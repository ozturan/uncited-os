/**
 * On-demand paper enrichment for the expanded-card detail view: open-access
 * status / free PDF link and OpenAlex topics, fetched live by DOI.
 *
 * Why on-demand and not stored: this needs no DB column and no backfill over
 * the ~50M-row corpus. OpenAlex is free (no key, polite pool via mailto), one
 * call fires only when a user actually expands a paper, and the public response
 * is CDN-cached per DOI so repeat views (across all users) never re-hit it.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// One author's profile links. `orcid` (their verified ORCID page) and `name`
// (for a Google Scholar name-search, built client-side) are common; x/bluesky/
// scholar are the rarely-listed real handles from their ORCID record.
type SocialHandle = { orcid: string | null; x: string | null; bluesky: string | null; scholar: string | null; name: string | null };

type Enrich = {
  oa: { isOa: boolean; pdfUrl: string | null; landingUrl: string | null; license: string | null; status: string | null };
  topics: { name: string; field: string | null }[];
  // Resolved per displayed author so the UI can render each person's links right
  // next to their name: `first` = first author, `last` = senior/last author.
  social: { first: SocialHandle | null; last: SocialHandle | null };
};

const EMPTY: Enrich = {
  oa: { isOa: false, pdfUrl: null, landingUrl: null, license: null, status: null },
  topics: [],
  social: { first: null, last: null },
};

type OAAuthorship = {
  author_position?: string;
  is_corresponding?: boolean;
  author?: { display_name?: string; orcid?: string | null };
};

type OAWork = {
  open_access?: { is_oa?: boolean; oa_url?: string | null; oa_status?: string | null };
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null; license?: string | null } | null;
  primary_location?: { pdf_url?: string | null; landing_page_url?: string | null; license?: string | null } | null;
  topics?: { display_name?: string; field?: { display_name?: string }; subfield?: { display_name?: string } }[];
  authorships?: OAAuthorship[];
};

const normalizeOrcid = (raw?: string | null): string | null => {
  const o = (raw || '').replace(/^https?:\/\/orcid\.org\//i, '').trim();
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(o) ? o : null;
};

// ORCID researcher-urls are free-form; make sure a value is an absolute http(s)
// URL so the rendered <a href> isn't treated as a relative link.
const ensureScheme = (u: string): string => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

// Build one author's profile links. The ORCID page (from the id) and the name
// (for a Scholar search) are returned whenever known; we additionally fetch the
// author's public researcher-urls to pick up a rarely-listed real X/Bluesky/
// Scholar handle. Returns null only when we know neither a name nor an ORCID.
async function resolveAuthorHandle(a: OAAuthorship | undefined): Promise<SocialHandle | null> {
  if (!a?.author) return null;
  const name = a.author.display_name || null;
  const orcidId = normalizeOrcid(a.author.orcid);
  const h: SocialHandle = { orcid: orcidId ? `https://orcid.org/${orcidId}` : null, x: null, bluesky: null, scholar: null, name };

  if (orcidId) {
    try {
      const r = await fetch(`https://pub.orcid.org/v3.0/${orcidId}/researcher-urls`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (r.ok) {
        const j = (await r.json()) as { 'researcher-url'?: { url?: { value?: string } }[] };
        for (const u of (j['researcher-url'] || []).map(u => u?.url?.value || '').filter(Boolean)) {
          if (!h.x && /(?:twitter\.com|x\.com)\//i.test(u)) h.x = ensureScheme(u);
          if (!h.bluesky && /(?:bsky\.app|bluesky)/i.test(u)) h.bluesky = ensureScheme(u);
          if (!h.scholar && /scholar\.google\./i.test(u)) h.scholar = ensureScheme(u);
        }
      }
    } catch {
      /* keep the orcid/name we already have */
    }
  }
  return (h.name || h.orcid) ? h : null;
}

// Resolve profile links for the two authors actually shown in the card line: the
// first author and the senior/last author. Each is returned separately so the UI
// can render an author's links right next to their name. Runs in parallel; a
// single-author paper (or shared ORCID) reuses one result.
async function resolveSocial(authorships: OAAuthorship[]): Promise<Enrich['social']> {
  const out: Enrich['social'] = { first: null, last: null };
  if (!Array.isArray(authorships) || authorships.length === 0) return out;

  const firstA = authorships.find(a => a.author_position === 'first') || authorships[0];
  const lastA = authorships.find(a => a.author_position === 'last') || authorships[authorships.length - 1];
  const firstOrcid = normalizeOrcid(firstA?.author?.orcid);
  const lastOrcid = normalizeOrcid(lastA?.author?.orcid);
  const sameAuthor = firstA === lastA || (!!firstOrcid && firstOrcid === lastOrcid);

  const [firstH, lastH] = await Promise.all([
    resolveAuthorHandle(firstA),
    sameAuthor ? Promise.resolve(null) : resolveAuthorHandle(lastA),
  ]);

  out.first = firstH;
  out.last = sameAuthor ? firstH : lastH;
  return out;
}

