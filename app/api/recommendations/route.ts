/**
 * For You API - Personalized recommendations from FOLLOWED journals
 *
 * Uses K-means clustering with 5 centroids + in-memory scoring:
 * 1. Get/compute user profile (5 centroids from last 200 starred) - cached in user_state.settings
 * 2. Fetch ONLY unread articles from followed journals (exclude read/starred at DB level)
 * 3. Score each unread article against centroids in memory (max similarity to any centroid)
 * 4. Return ALL unread articles ranked by similarity
 *
 * This ensures we rank ALL unread articles efficiently.
 */

import { NextRequest, NextResponse } from 'next/server';
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

// Related (for-you) candidate generation: k-means the recent star cloud into
// a few seeds and run ONE vector search per seed instead of one per star.
// Vector search is CPU-bound on the DB, so query COUNT is the cost; 5 seeds
// replace ~50 searches (~5s -> ~2s). Full density is recomputed in Node.
const RELATED_SEEDS = 5;
const SEED_MATCH = 400;

// Graceful empty response returned on error or timeout. The status code
// distinguishes "compute timed out" (504) from "unexpected exception" (500)
// from "no data" (200). Frontend can branch on response.status; the body's
// `error`/`reason` fields are descriptive but optional.
const EMPTY_RESPONSE_BODY = {
    error: true,
    items: [],
    unread: [],
    starred: [],
    read: [],
    all: [],
};
const TIMEOUT_RESPONSE_BODY = { ...EMPTY_RESPONSE_BODY, reason: 'timeout' };
const FAILURE_RESPONSE_BODY = { ...EMPTY_RESPONSE_BODY, reason: 'internal_error' };

// 30s — the cold path is user_state (1s) + RPC warmup (6s) + embeddings
// batch (1s) + hydrate (1s) + an optional centroids recompute (2s) ≈ 11s.
// 15s was tripping on cold starts and leaving users stuck on a silent
// empty response until they manually refreshed. Warm path is <2s so
// this doesn't slow anyone down in steady state.
const REQUEST_TIMEOUT_MS = 30_000;

export async function GET(request: NextRequest) {
    // Wrap the entire computation in a race against a 30-second timeout.
    // 504 (not 200) so the frontend can distinguish "timed out" from "no
    // recommendations": clicking Related and silently getting an empty list
    // was the previous failure mode.
    const timeoutPromise = new Promise<NextResponse>(resolve =>
        setTimeout(() => resolve(NextResponse.json(TIMEOUT_RESPONSE_BODY, { status: 504 })), REQUEST_TIMEOUT_MS)
    );

    const computePromise = computeRecommendations(request);

    return Promise.race([computePromise, timeoutPromise]);
}

