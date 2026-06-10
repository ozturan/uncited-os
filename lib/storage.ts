import { UserState } from './types';
import { createClient } from './supabase/client';
import { cleanupState } from './userStateCleanup';
import { SINGLE_USER_MODE } from './localUser';

const STORAGE_KEY = 'uncited_state';
const THEME_STORAGE_KEY = 'uncited_theme';

// Get theme from dedicated localStorage key (fast, sync access)
export function getStoredTheme(): string {
  if (typeof window === 'undefined') return 'light';
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'light';
  } catch {
    return 'light';
  }
}

// Save theme to dedicated localStorage key (doesn't affect user state sync)
export function setStoredTheme(theme: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore
  }
}

// Cache for offline/before auth
let localCache: UserState | null = null;

// Coalesced localStorage writes. `saveState` gets called from every
// star/read/follow action; stringifying + writing a heavy user's 17k-
// entry state blob per action was adding 50-100ms of main-thread jank.
// Schedule one write per 2s instead — the writes are pure mirror/backup
// (Supabase is source-of-truth for auth'd users) so a 2s gap is safe.
let pendingLocalStorageState: UserState | null = null;
let localStorageFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLocalStorageWrite(state: UserState) {
  if (typeof window === 'undefined') return;
  pendingLocalStorageState = state;
  localCache = state;
  if (localStorageFlushTimer) return;
  localStorageFlushTimer = setTimeout(() => {
    localStorageFlushTimer = null;
    const toSave = pendingLocalStorageState;
    pendingLocalStorageState = null;
    if (!toSave) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...toSave, _lastSaved: Date.now() }));
    } catch (e) {
      console.warn('Failed to flush state to localStorage:', e);
    }
  }, 2000);
}

// Shape returned by the get_user_activity RPC. One row per read/star
// with the canonical_id mirror populated by the id_map trigger.
type ReadRow = { entry_id: string; canonical_id: string | null; created_at: string };

// Save queue to prevent race conditions when multiple saves happen quickly
let saveQueue: Promise<void> = Promise.resolve();
let lastSavedState: UserState | null = null;

// cleanupState moved to ./userStateCleanup so the server-side prefetch
// (lib/serverPrefetch.ts) can apply the same overlap reconciliation
// without pulling in browser-only code from this file.

// Synchronously load state from localStorage (for initial render, prevents flash)
export function loadStateSync(): UserState {
  if (typeof window === 'undefined') {
    return { follows: [], read: [], starred: [] };
  }

  // Return cached state if available
  if (localCache) return localCache;

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    localCache = { follows: [], read: [], starred: [] };
    return localCache;
  }

  try {
    const parsed = JSON.parse(stored);
    // Check if it's theme-only data (shouldn't be used for initial state)
    if (parsed._themeOnly) {
      return { follows: [], read: [], starred: [] };
    }
    localCache = cleanupState({
      follows: parsed.follows || [],
      read: parsed.read || [],
      starred: parsed.starred || [],
      readTimestamps: parsed.readTimestamps,
      starredTimestamps: parsed.starredTimestamps,
      // Mirror canonical arrays on sync load so the first render's
      // dual-read matcher has them — otherwise starred papers flash
      // as unread until the async loadState() finishes.
      readCanonical: parsed.readCanonical,
      starredCanonical: parsed.starredCanonical,
      readTimestampsCanonical: parsed.readTimestampsCanonical,
      starredTimestampsCanonical: parsed.starredTimestampsCanonical,
      canonicalMigratedAt: parsed.canonicalMigratedAt,
      lastVisit: parsed.lastVisit,
      settings: parsed.settings
    });
    return localCache;
  } catch {
    localCache = { follows: [], read: [], starred: [] };
    return localCache;
  }
}

