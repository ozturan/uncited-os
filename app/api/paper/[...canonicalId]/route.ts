/**
 * Paper-detail API (Phase 7 seed).
 *
 * GET /api/paper/<canonical_id>
 *
 * Returns the paper metadata + its sightings + a list of related papers
 * (vector-similarity via match_papers_discover), all from Supabase — no
 * journal JSON files involved. Sets up a code path that works without the
 * static JSON backbone, so we can migrate routes to it incrementally in
 * Phase 7 without coordinating a big-bang cutover.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// Server-side client with service role — papers/sightings have RLS requiring
// auth, and this endpoint is intentionally public (paper metadata isn't
// user-scoped). No user-scoped data is exposed here.
function serviceSupabase() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

const MAX_RELATED = 12;
const RELATED_WINDOW_DAYS = 180;

type PaperRow = {
  canonical_id: string;
  id_kind: string;
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

type SightingRow = {
  source_feed: string;
  legacy_entry_id: string | null;
  feed_link: string | null;
  feed_categories: string[] | null;
  seen_at: string | null;
};

type RelatedRow = {
  canonical_id: string;
  source_feed: string;
  published_at: string;
  similarity: number;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ canonicalId: string[] }> },
) {
  const { canonicalId: rawSegments } = await params;
  // Catch-all route: canonical_id may contain '/' (e.g. doi:10.1038/...)
  // so it arrives as an array of URL segments we need to rejoin.
  const canonicalId = (rawSegments || []).map(s => decodeURIComponent(s)).join('/');
  if (!canonicalId) {
    return NextResponse.json({ error: 'canonical_id required' }, { status: 400 });
  }

  const supabase = serviceSupabase();

  const [paperRes, sightingsRes, embeddingRes] = await Promise.all([
    supabase
      .from('papers')
      .select('canonical_id,id_kind,title,abstract,authors,authors_text,published_at,primary_source,primary_link,external_ids,categories,type')
      .eq('canonical_id', canonicalId)
      .maybeSingle(),
    supabase
      .from('sightings')
      .select('source_feed,legacy_entry_id,feed_link,feed_categories,seen_at')
      .eq('paper_id', canonicalId)
      .order('seen_at', { ascending: true }),
    supabase
      .from('article_embeddings')
      .select('embedding_half')
      .eq('canonical_id', canonicalId)
      .not('embedding_half', 'is', null)
      .limit(1),
  ]);

  if (paperRes.error) {
    return NextResponse.json({ error: paperRes.error.message }, { status: 500 });
  }
  if (!paperRes.data) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const paper = paperRes.data as PaperRow;
  const sightings = (sightingsRes.data ?? []) as SightingRow[];
  const embedding = embeddingRes.data?.[0]?.embedding_half;

  let related: RelatedRow[] = [];
  if (embedding) {
    // Pull similar papers from unfollowed-aware RPC with an empty exclude,
    // then drop the paper itself in-memory.
    const minPublished = new Date(Date.now() - RELATED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase.rpc('match_papers_discover', {
      query_embedding: embedding,
      match_count: MAX_RELATED + 5,
      min_published_date: minPublished,
      p_excluded_feeds: null,
    });
    if (Array.isArray(data)) {
      related = (data as RelatedRow[])
        .filter(r => r.canonical_id !== canonicalId)
        .slice(0, MAX_RELATED);
    }
  }

  return NextResponse.json({
    paper: {
      canonical_id: paper.canonical_id,
      id_kind: paper.id_kind,
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors,
      authors_text: paper.authors_text,
      published_at: paper.published_at,
      primary_source: paper.primary_source,
      primary_link: paper.primary_link,
      external_ids: paper.external_ids,
      categories: paper.categories,
      type: paper.type,
    },
    sightings: sightings.map(s => ({
      source_feed: s.source_feed,
      legacy_entry_id: s.legacy_entry_id,
      feed_link: s.feed_link,
      feed_categories: s.feed_categories,
      seen_at: s.seen_at,
    })),
    related,
  });
}