async function computeRecommendations(_request: NextRequest): Promise<NextResponse> {
    try {
        const supabase = await createClient();
        const mode = _request.nextUrl.searchParams.get('mode') || 'for-you';

        // Get current user
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Phase 8: read/starred moved out of user_state jsonb into the reads/stars
        // tables. Fetch follows+settings from user_state (small) plus the exclude set.
        //
        // For You needs the all-time read∪starred union (via user_excluded_canonical)
        // to filter its candidates, plus the ≥3-stars probe. My Field skips BOTH here:
        // it fetches the same exclusion union IN PARALLEL with its own vector RPC inside
        // the branch below, so the (account-age-sized) union transfer overlaps the match
        // instead of serializing ahead of it — and hasEnoughStars is never read on that
        // path. The union is the only correct, uncapped source (a client-side .limit on
        // reads silently truncates at PostgREST db.max_rows and would leak read papers).
        const isMyField = mode === 'my-field';
        const [stateRes, starsProbeRes] = await Promise.all([
            supabase
                .from('user_state')
                .select('follows, settings')
                .eq('user_id', user.id)
                .single(),
            // Only need to know whether the user has ≥3 stars (threshold below) —
            // SELECT LIMIT 3 short-circuits much faster than a full count. Skipped on
            // the My Field path, where hasEnoughStars is never read.
            isMyField
                ? Promise.resolve({ data: [] as { entry_id: string }[] | null })
                : supabase.from('stars').select('entry_id').eq('user_id', user.id).limit(3),
        ]);

        const { data: userState, error: stateError } = stateRes;
        if (stateError || !userState) {
            return NextResponse.json({ error: 'User state not found' }, { status: 404 });
        }

        const followedJournals: string[] = userState.follows || [];
        const settings = userState.settings || {};
        const hasEnoughStars = (starsProbeRes.data?.length ?? 0) >= 3;
        // The read∪starred exclusion union is now fetched via getExcludedCanonicalSet
        // (per-user 60s cache) inside each branch, overlapping the vector work.

        if (followedJournals.length === 0) {
            return NextResponse.json({
                articles: [],
                message: 'Follow at least one journal to get recommendations'
            });
        }

        // ── My Field mode: use field_centroid instead of K-means ──────────────
        if (mode === 'my-field') {
            const fieldCentroid = settings.field_centroid as number[] | undefined;
            if (!fieldCentroid || fieldCentroid.length !== 256) {
                return NextResponse.json(
                    { error: 'Research profile not set up. Connect your Scholar profile in Settings first.' },
                    { status: 400 }
                );
            }

            const dateCutoff = new Date();
            dateCutoff.setDate(dateCutoff.getDate() - 30);

            // Exclude already read/starred. The read∪starred union is the only
            // correct, uncapped, server-aggregated source — fetched (cached 60s)
            // IN PARALLEL with the vector RPC so its transfer overlaps the match
            // instead of serializing ahead of it. See "For You" for why we filter in Node.
            const [excludedSet, matchFieldRes] = await Promise.all([
                getExcludedCanonicalSet(supabase, user.id),
                supabase.rpc('match_papers', {
                    query_embedding: fieldCentroid,
                    // The feed only renders the top ~100; 500 ranked candidates is ample
                    // headroom after excluding read/starred, and a much smaller/faster query
                    // + payload than 2000.
                    match_count: 500,
                    p_filter_feeds: followedJournals,
                    min_published_date: dateCutoff.toISOString(),
                    excluded_canonical_ids: [],
                }),
            ]);
            const { data: unreadRaw, error: fetchError } = matchFieldRes;
            const unreadArticles = unreadRaw
                ? (unreadRaw as any[]).filter(r => !excludedSet.has(r.canonical_id))
                : null;

            if (fetchError) {
                return NextResponse.json({ articles: [], message: 'Failed to fetch articles', error: fetchError.message });
            }

            if (!unreadArticles || unreadArticles.length === 0) {
                return NextResponse.json({ articles: [], message: 'No unread articles found' });
            }

            // The RPC already returns rows ordered by similarity DESC (its final
            // ORDER BY), and the Node filter above preserves order — so no re-sort is
            // needed. The old flow fired 40 parallel embedding queries to re-compute
            // the EXACT same value, which cost ~1.7s on heavy accounts.
            const unreadIds = unreadArticles.map((a: any) => a.canonical_id);
            return NextResponse.json({
                unread: unreadIds,
                starred: [],
                read: [],
                profile_info: { method: 'my-field', clusters: 1 },
                stats: { total_unread: unreadArticles.length, returned: unreadIds.length },
            }, {
                headers: {
                    'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
                },
            });
        }

        // ── For You mode: density-sum positive minus negative ────────────────
        // For each candidate, score = sum_{recent stars} max(0, sim - tau)
        //                            - lambda * sum_{recent reads-no-star} max(0, sim - tau).
        // The positive term is the density of the user's interest cloud
        // around the candidate; the negative term is the density of papers
        // they consistently skip. See lib/perStarKnn.ts header for the
        // rationale that pushed us off max-sim aggregation.

        if (!hasEnoughStars) {
            return NextResponse.json({
                articles: [],
                message: 'Star at least 3 papers to get personalized recommendations',
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

        // Exclusion union + anti vectors load in parallel with the seed fan-out.
        const excludedPromise = getExcludedCanonicalSet(supabase, user.id);
        const antiPromise = loadRecentAntiVectors(
            supabase,
            user.id,
            starVecs.map(s => s.canonicalId),
        );

        const dateCutoff = new Date();
        dateCutoff.setDate(dateCutoff.getDate() - 30);

        // Candidate generation: k-means the star cloud into a few seeds and run
        // ONE vector search per seed (~5) instead of one per star (~50). Vector
        // search is CPU-bound on the DB, so search COUNT is the dominant cost.
        const seeds = kmeansSeeds(starVectors, RELATED_SEEDS);
        const seedResults = await Promise.all(
            seeds.map(seed =>
                supabase.rpc('match_papers', {
                    query_embedding: seed,
                    match_count: SEED_MATCH,
                    p_filter_feeds: followedJournals,
                    min_published_date: dateCutoff.toISOString(),
                    excluded_canonical_ids: [],
                }).then((r: { data: unknown; error: { message?: string } | null }) => ({
                    rows: (r.data as { canonical_id: string; source_feed?: string }[] | null) ?? null,
                    error: r.error,
                }))
            )
        );

        if (seedResults.every(r => r.error)) {
            const err = seedResults.find(r => r.error)?.error;
            console.error('match_papers error:', err);
            return NextResponse.json({
                articles: [],
                message: 'Failed to fetch articles',
                error: err?.message,
            });
        }

        // Union the seed hits into the candidate pool (first source_feed wins).
        const candidateFeeds = new Map<string, string>();
        for (const r of seedResults) {
            for (const row of r.rows || []) {
                if (!candidateFeeds.has(row.canonical_id)) {
                    candidateFeeds.set(row.canonical_id, row.source_feed || '');
                }
            }
        }
        const candidateIds = [...candidateFeeds.keys()];

        const [antiVecs, candidateEmbeddings, excludedSet] = await Promise.all([
            antiPromise,
            fetchEmbeddingsByCanonical(supabase, candidateIds),
            excludedPromise,
        ]);

        // Full density: score every candidate against ALL star vectors (not just
        // the per-star top-K page), minus the density of recently skipped reads.
        const ranked = rankByDensityFromEmbeddings({
            candidateEmbeddings,
            candidateFeeds,
            starVectors,
            antiVectors: antiVecs.map(a => a.embedding),
            excluded: excludedSet,
            starCanonicalIds,
            // Home "Related": rank by the single most-similar starred paper so the
            // literal closest match is on top (vs density's "near many stars").
            rankBy: 'maxsim',
        });

        if (ranked.length === 0) {
            return NextResponse.json({
                articles: [],
                message: 'No unread articles found',
            });
        }

        const unreadIds = ranked.map(r => r.canonicalId);

        return NextResponse.json({
            unread: unreadIds,
            starred: [],
            read: [],
            profile_info: {
                method: 'density-pos-minus-neg',
                n_stars: starVecs.length,
                n_anti: antiVecs.length,
                tau: KNN_TAU,
                lambda: KNN_LAMBDA,
            },
            stats: {
                total_unread: unreadIds.length,
                returned: unreadIds.length,
            }
        }, {
            // Per-user; browser cache only. Keeps Related re-entries snappy.
            headers: {
                'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
            },
        });

    } catch (error) {
        console.error('Recommendations API error:', error);
        return NextResponse.json(FAILURE_RESPONSE_BODY, { status: 500 });
    }
}
