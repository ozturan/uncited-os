'use client';

import { useState, useEffect, useRef } from 'react';
import { UserSettings, KeywordFilter, FieldProfile } from '@/lib/types';
import { ReferenceManager, getReferenceManagerName } from '@/lib/referenceManager';

interface AuthorCandidate {
  authorId: string;
  name: string;
  affiliation: string;
  paperCount: number;
}

// ── Research Profile (My Field) component ─────────────────────────────────────
function ResearchProfile({
  settings,
  onSettingsChange,
}: {
  settings: UserSettings;
  onSettingsChange: (s: UserSettings) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<AuthorCandidate[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const profiles: FieldProfile[] = Array.isArray(settings.field_profiles) ? settings.field_profiles : [];
  const hasLegacyOnly = profiles.length === 0 && settings.field_centroid?.length === 256;

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Debounced search as user types
  const handleQueryChange = (val: string) => {
    setQuery(val);
    setError(null);
    setCandidates([]);
    setDropdownOpen(false);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 2) { setSearchLoading(false); return; }

    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/scholar?q=${encodeURIComponent(val.trim())}`);
        const data = await res.json();
        setCandidates(data.candidates || []);
        setDropdownOpen((data.candidates || []).length > 0);
      } catch {
        setCandidates([]);
      } finally {
        setSearchLoading(false);
      }
    }, 400);
  };

  // User picks a researcher to ADD as another profile (mixed into the centroid)
  const handleSelect = async (author: AuthorCandidate) => {
    setDropdownOpen(false);
    setQuery(author.name);
    setCandidates([]);
    setEmbedLoading(true);
    setError(null);
    setRecentlyAdded(null);

    try {
      const res = await fetch('/api/scholar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorId: author.authorId, name: author.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }
      setRecentlyAdded(author.name);
      setQuery('');
      // Persist the updated profile list + recomputed aggregate centroid.
      await onSettingsChange({
        ...settings,
        field_centroid: data.field_centroid,
        field_centroid_count: data.field_centroid_count,
        field_centroid_updated_at: new Date().toISOString(),
        field_description: data.profile?.description || settings.field_description,
        field_profiles: data.profiles,
      });
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setEmbedLoading(false);
    }
  };

  // Remove one profile (multi-profile mode)
  const handleRemoveOne = async (authorId: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/scholar?authorId=${encodeURIComponent(authorId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to remove'); return; }
      const remaining: FieldProfile[] = data.profiles || [];
      const next = { ...settings };
      if (remaining.length === 0) {
        delete next.field_centroid;
        delete next.field_centroid_count;
        delete next.field_centroid_updated_at;
        delete next.field_description;
        delete next.field_profiles;
      } else {
        next.field_centroid = data.field_centroid;
        next.field_centroid_count = data.field_centroid_count;
        next.field_centroid_updated_at = new Date().toISOString();
        next.field_profiles = remaining;
        next.field_description = remaining[0]?.description;
      }
      await onSettingsChange(next);
    } catch {
      setError('Network error. Please try again.');
    }
  };

  // Remove the legacy single-profile (no field_profiles) — clear everything
  const handleRemoveLegacy = async () => {
    const { field_centroid, field_centroid_count, field_centroid_updated_at, field_description, field_profiles, ...rest } = settings;
    await onSettingsChange(rest as UserSettings);
    setRecentlyAdded(null);
    setQuery('');
    setError(null);
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return iso; }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-[color:var(--color-ink)]">
          Research Profile
        </label>
        <p className="text-xs text-[color:var(--color-ink-soft)]">
          Add one or more researchers from Semantic Scholar — &ldquo;My Field&rdquo; ranks papers by
          similarity to the combined centroid of all of them.
        </p>
      </div>

      {/* Profile list */}
      {profiles.length > 0 && (
        <div className="flex flex-col gap-2">
          {profiles.map(p => (
            <div
              key={p.authorId}
              className="flex flex-col gap-1 px-3 py-2 rounded-lg text-sm"
              style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                  {p.name}
                </span>
                <button
                  onClick={() => handleRemoveOne(p.authorId)}
                  className="text-xs flex-shrink-0"
                  style={{ color: 'var(--color-ink-soft)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
                  title="Remove this researcher from your profile"
                >
                  Remove
                </button>
              </div>
              <div className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                {p.count} publications
                {p.addedAt && <span>{' · added '}{formatDate(p.addedAt)}</span>}
              </div>
              {p.description && (
                <div className="text-xs italic" style={{ color: 'var(--color-ink-soft)' }}>
                  Works on {p.description}.
                </div>
              )}
            </div>
          ))}
          {profiles.length > 1 && (
            <div className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
              My Field = average of {profiles.length} centroids · {settings.field_centroid_count ?? '?'} total publications
              {settings.field_centroid_updated_at && (
                <span>{' · updated '}{formatDate(settings.field_centroid_updated_at)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Legacy single-profile (no field_profiles array) */}
      {hasLegacyOnly && (
        <div
          className="flex flex-col gap-1 px-3 py-2 rounded-lg text-sm"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: 'var(--color-ink)' }}>
              <span style={{ color: 'var(--color-accent)', fontWeight: 500 }}>Active</span>
              {' · '}{settings.field_centroid_count ?? '?'} publications
              <span style={{ color: 'var(--color-ink-soft)' }}>{' · single legacy profile'}</span>
            </span>
            <button
              onClick={handleRemoveLegacy}
              className="text-xs flex-shrink-0"
              style={{ color: 'var(--color-ink-soft)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
            >
              Remove
            </button>
          </div>
          {settings.field_description && (
            <div className="text-xs italic" style={{ color: 'var(--color-ink-soft)' }}>
              You work on {settings.field_description}.
            </div>
          )}
        </div>
      )}

      {/* Recently-added flash */}
      {recentlyAdded && (
        <p className="text-sm" style={{ color: 'var(--color-accent)', fontWeight: 500 }}>
          Added {recentlyAdded} to your profile.
        </p>
      )}

      {/* Search input + dropdown */}
      <div ref={wrapperRef} style={{ position: 'relative' }}>
        <div className="flex gap-2 items-center">
          <div className="flex-1" style={{ position: 'relative' }}>
            <input
              type="text"
              value={query}
              onChange={e => handleQueryChange(e.target.value)}
              onFocus={() => { if (candidates.length > 0) setDropdownOpen(true); }}
              placeholder={profiles.length > 0 || hasLegacyOnly ? 'Add another researcher…' : 'Search by name on Semantic Scholar…'}
              disabled={embedLoading}
              className="w-full px-3 py-2 text-sm"
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                backgroundColor: 'var(--color-surface)',
                color: 'var(--color-ink)',
                fontSize: '14px',
                opacity: embedLoading ? 0.6 : 1,
              }}
            />
            {/* Inline search spinner */}
            {(searchLoading || embedLoading) && (
              <span
                className="absolute right-3 top-1/2 -translate-y-1/2 inline-block w-3 h-3 rounded-full border-2 animate-spin"
                style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }}
              />
            )}
          </div>
        </div>

        {/* Candidates dropdown */}
        {dropdownOpen && candidates.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
              zIndex: 1000,
              overflow: 'hidden',
            }}
          >
            {candidates.map(author => (
              <button
                key={author.authorId}
                onClick={() => handleSelect(author)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  width: '100%',
                  padding: '8px 12px',
                  border: 'none',
                  borderBottom: '1px solid var(--color-border)',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  gap: '2px',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-bg)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-ink)' }}>
                  {author.name}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--color-ink-soft)' }}>
                  {[author.affiliation, author.paperCount > 0 ? `${author.paperCount} papers` : null]
                    .filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* No results */}
        {dropdownOpen && candidates.length === 0 && !searchLoading && query.trim().length >= 2 && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              backgroundColor: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '13px',
              color: 'var(--color-ink-soft)',
              zIndex: 1000,
            }}
          >
            No authors found for &ldquo;{query}&rdquo;
          </div>
        )}
      </div>

      {embedLoading && (
        <p className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
          Fetching publications and building your profile… this may take a few seconds.
        </p>
      )}
      {error && <p className="text-xs" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>}
      {profiles.length === 0 && !hasLegacyOnly && !embedLoading && (
        <p className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
          Researcher names + a 256-dim centroid + a short LLM-generated description are stored
          in your private settings (RLS-scoped to you only).
        </p>
      )}
    </div>
  );
}

// ── Keyword Filters component ──────────────────────────────────────────────────
function KeywordFiltersSection({
  settings,
  onSettingsChange,
}: {
  settings: UserSettings;
  onSettingsChange: (s: UserSettings) => Promise<void>;
}) {
  const [filters, setFilters] = useState<KeywordFilter[]>(settings.keywordFilters || []);
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [logic, setLogic] = useState<'AND' | 'OR'>('OR');
  const [fields, setFields] = useState<'both' | 'title' | 'abstract'>('both');

  // Sync internal state if props change externally
  useEffect(() => {
    setFilters(settings.keywordFilters || []);
  }, [settings.keywordFilters]);

  const handleAddClick = () => {
    setIsEditing(true);
    setEditingId(null);
    setName('');
    setKeywords('');
    setLogic('OR');
    setFields('both');
  };

  const handleEditClick = (f: KeywordFilter) => {
    setIsEditing(true);
    setEditingId(f.id);
    setName(f.name);
    setKeywords(f.keywords);
    setLogic(f.logic || 'OR');
    setFields(f.fields || 'both');
  };

  const handleSave = async () => {
    if (!name.trim() || !keywords.trim()) return;

    let newFilters = [...filters];
    if (editingId) {
      newFilters = newFilters.map(f => f.id === editingId ? { ...f, name: name.trim(), keywords: keywords.trim(), logic, fields } : f);
    } else {
      const newFilter: KeywordFilter = {
        id: crypto.randomUUID(),
        name: name.trim(), // max 2 words ideally, but we won't strictly block longer
        keywords: keywords.trim(),
        logic,
        fields
      };
      newFilters.push(newFilter);
    }

    setFilters(newFilters);
    setIsEditing(false);
    await onSettingsChange({ ...settings, keywordFilters: newFilters });
  };

  const handleRemove = async (id: string) => {
    const newFilters = filters.filter(f => f.id !== id);
    setFilters(newFilters);
    await onSettingsChange({ ...settings, keywordFilters: newFilters });
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-[color:var(--color-ink)]">
          Saved Keyword Filters
        </label>
        <p className="text-xs text-[color:var(--color-ink-soft)]">
          Create custom keyword searches that appear alongside &lsquo;My Field&rsquo; and &lsquo;Recent Related&rsquo; in your feed dropdown.
        </p>
      </div>

      {filters.length > 0 && !isEditing && (
        <div className="flex flex-col gap-2">
          {filters.map(f => (
            <div key={f.id} className="flex flex-col md:flex-row md:items-center justify-between gap-2 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
              <div className="flex flex-col">
                <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>{f.name}</span>
                <span className="text-xs" style={{ color: 'var(--color-ink-soft)', lineHeight: 1.5 }}>
                  {f.fields === 'both' ? 'Title & Abstract' : f.fields === 'title' ? 'Title only' : 'Abstract only'} · {f.logic} match logic<br />
                  <span style={{ opacity: 0.8 }}>Keywords: {f.keywords}</span>
                </span>
              </div>
              <div className="flex gap-2 self-start md:self-auto mt-1 md:mt-0">
                <button onClick={() => handleEditClick(f)} className="text-xs" style={{ color: 'var(--color-ink)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>Edit</button>
                <button onClick={() => handleRemove(f.id)} className="text-xs" style={{ color: 'var(--color-error, #ef4444)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!isEditing ? (
        <button
          onClick={handleAddClick}
          className="text-sm px-3 py-2 rounded-lg self-start transition-colors"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-ink)' }}
        >
          + Add Filter
        </button>
      ) : (
        <div className="flex flex-col gap-4 p-4 rounded-lg" style={{ backgroundColor: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--color-ink)' }}>Filter Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CRISPR (max 2 words recommended)" className="text-sm px-3 py-2 rounded border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--color-ink)' }}>Keywords</label>
            <textarea value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="e.g. crispr, cas9, gene editing" rows={2} className="text-sm px-3 py-2 rounded border w-full resize-none" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' }} />
            <span className="text-[10px]" style={{ color: 'var(--color-ink-soft)' }}>Separate keywords with commas or spaces.</span>
          </div>

          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-ink)' }}>Search In</label>
              <select value={fields} onChange={e => setFields(e.target.value as any)} className="text-sm px-2 py-2 rounded border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' }}>
                <option value="both">Title & Abstract</option>
                <option value="title">Title Only</option>
                <option value="abstract">Abstract Only</option>
              </select>
            </div>

            <div className="flex flex-col gap-1 flex-1">
              <label className="text-xs font-medium" style={{ color: 'var(--color-ink)' }}>Match Logic</label>
              <select value={logic} onChange={e => setLogic(e.target.value as any)} className="text-sm px-2 py-2 rounded border" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)', color: 'var(--color-ink)' }}>
                <option value="OR">OR (match ANY keyword)</option>
                <option value="AND">AND (match ALL keywords)</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-1 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
            <button onClick={handleCancel} className="text-sm px-4 py-2 rounded" style={{ color: 'var(--color-ink-soft)', backgroundColor: 'transparent' }}>Cancel</button>
            <button onClick={handleSave} disabled={!name.trim() || !keywords.trim()} className="text-sm px-4 py-2 rounded" style={{ backgroundColor: name.trim() && keywords.trim() ? 'var(--color-accent)' : 'var(--color-border)', color: 'white', transition: 'background-color 0.2s' }}>Save Filter</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SettingsProps {
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => Promise<void>;
  activeTab?: 'general' | 'reading' | 'filters' | 'system';
}

export default function Settings({ settings, onSettingsChange, activeTab = 'general' }: SettingsProps) {


  const handleOrganizationChange = async (organization: 'discipline' | 'publisher' | 'recent') => {
    await onSettingsChange({
      ...settings,
      sidebarOrganization: organization
    });
  };



  const handleReferenceManagerChange = async (manager: ReferenceManager) => {
    await onSettingsChange({
      ...settings,
      defaultReferenceManager: manager
    });
  };

  const referenceManagers: ReferenceManager[] = ['mendeley', 'zotero', 'bibtex', 'endnote'];
  const currentManager = settings.defaultReferenceManager || 'mendeley';

  return (
    <div className="flex flex-col gap-6">
      {activeTab === 'general' && (<>
        {/* Theme Selection */}
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-[color:var(--color-ink)]">
            Theme
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'light');
                await onSettingsChange({ ...settings, theme: 'light' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'light' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'light' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'light' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Light
            </button>
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'dark');
                await onSettingsChange({ ...settings, theme: 'dark' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'dark' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'dark' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'dark' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Dark
            </button>
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'sepia');
                await onSettingsChange({ ...settings, theme: 'sepia' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'sepia' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'sepia' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'sepia' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Sepia
            </button>
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'retro');
                await onSettingsChange({ ...settings, theme: 'retro' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'retro' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'retro' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'retro' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Retro
            </button>
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'blue');
                await onSettingsChange({ ...settings, theme: 'blue' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'blue' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'blue' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'blue' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Blue
            </button>
            <button
              onClick={async () => {
                document.documentElement.setAttribute('data-theme', 'coral');
                await onSettingsChange({ ...settings, theme: 'coral' });
              }}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.theme === 'coral' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.theme === 'coral' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.theme === 'coral' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Coral
            </button>
          </div>
        </div>


        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--color-border)' }}></div>
        {/* Show Thumbnails */}
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-[color:var(--color-ink)]">
            Article Thumbnails
          </label>
          <div className="flex gap-2">
            <button
              onClick={async () => await onSettingsChange({ ...settings, showThumbnails: true })}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.showThumbnails !== false ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.showThumbnails !== false ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.showThumbnails !== false ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Show
            </button>
            <button
              onClick={async () => await onSettingsChange({ ...settings, showThumbnails: false })}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.showThumbnails === false ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.showThumbnails === false ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.showThumbnails === false ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Hide
            </button>
          </div>
        </div>



      </>)}
      {activeTab === 'reading' && (<>
        {/* Sidebar Organization Section */}
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-[color:var(--color-ink)]">
            Organize sidebar by
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => handleOrganizationChange('discipline')}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.sidebarOrganization === 'discipline' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.sidebarOrganization === 'discipline' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.sidebarOrganization === 'discipline' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Discipline
            </button>
            <button
              onClick={() => handleOrganizationChange('publisher')}
              className="px-3 py-2 text-sm transition-all text-center"
              style={{
                backgroundColor: settings.sidebarOrganization === 'publisher' ? 'var(--color-accent)' : 'var(--color-surface)',
                color: settings.sidebarOrganization === 'publisher' ? 'white' : 'var(--color-ink)',
                border: '1px solid var(--color-border)',
                fontWeight: settings.sidebarOrganization === 'publisher' ? 500 : 400,
                letterSpacing: '0.02em',
                borderRadius: '6px'
              }}
            >
              Publisher
            </button>
          </div>
        </div>







        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--color-border)' }}></div>
        {/* Reference Manager Section */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-[color:var(--color-ink)]">
              Default Reference Manager
            </label>
            <p className="text-xs text-[color:var(--color-ink-soft)]">
              Choose your preferred reference manager for quick export
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {referenceManagers.map((manager) => (
              <button
                key={manager}
                onClick={() => handleReferenceManagerChange(manager)}
                className="px-3 py-2 text-sm transition-all text-center"
                style={{
                  backgroundColor: currentManager === manager ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: currentManager === manager ? 'white' : 'var(--color-ink)',
                  border: '1px solid var(--color-border)',
                  fontWeight: currentManager === manager ? 500 : 400,
                  letterSpacing: '0.02em',
                  borderRadius: '6px'
                }}
              >
                {getReferenceManagerName(manager)}
              </button>
            ))}
          </div>
        </div>


      </>)}
      {activeTab === 'filters' && (<>
        {/* Research Profile (My Field) */}
        <ResearchProfile settings={settings} onSettingsChange={onSettingsChange} />


        {/* Divider */}
        <div style={{ borderTop: '1px solid var(--color-border)' }}></div>
        {/* Keyword Filters */}
        <KeywordFiltersSection settings={settings} onSettingsChange={onSettingsChange} />


      </>)}
      {activeTab === 'system' && (<>
        {/* Keyboard Shortcuts Section */}
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-[color:var(--color-ink)]">
            Keyboard Shortcuts
          </label>
          <div className="text-sm" style={{ color: 'var(--color-ink)' }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex items-center gap-3">
                <span className="kbd">j</span>
                <span className="kbd">k</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Navigate articles</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="kbd">a</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Toggle abstract</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="kbd">s</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Star / Unstar</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="kbd">d</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Mark read / unread</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="kbd">o</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Open article</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="kbd">e</span>
                <span style={{ color: 'var(--color-ink-soft)' }}>Export to reference manager</span>
              </div>
            </div>
          </div>
        </div>

      </>)}

    </div>
  );
}
