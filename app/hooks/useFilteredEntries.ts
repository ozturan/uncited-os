'use client';

import { useMemo, useCallback } from 'react';
import { Entry, Catalog, UserSettings, UserState } from '@/lib/types';
import { WEEK_MS, MONTH_MS } from '@/lib/constants';
import { ARTICLE_TYPES } from '../components/TypeFilter';

interface FilterInputs {
  entries: Entry[];
  discoverEntries: Entry[];
  starredJournalEntries: Entry[];
  discoverSearchResults: Entry[] | null;
  kwDiscoverArticles: Entry[] | null;
  myFieldDiscoverArticles: Entry[] | null;
  myFieldRecommendations: string[] | null;
  recommendations: { all: string[], unread: string[], starred: string[], read: string[] } | null;
  state: UserState;
  deferredRead: string[];
  deferredStarred: string[];
  // Canonical-ID mirrors of deferredRead/deferredStarred. Empty array is
  // safe (the matcher falls back to legacy ids).
  deferredReadCanonical?: string[];
  deferredStarredCanonical?: string[];
  deferredSearch: string;
  deferredMainFilter: string;
  deferredSortMode: string;
  deferredDateFilter: string;
  deferredSelectedJournalId: string | null;
  // Immediate values for UI
  mainFilter: string;
  sortMode: string;
  catalog: Catalog | null;
  searchWords: string[];
}

