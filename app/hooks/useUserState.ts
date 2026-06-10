'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { UserState, UserSettings, Entry } from '@/lib/types';
import { loadState, loadStateSync, saveState, toggleStar, markRead, markUnread, unfollowJournal, migrateLocalStorageToSupabase } from '@/lib/storage';

const DEFAULT_SETTINGS: UserSettings = { sidebarOrganization: 'discipline', theme: 'light', showThumbnails: true };
export { DEFAULT_SETTINGS };

export function useUserState(
  user: any,
  userLoading: boolean,
  onSignOut?: () => void,
  initialState: UserState | null = null,
) {
  // When the server has already hydrated the user_state for us
  // (lib/serverPrefetch.prefetchDashboard), seed React state with it and
  // mark stateLoadedOnce immediately. The follows-change SWR refetch
  // further down still runs as before to keep things fresh.
  const [state, setState] = useState<UserState>(
    initialState || { follows: [], read: [], starred: [] }
  );
  const [loading, setLoading] = useState(!initialState);
  const [stateLoadedOnce, setStateLoadedOnce] = useState(!!initialState);

  const prevUserRef = useRef<any>(null);
  const prevFollowsRef = useRef<string[]>(initialState?.follows ? [...initialState.follows] : []);
  const entriesLoadingStartedRef = useRef<boolean>(!!initialState);

  // Expose refs for useEntries
  const isFirstLogin = user && !prevUserRef.current;
  useEffect(() => {
    prevUserRef.current = user;
  }, [user?.id]);

  // State loading + migration effect
  useEffect(() => {
    if (user && !userLoading && !stateLoadedOnce) {
      const migrationAttempted = sessionStorage.getItem('migration_attempted');

      loadState(user).then(async (newState) => {
        const isEmpty = (!newState.follows || newState.follows.length === 0) &&
          (!newState.settings || !newState.settings.theme);

        if (isEmpty && !migrationAttempted && typeof window !== 'undefined') {
          const stored = localStorage.getItem('uncited_state');
          if (stored) {
            try {
              const parsed = JSON.parse(stored);
              if (!parsed._themeOnly && (parsed.follows?.length > 0 || parsed.settings)) {
                newState = {
                  follows: parsed.follows || [],
                  read: parsed.read || [],
                  starred: parsed.starred || [],
                  readTimestamps: parsed.readTimestamps,
                  starredTimestamps: parsed.starredTimestamps,
                  lastVisit: parsed.lastVisit,
                  settings: parsed.settings,
                };
                sessionStorage.setItem('migration_attempted', 'true');
                migrateLocalStorageToSupabase().catch(() => {});
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }

        const currentVisitTime = new Date().toISOString();

        setState(prevState => ({
          ...newState,
          lastVisit: currentVisitTime,
          settings: newState.settings || prevState.settings
        }));
        prevFollowsRef.current = [...(newState.follows || [])];
        setStateLoadedOnce(true);
        setLoading(false);

        saveState({
          ...newState,
          lastVisit: currentVisitTime
        }).catch(console.error);
      }).catch(() => {
        setStateLoadedOnce(true);
        setLoading(false);
      });

      if (!migrationAttempted) {
        sessionStorage.setItem('migration_attempted', 'true');
        migrateLocalStorageToSupabase().catch(() => {});
      }
    } else if (!user && !userLoading) {
      setState({ follows: [], read: [], starred: [] });
      setStateLoadedOnce(true);
      setLoading(false);
      entriesLoadingStartedRef.current = false;
      prevFollowsRef.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, userLoading, stateLoadedOnce]);

  // Phase A bug fix: when state is server-prefetched, the loadState()
  // branch above is skipped — so user_state.last_visit never gets bumped
  // on a cold page load. Stamp it explicitly here so the analytics
  // dashboard's `Visited (30d)` chart and engagement-rate calc keep
  // tracking real visits, not just actions.
  const lastVisitStampedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !stateLoadedOnce) return;
    if (lastVisitStampedRef.current === user.id) return;
    lastVisitStampedRef.current = user.id;
    const currentVisitTime = new Date().toISOString();
    setState(prev => {
      const next = { ...prev, lastVisit: currentVisitTime };
      saveState(next).catch(console.error);
      return next;
    });
  }, [user?.id, stateLoadedOnce]);

  // Extended sign-out: clear state too
  const handleSignOut = useCallback(async () => {
    setState({ follows: [], read: [], starred: [] });
    setStateLoadedOnce(false);
    if (onSignOut) await onSignOut();
  }, [onSignOut]);

  // Immediate Sets for instant visual feedback on cards.
  // Legacy sets are kept (back-compat for call sites not yet migrated).
  // Canonical sets cover cross-feed duplicates via the papers/sightings
  // migration. matcher.isStarred(entry) checks canonical first, falls
  // back to legacy id so nothing breaks during the transition.
  const readSet = useMemo(() => new Set(state.read), [state.read]);
  const starredSet = useMemo(() => new Set(state.starred), [state.starred]);
  const readSetCanonical = useMemo(
    () => new Set(state.readCanonical ?? []),
    [state.readCanonical]
  );
  const starredSetCanonical = useMemo(
    () => new Set(state.starredCanonical ?? []),
    [state.starredCanonical]
  );

  // --- Action handlers ---

  const handleToggleFollowJournal = useCallback(async (journalId: string) => {
    if (!journalId) return;
    setState(prev => {
      const isFollowing = prev.follows.includes(journalId);
      if (isFollowing) {
        const newFollows = prev.follows.filter(id => id !== journalId);
        const newState = { ...prev, follows: newFollows };
        unfollowJournal(journalId, newState).catch(console.error);
        return newState;
      } else {
        const newFollows = [...prev.follows, journalId];
        const newState = { ...prev, follows: newFollows };
        saveState(newState).catch(console.error);
        return newState;
      }
    });
  }, []);

  const handleSettingsChange = useCallback(async (newSettings: UserSettings) => {
    setState(prev => {
      const newState = { ...prev, settings: newSettings };
      saveState(newState).catch(console.error);
      return newState;
    });
  }, []);

  const handleUpdateSettings = useCallback((newSettings: UserSettings) => {
    setState(prev => {
      const newState = { ...prev, settings: newSettings };
      saveState(newState).catch(console.error);
      return newState;
    });
  }, []);

  const handleUnfollowAll = useCallback(async () => {
    setState(prev => {
      if (prev.follows.length === 0) return prev;
      const newState = { ...prev, follows: [] };
      saveState(newState).catch(console.error);
      return newState;
    });
  }, []);

  return {
    state, setState, loading, stateLoadedOnce,
    readSet, starredSet,
    readSetCanonical, starredSetCanonical,
    prevFollowsRef, entriesLoadingStartedRef,
    handleToggleFollowJournal,
    handleSettingsChange, handleUpdateSettings, handleUnfollowAll,
    handleSignOut,
  };
}