export async function loadState(preAuthUser?: { id: string } | null): Promise<UserState> {
  const supabase = createClient();

  // Use pre-authenticated user if provided, otherwise check auth (slower)
  let user = preAuthUser;
  if (user === undefined) {
    const { data: { user: fetchedUser }, error: authError } = await supabase.auth.getUser();

    // If there's an auth error (like invalid refresh token), sign out and return empty state
    if (authError && (authError.message?.includes('refresh_token') || authError.code === 'refresh_token_not_found')) {
      console.warn('Auth error detected (invalid refresh token), signing out:', authError.message);
      await supabase.auth.signOut();
      return { follows: [], read: [], starred: [] };
    }
    user = fetchedUser;
  }

  if (!user) {
    // Return from localStorage for non-authenticated users
    if (typeof window === 'undefined') {
      return { follows: [], read: [], starred: [] };
    }

    if (localCache) return localCache;

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      localCache = { follows: [], read: [], starred: [] };
      return localCache;
    }

    try {
      localCache = JSON.parse(stored);
      return localCache || { follows: [], read: [], starred: [] };
    } catch {
      localCache = { follows: [], read: [], starred: [] };
      return localCache;
    }
  }

  // Phase 8: read/starred/timestamps come from the dedicated
  // reads/stars tables. user_state now holds only small, fast-to-
  // write fields (follows/settings/last_visit). The old jsonb array
  // columns are no longer written by saveState — they may linger on
  // the row for a while but we stopped reading them.
  //
  // Single RPC `get_user_activity` returns {reads, stars} as one
  // jsonb blob. Was paginating 17 separate range() requests for a
  // 17k-row heavy user (~1.5-3s wall time); now one round-trip.
  const [userRow, activityRow] = await Promise.all([
    supabase
      .from('user_state')
      .select('follows, last_visit, settings, updated_at, canonical_migrated_at')
      .eq('user_id', user.id)
      .single(),
    supabase.rpc('get_user_activity', { p_user_id: user.id }),
  ]);
  let { data, error } = userRow;
  const activity = (activityRow.data as { reads?: ReadRow[]; stars?: ReadRow[] } | null) || {};
  const readsRows = activity.reads || [];
  const starsRows = activity.stars || [];

  // Build read/starred (+ canonical mirrors + timestamps) from the dedicated
  // reads/stars tables FIRST. This is independent of the user_state row, so it
  // must survive even when that row is missing or its read fails — otherwise a
  // present-but-rowless account (user_state deleted/reset while reads/stars
  // rows still exist) silently shows zero reads/stars on every load.
  const read: string[] = [];
  const readCanonical: string[] = [];
  const readTimestamps: { [k: string]: string } = {};
  const readTimestampsCanonical: { [k: string]: string } = {};
  for (const r of readsRows) {
    if (!r.entry_id) continue;
    read.push(r.entry_id);
    readTimestamps[r.entry_id] = r.created_at;
    if (r.canonical_id) { readCanonical.push(r.canonical_id); readTimestampsCanonical[r.canonical_id] = r.created_at; }
  }
  const starred: string[] = [];
  const starredCanonical: string[] = [];
  const starredTimestamps: { [k: string]: string } = {};
  const starredTimestampsCanonical: { [k: string]: string } = {};
  for (const s of starsRows) {
    if (!s.entry_id) continue;
    starred.push(s.entry_id);
    starredTimestamps[s.entry_id] = s.created_at;
    if (s.canonical_id) { starredCanonical.push(s.canonical_id); starredTimestampsCanonical[s.canonical_id] = s.created_at; }
  }
  const activityState = {
    read, starred, readTimestamps, starredTimestamps,
    readCanonical, starredCanonical, readTimestampsCanonical, starredTimestampsCanonical,
  };

  if (error) {
    // Only handle specific "not found" errors - don't overwrite on other errors!
    // PGRST116 means no rows found (expected for new users)
    if (error.code === 'PGRST116') {
      // No user_state row — but the reads/stars tables may still hold data, so
      // return that activity instead of discarding it. follows/settings default
      // to empty (the saveState anti-wipe guard protects them from persisting).
      return { follows: [], ...activityState };
    } else {
      // Other errors (network, auth, etc.) - DON'T overwrite! Try localStorage as fallback
      console.error('Supabase loadState error (non-fatal):', error);
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          try {
            const localState: UserState = JSON.parse(stored);
            // Return local state but keep the table-sourced reads/stars (the
            // table is the source of truth); DON'T save empty state to Supabase.
            return { ...localState, ...activityState };
          } catch {
            // If localStorage also fails, return reads/stars but DON'T save it
            return { follows: [], ...activityState };
          }
        }
      }
      // Return reads/stars but DON'T save it to Supabase on errors
      return { follows: [], ...activityState };
    }
  }

  if (!data) {
    // No data but no error - this is suspicious, could be a transient issue
    // Don't overwrite existing data! Try to check if row actually exists first
    // If query succeeded but returned null, it might be a data format issue, not missing data

    // Check localStorage as fallback but DON'T save empty state
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          const localState: UserState = JSON.parse(stored);
          // Only migrate if local state has actual data, don't overwrite with empty
          if (localState.follows.length > 0 || localState.read.length > 0 || localState.starred.length > 0 || localState.settings) {
            await saveState(localState);
            localStorage.removeItem(STORAGE_KEY);
            return localState;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // CRITICAL: Don't save empty state if data is null - this could overwrite existing data!
    // Only return empty state, don't persist it
    // If user truly has no data, they'll create it through normal usage
    console.warn('loadState: Supabase returned null data with no error - returning reads/stars without persisting');
    return { follows: [], ...activityState };
  }

  // Parse array fields (they might be strings from Supabase).
  const parseArray = (value: any): string[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  // read/starred (+ canonical mirrors + timestamps) were already built above
  // from the dedicated tables, so they're available on every path.
  let loadedState: UserState = {
    follows: parseArray(data.follows),
    read,
    starred,
    readTimestamps,
    starredTimestamps,
    readCanonical,
    starredCanonical,
    readTimestampsCanonical,
    starredTimestampsCanonical,
    canonicalMigratedAt: data.canonical_migrated_at || undefined,
    lastVisit: data.last_visit || undefined,
    settings: data.settings || undefined,
  };

  // Clean up: ensure no item is in both starred and archived
  loadedState = cleanupState(loadedState);

  // For authenticated users, NEVER use localStorage for data arrays (follows, read, starred)
  // Supabase is the SINGLE SOURCE OF TRUTH for authenticated users
  // localStorage is only used for settings (theme) for fast initial render
  // This prevents the data loss bug where localStorage overwrites Supabase
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);

        // Only merge settings (theme, preferences) - NEVER data arrays.
        // Server wins on conflicts: localStorage only fills in keys the server
        // row doesn't have. Spreading local LAST used to clobber server values,
        // which made a theme changed on one device never appear on another (each
        // device kept re-applying its own stale localStorage theme). For a
        // signed-in user, user_state is the source of truth.
        if (parsed.settings) {
          loadedState.settings = { ...parsed.settings, ...loadedState.settings };
        }

        // Sync theme to dedicated theme storage
        if (loadedState.settings?.theme) {
          setStoredTheme(loadedState.settings.theme);
        }

        // Clear localStorage for authenticated users - keep only theme for fast load
        // This prevents stale localStorage from causing issues
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          _themeOnly: true,
          settings: { theme: loadedState.settings?.theme },
          _lastCleared: Date.now()
        }));
      }
    } catch {
      // Ignore errors
    }
  }

  // Final cleanup before returning
  return cleanupState(loadedState);
}

