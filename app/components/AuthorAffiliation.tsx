'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
    AffiliationData,
    affiliationCacheKey,
    deriveDoi,
    extractRssSurnames,
    fetchAffiliation,
    getCached,
    setCached,
} from '@/lib/affiliation';
import { normalizeDoi, fetchEnrichSocial, getCachedEnrich } from '@/lib/paperEnrich';

type SocialHandle = { orcid: string | null; x: string | null; bluesky: string | null; scholar: string | null; name: string | null };
type AuthorSocial = { first: SocialHandle | null; last: SocialHandle | null };

// An author is "linkable" if we have their ORCID, a real handle, or a name (for
// a Google Scholar exact-author search).
const handleHasAny = (h?: SocialHandle | null): boolean => !!(h && (h.orcid || h.x || h.bluesky || h.scholar || h.name));

// Google Scholar exact-author article search. Opened in the user's browser (so
// no server IP block), the author:"..." operator reliably surfaces this exact
// author's work and shows their profile box at the top when they have one.
const scholarAuthorSearch = (name: string): string =>
    `https://scholar.google.com/scholar?q=${encodeURIComponent(`author:"${name}"`)}`;

const IconOrcid = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="11" fill="#A6CE39" />
        <path fill="#fff" d="M7.4 8.3a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1zM6.6 9.6h1.6v8.1H6.6V9.6zm3.1 0h3.1c3 0 4.3 2.1 4.3 4.05 0 2.1-1.65 4.05-4.3 4.05H9.7V9.6zm1.6 1.45v5.2h1.4c2 0 2.7-1.5 2.7-2.6 0-1.8-1.15-2.6-2.7-2.6h-1.4z" />
    </svg>
);

const IconX = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.244 2H21l-6.56 7.49L22 22h-6.828l-5.35-7.02L3.6 22H1l7.06-8.06L2 2h6.828l4.89 6.43L18.244 2zm-2.41 18h2.103L8.27 4H6.06l9.774 16z" />
    </svg>
);
const IconBsky = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 9.5c1.7-3.6 5-6.5 7.5-7.3.9-.3 1.8.6 1.5 1.5-.8 2.5-3.7 5.8-7.3 7.5 3.6 1.7 6.5 5 7.3 7.5.3.9-.6 1.8-1.5 1.5-2.5-.8-5.8-3.7-7.5-7.3-1.7 3.6-5 6.5-7.5 7.3-.9.3-1.8-.6-1.5-1.5.8-2.5 3.7-5.8 7.3-7.5-3.6-1.7-6.5-5-7.3-7.5C2.2 2.8 3.1 1.9 4 2.2 6.5 3 9.8 5.9 11.5 9.5z" />
    </svg>
);
const IconScholar = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2 1 8l11 6 9-4.9V16h2V8L12 2zM5 13.2v3.3L12 20l7-3.5v-3.3L12 17 5 13.2z" />
    </svg>
);

// One author's profile icons, rendered inline right after that author's name.
// ORCID (verified page) and Scholar (real link if listed, otherwise a name
// search) are the common ones; X/Bluesky show only when the author listed them.
const SocialIcons: React.FC<{ handle?: SocialHandle | null; name?: string | null }> = ({ handle, name }) => {
    const orcid = handle?.orcid || null;
    const x = handle?.x || null;
    const bluesky = handle?.bluesky || null;
    const effName = name || handle?.name || null;
    // A real profile if the author listed one on ORCID, else an exact-author search.
    const scholarHref = handle?.scholar || (effName ? scholarAuthorSearch(effName) : null);
    if (!orcid && !x && !bluesky && !scholarHref) return null;
    const who = effName || 'Author';
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    const linkStyle: React.CSSProperties = { color: 'inherit', display: 'inline-flex', opacity: 0.7 };
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 3 }}>
            {orcid && <a href={orcid} target="_blank" rel="noopener noreferrer" title={`${who} on ORCID`} onClick={stop} style={{ display: 'inline-flex' }}><IconOrcid /></a>}
            {x && <a href={x} target="_blank" rel="noopener noreferrer" title={`${who} on X`} onClick={stop} style={linkStyle}><IconX /></a>}
            {bluesky && <a href={bluesky} target="_blank" rel="noopener noreferrer" title={`${who} on Bluesky`} onClick={stop} style={linkStyle}><IconBsky /></a>}
            {scholarHref && <a href={scholarHref} target="_blank" rel="noopener noreferrer" title={`${who} on Google Scholar`} onClick={stop} style={linkStyle}><IconScholar /></a>}
        </span>
    );
};

