/**
 * Affiliation API — resolves the author/lab/institution entity for a paper on demand.
 *
 * GET /api/affiliation?canonicalId=&doi=&arxivId=&title=&authors=&year=
 *   Returns { data: AffiliationData | null }. Used by the live UI (AuthorAffiliation,
 *   share text) for papers whose affiliation isn't already in the feed payload.
 *
 * Fast path: a synchronous peek of the shared in-process cache (warmed by the feed)
 * returns instantly. Concurrent requests for the same paper share one resolution
 * (dedupe). Misses resolve via the shared resolver and are stored for next time.
 *
 * Public metadata, no auth. Heavily cacheable — the answer is stable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveAffiliation } from '@/lib/affiliationResolver';
import { peekAffiliation, storeAffiliation, dedupeResolve } from '@/lib/affiliationServerCache';
import type { AffiliationData } from '@/lib/affiliation';

export const runtime = 'nodejs';

const HIT_TTL = 'public, max-age=86400, s-maxage=604800';
const MISS_TTL = 'public, max-age=3600, s-maxage=86400';

export async function GET(request: NextRequest) {
    const p = request.nextUrl.searchParams;
    const canonicalId = p.get('canonicalId') || undefined;
    const doi = p.get('doi');
    const arxivId = p.get('arxivId');
    const title = p.get('title');
    if (!doi && !arxivId && !title) {
        return NextResponse.json({ data: null }, { status: 400 });
    }

    // Fast path: warm in-process cache (shared with the feed warm-cache).
    const cached = peekAffiliation(canonicalId);
    if (cached !== undefined) {
        return NextResponse.json({ data: cached }, { headers: { 'Cache-Control': cached ? HIT_TTL : MISS_TTL } });
    }

    const yearRaw = p.get('year');
    const year = yearRaw && /^\d{4}$/.test(yearRaw) ? parseInt(yearRaw, 10) : null;

    try {
        const data = await dedupeResolve(canonicalId, async (): Promise<AffiliationData | null> => {
            const resolved = await resolveAffiliation({
                doi, arxivId, title,
                authors: p.get('authors'),
                year,
                signal: AbortSignal.timeout(20000),
            });
            if (!resolved || !resolved.lastAuthorLastName) return null;
            return {
                firstAuthorName: resolved.firstAuthorName,
                firstAuthorLastName: resolved.firstAuthorLastName,
                isMultiAuthor: resolved.isMultiAuthor,
                lastAuthorName: resolved.lastAuthorName,
                lastAuthorLastName: resolved.lastAuthorLastName,
                institutionName: resolved.institutionName,
                institutionLogo: resolved.institutionLogo,
                institutionUrl: resolved.institutionUrl,
            };
        });
        storeAffiliation(canonicalId, data);
        return NextResponse.json({ data }, { headers: { 'Cache-Control': data ? HIT_TTL : MISS_TTL } });
    } catch (err) {
        console.error('affiliation resolve error:', err);
        return NextResponse.json({ data: null }, { status: 200 });
    }
}
