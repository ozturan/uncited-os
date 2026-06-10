'use client';

import React, { useEffect, useState, useRef, useMemo, useCallback, useDeferredValue } from 'react';
import { Catalog, Entry, UserSettings, UserState } from '@/lib/types';
import type { PrefetchedUser } from '@/lib/serverPrefetch';
import { DEFAULT_DISPLAY_LIMIT, WEEK_MS, MONTH_MS } from '@/lib/constants';
import { saveState } from '@/lib/storage';
import { getOrFetchAffiliation } from '@/lib/affiliation';
import { prefetchEnrich, fetchEnrichSocial, doiForEntry } from '@/lib/paperEnrich';

import FilterBar from './components/FilterBar';
import MainHeader from './components/MainHeader';
import ArticleList from './components/ArticleList';
import ScrollToTopButton from './components/ScrollToTopButton';
import dynamic from 'next/dynamic';

// Lazy load heavy components
const Sidebar = dynamic(() => import('./components/Sidebar'), { ssr: false });
const Settings = dynamic(() => import('./components/Settings'), { ssr: false });
const SettingsDashboard = dynamic(() => import('./components/SettingsDashboard'), { ssr: false });

import 'katex/dist/katex.min.css';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// Custom hooks
import { useAuth } from './hooks/useAuth';
import { useUserState, DEFAULT_SETTINGS } from './hooks/useUserState';
import { useEntries } from './hooks/useEntries';
import { useDiscover } from './hooks/useDiscover';
import { useArticleActions } from './hooks/useArticleActions';
import { useFilteredEntries } from './hooks/useFilteredEntries';
import { useKeyboardNav } from './hooks/useKeyboardNav';

interface HomeProps {
  initialEntries?: Entry[];
  initialUser?: PrefetchedUser | null;
  initialState?: UserState | null;
}

// Warm an image into the browser cache so the <img> paints instantly when its
// card renders (used for institution favicons in the author line). Deduped by
// URL so a shared institution logo is fetched once.
const _preloadedImgs = new Set<string>();
function preloadImage(url: string | null | undefined) {
  if (!url || typeof window === 'undefined' || _preloadedImgs.has(url)) return;
  _preloadedImgs.add(url);
  const img = new window.Image();
  img.src = url;
}