interface Props {
    canonicalId: string | undefined;
    doi: string | undefined;
    arxivId: string | undefined;
    title: string | undefined;
    /** Author label from the RSS feed (e.g., "Cook" or "Cook et al."). Used only as a
     *  best-effort fallback if resolution yields nothing — never shown mid-resolve. */
    parentAuthorLastName: string | null;
    /** Full RSS author string and publication date — disambiguation signals for the
     *  title-search fallback when the paper has no DOI or the DOI 404s. */
    parentAuthorsRaw: string | null;
    parentPublished: string | null;
    /** Reports whether this component currently renders any author content, so the
     *  parent can avoid a dangling "·" separator before the date when it's empty. */
    onContent?: (hasContent: boolean) => void;
    /** Pre-resolved entity from the feed payload. When present the card paints the
     *  full author line on first render — no fetch, no flash. */
    initialData?: AffiliationData | null;
    /** Render the institution as plain text instead of a link (avoids nesting an
     *  <a> inside an outer link, e.g. on the Trending page's card-as-link). */
    disableInstitutionLink?: boolean;
}

const AuthorAffiliation: React.FC<Props> = ({ canonicalId, doi, arxivId, title, parentAuthorLastName, parentAuthorsRaw, parentPublished, onContent, initialData, disableInstitutionLink }) => {
    const containerRef = useRef<HTMLSpanElement>(null);
    const cacheKey = affiliationCacheKey(canonicalId);
    const lookupDoi = deriveDoi(doi, arxivId);

    // Seed from the feed payload (instant) or the persistent cache, so a paper that's
    // already resolved paints the full line on first render — no fetch, no flash.
    const [data, setData] = useState<AffiliationData | null>(() => {
        if (initialData) return initialData;
        if (!cacheKey) return null;
        const c = getCached(cacheKey);
        return c && c !== 'none' ? c : null;
    });
    // `settled` = resolution has finished (payload, cache hit, known-miss, unresolvable).
    // Until then we render NOTHING for the author rather than the RSS-derived surname,
    // so the old formatAuthorLastName output never flashes before the resolved entity.
    const [settled, setSettled] = useState<boolean>(() => {
        if (initialData) return true;
        if (!cacheKey || (!lookupDoi && !title)) return true; // unresolvable → show RSS fallback
        return getCached(cacheKey) !== null;                  // cache hit or known-miss
    });

    const rssSurnames = React.useMemo(() => extractRssSurnames(parentAuthorsRaw), [parentAuthorsRaw]);
    const publishedYear = React.useMemo(() => {
        if (!parentPublished) return null;
        const y = parseInt(parentPublished.slice(0, 4), 10);
        return Number.isFinite(y) && y > 1900 && y < 2100 ? y : null;
    }, [parentPublished]);

    useEffect(() => {
        if (settled || !cacheKey) return;                     // already resolved from cache, or nothing to do
        const node = containerRef.current;
        if (!node) return;

        const ctrl = new AbortController();
        let triggered = false;

        const observer = new IntersectionObserver(
            (entries) => {
                if (triggered) return;
                if (!entries.some(e => e.isIntersecting)) return;
                triggered = true;
                observer.disconnect();

                fetchAffiliation(canonicalId, lookupDoi, title || null, publishedYear, rssSurnames, ctrl.signal)
                    .then(result => {
                        if (ctrl.signal.aborted) return;
                        if (result) {
                            setCached(cacheKey, result);
                            setData(result);
                        } else {
                            setCached(cacheKey, 'none');
                        }
                        setSettled(true);
                    })
                    .catch(() => { /* aborted or network error — leave unsettled, a retry can resolve later */ });
            },
            // Prefetch a little ahead of the viewport so the resolved entity is usually
            // ready by the time the card is seen — but not so far that a 100-card list
            // fires ~100 resolves at once (they now also queue behind a concurrency cap
            // in lib/affiliation.ts; a tighter margin keeps the queue short).
            { rootMargin: '300px' },
        );

        observer.observe(node);

        return () => {
            observer.disconnect();
            ctrl.abort();
        };
    }, [settled, cacheKey, lookupDoi, title, publishedYear, rssSurnames]);

    // Author socials (X/Bluesky/Scholar) from the lead/senior author's public
    // ORCID record. Resolved lazily on visibility — only for cards actually
    // scrolled near the viewport — and cached/deduped per DOI, so it never
    // blasts the whole list. Only DOIs resolve (OpenAlex is keyed by DOI).
    const enrichDoi = React.useMemo(
        () => normalizeDoi(doi || (canonicalId?.startsWith('doi:') ? canonicalId.slice(4) : '')),
        [doi, canonicalId],
    );
    // Seed from the enrich cache (mem → persisted) so socials warmed by the
    // background prefetch or a prior visit render immediately, no pop-in.
    const [social, setSocial] = useState<AuthorSocial | null>(() => {
        const c = enrichDoi ? getCachedEnrich(enrichDoi) : null;
        return (c?.social && (c.social.first || c.social.last)) ? c.social : null;
    });

    useEffect(() => {
        if (!enrichDoi) return;
        const node = containerRef.current;
        if (!node) return;
        let done = false;
        const obs = new IntersectionObserver(
            (entries) => {
                if (done || !entries.some(e => e.isIntersecting)) return;
                done = true;
                obs.disconnect();
                fetchEnrichSocial(enrichDoi).then(d => {
                    const s = d?.social;
                    if (s && (s.first || s.last)) setSocial(s);
                });
            },
            { rootMargin: '300px' },
        );
        obs.observe(node);
        return () => obs.disconnect();
    }, [enrichDoi]);

    const parentSurname = (parentAuthorLastName || '')
        .replace(/\s+et\s*al\.?\s*$/i, '')
        .trim()
        .toLowerCase();

    let leadingLabel = '';
    if (data && data.firstAuthorLastName) {
        // Resolved: derive the leading author from the SAME source as the lab, so the
        // name, the "et al." marker, and the lab are always mutually consistent.
        // Suppress it for single-author papers (first == last), where we just show the lab.
        const sameAsLast = data.firstAuthorLastName.toLowerCase() === data.lastAuthorLastName.toLowerCase();
        if (!sameAsLast) {
            leadingLabel = data.isMultiAuthor
                ? `${data.firstAuthorLastName} et al.`
                : data.firstAuthorLastName;
        }
    } else if (data) {
        // Resolved but no first-author name (rare): fall back to RSS, suppress if == lab.
        const matches = parentSurname && parentSurname === data.lastAuthorLastName.toLowerCase();
        leadingLabel = matches ? '' : (parentAuthorLastName || '');
    } else if (settled) {
        // Resolution finished with no data → best-effort RSS surname (no worse than before).
        leadingLabel = parentAuthorLastName || '';
    }
    // else: still resolving → render nothing, so the old RSS surname never flashes
    // before being corrected by the resolved entity.

    const hasSocial = handleHasAny(social?.first) || handleHasAny(social?.last);
    const hasContent = !!(leadingLabel || data || hasSocial);
    useEffect(() => { onContent?.(hasContent); }, [hasContent, onContent]);

    return (
        <span ref={containerRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            {leadingLabel && <span>{leadingLabel}</span>}
            {/* First author's socials, right after their name */}
            {leadingLabel && <SocialIcons handle={social?.first} name={data?.firstAuthorName || social?.first?.name || null} />}
            {data && (
                <>
                    {leadingLabel && <span style={{ opacity: 0.5 }}>·</span>}
                    <span>{data.isMultiAuthor ? `${data.lastAuthorLastName} Lab` : data.lastAuthorLastName}</span>
                    {/* Senior/last author's socials, right after the lab. For a single-author
                        paper (no leading label) this is where that author's links land. */}
                    <SocialIcons handle={social?.last} name={data?.lastAuthorName || social?.last?.name || null} />
                    {data.institutionName && (
                        <>
                            <span style={{ opacity: 0.5 }}>·</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {data.institutionLogo && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={data.institutionLogo}
                                        alt=""
                                        width={12}
                                        height={12}
                                        className="aff-favicon"
                                        style={{ width: 12, height: 12, borderRadius: 2, verticalAlign: '-2px', flexShrink: 0 }}
                                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                                    />
                                )}
                                {data.institutionUrl && !disableInstitutionLink ? (
                                    <a
                                        href={data.institutionUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ color: 'inherit', textDecoration: 'none' }}
                                    >
                                        {data.institutionName}
                                    </a>
                                ) : (
                                    <span>{data.institutionName}</span>
                                )}
                            </span>
                        </>
                    )}
                </>
            )}
        </span>
    );
};

export default AuthorAffiliation;
