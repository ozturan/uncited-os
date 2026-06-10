'use client';

import React, { memo, useState, useRef, useEffect, useCallback } from 'react';
import { Catalog, UserSettings } from '@/lib/types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEnvelope, faStar as faStarSolid, faInbox, faSearch, faCircleCheck, faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import SearchBar from './SearchBar';
import CategorySelector from './CategorySelector';
import TypeFilter, { ARTICLE_TYPES } from './TypeFilter';

interface FilterBarProps {
  variant: 'mobile' | 'desktop';
  mainFilter: 'unread' | 'archive' | 'starred' | 'discover';
  sortMode: string;
  setSortMode: (mode: string) => void;
  myFieldRecommendations: string[] | null;
  dateFilter: 'all' | 'this-week' | 'older';
  setDateFilter: (filter: 'all' | 'this-week' | 'older') => void;
  search: string;
  setSearch: (search: string) => void;
  discoverSearch: string;
  setDiscoverSearch: (search: string) => void;
  settings: UserSettings | undefined;
  unreadCount: number;
  // Unread is derived from the feed, so it's 0 until entries load. Gate its
  // display on this so the badge doesn't flash "(0)" before the real count.
  countsReady: boolean;
  starredCount: number;
  readCount: number;
  thisWeekCount: number;
  thisMonthCount: number;
  archiveAllCount: number;
  selectedJournalId: string | null;
  catalog: Catalog | null;
  recommendationsLoading: boolean;
  switchMainFilter: (filter: 'unread' | 'archive' | 'starred' | 'discover') => void;
  handleArchiveAll: () => void;
  archiveAllSaving?: boolean;
  onUpdateSettings: (settings: UserSettings) => void;
  onRefreshDiscover: () => void | Promise<unknown>;
  filteredCount: number;
  keywordFilterCounts?: Map<string, number>;
}