export async function saveState(state: UserState): Promise<void> {
  // Queue this save to prevent race conditions
  saveQueue = saveQueue.then(async () => {
    await performSave(state);
  }).catch(err => {
    console.error('Error in save queue:', err);
  });

  return saveQueue;
}

async function performSave(state: UserState): Promise<void> {
  const supabase = createClient();

  // Clean up state before saving: ensure no item is in both starred and archived
  // This initial cleanup ensures the state we're about to save is consistent
  // We'll clean up again after merging with database data to handle any edge cases
  const cleanedState = cleanupState(state);

  // Defensive check: ensure we didn't accidentally remove articles that are only in one list
  // This should never happen, but if it does, log a warning
  const stateStarredCount = state.starred?.length || 0;
  const cleanedStarredCount = cleanedState.starred?.length || 0;
  const stateReadCount = state.read?.length || 0;
  const cleanedReadCount = cleanedState.read?.length || 0;

  if (cleanedStarredCount < stateStarredCount || cleanedReadCount < stateReadCount) {
    // Check if any articles were removed that shouldn't have been
    const removedFromStarred = state.starred?.filter(id => !cleanedState.starred.includes(id)) || [];
    const removedFromRead = state.read?.filter(id => !cleanedState.read.includes(id)) || [];

    // Only warn if articles were removed that aren't in both lists
    removedFromStarred.forEach(id => {
      if (!state.read?.includes(id)) {
        console.warn('performSave: Article removed from starred but was not in read:', id);
      }
    });
    removedFromRead.forEach(id => {
      if (!state.starred?.includes(id)) {
        console.warn('performSave: Article removed from read but was not in starred:', id);
      }
    });
  }

  // Mirror to localStorage (debounced). Full-state stringify of a 17k-
  // entry heavy user was ~500KB and blocked the main thread for ~100ms
  // per action; now collapsed to one write per 2s.
  lastSavedState = cleanedState;
  scheduleLocalStorageWrite(cleanedState);

  // Check if user is authenticated before proceeding
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  // If there's an auth error (like invalid refresh token), don't save
  // This prevents data loss attempts during auth failures
  if (authError && (authError.message?.includes('refresh_token') || authError.code === 'refresh_token_not_found')) {
    console.warn('Auth error detected during saveState (invalid refresh token), skipping save:', authError.message);
    // Sign out to clear invalid session
    await supabase.auth.signOut();
    return;
  }

  // Use the already-cleaned state from the top of the function. The
  // old code ran cleanupState THREE TIMES per save (once here, once
  // more at state=cleanupState(state), once more at finalState=
  // cleanupState(state)) — for heavy users with 17k reads each pass
  // was ~30ms of synchronous array/object work. Phase 8 removed the
  // merge-with-existing logic between them, so there's nothing to
  // re-clean in between.
  const finalState = cleanedState;

  // Save theme to dedicated localStorage key for immediate access on next page load
  if (finalState.settings?.theme) {
    setStoredTheme(finalState.settings.theme);
  }

  // User already checked above, check again for non-authenticated path
  if (!user) {
    // Already saved to localStorage above
    return;
  }

  // ANTI-WIPE GUARD. When the DB read fails/times out, loadState returns the
  // default empty state ({follows:[], read:[], starred:[]}). If a save then
  // fires (a theme/sort change, autosave), it would clobber the real follows
  // AND settings (keywords, research profile) with empties — exactly the data
  // loss seen during the 2026-06-09 Supabase outage. So: if the incoming state
  // is "empty everything" (follows + read + starred all empty — the failed-load
  // signature, NOT a genuine unfollow-all, which keeps read/starred), verify
  // against the DB and refuse to overwrite a populated row.
  let safeFollows = finalState.follows;
  let safeSettings: unknown = finalState.settings || null;
  const looksLikeFailedLoad =
    (finalState.follows?.length || 0) === 0 &&
    (finalState.read?.length || 0) === 0 &&
    (finalState.starred?.length || 0) === 0;
  // The anti-wipe guard protects against a failed DB load clobbering real data.
  // In single-user local mode it would also block a genuine "unfollow my last
  // journal" (which produces the same empty signature), so skip it there.
  if (looksLikeFailedLoad && !SINGLE_USER_MODE) {
    try {
      const { data: existing, error: readErr } = await supabase
        .from('user_state')
        .select('follows, settings')
        .eq('user_id', user.id)
        .maybeSingle();
      if (readErr) {
        // Couldn't verify — do NOT risk clobbering. Skip the DB write.
        console.warn('[saveState] anti-wipe: verify read failed, skipping save to protect follows/settings');
        return;
      }
      const existingFollows = Array.isArray(existing?.follows) ? existing!.follows : [];
      const existingSettings = (existing?.settings as Record<string, unknown> | null) || null;
      const existingHasData = existingFollows.length > 0 ||
        !!(existingSettings && (existingSettings.keywordFilters || existingSettings.field_centroid));
      if (existingHasData) {
        console.warn('[saveState] anti-wipe: refusing to overwrite a populated account with empty state; preserving stored follows/settings');
        safeFollows = existingFollows;
        // keep stored settings unless the incoming settings actually carries the user's profile fields
        const incoming = (finalState.settings as Record<string, unknown> | undefined) || {};
        if (!incoming.keywordFilters && !incoming.field_centroid && existingSettings) {
          safeSettings = existingSettings;
        }
      }
    } catch {
      console.warn('[saveState] anti-wipe: verify threw, skipping save to protect follows/settings');
      return;
    }
  }

  // Phase 8: saveState only persists tiny, fast-to-write fields.
  // read/starred/timestamps/canonicals now live in the reads/stars
  // tables (one row per action) and are updated by markRead,
  // markUnread, toggleStar etc. Was uploading ~3 MB per save for
  // heavy accounts and tripping Supabase's 49s statement_timeout.
  // Now each save is a few kilobytes.
  const basePayload: Record<string, unknown> = {
    user_id: user.id,
    follows: safeFollows,
    last_visit: finalState.lastVisit || null,
    settings: safeSettings,
    updated_at: new Date().toISOString(),
  };

  // Try with timestamps first
  let { error } = await supabase
    .from('user_state')
    .upsert(basePayload, {
      onConflict: 'user_id'
    });

  if (error) {
    console.error('Error saving state:', error);
  }
}

