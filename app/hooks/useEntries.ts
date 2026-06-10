'use client';

import { useEffect, useState, useCallback, useRef, MutableRefObject } from 'react';
import { Entry, UserState } from '@/lib/types';
import { loadStateSync } from '@/lib/storage';

// Two-tier feed load, tuned so the user never sees a second wave:
//   1. Full window WITHOUT abstracts (lite RPC, small payload) → this is the
//      REVEAL gate. It carries the COMPLETE unread set and the true "Unread (N)"
//      count, so the feed paints once, fully formed (first 100 shown, the rest
//      paginated silently on scroll). Collapsed cards never render the abstract,
//      so omitting it here is visually identical to having it.
//   2. Full window WITH abstracts → silently backfills abstracts so the expanded
//      view / search / tl;dr work. No visible change to the collapsed list.
// An earlier fast 120-row first page was removed: revealing on it showed ~90
// unread (120 minus already-read) and the wrong count, then both jumped when the
// full window landed. The lite full fetch is small enough (~2-3s) to gate on.
const FULL_LIMIT = 5000;

function fetchFollowsFeed(follows: string[], limit: number, withAbstract = true): Promise<Entry[]> {
  const url = `/api/articles?${withAbstract ? 'with_abstract=1&' : ''}limit=${limit}&follows=${follows.join(',')}`;
  const doFetch = (): Promise<any> =>
    fetch(url).then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); });
  return doFetch()
    .catch((): Promise<any> => new Promise(resolve => setTimeout(resolve, 3000)).then(doFetch))
    .then((data: any) => (Array.isArray(data) ? (data as Entry[]) : []));
}

