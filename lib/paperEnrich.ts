/**
 * Shared client cache + prefetch queue for OpenAlex paper enrichment
 * (open-access PDF link + topics) used by the expanded-card detail view.
 *
 * Why a shared module: the card list prefetches enrichment for visible papers
 * (10 in flight at a time) so that when a user expands/opens a paper the data
 * is already in `enrichCache` and renders instantly — no spinner, no wait. The
 * PaperDetailExtras component reads the same cache, so a prefetched paper shows
 * its pills immediately. Everything is deduped by DOI across the whole session.
 */
import type { Entry } from './types';
import { lruSet } from './persistentCache';

export type Enrich = {
  oa: { isOa: boolean; pdfUrl: string | null; landingUrl: string | null; license: string | null; status: string | null };
  topics: { name: string; field: string | null }[];
  social?: {
    first: { orcid: string | null; x: string | null; bluesky: string | null; scholar: string | null; name: string | null } | null;
    last: { orcid: string | null; x: string | null; bluesky: string | null; scholar: string | null; name: string | null } | null;
  };
};

const enrichCache = new Map<string, Enrich>();
const inflight = new Map<string, Promise<Enrich | null>>();

// Persist OA/topics across sessions (localStorage), mirroring lib/affiliation:
// once a paper's PDF link + topics resolve on a device, the card renders them
// instantly on every later visit instead of re-hitting OpenAlex/Unpaywall. A
// fully-resolved record is kept permanently; an empty/unresolved one expires so
// a freshly-indexed paper auto-upgrades. Social (ORCID) is intentionally NOT
// persisted — it's only fetched on expand and kept session-only.
const PERSIST_PREFIX = 'uncited_enrich_v1_';
const PERSIST_INDEX = 'uncited_enrich_idx_v1';
const PERSIST_MAX = 2000; // bound localStorage growth (~1-1.5MB); LRU-evict beyond
const PERSIST_RETRY_TTL_MS = 1000 * 60 * 60 * 24 * 3; // retry empty records after 3 days
const isResolved = (e: Enrich): boolean => !!(e.oa?.isOa || e.oa?.pdfUrl || e.oa?.landingUrl || e.topics?.length);

function readPersisted(doi: string): Enrich | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PERSIST_PREFIX + doi);
    if (!raw) return null;
    const env = JSON.parse(raw) as { e: Enrich; t: number };
    if (!env?.e) return null;
    if (!isResolved(env.e) && Date.now() - env.t > PERSIST_RETRY_TTL_MS) {
      window.localStorage.removeItem(PERSIST_PREFIX + doi);
      return null;
    }
    return env.e;
  } catch { return null; }
}

function writePersisted(doi: string, e: Enrich): void {
  if (typeof window === 'undefined') return;
  try {
    // Persist OA + topics + author socials (ORCID/Scholar/X/Bluesky are public
    // profile links, not PII) so the card's social icons render warm on every
    // later visit instead of re-resolving. LRU-bounded to cap localStorage use.
    lruSet(PERSIST_INDEX, PERSIST_PREFIX + doi, JSON.stringify({ e, t: Date.now() }), PERSIST_MAX);
  } catch { /* storage full / disabled — skip, session cache still serves this tab */ }
}
// Author-social (ORCID) is resolved separately and only on card expand, so the
// visible-card prefetch never triggers ORCID lookups.
const socialInflight = new Map<string, Promise<Enrich | null>>();
const socialDone = new Set<string>();

// Per-DOI subscribers, notified whenever the cache for that DOI is (re)written.
// Lets a component (e.g. the inline PDF button) reveal itself when the visible-
// card prefetch warms the OA link, without itself triggering a fetch.
const listeners = new Map<string, Set<() => void>>();