export async function exportState(): Promise<string> {
  const state = await loadState();
  return JSON.stringify(state, null, 2);
}

export async function importState(json: string): Promise<UserState> {
  const state = JSON.parse(json);
  await saveState(state);
  return state;
}

export async function followJournal(journalId: string): Promise<void> {
  // Fire-and-forget Supabase backup function
  const syncToSupabase = async (timestamp: string) => {
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) return;

      // Add to follows backup table
      await supabase.from('follows').upsert({
        user_id: user.id,
        journal_id: journalId,
        created_at: timestamp
      }, { onConflict: 'user_id,journal_id' });
    } catch (e) {
      console.warn('Background sync to follows table failed:', e);
    }
  };

  const state = await loadState();
  if (!state.follows.includes(journalId)) {
    const timestamp = new Date().toISOString();

    state.follows.push(journalId);

    // Trigger background sync without awaiting
    syncToSupabase(timestamp);

    await saveState(state);
  }
}

export async function unfollowJournal(journalId: string, currentState?: UserState): Promise<void> {
  // Fire-and-forget Supabase backup function
  const syncToSupabase = async () => {
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) return;

      // Remove from follows backup table
      await supabase.from('follows').delete().match({ user_id: user.id, journal_id: journalId });
    } catch (e) {
      console.warn('Background sync to follows table failed:', e);
    }
  };

  // If currentState is provided, it already has the journal unfollowed (optimistic update)
  // Just save it directly to persist the change
  if (currentState) {
    // Trigger background sync without awaiting
    syncToSupabase();

    await saveState(currentState);
    return;
  }

  // Otherwise, load state and unfollow
  const state = await loadState();
  state.follows = state.follows.filter(id => id !== journalId);

  // Trigger background sync without awaiting
  syncToSupabase();

  await saveState(state);
}