export function useEntries(
  user: any,
  userLoading: boolean,
  state: UserState,
  stateLoadedOnce: boolean,
  view: string,
  initialEntries: Entry[],
  isMobile: boolean,
  entriesLoadingStartedRef: MutableRefObject<boolean>,
  prevFollowsRef: MutableRefObject<string[]>,
) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries || []);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesLoadedOnce, setEntriesLoadedOnce] = useState(false);
  const isRefreshingRef = useRef(false);
  // Tracks which follows set the full (with-abstract backfill) load has completed
  // for, so neither the fast first page nor the lite full clobbers it.
  const fullLoadedKeyRef = useRef<string>('');
  // Tracks which follows set the lite full (no-abstract) load has landed for, so
  // a late fast first page doesn't shrink the complete list back to ~120.
  const liteLoadedKeyRef = useRef<string>('');

  // Load the followed-journal feed so it reveals once, fully formed: the
  // complete lite window gates the paint, then abstracts backfill silently.
  const loadFollowsTwoTier = useCallback((follows: string[]) => {
    const key = [...follows].sort().join('|');
    prevFollowsRef.current = [...follows];
    entriesLoadingStartedRef.current = true;
    setEntriesLoading(true);

    // Tier 1 — full window WITHOUT abstracts: the reveal gate. Complete unread
    // set + true count in one paint. Don't clobber the with-abstract full if it
    // somehow already landed for this same follows set.
    fetchFollowsFeed(follows, FULL_LIMIT, false)
      .then(lite => {
        if (fullLoadedKeyRef.current === key) return; // abstract-full already won
        liteLoadedKeyRef.current = key;
        setEntries(prev => prev.length > lite.length ? prev : lite);
        setEntriesLoading(false);
        setEntriesLoadedOnce(true);
      })
      .catch(() => { /* tier 2 is the backstop */ });

    // Tier 2 — full window WITH abstracts: silently backfills abstracts for the
    // expanded view / search / tl;dr. No visible change to the collapsed list.
    fetchFollowsFeed(follows, FULL_LIMIT, true)
      .then(full => {
        fullLoadedKeyRef.current = key;
        setEntries(full);
        setEntriesLoading(false);
        setEntriesLoadedOnce(true);
      })
      .catch(err => {
        console.error('Failed to load full feed:', err);
        setEntriesLoading(false);
        setEntriesLoadedOnce(true);
      });
  }, [entriesLoadingStartedRef, prevFollowsRef]);

  // Reset on mount
  useEffect(() => {
    entriesLoadingStartedRef.current = false;
    setEntriesLoadedOnce(false);
    if (initialEntries.length > 0) {
      setEntriesLoadedOnce(true);
      entriesLoadingStartedRef.current = true;
    }
  }, [initialEntries.length, entriesLoadingStartedRef]);

  // Clear entries on sign-out
  useEffect(() => {
    if (!user && !userLoading) {
      setEntries([]);
      setEntriesLoading(false);
      setEntriesLoadedOnce(false);
      entriesLoadingStartedRef.current = false;
    }
  }, [user, userLoading, entriesLoadingStartedRef]);

  // Optimistic SWR fetch on mount — kicks off the two-tier load from the
  // locally-cached follows so the feed starts appearing before Supabase state
  // resolves.
  useEffect(() => {
    if (entriesLoadingStartedRef.current) return;
    const cachedState = loadStateSync();
    if (cachedState && cachedState.follows && cachedState.follows.length > 0) {
      loadFollowsTwoTier(cachedState.follows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // State-based entries fetch (after state loads from Supabase)
  useEffect(() => {
    if (!user || userLoading || !stateLoadedOnce) return;

    const follows = state.follows || [];

    if (follows.length === 0) {
      entriesLoadingStartedRef.current = true;
      setEntries([]);
      setEntriesLoading(false);
      setEntriesLoadedOnce(true);
    } else if (entriesLoadedOnce || entriesLoading) {
      // Optimistic already loaded or loading — check if follows match
      const cachedFollows = prevFollowsRef.current;
      const followsMatch = follows.length === cachedFollows.length &&
        follows.every((f: string) => cachedFollows.includes(f));
      if (followsMatch) {
        entriesLoadingStartedRef.current = true;
      } else {
        // Follows differ from the optimistic load — reload from the real set.
        loadFollowsTwoTier(follows);
      }
    } else if (initialEntries.length > 0) {
      entriesLoadingStartedRef.current = true;
      setEntriesLoadedOnce(true);
    } else {
      loadFollowsTwoTier(follows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, userLoading, stateLoadedOnce]);

  // Backup fetch for view change
  useEffect(() => {
    if (user && !userLoading && stateLoadedOnce && view === 'all' && initialEntries.length === 0 && !entriesLoading && !entriesLoadedOnce) {
      const follows = state.follows || [];
      if (follows.length === 0) {
        entriesLoadingStartedRef.current = true;
        setEntries([]);
        setEntriesLoading(false);
        setEntriesLoadedOnce(true);
      } else {
        loadFollowsTwoTier(follows);
      }
    }
  }, [user, userLoading, stateLoadedOnce, view, initialEntries.length, entriesLoading, entriesLoadedOnce, state.follows, entriesLoadingStartedRef, loadFollowsTwoTier]);

  // Follows-change reload
  useEffect(() => {
    if (!user || userLoading || view !== 'all') return;
    if (!entriesLoadedOnce && entries.length === 0 && !entriesLoading) return;

    const follows = state.follows || [];
    const prevFollows = prevFollowsRef.current;
    const followsSet = new Set(follows);
    const prevFollowsSet = new Set(prevFollows);
    const followsChanged = follows.length !== prevFollows.length ||
      follows.some(id => !prevFollowsSet.has(id)) ||
      prevFollows.some(id => !followsSet.has(id));

    if (followsChanged) {
      const newlyFollowed = follows.filter(id => !prevFollowsSet.has(id));
      const newlyUnfollowed = prevFollows.filter(id => !followsSet.has(id));
      prevFollowsRef.current = [...follows];

      if (follows.length === 0) {
        setEntries([]);
      } else if (newlyUnfollowed.length > 0 && newlyFollowed.length === 0) {
        setEntries(prevEntries => prevEntries.filter(e => followsSet.has(e.journalId)));
      } else if (newlyFollowed.length > 0) {
        fetch(`/api/articles?with_abstract=1&follows=${newlyFollowed.join(',')}`)
          .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
          .then(newEntries => {
            const arr = Array.isArray(newEntries) ? newEntries : [];
            setEntries(prev => {
              const existing = new Set(prev.map(e => e.id));
              return [...prev, ...arr.filter(e => !existing.has(e.id))];
            });
            if (!entriesLoadedOnce) setEntriesLoadedOnce(true);
          })
          .catch(err => console.error('Failed to load new journal entries:', err));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.follows, user, userLoading, view, entriesLoadedOnce]);

  // Refresh
  const handleRefresh = useCallback(async () => {
    if (!user || !state?.follows || state.follows.length === 0 || isRefreshingRef.current) return;
    isRefreshingRef.current = true;
    try {
      const res = await fetch(`/api/articles?with_abstract=1&follows=${state.follows.join(',')}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const followsSet = new Set(state.follows);
      let newEntries: Entry[] = [];
      if (data && Array.isArray(data.entries)) {
        newEntries = data.entries.filter((e: Entry) => followsSet.has(e.journalId));
      } else if (Array.isArray(data)) {
        newEntries = data.filter((e: Entry) => followsSet.has(e.journalId));
      }
      setEntries(newEntries);
    } catch (err) {
      console.error('Failed to refresh entries:', err);
    } finally {
      isRefreshingRef.current = false;
    }
  }, [user, state?.follows]);

  // Auto-refresh on visibility
  useEffect(() => {
    if (typeof window === 'undefined' || !isMobile) return;
    const handleVisibilityChange = () => {
      if (!document.hidden && user && state?.follows && state.follows.length > 0) {
        handleRefresh().catch(console.error);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isMobile, user, state?.follows, handleRefresh]);

  // Append a just-followed journal's papers as soon as the on-follow fetch has
  // ingested them. The follows-change effect above runs on the optimistic follow,
  // before those rows exist, so it would otherwise miss them until a refresh.
  const appendFollowedJournal = useCallback((journalId: string) => {
    fetch(`/api/articles?with_abstract=1&follows=${encodeURIComponent(journalId)}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => {
        const arr: Entry[] = Array.isArray(data) ? data : (Array.isArray(data?.entries) ? data.entries : []);
        if (arr.length === 0) return;
        setEntries(prev => {
          const existing = new Set(prev.map(e => e.id));
          return [...arr.filter(e => !existing.has(e.id)), ...prev];
        });
        setEntriesLoadedOnce(true);
      })
      .catch(err => console.error('Failed to load followed journal entries:', err));
  }, []);

  return {
    entries, setEntries, entriesLoading, entriesLoadedOnce, setEntriesLoadedOnce, appendFollowedJournal,
  };
}
