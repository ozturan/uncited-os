'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Entry, UserState } from '@/lib/types';

// Discover candidate pool. The per-visit vector search is slow on the free tier,
// so instead of re-running it on every entry/refresh we fetch a large ranked
// pool ONCE and keep it IN MEMORY for the session, then show a random slice.
// Entering Discover or hitting refresh just re-samples the cached pool — instant,
// and different every time. Kept in memory (not localStorage) so it costs zero
// browser storage; it refetches once on a hard reload and refreshes in the
// background when it goes stale, so new papers still rotate in.
const DISCOVER_POOL_LIMIT = 250;     // ranked candidates to cache
const DISCOVER_DISPLAY_COUNT = 100;  // how many to show at once
const DISCOVER_POOL_TTL = 45 * 60 * 1000;

function shuffledSlice(pool: Entry[], n: number): Entry[] {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function fetchDiscoverPool(): Promise<Entry[]> {
  try {
    const res = await fetch(`/api/discover?limit=${DISCOVER_POOL_LIMIT}`);
    const data = res.ok ? await res.json() : { articles: [] };
    return (data.articles as Entry[]) || [];
  } catch { return []; }
}

export function useDiscover(
  user: any,
  userLoading: boolean,
  state: UserState,
  view: string,
) {
  const [discoverEntries, setDiscoverEntries] = useState<Entry[]>([]);
  const discoverPoolRef = useRef<Entry[]>([]);
  const discoverPoolTsRef = useRef(0);
  const [discoverSearch, setDiscoverSearch] = useState('');
  const [discoverSearchResults, setDiscoverSearchResults] = useState<Entry[] | null>(null);
  const [discoverSearchLoading, setDiscoverSearchLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const discoverLoadedRef = useRef(false);

  // Keyword discover
  const [kwDiscoverArticles, setKwDiscoverArticles] = useState<Entry[] | null>(null);
  const [kwDiscoverLoading, setKwDiscoverLoading] = useState(false);
  const [kwDiscoverPoolSize, setKwDiscoverPoolSize] = useState(0);

  // Starred journal entries
  const [starredJournalEntries, setStarredJournalEntries] = useState<Entry[]>([]);
  const starredLoadedRef = useRef(false);

  // Recommendations
  const [recommendations, setRecommendations] = useState<{ all: string[], unread: string[], starred: string[], read: string[] } | null>(null);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
  const [myFieldRecommendations, setMyFieldRecommendations] = useState<string[] | null>(null);
  const [myFieldDiscoverArticles, setMyFieldDiscoverArticles] = useState<Entry[] | null>(null);
  const [myFieldLoading, setMyFieldLoading] = useState(false);

  // Discover — prefetches once the user is signed in so clicking the
  // Discover tab or switching to a similarity-based sort feels instant.
  // Waits ~800ms so first paint of the main feed isn't blocked; uses
  // requestIdleCallback when available so we only prefetch when the
  // main thread is quiet. Short-circuits if the user goes to the
  // Discover tab first — the view-gated branch fires immediately there.
  useEffect(() => {
    if (!user || userLoading) return;
    if (discoverLoadedRef.current) return;

    // If the user landed directly on discover, skip the idle delay.
    const immediate = view === 'discover';
    const schedule = (fn: () => void) => {
      if (immediate) { fn(); return () => {}; }
      const idle = (window as any).requestIdleCallback as
        | ((cb: IdleRequestCallback, opts?: any) => number)
        | undefined;
      if (idle) {
        const h = idle(() => fn(), { timeout: 2500 });
        return () => (window as any).cancelIdleCallback?.(h);
      }
      const t = window.setTimeout(fn, 800);
      return () => window.clearTimeout(t);
    };

    // Instant path: the in-memory pool from this session — sample it now, and
    // only refresh in the background if it has gone stale.
    if (discoverPoolRef.current.length) {
      discoverLoadedRef.current = true;
      setDiscoverEntries(shuffledSlice(discoverPoolRef.current, DISCOVER_DISPLAY_COUNT));
      if (Date.now() - discoverPoolTsRef.current > DISCOVER_POOL_TTL) {
        fetchDiscoverPool().then(items => {
          if (items.length) { discoverPoolRef.current = items; discoverPoolTsRef.current = Date.now(); }
        });
      }
      return;
    }

    const cancel = schedule(() => {
      if (discoverLoadedRef.current) return;
      discoverLoadedRef.current = true;
      if (immediate) setDiscoverLoading(true);
      fetchDiscoverPool()
        .then(items => {
          discoverPoolRef.current = items;
          discoverPoolTsRef.current = Date.now();
          if (items.length) setDiscoverEntries(shuffledSlice(items, DISCOVER_DISPLAY_COUNT));
        })
        .finally(() => { if (immediate) setDiscoverLoading(false); });
    });
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, userLoading, view]);

  // Re-sample the cached pool each time the user opens Discover, so it shows a
  // different slice instantly without re-fetching.
  useEffect(() => {
    if (view !== 'discover') return;
    if (!discoverPoolRef.current.length) return;
    setDiscoverEntries(shuffledSlice(discoverPoolRef.current, DISCOVER_DISPLAY_COUNT));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Reset on sign-out so data re-fetches on next login
  useEffect(() => {
    if (!user && !userLoading) {
      discoverLoadedRef.current = false;
      starredLoadedRef.current = false;
      discoverPoolRef.current = [];
      discoverPoolTsRef.current = 0;
      setDiscoverEntries([]);
      setRecommendations(null);
    }
  }, [user, userLoading, setRecommendations]);

  // Discover search
  useEffect(() => {
    if (!discoverSearch.trim() || discoverSearch.trim().length < 2) {
      setDiscoverSearchResults(null);
      setDiscoverSearchLoading(false);
      return;
    }
    setDiscoverSearchLoading(true);
    const controller = new AbortController();
    fetch(`/api/discover?search=${encodeURIComponent(discoverSearch.trim())}&limit=100`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : { articles: [] })
      .then(data => { setDiscoverSearchResults(data.articles || []); setDiscoverSearchLoading(false); })
      .catch((err) => { if (err.name === 'AbortError') return; setDiscoverSearchResults([]); setDiscoverSearchLoading(false); });
    return () => controller.abort();
  }, [discoverSearch]);

  // Starred articles from unfollowed journals. Only needed when the user
  // actually opens the Starred tab — deferring it off the critical path.
  useEffect(() => {
    if (view !== 'starred') return;
    if (state.starred.length === 0 || starredLoadedRef.current) return;
    starredLoadedRef.current = true;
    fetch('/api/starred-articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starredIds: state.starred, followedJournals: state.follows })
    })
      .then(res => res.ok ? res.json() : [])
      .then(articles => { if (Array.isArray(articles) && articles.length > 0) setStarredJournalEntries(articles); })
      .catch(err => { console.error('Failed to load starred journal entries:', err); starredLoadedRef.current = false; });
  }, [view, state.starred, state.follows]);

  // Refresh discover — instant: draw a new random slice from the cached pool
  // instead of re-running the slow vector search. Only hits the network if the
  // pool is empty (first ever load) or stale (background refresh for next time).
  const handleRefreshDiscover = useCallback(() => {
    const pool = discoverPoolRef.current;
    if (pool.length) {
      setDiscoverEntries(shuffledSlice(pool, DISCOVER_DISPLAY_COUNT));
      // Background-refresh the pool if it's stale, so next time is up to date.
      if (Date.now() - discoverPoolTsRef.current > DISCOVER_POOL_TTL) {
        fetchDiscoverPool().then(items => {
          if (items.length) { discoverPoolRef.current = items; discoverPoolTsRef.current = Date.now(); }
        });
      }
      return Promise.resolve();
    }
    // No pool yet — fetch it once. The button shows an in-flight spinner.
    setDiscoverLoading(true);
    return fetchDiscoverPool()
      .then(items => {
        discoverPoolRef.current = items;
        discoverPoolTsRef.current = Date.now();
        if (items.length) {
          setDiscoverEntries(shuffledSlice(items, DISCOVER_DISPLAY_COUNT));
        } else {
          setDiscoverEntries([]);
        }
        setDiscoverLoading(false);
      })
      .catch(() => setDiscoverLoading(false));
  }, []);

  const handleDiscoverLoading = useCallback(() => {
    if (!discoverLoadedRef.current) setDiscoverLoading(true);
  }, []);

  return {
    discoverEntries, discoverSearch, setDiscoverSearch,
    discoverSearchResults, discoverSearchLoading, discoverLoading,
    kwDiscoverArticles, setKwDiscoverArticles, kwDiscoverLoading, setKwDiscoverLoading,
    kwDiscoverPoolSize, setKwDiscoverPoolSize,
    starredJournalEntries,
    recommendations, setRecommendations,
    recommendationsLoading, setRecommendationsLoading,
    recommendationsError, setRecommendationsError,
    myFieldRecommendations, setMyFieldRecommendations,
    myFieldDiscoverArticles, setMyFieldDiscoverArticles,
    myFieldLoading, setMyFieldLoading,
    handleRefreshDiscover, handleDiscoverLoading,
  };
}
