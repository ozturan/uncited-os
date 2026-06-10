// Server-side affiliation cache for instant first paint, WITHOUT a schema migration.
//
// The feed attaches any already-resolved entity to the payload (zero added latency —
// it's a synchronous in-process Map peek), so the card renders the full author line on
// first paint with no client fetch and no flash. Misses are resolved in the background
// via after() so the NEXT load is instant too. On a cold instance the Map is empty, so
// behaviour degrades exactly to the client-side path (no regression) and self-warms.
//
// The Map is per-instance and ephemeral (no durable store without a migration); combined
// with the client's persistent localStorage cache this covers the common cases.

import { resolveAffiliation, type ResolvedAffiliation } from './affiliationResolver';
import type { AffiliationData } from './affiliation';
import type { EntryShape } from './paperFeed';

const MAX_ENTRIES = 5000;
// canonicalId → resolved client entity, or null for a known miss. Absent key = unknown.
const cache = new Map<string, AffiliationData | null>();
// In-flight resolutions, so concurrent requests for the same paper share one resolve.
const inflight = new Map<string, Promise<AffiliationData | null>>();

/** Synchronous peek by canonicalId. undefined = unknown, null = known miss, object = hit. */
export function peekAffiliation(canonicalId?: string): AffiliationData | null | undefined {
    if (!canonicalId) return undefined;
    return cache.has(canonicalId) ? (cache.get(canonicalId) as AffiliationData | null) : undefined;
}

/** Store a resolved entity (or null miss) under canonicalId, with LRU eviction. */
export function storeAffiliation(canonicalId: string | undefined, data: AffiliationData | null): void {
    if (!canonicalId) return;
    if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(canonicalId, data);
}

/** De-duplicate concurrent resolutions of the same paper (a feed fires many at once). */
export function dedupeResolve(canonicalId: string | undefined, run: () => Promise<AffiliationData | null>): Promise<AffiliationData | null> {
    if (!canonicalId) return run();
    const existing = inflight.get(canonicalId);
    if (existing) return existing;
    const p = run().finally(() => inflight.delete(canonicalId));
    inflight.set(canonicalId, p);
    return p;
}

function toClient(r: ResolvedAffiliation | null): AffiliationData | null {
    if (!r || !r.lastAuthorLastName) return null;
    return {
        firstAuthorName: r.firstAuthorName,
        firstAuthorLastName: r.firstAuthorLastName,
        isMultiAuthor: r.isMultiAuthor,
        lastAuthorName: r.lastAuthorName,
        lastAuthorLastName: r.lastAuthorLastName,
        institutionName: r.institutionName,
        institutionLogo: r.institutionLogo,
        institutionUrl: r.institutionUrl,
    };
}

function toYear(s: string | null | undefined): number | null {
    if (!s) return null;
    const y = parseInt(s.slice(0, 4), 10);
    return Number.isFinite(y) && y > 1900 && y < 2100 ? y : null;
}

export interface WarmItem {
    key: string;
    doi?: string;
    arxivId?: string;
    title?: string;
    authors?: string;
    year: number | null;
}

/** Attach already-cached affiliations to entries (synchronous, zero latency).
 *  Returns the misses to warm in the background so later loads are instant. */
export function attachCachedAffiliations(entries: EntryShape[]): WarmItem[] {
    const misses: WarmItem[] = [];
    for (const e of entries) {
        const key = e.canonicalId;
        if (!key) continue;
        if (cache.has(key)) {
            const v = cache.get(key);
            if (v) e.affiliation = v;
        } else {
            misses.push({ key, doi: e.doi, arxivId: e.arxivId, title: e.title, authors: e.authors, year: toYear(e.published) });
        }
    }
    return misses;
}

// How many papers warm per page (was 15 sequential, so a 100-card page left most
// cards cold for the next load) and how many resolve concurrently. These hit only
// free metadata APIs (Crossref/OpenAlex), so modest parallelism is fine and lets the
// cache fill within a single page dwell — making the NEXT load paint full lines.
const WARM_LIMIT = 40;
const WARM_CONCURRENCY = 5;

/** Background warm (call via after()). Bounded; each paper resolves once per instance. */
export async function warmAffiliations(items: WarmItem[], limit = WARM_LIMIT): Promise<void> {
    const todo = items.slice(0, limit).filter(it => !cache.has(it.key));
    if (todo.length === 0) return;

    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < todo.length) {
            const it = todo[cursor++];
            if (cache.has(it.key)) continue;
            try {
                const r = await resolveAffiliation({
                    doi: it.doi, arxivId: it.arxivId, title: it.title, authors: it.authors, year: it.year,
                    signal: AbortSignal.timeout(20000),
                });
                if (cache.size >= MAX_ENTRIES) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
                cache.set(it.key, toClient(r));
            } catch {
                // leave the key unknown so it's retried on a later load
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(WARM_CONCURRENCY, todo.length) }, () => worker()),
    );
}