// DOI -> PDF resolver sources. No publisher URL patterns are hardcoded: each
// source reports the publisher's own PDF link, and we take the first that exists.

// Unpaywall: open-access status + a direct url_for_pdf when it has one.
async function unpaywallInfo(doi: string): Promise<{ isOa: boolean; pdf: string | null }> {
  try {
    const r = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=contact@uncited.com`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { isOa: false, pdf: null };
    const j = (await r.json()) as {
      is_oa?: boolean;
      best_oa_location?: { url_for_pdf?: string | null } | null;
      oa_locations?: ({ url_for_pdf?: string | null } | null)[];
    };
    const cands = [j.best_oa_location, ...(j.oa_locations || [])].filter(Boolean) as { url_for_pdf?: string | null }[];
    return { isOa: !!j.is_oa, pdf: cands.map(l => l.url_for_pdf).find(Boolean) || null };
  } catch {
    return { isOa: false, pdf: null };
  }
}

// Crossref link[]: publishers deposit their own PDF URL here with a content-type.
// Catches PDFs the OA aggregators miss (e.g. eLife's CDN PDF). Skip text-mining
// links that point at an entitlement-gated API (Elsevier/Wiley) — those need a
// token and won't open for a normal reader.
async function crossrefPdf(doi: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'uncited (mailto:contact@uncited.com)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { message?: { link?: { URL?: string; 'content-type'?: string }[] } };
    const link = (j.message?.link || []).find(
      l => /pdf/i.test(l['content-type'] || '') && l.URL && !/api\.(elsevier|wiley)\.com/i.test(l.URL),
    );
    return link?.URL || null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('doi')?.trim() || '';
  const doi = raw
    .replace(/^doi:/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/[?#].*$/, '')
    .trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) {
    return NextResponse.json({ error: 'invalid doi' }, { status: 400 });
  }

  // Author socials (ORCID lookups) are resolved only when explicitly requested
  // — i.e. when a card is actually expanded. The visible-card prefetch omits the
  // flag so it never pays the ORCID cost and the OA/topics data stays instant.
  const wantSocial = request.nextUrl.searchParams.get('social') === '1';

  try {
    const select = 'open_access,best_oa_location,primary_location,topics'
      + (wantSocial ? ',authorships' : '');
    const oaUrl = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`
      + `?mailto=contact@uncited.com&select=${select}`;
    // DOI -> PDF: query OpenAlex + Unpaywall + Crossref in parallel and combine.
    // Don't bail when OpenAlex 404s (common for recent papers) — Unpaywall/Crossref
    // often still have the PDF.
    const [w, up, crPdf] = await Promise.all([
      fetch(oaUrl, { headers: { 'User-Agent': 'Uncited (mailto:contact@uncited.com)' }, signal: AbortSignal.timeout(8000) })
        .then(r => (r.ok ? r.json() : null)).catch(() => null) as Promise<OAWork | null>,
      unpaywallInfo(doi),
      crossrefPdf(doi),
    ]);
    const oaLoc = w?.best_oa_location || null;
    const prim = w?.primary_location || null;
    const isOa = up.isOa || !!w?.open_access?.is_oa;
    // Only surface a PDF when the paper is open access, so the link actually opens
    // (not a paywall login). Source order: OA copy (Unpaywall) -> publisher PDF
    // declared in Crossref -> OpenAlex location. No hardcoded publisher URL forms.
    const pdfUrl = isOa ? (up.pdf || crPdf || oaLoc?.pdf_url || prim?.pdf_url || null) : null;
    const oa: Enrich['oa'] = {
      isOa,
      pdfUrl,
      landingUrl: oaLoc?.landing_page_url || w?.open_access?.oa_url || prim?.landing_page_url || null,
      license: oaLoc?.license || prim?.license || null,
      status: w?.open_access?.oa_status || null,
    };
    const topics: Enrich['topics'] = (Array.isArray(w?.topics) ? w!.topics! : [])
      .slice(0, 3)
      .map(t => ({ name: t?.display_name || '', field: t?.field?.display_name || t?.subfield?.display_name || null }))
      .filter(t => t.name);

    const social = wantSocial ? await resolveSocial(w?.authorships || []) : { ...EMPTY.social };

    return NextResponse.json({ oa, topics, social } as Enrich, {
      // Public per-paper facts that rarely change: let the CDN serve repeats.
      headers: { 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800' },
    });
  } catch {
    return NextResponse.json(EMPTY, { headers: { 'Cache-Control': 'public, max-age=600' } });
  }
}
