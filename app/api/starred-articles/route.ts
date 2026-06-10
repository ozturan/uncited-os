/**
 * Starred Articles — returns starred entries that belong to journals the
 * user does NOT currently follow (so the main feed wouldn't surface them).
 *
 * Body: { starredIds: string[], followedJournals: string[] }
 *
 * Matches by legacy entry_id OR canonical_id — covers users at any stage
 * of the canonical migration.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import {
  serviceSupabase,
  SIGHTINGS_JOIN_SELECT,
  SightingRow,
  shapeEntry,
} from '@/lib/paperFeed';
import { attachCachedAffiliations, warmAffiliations } from '@/lib/affiliationServerCache';

export async function POST(request: NextRequest) {
  try {
    const { starredIds, followedJournals } = await request.json();
    if (!Array.isArray(starredIds) || starredIds.length === 0) {
      return NextResponse.json([]);
    }

    const followedSet = new Set<string>(Array.isArray(followedJournals) ? followedJournals : []);
    // Canonical IDs are prefixed (doi:, arxiv:, title:); legacy entry ids
    // are anything else. `legacy:<id>` tombstones live in starred_canonical
    // when Phase 3 couldn't resolve the legacy id — they never match any
    // papers row, so drop them instead of sending a wasted query.
    const canonicalIds: string[] = [];
    const legacyIds: string[] = [];
    for (const id of starredIds) {
      if (typeof id !== 'string') continue;
      if (id.startsWith('legacy:')) continue; // tombstone — no paper exists
      if (id.startsWith('doi:') || id.startsWith('arxiv:') || id.startsWith('title:')) {
        canonicalIds.push(id);
      } else {
        legacyIds.push(id);
      }
    }

    const supabase = serviceSupabase();

    // Chunk `in()` filters — PostgREST has a URL length limit. ~500 ids per call.
    const CHUNK = 500;
    const rows: SightingRow[] = [];

    async function fetchInChunks(field: 'legacy_entry_id' | 'paper_id', ids: string[]) {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('sightings')
          .select(SIGHTINGS_JOIN_SELECT)
          .in(field, batch)
          .limit(batch.length * 2);
        if (error) {
          console.error(`[/api/starred-articles] ${field} chunk error:`, error.message);
          continue;
        }
        if (data) rows.push(...(data as unknown as SightingRow[]));
      }
    }

    await Promise.all([
      legacyIds.length > 0 ? fetchInChunks('legacy_entry_id', legacyIds) : Promise.resolve(),
      canonicalIds.length > 0 ? fetchInChunks('paper_id', canonicalIds) : Promise.resolve(),
    ]);

    // Dedup by canonical_id + source_feed — a single paper in a followed
    // and unfollowed feed should only appear once (in the unfollowed view).
    const byKey = new Map<string, ReturnType<typeof shapeEntry>>();
    for (const row of rows) {
      if (followedSet.has(row.source_feed)) continue;
      const entry = shapeEntry(row);
      if (!entry) continue;
      const key = `${entry.canonicalId}|${entry.journalId}`;
      if (!byKey.has(key)) byKey.set(key, entry);
    }

    // Collapse cross-feed dupes — prefer the one from a journal the user
    // doesn't follow (which they all already are, given the filter above).
    const seenCanonical = new Set<string>();
    const result: NonNullable<ReturnType<typeof shapeEntry>>[] = [];
    for (const entry of byKey.values()) {
      if (!entry) continue;
      if (seenCanonical.has(entry.canonicalId)) continue;
      seenCanonical.add(entry.canonicalId);
      result.push(entry);
    }

    const misses = attachCachedAffiliations(result);
    if (misses.length) after(() => warmAffiliations(misses));

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (error) {
    console.error('Failed to load starred articles:', error);
    return NextResponse.json([], { status: 500 });
  }
}