/** Subscribe to cache updates for one DOI. Returns an unsubscribe fn. */
export function subscribeEnrich(doi: string | null, cb: () => void): () => void {
  if (!doi) return () => { };
  let set = listeners.get(doi);
  if (!set) { set = new Set(); listeners.set(doi, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (!set!.size) listeners.delete(doi); };
}

function mergeIntoCache(doi: string, d: Enrich): Enrich {
  const prev = enrichCache.get(doi);
  // Keep a non-empty social over an empty one (prefetch returns empty social).
  const incomingHasSocial = !!(d.social && (d.social.first || d.social.last));
  const social = incomingHasSocial ? d.social : (prev?.social ?? d.social);
  const merged = { ...prev, ...d, social } as Enrich;
  enrichCache.set(doi, merged);
  writePersisted(doi, merged);
  const ls = listeners.get(doi);
  if (ls) for (const cb of ls) cb();
  return merged;
}

export function normalizeDoi(raw: string | null | undefined): string | null {
  const d = (raw || '')
    .replace(/^doi:/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/[?#].*$/, '')
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
}

export function doiForEntry(entry: Pick<Entry, 'doi' | 'canonicalId'>): string | null {
  const fromCanonical = entry.canonicalId?.startsWith('doi:') ? entry.canonicalId.slice(4) : '';
  return normalizeDoi(entry.doi || fromCanonical);
}

export function getCachedEnrich(doi: string | null): Enrich | null {
  if (!doi) return null;
  const mem = enrichCache.get(doi);
  if (mem) return mem;
  // Read-through to the persisted store so a card resolved on a previous visit
  // paints instantly without a fetch. Hydrate the in-memory cache on hit.
  const persisted = readPersisted(doi);
  if (persisted) { enrichCache.set(doi, persisted); return persisted; }
  return null;
}

// OA + topics only (no ORCID/social). Used by the visible-card prefetch and as
// the instant first paint when a card expands.
export function fetchEnrich(doi: string): Promise<Enrich | null> {
  // Read-through (mem → persisted) so a paper resolved on a prior visit is never
  // re-fetched; only genuinely-unknown DOIs hit the network.
  const cached = getCachedEnrich(doi);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(doi);
  if (existing) return existing;
  const p = fetch(`/api/paper-enrich?doi=${encodeURIComponent(doi)}`)
    .then(r => (r.ok ? r.json() : null))
    .then((d: Enrich | null) => { const m = d ? mergeIntoCache(doi, d) : null; inflight.delete(doi); return m; })
    .catch(() => { inflight.delete(doi); return null; });
  inflight.set(doi, p);
  return p;
}

// Full enrichment INCLUDING author socials (ORCID). Merges the resolved social
// into the shared cache. Returns a cached/persisted result without a network
// call when social is already known, so warmed papers never re-resolve.
export function fetchEnrichSocial(doi: string): Promise<Enrich | null> {
  const cached = getCachedEnrich(doi); // mem → persisted (restores warmed social)
  if (cached && (socialDone.has(doi) || cached.social?.first || cached.social?.last)) {
    socialDone.add(doi);
    return Promise.resolve(cached);
  }
  const existing = socialInflight.get(doi);
  if (existing) return existing;
  // v3: scholar is now a resolved real profile URL (via Startpage), not a name
  // search. The bump is a fresh CDN cache key so we don't read stale responses.
  const p = fetch(`/api/paper-enrich?doi=${encodeURIComponent(doi)}&social=1&v=3`)
    .then(r => (r.ok ? r.json() : null))
    .then((d: Enrich | null) => {
      const m = d ? mergeIntoCache(doi, d) : null;
      if (d) socialDone.add(doi);
      socialInflight.delete(doi);
      return m;
    })
    .catch(() => { socialInflight.delete(doi); return null; });
  socialInflight.set(doi, p);
  return p;
}

// Background prefetch queue, capped at 10 concurrent requests so we warm the
// cache for visible papers without hammering OpenAlex (which the per-DOI CDN
// cache then serves cheaply for everyone). Deduped against cache + in-flight.
const MAX_CONCURRENT = 10;
const queue: Array<{ doi: string; social: boolean }> = [];
const queued = new Set<string>();
let active = 0;

const socialResolved = (doi: string): boolean => {
  if (socialDone.has(doi)) return true;
  const c = getCachedEnrich(doi);
  return !!(c && (c.social?.first || c.social?.last));
};

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { doi, social } = queue.shift()!;
    queued.delete(doi);
    if (social ? socialResolved(doi) : !!getCachedEnrich(doi)) continue;
    active++;
    (social ? fetchEnrichSocial(doi) : fetchEnrich(doi)).finally(() => { active--; pump(); });
  }
}

/**
 * Warm the enrichment cache for a list of papers, 10 requests in flight at a
 * time. With `{ social: true }` it warms OA + topics + author socials (one
 * call), so the card's ORCID/Scholar icons render warm instead of popping in on
 * scroll. Skips anything already cached/persisted (no network) and dedups
 * against in-flight + queued.
 */
export function prefetchEnrich(
  entries: Pick<Entry, 'doi' | 'canonicalId'>[],
  opts?: { social?: boolean },
): void {
  const social = !!opts?.social;
  for (const e of entries) {
    const doi = doiForEntry(e);
    if (!doi || queued.has(doi)) continue;
    if (social ? (socialResolved(doi) || socialInflight.has(doi)) : (!!getCachedEnrich(doi) || inflight.has(doi))) continue;
    queued.add(doi);
    queue.push({ doi, social });
  }
  pump();
}
