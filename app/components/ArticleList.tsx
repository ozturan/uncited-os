'use client';

import React, { memo, useState, useCallback, useEffect, useRef } from 'react';
import { Entry, Catalog, UserSettings } from '@/lib/types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar as faStarSolid, faSearch, faInbox as faInboxEmpty } from '@fortawesome/free-solid-svg-icons';
import { detectPaperType, getPaperTypeBadgeColor, formatAuthorLastName, formatPublicationDate, getJournalLogo } from '@/lib/paperUtils';
import SwipeableArticleCard from './SwipeableArticleCard';
import ArticleCardContent from './ArticleCardContent';
import ArticleSkeleton from './ArticleSkeleton';

interface CardItemProps {
  entry: Entry;
  index: number;
  selectedIndex: number;
  isActualMobile: boolean;
  mainFilter: 'unread' | 'archive' | 'starred' | 'discover';
  readSet: Set<string>;
  starredSet: Set<string>;
  readSetCanonical?: Set<string>;
  starredSetCanonical?: Set<string>;
  settings: UserSettings | undefined;
  lastVisit: string | undefined;
  catalog: Catalog | null;
  expandedAbstracts: Set<string>;
  setExpandedAbstracts: React.Dispatch<React.SetStateAction<Set<string>>>;
  copiedLinkForId: string | null;
  setCopiedLinkForId: React.Dispatch<React.SetStateAction<string | null>>;
  copiedRefManagerForId: string | null;
  onSwipeRight: (entryId: string, canonicalId?: string) => void;
  onSwipeLeft: (entryId: string, canonicalId?: string) => void;
  onToggleStar: (entryId: string, canonicalId?: string) => void;
  onToggleRead: (entryId: string, canonicalId?: string) => void;
  onJournalClick: (journalId: string) => void;
}

const CardItem = memo(function CardItem({
  entry, index, selectedIndex, isActualMobile, mainFilter,
  readSet, starredSet, readSetCanonical, starredSetCanonical,
  settings, lastVisit, catalog,
  expandedAbstracts, setExpandedAbstracts,
  copiedLinkForId, setCopiedLinkForId, copiedRefManagerForId,
  onSwipeRight, onSwipeLeft, onToggleStar, onToggleRead,
  onJournalClick,
}: CardItemProps) {
  // Canonical-aware star/read check. Prefers canonical_id when both
  // the entry has one AND the user's canonical set is populated.
  const isStarred = starredSet.has(entry.id)
    || (entry.canonicalId ? (starredSetCanonical?.has(entry.canonicalId) ?? false) : false);
  const isRead = readSet.has(entry.id)
    || (entry.canonicalId ? (readSetCanonical?.has(entry.canonicalId) ?? false) : false);
  const paperType = detectPaperType(entry);
  const badgeColor = getPaperTypeBadgeColor(paperType);
  const authorLastName = formatAuthorLastName(entry.authors);
  const formattedDate = formatPublicationDate(entry.published, entry.availableOnline);

  let logo = '';
  if (entry.journalId && catalog) {
    const journal = catalog.disciplines
      .flatMap(d => d.journals)
      .find(j => j.id === entry.journalId);
    logo = getJournalLogo(journal?.logo, entry.journal, entry.link);
  } else {
    logo = getJournalLogo(undefined, entry.journal, entry.link);
  }

  const swipeRightAction = settings?.swipeRightAction || 'archive';

  return (
    <SwipeableArticleCard
      key={entry.id}
      entry={entry}
      isMobile={isActualMobile}
      index={index}
      selectedIndex={selectedIndex}
      mainFilter={mainFilter}
      showSwipeIndicators={isActualMobile}
      swipeRightAction={swipeRightAction}
      onSwipeRight={swipeRightAction === 'archive'
        ? onSwipeRight
        : onSwipeLeft}
      onSwipeLeft={swipeRightAction === 'archive'
        ? onSwipeLeft
        : onSwipeRight}
    >
      <ArticleCardContent
        entry={entry}
        isStarred={isStarred}
        isRead={isRead}
        showThumbnails={settings?.showThumbnails !== false}
        defaultReferenceManager={settings?.defaultReferenceManager || 'mendeley'}
        lastVisit={lastVisit}
        paperType={paperType}
        badgeColor={badgeColor}
        authorLastName={authorLastName}
        formattedDate={formattedDate}
        logo={logo}
        expandedAbstracts={expandedAbstracts}
        setExpandedAbstracts={setExpandedAbstracts}
        copiedLinkForId={copiedLinkForId}
        setCopiedLinkForId={setCopiedLinkForId}
        copiedRefManagerForId={copiedRefManagerForId}
        showStarCount={false}
        starCount={entry.starCount || 0}
        onJournalClick={onJournalClick}
        disableJournalClick={mainFilter === 'discover'}
        onToggleStar={onToggleStar}
        onToggleRead={onToggleRead}
      />
    </SwipeableArticleCard>
  );
}, (prev, next) => {
  const id = prev.entry.id;
  const cid = prev.entry.canonicalId;
  const prevRead = prev.readSet.has(id) || (cid ? (prev.readSetCanonical?.has(cid) ?? false) : false);
  const nextRead = next.readSet.has(id) || (cid ? (next.readSetCanonical?.has(cid) ?? false) : false);
  const prevStarred = prev.starredSet.has(id) || (cid ? (prev.starredSetCanonical?.has(cid) ?? false) : false);
  const nextStarred = next.starredSet.has(id) || (cid ? (next.starredSetCanonical?.has(cid) ?? false) : false);
  return (
    prev.entry === next.entry &&
    prevRead === nextRead &&
    prevStarred === nextStarred &&
    prev.index === next.index &&
    prev.selectedIndex === next.selectedIndex &&
    prev.expandedAbstracts === next.expandedAbstracts &&
    prev.copiedLinkForId === next.copiedLinkForId &&
    prev.copiedRefManagerForId === next.copiedRefManagerForId &&
    prev.settings === next.settings &&
    prev.mainFilter === next.mainFilter &&
    prev.isActualMobile === next.isActualMobile
  );
});

