'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import Link from 'next/link';
import { Catalog, UserState, Entry, UserSettings, Journal } from '@/lib/types';
import { unfollowJournal, followJournal, saveState } from '@/lib/storage';
import { getJournalLogo as getJournalLogoUtil } from '@/lib/paperUtils';
import Wordmark from './Wordmark';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCompass, faHome } from '@fortawesome/free-solid-svg-icons';

interface SidebarProps {
  catalog: Catalog | null;
  state: UserState;
  entries: Entry[];
  onStateChange: (state: UserState) => void;
  onJournalSelect: (journalId: string | null) => void;
  selectedJournalId: string | null;
}

interface GroupedJournals {
  id: string;
  name: string;
  journals: Journal[];
}

interface SidebarPropsWithMobile extends SidebarProps {
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
  onJournalFetched?: (journalId: string) => void;
  user?: any;
  onShowSettings?: () => void;
  onCloseSettings?: () => void;
  isMobile?: boolean;
  currentView?: 'all' | 'discover';
  onViewChange?: (view: 'all' | 'discover') => void;
  showSettingsDashboard?: boolean;
  mainFilter?: 'unread' | 'archive' | 'starred' | 'discover';
  onMainFilterChange?: (filter: 'unread' | 'archive' | 'starred' | 'discover') => void;
  onDiscoverLoading?: () => void;
  readSet?: Set<string>;
  starredSet?: Set<string>;
  readSetCanonical?: Set<string>;
  starredSetCanonical?: Set<string>;
  // Provided by useFilteredEntries so badges use the same filter set as
  // the FilterBar "Unread (N)" tab. Falls back to a self-computed count
  // if missing.
  unreadByJournal?: Map<string, number>;
  totalUnread?: number;
}

