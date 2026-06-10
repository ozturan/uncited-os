/**
 * Server-side prefetch for the authed dashboard.
 *
 * Replaces the client-side cold-load chain (auth.getUser → loadState →
 * /api/articles) with a single Promise.all on the server. The HTML hits the
 * browser with content already in it; client hydrates without refetching.
 *
 * Returns:
 *   - user: the authed user (or null)
 *   - state: a UserState shape matching what lib/storage.ts:loadState() builds
 *   - entries: first N papers from followed journals, EntryShape[]
 *
 * Anonymous visitors get { user: null, state: null, entries: [] } and the
 * caller falls back to the marketing landing path. Each underlying call is
 * defensive — Supabase outage on any branch leaves the others untouched and
 * the client-side fallbacks in useAuth/useUserState/useEntries pick up.
 */

import type { Entry, UserState } from '@/lib/types';
import type { EntryShape } from '@/lib/paperFeed';
import {
  serviceSupabase,
  shapeEntry,
  sortByPublishedDesc,
  type SightingRow,
} from '@/lib/paperFeed';
import { createClient } from '@/lib/supabase/server';
import { cleanupState } from '@/lib/userStateCleanup';
import { SINGLE_USER_MODE, LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/localUser';

type ActivityRow = { entry_id: string | null; canonical_id: string | null; created_at: string };

const PREFETCH_FOLLOWS_SINCE_DAYS = 90;
// Must match the client's full-load limit. We tried dropping this to 500
// for faster SSR, but useEntries' refetch-after-hydration logic skips the
// background refresh when follows match prevFollowsRef — so the unread
// count was capped at 500. Better correctness than 500ms of SSR speedup.
const PREFETCH_FOLLOWS_LIMIT = 5000;

export type PrefetchedUser = {
  id: string;
  email?: string | null;
  // intentionally minimal — only what the client immediately needs.
  // Full user object still arrives via supabase.auth.onAuthStateChange.
};

export type PrefetchResult = {
  user: PrefetchedUser | null;
  state: UserState | null;
  entries: Entry[];
};

const EMPTY: PrefetchResult = { user: null, state: null, entries: [] };

// Lightweight prefetch used to gate the home document's FIRST BYTE: resolve only
// whether the visitor is signed in (one getUser), nothing else. The previous
// prefetchDashboard() blocked first paint on user_state + get_user_activity (two
// full-table jsonb_agg scans — 5-15s for heavy accounts) + the feed RPC, so the
// loading screen itself was delayed for several seconds. Here we return state=null /
// entries=[]; the client backfills via useUserState.loadState() and useEntries
// (initialState=null triggers those paths), and the theme is already applied
// pre-hydration from localStorage (app/layout.tsx), so there is no flash.
export async function prefetchUser(): Promise<PrefetchResult> {
  // Single-user local mode: render the dashboard directly, no landing page.
  if (SINGLE_USER_MODE) {
    return { user: { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL }, state: null, entries: [] };
  }
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return EMPTY;
  }
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return EMPTY;
    return { user: { id: data.user.id, email: data.user.email }, state: null, entries: [] };
  } catch {
    return EMPTY;
  }
}

