/**
 * Bounded localStorage helper shared by the affiliation and enrich caches.
 *
 * Both caches write one key per paper, so an active reader can accumulate
 * thousands of entries and silently hit the ~5MB quota, after which every write
 * fails and caching quietly stops helping. This keeps a per-cache index of keys
 * in recency order and evicts the oldest once the count passes `max`, with a
 * quota-recovery path that drops the oldest half and retries. Approximate LRU:
 * recency is updated on write (re-warm / re-resolve), which is enough for these
 * write-once-then-served caches.
 */

function readIndex(indexKey: string): string[] {
  try {
    const raw = localStorage.getItem(indexKey);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/** Set `key`=`value`, recording it in `indexKey`'s LRU and evicting past `max`. */
export function lruSet(indexKey: string, key: string, value: string, max: number): void {
  if (typeof window === 'undefined') return;
  const evict = (idx: string[], target: number): string[] => {
    while (idx.length > target) {
      const old = idx.shift();
      if (old && old !== key) { try { localStorage.removeItem(old); } catch { /* ignore */ } }
    }
    return idx;
  };
  try {
    localStorage.setItem(key, value);
    let idx = readIndex(indexKey);
    idx = idx.filter(k => k !== key); // move to most-recent
    idx.push(key);
    idx = evict(idx, max);
    localStorage.setItem(indexKey, JSON.stringify(idx));
  } catch {
    // Quota hit: drop the oldest half and retry once.
    try {
      let idx = readIndex(indexKey);
      idx = evict(idx, Math.floor(idx.length / 2));
      localStorage.setItem(indexKey, JSON.stringify(idx));
      localStorage.setItem(key, value);
      idx = idx.filter(k => k !== key); idx.push(key);
      localStorage.setItem(indexKey, JSON.stringify(idx));
    } catch { /* give up; in-memory cache still serves this tab */ }
  }
}
