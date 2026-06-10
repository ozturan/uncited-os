/**
 * Phase 7 feed endpoint — reads articles from Supabase (papers + sightings).
 *
 * GET /api/feed?follows=a,b,c[&since_days=90&limit=5000]
 *
 * Thin alias over the same shape as /api/articles (?follows=...). Kept as
 * a separate clean entry point so existing callers of /api/articles can
 * stay on that path while new code uses /api/feed.
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
  const { searchParams } = new URL(request.url);
  const followsParam = searchParams.get('follows');
  const sinceDays = Math.max(1, Math.min(365, parseInt(searchParams.get('since_days') || '90', 10) || 90));
  const limit = Math.max(1, Math.min(10000, parseInt(searchParams.get('limit') || '5000', 10) || 5000));

  if (!followsParam) {
    return NextResponse.json([], { headers: { 'Cache-Control': 'public, s-maxage=60' } });
  }
  const follows = followsParam.split(',').map(s => s.trim()).filter(Boolean);
  if (follows.length === 0) {
    return NextResponse.json([], { headers: { 'Cache-Control': 'public, s-maxage=60' } });
  }

  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const supabase = serviceSupabase();

  const { rows, error } = await paginateAll<SightingRow>(() =>
    supabase
      .from('sightings')
      .select(SIGHTINGS_JOIN_SELECT)
      .in('source_feed', follows)
      .gte('papers.published_at', since)
      .order('papers(published_at)', { ascending: false }),
    limit,
  );

  if (error) {
    return NextResponse.json(
      { error },
      { status: 500, headers: { 'Cache-Control': 'public, s-maxage=30' } },
    );
  }

  const entries = rows.map(shapeEntry).filter(Boolean) as NonNullable<ReturnType<typeof shapeEntry>>[];
  entries.sort(sortByPublishedDesc);

  const misses = attachCachedAffiliations(entries);
  if (misses.length) after(() => warmAffiliations(misses));

  return NextResponse.json(entries, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}