const Sidebar = memo(function Sidebar({
  catalog,
  state,
  entries,
  onStateChange,
  onJournalSelect,
  selectedJournalId,
  isMobileOpen = false,
  onMobileClose,
  onJournalFetched,
  user,
  onShowSettings,
  onCloseSettings,
  isMobile = false,
  currentView = 'all',
  showSettingsDashboard = false,
  onViewChange,
  mainFilter,
  onMainFilterChange,
  onDiscoverLoading,
  readSet: readSetProp,
  starredSet: starredSetProp,
  readSetCanonical: readSetCanonicalProp,
  starredSetCanonical: starredSetCanonicalProp,
  unreadByJournal: unreadByJournalProp,
  totalUnread: totalUnreadProp,
}: SidebarPropsWithMobile) {
  const isPopularPage = false;
  // Use pre-computed Sets from parent (avoids recreating on every render)
  const readSet = useMemo(() => readSetProp ?? new Set(state.read), [readSetProp, state.read]);
  const starredSet = useMemo(() => starredSetProp ?? new Set(state.starred), [starredSetProp, state.starred]);
  const readSetC = useMemo(
    () => readSetCanonicalProp ?? new Set(state.readCanonical ?? []),
    [readSetCanonicalProp, state.readCanonical]
  );
  const starredSetC = useMemo(
    () => starredSetCanonicalProp ?? new Set(state.starredCanonical ?? []),
    [starredSetCanonicalProp, state.starredCanonical]
  );
  // Canonical-aware matchers for in-sidebar counts.
  const isRead = useCallback((e: Entry) =>
    readSet.has(e.id) || (e.canonicalId ? readSetC.has(e.canonicalId) : false),
    [readSet, readSetC]);
  const isStarred = useCallback((e: Entry) =>
    starredSet.has(e.id) || (e.canonicalId ? starredSetC.has(e.canonicalId) : false),
    [starredSet, starredSetC]);
  const followsSet = useMemo(() => new Set(state.follows), [state.follows]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const countsFetchedRef = useRef(false);
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'impact' | 'recent'>('name');
  const [allJournalArticleCounts, setAllJournalArticleCounts] = useState<Map<string, number>>(new Map());
  const [articleCountsLoading, setArticleCountsLoading] = useState(false);
  const [fetchingJournals, setFetchingJournals] = useState<Set<string>>(new Set());
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Get default settings if not present
  const settings: UserSettings = state.settings || { sidebarOrganization: 'discipline', theme: 'light', showThumbnails: true };

  // Clean up invalid journal IDs from state when catalog is loaded
  // Use a ref to track if cleanup has been done to avoid infinite loops
  const cleanupDoneRef = useRef(false);
  useEffect(() => {
    // Only run cleanup once when catalog first loads, not on every state change
    // This prevents interfering with user actions like unfollowing
    if (!catalog || state.follows.length === 0 || cleanupDoneRef.current) return;

    // Get all valid journal IDs from catalog
    const validJournalIds = new Set(
      catalog.disciplines.flatMap(d => d.journals.map(j => j.id))
    );

    // Find invalid journal IDs (in state but not in catalog)
    const invalidJournalIds = state.follows.filter(id => !validJournalIds.has(id));

    // If there are invalid IDs, clean them up (but only once)
    if (invalidJournalIds.length > 0) {
      const cleanedFollows = state.follows.filter(id => validJournalIds.has(id));
      const newState = { ...state, follows: cleanedFollows };
      onStateChange(newState);
      // Save cleaned state to Supabase
      saveState(newState).catch(console.error);
    }
    // Mark as done after first run
    cleanupDoneRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]); // Only run when catalog loads, not on state changes

  // Extract real journal logo using shared utility (handles PLOS, Cell Press, etc.)
  const getJournalLogo = (journal: Journal): string => {
    // Use shared utility function for consistent handling
    // Use RSS URL as article link since we don't have a specific article
    return getJournalLogoUtil(journal.logo, journal.name, journal.rss);
  };

  // Clean journal name by removing leading/trailing quotes
  const cleanJournalName = (name: string): string => {
    if (!name) return name;
    return name.replace(/^["']+|["']+$/g, '').trim();
  };

  // Get all followed journals — memoized so it doesn't recompute on every render
  const followedJournals = useMemo(
    () => catalog?.disciplines.flatMap(d => d.journals).filter(j => followsSet.has(j.id)) || [],
    [catalog, followsSet]
  );

  // Group followed journals by current organization mode
  const getGroupedJournals = (): GroupedJournals[] => {
    if (settings.sidebarOrganization === 'publisher') {
      // Group by publisher
      const byPublisher = new Map<string, Journal[]>();
      followedJournals.forEach(journal => {
        const publisher = journal.publisher || 'Unknown Publisher';
        if (!byPublisher.has(publisher)) {
          byPublisher.set(publisher, []);
        }
        byPublisher.get(publisher)!.push(journal);
      });

      return Array.from(byPublisher.entries())
        .map(([publisher, journals]) => ({
          id: publisher.toLowerCase().replace(/\s+/g, '-'),
          name: publisher,
          journals: journals.sort((a, b) => a.name.localeCompare(b.name))
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else if (settings.sidebarOrganization === 'recent') {
      // Sort by most recent article date, unread journals first
      const journalWithDates = followedJournals.map(journal => {
        // Find articles for this journal
        const journalEntries = entries.filter(e => e.journalId === journal.id);

        // Filter to only unread articles (not read and not starred)
        const unreadEntries = journalEntries.filter(e =>
          !isRead(e) && !isStarred(e)
        );

        // Get most recent unread article date, or most recent article date if all read
        const mostRecentUnreadDate = unreadEntries.length > 0
          ? Math.max(...unreadEntries.map(e => new Date(e.published || 0).getTime()))
          : 0;

        const mostRecentAnyDate = journalEntries.length > 0
          ? Math.max(...journalEntries.map(e => new Date(e.published || 0).getTime()))
          : 0;

        return {
          journal,
          mostRecentUnreadDate,
          mostRecentAnyDate,
          hasUnread: unreadEntries.length > 0
        };
      });

      // Sort: unread journals first (by most recent unread), then read journals (by most recent any)
      const sortedJournals = journalWithDates
        .sort((a, b) => {
          // If one has unread and the other doesn't, prioritize the one with unread
          if (a.hasUnread && !b.hasUnread) return -1;
          if (!a.hasUnread && b.hasUnread) return 1;

          // Both have unread or both don't - sort by appropriate date
          if (a.hasUnread && b.hasUnread) {
            return b.mostRecentUnreadDate - a.mostRecentUnreadDate;
          } else {
            return b.mostRecentAnyDate - a.mostRecentAnyDate;
          }
        })
        .map(item => item.journal);

      return [{
        id: 'recently-updated',
        name: 'Recently Updated',
        journals: sortedJournals
      }];
    } else {
      // Group by discipline (default)
      if (!catalog) return [];
      return catalog.disciplines
        .map(discipline => ({
          ...discipline,
          id: discipline.id || discipline.name,
          journals: discipline.journals.filter(j => followsSet.has(j.id))
        }))
        .filter(d => d.journals.length > 0);
    }
  };

  // Memoize grouped journals — getGroupedJournals() is O(journals × entries) in 'recent' mode
  // so recomputing it on every keystroke in the journal search caused visible lag.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allGroupedJournals = useMemo(getGroupedJournals, [
    settings.sidebarOrganization, followedJournals, entries, readSet, starredSet, catalog,
  ]);

  // Filter journals based on sidebar search query
  const groupedJournals = useMemo(() => {
    if (!sidebarSearchQuery.trim()) return allGroupedJournals;

    const searchLower = sidebarSearchQuery.toLowerCase().trim();
    return allGroupedJournals
      .map(group => ({
        ...group,
        journals: group.journals.filter(journal =>
          cleanJournalName(journal.name).toLowerCase().includes(searchLower)
        )
      }))
      .filter(group => group.journals.length > 0);
  }, [allGroupedJournals, sidebarSearchQuery]);

  // Initialize expanded disciplines to show all groups
  const [expandedDisciplines, setExpandedDisciplines] = useState<Set<string>>(
    new Set(groupedJournals.map(g => g.id))
  );

  // Auto-expand new groups that appear (e.g., after search is cleared)
  // But don't run on every groupedJournals change - only when group IDs actually change
  useEffect(() => {
    const currentGroupIds = groupedJournals.map(g => g.id);
    const currentGroupIdsSet = new Set(currentGroupIds);
    const existingIds = Array.from(expandedDisciplines);

    // Check if there are any new group IDs that weren't there before
    const hasNewGroups = currentGroupIds.some(id => !existingIds.includes(id) && !expandedDisciplines.has(id));

    if (hasNewGroups) {
      const newExpanded = new Set(expandedDisciplines);
      currentGroupIds.forEach(id => {
        if (!newExpanded.has(id)) {
          newExpanded.add(id);
        }
      });
      setExpandedDisciplines(newExpanded);
    }
  }, [groupedJournals.map(g => g.id).join(',')]);

  // Update expanded disciplines when grouping changes
  useEffect(() => {
    setExpandedDisciplines(new Set(groupedJournals.map(g => g.id)));
  }, [settings.sidebarOrganization, state.follows.length]);

  const toggleDiscipline = (disciplineId: string) => {
    const newExpanded = new Set(expandedDisciplines);
    if (newExpanded.has(disciplineId)) {
      newExpanded.delete(disciplineId);
    } else {
      newExpanded.add(disciplineId);
    }
    setExpandedDisciplines(newExpanded);
  };

  // Prefer the filtered counts from useFilteredEntries (same filters as
  // FilterBar "Unread (N)"). Fall back to a local 30-day count if the
  // parent didn't pass them — keeps this component usable in isolation.
  const { unreadByJournal, totalUnread, journalsWithUnreadCount } = useMemo(() => {
    if (unreadByJournalProp && typeof totalUnreadProp === 'number') {
      return {
        unreadByJournal: unreadByJournalProp,
        totalUnread: totalUnreadProp,
        journalsWithUnreadCount: unreadByJournalProp.size,
      };
    }
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    let total = 0;
    const journalHasUnread = new Set<string>();

    for (const e of entries) {
      if (!followsSet.has(e.journalId)) continue;
      if (isRead(e) || isStarred(e)) continue;
      if (e.published && new Date(e.published).getTime() < thirtyDaysAgo) continue;
      counts.set(e.journalId, (counts.get(e.journalId) || 0) + 1);
      total++;
      journalHasUnread.add(e.journalId);
    }
    return { unreadByJournal: counts, totalUnread: total, journalsWithUnreadCount: journalHasUnread.size };
  }, [unreadByJournalProp, totalUnreadProp, entries, followsSet, readSet, starredSet]);

  const getUnreadCount = useCallback((journalId: string) => {
    return unreadByJournal.get(journalId) || 0;
  }, [unreadByJournal]);

  const getTotalUnread = useCallback(() => totalUnread, [totalUnread]);

  const handleUnfollow = async (journalId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Optimistic update - update UI immediately
    const newFollows = state.follows.filter(id => id !== journalId);
    const newState = { ...state, follows: newFollows };
    onStateChange(newState);
    // Save to backend in background with computed state to prevent race conditions
    await unfollowJournal(journalId, newState);
    if (selectedJournalId === journalId) {
      onJournalSelect(null);
    }
  };

  const handleFollowJournal = async (journalId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (followsSet.has(journalId)) return;
    // Optimistic update - update UI immediately
    const newFollows = [...state.follows, journalId];
    const newState = { ...state, follows: newFollows };
    onStateChange(newState);
    // Save to backend in background with computed state to prevent race conditions
    saveState(newState).catch(console.error);
    // Instantly pull this journal's latest papers so the feed isn't empty while
    // waiting for the next scheduled fetch. Show a spinner on the journal in the
    // sidebar until its papers land.
    setFetchingJournals(prev => new Set(prev).add(journalId));
    try {
      await fetch('/api/fetch-journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journalId }),
      });
      // Pull the now-ingested papers into the feed immediately.
      onJournalFetched?.(journalId);
    } catch {
      // ignore — the scheduled fetch will pick it up
    } finally {
      setFetchingJournals(prev => {
        const next = new Set(prev);
        next.delete(journalId);
        return next;
      });
    }
  };

  const handleUnfollowInModal = async (journalId: string) => {
    if (!followsSet.has(journalId)) return;
    // Optimistic update - update UI immediately
    const newFollows = state.follows.filter(id => id !== journalId);
    const newState = { ...state, follows: newFollows };
    onStateChange(newState);
    // Save to backend in background with computed state to prevent race conditions
    await unfollowJournal(journalId, newState);
  };

  // Fetch article counts for all journals when modal opens (once per open).
  useEffect(() => {
    if (!showAddModal) { countsFetchedRef.current = false; return; }
    if (countsFetchedRef.current || articleCountsLoading) return;
    {
      countsFetchedRef.current = true;
      setArticleCountsLoading(true);
      setLoadingProgress(0);

      // Simulate progress while loading - more frequent updates for smoother animation
      const progressInterval = setInterval(() => {
        setLoadingProgress(prev => {
          if (prev >= 90) return prev; // Stop at 90% until actual data loads
          return Math.min(prev + Math.random() * 10 + 5, 90); // Increment by 5-15%, cap at 90
        });
      }, 100); // Update every 100ms for smoother animation

      // /api/article-counts is ISR-cached at the edge (revalidate 30 min,
      // s-maxage 1800), so this is just as fast as the old direct
      // /data/stats.json fetch but always fresh and Supabase-backed.
      const startTime = Date.now();
      fetch('/api/article-counts')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(async (data: Record<string, number>) => {
          // Ensure at least 800ms has passed so users can see the progress
          const elapsed = Date.now() - startTime;
          const minDelay = 800;
          if (elapsed < minDelay) {
            await new Promise(resolve => setTimeout(resolve, minDelay - elapsed));
          }

          const countsMap = new Map<string, number>();
          for (const [journalId, count] of Object.entries(data)) {
            countsMap.set(journalId, count);
          }
          clearInterval(progressInterval);
          setLoadingProgress(100); // Complete the progress bar
          setAllJournalArticleCounts(countsMap);
          setArticleCountsLoading(false);
        })
        .catch(err => {
          console.error('Failed to load article counts:', err);
          clearInterval(progressInterval);
          setArticleCountsLoading(false);
          setLoadingProgress(0);
        });

      return () => clearInterval(progressInterval);
    }
  }, [showAddModal, articleCountsLoading]);

  // Get all journals with discipline name/id for modal (both followed and unfollowed)
  // Only show journals once allJournalArticleCounts has loaded to prevent flash
  const allCatalogJournals = useMemo(() => {
    if (!catalog) return [];
    // Build from the catalog regardless of article counts so browse works even
    // with an empty/pruned database (counts are just decoration).
    return catalog.disciplines.flatMap(d =>
      d.journals.map(j => ({
        ...j,
        disciplineName: d.name,
        disciplineId: d.id,
      }))
    );
  }, [catalog]);

  // Filter by search query (memoized) - smart relevance-based search
  const filteredAllJournals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    if (!q) {
      // No search query - just apply sorting
      const sorted = [...allCatalogJournals];
      if (sortBy === 'name') {
        sorted.sort((a, b) => cleanJournalName(a.name).localeCompare(cleanJournalName(b.name)));
      } else if (sortBy === 'impact') {
        sorted.sort((a, b) => {
          const impactA = a.impactFactor || 0;
          const impactB = b.impactFactor || 0;
          return impactB - impactA;
        });
      } else if (sortBy === 'recent') {
        sorted.reverse();
      }
      return sorted;
    }

    // Calculate relevance score for each journal
    const journalsWithScore = allCatalogJournals
      .map(journal => {
        const journalName = cleanJournalName(journal.name).toLowerCase();
        const disciplineName = journal.disciplineName.toLowerCase();

        let score = 0;

        // Exact match (highest priority)
        if (journalName === q) {
          score = 1000;
        }
        // Starts with query (high priority)
        else if (journalName.startsWith(q)) {
          score = 500;
        }
        // Word boundary match in journal name (medium-high priority)
        else if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(journalName)) {
          score = 300;
        }
        // Contains in journal name (medium priority)
        else if (journalName.includes(q)) {
          score = 200;
        }
        // Discipline name match (lower priority)
        else if (disciplineName.includes(q)) {
          score = 100;
        }

        // Boost by impact factor (add up to 50 points based on IF)
        if (score > 0 && journal.impactFactor) {
          score += Math.min(journal.impactFactor * 2, 50);
        }

        return { ...journal, relevanceScore: score };
      })
      .filter(j => j.relevanceScore > 0);

    // Apply sorting
    const sorted = [...journalsWithScore];
    if (sortBy === 'name') {
      // Sort by relevance first, then alphabetically within same relevance
      sorted.sort((a, b) => {
        if (Math.abs(a.relevanceScore - b.relevanceScore) < 10) {
          return cleanJournalName(a.name).localeCompare(cleanJournalName(b.name));
        }
        return b.relevanceScore - a.relevanceScore;
      });
    } else if (sortBy === 'impact') {
      // Sort by relevance tier, then by IF within tier
      sorted.sort((a, b) => {
        // Define relevance tiers
        const getTier = (score: number) => {
          if (score >= 500) return 3; // Exact or starts with
          if (score >= 200) return 2; // Contains in name
          return 1; // Discipline match
        };

        const tierA = getTier(a.relevanceScore);
        const tierB = getTier(b.relevanceScore);

        if (tierA !== tierB) {
          return tierB - tierA; // Higher tier first
        }

        // Within same tier, sort by IF
        const impactA = a.impactFactor || 0;
        const impactB = b.impactFactor || 0;
        return impactB - impactA;
      });
    } else if (sortBy === 'recent') {
      // Sort by relevance first, then recent
      sorted.sort((a, b) => {
        if (Math.abs(a.relevanceScore - b.relevanceScore) < 10) {
          return 1; // Keep original order for same relevance
        }
        return b.relevanceScore - a.relevanceScore;
      });
    } else {
      // Default: sort by relevance score only
      sorted.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }

    return sorted;
  }, [allCatalogJournals, searchQuery, sortBy]);

  // Total article count for currently filtered journals (for modal summary)
  const totalArticlesForFiltered = useMemo(() => {
    let total = 0;
    for (const j of filteredAllJournals) {
      total += allJournalArticleCounts.get(j.id) || 0;
    }
    return total;
  }, [filteredAllJournals, allJournalArticleCounts]);

  // Simple pagination to avoid rendering too many items at once
  const [visibleCount, setVisibleCount] = useState(200);
  useEffect(() => {
    // reset pagination on open or search change
    setVisibleCount(200);
  }, [showAddModal, searchQuery]);

  return (
    <>
      {/* Mobile overlay - invisible, just for closing */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={`
          fixed md:sticky top-0 left-0 h-screen overflow-y-auto flex flex-col z-50
          w-64 border-r
          transform transition-transform duration-300 ease-in-out
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        // 100dvh (dynamic viewport height) so the pinned footer isn't hidden
        // behind the mobile browser toolbar; falls back to the h-screen 100vh
        // on browsers that don't support dvh.
        style={{ height: '100dvh', backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border)' }}
      >
        <div className="border-b px-4 md:px-6" style={{ height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <h2
            className="text-2xl"
            style={{
              fontWeight: 300,
              color: 'var(--color-ink)',
              lineHeight: '2rem',
              margin: 0,
              fontSize: '26px'
            }}
          >
            <Wordmark />
          </h2>
          {/* Mobile close button */}
          {onMobileClose && (
            <button
              onClick={onMobileClose}
              className="md:hidden p-2"
              style={{ color: 'var(--color-ink-soft)', position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)' }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>

        <div className="p-3 md:p-4 border-b" style={{ backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <Link
            href="/"
            prefetch={true}
            className="w-full text-left px-2 py-1.5 rounded transition-colors mb-3 block"
            style={{
              backgroundColor: !showSettingsDashboard && !isPopularPage && mainFilter !== 'discover' ? 'var(--color-accent)' : 'transparent',
              color: !showSettingsDashboard && !isPopularPage && mainFilter !== 'discover' ? 'white' : 'var(--color-ink)',
              textDecoration: 'none'
            }}
            onClick={(e) => {
              e.preventDefault();
              // Close settings if open
              if (showSettingsDashboard && onCloseSettings) {
                onCloseSettings();
              }
              if (isPopularPage && onViewChange) {
                onViewChange('all');
                onJournalSelect(null); // Clear selected journal when switching from Popular
              } else {
                onJournalSelect(null);
              }
              // Reset to unread when clicking Home
              if (onMainFilterChange) {
                onMainFilterChange('unread');
              }
              if (isMobile && onMobileClose) {
                onMobileClose();
              }
            }}
            onMouseEnter={(e) => {
              if (showSettingsDashboard || isPopularPage || mainFilter === 'discover') {
                e.currentTarget.style.backgroundColor = 'var(--color-surface)';
              } else {
                e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)';
              }
            }}
            onMouseLeave={(e) => {
              if (showSettingsDashboard || isPopularPage || mainFilter === 'discover') {
                e.currentTarget.style.backgroundColor = 'transparent';
              } else {
                e.currentTarget.style.backgroundColor = 'var(--color-accent)';
              }
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faHome} className="w-4 h-4" />
                <span className="font-medium">Home</span>
              </div>
              {getTotalUnread() > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-ink)',
                  border: selectedJournalId === null ? 'none' : `1px solid var(--color-border)`
                }}>
                  {getTotalUnread()}
                </span>
              )}
            </div>
          </Link>

          <button
            onClick={() => {
              // Set loading state immediately
              if (onDiscoverLoading) {
                onDiscoverLoading();
              }
              // Close settings if open
              if (showSettingsDashboard && onCloseSettings) {
                onCloseSettings();
              }
              onJournalSelect(null);
              if (onMainFilterChange) {
                onMainFilterChange('discover');
              }
              if (isMobile && onMobileClose) {
                onMobileClose();
              }
            }}
            className="w-full text-left px-2 py-1.5 rounded transition-colors mb-3 block"
            style={{
              backgroundColor: !showSettingsDashboard && !isPopularPage && selectedJournalId === null && mainFilter === 'discover' ? 'var(--color-accent)' : 'transparent',
              color: !showSettingsDashboard && !isPopularPage && selectedJournalId === null && mainFilter === 'discover' ? 'white' : 'var(--color-ink)',
              border: 'none',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => {
              if (mainFilter !== 'discover' || showSettingsDashboard || isPopularPage || selectedJournalId !== null) {
                e.currentTarget.style.backgroundColor = 'var(--color-surface)';
              } else {
                e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)';
              }
            }}
            onMouseLeave={(e) => {
              if (mainFilter !== 'discover' || showSettingsDashboard || isPopularPage || selectedJournalId !== null) {
                e.currentTarget.style.backgroundColor = 'transparent';
              } else {
                e.currentTarget.style.backgroundColor = 'var(--color-accent)';
              }
            }}
          >
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faCompass} className="w-4 h-4" />
              <span className="font-medium">Discover</span>
            </div>
          </button>

          <button
            onClick={() => setShowAddModal(true)}
            className="w-full text-sm transition-all border"
            style={{
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-ink-soft)',
              borderColor: 'var(--color-border)',
              fontWeight: 400,
              letterSpacing: '0.02em',
              borderRadius: '6px',
              padding: '10px 16px'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--color-bg)';
              e.currentTarget.style.borderColor = 'var(--color-ink-soft)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--color-surface)';
              e.currentTarget.style.borderColor = 'var(--color-border)';
            }}
          >
            + Add Journal
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Sticky Search Bar */}
          <div className="sticky top-0 z-10 p-3 md:p-4 pb-0" style={{ backgroundColor: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>
            <div className="mb-3">
              <div className="relative">
                <svg
                  className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 opacity-40"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  style={{ color: 'var(--color-ink-soft)' }}
                >
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                  type="search"
                  placeholder="Search journals..."
                  className="w-full pl-8 pr-2 py-1.5 text-xs transition-all border"
                  style={{
                    borderColor: 'var(--color-border)',
                    borderRadius: '6px',
                    fontSize: '16px',
                    color: 'var(--color-ink)',
                    backgroundColor: 'var(--color-surface)',
                    fontWeight: 400
                  }}
                  value={sidebarSearchQuery}
                  onChange={(e) => setSidebarSearchQuery(e.target.value)}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-accent)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border)';
                  }}
                />
                {sidebarSearchQuery.length > 0 && (
                  <button
                    onClick={() => setSidebarSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 flex items-center justify-center opacity-40 hover:opacity-60"
                    style={{ color: 'var(--color-ink-soft)' }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between px-3 pb-3 md:pb-0">
              <div className="text-xs uppercase text-[var(--color-ink-soft)] font-medium">
                Following
              </div>
              <div className="text-xs text-[var(--color-ink-soft)]">
                ({state.follows.length})
              </div>
            </div>
          </div>

          {/* Scrollable Content */}
          <div className="px-3 md:px-4 pb-3 md:pb-4">
            {groupedJournals.length === 0 && (
              <div className="px-3 py-4 text-sm text-[var(--color-ink-soft)] text-center">
                {sidebarSearchQuery.trim() ? (
                  <>No journals match "{sidebarSearchQuery}"</>
                ) : (
                  <>
                    No journals followed yet.<br />
                    Click "+ Add Journal" above to start.
                  </>
                )}
              </div>
            )}


            {groupedJournals.map(group => (
              <div key={group.id} className="mb-2">
                <button
                  onClick={() => toggleDiscipline(group.id)}
                  className="w-full text-left px-2 py-1 text-xs font-medium rounded flex items-center justify-between"
                  style={{ color: 'var(--color-ink-soft)', transition: 'background-color 0.15s ease' }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <span>{group.name} <span style={{ opacity: 0.5, fontSize: '0.85em' }}>({group.id === 'recently-updated' ? journalsWithUnreadCount : group.journals.length})</span></span>
                  <span className="text-xs">
                    {expandedDisciplines.has(group.id) ? '▼' : '▶'}
                  </span>
                </button>

                {expandedDisciplines.has(group.id) && (
                  <div className="ml-2 mt-1">
                    {group.journals.map(journal => {
                      const unreadCount = getUnreadCount(journal.id);
                      return (
                        <div
                          key={journal.id}
                          className="group px-2 py-1.5 text-[13px] rounded cursor-pointer transition-colors relative"
                          style={{
                            backgroundColor: selectedJournalId === journal.id ? 'var(--color-bg)' : 'transparent',
                            color: 'var(--color-ink)'
                          }}
                          onClick={() => {
                            onJournalSelect(journal.id);
                            // Close settings if open
                            if (showSettingsDashboard && onCloseSettings) {
                              onCloseSettings();
                            }
                            if (isPopularPage && onViewChange) {
                              onViewChange('all');
                            }
                          }}
                          onMouseEnter={(e) => {
                            if (selectedJournalId !== journal.id) {
                              e.currentTarget.style.backgroundColor = 'var(--color-surface)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedJournalId !== journal.id) {
                              e.currentTarget.style.backgroundColor = 'transparent';
                            }
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center pr-8" style={{ gap: '6px' }}>
                              <img
                                src={getJournalLogo(journal)}
                                alt={cleanJournalName(journal.name)}
                                style={{ width: '14px', height: '14px' }}
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                              <span>{cleanJournalName(journal.name)}</span>
                            </div>
                            {fetchingJournals.has(journal.id) ? (
                              <span
                                className="inline-block animate-spin rounded-full"
                                style={{
                                  width: '11px',
                                  height: '11px',
                                  borderWidth: '2px',
                                  borderStyle: 'solid',
                                  borderColor: 'var(--color-border)',
                                  borderTopColor: 'var(--color-ink-soft)',
                                }}
                                title="Fetching latest papers…"
                              />
                            ) : unreadCount > 0 ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{
                                backgroundColor: 'var(--color-surface)',
                                color: 'var(--color-ink)',
                                border: `1px solid var(--color-border)`
                              }}>
                                {unreadCount}
                              </span>
                            ) : null}
                          </div>
                          <button
                            onClick={(e) => handleUnfollow(journal.id, e)}
                            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded transition-opacity"
                            style={{
                              backgroundColor: 'var(--color-surface)',
                              color: 'var(--color-ink)',
                              transition: 'background-color 0.15s ease'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = 'var(--color-border)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = 'var(--color-surface)';
                            }}
                            title="Unfollow"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Support link — quiet footer pinned to the bottom; uncited-os is free
            and open, this just points to the maintainer's tip jar. */}
        <div className="mt-auto border-t px-4 py-3 flex justify-center" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg)' }}>
          <a
            href="https://www.buymeacoffee.com/uncited"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-xs transition-colors"
            style={{ color: 'var(--color-ink-soft)', textDecoration: 'none' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: '13px',
                height: '18px',
                backgroundImage: 'var(--bmc-logo)',
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundSize: 'contain',
              }}
            />
            <span>Support <span style={{
              textDecoration: 'underline',
              textDecorationColor: 'var(--brand-underline-blue)',
              textUnderlineOffset: '3px',
            }}>uncited</span></span>
          </a>
        </div>

      </aside>

      {showAddModal && (
        <div
          className="fixed inset-0 flex items-center justify-center modal-overlay"
          style={{ backgroundColor: 'var(--color-overlay, rgba(0, 0, 0, 0.6))', zIndex: 100 }}
          onMouseDown={(e) => {
            // Only close if mousedown is on the backdrop itself, not when dragging text from inside
            if (e.target === e.currentTarget) {
              setShowAddModal(false);
            }
          }}
        >
          <div
            className="rounded-lg p-4 md:p-6 max-w-2xl w-full mx-4 max-h-[90vh] md:max-h-[80vh] overflow-y-auto"
            style={{ backgroundColor: 'var(--color-surface)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold mb-0" style={{ color: 'var(--color-ink)' }}>Add Journals</h2>
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setSearchQuery('');
                  setLocalSearchQuery('');
                }}
                className="text-2xl transition-colors"
                style={{ color: 'var(--color-ink-soft)' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-ink)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-ink-soft)'; }}
              >
                ×
              </button>
            </div>

            {articleCountsLoading ? (
              <div className="flex items-center justify-center py-16">
                <div className="text-center">
                  <div className="mb-4">
                    <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--color-accent)' }}></div>
                  </div>
                  <p className="text-lg" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>Loading...</p>
                </div>
              </div>
            ) : allCatalogJournals.length === 0 ? (
              <p className="text-[var(--color-ink-soft)] text-center py-8">
                You're following all available journals!
              </p>
            ) : (
              <>
                <div className="mb-4 space-y-3">
                  <input
                    type="search"
                    placeholder="Search journals..."
                    className="w-full px-4 py-2 border rounded transition-colors focus:outline-none focus:ring-2"
                    style={{
                      borderColor: 'var(--color-border)',
                      backgroundColor: 'var(--color-bg)',
                      color: 'var(--color-ink)',
                      fontSize: '16px'
                    }}
                    value={localSearchQuery}
                    onChange={(e) => {
                      const val = e.target.value;
                      setLocalSearchQuery(val);
                      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                      if (!val) { setSearchQuery(''); return; }
                      searchDebounceRef.current = setTimeout(() => setSearchQuery(val), 150);
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-accent)';
                      e.currentTarget.style.outline = 'none';
                      e.currentTarget.style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                    autoFocus
                  />
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-[var(--color-ink-soft)]">
                      {filteredAllJournals.length} journal{filteredAllJournals.length !== 1 ? 's' : ''}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSortBy('name')}
                        className="px-2 py-1 text-xs rounded transition-all"
                        style={{
                          backgroundColor: sortBy === 'name' ? 'var(--color-accent)' : 'var(--color-surface)',
                          color: sortBy === 'name' ? 'white' : 'var(--color-ink)',
                          border: `1px solid ${sortBy === 'name' ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          fontWeight: sortBy === 'name' ? 500 : 400
                        }}
                      >
                        A-Z
                      </button>
                      <button
                        onClick={() => setSortBy('impact')}
                        className="px-2 py-1 text-xs rounded transition-all"
                        style={{
                          backgroundColor: sortBy === 'impact' ? 'var(--color-accent)' : 'var(--color-surface)',
                          color: sortBy === 'impact' ? 'white' : 'var(--color-ink)',
                          border: `1px solid ${sortBy === 'impact' ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          fontWeight: sortBy === 'impact' ? 500 : 400
                        }}
                      >
                        IF
                      </button>
                    </div>
                  </div>
                </div>

                {articleCountsLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <div className="text-center">
                      <div className="mb-4">
                        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--color-accent)' }}></div>
                      </div>
                      <p className="text-lg" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>Loading...</p>
                    </div>
                  </div>
                ) : filteredAllJournals.length === 0 ? (
                  <p className="text-[var(--color-ink-soft)] text-center py-8">
                    No journals found matching "{searchQuery}"
                  </p>
                ) : (
                  <div className="space-y-4 max-h-96 overflow-y-auto">
                    {(() => {
                      const slice = filteredAllJournals.slice(0, visibleCount);

                      // When sorting by IF, show journals without grouping by discipline
                      if (sortBy === 'impact') {
                        return (
                          <div className="space-y-2">
                            {slice.map((journal: any) => {
                              const isFollowed = followsSet.has(journal.id);
                              return (
                                <div
                                  key={journal.id}
                                  className="flex items-start justify-between p-3 border rounded transition-colors gap-3"
                                  style={{
                                    borderColor: 'var(--color-border)',
                                    backgroundColor: 'transparent'
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <img
                                        src={getJournalLogo(journal)}
                                        alt={cleanJournalName(journal.name)}
                                        style={{ width: '20px', height: '20px', flexShrink: 0 }}
                                        onError={(e) => {
                                          e.currentTarget.style.display = 'none';
                                        }}
                                      />
                                      <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>{cleanJournalName(journal.name)}</span>
                                    </div>
                                    <div className="flex items-center gap-2 ml-7">
                                      {journal.impactFactor && (
                                        <span className="text-xs px-2 py-0.5 rounded border" style={{ borderColor: 'var(--color-border)', color: 'var(--color-ink-soft)' }}>
                                          IF: {journal.impactFactor}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex-shrink-0">
                                    {fetchingJournals.has(journal.id) ? (
                                      <span
                                        className="inline-block animate-spin rounded-full"
                                        style={{ width: '16px', height: '16px', borderWidth: '2px', borderStyle: 'solid', borderColor: 'var(--color-border)', borderTopColor: 'var(--color-ink-soft)' }}
                                        title="Fetching latest papers…"
                                      />
                                    ) : isFollowed ? (
                                      <button
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleUnfollowInModal(journal.id);
                                        }}
                                        type="button"
                                        className="px-4 py-1.5 text-sm transition-all border whitespace-nowrap"
                                        style={{
                                          backgroundColor: 'var(--color-surface)',
                                          color: 'var(--color-ink)',
                                          borderColor: 'var(--color-border)',
                                          fontWeight: 400,
                                          letterSpacing: '0.02em',
                                          borderRadius: '6px'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)'; }}
                                      >
                                        Unfollow
                                      </button>
                                    ) : (
                                      <button
                                        onClick={(e) => handleFollowJournal(journal.id, e)}
                                        type="button"
                                        className="px-4 py-1.5 text-sm transition-all whitespace-nowrap"
                                        style={{
                                          backgroundColor: 'var(--color-accent)',
                                          color: 'var(--color-accent-text)',
                                          fontWeight: 400,
                                          letterSpacing: '0.02em',
                                          borderRadius: '6px'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-accent)'; }}
                                      >
                                        Follow
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      }

                      // For other sort modes (name, recent), group by discipline
                      const byDiscipline = new Map<string, { name: string; items: typeof slice }>();
                      for (const j of slice) {
                        const key = j.disciplineId;
                        const group = byDiscipline.get(key);
                        if (!group) {
                          byDiscipline.set(key, { name: j.disciplineName, items: [j] as any });
                        } else {
                          (group.items as any).push(j);
                        }
                      }
                      return Array.from(byDiscipline.entries()).map(([id, group]) => (
                        <div key={id || 'uncategorized'}>
                          <h3 className="text-sm font-medium text-[var(--color-ink-soft)] mb-2">
                            {group.name} <span style={{ opacity: 0.5, fontSize: '0.9em' }}>({(group.items as any).length})</span>
                          </h3>
                          <div className="space-y-2">
                            {(group.items as any).map((journal: any) => {
                              const isFollowed = followsSet.has(journal.id);
                              return (
                                <div
                                  key={journal.id}
                                  className="flex items-start justify-between p-3 border rounded transition-colors gap-3"
                                  style={{
                                    borderColor: 'var(--color-border)',
                                    backgroundColor: 'transparent'
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <img
                                        src={getJournalLogo(journal)}
                                        alt={cleanJournalName(journal.name)}
                                        style={{ width: '20px', height: '20px', flexShrink: 0 }}
                                        onError={(e) => {
                                          e.currentTarget.style.display = 'none';
                                        }}
                                      />
                                      <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>{cleanJournalName(journal.name)}</span>
                                    </div>
                                    <div className="flex items-center gap-2 ml-7">
                                      {journal.impactFactor && (
                                        <span className="text-xs px-2 py-0.5 rounded border" style={{ borderColor: 'var(--color-border)', color: 'var(--color-ink-soft)' }}>
                                          IF: {journal.impactFactor}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex-shrink-0">
                                    {fetchingJournals.has(journal.id) ? (
                                      <span
                                        className="inline-block animate-spin rounded-full"
                                        style={{ width: '16px', height: '16px', borderWidth: '2px', borderStyle: 'solid', borderColor: 'var(--color-border)', borderTopColor: 'var(--color-ink-soft)' }}
                                        title="Fetching latest papers…"
                                      />
                                    ) : isFollowed ? (
                                      <button
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          handleUnfollowInModal(journal.id);
                                        }}
                                        type="button"
                                        className="px-4 py-1.5 text-sm transition-all border whitespace-nowrap"
                                        style={{
                                          backgroundColor: 'var(--color-surface)',
                                          color: 'var(--color-ink)',
                                          borderColor: 'var(--color-border)',
                                          fontWeight: 400,
                                          letterSpacing: '0.02em',
                                          borderRadius: '6px'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)'; }}
                                      >
                                        Unfollow
                                      </button>
                                    ) : (
                                      <button
                                        onClick={(e) => handleFollowJournal(journal.id, e)}
                                        type="button"
                                        className="px-4 py-1.5 text-sm transition-all whitespace-nowrap"
                                        style={{
                                          backgroundColor: 'var(--color-accent)',
                                          color: 'var(--color-accent-text)',
                                          fontWeight: 400,
                                          letterSpacing: '0.02em',
                                          borderRadius: '6px'
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-accent)'; }}
                                      >
                                        Follow
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ));
                    })()}
                    {visibleCount < filteredAllJournals.length && (
                      <div className="pt-2">
                        <button
                          onClick={() => setVisibleCount(v => v + 200)}
                          className="w-full py-2 text-sm transition-all border"
                          style={{
                            backgroundColor: 'var(--color-surface)',
                            color: 'var(--color-ink)',
                            borderColor: 'var(--color-border)',
                            fontWeight: 400,
                            letterSpacing: '0.02em',
                            borderRadius: '6px'
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)'; }}
                        >
                          Show more ({Math.min(filteredAllJournals.length - visibleCount, 200)} more)
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
});

export default Sidebar;
