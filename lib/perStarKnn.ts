/**
 * Density-based scoring for /api/recommendations and /api/discover.
 *
 * For each candidate paper we compute two density terms over its similarities
 * to the user's star and anti-star sets:
 *
 *   positive = sum over recent stars of      max(0, sim - tau)
 *   negative = sum over recent reads-no-star max(0, sim - tau)
 *   score    = positive - lambda * negative
 *
 * Replaces the older max-sim-with-cap aggregator. The key gains, measured by
 * eye against real top-25 lists, came from two facts about the embedding
 * space:
 *
 *  - Off-target items (penguin conservation, bacterial replication, etc.) are
 *    typically close to ONE star and isolated from the rest. Density-sum
 *    buries them because their other-star contributions are zero; max-sim
 *    didn't.
 *  - Items the user reliably opens and ignores (pharma news, cancer cell
 *    biology adjacencies) are concentrated in a few read-without-star
 *    regions. The 21k+ reads sitting in the exclude set were previously
 *    unused as signal; subtracting their density now actively pushes those
 *    regions down.
 *
 * The cap aggregator is gone: pile-up of near-duplicates from one popular
 * star doesn't happen under density-sum because near-duplicates live in
 * similar regions and accumulate the same other-star contributions, so they
 * rank close together rather than monopolizing the top.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// Profile size: how many recent stars define the user's taste. 50 was too narrow
// for heavy users (1000+ stars) — it captured only the last few weeks of starring
// and missed the breadth of their interests, so Related looked off-topic. 250
// covers months of starring. Validated against the real match_papers pipeline for
// a 1215-star user: candidates passing the floor 38 -> 139 and top max-sim
// 0.58 -> 0.75. Density is still computed against ALL of these, so cost scales
// linearly (250 cosines/candidate) — fine within the route's 30s budget.
export const KNN_N_STARS = 250;
export const KNN_N_ANTI = 50;
export const KNN_PER_STAR_MATCH = 100;
export const KNN_TAU = 0.5;
// Relevance floor: a candidate must be GENUINELY close to at least one star
// (best cosine >= KNN_FLOOR) to be eligible, not merely clear the soft tau with
// several weak ~0.5 brushes. Validated against the real match_papers candidate
// pool: a membrane-physiology paper grazing a regulatory-genomics star cloud at
// 0.544 ranked #50 under tau alone; the floor drops it entirely while leaving
// the strong head (all >= 0.6) untouched. Keeps tau=0.5 for scoring — this only
// gates eligibility, so the recall-friendly density ranking is unchanged for
// papers that pass. Raise toward 0.58 for a sharper/shorter feed, lower toward
// 0.52 for a longer/noisier one. Genuine matches sit ~0.55-0.62, same-field
// noise tops out ~0.55, so they overlap — no floor is perfect at 256 dims.
export const KNN_FLOOR = 0.55;
// lambda = 0: the read-without-star penalty is disabled. A 50-user held-out
// sweep (sum/top-k aggregation, hard same-field negatives) found every lambda>0
// setting ranked below its lambda=0 twin, and lambda=1 was worst — it demotes
// genuinely relevant papers just because the user *read* a neighbour without
// starring it (e.g. a spatial-transcriptomics rec suppressed by having read a
// spatial-chromatin paper). Since users read within their own field, the
// penalty punishes relevance. Keep at 0 unless a better negative signal exists.
export const KNN_LAMBDA = 0;

// Supabase REST URL length cap is ~8KB; .in() with more canonical_ids per
// call silently returns nothing. Batches of 100 stay well under.
const EMB_BATCH = 100;

export type StarVec = { canonicalId: string; embedding: number[] };

export type Scored = {
  canonical_id: string;
  similarity: number;
  source_feed?: string;
};

export type RankedItem = {
  canonicalId: string;
  score: number;
  posScore: number;
  negScore: number;
  nContributors: number;
  sourceFeed?: string;
};

export async function loadRecentStarVectors(
  supabase: SupabaseClient,
  userId: string,
  n: number = KNN_N_STARS,
): Promise<StarVec[]> {
  const { data: stars } = await supabase
    .from('stars')
    .select('canonical_id')
    .eq('user_id', userId)
    .not('canonical_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(n * 3);
  const cids = (stars || [])
    .map((r: { canonical_id: string | null }) => r.canonical_id)
    .filter((id: string | null): id is string => !!id && !id.startsWith('legacy:'));
  if (cids.length === 0) return [];

  const byCid = await fetchEmbeddingsByCanonical(supabase, cids);
  const out: StarVec[] = [];
  for (const cid of cids) {
    const e = byCid.get(cid);
    if (e) out.push({ canonicalId: cid, embedding: e });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Most recent reads that are NOT in the user's star set. These represent
 * "saw and didn't care" signal, used as a negative density source.
 */