export async function markRead(entryId: string, currentState?: UserState): Promise<void> {
  // Fire-and-forget Supabase backup function
  const syncToSupabase = async (timestamp: string) => {
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) return;

      // Add to reads backup table
      await supabase.from('reads').upsert({
        user_id: user.id,
        entry_id: entryId,
        created_at: timestamp
      }, { onConflict: 'user_id,entry_id' });
    } catch (e) {
      console.warn('Background sync to reads table failed:', e);
    }
  };

  // If currentState is provided, it already has the entry marked as read (optimistic update)
  // Just save it directly to persist the change
  if (currentState) {
    const timestamp = currentState.readTimestamps?.[entryId] || new Date().toISOString();

    // Trigger background sync without awaiting
    syncToSupabase(timestamp);

    // Fire-and-forget save (don't await)
    saveState(currentState).catch(console.error);
    return;
  }

  // Otherwise, load state and mark as read
  const state = await loadState();
  if (!state.read.includes(entryId)) {
    const timestamp = new Date().toISOString();

    state.read.push(entryId);
    // Track timestamp when marked as read
    if (!state.readTimestamps) {
      state.readTimestamps = {};
    }
    state.readTimestamps[entryId] = timestamp;
    // IMPORTANT: When archiving, if article is starred, remove it from starred
    // The most recent action (archive) takes precedence
    if (state.starred.includes(entryId)) {
      state.starred = state.starred.filter(id => id !== entryId);
      // Clean up starred timestamp
      if (state.starredTimestamps) {
        delete state.starredTimestamps[entryId];
      }
    }

    // Trigger background sync without awaiting
    syncToSupabase(timestamp);

    await saveState(state);
  }
}

