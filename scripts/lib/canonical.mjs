// ============================================================
// Canonical paper-ID resolver. Pure — no network calls.
// ============================================================
// Canonical ID format:
//   "doi:10.1038/..."        — DOI is the primary key when present
//   "arxiv:2406.04301"       — arxiv ID without version suffix
//   "title:<16-hex>"         — fallback; sha256(title|surname|year)[:16]
//
// Priority of resolution:
//   1. DOI — arxiv-DOIs (10.48550/arXiv.X) collapse back to arxiv:X so
//      an arxiv entry and a DOI-tagged entry for the same preprint
//      share a canonical ID.
//   2. arxiv ID (version-stripped).
//   3. title hash (author surname + year included to reduce collisions).
//   4. hard-fallback using (journalId, published, guid|link) — only for
//      items with no useful text; per-feed so cannot cross-collide.
//
// Note: arxiv preprints and their peer-reviewed published versions
// stay as separate canonical IDs under this resolver. That's an
// accepted limitation — merging them would require an external
// cross-reference source we've deliberately opted out of.
// ============================================================
import { createHash } from 'node:crypto';

// ---------- arXiv ID extraction ----------
// Handles the most common formats. Always strips trailing vN version suffix.
const ARXIV_PATTERNS = [
  /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i,
  /oai:arxiv\.org:(\d{4}\.\d{4,5})/i,
  /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i,
  /arxiv:?\s*(\d{4}\.\d{4,5})/i,
];

export function extractArxivId(article) {
  if (!article) return null;
  const sources = [
    article.arxivId,
    article.link,
    article.id,
    article.guid,
    article.doi,
  ].filter(Boolean).map(String);

  for (const s of sources) {
    for (const re of ARXIV_PATTERNS) {
      const m = s.match(re);
      if (m) return m[1].toLowerCase();
    }
  }
  return null;
}

// ---------- DOI normalization ----------
const DOI_REGEX = /^10\.\d{4,9}\/[^\s]+$/;

export function normalizeDoi(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  s = s.replace(/^doi:\s*/, '');
  // strip common trailing punctuation
  s = s.replace(/[.,;\s]+$/, '');
  if (!DOI_REGEX.test(s)) return null;
  return s;
}

// ---------- Title normalization ----------
export function normalizeTitle(title) {
  if (!title) return '';
  // \p{L} (letters) + \p{N} (numbers) + \s; keeps CJK, Cyrillic, Greek,
  // etc. NFKD first so diacritics decompose and combining marks disappear.
  return String(title)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')          // strip combining marks
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation/symbols
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Author surname heuristic ----------
// Input can be:
//   "Smith, John A."          → "smith"
//   "John A. Smith"           → "smith"
//   { name: "Smith, J." }     → "smith"
//   ["Smith, J.", "Doe, A."]  → "smith" (first author)
function firstAuthorSurname(authors) {
  if (!authors) return '';
  const first = Array.isArray(authors) ? authors[0] : authors;
  if (!first) return '';
  const raw = typeof first === 'string' ? first : (first.name || first.fullName || first.displayName || '');
  if (!raw) return '';
  const s = String(raw).trim();
  // "Last, First" form
  if (s.includes(',')) {
    const last = s.split(',', 1)[0].trim();
    return normalizeTitle(last).split(' ')[0] || '';
  }
  // "First Last" form — take last token
  const tokens = normalizeTitle(s).split(' ').filter(Boolean);
  return tokens[tokens.length - 1] || '';
}

// ---------- Publication-year extraction ----------
function publicationYear(published) {
  if (!published) return '';
  try {
    const d = new Date(published);
    const y = d.getUTCFullYear();
    if (isNaN(y) || y < 1800 || y > 2200) return '';
    return String(y);
  } catch {
    return '';
  }
}

// ---------- Title hash ----------
// sha256(title_normalized | surname | year)[:16]
// Returning 16 hex chars (64 bits). At ~10^6 papers, birthday collisions
// are ~10^-8. Still cross-check uniqueness after backfill.
export function titleHash(title, authors, published) {
  const t = normalizeTitle(title);
  const s = firstAuthorSurname(authors);
  const y = publicationYear(published);
  const input = `${t}|${s}|${y}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ---------- Hard fallback for near-empty items ----------
// Per-feed key, so can't collide across feeds.
export function hardFallbackHash(article) {
  const journal = article.journalId || article.journal || '';
  const pub = article.published || article.pubDate || '';
  const guid = article.feed_guid || article.guid || article.link || article.id || '';
  return createHash('sha256')
    .update(`${journal}|${pub}|${guid}`)
    .digest('hex').slice(0, 16);
}

// ---------- Main entry point ----------
// Returns { canonical_id, id_kind, external_ids }
export function resolveCanonicalId(article) {
  if (!article) throw new Error('resolveCanonicalId: article required');

  const external_ids = {};

  // 1. DOI wins — UNLESS the DOI is an arxiv DOI, in which case the
  //    canonical identity is the arxiv form so an arxiv entry and a
  //    DOI-tagged entry for the same preprint collapse to one paper.
  const directDoi = normalizeDoi(article.doi);
  if (directDoi) {
    const arxivFromDoi = extractArxivId({ doi: directDoi });
    if (arxivFromDoi) {
      external_ids.doi = directDoi;
      external_ids.arxiv_id = arxivFromDoi;
      return {
        canonical_id: `arxiv:${arxivFromDoi}`,
        id_kind: 'arxiv',
        external_ids,
      };
    }
    external_ids.doi = directDoi;
    const arxiv = extractArxivId(article);
    if (arxiv) external_ids.arxiv_id = arxiv;
    return {
      canonical_id: `doi:${directDoi}`,
      id_kind: 'doi',
      external_ids,
    };
  }

  // 2. arXiv ID.
  const arxiv = extractArxivId(article);
  if (arxiv) {
    external_ids.arxiv_id = arxiv;
    return {
      canonical_id: `arxiv:${arxiv}`,
      id_kind: 'arxiv',
      external_ids,
    };
  }

  // 3. Title hash
  const titleNorm = normalizeTitle(article.title || '');
  if (titleNorm.length >= 20) {
    const h = titleHash(article.title, article.authors, article.published || article.pubDate);
    return {
      canonical_id: `title:${h}`,
      id_kind: 'title',
      external_ids,
    };
  }

  // 4. Hard fallback for near-empty items
  const h = hardFallbackHash(article);
  return {
    canonical_id: `title:${h}`,
    id_kind: 'title',
    external_ids,
  };
}

// ============================================================
// Test vectors (for manual verification):
//   resolveCanonicalId({ doi: '10.1038/s41586-021-03819-2' })
//     → { canonical_id: 'doi:10.1038/s41586-021-03819-2', id_kind: 'doi', ... }
//
//   resolveCanonicalId({ link: 'https://arxiv.org/abs/2406.04301v3' })
//     → { canonical_id: 'arxiv:2406.04301', id_kind: 'arxiv', ... }
//
//   resolveCanonicalId({ doi: '10.48550/arXiv.2510.07143' })
//     → { canonical_id: 'arxiv:2510.07143', id_kind: 'arxiv', ... }
//
//   resolveCanonicalId({ title: 'A long unique research article', authors: [{name:'Smith, J.'}], published: '2024-05-10' })
//     → { canonical_id: 'title:<hash>', id_kind: 'title', ... }
// ============================================================