interface ArticleListProps {
  filteredEntries: Entry[];
  paginatedEntries: Entry[];
  hasMoreEntries: boolean;
  displayLimit: number;
  setDisplayLimit: React.Dispatch<React.SetStateAction<number>>;
  mainFilter: 'unread' | 'archive' | 'starred' | 'discover';
  sortMode: string;
  search: string;
  entriesLoading: boolean;
  discoverLoading: boolean;
  discoverSearchLoading: boolean;
  isDiscoverSearchActive: boolean;
  recommendationsLoading: boolean;
  // First-paint gate: keep the main feed in its skeleton until the first
  // viewport of cards has been prewarmed (affiliation + enrich), so the feed
  // reveals fully assembled instead of resolving each card piecemeal on scroll.
  firstViewportReady: boolean;
  user: any;
  stateLoadedOnce: boolean;
  loading: boolean;
  followsCount: number;
  onOpenSidebar: () => void;
  starredCount: number;
  settings: UserSettings | undefined;
  lastVisit: string | undefined;
  readSet: Set<string>;
  starredSet: Set<string>;
  readSetCanonical?: Set<string>;
  starredSetCanonical?: Set<string>;
  selectedIndex: number;
  isActualMobile: boolean;
  catalog: Catalog | null;
  discoverTotalCount: number;
  switchMainFilter: (filter: 'unread' | 'archive' | 'starred' | 'discover') => void;
  onSwipeRight: (entryId: string, canonicalId?: string) => void;
  onSwipeLeft: (entryId: string, canonicalId?: string) => void;
  onToggleStar: (entryId: string, canonicalId?: string) => void;
  onToggleRead: (entryId: string, canonicalId?: string) => void;
  onJournalClick: (journalId: string) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  scrollContainerEl?: HTMLDivElement | null;
}