export async function markUnread(entryId: string, currentState?: UserState): Promise<void> {
  // Fire-and-forget Supabase backup function
  const syncToSupabase = async () => {
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) return;

      // Remove ALL sightings of this paper (same paper across feeds shares a
      // canonical_id but has distinct entry_ids); deleting only entry_id leaves
      // a sibling row that reappears as read after a reload. Resolve via id_map.
      await supabase.from('reads').delete().match({ user_id: user.id, entry_id: entryId });
      const { data: m } = await supabase.from('id_map').select('canonical_id').eq('legacy_entry_id', entryId).maybeSingle();
      if (m?.canonical_id) {
        await supabase.from('reads').delete().match({ user_id: user.id, canonical_id: m.canonical_id });
      }
    } catch (e) {
      console.warn('Background sync to reads table failed:', e);
    }
  };

  // If currentState is provided, it already has the entry removed (optimistic update)
  // Just save it directly to persist the change
  if (currentState) {
    // Trigger background sync without awaiting
    syncToSupabase();

    // Fire-and-forget save (don't await)
    saveState(currentState).catch(console.error);
    return;
  }

  // Otherwise, load state and mark as unread
  const state = await loadState();
  state.read = state.read.filter(id => id !== entryId);
  // Remove timestamp
  if (state.readTimestamps) {
    delete state.readTimestamps[entryId];
  }

  // Trigger background sync without awaiting
  syncToSupabase();

  await saveState(state);
}

export async function toggleStar(entryId: string, currentState?: UserState): Promise<void> {
  // Fire-and-forget Supabase sync function
  const syncToSupabase = async (isStarred: boolean, timestamp: string) => {
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) return;

      if (isStarred) {
        // Ensure it's in the stars table
        await supabase.from('stars').upsert({
          user_id: user.id,
          entry_id: entryId,
          created_at: timestamp
        }, { onConflict: 'user_id,entry_id' });
      } else {
        // Remove ALL sightings of this paper, not just this entry_id. The same
        // paper seen via multiple feeds has distinct entry_ids but one
        // canonical_id; deleting only the entry_id leaves a sibling row that
        // reappears as starred after a reload. Resolve canonical via id_map.
        await supabase.from('stars').delete().match({ user_id: user.id, entry_id: entryId });
        const { data: m } = await supabase.from('id_map').select('canonical_id').eq('legacy_entry_id', entryId).maybeSingle();
        if (m?.canonical_id) {
          await supabase.from('stars').delete().match({ user_id: user.id, canonical_id: m.canonical_id });
        }
      }
    } catch (e) {
      console.warn('Background sync to Supabase stars table failed:', e);
    }
  };

  // If currentState is provided, it already has the entry starred/unstarred (optimistic update)
  // Just save it directly to persist the change, but also update Supabase stars table in background
  if (currentState) {
    const isStarred = currentState.starred.includes(entryId);
    const timestamp = currentState.starredTimestamps?.[entryId] || new Date().toISOString();

    // Trigger background sync without awaiting
    syncToSupabase(isStarred, timestamp);

    // Fire-and-forget save (don't await)
    saveState(currentState).catch(console.error);
    return;
  }

  // Otherwise, load state and toggle
  const state = await loadState();
  const timestamp = new Date().toISOString();
  let isStarred = false;

  if (state.starred.includes(entryId)) {
    state.starred = state.starred.filter(id => id !== entryId);
    // Remove timestamp
    if (state.starredTimestamps) {
      delete state.starredTimestamps[entryId];
    }
    isStarred = false;
  } else {
    state.starred.push(entryId);
    // Track timestamp
    if (!state.starredTimestamps) {
      state.starredTimestamps = {};
    }
    state.starredTimestamps[entryId] = timestamp;
    // IMPORTANT: When starring, if article is archived (read), remove it from archive
    // The most recent action (star) takes precedence
    if (state.read.includes(entryId)) {
      state.read = state.read.filter(id => id !== entryId);
      // Clean up read timestamp
      if (state.readTimestamps) {
        delete state.readTimestamps[entryId];
      }
    }
    isStarred = true;
  }

  // Trigger background sync without awaiting
  syncToSupabase(isStarred, timestamp);

  await saveState(state);
}