const FilterBar = memo(function FilterBar({
  variant,
  mainFilter,
  sortMode,
  setSortMode,
  dateFilter,
  setDateFilter,
  search,
  setSearch,
  discoverSearch,
  setDiscoverSearch,
  settings,
  unreadCount,
  countsReady,
  starredCount,
  readCount,
  thisWeekCount,
  thisMonthCount,
  archiveAllCount,
  selectedJournalId,
  catalog,
  recommendationsLoading,
  myFieldRecommendations,
  switchMainFilter,
  handleArchiveAll,
  archiveAllSaving,
  onUpdateSettings,
  onRefreshDiscover,
  filteredCount,
  keywordFilterCounts,
}: FilterBarProps) {

  // Spin the refresh icon while a refresh is in flight. The full-list loading
  // state is intentionally suppressed once entries exist, so this is the only
  // visible feedback for an explicit refresh click.
  const [refreshing, setRefreshing] = useState(false);
  const doRefresh = () => {
    if (refreshing) return;
    const result = onRefreshDiscover();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setRefreshing(true);
      (result as Promise<unknown>).finally(() => setRefreshing(false));
    }
  };

  const handleTypesChange = (newTypes: string[]) => {
    onUpdateSettings({
      sidebarOrganization: 'discipline',
      theme: 'light',
      showThumbnails: true,
      ...settings,
      articleTypes: newTypes,
    });
  };

  const handleDiscoverCategoriesChange = (newCategories: string[]) => {
    onUpdateSettings({
      sidebarOrganization: 'discipline',
      theme: 'light',
      showThumbnails: true,
      ...settings,
      discoverCategories: newCategories,
    });
  };

  const isMobile = variant === 'mobile';
  const showIcons = variant !== 'mobile';

  // Local state for search inputs so the input stays responsive while
  // the parent state update (which triggers heavy filtering) is debounced.
  const [localSearch, setLocalSearch] = useState(search);
  const [localDiscoverSearch, setLocalDiscoverSearch] = useState(discoverSearch);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const discoverDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Sync local state when parent clears the search externally (e.g. switching tabs).
  useEffect(() => { setLocalSearch(search); }, [search]);
  useEffect(() => { setLocalDiscoverSearch(discoverSearch); }, [discoverSearch]);

  const handleSearchChange = useCallback((value: string) => {
    setLocalSearch(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value) { setSearch(''); return; }
    searchDebounceRef.current = setTimeout(() => setSearch(value), 200);
  }, [setSearch]);

  const handleDiscoverSearchChange = useCallback((value: string) => {
    setLocalDiscoverSearch(value);
    if (discoverDebounceRef.current) clearTimeout(discoverDebounceRef.current);
    if (!value) { setDiscoverSearch(''); return; }
    discoverDebounceRef.current = setTimeout(() => setDiscoverSearch(value), 150);
  }, [setDiscoverSearch]);

  // Custom sort dropdown state
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const sortDropdownRef = useRef<HTMLDivElement>(null);

  // Local UI state — colocated to avoid re-rendering the entire page tree
  const [showCategorySelector, setShowCategorySelector] = useState(false);
  const [showTypeFilter, setShowTypeFilter] = useState(false);

  // Date filter dropdown state
  const [dateDropdownOpen, setDateDropdownOpen] = useState(false);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node)) {
        setSortDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  // Shared inline search input (tablet/desktop)
  const renderInlineSearch = () => (
    <div className="relative">
      <FontAwesomeIcon
        icon={faSearch}
        className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-40"
        style={{ color: 'var(--color-ink-soft)' }}
        aria-hidden
      />
      <input
        type="search"
        placeholder="Search title or abstract..."
        className={`w-full pl-10 pr-4 ${variant === 'desktop' ? 'py-1.5 text-sm' : 'py-2'} transition-all border`}
        style={{
          borderColor: 'var(--color-border)',
          borderRadius: '6px',
          fontSize: '16px',
          color: 'var(--color-ink)',
          backgroundColor: 'var(--color-surface)',
          fontWeight: 400
        }}
        value={localSearch}
        onChange={(e) => handleSearchChange(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-accent)';
          e.currentTarget.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--color-accent) 15%, transparent)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-border)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      />
      {localSearch.length > 0 && (
        <button
          onClick={() => handleSearchChange('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center opacity-40 hover:opacity-60"
          style={{ color: 'var(--color-ink-soft)' }}
          title="Clear search"
          aria-label="Clear search"
        >
          ×
        </button>
      )}
    </div>
  );

  // Search row
  const renderSearchRow = () => {
    if (mainFilter === 'discover') {
      return (
        <SearchBar
          value={localDiscoverSearch}
          onChange={handleDiscoverSearchChange}
          placeholder="Search all journals from last 30 days..."
        />
      );
    }
    return isMobile ? <SearchBar value={localSearch} onChange={handleSearchChange} /> : renderInlineSearch();
  };

  // Discover filters (categories + type + refresh)
  const renderDiscoverFilters = () => {
    if (mainFilter !== 'discover') return null;

    // Sort dropdown for discover — hidden when text search is active (API ignores mode for search)
    const discoverSort = !localDiscoverSearch.trim() ? renderSortDropdown() : null;

    if (isMobile) {
      return (
        <div className="mt-3 relative">
          <div className="grid grid-cols-4 gap-2">
            {discoverSort}
            {catalog && (
              <CategorySelector
                catalog={catalog}
                selectedCategories={settings?.discoverCategories || []}
                onCategoriesChange={handleDiscoverCategoriesChange}
                isOpen={showCategorySelector}
                onToggle={() => setShowCategorySelector(!showCategorySelector)}
                variant="grid"
              />
            )}
            <TypeFilter
              selectedTypes={settings?.articleTypes || ARTICLE_TYPES.map(t => t.id)}
              onTypesChange={handleTypesChange}
              isOpen={showTypeFilter}
              onToggle={() => setShowTypeFilter(!showTypeFilter)}
              variant="grid"
            />
            <button
              onClick={doRefresh}
              className="btn-nav"
              title="Get new recommendations"
            >
              <span className="flex flex-col items-center">
                <FontAwesomeIcon icon={faArrowsRotate} className={`w-3.5 h-3.5 mb-0.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </span>
            </button>
          </div>
        </div>
      );
    }

    if (variant === 'desktop') {
      // Desktop discover uses a button-based category dropdown instead of CategorySelector
      return (
        <div className="relative">
          <div className="flex flex-wrap gap-2 items-center">
            {discoverSort}
            {catalog && (
              <div style={{ position: 'relative' }}>
                {(() => {
                  const currentCategories = settings?.discoverCategories || [];
                  const allDisciplineIds = catalog.disciplines.map(
                    d => d.id || d.name.toLowerCase().replace(/\s+/g, '-')
                  );
                  const hasCatFilter = currentCategories.length > 0 &&
                    !allDisciplineIds.every(id => currentCategories.includes(id));
                  return (
                    <>
                      <button
                        className={`btn-nav inline-flex items-center gap-1.5 ${hasCatFilter ? 'active' : ''}`}
                        onClick={() => setShowCategorySelector(!showCategorySelector)}
                      >
                        Categories
                        {hasCatFilter && <span className="text-[10px] opacity-75">({currentCategories.length})</span>}
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                          strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      {showCategorySelector && (
                        <>
                          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setShowCategorySelector(false)} />
                          <div
                            style={{
                              position: 'absolute',
                              top: 'calc(100% + 4px)',
                              left: 0,
                              backgroundColor: 'var(--color-surface)',
                              border: '1px solid var(--color-border)',
                              borderRadius: '8px',
                              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                              padding: '4px 0',
                              minWidth: '220px',
                              maxWidth: '320px',
                              maxHeight: '320px',
                              overflowY: 'auto',
                              zIndex: 1000,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {catalog.disciplines.map(discipline => {
                              const disciplineId = discipline.id || discipline.name.toLowerCase().replace(/\s+/g, '-');
                              const isSelected = currentCategories.includes(disciplineId);
                              return (
                                <button
                                  key={disciplineId}
                                  onClick={() => {
                                    const next = isSelected
                                      ? currentCategories.filter(id => id !== disciplineId)
                                      : [...currentCategories, disciplineId];
                                    handleDiscoverCategoriesChange(next);
                                  }}
                                  className={`dropdown-item${isSelected ? ' dropdown-item--selected' : ''}`}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '6px 12px',
                                    fontSize: '13px',
                                    fontWeight: isSelected ? 600 : 400,
                                    color: isSelected ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                                    border: 'none',
                                    cursor: 'pointer',
                                  }}
                                >
                                  <span>{discipline.name}</span>
                                  {isSelected && (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                            {hasCatFilter && (
                              <>
                                <div style={{ height: '1px', backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
                                <button
                                  onClick={() => handleDiscoverCategoriesChange([])}
                                  className="dropdown-item"
                                  style={{
                                    width: '100%', textAlign: 'left', padding: '6px 12px',
                                    fontSize: '12px', color: 'var(--color-ink-soft)',
                                    border: 'none', cursor: 'pointer',
                                  }}
                                >
                                  Clear filter
                                </button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            <TypeFilter
              selectedTypes={settings?.articleTypes || ARTICLE_TYPES.map(t => t.id)}
              onTypesChange={handleTypesChange}
              isOpen={showTypeFilter}
              onToggle={() => setShowTypeFilter(!showTypeFilter)}
              variant="inline"
            />
            <button
              onClick={doRefresh}
              className="btn-nav flex items-center gap-1.5"
              title="Get new recommendations"
            >
              <FontAwesomeIcon icon={faArrowsRotate} className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
      );
    }

    // Tablet
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {discoverSort}
        {catalog && (
          <div style={{ position: 'relative' }}>
            <CategorySelector
              catalog={catalog}
              selectedCategories={settings?.discoverCategories || []}
              onCategoriesChange={handleDiscoverCategoriesChange}
              isOpen={showCategorySelector}
              onToggle={() => setShowCategorySelector(!showCategorySelector)}
              variant="inline"
            />
          </div>
        )}
        <TypeFilter
          selectedTypes={settings?.articleTypes || ARTICLE_TYPES.map(t => t.id)}
          onTypesChange={handleTypesChange}
          isOpen={showTypeFilter}
          onToggle={() => setShowTypeFilter(!showTypeFilter)}
          variant="inline"
        />
        <button
          onClick={doRefresh}
          className="btn-nav flex items-center gap-1.5"
          title="Get new recommendations"
        >
          <FontAwesomeIcon icon={faArrowsRotate} className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    );
  };

  // Sort dropdown — custom button+panel (Trending style)
  const SORT_LABELS: Record<string, string> = { 'for-you': 'Related', 'my-field': 'My Field', date: 'Recent', added: 'Added' };
  const canShowRelevance = mainFilter === 'unread' || mainFilter === 'discover';
  const customFilters = (settings?.keywordFilters || []).map(f => ({
    value: `kw:${f.id}`,
    label: f.name,
    // Counts intentionally omitted — local-only tallies undercount the real
    // search scope (especially in Discover, where the API can return up to
    // 100 cross-corpus matches), and pre-fetching every filter on render
    // would burn an API call per filter on every page load.
  }));
  const sortOptions: { value: string; label: string; count?: number }[] = [
    ...(canShowRelevance ? [
      ...(settings?.field_centroid?.length === 256 ? [{ value: 'my-field', label: 'My Field' }] : []),
      { value: 'for-you', label: 'Related' },
    ] : []),
    ...customFilters,
    ...(mainFilter !== 'discover' ? [{ value: 'date', label: 'Recent' }] : []),
    ...((mainFilter === 'starred' || mainFilter === 'archive') ? [{ value: 'added', label: 'Added' }] : []),
  ];
  const effectiveSortMode = (mainFilter === 'discover' && (sortMode === 'date' || sortMode === 'added')) ? 'for-you' : sortMode;
  const currentSortLabel = SORT_LABELS[effectiveSortMode] || customFilters.find(f => f.value === effectiveSortMode)?.label || 'Related';
  const displayLabel = currentSortLabel;
  const isForYouLoading = (sortMode === 'for-you' || sortMode === 'my-field') && recommendationsLoading;
  const isMyFieldLoading = sortMode === 'my-field' && myFieldRecommendations === null && !recommendationsLoading;
  const isBackgroundLoading = mainFilter === 'unread' && sortMode !== 'for-you' && sortMode !== 'my-field' && recommendationsLoading;

  const renderSortDropdown = () => (
    <div
      ref={sortDropdownRef}
      className={`relative ${isMobile ? 'w-full h-full flex flex-col' : 'flex items-center gap-1.5 inline-flex flex-shrink-0'}`}
    >
      {/* Trigger button */}
      <button
        onClick={() => setSortDropdownOpen(o => !o)}
        className={`btn-nav ${isMobile ? 'w-full h-full' : 'inline-flex items-center gap-1.5 flex-shrink-0'}`}
        style={{ backgroundColor: 'transparent', cursor: 'pointer' }}
        title="Sort articles"
      >
        {isMobile ? (
          <span className="flex flex-col items-center justify-center w-full h-full">
            <span>{displayLabel}</span>
            {(isForYouLoading || isMyFieldLoading) && (
              <span
                className="inline-block w-2.5 h-2.5 rounded-full border-2 animate-spin flex-shrink-0 mt-0.5"
                style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }}
                aria-label="Loading recommendations"
              />
            )}
          </span>
        ) : (
          <>
            {displayLabel}
            {(isForYouLoading || isMyFieldLoading) ? (
              <span
                className="inline-block w-2.5 h-2.5 rounded-full border-2 animate-spin flex-shrink-0"
                style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }}
                aria-label="Loading recommendations"
              />
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, flexShrink: 0 }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
          </>
        )}
      </button>

      {/* Background-loading sibling spinner */}
      {!isMobile && isBackgroundLoading && (
        <span
          className="inline-block w-2.5 h-2.5 rounded-full border-2 animate-spin flex-shrink-0"
          style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }}
          title="Related is loading..."
          aria-label="Related is loading"
        />
      )}

      {/* Dropdown panel */}
      {sortDropdownOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            zIndex: 1000,
            minWidth: '130px',
            overflow: 'hidden',
            padding: '4px 0',
          }}
        >
          {sortOptions.map(opt => {
            const isActive = sortMode === opt.value;
            const kwCount = opt.count;
            return (
              <button
                key={opt.value}
                onClick={() => { setSortMode(opt.value); setSortDropdownOpen(false); }}
                className={`dropdown-item${isActive ? ' dropdown-item--selected' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  fontSize: '13px',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                  border: 'none',
                  cursor: 'pointer',
                  letterSpacing: '0.02em',
                }}
              >
                <span>{opt.label}</span>
                {kwCount !== undefined && (
                  <span style={{ fontSize: '11px', opacity: 0.5, flexShrink: 0 }}>({kwCount})</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  // Main filter buttons
  const renderMainFilters = () => {
    if (mainFilter === 'discover') return null;

    if (isMobile) {
      return (
        <div className="grid grid-cols-4 gap-2">
          <button
            className={`btn-nav ${mainFilter === 'unread' ? 'active' : ''}`}
            style={{ backgroundColor: mainFilter === 'unread' ? undefined : 'transparent' }}
            onClick={() => { switchMainFilter('unread'); setDateFilter('all'); }}
            title={countsReady ? `Unread (${unreadCount})` : 'Unread'}
          >
            <span className="flex flex-col items-center"><span>Unread</span><span className="text-[10px] opacity-75">{countsReady ? `(${unreadCount})` : ''}</span></span>
          </button>
          <button
            className={`btn-nav ${mainFilter === 'starred' ? 'active' : ''}`}
            style={{ backgroundColor: mainFilter === 'starred' ? undefined : 'transparent' }}
            onClick={() => { switchMainFilter('starred'); setDateFilter('all'); }}
            title={`Star (${starredCount})`}
          >
            <span className="flex flex-col items-center"><span>Starred</span><span className="text-[10px] opacity-75">({starredCount})</span></span>
          </button>
          <button
            className={`btn-nav ${mainFilter === 'archive' ? 'active' : ''}`}
            style={{ backgroundColor: mainFilter === 'archive' ? undefined : 'transparent' }}
            onClick={() => { switchMainFilter('archive'); setDateFilter('all'); }}
            title={`Read (${readCount})`}
          >
            <span className="flex flex-col items-center"><span>Read</span><span className="text-[10px] opacity-75">({readCount})</span></span>
          </button>
          {mainFilter !== 'archive' ? (
            <button
              className="btn-nav"
              style={{
                backgroundColor: 'transparent',
                borderColor: 'var(--color-border)',
                borderWidth: '1px',
                color: 'var(--color-ink-soft)'
              }}
              onClick={handleArchiveAll}
              disabled={archiveAllSaving}
              title={archiveAllSaving ? 'Saving — please don\'t refresh' : `Mark all as read`}
            >
              <span className="flex flex-col items-center"><span>{archiveAllSaving ? 'Saving…' : 'Mark Read'}</span>{!archiveAllSaving && archiveAllCount > 0 && <span className="text-[10px] opacity-75">({archiveAllCount})</span>}</span>
            </button>
          ) : <div></div>}
        </div>
      );
    }

    // Tablet & Desktop
    return (
      <div className={`flex items-${variant === 'desktop' ? 'stretch' : 'center'} gap-2 ${variant === 'desktop' ? 'mb-3' : 'flex-wrap'}`}>
        {renderSortDropdown()}
        <button
          className={`btn-nav flex-shrink-0 ${mainFilter === 'unread' ? 'active' : ''}`}
          style={{ backgroundColor: mainFilter === 'unread' ? undefined : 'transparent' }}
          onClick={() => { switchMainFilter('unread'); setDateFilter('all'); }}
        >
          <span className="inline-flex items-center gap-1.5">
            <FontAwesomeIcon icon={faEnvelope} className="w-4 h-4" aria-hidden />
            Unread <span className="text-[10px] opacity-75">{countsReady ? `(${unreadCount})` : ''}</span>
          </span>
        </button>
        <button
          className={`btn-nav flex-shrink-0 ${mainFilter === 'starred' ? 'active' : ''}`}
          style={{ backgroundColor: mainFilter === 'starred' ? undefined : 'transparent' }}
          onClick={() => { switchMainFilter('starred'); setDateFilter('all'); }}
        >
          <span className="inline-flex items-center gap-1.5">
            <FontAwesomeIcon icon={faStarSolid} className="w-4 h-4" aria-hidden />
            Starred <span className="text-[10px] opacity-75">({starredCount})</span>
          </span>
        </button>
        <button
          className={`btn-nav flex-shrink-0 ${mainFilter === 'archive' ? 'active' : ''}`}
          style={{ backgroundColor: mainFilter === 'archive' ? undefined : 'transparent' }}
          onClick={() => { switchMainFilter('archive'); setDateFilter('all'); }}
        >
          <span className="inline-flex items-center gap-1.5">
            <FontAwesomeIcon icon={faInbox} className="w-4 h-4" aria-hidden />
            Read <span className="text-[10px] opacity-75">({readCount})</span>
          </span>
        </button>
      </div>
    );
  };

  // Date filters row + type filter + mark all read
  const renderDateFilters = () => {
    if (mainFilter === 'discover') return null;

    const markAllReadTitle = selectedJournalId
      ? `Mark all ${mainFilter === 'unread' ? 'unread' : mainFilter === 'starred' ? 'starred' : 'related'} papers in this journal as read`
      : `Mark all ${mainFilter === 'unread' ? 'unread' : mainFilter === 'starred' ? 'starred' : 'related'} papers as read`;

    if (isMobile) {
      return (
        <div className="grid grid-cols-4 gap-2">
          {renderSortDropdown()}
          <TypeFilter
            selectedTypes={settings?.articleTypes || ARTICLE_TYPES.map(t => t.id)}
            onTypesChange={handleTypesChange}
            isOpen={showTypeFilter}
            onToggle={() => setShowTypeFilter(!showTypeFilter)}
          />
          <button
            className={`btn-nav ${dateFilter === 'this-week' ? 'active' : ''}`}
            style={{ opacity: mainFilter === null ? 0.5 : 1 }}
            onClick={() => setDateFilter(dateFilter === 'this-week' ? 'all' : 'this-week')}
            title={`This Week in ${mainFilter === 'unread' ? 'Unread' : mainFilter === 'archive' ? 'Read' : 'Starred'}`}
          >
            <span className="flex flex-col items-center"><span>This Week</span><span className="text-[10px] opacity-75">({thisWeekCount})</span></span>
          </button>
          <button
            className={`btn-nav ${dateFilter === 'older' ? 'active' : ''}`}
            style={{ opacity: mainFilter === null ? 0.5 : 1 }}
            onClick={() => setDateFilter(dateFilter === 'older' ? 'all' : 'older')}
            title={`Older in ${mainFilter === 'unread' ? 'Unread' : mainFilter === 'archive' ? 'Read' : 'Starred'}`}
          >
            <span className="flex flex-col items-center"><span>Older</span><span className="text-[10px] opacity-75">({thisMonthCount})</span></span>
          </button>
        </div>
      );
    }

    // Tablet & Desktop
    const dateOptions = [
      { value: 'all', label: 'All', count: null },
      { value: 'this-week', label: 'This Week', count: thisWeekCount },
      { value: 'older', label: 'Older', count: thisMonthCount },
    ] as const;
    const dateLabel = dateOptions.find(o => o.value === dateFilter)?.label ?? 'All';
    const dateActive = dateFilter !== 'all';

    return (
      <div className={`flex items-center gap-2 ${variant === 'desktop' ? 'mb-3' : 'flex-wrap'}`}>
        <TypeFilter
          selectedTypes={settings?.articleTypes || ARTICLE_TYPES.map(t => t.id)}
          onTypesChange={handleTypesChange}
          isOpen={showTypeFilter}
          onToggle={() => setShowTypeFilter(!showTypeFilter)}
          variant="inline"
        />

        {/* Date filter dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            className={`btn-nav inline-flex items-center gap-1.5 ${dateActive ? 'active' : ''}`}
            onClick={() => setDateDropdownOpen(o => !o)}
          >
            {dateLabel}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.45 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {dateDropdownOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 999 }} onClick={() => setDateDropdownOpen(false)} />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  backgroundColor: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '8px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                  zIndex: 1000,
                  minWidth: '140px',
                  overflow: 'hidden',
                  padding: '4px 0',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {dateOptions.map(opt => {
                  const isActive = dateFilter === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => { setDateFilter(opt.value); setDateDropdownOpen(false); }}
                      className={`dropdown-item${isActive ? ' dropdown-item--selected' : ''}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        padding: '6px 12px',
                        fontSize: '13px',
                        fontWeight: isActive ? 600 : 400,
                        color: isActive ? 'var(--color-ink)' : 'var(--color-ink-soft)',
                        border: 'none',
                        cursor: 'pointer',
                        letterSpacing: '0.02em',
                        textAlign: 'left',
                        gap: '12px',
                      }}
                    >
                      <span>{opt.label}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        {opt.count !== null && (
                          <span style={{ fontSize: '11px', opacity: 0.5 }}>({opt.count})</span>
                        )}
                        {isActive && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {mainFilter !== 'archive' && (
          <button
            className="btn-nav"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-ink-soft)' }}
            onClick={handleArchiveAll}
            disabled={archiveAllSaving}
            title={archiveAllSaving ? 'Saving — please don\'t refresh' : markAllReadTitle}
          >
            <FontAwesomeIcon icon={faCircleCheck} className="w-3.5 h-3.5 mr-1" aria-hidden />
            {archiveAllSaving ? 'Saving…' : <>Mark All Read {archiveAllCount > 0 && <span className="text-[10px] opacity-75">({archiveAllCount})</span>}</>}
          </button>
        )}
      </div>
    );
  };

  // Mobile layout
  if (isMobile) {
    return (
      <div className="mb-2 flex flex-col gap-3 md:hidden px-3">
        {renderSearchRow()}
        {renderDiscoverFilters()}
        {renderMainFilters()}
        {renderDateFilters()}
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="hidden md:block">
      <div className="max-w-7xl mx-auto px-4" style={{ position: 'sticky', top: 0, zIndex: 50, backgroundColor: 'var(--color-bg)', paddingTop: '2rem', paddingBottom: '0.75rem' }}>
        <div className="mb-3" style={{ marginTop: '-1rem' }}>
          {renderSearchRow()}
        </div>
        {renderDiscoverFilters()}
        {renderMainFilters()}
        {renderDateFilters()}
      </div>
    </div>
  );
});

export default FilterBar;
