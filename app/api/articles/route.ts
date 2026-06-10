/**
 * Article-listing endpoint — fully backed by Supabase.
 *
 * GET /api/articles?follows=a,b,c[&since_days=90&limit=5000]
 *   Main feed. Returns Entry-shaped articles from followed journals.
 *
 * GET /api/articles?exclude=a,b,c[&limit=1000&offset=0]
 *   Discover view. Returns { articles, hasMore, total } from feeds the
 *   user doesn't follow, windowed to the last 7 days.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import {
  serviceSupabase,
  SIGHTINGS_JOIN_SELECT,
  SightingRow,
  shapeEntry,
  sortByPublishedDesc,
  paginateAll,
} from '@/lib/paperFeed';
import { attachCachedAffiliations, warmAffiliations } from '@/lib/affiliationServerCache';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const followsParam = searchParams.get('follows');
    const excludeParam = searchParams.get('exclude');
    const limit = Math.max(1, Math.min(10000, parseInt(searchParams.get('limit') || '5000', 10) || 5000));
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0);
    const sinceDays = Math.max(1, Math.min(365, parseInt(searchParams.get('since_days') || '90', 10) || 90));

    if (excludeParam !== null) {
      const exclude = excludeParam.split(',').map(s => s.trim()).filter(Boolean);
      return await loadDiscoverArticles(exclude, limit, offset);
    }

    if (!followsParam) return NextResponse.json([]);
    const follows = followsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (follows.length === 0) return NextResponse.json([]);

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const supabase = serviceSupabase();

    // Single-shot RPC — no PostgREST 1000-row cap, no pagination round-trips.
    // Prefer the _lite variant (no abstract) so the list view response
    // stays small; abstract is fetched on demand via /api/paper/<id> when
    // the user expands a card.
    const wantAbstract = searchParams.get('with_abstract') === '1';
    const rpcName = wantAbstract ? 'feed_for_follows' : 'feed_for_follows_lite';
    const rpcResult = await supabase.rpc(rpcName, {
      p_follows: follows,
      p_since: since,
      p_limit: limit,
    });

    let rows: SightingRow[] | null = null;
    if (!rpcResult.error && rpcResult.data) {
      // RPC returns flat rows; reshape into the SightingRow shape shapeEntry() expects.
      rows = (rpcResult.data as any[]).map(r => ({
        source_feed: r.source_feed,
        legacy_entry_id: r.legacy_entry_id,
        feed_link: r.feed_link,
        paper_id: r.canonical_id,
        papers: {
          canonical_id: r.canonical_id,
          title: r.title,
          // Lite RPC omits abstract + authors jsonb — leave them null for shape().
          abstract: r.abstract ?? null,
          authors: r.authors ?? null,
          authors_text: r.authors_text,
          published_at: r.published_at,
          primary_source: r.primary_source,
          primary_link: r.primary_link,
          external_ids: r.external_ids,
          categories: r.categories,
          type: r.type,
        },
      })) as SightingRow[];
    } else if (rpcResult.error && !/function .* does not exist/i.test(rpcResult.error.message)) {
      console.error('[/api/articles follows] rpc error:', rpcResult.error.message);
      return NextResponse.json([], {
        status: 500,
        headers: { 'Cache-Control': 'public, s-maxage=30' },
      });
    } else {
      // RPC missing — paginated REST fallback.
      const { rows: fb, error: fbErr } = await paginateAll<SightingRow>(() =>
        supabase
          .from('sightings')
          .select(SIGHTINGS_JOIN_SELECT)
          .in('source_feed', follows)
          .gte('papers.published_at', since)
          .order('papers(published_at)', { ascending: false }),
        limit,
      );
      if (fbErr) {
        console.error('[/api/articles follows] fallback error:', fbErr);
        return NextResponse.json([], {
          status: 500,
          headers: { 'Cache-Control': 'public, s-maxage=30' },
        });
      }
      rows = fb;
    }

    const entries = (rows ?? []).map(shapeEntry).filter(Boolean) as NonNullable<ReturnType<typeof shapeEntry>>[];
    entries.sort(sortByPublishedDesc);

    // Instant first paint: attach warm affiliations now, warm misses after the response.
    const misses = attachCachedAffiliations(entries);
    if (misses.length) after(() => warmAffiliations(misses));

    return NextResponse.json(entries, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('Failed to load articles:', error);
    return NextResponse.json([], {
      status: 500,
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }
}

async function loadDiscoverArticles(excludeJournals: string[], limit: number, offset: number) {
  try {
    const supabase = serviceSupabase();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lookahead = limit + 1;

    // Chunk-paginate past PostgREST's 1000-row cap.
    const { rows: dataRows, error } = await paginateAll<SightingRow>(() => {
      let q = supabase
        .from('sightings')
        .select(SIGHTINGS_JOIN_SELECT)
        .gte('papers.published_at', since)
        .order('papers(published_at)', { ascending: false });
      if (excludeJournals.length > 0) {
        const quoted = excludeJournals.map(s => `"${s.replace(/"/g, '""')}"`).join(',');
        q = q.not('source_feed', 'in', `(${quoted})`);
      }
      return q;
    }, offset + lookahead);
    if (error) {
      console.error('[/api/articles discover] supabase error:', error);
      return NextResponse.json({ articles: [], hasMore: false, total: 0 }, {
        status: 500,
        headers: { 'Cache-Control': 'public, s-maxage=30' },
      });
    }
    const rows = dataRows.slice(offset);
    const entries = rows.map(shapeEntry).filter(Boolean) as NonNullable<ReturnType<typeof shapeEntry>>[];
    entries.sort(sortByPublishedDesc);

    const hasMore = entries.length > limit;
    const articles = entries.slice(0, limit);

    // Instant first paint: attach warm affiliations now, warm misses after the response.
    const misses = attachCachedAffiliations(articles);
    if (misses.length) after(() => warmAffiliations(misses));

    return NextResponse.json({
      articles,
      hasMore,
      total: 0, // COUNT over 883K rows is too expensive; UI uses hasMore only.
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('Failed to load discover articles:', error);
    return NextResponse.json({ articles: [], hasMore: false, total: 0 }, {
      status: 500,
      headers: { 'Cache-Control': 'public, s-maxage=60' },
    });
  }
}
