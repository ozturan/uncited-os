/**
 * Discover API - Find relevant articles from UNFOLLOWED journals
 *
 * Uses K-means clustering with 5 centroids:
 * 1. Get/compute user profile (5 centroids from last 200 starred) - cached in user_state.settings
 * 2. Vector search per centroid to find similar articles in unfollowed journals
 * 3. Score and merge results
 * 4. Return sorted by relevance with pagination for refresh
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    KNN_LAMBDA,
    KNN_TAU,
    fetchEmbeddingsByCanonical,
    kmeansSeeds,
    loadRecentAntiVectors,
    loadRecentStarVectors,
    rankByDensityFromEmbeddings,
} from '@/lib/perStarKnn';
import { getExcludedCanonicalSet } from '@/lib/excludedCache';
import { hydrateCanonicalIds } from '@/lib/paperFeed';
import { attachCachedAffiliations, warmAffiliations } from '@/lib/affiliationServerCache';
import { DEFAULT_DISPLAY_LIMIT } from '@/lib/constants';

// Discover Personalize (for-you) candidate generation: k-means the recent star
// cloud into a few seeds, one vector search per seed instead of one per star.
const DISCOVER_SEEDS = 5;
const DISCOVER_SEED_MATCH = 400;

// Attach any already-resolved author/lab/institution entities (synchronous, zero
// latency) so warm cards paint the full line on first render, and warm the misses
// in the background so the NEXT load is instant too. Mirrors /api/articles.
function attachAndWarm(articles: { canonicalId?: string }[]): void {
    const misses = attachCachedAffiliations(articles as Parameters<typeof attachCachedAffiliations>[0]);
    if (misses.length) after(() => warmAffiliations(misses));
}

// Fallback in-memory rate limiter (mirrors middleware logic)
const discoverRateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60_000;

function checkDiscoverRateLimit(request: NextRequest): boolean {
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded ? forwarded.split(',')[0].trim() : (request as any).ip ?? 'unknown';
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    const timestamps = discoverRateLimitMap.get(ip) ?? [];
    const recent = timestamps.filter(t => t > windowStart);
    if (recent.length >= RATE_LIMIT_MAX) {
        discoverRateLimitMap.set(ip, recent);
        return false;
    }
    recent.push(now);
    discoverRateLimitMap.set(ip, recent);
    return true;
}

// Deduplicate articles that are cross-listed across feeds (same title, different IDs).
// Articles are assumed pre-sorted by score descending; first occurrence wins.
function deduplicateByTitle(articles: any[]): any[] {
    const seenTitles = new Set<string>();
    return articles.filter(a => {
        const norm = (a.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!norm || seenTitles.has(norm)) return false;
        seenTitles.add(norm);
        return true;
    });
}

export async function GET(request: NextRequest) {
    // Fallback rate limit check (in case middleware didn't run)
    if (!checkDiscoverRateLimit(request)) {
        return NextResponse.json(
            { error: 'Too many requests. Please wait before trying again.' },
            { status: 429, headers: { 'Retry-After': '60' } }
        );
    }

    try {
        const supabase = await createClient();

        // Get current user
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Get query parameters
        const searchParams = request.nextUrl.searchParams;
        const limit = parseInt(searchParams.get('limit') || String(DEFAULT_DISPLAY_LIMIT));
        const offset = parseInt(searchParams.get('offset') || '0');
        const searchQuery = searchParams.get('search')?.trim() || '';
        const mode = searchParams.get('mode') || 'for-you';

        // Phase 8: load small user_state fields + exclude set from the
        // source-of-truth reads/stars tables. The legacy starred/read
        // jsonb arrays in user_state are no longer maintained.
        //
        // Used to fire an extra COUNT(*) on stars for a drift-tolerance
        // cache check. Dropped: the drift check is gone — cached centroids
        // are trusted. Saves one full-table count per request.
        const [stateRes, excludedSet, starsIdsRes] = await Promise.all([
            supabase.from('user_state').select('follows, settings').eq('user_id', user.id).single(),
            getExcludedCanonicalSet(supabase, user.id),
            // starsIdsRes populates the per-table starred sets used only by the
            // search/keyword branches (legacy entry_id + canonical). Reads are NOT
            // fetched per-row anymore: the My Field / density branches only need the
            // read∪starred UNION to suppress already-seen papers, and that is exactly
            // what user_excluded_canonical returns (server-aggregated, uncapped). The
            // old full `reads` pull shipped ~all read rows over the wire AND silently
            // truncated at PostgREST db.max_rows=1000, so the exclusion set was both
            // slow and incomplete.
            supabase.from('stars').select('entry_id, canonical_id').eq('user_id', user.id),
        ]);

        const { data: userState, error: stateError } = stateRes;
        if (stateError || !userState) {
            return NextResponse.json({ error: 'User state not found' }, { status: 404 });
        }

        const followedJournals: string[] = userState.follows || [];
        const settings = userState.settings || {};
        const starredIds: string[] = (starsIdsRes.data || []).map((r: any) => r.entry_id).filter(Boolean);
        const hasEnoughStars = starredIds.length >= 3;
        // excludedSet (above) is the read∪starred canonical union, server-aggregated
        // and complete, cached per-user for 60s. The My Field and density branches
        // exclude already-seen papers with this set directly.
        // Per-table starred set (canonical) — only the search/keyword branches need to
        // distinguish "starred" specifically (to drop starred papers from results).
        const starredCanonicalSet = new Set<string>(
            (starsIdsRes.data || [])
                .map((r: any) => r.canonical_id)
                .filter((id: string | null | undefined) => typeof id === 'string' && !id.startsWith('legacy:'))
        );

        // ========================================
        // SEARCH MODE: Hybrid semantic + keyword (rxiv-pattern).
        // Runs ILIKE title-match and pgvector cosine in parallel, merges
        // and boosts the union: vector matches that also contain query
        // terms get a relevance bonus, text-only matches enter at base
        // similarity 0.5 so they're still ranked alongside.
        // ========================================
        if (searchQuery.length > 0) {
            try {
                const { serviceSupabase, SIGHTINGS_JOIN_SELECT, shapeEntry } = await import('@/lib/paperFeed');
                const supabase = serviceSupabase();
                const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                const escapeIlike = (v: string) => v.replace(/[%_\\]/g, '');
                // title_normalized strips all punctuation (see normalizeTitle in
                // scripts/lib/canonical.mjs); apply the same normalization on
                // search terms so punctuated tokens still match.
                const normalizeForTitle = (v: string) =>
                    v.normalize('NFKD')
                        .toLowerCase()
                        .replace(/\p{M}+/gu, '')
                        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
                        .replace(/_+/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                const words = searchQuery
                    .toLowerCase()
                    .split(/\s+/)
                    .map(escapeIlike)
                    .filter(w => w.length > 0);

                // Build keyword query (existing logic).
                let keywordQuery = supabase
                    .from('sightings')
                    .select(SIGHTINGS_JOIN_SELECT)
                    .gte('papers.published_at', since)
                    .limit(DEFAULT_DISPLAY_LIMIT * 3);
                for (const w of words) {
                    const normalized = normalizeForTitle(w);
                    if (!normalized) continue;
                    keywordQuery = keywordQuery.ilike('papers.title_normalized', `%${normalized}%`);
                }
                if (followedJournals.length > 0) {
                    const quoted = followedJournals.map(s => `"${s.replace(/"/g, '""')}"`).join(',');
                    keywordQuery = keywordQuery.not('source_feed', 'in', `(${quoted})`);
                }

                // Embed the query for the semantic side. Failure here doesn't
                // block search — we still return keyword-only results.
                async function embedQuery(): Promise<number[] | null> {
                    const apiKey = process.env.OPENAI_API_KEY;
                    if (!apiKey) return null;
                    try {
                        const r = await fetch('https://api.openai.com/v1/embeddings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                            body: JSON.stringify({
                                model: 'text-embedding-3-small',
                                input: searchQuery,
                                dimensions: 256,
                            }),
                            signal: AbortSignal.timeout(10000),
                        });
                        if (!r.ok) return null;
                        const data = await r.json();
                        return data.data?.[0]?.embedding || null;
                    } catch { return null; }
                }

                const semanticPromise = embedQuery().then(async (queryEmbedding) => {
                    if (!queryEmbedding) return null;
                    const { data: matches, error } = await supabase.rpc('match_papers_discover', {
                        query_embedding: queryEmbedding,
                        match_count: DEFAULT_DISPLAY_LIMIT * 2,
                        min_published_date: since,
                        p_excluded_feeds: followedJournals.length > 0 ? followedJournals : null,
                    });
                    if (error || !matches) return null;
                    return matches as Array<{ canonical_id: string; source_feed: string; published_at: string; similarity: number }>;
                }).catch(() => null);

                const [keywordRes, semanticRes] = await Promise.all([
                    keywordQuery.then(r => r),
                    semanticPromise,
                ]);

                if (keywordRes.error) throw new Error(keywordRes.error.message);

                // Hydrate keyword hits.
                const starredLegacySet = new Set(starredIds);
                const keywordEntries = new Map<string, NonNullable<ReturnType<typeof shapeEntry>> & { score: number }>();
                for (const row of (keywordRes.data || []) as any[]) {
                    const entry = shapeEntry(row);
                    if (!entry) continue;
                    if (starredLegacySet.has(entry.id)) continue;
                    if (starredCanonicalSet.has(entry.canonicalId)) continue;
                    if (keywordEntries.has(entry.canonicalId)) continue;
                    keywordEntries.set(entry.canonicalId, { ...entry, score: 0 });
                }

                // Boost keyword scores by query-word coverage so a multi-word
                // phrase match outranks a single-word ILIKE hit.
                for (const e of keywordEntries.values()) {
                    const text = `${e.title.toLowerCase()} ${(e.abstract || '').toLowerCase()}`;
                    const wordsHit = words.filter(w => text.includes(w)).length;
                    e.score = 0.5 + 0.1 * Math.min(wordsHit, 5);
                }

                // Hydrate semantic results that aren't already in keyword set.
                const semanticIds = (semanticRes || [])
                    .filter(r => !keywordEntries.has(r.canonical_id))
                    .map(r => r.canonical_id);
                let semanticHydrated: Map<string, NonNullable<ReturnType<typeof shapeEntry>>> = new Map();
                if (semanticIds.length > 0) {
                    const { data: semRows } = await supabase
                        .from('sightings')
                        .select(SIGHTINGS_JOIN_SELECT)
                        .in('paper_id', semanticIds);
                    for (const row of (semRows || []) as any[]) {
                        const entry = shapeEntry(row);
                        if (!entry) continue;
                        if (starredLegacySet.has(entry.id)) continue;
                        if (starredCanonicalSet.has(entry.canonicalId)) continue;
                        if (!semanticHydrated.has(entry.canonicalId)) {
                            semanticHydrated.set(entry.canonicalId, entry);
                        }
                    }
                }

                // Merge: keyword entries get boosted by semantic similarity if
                // they're also in the semantic results.
                const merged = new Map<string, { entry: NonNullable<ReturnType<typeof shapeEntry>>; score: number }>();
                for (const [cid, e] of keywordEntries) {
                    merged.set(cid, { entry: e, score: e.score });
                }
                for (const r of semanticRes || []) {
                    if (merged.has(r.canonical_id)) {
                        merged.get(r.canonical_id)!.score += Math.max(0, r.similarity) * 0.5; // semantic boost on keyword hits
                        continue;
                    }
                    const entry = semanticHydrated.get(r.canonical_id);
                    if (!entry) continue;
                    // Keyword boost: how many query words appear in the semantic-only result?
                    const text = `${entry.title.toLowerCase()} ${(entry.abstract || '').toLowerCase()}`;
                    const allHit = words.every(w => text.includes(w));
                    const anyHit = words.some(w => text.includes(w));
                    const keywordBonus = allHit ? 0.3 : (anyHit ? 0.15 : 0);
                    merged.set(r.canonical_id, { entry, score: r.similarity + keywordBonus });
                }

                // Sort by score desc, take top N.
                const sorted = Array.from(merged.values()).sort((a, b) => b.score - a.score);
                const entries = sorted.slice(0, limit).map(x => x.entry);

                attachAndWarm(entries);

                return NextResponse.json({
                    articles: entries,
                    search_mode: true,
                    total_matches: entries.length,
                    hybrid: !!semanticRes,
                });
            } catch (error) {
                console.error('[Search] Error:', error);
                return NextResponse.json({
                    articles: [],
                    search_mode: true,
                    error: String(error),
                });
            }
        }

        // ========================================
        // KEYWORD FILTER MODE: Search article pool by keywords
        // ========================================
        const keywordsParam = searchParams.get('keywords')?.trim() || '';
        const keywordLogic = searchParams.get('keyword_logic') || 'OR';
        const keywordFields = searchParams.get('keyword_fields') || 'both';

        if (keywordsParam.length > 0) {
            const kwT0 = Date.now();
            try {
                const { serviceSupabase, SIGHTINGS_JOIN_SELECT, shapeEntry } = await import('@/lib/paperFeed');
                const supabase = serviceSupabase();
                // Match the discoverEntries date window (60 days). The local
                // keyword-filter badge counts against discoverEntries, so a
                // narrower window here would surface fewer results than the
                // badge implies.
                const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
                const terms = keywordsParam.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);

                // PostgREST's .or() can't filter on an embedded table's columns
                // ("papers.column.op.val" inside or() produces "failed to parse
                // logic tree"; switching to { referencedTable } makes the
                // joined query timeout because the GIN trgm index can't be
                // used through the sightings join). Run the keyword scan
                // directly against papers first to use the index, then fan
                // out to sightings for source_feed metadata and the
                // followed-journal exclusion.
                const escapeIlikeValue = (v: string) =>
                    v.replace(/[,()*%_]/g, '').replace(/\\/g, '');
                // title_normalized strips all punctuation (see normalizeTitle
                // in scripts/lib/canonical.mjs); apply the same normalization
                // so keywords like "DNA-seq" still match.
                const normalizeForTitle = (v: string) =>
                    v.normalize('NFKD')
                        .toLowerCase()
                        .replace(/\p{M}+/gu, '')
                        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
                        .replace(/_+/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                const termClauses = (term: string) => {
                    const safeAbs = escapeIlikeValue(term);
                    const safeTitle = escapeIlikeValue(normalizeForTitle(term));
                    if (keywordFields === 'title') return `title_normalized.ilike.%${safeTitle}%`;
                    if (keywordFields === 'abstract') return `abstract.ilike.%${safeAbs}%`;
                    return `title_normalized.ilike.%${safeTitle}%,abstract.ilike.%${safeAbs}%`;
                };

                // Stage 1: scan papers for canonical_ids matching the keyword(s).
                //
                // There's a GIN trgm index on title_normalized but NOT on
                // abstract. Mixing both columns in a single OR forces a seq
                // scan of every paper in the 60-day window and hits the
                // Supabase statement_timeout. Split into parallel queries so
                // the title side uses the index and the abstract side is its
                // own bounded scan, then union the canonical_ids.
                const safeTitleTerms = terms.map(t => escapeIlikeValue(normalizeForTitle(t))).filter(Boolean);
                const safeAbsTerms = terms.map(t => escapeIlikeValue(t)).filter(Boolean);
                const wantTitle = keywordFields === 'title' || keywordFields === 'both';
                const wantAbs = keywordFields === 'abstract' || keywordFields === 'both';
                const limitStage1 = DEFAULT_DISPLAY_LIMIT * 3;

                async function searchColumn(column: 'title_normalized' | 'abstract', safeTerms: string[]): Promise<string[]> {
                    if (safeTerms.length === 0) return [];
                    let q = supabase
                        .from('papers')
                        .select('canonical_id')
                        .gte('published_at', since)
                        .limit(limitStage1);
                    if (keywordLogic === 'OR' || safeTerms.length === 1) {
                        q = q.or(safeTerms.map(t => `${column}.ilike.%${t}%`).join(','));
                    } else {
                        for (const t of safeTerms) q = q.ilike(column, `%${t}%`);
                    }
                    const { data, error } = await q;
                    if (error) {
                        // Abstract has no trgm index; the seq scan can blow
                        // past Supabase's statement_timeout. Don't fail the
                        // whole keyword filter — return what we have (likely
                        // empty for this column) and let the other column
                        // carry the result.
                        console.warn(`[KwFilter] ${column} query failed: ${error.message}`);
                        return [];
                    }
                    return (data || []).map((r: { canonical_id: string }) => r.canonical_id).filter(Boolean);
                }

                const [titleIds, absIds] = await Promise.all([
                    wantTitle ? searchColumn('title_normalized', safeTitleTerms) : Promise.resolve([] as string[]),
                    wantAbs ? searchColumn('abstract', safeAbsTerms) : Promise.resolve([] as string[]),
                ]);

                // For AND with fields=both, a paper needs term1 AND term2 to
                // match somewhere — handled here by intersecting per-term
                // result sets. (For OR, just union.)
                let canonicalIds: string[];
                if (keywordLogic === 'AND' && terms.length > 1 && (wantTitle && wantAbs)) {
                    // Per-term: collect IDs that match in title OR abstract for that term.
                    const perTermSets: Set<string>[] = [];
                    for (let i = 0; i < terms.length; i++) {
                        const ts = [escapeIlikeValue(normalizeForTitle(terms[i]))].filter(Boolean);
                        const as_ = [escapeIlikeValue(terms[i])].filter(Boolean);
                        const [t, a] = await Promise.all([
                            wantTitle ? searchColumn('title_normalized', ts) : Promise.resolve([] as string[]),
                            wantAbs ? searchColumn('abstract', as_) : Promise.resolve([] as string[]),
                        ]);
                        perTermSets.push(new Set([...t, ...a]));
                    }
                    canonicalIds = [...perTermSets[0]].filter(id => perTermSets.every(s => s.has(id)));
                } else {
                    canonicalIds = Array.from(new Set([...titleIds, ...absIds]));
                }

                let entries: NonNullable<ReturnType<typeof shapeEntry>>[] = [];
                if (canonicalIds.length > 0) {
                    // Stage 2: fetch sightings for those papers, drop
                    // followed-journal feeds.
                    let sightQuery = supabase
                        .from('sightings')
                        .select(SIGHTINGS_JOIN_SELECT)
                        .in('paper_id', canonicalIds);
                    if (followedJournals.length > 0) {
                        const quoted = followedJournals.map(s => `"${s.replace(/"/g, '""')}"`).join(',');
                        sightQuery = sightQuery.not('source_feed', 'in', `(${quoted})`);
                    }
                    const { data: sightRows, error: sightErr } = await sightQuery;
                    if (sightErr) throw new Error(sightErr.message);

                    const starredLegacySet = new Set(starredIds);
                    const seenCanonical = new Set<string>();
                    for (const row of (sightRows || []) as any[]) {
                        const entry = shapeEntry(row);
                        if (!entry) continue;
                        if (starredLegacySet.has(entry.id)) continue;
                        if (starredCanonicalSet.has(entry.canonicalId)) continue;
                        if (seenCanonical.has(entry.canonicalId)) continue;
                        seenCanonical.add(entry.canonicalId);
                        entries.push(entry);
                        if (entries.length >= limit) break;
                    }
                }

                console.log(`[KwFilter] terms=${JSON.stringify(terms)} logic=${keywordLogic} fields=${keywordFields} papers=${canonicalIds.length} entries=${entries.length} elapsed=${Date.now() - kwT0}ms followed=${followedJournals.length}`);
                attachAndWarm(entries);
                return NextResponse.json({
                    articles: entries,
                    keyword_mode: true,
                    total_matches: entries.length,
                    // Number actually returned (capped at limit). The dropdown
                    // badge uses this so it reflects the broader unfollowed-
                    // journal search rather than the local discoverEntries count.
                    pool_size: entries.length,
                }, { headers: { 'Cache-Control': 'no-store' } });
            } catch (error) {
                console.error('[Keyword Filter] Error:', error);
                return NextResponse.json({
                    articles: [],
                    keyword_mode: true,
                    error: String(error)
                }, { headers: { 'Cache-Control': 'no-store' } });
            }
        }

        // ========================================
        // MY FIELD MODE — single field_centroid
        // ========================================
        if (mode === 'my-field') {
            const fieldCentroid = settings.field_centroid as number[] | undefined;
            if (!fieldCentroid || fieldCentroid.length !== 256) {
                return NextResponse.json(
                    { error: 'Research profile not set up. Connect your Scholar profile in Settings first.' },
                    { status: 400 }
                );
            }

            const dateCutoff = new Date();
            dateCutoff.setDate(dateCutoff.getDate() - 60);
            const perLimit = Math.ceil((limit + offset) * 2);

            const { data: rpcData } = await supabase.rpc('match_papers_discover', {
                query_embedding: fieldCentroid,
                match_count: perLimit,
                min_published_date: dateCutoff.toISOString(),
                p_excluded_feeds: followedJournals,
            });

            // Filter already-read/starred via the canonical union (cross-feed safe).
            const articleScores = new Map<string, { score: number; journalId: string }>();
            if (rpcData) {
                for (const item of rpcData) {
                    if (excludedSet.has(item.canonical_id)) continue;
                    const existing = articleScores.get(item.canonical_id);
                    if (!existing || item.similarity > existing.score) {
                        articleScores.set(item.canonical_id, { score: item.similarity, journalId: item.source_feed });
                    }
                }
            }

            const allSorted = Array.from(articleScores.entries())
                .map(([canonicalId, data]) => ({ canonicalId, ...data }))
                .sort((a, b) => b.score - a.score);

            const sortedArticles = allSorted.slice(offset, offset + limit);

            const articleByCanonical = await hydrateCanonicalIds(
                sortedArticles.map(a => a.canonicalId),
            );

            const finalArticles = deduplicateByTitle(
                sortedArticles
                    .map(scored => {
                        const article = articleByCanonical.get(scored.canonicalId);
                        if (!article) return null;
                        return { ...article, _score: scored.score };
                    })
                    .filter(Boolean)
            );

            attachAndWarm(finalArticles);

            return NextResponse.json({
                articles: finalArticles,
                profile_info: { method: 'my-field', clusters: 1 },
                stats: { total_available: allSorted.length, offset, returned: finalArticles.length },
            }, {
                headers: {
                    'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
                },
            });
        }

        // ========================================
        // PERSONALIZATION MODE - density-sum positive minus negative
        // ========================================
        // Same engine as /api/recommendations (see lib/perStarKnn.ts header).
        // Fan out match_papers_discover per recent star, fetch candidate
        // embeddings, subtract density from recent reads-without-stars.

        if (!hasEnoughStars) {
            return NextResponse.json({
                articles: [],
                message: 'Star at least 3 papers to get personalized discovery',
            });
        }

        const starVecs = await loadRecentStarVectors(supabase, user.id);
        if (starVecs.length < 3) {
            return NextResponse.json({
                articles: [],
                message: 'Not enough embeddings for starred articles',
            });
        }

        const starVectors = starVecs.map(s => s.embedding);
        const starCanonicalIds = new Set(starVecs.map(s => s.canonicalId));

        const antiPromise = loadRecentAntiVectors(
            supabase,
            user.id,
            starVecs.map(s => s.canonicalId),
        );

        const dateCutoff = new Date();
        dateCutoff.setDate(dateCutoff.getDate() - 60);

        // Candidate generation: k-means seeds → one match_papers_discover per
        // seed (~5) instead of one per star (~50). Full density is recomputed in
        // Node against every star (see rankByDensityFromEmbeddings).
        const seeds = kmeansSeeds(starVectors, DISCOVER_SEEDS);
        const seedResults = await Promise.all(
            seeds.map(seed =>
                supabase.rpc('match_papers_discover', {
                    query_embedding: seed,
                    match_count: DISCOVER_SEED_MATCH,
                    min_published_date: dateCutoff.toISOString(),
                    p_excluded_feeds: followedJournals,
                }).then((r: { data: unknown; error: { message?: string } | null }) => ({
                    rows: (r.data as { canonical_id: string; source_feed?: string }[] | null) ?? null,
                    error: r.error,
                }))
            )
        );

        const candidateFeeds = new Map<string, string>();
        for (const r of seedResults) {
            for (const row of r.rows || []) {
                if (!candidateFeeds.has(row.canonical_id)) {
                    candidateFeeds.set(row.canonical_id, row.source_feed || '');
                }
            }
        }
        const candidateIds = [...candidateFeeds.keys()];

        const [antiVecs, candidateEmbeddings] = await Promise.all([
            antiPromise,
            fetchEmbeddingsByCanonical(supabase, candidateIds),
        ]);

        // Discover excludes any paper the user has already read OR starred — the
        // cached read∪starred union (excludedSet) is exactly that set.
        const ranked = rankByDensityFromEmbeddings({
            candidateEmbeddings,
            candidateFeeds,
            starVectors,
            antiVectors: antiVecs.map(a => a.embedding),
            excluded: excludedSet,
            starCanonicalIds,
        });

        const pageSlice = ranked.slice(offset, offset + limit);

        const articleByCanonical = await hydrateCanonicalIds(
            pageSlice.map(a => a.canonicalId),
        );

        const finalArticles = deduplicateByTitle(
            pageSlice
                .map(scored => {
                    const article = articleByCanonical.get(scored.canonicalId);
                    if (!article) return null;
                    return { ...article, _score: scored.score };
                })
                .filter(Boolean)
        );

        attachAndWarm(finalArticles);

        return NextResponse.json({
            articles: finalArticles,
            profile_info: {
                method: 'density-pos-minus-neg',
                n_stars: starVecs.length,
                n_anti: antiVecs.length,
                tau: KNN_TAU,
                lambda: KNN_LAMBDA,
            },
            stats: {
                total_available: ranked.length,
                offset: offset,
                returned: finalArticles.length
            }
        }, {
            // Per-user response (depends on follows + centroids), so browser-cache
            // only. Makes re-entering the Discover tab instant for 60s, and
            // returns stale-while-revalidate for 5 min on auth'd SWR refreshes.
            headers: {
                'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
            },
        });

    } catch (error) {
        console.error('Discover API error:', error);
        return NextResponse.json(
            { error: 'Internal server error', details: String(error) },
            { status: 500 }
        );
    }
}
