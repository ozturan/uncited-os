/**
 * Deterministic, per-publisher direct-PDF URLs, derived from the article landing
 * URL / identifiers with NO network call. Modeled on Zotero's translators: each
 * publisher exposes its PDF at a predictable path, so we transform the link.
 *
 * This covers the open-access publishers that actually appear in the feed
 * (arXiv, Nature, Springer, bioRxiv/medRxiv, Frontiers, PLOS). For publishers
 * with no public deterministic PDF (ScienceDirect's tokenized URLs) or non-paper
 * pages (news sites) it returns null, and the OA resolver (Unpaywall, in the
 * enrich path) is the other half of the coverage. Verified reachable against
 * real feed links for arXiv/Nature/Frontiers/PLOS; Springer + bioRxiv resolve in
 * a real browser but bot-block server-side checks.
 */
import type { Entry } from './types';

function cleanDoi(raw?: string | null): string {
    return (raw || '')
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
        .replace(/^doi:/i, '')
        .replace(/[?#].*$/, '')
        .replace(/v\d+$/i, '') // bioRxiv RSS bakes a version (v1) into the DOI
        .trim();
}

export function directPdfUrl(
    entry: Pick<Entry, 'link' | 'doi' | 'arxivId' | 'canonicalId'>,
): string | null {
    // arXiv: deterministic /pdf/<id>, free, always works.
    const arxiv = entry.arxivId
        || (entry.canonicalId?.startsWith('arxiv:') ? entry.canonicalId.slice(6) : '');
    if (arxiv) return `https://arxiv.org/pdf/${arxiv}`;

    const link = (entry.link || '').trim();
    if (!link) return null;
    let host: string;
    try { host = new URL(link).hostname.replace(/^www\./, ''); } catch { return null; }
    const base = link.replace(/[?#].*$/, ''); // drop query (e.g. ?rss=1) and hash
    const doi = cleanDoi(entry.doi);

    // Lag-free fast paths for sources with a stable, VERIFIED PDF URL derivable
    // from the landing/ID alone (no metadata lookup, so brand-new papers get a
    // button immediately). EVERYTHING ELSE — Nature, eLife, Wiley, Springer, etc.
    // — goes through the DOI->PDF resolver in /api/paper-enrich (Crossref +
    // Unpaywall + OpenAlex), which reads the publisher's own PDF link instead of
    // hardcoding per-publisher URL shapes. Nature was removed from here precisely
    // because its URL shape is inconsistent; the resolver handles it by DOI.

    // Nature: <id>_reference.pdf is the real full-article PDF for Nature
    // Communications / Scientific Reports (the bulk of Nature volume here),
    // verified multi-MB application/pdf and user-confirmed. Lag-free for brand-new
    // articles the registries haven't indexed yet; the DOI->PDF resolver backs up
    // the rest of the Nature portfolio once indexed.
    if (host.endsWith('nature.com') && /\/articles\/[^/]+$/.test(base)) {
        return base.replace(/(_reference)?\.pdf$/i, '') + '_reference.pdf';
    }
    // bioRxiv / medRxiv: the abstract page + .full.pdf IS the PDF (medRxiv verified
    // 200 application/pdf; bioRxiv bot-blocks server probes but the same URL form
    // downloads in a browser). Built from the real landing URL so the stored DOI
    // prefix quirk doesn't matter.
    if (host.endsWith('biorxiv.org') || host.endsWith('medrxiv.org')) {
        return base.replace(/\.full(\.pdf)?$/i, '') + '.full.pdf';
    }
    // Frontiers: /articles/<doi>[/full] -> /articles/<doi>/pdf  (verified PDF)
    if (host.endsWith('frontiersin.org') && /\/articles\//.test(base)) {
        return base.replace(/\/full$/i, '') + '/pdf';
    }
    // PLOS: article?id=<doi> -> <journal>/article/file?id=<doi>&type=printable  (verified PDF)
    if (host.endsWith('journals.plos.org') && doi) {
        const journal = (base.match(/journals\.plos\.org\/([^/]+)\//) || [])[1] || 'plosone';
        return `https://journals.plos.org/${journal}/article/file?id=${doi}&type=printable`;
    }
    return null;
}
