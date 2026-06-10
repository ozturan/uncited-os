import { lruSet } from './persistentCache';

// Client-side affiliation helper. The heavy resolution (Crossref → landing-page
// meta → OpenAlex → author-level lookup → institution homepage) now lives server-side
// in lib/affiliationResolver.ts behind /api/affiliation, so the card, the share text,
// and the feed warm-cache all produce the SAME entity. This module just calls that
// route and caches the result.

export interface AffiliationData {
    firstAuthorName: string;         // full display name, e.g. "Alice Cook"
    firstAuthorLastName: string;     // surname only, for compact UI labels
    isMultiAuthor: boolean;
    lastAuthorName: string;          // full display name
    lastAuthorLastName: string;      // surname only
    institutionName: string;
    institutionLogo: string;
    institutionUrl: string;
}

const CACHE_PREFIX = 'uncited_aff_v6_';        // v6: server-resolved (Crossref-first + author-lookup)
// Persist across sessions (localStorage, not sessionStorage): once a paper is fully
// resolved on a device it renders instantly on every later view, so the author line
// never re-resolves or flashes again. Partial results (no institution yet) and misses
// expire so the paper auto-upgrades to the full line once OpenAlex indexes it.
const RETRY_TTL_MS = 1000 * 60 * 60 * 24 * 3;  // re-attempt partial/unresolved papers after 3 days

interface CacheEnvelope { d: AffiliationData | null; t: number; }

export function getCached(key: string): AffiliationData | 'none' | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const env = JSON.parse(raw) as CacheEnvelope;
        // Complete (has institution) → cache permanently.
        if (env.d && env.d.institutionName) return env.d;
        // Partial or negative → expire so we retry and converge to the full entity.
        if (Date.now() - env.t > RETRY_TTL_MS) { localStorage.removeItem(key); return null; }
        return env.d ?? 'none';
    } catch {
        return null;
    }
}

const CACHE_INDEX = 'uncited_aff_idx_v6';
const CACHE_MAX = 2000; // LRU-bound localStorage growth (~1MB)

export function setCached(key: string, val: AffiliationData | 'none'): void {
    const env: CacheEnvelope = { d: val === 'none' ? null : val, t: Date.now() };
    lruSet(CACHE_INDEX, key, JSON.stringify(env), CACHE_MAX);
}

export function affiliationCacheKey(canonicalId: string | undefined): string | null {
    return canonicalId ? `${CACHE_PREFIX}${canonicalId}` : null;
}

