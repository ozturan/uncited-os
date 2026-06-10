/**
 * Shared helpers for shaping papers + sightings rows into the Entry schema
 * the rest of the app expects. Used by /api/articles, /api/feed, and friends.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

// papers.primary_source is currently populated with the slug (e.g.
// "nature-cell-biology") rather than the display name. The catalog has
// the human-readable mapping; load it once at module init and look up
// at shape time. Falls through to the slug if the catalog is missing
// or the slug is unknown.
let catalogJournalNames: Map<string, string> | null = null;
function getCatalogNameMap(): Map<string, string> {
  if (catalogJournalNames) return catalogJournalNames;
  catalogJournalNames = new Map();
  try {
    const catalogPath = join(process.cwd(), 'public', 'data', 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    for (const discipline of catalog.disciplines || []) {
      for (const j of discipline.journals || []) {
        if (j.id && j.name) {
          // Strip stray quote characters that some entries carry.
          catalogJournalNames.set(j.id, String(j.name).replace(/^["']+|["']+$/g, '').trim());
        }
      }
    }
  } catch {
    // Mock client / build environment / catalog missing — leave the map empty.
  }
  return catalogJournalNames;
}

function displayJournalName(slug: string | null | undefined, fallback: string | null | undefined): string {
  if (!slug && !fallback) return '';
  const map = getCatalogNameMap();
  if (slug && map.has(slug)) return map.get(slug)!;
  // If `fallback` is a human-looking name (has spaces or any uppercase),
  // prefer it over the slug. Otherwise fall back to the slug itself.
  if (fallback && (/\s/.test(fallback) || /[A-Z]/.test(fallback))) return fallback;
  return fallback || slug || '';
}

// papers/sightings are public metadata — service role skips RLS and
// doesn't leak anything user-scoped.
export function serviceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type PaperRow = {
  canonical_id: string;
  title: string | null;
  abstract: string | null;
  authors: unknown;
  authors_text: string | null;
  published_at: string | null;
  primary_source: string | null;
  primary_link: string | null;
  external_ids: Record<string, unknown> | null;
  categories: string[] | null;
  type: string | null;
};

export type SightingRow = {
  source_feed: string;
  legacy_entry_id: string | null;
  feed_link: string | null;
  paper_id: string;
  papers: PaperRow | PaperRow[] | null;
};

// Centralized list of fields we pull from papers. Keep in sync across endpoints.
export const PAPERS_COLUMNS =
  'canonical_id,title,abstract,authors,authors_text,published_at,primary_source,primary_link,external_ids,categories,type';

export const SIGHTINGS_JOIN_SELECT =
  `source_feed,legacy_entry_id,feed_link,paper_id,papers!inner(${PAPERS_COLUMNS})`;

function authorsField(paper: PaperRow): string | undefined {
  if (paper.authors_text) return paper.authors_text;
  const a = paper.authors;
  if (Array.isArray(a)) {
    return a
      .map(x => typeof x === 'string' ? x : (x as { name?: string })?.name || '')
      .filter(Boolean)
      .join(', ') || undefined;
  }
  return undefined;
}

export type EntryShape = {
  id: string;
  canonicalId: string;
  title: string;
  authors?: string;
  abstract?: string;
  journal: string;
  journalId: string;
  published: string | null;
  doi?: string;
  arxivId?: string;
  link: string;
  categories?: string[];
  type?: string;
  /** Pre-resolved author/lab/institution entity, attached server-side when warm so the
   *  card paints the full line on first render. See lib/affiliationServerCache. */
  affiliation?: import('./affiliation').AffiliationData;
};

export function shapeEntry(row: SightingRow): EntryShape | null {
  const paper = Array.isArray(row.papers) ? row.papers[0] : row.papers;
  if (!paper || !paper.title) return null;
  const ext = (paper.external_ids || {}) as Record<string, unknown>;
  return {
    id: row.legacy_entry_id || paper.canonical_id,
    canonicalId: paper.canonical_id,
    title: paper.title,
    authors: authorsField(paper),
    abstract: paper.abstract || undefined,
    journal: displayJournalName(row.source_feed, paper.primary_source),
    journalId: row.source_feed,
    published: paper.published_at,
    doi: typeof ext.doi === 'string' ? ext.doi : undefined,
    // canonical.mjs stores arxiv ID under `arxiv_id`, not `arxiv`.
    arxivId: typeof ext.arxiv_id === 'string' ? ext.arxiv_id : undefined,
    link: row.feed_link || paper.primary_link || '',
    categories: paper.categories || undefined,
    type: paper.type || undefined,
  };
}

