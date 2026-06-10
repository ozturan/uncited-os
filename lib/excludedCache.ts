/**
 * Per-user cache of the read∪starred canonical-id union.
 *
 * `user_excluded_canonical` aggregates every paper the user has read or
 * starred — for heavy accounts that is 20k+ ids and ~1.5s to compute and ship
 * on EVERY recommendations / discover request. The set changes only when the
 * user reads or stars something, so a short in-process TTL cache removes the
 * repeated cost for an interactive session (clicking Related, My Field,
 * scrolling) without ever truncating the set (it caches exactly what the RPC
 * returns — the complete, server-aggregated union).
 *
 * Staleness window is TTL_MS: a paper read in the last minute can still appear
 * in a fresh recommendation list, but the client already knows it is read and
 * hides it, so the user never sees a duplicate. Cache is per warm serverless
 * instance; a cold instance simply pays the RPC once.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type CacheEntry = { set: Set<string>; expires: number };

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000; // backstop against unbounded growth on a long-lived instance

export async function getExcludedCanonicalSet(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expires > now) return hit.set;

  const { data, error } = await supabase.rpc('user_excluded_canonical', { p_user_id: userId });

  // NEVER cache a failed/empty fetch. Caching an error-derived empty set would
  // pin a truncated (zero-element) exclusion union for the whole TTL, leaking
  // every already-read/starred paper back into For You / My Field / Discover for
  // up to 60s on this warm instance. On failure, serve the last known-good set
  // if we have one (stale but COMPLETE beats empty), else return empty for THIS
  // request only and let the next request retry the RPC.
  if (error || !data) {
    return hit ? hit.set : new Set<string>();
  }

  const set = new Set<string>(data as string[]);
  if (cache.size >= MAX_ENTRIES) cache.clear(); // cheap, rare; avoids LRU bookkeeping
  cache.set(userId, { set, expires: now + TTL_MS });
  return set;
}

/** Drop a user's cached union (call after a read/star write if same-instance). */
export function invalidateExcludedCanonical(userId: string): void {
  cache.delete(userId);
}