export async function loadRecentAntiVectors(
  supabase: SupabaseClient,
  userId: string,
  starCanonicalIds: string[],
  n: number = KNN_N_ANTI,
): Promise<StarVec[]> {
  const starSet = new Set(starCanonicalIds);
  const { data: reads } = await supabase
    .from('reads')
    .select('canonical_id')
    .eq('user_id', userId)
    .not('canonical_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(n * 5);
  const cids = (reads || [])
    .map((r: { canonical_id: string | null }) => r.canonical_id)
    .filter((id: string | null): id is string =>
      !!id && !id.startsWith('legacy:') && !starSet.has(id),
    )
    .slice(0, n);
  if (cids.length === 0) return [];

  const byCid = await fetchEmbeddingsByCanonical(supabase, cids);
  const out: StarVec[] = [];
  for (const cid of cids) {
    const e = byCid.get(cid);
    if (e) out.push({ canonicalId: cid, embedding: e });
    if (out.length >= n) break;
  }
  return out;
}

export async function fetchEmbeddingsByCanonical(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (ids.length === 0) return out;
  const batches: Promise<void>[] = [];
  for (let i = 0; i < ids.length; i += EMB_BATCH) {
    const slice = ids.slice(i, i + EMB_BATCH);
    batches.push((async () => {
      const { data } = await supabase
        .from('article_embeddings')
        .select('canonical_id, embedding_half')
        .in('canonical_id', slice);
      for (const r of (data || []) as Array<{ canonical_id: string; embedding_half: string | number[] }>) {
        const v = typeof r.embedding_half === 'string' ? JSON.parse(r.embedding_half) : r.embedding_half;
        if (v && v.length === 256) out.set(r.canonical_id, v);
      }
    })());
  }
  await Promise.all(batches);
  return out;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? d / denom : 0;
}

/**
 * Density-sum score per candidate: sum_{stars} max(0, sim - tau)
 *   minus lambda * sum_{anti} max(0, sim - tau).
 *
 * `perStar` carries the positive-side similarities from the match_papers /
 * match_papers_discover fan-out. `candidateEmbeddings` is needed only to
 * compute negative-side similarities (anti vectors aren't in the RPC results,
 * so we compute their cosines in Node). Pass an empty `antiVectors` array to
 * skip the negative term entirely.
 */
export function mergeAndRankByDensity(opts: {
  perStar: Array<{ sponsor: string; rows: Scored[] | null }>;
  candidateEmbeddings: Map<string, number[]>;
  antiVectors: number[][];
  excluded: Set<string>;
  tau?: number;
  lambda?: number;
}): RankedItem[] {
  const tau = opts.tau ?? KNN_TAU;
  const lambda = opts.lambda ?? KNN_LAMBDA;

  // Aggregate per-star similarities per candidate, keeping max if duplicated.
  const perCand = new Map<string, { simByStar: Map<string, number>; sourceFeed?: string }>();
  for (const { sponsor, rows } of opts.perStar) {
    if (!rows) continue;
    for (const r of rows) {
      if (opts.excluded.has(r.canonical_id)) continue;
      if (r.canonical_id === sponsor) continue;
      let e = perCand.get(r.canonical_id);
      if (!e) {
        e = { simByStar: new Map(), sourceFeed: r.source_feed };
        perCand.set(r.canonical_id, e);
      }
      const cur = e.simByStar.get(sponsor) ?? -Infinity;
      if ((r.similarity ?? 0) > cur) e.simByStar.set(sponsor, r.similarity);
    }
  }

  const out: RankedItem[] = [];
  for (const [cid, e] of perCand) {
    let pos = 0, n = 0;
    for (const s of e.simByStar.values()) {
      if (s > tau) { pos += s - tau; n++; }
    }
    let neg = 0;
    const cv = opts.candidateEmbeddings.get(cid);
    if (cv && opts.antiVectors.length > 0) {
      for (const av of opts.antiVectors) {
        const sim = cosine(cv, av);
        if (sim > tau) neg += sim - tau;
      }
    }
    out.push({
      canonicalId: cid,
      score: pos - lambda * neg,
      posScore: pos,
      negScore: neg,
      nContributors: n,
      sourceFeed: e.sourceFeed,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function normalize(v: number[]): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map(x => x / n);
}

/**
 * Lightweight spherical k-means over the recent star vectors, used to pick
 * candidate-generation SEEDS for the density ranker. Returns up to `k`
 * L2-normalized centroids (cosine space); if there are fewer than `k` input
 * vectors, each is its own seed.
 *
 * Why: the old Related/Discover path fired one match_papers per star (~50
 * vector searches), which is CPU-bound on the DB and serializes to ~5s. Five
 * k-means seeds cover the same multi-modal interest clusters in ~5 searches,
 * and the FULL density score is then recomputed in Node against every star
 * (see rankByDensityFromEmbeddings). Deterministic init (evenly-spaced picks,
 * no RNG) so identical requests don't jitter.
 */
export function kmeansSeeds(vectors: number[][], k: number, iters = 8): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n <= k) return vectors.map(normalize);
  const dim = vectors[0].length;

  let centroids: number[][] = [];
  for (let i = 0; i < k; i++) centroids.push(normalize(vectors[Math.floor((i * n) / k)]));

  const assign = new Array(n).fill(-1);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const s = cosine(vectors[i], centroids[c]);
        if (s > bestSim) { bestSim = s; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    if (!moved) break;
    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      const v = vectors[i];
      const acc = sums[c];
      for (let d = 0; d < dim; d++) acc[d] += v[d];
    }
    centroids = centroids.map((prev, c) => (counts[c] === 0 ? prev : normalize(sums[c])));
  }
  return centroids;
}

/**
 * Density-sum ranking computed entirely from embeddings — no per-star RPC
 * fan-out. Same score as mergeAndRankByDensity:
 *   pos = sum over star vectors of  max(0, cos - tau)
 *   neg = sum over anti vectors of  max(0, cos - tau)
 *   score = pos - lambda * neg
 * but every candidate is scored against ALL star vectors (full density),
 * instead of only the similarities that surfaced in each star's top-K page.
 * The candidate pool is produced separately by the k-means-seeded search,
 * which is what lets us run ~5 vector searches instead of ~50.
 */
export function rankByDensityFromEmbeddings(opts: {
  candidateEmbeddings: Map<string, number[]>;
  candidateFeeds?: Map<string, string>;
  starVectors: number[][];
  antiVectors: number[][];
  excluded: Set<string>;
  starCanonicalIds?: Set<string>;
  tau?: number;
  lambda?: number;
  // 'density' (default): rank by sum of star-density (papers near MANY stars win).
  // 'maxsim': rank by the single nearest star (most-similar-to-any-star first).
  // Home Related uses 'maxsim' so the literal closest paper to anything the user
  // starred sits on top; Discover keeps 'density'. Density is still computed
  // either way (posScore) for tie-breaking and debug.
  rankBy?: 'density' | 'maxsim';
}): RankedItem[] {
  const tau = opts.tau ?? KNN_TAU;
  const lambda = opts.lambda ?? KNN_LAMBDA;
  const rankBy = opts.rankBy ?? 'density';
  const out: Array<RankedItem & { maxSim: number }> = [];
  for (const [cid, cv] of opts.candidateEmbeddings) {
    if (opts.excluded.has(cid)) continue;
    if (opts.starCanonicalIds?.has(cid)) continue;
    let pos = 0, n = 0, maxSim = -Infinity;
    for (const sv of opts.starVectors) {
      const s = cosine(cv, sv);
      if (s > maxSim) maxSim = s;
      if (s > tau) { pos += s - tau; n++; }
    }
    if (n === 0) continue;          // not near any star — never a recommendation
    if (maxSim < KNN_FLOOR) continue; // near several stars but not GENUINELY close to any — drop the weak tail
    let neg = 0;
    for (const av of opts.antiVectors) {
      const s = cosine(cv, av);
      if (s > tau) neg += s - tau;
    }
    out.push({
      canonicalId: cid,
      score: rankBy === 'maxsim' ? maxSim : pos - lambda * neg,
      posScore: pos,
      negScore: neg,
      nContributors: n,
      sourceFeed: opts.candidateFeeds?.get(cid),
      maxSim,
    });
  }
  // Primary by score; for maxsim ties, denser papers first (more corroboration).
  out.sort((a, b) => b.score - a.score || b.posScore - a.posScore);
  return out;
}