export function useFilteredEntries(inputs: FilterInputs) {
  const {
    entries, discoverEntries, starredJournalEntries,
    discoverSearchResults, kwDiscoverArticles, myFieldDiscoverArticles, myFieldRecommendations,
    recommendations, state, deferredRead, deferredStarred,
    deferredReadCanonical = [], deferredStarredCanonical = [],
    deferredSearch,
    deferredMainFilter, deferredSortMode, deferredDateFilter, deferredSelectedJournalId,
    mainFilter, sortMode, catalog, searchWords,
  } = inputs;

  const matchesTypeFilter = useCallback((entry: Entry) => {
    const selectedTypes = state.settings?.articleTypes;
    if (selectedTypes && selectedTypes.length === 0) return false;
    if (!selectedTypes || selectedTypes.length >= ARTICLE_TYPES.length) return true;
    const entryType = entry.type || 'Research';
    return selectedTypes.includes(entryType);
  }, [state.settings?.articleTypes]);

  const allSourceEntries = useMemo(() => {
    const seen = new Set<string>();
    const result: Entry[] = [];
    for (const e of entries) { if (!seen.has(e.id)) { seen.add(e.id); result.push(e); } }
    for (const e of discoverEntries) { if (!seen.has(e.id)) { seen.add(e.id); result.push(e); } }
    for (const e of starredJournalEntries) { if (!seen.has(e.id)) { seen.add(e.id); result.push(e); } }
    return result;
  }, [entries, discoverEntries, starredJournalEntries]);

  const lowercasedMap = useMemo(() => {
    const map = new Map<string, { titleLower: string; abstractLower: string }>();
    for (const e of allSourceEntries) {
      map.set(e.id, { titleLower: e.title.toLowerCase(), abstractLower: (e.abstract || '').toLowerCase() });
    }
    return map;
  }, [allSourceEntries]);

  // Sets that every filter / count pass needs. Lifted out of the
  // individual useMemos so they only rebuild when the underlying
  // array changes, not on every render that happens to touch
  // filteredEntries. Rebuilding new Set(deferredRead) with 17k
  // entries was costing 200ms+ per keystroke on heavy accounts.
  const followsSet = useMemo(() => new Set(state.follows), [state.follows]);
  const readSet = useMemo(() => new Set(deferredRead), [deferredRead]);
  const starredSet = useMemo(() => new Set(deferredStarred), [deferredStarred]);
  const readSetC = useMemo(() => new Set(deferredReadCanonical), [deferredReadCanonical]);
  const starredSetC = useMemo(() => new Set(deferredStarredCanonical), [deferredStarredCanonical]);
  const isReadFn = useCallback((e: Entry) =>
    readSet.has(e.id) || (e.canonicalId ? readSetC.has(e.canonicalId) : false),
    [readSet, readSetC],
  );
  const isStarredFn = useCallback((e: Entry) =>
    starredSet.has(e.id) || (e.canonicalId ? starredSetC.has(e.canonicalId) : false),
    [starredSet, starredSetC],
  );

  const matchesKeywordFilter = useCallback((entry: Entry): boolean => {
    if (!deferredSortMode.startsWith('kw:')) return true;
    const filterId = deferredSortMode.slice(3);
    const kwFilter = state.settings?.keywordFilters?.find(f => f.id === filterId);
    if (!kwFilter || !kwFilter.keywords.trim()) return true;
    const terms = kwFilter.keywords.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    if (terms.length === 0) return true;
    const isAnd = kwFilter.logic === 'AND';
    const searchTitle = kwFilter.fields === 'title' || kwFilter.fields === 'both';
    const searchAbstract = kwFilter.fields === 'abstract' || kwFilter.fields === 'both';
    const cached = lowercasedMap.get(entry.id);
    const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
    const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
    const matches = (term: string) => {
      if (searchTitle && titleLower.includes(term)) return true;
      if (searchAbstract && abstractLower.includes(term)) return true;
      return false;
    };
    return isAnd ? terms.every(matches) : terms.some(matches);
  }, [deferredSortMode, state.settings?.keywordFilters, lowercasedMap]);

  const filteredEntries = useMemo(() => {
    // Sets + is-predicates come from top-level memos (see above).
    const isRead = isReadFn;
    const isStarred = isStarredFn;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - MONTH_MS);
    const sevenDaysAgo = new Date(now.getTime() - WEEK_MS);

    const discoverCategories = state.settings?.discoverCategories || [];
    let discoverCategoryJournals: Set<string> | null = null;
    if (discoverCategories.length > 0 && catalog) {
      discoverCategoryJournals = new Set<string>();
      for (const categoryId of discoverCategories) {
        const discipline = catalog.disciplines.find(d => (d.id || d.name.toLowerCase().replace(/\s+/g, '-')) === categoryId);
        if (discipline) { for (const j of discipline.journals) discoverCategoryJournals.add(j.id); }
      }
    }

    const searchLower = deferredSearch.toLowerCase();
    const hasSearch = deferredSearch.length > 0;
    const deferredSearchWords = hasSearch ? searchLower.trim().split(/\s+/).filter(w => w.length > 0) : [];

    let sourceEntries: Entry[];
    if (deferredMainFilter === 'discover') {
      if (discoverSearchResults !== null) sourceEntries = discoverSearchResults;
      else if (deferredSortMode.startsWith('kw:') && kwDiscoverArticles !== null) sourceEntries = kwDiscoverArticles;
      else if (deferredSortMode === 'my-field' && myFieldDiscoverArticles !== null) sourceEntries = myFieldDiscoverArticles;
      else sourceEntries = discoverEntries;
    } else if (deferredMainFilter === 'starred' || deferredMainFilter === 'archive') {
      sourceEntries = allSourceEntries;
    } else {
      sourceEntries = entries;
    }

    // When a keyword filter is active in Discover with API-sourced results,
    // the keyword IS the user's selected scope. Trust the API and skip the
    // category narrowing + read/starred filtering — those secondary filters
    // were silently dropping all 19 CRISPR hits to zero even though the
    // dropdown badge promised matches.
    const isKwSourcedDiscover =
      deferredMainFilter === 'discover' &&
      deferredSortMode.startsWith('kw:') &&
      kwDiscoverArticles !== null;

    let filtered = sourceEntries.filter(entry => {
      const entryId = entry.id;
      const journalId = entry.journalId;

      if (deferredMainFilter === 'discover') {
        if (discoverSearchResults !== null) {
          if (isRead(entry) || isStarred(entry)) return false;
        } else if (isKwSourcedDiscover) {
          if (followsSet.has(journalId)) return false;
          if (isStarred(entry)) return false;
        } else {
          if (followsSet.has(journalId)) return false;
          if (discoverCategoryJournals !== null && !discoverCategoryJournals.has(journalId)) return false;
          if (isRead(entry) || isStarred(entry)) return false;
        }
      } else if (deferredMainFilter === 'starred') {
        if (!isStarred(entry)) return false;
        if (deferredSelectedJournalId && journalId !== deferredSelectedJournalId) return false;
      } else if (deferredMainFilter === 'archive') {
        if (!isRead(entry)) return false;
        if (deferredSelectedJournalId && journalId !== deferredSelectedJournalId) return false;
        if (entry.published && new Date(entry.published) < thirtyDaysAgo) return false;
      } else {
        if (!followsSet.has(journalId)) return false;
        if (deferredSelectedJournalId && journalId !== deferredSelectedJournalId) return false;
        if (deferredMainFilter === 'unread') {
          if (isRead(entry) || isStarred(entry)) return false;
          // No 30-day cap: Unread = ALL loaded unread (90-day feed window),
          // paginated 100 at a time, so the list and the "Unread (N)" badge both
          // reflect the user's full unread inventory, not just the last month.
        }
      }

      // The remaining filters (date/type/search/local kw re-match) are skipped
      // for kw-sourced Discover — the API has already scoped the result to
      // the keyword. Re-applying these client-side would silently drop hits.
      if (isKwSourcedDiscover) return true;

      if (deferredDateFilter !== 'all') {
        if (!entry.published) return false;
        const publishedDate = new Date(entry.published);
        if (deferredDateFilter === 'this-week' && publishedDate < sevenDaysAgo) return false;
        if (deferredDateFilter === 'older' && (publishedDate >= sevenDaysAgo || publishedDate < thirtyDaysAgo)) return false;
      }

      if (!matchesTypeFilter(entry)) return false;

      if (hasSearch && deferredSearchWords.length > 0) {
        const cached = lowercasedMap.get(entryId);
        const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
        const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
        if (!deferredSearchWords.every(word => titleLower.includes(word) || abstractLower.includes(word))) return false;
      }

      return true;
    });

    // Keyword filter (skipped when source is kwDiscoverArticles — already
    // matched server-side; local raw-text re-match can disagree on
    // punctuation-stripped title_normalized hits).
    if (deferredSortMode.startsWith('kw:') && !isKwSourcedDiscover) {
      const filterId = deferredSortMode.slice(3);
      const kwFilter = state.settings?.keywordFilters?.find(f => f.id === filterId);
      if (kwFilter && kwFilter.keywords.trim()) {
        const terms = kwFilter.keywords.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
        const isAnd = kwFilter.logic === 'AND';
        const searchTitle = kwFilter.fields === 'title' || kwFilter.fields === 'both';
        const searchAbstract = kwFilter.fields === 'abstract' || kwFilter.fields === 'both';
        filtered = filtered.filter(entry => {
          const cached = lowercasedMap.get(entry.id);
          const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
          const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
          const matches = (term: string) => {
            if (searchTitle && titleLower.includes(term)) return true;
            if (searchAbstract && abstractLower.includes(term)) return true;
            return false;
          };
          return isAnd ? terms.every(matches) : terms.some(matches);
        });
      }
    }

    // Sorting
    const sortedResults = [...filtered];
    if (deferredMainFilter === 'discover') {
      // Keep API order
    } else if (deferredSortMode === 'my-field') {
      const dateMs = new Map<string, number>();
      for (const e of sortedResults) dateMs.set(e.id, e.published ? new Date(e.published).getTime() : 0);
      if (myFieldRecommendations === null) {
        sortedResults.sort((a, b) => (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0));
      } else {
        // myFieldRecommendations is a list of canonical_ids (the route used to
        // ship full paper objects just to extract .id from each one).
        const myFieldSet = new Set(myFieldRecommendations);
        const myFieldIndex = new Map(myFieldRecommendations.map((id, i) => [id, i]));
        const keyOf = (e: { canonicalId?: string; id: string }) => e.canonicalId ?? e.id;
        const hasMatching = myFieldRecommendations.length > 0 && sortedResults.some(a => myFieldSet.has(keyOf(a)));
        if (hasMatching) {
          // Show ALL unread together: ranked papers first (by field-centroid
          // rank), then the rest by date — full unread list stays loaded.
          sortedResults.sort((a, b) => {
            const ak = keyOf(a); const bk = keyOf(b);
            const aHas = myFieldSet.has(ak); const bHas = myFieldSet.has(bk);
            if (aHas && bHas) return (myFieldIndex.get(ak) ?? 0) - (myFieldIndex.get(bk) ?? 0);
            if (aHas) return -1; if (bHas) return 1;
            return (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0);
          });
        } else {
          sortedResults.sort((a, b) => (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0));
        }
      }
    } else if (deferredSortMode === 'for-you') {
      const dateMs = new Map<string, number>();
      for (const e of sortedResults) dateMs.set(e.id, e.published ? new Date(e.published).getTime() : 0);
      if (!recommendations) {
        sortedResults.sort((a, b) => (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0));
      } else {
        let target: string[] = [];
        if (deferredMainFilter === 'unread') target = recommendations.unread || [];
        else if (deferredMainFilter === 'starred') target = recommendations.starred || [];
        else if (deferredMainFilter === 'archive') target = recommendations.read || [];
        // target holds canonical_ids; entries' canonical_id is the join key.
        // (Legacy .id still works as fallback for unmigrated entries.)
        const recSet = new Set(target);
        const recIndex = new Map(target.map((id, i) => [id, i]));
        const keyOf = (e: { canonicalId?: string; id: string }) => e.canonicalId ?? e.id;
        const hasMatching = target.length > 0 && sortedResults.some(a => recSet.has(keyOf(a)));
        if (hasMatching) {
          // Show ALL unread together: ranked papers first (most-similar-first via
          // recIndex, which the API now orders by max-similarity), then the rest
          // of the unread by date. The relevant block sits on top; unranked papers
          // (not close to any star) follow so the full unread list stays loaded.
          sortedResults.sort((a, b) => {
            const ak = keyOf(a); const bk = keyOf(b);
            const aHas = recSet.has(ak); const bHas = recSet.has(bk);
            if (aHas && bHas) return (recIndex.get(ak) ?? 0) - (recIndex.get(bk) ?? 0);
            if (aHas) return -1; if (bHas) return 1;
            return (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0);
          });
        } else {
          sortedResults.sort((a, b) => (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0));
        }
      }
    } else if (deferredSortMode === 'added' && (deferredMainFilter === 'starred' || deferredMainFilter === 'archive')) {
      const timestamps = deferredMainFilter === 'starred' ? state.starredTimestamps : state.readTimestamps;
      const tsMs = new Map<string, number>();
      for (const e of sortedResults) tsMs.set(e.id, timestamps?.[e.id] ? new Date(timestamps[e.id]).getTime() : 0);
      sortedResults.sort((a, b) => (tsMs.get(b.id) ?? 0) - (tsMs.get(a.id) ?? 0));
    } else {
      const dateMs = new Map<string, number>();
      for (const e of sortedResults) dateMs.set(e.id, e.published ? new Date(e.published).getTime() : 0);
      sortedResults.sort((a, b) => (dateMs.get(b.id) ?? 0) - (dateMs.get(a.id) ?? 0));
    }

    return sortedResults;
  }, [entries, allSourceEntries, discoverSearchResults, kwDiscoverArticles, myFieldDiscoverArticles, myFieldRecommendations, state.follows, deferredRead, deferredStarred, deferredReadCanonical, deferredStarredCanonical, state.readTimestamps, state.starredTimestamps, state.settings?.discoverCategories, state.settings?.articleTypes, state.settings?.keywordFilters, deferredSelectedJournalId, deferredMainFilter, deferredSortMode, deferredDateFilter, deferredSearch, matchesTypeFilter, recommendations, lowercasedMap, catalog]);

  // Consolidated counts — share the top-level Sets with filteredEntries.
  const counts = useMemo(() => {
    const isRead = isReadFn;
    const isStarred = isStarredFn;
    const now = Date.now();
    const sevenDaysAgo = now - WEEK_MS;
    const thirtyDaysAgo = now - MONTH_MS;

    let thisWeek = 0, thisMonth = 0, archiveAll = 0, unread = 0, starred = 0, read = 0, discover = 0;

    const matchesSearch = (entry: Entry): boolean => {
      if (searchWords.length === 0) return true;
      const cached = lowercasedMap.get(entry.id);
      const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
      const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
      return searchWords.every(word => titleLower.includes(word) || abstractLower.includes(word));
    };

    const dateCountSource = mainFilter === 'discover' ? discoverEntries
      : (mainFilter === 'starred' || mainFilter === 'archive') ? allSourceEntries
      : entries;

    const passesMainFilter = (entry: Entry): boolean => {
      const eid = entry.id; const jid = entry.journalId;
      if (mainFilter === 'discover') { if (isRead(entry) || isStarred(entry)) return false; }
      else if (mainFilter === 'starred') { if (!isStarred(entry)) return false; if (deferredSelectedJournalId && jid !== deferredSelectedJournalId) return false; }
      else if (mainFilter === 'archive') { if (!isRead(entry)) return false; if (deferredSelectedJournalId && jid !== deferredSelectedJournalId) return false; }
      else { if (!followsSet.has(jid)) return false; if (deferredSelectedJournalId && jid !== deferredSelectedJournalId) return false; if (mainFilter === 'unread') { if (isRead(entry) || isStarred(entry)) return false; } }
      if (!matchesTypeFilter(entry)) return false;
      if (!matchesSearch(entry)) return false;
      if (!matchesKeywordFilter(entry)) return false;
      return true;
    };

    for (const entry of dateCountSource) {
      if (!passesMainFilter(entry)) continue;
      if (!entry.published) continue;
      const pubMs = new Date(entry.published).getTime();
      if (pubMs >= sevenDaysAgo) thisWeek++;
      else if (pubMs >= thirtyDaysAgo) thisMonth++;
    }

    if (mainFilter !== 'archive' && mainFilter !== 'discover') {
      const archiveSource = mainFilter === 'starred' ? allSourceEntries : entries;
      for (const entry of archiveSource) {
        const eid = entry.id; const jid = entry.journalId;
        if (mainFilter !== 'starred' && !followsSet.has(jid)) continue;
        if (deferredSelectedJournalId && jid !== deferredSelectedJournalId) continue;
        if (!matchesTypeFilter(entry)) continue;
        if (!matchesSearch(entry)) continue;
        if (deferredDateFilter !== 'all' && entry.published) {
          const pubMs = new Date(entry.published).getTime();
          if (deferredDateFilter === 'this-week' && pubMs < sevenDaysAgo) continue;
          if (deferredDateFilter === 'older' && (pubMs >= sevenDaysAgo || pubMs < thirtyDaysAgo)) continue;
        }
        if (mainFilter === 'unread') { if (isRead(entry) || isStarred(entry)) continue; }
        else if (mainFilter === 'starred') { if (!isStarred(entry)) continue; }
        archiveAll++;
      }
    }

    for (const e of entries) {
      if (!followsSet.has(e.journalId)) continue;
      if (isRead(e) || isStarred(e)) continue;
      if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) continue;
      if (!matchesTypeFilter(e)) continue;
      if (!matchesSearch(e)) continue;
      if (!matchesKeywordFilter(e)) continue;
      unread++;
    }

    const isKwActive = sortMode.startsWith('kw:');
    if (!deferredSelectedJournalId && !isKwActive) {
      starred = deferredStarred.length;
    } else {
      for (const e of allSourceEntries) {
        if (!isStarred(e)) continue;
        if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) continue;
        if (!matchesKeywordFilter(e)) continue;
        starred++;
      }
    }

    for (const e of entries) {
      if (!followsSet.has(e.journalId)) continue;
      if (!isRead(e)) continue;
      if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) continue;
      if (!matchesTypeFilter(e)) continue;
      if (!matchesKeywordFilter(e)) continue;
      read++;
    }

    for (const e of entries) {
      if (followsSet.has(e.journalId)) continue;
      if (isRead(e) || isStarred(e)) continue;
      discover++;
    }

    return { thisWeekCount: thisWeek, thisMonthCount: thisMonth, archiveAllCount: archiveAll, unreadCount: unread, starredCount: starred, readCount: read, discoverCount: discover };
  }, [entries, discoverEntries, allSourceEntries, state.follows, deferredRead, deferredStarred, deferredReadCanonical, deferredStarredCanonical, deferredSelectedJournalId, mainFilter, sortMode, deferredDateFilter, searchWords, matchesTypeFilter, matchesKeywordFilter, lowercasedMap]);

  // Sidebar per-journal + total unread, filtered the same way FilterBar's
  // unreadCount is (type + search + keyword + 30d + follows + not-read/starred),
  // so the Home badge and the per-journal badges match the "Unread (N)" tab.
  // Differs from FilterBar's unreadCount by NOT applying the selected-journal
  // filter — Sidebar needs per-journal totals across all followed journals.
  const sidebarUnread = useMemo(() => {
    const isRead = isReadFn;
    const isStarred = isStarredFn;

    const matchesSearch = (entry: Entry): boolean => {
      if (searchWords.length === 0) return true;
      const cached = lowercasedMap.get(entry.id);
      const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
      const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
      return searchWords.every(word => titleLower.includes(word) || abstractLower.includes(word));
    };

    const byJournal = new Map<string, number>();
    let total = 0;
    for (const e of entries) {
      if (!followsSet.has(e.journalId)) continue;
      if (isRead(e) || isStarred(e)) continue;
      if (!matchesTypeFilter(e)) continue;
      if (!matchesSearch(e)) continue;
      // Keyword filter intentionally NOT applied — the sidebar shows the
      // true unread inventory per followed journal; layering kw on top
      // turns the per-journal numbers into "matches in this journal" and
      // hides journals that have zero kw matches but plenty of unread.
      byJournal.set(e.journalId, (byJournal.get(e.journalId) || 0) + 1);
      total++;
    }
    return { unreadByJournal: byJournal, totalUnread: total };
  }, [entries, state.follows, deferredRead, deferredStarred, deferredReadCanonical, deferredStarredCanonical, searchWords, matchesTypeFilter, lowercasedMap]);

  // Keyword filter counts
  const keywordFilterCounts = useMemo(() => {
    const kwFilters = state.settings?.keywordFilters;
    if (!kwFilters || kwFilters.length === 0) return new Map<string, number>();
    const isReadKw = isReadFn;
    const isStarredKw = isStarredFn;

    let source: Entry[];
    if (mainFilter === 'discover') source = discoverEntries;
    else source = entries;

    const baseEntries = source.filter(e => {
      if (mainFilter === 'discover') { if (isReadKw(e) || isStarredKw(e)) return false; }
      else if (mainFilter === 'unread') { if (!followsSet.has(e.journalId)) return false; if (isReadKw(e) || isStarredKw(e)) return false; if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) return false; }
      else if (mainFilter === 'starred') { if (!isStarredKw(e)) return false; if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) return false; }
      else if (mainFilter === 'archive') { if (!isReadKw(e)) return false; if (deferredSelectedJournalId && e.journalId !== deferredSelectedJournalId) return false; }
      if (!matchesTypeFilter(e)) return false;
      return true;
    });

    const counts = new Map<string, number>();
    for (const kwFilter of kwFilters) {
      if (!kwFilter.keywords.trim()) { counts.set(kwFilter.id, 0); continue; }
      const terms = kwFilter.keywords.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
      if (terms.length === 0) { counts.set(kwFilter.id, 0); continue; }
      const isAnd = kwFilter.logic === 'AND';
      const searchTitle = kwFilter.fields === 'title' || kwFilter.fields === 'both';
      const searchAbstract = kwFilter.fields === 'abstract' || kwFilter.fields === 'both';
      let count = 0;
      for (const entry of baseEntries) {
        const cached = lowercasedMap.get(entry.id);
        const titleLower = cached?.titleLower ?? entry.title.toLowerCase();
        const abstractLower = cached?.abstractLower ?? (entry.abstract || '').toLowerCase();
        const matches = (term: string) => {
          if (searchTitle && titleLower.includes(term)) return true;
          if (searchAbstract && abstractLower.includes(term)) return true;
          return false;
        };
        if (isAnd ? terms.every(matches) : terms.some(matches)) count++;
      }
      counts.set(kwFilter.id, count);
    }
    return counts;
  }, [entries, discoverEntries, state.settings?.keywordFilters, state.follows, deferredRead, deferredStarred, deferredReadCanonical, deferredStarredCanonical, mainFilter, deferredSelectedJournalId, matchesTypeFilter, lowercasedMap]);

  return {
    filteredEntries, allSourceEntries,
    matchesTypeFilter,
    ...counts,
    ...sidebarUnread,
    keywordFilterCounts,
  };
}