export function deriveDoi(doi?: string, arxivId?: string): string | null {
    if (doi) return doi.replace(/^https?:\/\/doi\.org\//, '').replace(/[?#].*$/, '');
    if (arxivId) return `10.48550/arXiv.${arxivId}`;
    return null;
}

// RSS surnames are passed to the resolver as a title-search disambiguation signal.
export function extractRssSurnames(raw: string | null): string[] {
    if (!raw) return [];
    const cleaned = raw.replace(/\s+et\s+al\.?\s*$/i, '').trim();
    if (!cleaned) return [];
    return cleaned
        .split(/\s*,\s*|\s+&\s+|\s+and\s+/i)
        .map(s => s.trim().split(/\s+/).pop() || '')
        .map(s => s.toLowerCase())
        .filter(s => s.length >= 2);
}

// Client-side concurrency gate. A long feed page mounts ~100 AuthorAffiliation
// components that each want to resolve; without a cap they fire ~100 simultaneous
// GET /api/affiliation requests, saturating the browser's per-host connection pool
// and the serverless function pool — which is the SAME pool serving the vector
// recommendation/discover call the user is actually waiting on. Capping to a small
// number of in-flight resolutions removes that contention; the rest queue and drain
// as slots free up (FIFO ≈ top-to-bottom of the visible list).
const MAX_CONCURRENT_AFFILIATION = 5;
let activeAffiliation = 0;
const affiliationQueue: Array<() => void> = [];

function acquireAffiliationSlot(): Promise<void> {
    if (activeAffiliation < MAX_CONCURRENT_AFFILIATION) {
        activeAffiliation++;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => {
        affiliationQueue.push(() => { activeAffiliation++; resolve(); });
    });
}

function releaseAffiliationSlot(): void {
    activeAffiliation = Math.max(0, activeAffiliation - 1);
    const next = affiliationQueue.shift();
    if (next) next();
}

// Resolve via the server route. `doi` here is already DOI-or-arxiv-derived (deriveDoi).
// `canonicalId` lets the route key its shared in-process cache for instant repeats.
export async function fetchAffiliation(
    canonicalId: string | undefined,
    doi: string | null,
    title: string | null,
    publishedYear: number | null,
    rssSurnames: string[],
    signal: AbortSignal,
): Promise<AffiliationData | null> {
    const params = new URLSearchParams();
    if (canonicalId) params.set('canonicalId', canonicalId);
    if (doi) params.set('doi', doi);
    if (title) params.set('title', title);
    if (publishedYear) params.set('year', String(publishedYear));
    if (rssSurnames.length) params.set('authors', rssSurnames.join(', '));
    if ([...params.keys()].length === 0) return null;

    // Don't even take a slot if the card already scrolled away / unmounted.
    if (signal.aborted) return null;
    await acquireAffiliationSlot();
    try {
        if (signal.aborted) return null;
        const res = await fetch(`/api/affiliation?${params.toString()}`, { signal });
        if (!res.ok) return null;
        const json = await res.json();
        return (json?.data as AffiliationData) ?? null;
    } catch {
        return null;
    } finally {
        releaseAffiliationSlot();
    }
}

// Read the cache; if missing, fetch and store. Used by the share button so the
// copied text contains the same info shown in the affiliation row.
export async function getOrFetchAffiliation(args: {
    canonicalId: string | undefined;
    doi?: string;
    arxivId?: string;
    title?: string;
    parentAuthorsRaw: string | null;
    parentPublished: string | null;
    signal?: AbortSignal;
}): Promise<AffiliationData | null> {
    const key = affiliationCacheKey(args.canonicalId);
    if (key) {
        const cached = getCached(key);
        if (cached && cached !== 'none') return cached;
        if (cached === 'none') return null;
    }
    const lookupDoi = deriveDoi(args.doi, args.arxivId);
    if (!lookupDoi && !args.title) return null;
    const rssSurnames = extractRssSurnames(args.parentAuthorsRaw);
    const publishedYear = (() => {
        if (!args.parentPublished) return null;
        const y = parseInt(args.parentPublished.slice(0, 4), 10);
        return Number.isFinite(y) && y > 1900 && y < 2100 ? y : null;
    })();
    const signal = args.signal ?? new AbortController().signal;
    try {
        const result = await fetchAffiliation(args.canonicalId, lookupDoi, args.title || null, publishedYear, rssSurnames, signal);
        if (key) setCached(key, result || 'none');
        return result;
    } catch {
        return null;
    }
}

// Build the author/lab/affiliation line for the share clipboard text.
// Mirrors the card's render order so the copied text matches what's shown.
export function formatAffiliationForShare(
    data: AffiliationData | null,
    fallbackAuthors: string | null,
    fallbackSurname: string | null,
): string {
    if (data) {
        const parts: string[] = [];
        const first = data.firstAuthorLastName;
        const last = data.lastAuthorLastName;
        // Leading author (suppressed when it equals the lab head, i.e. single-author).
        if (first && first.toLowerCase() !== (last || '').toLowerCase()) {
            parts.push(data.isMultiAuthor ? `${first} et al.` : first);
        }
        if (last) parts.push(data.isMultiAuthor ? `${last} Lab` : last);
        if (data.institutionName) parts.push(data.institutionName);
        if (parts.length) return parts.join(' · ');
    }
    if (fallbackAuthors) return fallbackAuthors;
    if (fallbackSurname) return `${fallbackSurname} et al.`;
    return '';
}