export function sortByPublishedDesc(a: { published?: string | null }, b: { published?: string | null }): number {
  return String(b.published || '').localeCompare(String(a.published || ''));
}

/**
 * Paginate past PostgREST's db.max_rows (1000) cap. Supabase silently
 * truncates any single response, so to reliably return up to `targetLimit`
 * rows we issue .range() queries per page.
 *
 * Strategy: fire the first page to probe; if it returns a full page we
 * fire the remaining pages in parallel (wall time ~= 2 round-trips) rather
 * than serially (~N round-trips).
 *
 * Caller supplies a queryBuilder callback that returns a fresh query
 * builder each call (can't reuse a capped cursor).
 */
export async function paginateAll<T>(
  queryBuilder: () => any,
  targetLimit: number,
  pageSize = 1000,
): Promise<{ rows: T[]; error: string | null }> {
  // First page — also tells us whether we need more.
  const firstTo = Math.min(pageSize - 1, targetLimit - 1);
  const { data: firstData, error: firstErr } = await queryBuilder().range(0, firstTo);
  if (firstErr) return { rows: [], error: firstErr.message };
  if (!firstData || firstData.length === 0) return { rows: [], error: null };
  if (firstData.length < pageSize || targetLimit <= pageSize) {
    return { rows: firstData as T[], error: null };
  }

  // First page was full and we want more. Fire the rest in parallel.
  const remainingPages: Array<[number, number]> = [];
  for (let from = pageSize; from < targetLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, targetLimit - 1);
    remainingPages.push([from, to]);
  }
  const results = await Promise.all(
    remainingPages.map(([from, to]) => queryBuilder().range(from, to)),
  );
  const rows: T[] = [...(firstData as T[])];
  for (const res of results) {
    if (res.error) return { rows, error: res.error.message };
    if (!res.data || res.data.length === 0) break;
    rows.push(...(res.data as T[]));
    if (res.data.length < pageSize) break;
  }
  return { rows, error: null };
}

/**
 * Given a list of canonical IDs, fetch one representative sighting+paper
 * row per id and return them as a Map<canonical_id, EntryShape>. Used by
 * endpoints that rank by canonical_id (match_papers, /api/scholar, etc.)
 * to hydrate article metadata without reading JSON files.
 *
 * Caller passes an optional preferredFeeds array — when a paper has
 * sightings in multiple feeds, the first match from preferredFeeds wins
 * (typically the user's follows), so the article's displayed journal
 * matches what the user expects.
 */
export async function hydrateCanonicalIds(
  canonicalIds: string[],
  preferredFeeds?: string[],
): Promise<Map<string, EntryShape>> {
  const out = new Map<string, EntryShape>();
  if (canonicalIds.length === 0) return out;

  const supabase = serviceSupabase();
  const preferred = new Set(preferredFeeds ?? []);

  // Chunk to stay under PostgREST URL limit (~2K chars).
  const CHUNK = 500;
  const batches: string[][] = [];
  for (let i = 0; i < canonicalIds.length; i += CHUNK) batches.push(canonicalIds.slice(i, i + CHUNK));

  // Fetch all chunks in PARALLEL (was serial — saved a round-trip per extra 500 papers).
  // Results are processed in chunk order, so the preferred-feed upgrade stays deterministic.
  const results = await Promise.all(batches.map(batch =>
    supabase
      .from('sightings')
      .select(SIGHTINGS_JOIN_SELECT)
      .in('paper_id', batch)
      .limit(batch.length * 3) // each paper may have N sightings; upper bound.
  ));
  for (const { data, error } of results) {
    if (error) {
      console.error('[hydrateCanonicalIds] error:', error.message);
      continue;
    }
    if (!data) continue;
    for (const row of data as unknown as SightingRow[]) {
      const entry = shapeEntry(row);
      if (!entry) continue;
      const existing = out.get(entry.canonicalId);
      if (!existing) {
        out.set(entry.canonicalId, entry);
      } else if (preferred.has(entry.journalId) && !preferred.has(existing.journalId)) {
        // Upgrade: a preferred-feed sighting beats a non-preferred one.
        out.set(entry.canonicalId, entry);
      }
    }
  }
  return out;
}
