/**
 * On-follow instant fetch.
 *
 * POST /api/fetch-journal  { journalId: string }
 *   Fetches just that one journal's RSS feed(s) and upserts the latest papers,
 *   so a newly-followed journal shows recent papers right away instead of
 *   waiting for the next scheduled run. Reuses the same canonical-id / dedup
 *   ingest as the full pipeline, so nothing double-writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';
// Shared ESM ingest helper used by scripts/fetch.js (plain JS, no types).
import { syncPapersAndSightings } from '../../../scripts/lib/paper-sync.mjs';

export const runtime = 'nodejs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) uncited-os/1.0';

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || url === 'mock' || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

let catalogCache: { disciplines: { journals: { id: string; rss: string | string[] }[] }[] } | null =
  null;
function findJournal(journalId: string) {
  if (!catalogCache) {
    const p = process.env.CATALOG_PATH || join(process.cwd(), 'public/data/catalog.json');
    catalogCache = JSON.parse(readFileSync(p, 'utf-8'));
  }
  for (const d of catalogCache!.disciplines) {
    const j = d.journals.find((x) => x.id === journalId);
    if (j) return j;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { journalId } = (await req.json()) as { journalId?: string };
    if (!journalId || typeof journalId !== 'string') {
      return NextResponse.json({ error: 'journalId is required' }, { status: 400 });
    }

    const journal = findJournal(journalId);
    if (!journal) return NextResponse.json({ error: 'journal not found in catalog' }, { status: 404 });

    const supabase = serviceClient();
    if (!supabase) return NextResponse.json({ error: 'database not configured' }, { status: 500 });

    const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': UA } });
    const rssFeeds = Array.isArray(journal.rss) ? journal.rss : [journal.rss];

    const articles: Record<string, unknown>[] = [];
    for (const rss of rssFeeds) {
      if (!rss) continue;
      try {
        const feed = await parser.parseURL(rss);
        for (const item of feed.items || []) {
          articles.push({
            title: item.title || '',
            abstract:
              (item as { contentSnippet?: string }).contentSnippet ||
              (item as { content?: string }).content ||
              (item as { summary?: string }).summary ||
              '',
            authors:
              (item as { creator?: string }).creator ||
              (item as { author?: string }).author ||
              '',
            published: item.isoDate || item.pubDate || null,
            journalId: journal.id,
            link: item.link || null,
            categories: item.categories || [],
            id: item.guid || item.link || null,
            guid: item.guid || null,
            type: 'Research',
          });
        }
      } catch {
        // one bad feed URL shouldn't fail the whole follow
      }
    }

    if (articles.length === 0) {
      return NextResponse.json({ ok: true, journalId, fetched: 0, papersUpserted: 0 });
    }

    const result = await syncPapersAndSightings(articles, supabase);
    return NextResponse.json({ ok: true, journalId, fetched: articles.length, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 500 },
    );
  }
}