// Bulk mark-as-read for "Mark all read".
//
// Routes through /api/mark-all-read (server-side, auth-from-cookie,
// service-role write) because direct anon upsert from the browser
// silently failed in production — likely an auth/RLS interaction we
// couldn't pin down. The server route surfaces real errors in Vercel
// logs and uses one round-trip regardless of payload size.
export async function bulkMarkRead(
  entryIds: string[],
  alsoUnstar: boolean,
  currentState: UserState,
): Promise<void> {
  // Persist follows/settings via user_state (separate from reads/stars tables).
  saveState(currentState).catch(console.error);
  if (entryIds.length === 0) return;

  const res = await fetch('/api/mark-all-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryIds, alsoUnstar }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[bulkMarkRead] /api/mark-all-read failed', res.status, text);
    throw new Error(`mark-all-read failed: ${res.status} ${text}`);
  }
}

// Migrate and merge localStorage data to Supabase when user signs in
export async function migrateLocalStorageToSupabase(): Promise<void> {
  if (typeof window === 'undefined') return;

  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  // If there's an auth error, don't proceed with migration
  if (authError && (authError.message?.includes('refresh_token') || authError.code === 'refresh_token_not_found')) {
    console.warn('Auth error detected during migration, skipping:', authError.message);
    return;
  }

  if (!user) return;

  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return;

  try {
    const parsed = JSON.parse(stored);

    // CRITICAL: Check if this is a theme-only localStorage entry
    // If _themeOnly flag is set, don't migrate - it would overwrite Supabase with empty data
    if (parsed._themeOnly) {
      console.log('LocalStorage contains theme-only data (no real user data) - skipping migration');
      return; // Don't migrate theme-only localStorage
    }

    const localState: UserState = {
      follows: parsed.follows || [],
      read: parsed.read || [],
      starred: parsed.starred || [],
      settings: parsed.settings,
      readTimestamps: parsed.readTimestamps,
      starredTimestamps: parsed.starredTimestamps,
      lastVisit: parsed.lastVisit
    };

    // Check if user already has state in Supabase
    const { data: existingState } = await supabase
      .from('user_state')
      .select('follows, read, starred, settings')
      .eq('user_id', user.id)
      .single();

    if (!existingState) {
      // No existing state - migrate local storage to Supabase
      // BUT only if localStorage has actual data (don't overwrite with empty)
      if (localState.follows && localState.follows.length > 0 ||
        localState.read && localState.read.length > 0 ||
        localState.starred && localState.starred.length > 0 ||
        localState.settings) {
        await saveState(localState);
        // Verify save was successful before clearing localStorage
        const { data: verifyData } = await supabase
          .from('user_state')
          .select('follows, read, starred, settings')
          .eq('user_id', user.id)
          .single();

        if (verifyData) {
          // Verify we actually saved data, not empty arrays
          const verifyFollows = Array.isArray(verifyData.follows) ? verifyData.follows : [];
          const verifySettings = verifyData.settings;
          if (verifyFollows.length > 0 || verifySettings) {
            console.log('Migrated local storage to Supabase');
            // Only clear localStorage after verifying Supabase has the data
            localStorage.removeItem(STORAGE_KEY);
          } else {
            console.error('Migration failed: Supabase state saved but appears empty');
            // Don't clear localStorage if save failed or data is empty
          }
        } else {
          console.error('Migration failed: Could not verify Supabase state after save');
          // Don't clear localStorage if verification failed
        }
      } else {
        console.log('LocalStorage has no data to migrate - skipping');
        // Clear empty localStorage so it doesn't try to migrate again
        localStorage.removeItem(STORAGE_KEY);
      }
    } else {
      // User already has state in Supabase
      // CRITICAL: Only merge if localStorage has ACTUAL user data (follows/read/starred), not just theme
      // If localStorage only has theme settings, it's likely from saveState() and should not overwrite Supabase
      const localHasRealData =
        (localState.follows && localState.follows.length > 0) ||
        (localState.read && localState.read.length > 0) ||
        (localState.starred && localState.starred.length > 0);

      // Check if settings has more than just theme (e.g., sidebarOrganization)
      const settingsHasMoreThanTheme = localState.settings &&
        Object.keys(localState.settings).filter(k => k !== 'theme').length > 0;

      if (!localHasRealData && !settingsHasMoreThanTheme) {
        // localStorage is empty or only has theme - just clear it and don't touch Supabase
        console.log('LocalStorage has no real data (only theme or empty), Supabase has data - clearing localStorage only');
        localStorage.removeItem(STORAGE_KEY);
        return; // Don't merge empty data or theme-only data
      }

      // Parse existing state arrays (they might be strings from Supabase)
      const parseArray = (value: any): string[] => {
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
        return [];
      };

      const existingFollows = parseArray(existingState.follows);
      const existingRead = parseArray(existingState.read);
      const existingStarred = parseArray(existingState.starred);

      // Merge: Supabase is source of truth for follows (prevents re-adding unfollowed journals)
      // For read/starred, union merge is safe (adding more is fine)
      // We can't distinguish "never followed" from "unfollowed" in localStorage,
      // so we trust Supabase for the current follows list
      const mergedState: UserState = {
        follows: existingFollows, // Supabase is source of truth - don't merge localStorage follows
        read: [...new Set([...existingRead, ...(localState.read || [])])],
        starred: [...new Set([...existingStarred, ...(localState.starred || [])])],
        settings: existingState.settings || localState.settings || undefined
      };

      // Only save if there are differences (avoid unnecessary writes)
      const hasChanges =
        mergedState.follows.length !== existingFollows.length ||
        mergedState.read.length !== existingRead.length ||
        mergedState.starred.length !== existingStarred.length ||
        JSON.stringify(existingState.settings || {}) !== JSON.stringify(mergedState.settings || {});

      if (hasChanges) {
        await saveState(mergedState);
        // Verify save was successful before clearing localStorage
        const { data: verifyData } = await supabase
          .from('user_state')
          .select('follows, read, starred, settings')
          .eq('user_id', user.id)
          .single();

        if (verifyData) {
          const verifyFollows = parseArray(verifyData.follows);
          const verifySettings = verifyData.settings;
          // Verify we saved more data than we had, or at least the same amount
          if (verifyFollows.length >= existingFollows.length &&
            (verifySettings || existingState.settings)) {
            console.log('Merged local storage with Supabase state');
            // Only clear localStorage after verifying Supabase has the merged data
            localStorage.removeItem(STORAGE_KEY);
          } else {
            console.error('Merge failed: Supabase state not saved correctly or lost data');
            // Don't clear localStorage if save failed or we lost data
          }
        } else {
          console.error('Merge failed: Could not verify Supabase state after save');
          // Don't clear localStorage if verification failed
        }
      } else {
        // No changes needed, safe to clear localStorage
        console.log('No changes to merge - clearing localStorage');
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch (error) {
    console.error('Error migrating local storage:', error);
  }
}