export async function prefetchDashboard(): Promise<PrefetchResult> {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return EMPTY;
  }

  let user: PrefetchedUser | null = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return EMPTY;
    user = { id: data.user.id, email: data.user.email };
  } catch {
    return EMPTY;
  }

  // Fan out user_state + activity in parallel. Mirrors lib/storage.ts:loadState().
  const [userRowRes, activityRes] = await Promise.all([
    supabase
      .from('user_state')
      .select('follows, last_visit, settings, updated_at, canonical_migrated_at')
      .eq('user_id', user.id)
      .single(),
    supabase.rpc('get_user_activity', { p_user_id: user.id }),
  ]);

  // Tolerate a missing user_state row — new accounts hit PGRST116 here.
  const userRow = userRowRes.data || null;
  const activity = (activityRes.data as { reads?: ActivityRow[]; stars?: ActivityRow[] } | null) || {};

  const follows: string[] = parseStringArray(userRow?.follows);
  const settings = userRow?.settings || undefined;
  const lastVisit: string | undefined = userRow?.last_visit || undefined;
  const canonicalMigratedAt: string | undefined = userRow?.canonical_migrated_at || undefined;

  const read: string[] = [];
  const readCanonical: string[] = [];
  const readTimestamps: { [k: string]: string } = {};
  const readTimestampsCanonical: { [k: string]: string } = {};
  for (const r of activity.reads || []) {
    if (!r.entry_id) continue;
    read.push(r.entry_id);
    readTimestamps[r.entry_id] = r.created_at;
    if (r.canonical_id) {
      readCanonical.push(r.canonical_id);
      readTimestampsCanonical[r.canonical_id] = r.created_at;
    }
  }
  const starred: string[] = [];
  const starredCanonical: string[] = [];
  const starredTimestamps: { [k: string]: string } = {};
  const starredTimestampsCanonical: { [k: string]: string } = {};
  for (const s of activity.stars || []) {
    if (!s.entry_id) continue;
    starred.push(s.entry_id);
    starredTimestamps[s.entry_id] = s.created_at;
    if (s.canonical_id) {
      starredCanonical.push(s.canonical_id);
      starredTimestampsCanonical[s.canonical_id] = s.created_at;
    }
  }

  // Same overlap reconciliation as lib/storage.ts:loadState applies. Without
  // this, articles that are in BOTH starred and read get double-counted by
  // the legacy/canonical filter logic, so the unread/read counts the user
  // sees on first paint differ from the post-hydration client-side numbers.
  const state: UserState = cleanupState({
    follows,
    read,
    starred,
    readTimestamps,
    starredTimestamps,
    readCanonical,
    starredCanonical,
    readTimestampsCanonical,
    starredTimestampsCanonical,
    canonicalMigratedAt,
    lastVisit,
    settings,
  });

  // Prefetch first page of followed-journal entries via the same RPC that
  // /api/articles uses. Skip if the user has no follows yet — empty array
  // matches the client's behavior in that case.
  //
  // Tight 500ms deadline on the blocking server prefetch: this whole function
  // gates the first byte of HTML, so every ms here is a blank tab. Heavy users
  // hit 8-13s on this RPC and ALWAYS blew the old 1.5s cap — pure wasted block
  // with empty results anyway. Only feeds that come back fast (<500ms) get
  // prefetched into the first paint; everyone else ships the shell immediately
  // and the client's useEntries SWR path loads + spins (one extra round-trip).
  let entries: Entry[] = [];
  if (follows.length > 0) {
    try {
      entries = await Promise.race([
        loadFeedEntries(follows).then(rows => rows.map(shapeToEntry)),
        new Promise<Entry[]>(resolve => setTimeout(() => resolve([]), 500)),
      ]);
    } catch (err) {
      console.warn('[serverPrefetch] feed load failed:', err);
      entries = [];
    }
  }

  return { user, state, entries };
}

// EntryShape allows nullable `published`; Entry doesn't. Coerce here so the
// prop type matches what page-client.tsx → useEntries expects.
function shapeToEntry(s: EntryShape): Entry {
  return {
    id: s.id,
    canonicalId: s.canonicalId,
    title: s.title,
    authors: s.authors,
    abstract: s.abstract,
    journal: s.journal,
    journalId: s.journalId,
    published: s.published || '',
    doi: s.doi,
    arxivId: s.arxivId,
    link: s.link,
    categories: s.categories,
    type: s.type as Entry['type'],
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function loadFeedEntries(follows: string[]): Promise<EntryShape[]> {
  const since = new Date(Date.now() - PREFETCH_FOLLOWS_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const supabase = serviceSupabase();
  // Use the full RPC (not _lite) so abstracts ship with the SSR payload.
  // Without this, the home feed cards never get the "tl;dr" / "Show abstract"
  // buttons because their gating condition is `entry.abstract truthy`, and
  // useEntries' SSR-prefetch path skips the client refetch that would have
  // backfilled abstracts. Discover works because it has no SSR prefetch.
  const { data, error } = await supabase.rpc('feed_for_follows', {
    p_follows: follows,
    p_since: since,
    p_limit: PREFETCH_FOLLOWS_LIMIT,
  });
  if (error || !data) return [];

  const rows: SightingRow[] = (data as any[]).map(r => ({
    source_feed: r.source_feed,
    legacy_entry_id: r.legacy_entry_id,
    feed_link: r.feed_link,
    paper_id: r.canonical_id,
    papers: {
      canonical_id: r.canonical_id,
      title: r.title,
      abstract: r.abstract ?? null,
      authors: r.authors ?? null,
      authors_text: r.authors_text,
      published_at: r.published_at,
      primary_source: r.primary_source,
      primary_link: r.primary_link,
      external_ids: r.external_ids,
      categories: r.categories,
      type: r.type,
    },
  })) as SightingRow[];

  const shaped = rows.map(shapeEntry).filter(Boolean) as EntryShape[];
  shaped.sort(sortByPublishedDesc);
  return shaped;
}