function HomeContent({ initialEntries = [], initialUser = null, initialState = null }: HomeProps) {
  const searchParams = useSearchParams();

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Single-user local mode: useAuth returns the fixed local user synchronously;
  // there is no login, session, or sign-out.
  const { user, userLoading } = useAuth(initialUser);

  // ── User State (follows, read, starred, settings) ─────────────────────────
  // initialState lets useUserState skip the loadState() call on first render.
  // Subsequent SWR refresh on follows-change still runs.
  const {
    state, setState, loading, stateLoadedOnce,
    readSet, starredSet,
    readSetCanonical, starredSetCanonical,
    prevFollowsRef, entriesLoadingStartedRef,
    handleToggleFollowJournal,
    handleSettingsChange, handleUpdateSettings, handleUnfollowAll,
  } = useUserState(user, userLoading, undefined, initialState);

  // ── Catalog ───────────────────────────────────────────────────────────────
  // Loaded in the background; it does NOT gate the dashboard reveal. Catalog only
  // powers the add/follow-journals UI and a few name lookups, all of which guard
  // `catalog === null`, so the feed renders immediately and these fill in (~100-
  // 500ms later) when the dynamic import resolves.
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  useEffect(() => {
    import('@/public/data/catalog-lite.json')
      .then((module) => setCatalog(module.default as Catalog))
      .catch(() => { /* catalog-dependent UI stays inert until reload */ });
  }, []);

  // ── Device detection ──────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  useEffect(() => {
    const checkDevice = () => {
      const width = window.innerWidth;
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      setIsTouchDevice(isTouch);
      setIsMobile(width < 768);
    };
    checkDevice();
    window.addEventListener('resize', checkDevice);
    return () => window.removeEventListener('resize', checkDevice);
  }, []);

  // ── View / Filter / Sort state ────────────────────────────────────────────
  const [view, setView] = useState<'all' | 'discover'>('all');
  const [mainFilter, setMainFilter] = useState<'unread' | 'archive' | 'starred' | 'discover'>('unread');
  const [sortMode, setSortModeState] = useState<string>('date');
  const [dateFilter, setDateFilter] = useState<'all' | 'this-week' | 'older'>('all');
  const [search, setSearch] = useState('');
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_DISPLAY_LIMIT);

  // Journal selection (restore from sessionStorage)
  const getInitialJournalId = () => {
    if (typeof window === 'undefined') return null;
    try { const saved = sessionStorage.getItem('selectedJournalId'); if (saved) { sessionStorage.removeItem('selectedJournalId'); return saved; } } catch (e) {}
    return null;
  };
  const [selectedJournalId, setSelectedJournalId] = useState<string | null>(getInitialJournalId());
  const [selectedDiscipline, setSelectedDiscipline] = useState<string | null>(null);

  // Sort mode persistence
  const setSortMode = useCallback((mode: string) => {
    setSortModeState(mode);
    setState(prev => {
      const newState = { ...prev, settings: { sidebarOrganization: prev.settings?.sidebarOrganization || 'discipline', theme: prev.settings?.theme || 'light', ...prev.settings, sortMode: mode } };
      saveState(newState).catch(console.error);
      return newState;
    });
  }, [setState]);

  useEffect(() => {
    if (state.settings?.sortMode && state.settings.sortMode !== 'for-you' && state.settings.sortMode !== 'my-field') {
      setSortModeState(state.settings.sortMode);
    }
  }, [state.settings?.sortMode]);

  const switchMainFilter = useCallback((newFilter: 'unread' | 'archive' | 'starred' | 'discover') => {
    setMainFilter(newFilter);
    if (newFilter === 'starred' || newFilter === 'archive') setSortModeState('added');
    else if (newFilter === 'discover' && (sortMode === 'date' || sortMode === 'added')) setSortModeState('for-you');
    else if (newFilter === 'unread' && sortMode === 'added') setSortModeState('date');
  }, [sortMode]);

  useEffect(() => {
    if (mainFilter === 'discover' && (sortMode === 'date' || sortMode === 'added')) setSortModeState('for-you');
  }, [mainFilter, sortMode]);

  // ── Deferred values for smooth filtering ──────────────────────────────────
  const deferredSearch = useDeferredValue(search);
  const deferredRead = useDeferredValue(state.read);
  const deferredStarred = useDeferredValue(state.starred);
  // Canonical-ID deferred mirrors — empty array if user hasn't been
  // migrated yet (Phase 3 populates these columns).
  const readCanonicalForHook = useMemo(() => state.readCanonical ?? [], [state.readCanonical]);
  const starredCanonicalForHook = useMemo(() => state.starredCanonical ?? [], [state.starredCanonical]);
  const deferredReadCanonical = useDeferredValue(readCanonicalForHook);
  const deferredStarredCanonical = useDeferredValue(starredCanonicalForHook);
  const deferredMainFilter = useDeferredValue(mainFilter);
  const deferredSortMode = useDeferredValue(sortMode);
  const deferredDateFilter = useDeferredValue(dateFilter);
  const deferredSelectedJournalId = useDeferredValue(selectedJournalId);
  const searchWords = useMemo(() => deferredSearch.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0), [deferredSearch]);

  // Pending indicator
  const isFilterPending = deferredMainFilter !== mainFilter || deferredSortMode !== sortMode || deferredDateFilter !== dateFilter;

  // ── Entries loading ───────────────────────────────────────────────────────
  const { entries, setEntries, entriesLoading, entriesLoadedOnce, setEntriesLoadedOnce, appendFollowedJournal } = useEntries(
    user, userLoading, state, stateLoadedOnce, view, initialEntries, isMobile,
    entriesLoadingStartedRef, prevFollowsRef,
  );

  // ── Discover / Recommendations ────────────────────────────────────────────
  const {
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
  } = useDiscover(user, userLoading, state, view);

  // Keyword discover fetch
  useEffect(() => {
    if (mainFilter !== 'discover' || !sortMode.startsWith('kw:')) {
      setKwDiscoverArticles(null); setKwDiscoverPoolSize(0); return;
    }
    const filterId = sortMode.slice(3);
    const kwFilter = state.settings?.keywordFilters?.find(f => f.id === filterId);
    if (!kwFilter || !kwFilter.keywords.trim()) { setKwDiscoverArticles([]); setKwDiscoverPoolSize(0); return; }
    setKwDiscoverLoading(true);
    const params = new URLSearchParams({ keywords: kwFilter.keywords, keyword_logic: kwFilter.logic || 'OR', keyword_fields: kwFilter.fields || 'both', limit: '100' });
    fetch(`/api/discover?${params.toString()}`)
      .then(res => res.ok ? res.json() : { articles: [], pool_size: 0 })
      .then(data => { setKwDiscoverArticles(data.articles || []); setKwDiscoverPoolSize(data.pool_size || 0); })
      .catch(() => { setKwDiscoverArticles([]); setKwDiscoverPoolSize(0); })
      .finally(() => setKwDiscoverLoading(false));
  }, [mainFilter, sortMode, state.settings?.keywordFilters, setKwDiscoverArticles, setKwDiscoverPoolSize, setKwDiscoverLoading]);

  // Recommendations fetch (lazy)
  const fetchRecommendations = useCallback(async () => {
    if (!user || recommendationsLoading) return;
    if (recommendations !== null) return;
    setRecommendationsLoading(true);
    setRecommendationsError(null);
    try {
      const response = await fetch('/api/recommendations');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      // Response shape: unread/starred/read are arrays of canonical_id strings.
      // (Was objects with full paper metadata — 2MB payload — but only .id was
      // ever used. Ranker matches against entry.canonicalId now, see
      // useFilteredEntries.ts.)
      const pickIds = (v: any): string[] =>
        Array.isArray(v) ? v.map((x: any) => typeof x === 'string' ? x : x?.canonicalId || x?.id).filter(Boolean) : [];
      if (data.unread && Array.isArray(data.unread)) {
        const unreadIds = pickIds(data.unread);
        const starredIds = pickIds(data.starred);
        const readIds = pickIds(data.read);
        setRecommendations({ all: [...starredIds, ...readIds], unread: unreadIds, starred: starredIds, read: readIds });
      } else if (data.message) { setRecommendationsError(data.message); setRecommendations({ all: [], unread: [], starred: [], read: [] }); }
    } catch (error) {
      console.error('Error fetching recommendations:', error);
      setRecommendationsError('Failed to load recommendations');
      setSortModeState('date');
    } finally { setRecommendationsLoading(false); }
  }, [user, recommendations, recommendationsLoading, setRecommendations, setRecommendationsLoading, setRecommendationsError]);

  useEffect(() => {
    if (sortMode === 'for-you' && recommendations === null && !recommendationsLoading) fetchRecommendations();
  }, [sortMode, recommendations, recommendationsLoading, fetchRecommendations]);

  // Background prefetch of /api/recommendations so the "Related" sort
  // is instant when the user clicks it. Gated on user + dashboard
  // settled + not already fetched; scheduled via requestIdleCallback
  // (falls back to 1.5s timeout) so it never competes with first paint.
  useEffect(() => {
    if (!user || !stateLoadedOnce || recommendations !== null || recommendationsLoading) return;
    if (sortMode === 'for-you') return; // synchronous path already handles it
    const idle = (window as any).requestIdleCallback as
      | ((cb: IdleRequestCallback, opts?: any) => number)
      | undefined;
    const cancelIdle = (window as any).cancelIdleCallback as ((h: number) => void) | undefined;
    if (idle) {
      const h = idle(() => { fetchRecommendations(); }, { timeout: 3000 });
      return () => cancelIdle?.(h);
    }
    const t = window.setTimeout(() => { fetchRecommendations(); }, 1500);
    return () => window.clearTimeout(t);
  }, [user, stateLoadedOnce, recommendations, recommendationsLoading, sortMode, fetchRecommendations]);

  // My Field
  useEffect(() => { setMyFieldRecommendations(null); setMyFieldDiscoverArticles(null); }, [state.settings?.field_centroid_updated_at, setMyFieldRecommendations, setMyFieldDiscoverArticles]);

  useEffect(() => {
    if (sortMode !== 'my-field' || !user) return;
    if (!state.settings?.field_centroid || state.settings.field_centroid.length !== 256) { setSortModeState('for-you'); return; }
    // Only load the My Field data for the view the user is actually on. Loading both
    // at once runs two heavy pgvector RPCs in parallel that contend on the DB and make
    // both slow; the other view loads when switched to.
    const inDiscover = mainFilter === 'discover';
    const needRecs = !inDiscover && myFieldRecommendations === null;
    const needDisc = inDiscover && myFieldDiscoverArticles === null;
    if (!needRecs && !needDisc) return;

    // Cancel the in-flight RPC if the user switches sort/view mid-load, so a stale
    // result can't overwrite the new view and we never leave a duplicate running.
    const ctrl = new AbortController();
    setMyFieldLoading(true);
    const url = inDiscover ? '/api/discover?mode=my-field&limit=100' : '/api/recommendations?mode=my-field';
    fetch(url, { signal: ctrl.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (ctrl.signal.aborted) return;
        if (inDiscover) {
          setMyFieldDiscoverArticles(data?.articles || []);
        } else if (data?.unread && Array.isArray(data.unread)) {
          setMyFieldRecommendations(data.unread.map((x: any) => typeof x === 'string' ? x : x?.canonicalId || x?.id).filter(Boolean));
        } else {
          setMyFieldRecommendations([]);
        }
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        if (inDiscover) setMyFieldDiscoverArticles([]); else setMyFieldRecommendations([]);
      })
      .finally(() => { if (!ctrl.signal.aborted) setMyFieldLoading(false); });

    // Clear loading here too (not only in the gated .finally): if the user switches
    // sort AWAY from my-field mid-load, the fetch is aborted and no replacement starts,
    // so the gated .finally (skipped because aborted) would otherwise leave
    // myFieldLoading stuck true. When a replacement fetch DOES start in the same effect
    // run, its setMyFieldLoading(true) batches after this cleanup and wins — no flicker.
    return () => { ctrl.abort(); setMyFieldLoading(false); };
  }, [sortMode, user, myFieldRecommendations, myFieldDiscoverArticles, mainFilter, state.settings?.field_centroid?.length, setSortModeState, setMyFieldLoading, setMyFieldRecommendations, setMyFieldDiscoverArticles]);

  // ── Filtered entries ──────────────────────────────────────────────────────
  const {
    filteredEntries, allSourceEntries, matchesTypeFilter,
    thisWeekCount, thisMonthCount, archiveAllCount, unreadCount, starredCount, readCount, discoverCount,
    unreadByJournal, totalUnread,
    keywordFilterCounts,
  } = useFilteredEntries({
    entries, discoverEntries, starredJournalEntries,
    discoverSearchResults, kwDiscoverArticles, myFieldDiscoverArticles, myFieldRecommendations,
    recommendations, state, deferredRead, deferredStarred,
    deferredReadCanonical, deferredStarredCanonical,
    deferredSearch,
    deferredMainFilter, deferredSortMode, deferredDateFilter, deferredSelectedJournalId,
    mainFilter, sortMode, catalog, searchWords,
  });

  const paginatedEntries = useMemo(() => filteredEntries.slice(0, displayLimit), [filteredEntries, displayLimit]);
  const hasMoreEntries = filteredEntries.length > displayLimit;

  // ── First-viewport prewarm ────────────────────────────────────────────────
  // On the initial main-feed paint, resolve affiliation + enrich for the first
  // screenful of cards BEFORE the list is revealed, so it appears fully
  // assembled instead of each card popping its author line / PDF button in as it
  // scrolls into view. Latches once; later filter/sort changes use the normal
  // (fast, client-side) path and the existing per-visible-card lazy resolution.
  const FIRST_VIEWPORT_PREWARM = 8;
  const FIRST_VIEWPORT_TIMEOUT_MS = 2500;
  const [firstViewportReady, setFirstViewportReady] = useState(false);
  const prewarmStartedRef = useRef(false);
  useEffect(() => {
    if (prewarmStartedRef.current) return;
    // Discover has its own loading states and is user-navigated, not first paint.
    if (mainFilter === 'discover') { prewarmStartedRef.current = true; setFirstViewportReady(true); return; }
    const first = filteredEntries.slice(0, FIRST_VIEWPORT_PREWARM);
    if (first.length === 0) {
      // Empty feed (e.g. no follows yet): reveal the empty state once load settles.
      if (!entriesLoading) { prewarmStartedRef.current = true; setFirstViewportReady(true); }
      return;
    }
    prewarmStartedRef.current = true;
    // Never trap the user: reveal after a hard cap even if a resolver is slow.
    const cap = setTimeout(() => setFirstViewportReady(true), FIRST_VIEWPORT_TIMEOUT_MS);
    Promise.allSettled(first.map((e) => {
      const did = doiForEntry(e);
      return Promise.allSettled([
        getOrFetchAffiliation({
          canonicalId: e.canonicalId,
          doi: e.doi,
          arxivId: e.arxivId,
          title: e.title,
          parentAuthorsRaw: e.authors || null,
          parentPublished: e.published || null,
        }).then((aff) => { preloadImage(aff?.institutionLogo); return aff; }),
        // social=1 returns OA + topics + author socials in one call, so the
        // first screen's ORCID/Scholar icons are warm before reveal too.
        did ? fetchEnrichSocial(did) : Promise.resolve(null),
      ]);
    })).then(() => { clearTimeout(cap); setFirstViewportReady(true); });
    return () => clearTimeout(cap);
  }, [mainFilter, filteredEntries, entriesLoading]);

  // ── Background warm of the rest of the list ───────────────────────────────
  // After the first viewport is revealed, warm affiliation + enrich for a deep
  // buffer of the current list in idle time, so cards are already resolved when
  // scrolled to (not lazy) instead of each one loading on arrival. Both resolvers
  // are concurrency-capped and skip anything already cached (incl. the persisted
  // localStorage cache), so warmed papers are never refetched on later visits.
  // Capped at BACKGROUND_WARM to bound first-session cost; beyond it the existing
  // per-visible-card lazy resolution still fills cards in on scroll.
  const BACKGROUND_WARM = 300;
  useEffect(() => {
    if (!firstViewportReady) return;
    // Cost/data-aware: on a metered or slow connection, skip the eager buffer
    // warm and fall back to the existing per-visible-card lazy resolution.
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;
    const list = filteredEntries.slice(0, BACKGROUND_WARM);
    if (list.length === 0) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      prefetchEnrich(list, { social: true }); // OA + topics + socials; queue-capped (10), skips cached/persisted
      for (const e of list) {
        getOrFetchAffiliation({
          canonicalId: e.canonicalId,
          doi: e.doi,
          arxivId: e.arxivId,
          title: e.title,
          parentAuthorsRaw: e.authors || null,
          parentPublished: e.published || null,
        }).then((aff) => { preloadImage(aff?.institutionLogo); })
          .catch(() => { /* cached-miss/network — the lazy path retries on scroll */ });
      }
    };
    const idle = (window as any).requestIdleCallback as
      | ((cb: IdleRequestCallback, opts?: any) => number)
      | undefined;
    const cancelIdle = (window as any).cancelIdleCallback as ((h: number) => void) | undefined;
    if (idle) {
      const h = idle(run, { timeout: 2500 });
      return () => { cancelled = true; cancelIdle?.(h); };
    }
    const t = window.setTimeout(run, 1200);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [firstViewportReady, filteredEntries]);

  // For the active kw filter in Discover, the badge must equal the count
  // the user will actually see after every client-side filter (reads, types,
  // date, etc.) — otherwise "(19)" in the dropdown can still resolve to an
  // empty list. filteredEntries IS that post-filter result.
  const effectiveKeywordFilterCounts = useMemo(() => {
    if (mainFilter !== 'discover' || !sortMode.startsWith('kw:') || !kwDiscoverArticles) {
      return keywordFilterCounts;
    }
    const next = new Map(keywordFilterCounts);
    next.set(sortMode.slice(3), filteredEntries.length);
    return next;
  }, [keywordFilterCounts, mainFilter, sortMode, kwDiscoverArticles, filteredEntries.length]);

  // ── Article actions ───────────────────────────────────────────────────────
  const {
    handleToggleStarOptimized, handleToggleReadOptimized,
    handleSwipeRightStable, handleSwipeLeftStable,
    handleArchiveAll: archiveAllAction,
  } = useArticleActions(state, setState);

  // Ref-based: `filteredEntries` and `mainFilter` update constantly but
  // the FilterBar's `handleArchiveAll` callback identity must stay stable
  // so memo() actually skips renders when these change. Previously this
  // useCallback rebuilt on every keystroke (filteredEntries depends on
  // deferredSearch), making FilterBar re-render on every keystroke.
  const filteredEntriesRef = useRef(filteredEntries);
  const mainFilterRef = useRef(mainFilter);
  filteredEntriesRef.current = filteredEntries;
  mainFilterRef.current = mainFilter;
  const [archiveAllSaving, setArchiveAllSaving] = useState(false);
  const handleArchiveAll = useCallback(async () => {
    setArchiveAllSaving(true);
    try {
      await archiveAllAction(mainFilterRef.current, filteredEntriesRef.current);
    } finally {
      setArchiveAllSaving(false);
    }
  }, [archiveAllAction]);

  // Guard against refresh while bulk save is in flight — without this the
  // user sees count → 0 → click refresh → count back to N because the
  // POST was aborted mid-write.
  useEffect(() => {
    if (!archiveAllSaving) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [archiveAllSaving]);

  const handleJournalClickStable = useCallback((journalId: string) => {
    setSelectedJournalId(journalId);
  }, []);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const { selectedIndex, setSelectedIndex } = useKeyboardNav(
    filteredEntries, state, setState, displayLimit, setDisplayLimit,
  );

  // Reset display limit on filter change
  useEffect(() => {
    setDisplayLimit(DEFAULT_DISPLAY_LIMIT);
    setSelectedIndex(0);
  }, [mainFilter, dateFilter, selectedJournalId, deferredSearch, setSelectedIndex]);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showSettingsDashboard, setShowSettingsDashboard] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainerEl(node);
  }, []);
  const scrollCleanupRef = useRef<(() => void) | null>(null);

  // Swipe-to-open sidebar refs
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const isSwipingRef = useRef(false);

  // ── Dashboard readiness ───────────────────────────────────────────────────
  // The full-screen loading gate intentionally does NOT wait on the article
  // feed OR the catalog import: as soon as auth + user state are ready we render
  // the app shell (sidebar, header, theme) and let the feed area show a skeleton
  // while /api/articles loads. Gating on entries used to hold the spinner through
  // the whole state→articles waterfall (up to 5000 papers); gating on the catalog
  // held it on a dynamic JSON import the feed doesn't need.
  const isDashboardReady = user && stateLoadedOnce && !loading;
  const [dashboardReadyState, setDashboardReadyState] = useState(false);
  const [componentsLoaded, setComponentsLoaded] = useState(false);

  useEffect(() => {
    if (user && !userLoading && !componentsLoaded) {
      Promise.all([import('./components/Sidebar'), import('./components/Settings')])
        .then(() => setComponentsLoaded(true))
        .catch(() => setComponentsLoaded(true));
    } else if (!user && !userLoading) setComponentsLoaded(false);
  }, [user, userLoading, componentsLoaded]);

  // Theme application
  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (isDashboardReady && !dashboardReadyState) {
        const theme = state.settings?.theme || 'light';
        document.documentElement.setAttribute('data-theme', theme);
        (document.body as any).style.backgroundColor = '';
        (document.body as any).style.color = '';
        setDashboardReadyState(true);
      } else if (!isDashboardReady) {
        if (!user && !userLoading) {
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          try {
            const stored = window.localStorage.getItem('uncited_state');
            if (stored) { const parsed = JSON.parse(stored); document.documentElement.setAttribute('data-theme', parsed.settings?.theme || 'light'); }
            else document.documentElement.setAttribute('data-theme', 'light');
          } catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
        }
        (document.body as any).style.backgroundColor = '';
        (document.body as any).style.color = '';
        setDashboardReadyState(false);
      }
    }
  }, [isDashboardReady, state.settings?.theme, dashboardReadyState, user?.id, userLoading]);

  // Offline detection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setIsOffline(!navigator.onLine);
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => { window.removeEventListener('offline', handleOffline); window.removeEventListener('online', handleOnline); };
  }, []);

  // Scroll-to-top
  useEffect(() => {
    if (!user || !isDashboardReady) return;
    if (scrollCleanupRef.current) { scrollCleanupRef.current(); scrollCleanupRef.current = null; }
    const timeoutId = setTimeout(() => {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      const handleScroll = () => setShowScrollToTop(scrollContainer.scrollTop > 200);
      handleScroll();
      scrollContainer.addEventListener('scroll', handleScroll);
      const handleResize = () => handleScroll();
      window.addEventListener('resize', handleResize);
      scrollCleanupRef.current = () => { scrollContainer.removeEventListener('scroll', handleScroll); window.removeEventListener('resize', handleResize); };
    }, 100);
    return () => { clearTimeout(timeoutId); if (scrollCleanupRef.current) { scrollCleanupRef.current(); scrollCleanupRef.current = null; } };
  }, [user, isDashboardReady]);

  const scrollToTop = () => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  // Swipe-to-open sidebar
  useEffect(() => {
    if (!isMobile) return;
    const handleTouchStart = (e: TouchEvent) => { const t = e.touches[0]; swipeStartX.current = t.clientX; swipeStartY.current = t.clientY; isSwipingRef.current = t.clientX < 50; };
    const handleTouchMove = (e: TouchEvent) => { if (!isSwipingRef.current) return; const t = e.touches[0]; const dx = t.clientX - swipeStartX.current; const dy = Math.abs(t.clientY - swipeStartY.current); if (dx > 30 && dx > dy) { setSidebarOpen(true); isSwipingRef.current = false; } };
    const handleTouchEnd = () => { isSwipingRef.current = false; };
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => { document.removeEventListener('touchstart', handleTouchStart); document.removeEventListener('touchmove', handleTouchMove); document.removeEventListener('touchend', handleTouchEnd); };
  }, [isMobile]);

  // ── Stable handlers ───────────────────────────────────────────────────────
  const handleJournalSelect = useCallback((journalId: string | null) => {
    setSelectedJournalId(journalId);
    if (mainFilter === 'discover') switchMainFilter('unread');
    setView('all');
    if (isMobile) setSidebarOpen(false);
    setShowSettingsDashboard(false);
  }, [mainFilter, switchMainFilter, isMobile]);

  const handleMobileClose = useCallback(() => setSidebarOpen(false), []);
  const handleShowSettings = useCallback(() => setShowSettingsDashboard(true), []);
  const handleCloseSettings = useCallback(() => setShowSettingsDashboard(false), []);
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), []);
  const handleCloseSettingsDashboard = useCallback(() => setShowSettingsDashboard(false), []);

  const filterBarVariant = useMemo<'mobile' | 'desktop'>(() => {
    return isMobile ? 'mobile' : 'desktop';
  }, [isMobile]);

  // ── Early returns ─────────────────────────────────────────────────────────
  if (userLoading) return null;

  if (user && (!isDashboardReady || !dashboardReadyState || !componentsLoaded)) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-ink)', zIndex: 9999 }}>
        <div className="text-center">
          <div className="mb-4"><div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--color-accent)' }}></div></div>
          <p className="text-lg" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>Loading...</p>
        </div>
      </div>
    );
  }

  // ── Render dashboard ──────────────────────────────────────────────────────
  return (
    <>
      {/* Offline banner */}
      {isOffline && (
        <div role="status" aria-live="polite" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10001, backgroundColor: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)' }}>
          <span style={{ fontSize: '13px', color: 'var(--color-ink-soft)', fontWeight: 500 }}>You&rsquo;re offline &mdash; showing cached content.</span>
          <button onClick={() => setIsOffline(false)} aria-label="Dismiss offline notice" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: 'var(--color-ink-soft)', fontSize: '16px', lineHeight: 1, flexShrink: 0 }}>&times;</button>
        </div>
      )}

      <div className="app-dashboard flex h-screen overflow-hidden">
        <Sidebar
          catalog={catalog}
          state={state}
          entries={entries}
          onStateChange={setState}
          onJournalFetched={appendFollowedJournal}
          onJournalSelect={handleJournalSelect}
          selectedJournalId={selectedJournalId}
          isMobileOpen={sidebarOpen}
          onMobileClose={handleMobileClose}
          user={user}
          onShowSettings={handleShowSettings}
          onCloseSettings={handleCloseSettings}
          isMobile={isMobile}

          currentView={view}
          onViewChange={setView}
          showSettingsDashboard={showSettingsDashboard}
          mainFilter={mainFilter}
          onMainFilterChange={switchMainFilter}
          onDiscoverLoading={handleDiscoverLoading}
          readSet={readSet}
          starredSet={starredSet}
          readSetCanonical={readSetCanonical}
          starredSetCanonical={starredSetCanonical}
          unreadByJournal={unreadByJournal}
          totalUnread={totalUnread}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          <MainHeader
            showSettingsDashboard={showSettingsDashboard}
            setShowSettingsDashboard={setShowSettingsDashboard}
            view={view}
            selectedJournalId={selectedJournalId}
            follows={state.follows}
            user={user}
            catalog={catalog}
            mainFilter={mainFilter}
            discoverSearch={discoverSearch}
            discoverSearchLoading={discoverSearchLoading}
            discoverSearchResults={discoverSearchResults}
            onToggleFollowJournal={handleToggleFollowJournal}
            onOpenSidebar={handleOpenSidebar}
          />

          <div ref={scrollContainerCallbackRef} className="flex-1 overflow-y-auto" style={{ overscrollBehaviorY: 'contain' }}>
            {showSettingsDashboard ? (
              <SettingsDashboard
                user={user}
                settings={state.settings || DEFAULT_SETTINGS}
                followsCount={state.follows.length}
                onSettingsChange={handleSettingsChange}
                onUnfollowAll={handleUnfollowAll}
                onClose={handleCloseSettingsDashboard}
              />
            ) : (
              <div className="max-w-7xl mx-auto py-4 md:py-0">
                <FilterBar
                  variant={filterBarVariant}
                  mainFilter={mainFilter}
                  sortMode={sortMode}
                  setSortMode={setSortMode}
                  dateFilter={dateFilter}
                  setDateFilter={setDateFilter}
                  search={search}
                  setSearch={setSearch}
                  discoverSearch={discoverSearch}
                  setDiscoverSearch={setDiscoverSearch}
                  settings={state.settings}
                  unreadCount={unreadCount}
                  countsReady={entriesLoadedOnce}
                  starredCount={starredCount}
                  readCount={readCount}
                  thisWeekCount={thisWeekCount}
                  thisMonthCount={thisMonthCount}
                  archiveAllCount={archiveAllCount || 0}
                  selectedJournalId={selectedJournalId}
                  catalog={catalog}
                  recommendationsLoading={recommendationsLoading || myFieldLoading}
                  myFieldRecommendations={myFieldRecommendations}
                  switchMainFilter={switchMainFilter}
                  handleArchiveAll={handleArchiveAll}
                  archiveAllSaving={archiveAllSaving}
                  onUpdateSettings={handleUpdateSettings}
                  onRefreshDiscover={handleRefreshDiscover}
                  filteredCount={filteredEntries.length}
                  keywordFilterCounts={effectiveKeywordFilterCounts}
                />

                <ArticleList
                  filteredEntries={filteredEntries}
                  paginatedEntries={paginatedEntries}
                  hasMoreEntries={hasMoreEntries}
                  displayLimit={displayLimit}
                  setDisplayLimit={setDisplayLimit}
                  mainFilter={mainFilter}
                  sortMode={sortMode}
                  search={search}
                  entriesLoading={entriesLoading}
                  discoverLoading={discoverLoading || kwDiscoverLoading}
                  discoverSearchLoading={discoverSearchLoading}
                  isDiscoverSearchActive={!!discoverSearch.trim()}
                  recommendationsLoading={recommendationsLoading}
                  firstViewportReady={firstViewportReady}
                  user={user}
                  stateLoadedOnce={stateLoadedOnce}
                  loading={loading}
                  followsCount={state.follows.length}
                  onOpenSidebar={handleOpenSidebar}
                  starredCount={state.starred.length}
                  settings={state.settings}
                  lastVisit={state.lastVisit}
                  readSet={readSet}
                  starredSet={starredSet}
                  readSetCanonical={readSetCanonical}
                  starredSetCanonical={starredSetCanonical}
                  selectedIndex={selectedIndex}
                  isActualMobile={isMobile}
                  catalog={catalog}
                  discoverTotalCount={mainFilter === 'discover' && sortMode.startsWith('kw:') && kwDiscoverPoolSize > 0 ? kwDiscoverPoolSize : discoverEntries.length}
                  switchMainFilter={switchMainFilter}
                  onSwipeRight={handleSwipeRightStable}
                  onSwipeLeft={handleSwipeLeftStable}
                  onToggleStar={handleToggleStarOptimized}
                  onToggleRead={handleToggleReadOptimized}
                  onJournalClick={handleJournalClickStable}
                  scrollContainerRef={scrollContainerRef}
                  scrollContainerEl={scrollContainerEl}
                />
              </div>
            )}
          </div>

          {showScrollToTop && (
            <ScrollToTopButton isMobile={isMobile} onClick={scrollToTop} />
          )}
        </main>
      </div>
    </>
  );
}

export default function Home({ initialEntries = [], initialUser = null, initialState = null }: HomeProps) {
  return (
    <Suspense fallback={null}>
      <HomeContent
        initialEntries={initialEntries}
        initialUser={initialUser}
        initialState={initialState}
      />
    </Suspense>
  );
}
