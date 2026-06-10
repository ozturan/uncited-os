/**
 * Vector-index warmup. The recommendation/discover RPCs cold-start at ~6s when
 * their HNSW index + the followed-feed embedding rows have been evicted from
 * Postgres shared_buffers; warm they run in ~0.3s. Feeds ingest only every 3h
 * (GitHub Actions), so between runs the index goes cold and My Field's first
 * load pays the 6s. A Vercel cron hits this every few minutes to keep both the
 * match_papers (followed-feed scan) and match_papers_discover (ANN) paths hot,
 * so real users never see the cold path.
 *
 * It REPLAYS a real (follows, centroid) query from an existing user so it warms
 * the exact pages real requests touch — an empty-feeds query would short-circuit
 * before the vector scan and warm nothing.
 *
 * Auth: if CRON_SECRET is set, require `Authorization: Bearer <CRON_SECRET>`
 * (Vercel attaches this to cron invocations automatically). Without the env var
 * it is open but harmless (does two bounded, read-only RPCs).
 */
import { NextRequest, NextResponse } from 'next/server';
import { serviceSupabase } from '@/lib/paperFeed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (secret) {
        const auth = request.headers.get('authorization');
        if (auth !== `Bearer ${secret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    const t0 = Date.now();
    try {
        const supabase = serviceSupabase();

        // A representative user with a field_centroid + followed feeds.
        const { data: states } = await supabase
            .from('user_state')
            .select('follows, settings')
            .not('settings->field_centroid', 'is', null)
            .limit(20);

        const u = (states || []).find(
            (s: { follows?: string[]; settings?: { field_centroid?: number[] } }) =>
                Array.isArray(s.follows) && s.follows.length > 0 &&
                Array.isArray(s.settings?.field_centroid) && s.settings!.field_centroid!.length === 256
        ) as { follows: string[]; settings: { field_centroid: number[] } } | undefined;

        const cutoff30 = new Date(); cutoff30.setDate(cutoff30.getDate() - 30);
        const cutoff60 = new Date(); cutoff60.setDate(cutoff60.getDate() - 60);

        // Fallback synthetic unit vector (only warms the discover ANN path) if no
        // suitable user exists yet.
        const probe = u?.settings.field_centroid
            || Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0));
        const follows = u?.follows || [];

        const tasks: PromiseLike<unknown>[] = [
            supabase.rpc('match_papers_discover', {
                query_embedding: probe,
                match_count: 240,
                min_published_date: cutoff60.toISOString(),
                p_excluded_feeds: follows.length ? follows : null,
            }),
        ];
        if (follows.length) {
            tasks.push(
                supabase.rpc('match_papers', {
                    query_embedding: probe,
                    match_count: 500,
                    p_filter_feeds: follows,
                    min_published_date: cutoff30.toISOString(),
                    excluded_canonical_ids: [],
                })
            );
        }

        await Promise.all(tasks);

        return NextResponse.json(
            { ok: true, warmed: follows.length ? ['match_papers', 'match_papers_discover'] : ['match_papers_discover'], ms: Date.now() - t0 },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    } catch (error) {
        return NextResponse.json({ ok: false, error: String(error), ms: Date.now() - t0 }, { status: 500 });
    }
}
