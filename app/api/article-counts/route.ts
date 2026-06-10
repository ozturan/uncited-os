import { NextResponse } from 'next/server';
import { serviceSupabase } from '@/lib/paperFeed';

// Per-journal article counts for the last 30 days. Drives the journal-grid
// badges in the sidebar.
//
// Now an ISR route querying Supabase live (via the journal_counts_since
// RPC) instead of fetching a pre-generated /data/stats.json. Vercel
// regenerates the response every 30 minutes; CDN serves cache hits in
// between. Eliminates the dependency on scripts/generate-stats.js.

// Render on-demand (NOT prerendered at build) so a Supabase outage during the
// build can't time out and abort the whole deploy. The CDN still caches the
// response for 30 min via the Cache-Control headers set below, so the database
// is hit at most ~once per window — same effective caching, no build-time
// dependency on the DB being up.
export const dynamic = 'force-dynamic';

const SINCE_DAYS = 30;

export async function GET() {
  try {
    const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const supabase = serviceSupabase();
    const { data, error } = await supabase.rpc('journal_counts_since', { p_since: since });
    if (error) {
      console.error('[article-counts] RPC error:', error.message);
      // Apply migrations/38_journal_counts_since.sql in Supabase if this
      // happens. Fall through to empty so the badges hide gracefully.
      return NextResponse.json({}, {
        headers: { 'Cache-Control': 'public, s-maxage=60' },
      });
    }

    const counts: Record<string, number> = {};
    for (const row of data || []) {
      if (row.primary_source) counts[row.primary_source] = Number(row.count) || 0;
    }
    return NextResponse.json(counts, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    console.error('[article-counts] error:', err);
    return NextResponse.json({}, {
      status: 500,
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }
}