const ArticleList = memo(function ArticleList({
  filteredEntries,
  paginatedEntries,
  hasMoreEntries,
  displayLimit,
  setDisplayLimit,
  mainFilter,
  sortMode,
  search,
  entriesLoading,
  discoverLoading,
  discoverSearchLoading,
  isDiscoverSearchActive,
  recommendationsLoading,
  firstViewportReady,
  user,
  stateLoadedOnce,
  loading,
  followsCount,
  onOpenSidebar,
  starredCount,
  settings,
  lastVisit,
  readSet,
  starredSet,
  readSetCanonical,
  starredSetCanonical,
  selectedIndex,
  isActualMobile,
  catalog,
  discoverTotalCount,
  switchMainFilter,
  onSwipeRight,
  onSwipeLeft,
  onToggleStar,
  onToggleRead,
  onJournalClick,
  scrollContainerRef,
  scrollContainerEl,
}: ArticleListProps) {
  // Local UI state
  const [expandedAbstracts, setExpandedAbstracts] = useState<Set<string>>(new Set());
  const [copiedLinkForId, setCopiedLinkForId] = useState<string | null>(null);
  const [copiedRefManagerForId, setCopiedRefManagerForId] = useState<string | null>(null);

  // Infinite scroll: reveal the whole list 100 at a time as the user scrolls,
  // instead of stopping behind a "Load More" button at the first 100. A sentinel
  // just below the list auto-bumps displayLimit when it nears the viewport.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMoreEntries) return;
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries.some(e => e.isIntersecting)) setDisplayLimit(prev => prev + 100); },
      { root: scrollContainerEl || null, rootMargin: '800px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMoreEntries, displayLimit, scrollContainerEl, setDisplayLimit]);

  // Note: the OpenAlex enrich cache (Free-PDF / topics, and author socials) is
  // warmed lazily per visible card by the author line (AuthorAffiliation) as it
  // scrolls into view, which also serves the expanded detail. No eager
  // whole-list prefetch — that double-fetched and warmed cards never seen.

  // First-load skeleton for the main (non-discover) feed: the app shell now
  // renders before /api/articles resolves, so show placeholder cards instead of
  // flashing the "No papers" empty state while the initial fetch is in flight.
  const showMainFeedLoading = mainFilter !== 'discover' && entriesLoading && paginatedEntries.length === 0;
  const showEmptyNonDiscover = filteredEntries.length === 0 && mainFilter !== 'discover' && !showMainFeedLoading;
  const showDiscoverMinStars = mainFilter === 'discover' && starredCount < 3;
  // Only fall back to the skeleton when there's nothing to show yet. If a prior/cached
  // list is already on screen (e.g. returning to a tab, or revalidating), keep it
  // rendered during the refetch instead of blanking the whole feed into a skeleton.
  const showDiscoverLoading = mainFilter === 'discover' && (discoverLoading || discoverSearchLoading) && paginatedEntries.length === 0;
  const showRecommendationsLoading = (sortMode === 'for-you' || sortMode === 'my-field') && recommendationsLoading && paginatedEntries.length === 0;
  // First-paint: entries have arrived but the first viewport isn't prewarmed yet.
  // Hold the skeleton so the feed reveals fully assembled (no per-card pop-in).
  // Only the main feed is gated; discover/recs have their own loading states.
  const mainFeedHydrating = mainFilter !== 'discover' && paginatedEntries.length > 0 && !firstViewportReady;
  const showVirtualList = !showEmptyNonDiscover && !showDiscoverMinStars && !showDiscoverLoading && !showRecommendationsLoading && !mainFeedHydrating && paginatedEntries.length > 0;

  return (
    <>
      {showEmptyNonDiscover && (
        <div className="text-center py-20 px-4" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>
          {user && stateLoadedOnce && !loading && followsCount === 0 ? (
            <div className="flex flex-col items-center gap-4 max-w-md mx-auto">
              <FontAwesomeIcon icon={faInboxEmpty} className="w-12 h-12 opacity-40" style={{ color: 'var(--color-ink-soft)' }} aria-hidden />
              <div>
                <div className="text-base font-medium mb-2" style={{ color: 'var(--color-ink)' }}>Follow some journals to get started</div>
                <div className="text-sm mb-4">Browse our catalog and follow journals in your field to see new papers here.</div>
                <button onClick={onOpenSidebar} className="px-4 py-2 text-sm font-medium transition-colors rounded-lg text-white" style={{ backgroundColor: 'var(--color-accent)' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--color-accent)'}>Browse Journals</button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 max-w-md mx-auto">
              <FontAwesomeIcon icon={search.length > 0 ? faSearch : faInboxEmpty} className="w-12 h-12 opacity-40" style={{ color: 'var(--color-ink-soft)' }} aria-hidden />
              {(() => {
                const isKwFilter = sortMode.startsWith('kw:');
                const kwFilterName = isKwFilter ? (settings?.keywordFilters?.find(f => f.id === sortMode.slice(3))?.name || 'this filter') : null;
                return (
                  <div>
                    <div className="text-base font-medium mb-2" style={{ color: 'var(--color-ink)' }}>
                      {search.length > 0 ? 'No papers match your search' : isKwFilter ? `No papers match "${kwFilterName}"` : mainFilter === 'unread' ? 'No unread papers' : mainFilter === 'starred' ? 'No starred papers' : 'No archived papers'}
                    </div>
                    <div className="text-sm">
                      {search.length > 0 ? 'Try different keywords or clear your search' : isKwFilter ? 'No papers in the current view contain these keywords.' : mainFilter === 'unread' ? 'Papers you mark as read or star will appear in their respective sections.' : mainFilter === 'starred' ? 'Star papers to save them for later reading.' : 'Papers you mark as read will appear here.'}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Discover description */}
      {mainFilter === 'discover' && starredCount >= 3 && paginatedEntries.length > 0 && (
        <div className="px-3 md:px-4 pb-4">
          <p style={{ fontSize: '14px', color: 'var(--color-ink-soft)', fontWeight: 400, lineHeight: '1.6', maxWidth: '800px' }}>
            Explore relevant research beyond your followed journals. Curated based on your interests.
          </p>
        </div>
      )}

      {/* Discover keyword filter empty */}
      {mainFilter === 'discover' && sortMode.startsWith('kw:') && filteredEntries.length === 0 && !discoverLoading && (
        <div className="text-center py-20 px-4" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>
          <div className="flex flex-col items-center gap-4 max-w-md mx-auto">
            <FontAwesomeIcon icon={faSearch} className="w-12 h-12 opacity-40" style={{ color: 'var(--color-ink-soft)' }} aria-hidden />
            <div>
              <div className="text-base font-medium mb-2" style={{ color: 'var(--color-ink)' }}>No papers match &ldquo;{settings?.keywordFilters?.find(f => f.id === sortMode.slice(3))?.name || 'this filter'}&rdquo;</div>
              <div className="text-sm">No matches in unfollowed journals from the past 60 days.</div>
            </div>
          </div>
        </div>
      )}

      {/* Discover search empty */}
      {mainFilter === 'discover' && isDiscoverSearchActive && filteredEntries.length === 0 && !discoverSearchLoading && (
        <div className="text-center py-20 px-4" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>
          <div className="flex flex-col items-center gap-4 max-w-md mx-auto">
            <FontAwesomeIcon icon={faSearch} className="w-12 h-12 opacity-40" style={{ color: 'var(--color-ink-soft)' }} aria-hidden />
            <div>
              <div className="text-base font-medium mb-2" style={{ color: 'var(--color-ink)' }}>No papers found</div>
              <div className="text-sm">Try different keywords or clear your search.</div>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      {showDiscoverMinStars ? (
        <div className="text-center py-20 px-4" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>
          <div className="flex flex-col items-center gap-4 max-w-md mx-auto">
            <FontAwesomeIcon icon={faStarSolid} className="w-12 h-12 opacity-40" style={{ color: 'var(--color-ink-soft)' }} aria-hidden />
            <div>
              <div className="text-base font-medium mb-2" style={{ color: 'var(--color-ink)' }}>Personalize your feed</div>
              <div className="text-sm mb-6">Star at least 3 papers you find interesting to help us discover more relevant research for you.</div>
              <button onClick={() => switchMainFilter('unread')} className="px-4 py-2 text-sm font-medium transition-colors rounded-lg text-white" style={{ backgroundColor: 'var(--color-accent)' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--color-accent-hover)'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--color-accent)'}>Browse Papers</button>
            </div>
          </div>
        </div>
      ) : showDiscoverLoading || showRecommendationsLoading || showMainFeedLoading || mainFeedHydrating ? (
        <div className="px-3 md:px-4">
          <ArticleSkeleton count={5} />
        </div>
      ) : showVirtualList ? (
        <div className="px-3 md:px-4 space-y-2 md:space-y-4">
          {paginatedEntries.map((entry, index) => (
            <CardItem
              key={entry.id}
              entry={entry}
              index={index}
              selectedIndex={selectedIndex}
              isActualMobile={isActualMobile}
              mainFilter={mainFilter}
              readSet={readSet}
              starredSet={starredSet}
              readSetCanonical={readSetCanonical}
              starredSetCanonical={starredSetCanonical}
              settings={settings}
              lastVisit={lastVisit}
              catalog={catalog}
              expandedAbstracts={expandedAbstracts}
              setExpandedAbstracts={setExpandedAbstracts}
              copiedLinkForId={copiedLinkForId}
              setCopiedLinkForId={setCopiedLinkForId}
              copiedRefManagerForId={copiedRefManagerForId}
              onSwipeRight={onSwipeRight}
              onSwipeLeft={onSwipeLeft}
              onToggleStar={onToggleStar}
              onToggleRead={onToggleRead}
              onJournalClick={onJournalClick}
            />
          ))}

          {/* Infinite-scroll sentinel: when it nears the viewport the effect
              above loads the next 100. The button below is a manual fallback. */}
          {hasMoreEntries && <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />}

          {/* Load More Button (fallback / explicit) */}
          {hasMoreEntries && (
            <div className="flex justify-center py-8">
              <button
                onClick={() => setDisplayLimit(prev => prev + 100)}
                className="px-6 py-3 text-sm transition-colors border"
                style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)', borderColor: 'var(--color-border)', fontWeight: 400, letterSpacing: '0.02em', borderRadius: '6px' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-bg)'; e.currentTarget.style.borderColor = 'var(--color-ink-soft)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-surface)'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}
              >
                Load More ({Math.min(100, filteredEntries.length - displayLimit)} more)
              </button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
});

export default ArticleList;
