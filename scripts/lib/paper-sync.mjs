// ============================================================
// Phase 1 dual-write: push new articles into papers/sightings/id_map
// alongside the existing JSON write. Designed to fail soft: any
// error here is logged and swallowed so ingest never breaks.
// ============================================================
import { resolveCanonicalId, normalizeTitle } from './canonical.mjs';

const BATCH = 25;

function safeTimestamp(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function resolvedVia(resolution) {
  const { id_kind } = resolution;
  if (id_kind === 'doi')   return 'doi';
  if (id_kind === 'arxiv') return 'arxiv';
  // title fallback — we can't tell from resolution alone whether it was
  // the long-title hash or the hard-fallback hash, but both collapse to
  // 'title:<hash>'. Use the generic tag.
  return 'title-hash';
}

function toAuthorsJson(authors) {
  if (!authors) return [];
  if (Array.isArray(authors)) {
    return authors.map(a => {
      if (typeof a === 'string') return { name: a };
      if (a && typeof a === 'object') return a;
      return null;
    }).filter(Boolean);
  }
  if (typeof authors === 'string') {
    // "Smith J, Doe A" → [{name: 'Smith J'}, {name: 'Doe A'}]
    return authors
      .split(/\s*[,;]\s*/)
      .filter(Boolean)
      .map(name => ({ name }));
  }
  return [];
}

function authorsText(authors) {
  if (typeof authors === 'string') return authors.trim() || null;
  if (Array.isArray(authors)) {
    const joined = authors
      .map(a => (typeof a === 'string' ? a : a?.name || ''))
      .filter(Boolean)
      .join(', ');
    return joined || null;
  }
  return null;
}

function cleanStringList(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(c => typeof c === 'string' && c.trim())
    .map(s => s.trim());
}

export async function syncPapersAndSightings(articles, supabase, _opts = {}) {
  if (!supabase) return { papersUpserted: 0, sightingsUpserted: 0, idMapUpserted: 0, errors: 0, skipped: 'no_supabase' };
  if (!articles || articles.length === 0) return { papersUpserted: 0, sightingsUpserted: 0, idMapUpserted: 0, errors: 0 };

  // Resolver is pure/synchronous — no network, no concurrency needed.
  const resolved = new Array(articles.length);
  let resolveErrors = 0;
  for (let i = 0; i < articles.length; i++) {
    try {
      resolved[i] = {
        article: articles[i],
        resolution: resolveCanonicalId(articles[i]),
      };
    } catch {
      resolveErrors++;
    }
  }

  // Deduplicate papers by canonical_id within this batch. First
  // occurrence wins; downstream PostgreSQL upsert skips if the row
  // already exists in the table.
  const papersById = new Map();
  const sightings = [];
  const idMapEntries = [];

  const sightingsByKey = new Map(); // dedupe (paper_id, source_feed) within batch

  for (const entry of resolved) {
    if (!entry) continue; // resolver errors leave holes
    const { article, resolution } = entry;
    const { canonical_id, id_kind, external_ids } = resolution;

    const abstract = (article.abstract || article.summary || '').slice(0, 20000) || null;

    if (!papersById.has(canonical_id)) {
      papersById.set(canonical_id, {
        canonical_id,
        id_kind,
        title: (article.title || '').slice(0, 2000),
        title_normalized: normalizeTitle(article.title || '').slice(0, 2000),
        abstract,
        authors: toAuthorsJson(article.authors),
        authors_text: authorsText(article.authors),
        published_at: safeTimestamp(article.published || article.pubDate),
        primary_source: article.journalId || article.journal || null,
        primary_link: article.link || null,
        external_ids,
        categories: cleanStringList(article.categories),
        type: article.type || null,
      });
    }

    const sightingKey = `${canonical_id}|${String(article.journalId || article.journal || 'unknown')}`;
    if (!sightingsByKey.has(sightingKey)) {
      sightingsByKey.set(sightingKey, {
        paper_id: canonical_id,
        source_feed: String(article.journalId || article.journal || 'unknown'),
        legacy_entry_id: article.id ? String(article.id) : null,
        feed_guid: article.guid ? String(article.guid) : null,
        feed_link: article.link ? String(article.link) : null,
        feed_categories: cleanStringList(article.categories),
      });
    }

    if (article.id && article.id !== canonical_id) {
      idMapEntries.push({
        legacy_entry_id: String(article.id),
        canonical_id,
        resolved_via: resolvedVia(resolution),
      });
    }
  }

  for (const s of sightingsByKey.values()) sightings.push(s);

  let papersUpserted = 0, sightingsUpserted = 0, idMapUpserted = 0, errors = 0;

  // Papers: insert-or-skip. We intentionally don't overwrite existing
  // merged state from earlier runs or backfill.
  const papersArr = Array.from(papersById.values());
  for (let i = 0; i < papersArr.length; i += BATCH) {
    const batch = papersArr.slice(i, i + BATCH);
    const { error } = await supabase
      .from('papers')
      .upsert(batch, { onConflict: 'canonical_id', ignoreDuplicates: true });
    if (error) {
      errors++;
      console.error('   papers upsert error:', error.message);
    } else {
      papersUpserted += batch.length;
    }
  }

  // Sightings: upsert; if the pair (paper_id, source_feed) already
  // exists, refresh `seen_at` and link metadata.
  for (let i = 0; i < sightings.length; i += BATCH) {
    const batch = sightings.slice(i, i + BATCH).map(s => ({
      ...s,
      seen_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from('sightings')
      .upsert(batch, { onConflict: 'paper_id,source_feed' });
    if (error) {
      errors++;
      console.error('   sightings upsert error:', error.message);
    } else {
      sightingsUpserted += batch.length;
    }
  }

  // id_map: insert-or-skip. Never overwrite an existing canonical mapping.
  const dedupedIdMap = new Map();
  for (const e of idMapEntries) {
    if (!dedupedIdMap.has(e.legacy_entry_id)) dedupedIdMap.set(e.legacy_entry_id, e);
  }
  const idMapArr = Array.from(dedupedIdMap.values());
  for (let i = 0; i < idMapArr.length; i += BATCH) {
    const batch = idMapArr.slice(i, i + BATCH);
    const { error } = await supabase
      .from('id_map')
      .upsert(batch, { onConflict: 'legacy_entry_id', ignoreDuplicates: true });
    if (error) {
      errors++;
      console.error('   id_map upsert error:', error.message);
    } else {
      idMapUpserted += batch.length;
    }
  }

  return {
    papersUpserted,
    sightingsUpserted,
    idMapUpserted,
    errors: errors + resolveErrors,
    totalArticles: articles.length,
    resolveErrors,
  };
}
