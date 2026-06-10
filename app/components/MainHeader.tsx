'use client';

import React, { memo } from 'react';
import { Catalog } from '@/lib/types';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faCompass, faHome } from '@fortawesome/free-solid-svg-icons';
import { getJournalLogo } from '@/lib/paperUtils';

interface MainHeaderProps {
  showSettingsDashboard: boolean;
  setShowSettingsDashboard: (v: boolean) => void;
  view: 'all' | 'discover';
  selectedJournalId: string | null;
  follows: string[];
  user: any;
  catalog: Catalog | null;
  mainFilter: 'unread' | 'archive' | 'starred' | 'discover';
  discoverSearch: string;
  discoverSearchLoading: boolean;
  discoverSearchResults: any[] | null;
  onToggleFollowJournal: (journalId: string) => void;
  onOpenSidebar: () => void;
}

// Clean journal name by removing leading/trailing quotes
const cleanJournalName = (name: string): string => {
  if (!name) return name;
  return name.replace(/^["']+|["']+$/g, '').trim();
};

function MainHeaderInner({
  showSettingsDashboard,
  setShowSettingsDashboard,
  view,
  selectedJournalId,
  follows,
  user,
  catalog,
  mainFilter,
  discoverSearch,
  discoverSearchLoading,
  discoverSearchResults,
  onToggleFollowJournal,
  onOpenSidebar,
}: MainHeaderProps) {

  const getSelectedJournalName = () => {
    if (!selectedJournalId || !catalog) {
      if (view === 'discover' || mainFilter === 'discover') return 'Discover';
      return 'Home';
    }
    for (const discipline of catalog.disciplines) {
      const journal = discipline.journals.find(j => j.id === selectedJournalId);
      if (journal) return cleanJournalName(journal.name);
    }
    if (view === 'discover' || mainFilter === 'discover') return 'Discover';
    return 'Home';
  };

  const getHeaderIcon = () => {
    if (view === 'discover' || mainFilter === 'discover') return faCompass;
    if (!selectedJournalId) return faHome;
    return null;
  };

  const getSelectedJournalLogo = () => {
    if (!selectedJournalId || !catalog) return null;
    for (const discipline of catalog.disciplines) {
      const journal = discipline.journals.find(j => j.id === selectedJournalId);
      if (journal) {
        return getJournalLogo(journal.logo, journal.name, journal.rss);
      }
    }
    return null;
  };

  const getSelectedJournalWebsite = () => {
    if (!selectedJournalId || !catalog) return null;
    for (const discipline of catalog.disciplines) {
      const journal = discipline.journals.find(j => j.id === selectedJournalId);
      if (journal) {
        try {
          const url = new URL(journal.rss);
          let hostname = url.hostname;
          hostname = hostname.replace(/^feeds?\./, '').replace(/^rss?\./, '');
          if (hostname.includes('nature.com')) {
            return 'https://www.nature.com';
          } else if (hostname.includes('cell.com')) {
            return 'https://www.cell.com';
          } else if (hostname.includes('sciencedirect.com')) {
            return 'https://www.sciencedirect.com';
          } else if (hostname.includes('biomedcentral.com')) {
            return 'https://www.biomedcentral.com';
          } else if (hostname.includes('plos.org')) {
            return 'https://journals.plos.org';
          } else if (hostname.includes('pnas.org')) {
            return 'https://www.pnas.org';
          } else if (hostname.includes('arxiv.org')) {
            return 'https://arxiv.org';
          } else if (hostname.includes('biorxiv.org')) {
            return 'https://www.biorxiv.org';
          } else {
            hostname = hostname.replace(/^www\./, '');
            return `https://www.${hostname}`;
          }
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  return (
    <header className="border-b px-3 md:px-6" style={{ position: 'sticky', top: 0, zIndex: 10, height: '80px', display: 'flex', alignItems: 'center', backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between" style={{ width: '100%', minWidth: 0 }}>
        <div className="flex items-center gap-2 flex-1" style={{ minWidth: 0 }}>
          {/* Mobile menu button */}
          <button
            onClick={onOpenSidebar}
            className="md:hidden p-2 -ml-2"
            style={{ color: 'var(--color-ink-soft)', flexShrink: 0 }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          {showSettingsDashboard ? (
            <h1 style={{ fontSize: '22px', fontWeight: 300, color: 'var(--color-ink)', lineHeight: '1.75rem', margin: 0 }}>
              Settings
            </h1>
          ) : (
            <>
              {selectedJournalId && (
                <div className="flex items-center gap-1.5" style={{ flexShrink: 0 }}>
                  <button
                    onClick={() => onToggleFollowJournal(selectedJournalId)}
                    className="p-1.5 rounded transition-colors text-xs font-medium"
                    style={{
                      backgroundColor: follows.includes(selectedJournalId)
                        ? 'var(--color-surface)'
                        : 'var(--color-accent)',
                      color: follows.includes(selectedJournalId)
                        ? 'var(--color-ink)'
                        : 'white',
                      border: `1px solid ${follows.includes(selectedJournalId) ? 'var(--color-border)' : 'var(--color-accent)'}`,
                    }}
                    title={follows.includes(selectedJournalId) ? 'Unfollow journal' : 'Follow journal'}
                  >
                    {follows.includes(selectedJournalId) ? 'Following' : 'Follow'}
                  </button>
                  <img
                    src={getSelectedJournalLogo() || ''}
                    alt={getSelectedJournalName()}
                    style={{ width: '20px', height: '20px' }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                </div>
              )}
              {selectedJournalId && getSelectedJournalWebsite() ? (
                <h1 className="truncate" style={{ fontSize: '18px', fontWeight: 300, color: 'var(--color-ink)', lineHeight: '1.5rem', margin: 0, display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  {getHeaderIcon() && <FontAwesomeIcon icon={getHeaderIcon()!} className="w-4 h-4 flex-shrink-0" />}
                  <a
                    href={getSelectedJournalWebsite() || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline truncate"
                    style={{ color: 'inherit', minWidth: 0 }}
                  >
                    {getSelectedJournalName()}
                  </a>
                </h1>
              ) : (
                <h1 className="truncate" style={{ fontSize: '18px', fontWeight: 300, color: 'var(--color-ink)', lineHeight: '1.5rem', margin: 0, display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  {getHeaderIcon() && <FontAwesomeIcon icon={getHeaderIcon()!} className="w-4 h-4 flex-shrink-0" />}
                  <span className="truncate" style={{ minWidth: 0 }}>{getSelectedJournalName()}</span>
                </h1>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 md:gap-3" style={{ flexShrink: 0 }}>
          {user && (
            <>
              <span className="hidden md:inline text-sm" style={{ color: 'var(--color-ink-soft)', fontWeight: 400 }}>{user.email}</span>
              <button
                onClick={() => {
                  setShowSettingsDashboard(true);
                }}
                className="p-2 transition-colors border rounded-md"
                style={{
                  backgroundColor: showSettingsDashboard ? 'var(--color-accent)' : 'var(--color-surface)',
                  borderColor: showSettingsDashboard ? 'var(--color-accent)' : 'var(--color-border)',
                  color: showSettingsDashboard ? 'white' : 'var(--color-ink)'
                }}
                onMouseEnter={(e) => {
                  if (!showSettingsDashboard) {
                    e.currentTarget.style.backgroundColor = 'var(--color-bg)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!showSettingsDashboard) {
                    e.currentTarget.style.backgroundColor = 'var(--color-surface)';
                  } else {
                    e.currentTarget.style.backgroundColor = 'var(--color-accent)';
                  }
                }}
                title="Settings"
                aria-label="Settings"
              >
                <FontAwesomeIcon icon={faGear} className="w-4 h-4" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

// Memoized so typing in the FilterBar search / starring / reading cards
// doesn't re-render the whole header tree. Its 16 props all come from
// stable refs in page-client.tsx (useCallback + state).
const MainHeader = memo(MainHeaderInner);
export default MainHeader;
