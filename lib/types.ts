export interface Journal {
  id: string;
  name: string;
  rss: string;
  logo: string;
  publisher: string; // Publishing group/organization
  impactFactor?: number; // Journal Impact Factor
}

export interface Discipline {
  id: string;
  name: string;
  journals: Journal[];
}

export interface Catalog {
  disciplines: Discipline[];
}

export interface KeywordFilter {
  id: string;
  name: string;
  keywords: string; // comma-separated or space-separated
  fields: 'title' | 'abstract' | 'both';
  logic: 'AND' | 'OR';
}

export interface Entry {
  id: string;
  canonicalId?: string; // Canonical paper identifier (doi:... | arxiv:... | title:<hash>)
                        // Added during papers/sightings migration. Matches across feed variants.
  title: string;
  authors?: string;
  abstract?: string;
  journal: string;
  journalId: string;
  published: string;
  availableOnline?: string;
  doi?: string;
  arxivId?: string;
  link: string;
  pdfLink?: string;
  type?: 'Research' | 'Review' | 'Letter' | 'Commentary' | 'News' | 'Editorial' | 'Preprint' | 'Other';
  thumbnail?: string;
  categories?: string[]; // Feed-provided categories/tags
  section?: string; // Feed section/channel-specific section if available
  sourceType?: string; // Feed-provided explicit type (e.g., dc:type, prism:genre)
  starCount?: number;
  affiliation?: import('./affiliation').AffiliationData; // pre-resolved author/lab/institution (server-attached when warm)
}

export interface UserState {
  follows: string[]; // journal IDs
  read: string[]; // entry IDs (legacy) — still the source of truth until cutover
  starred: string[]; // entry IDs (legacy)
  readTimestamps?: { [entryId: string]: string };
  starredTimestamps?: { [entryId: string]: string };
  // Canonical equivalents — populated by Phase 3 migration. Contains
  // canonical paper IDs (doi:... / arxiv:... / title:<hash>).
  readCanonical?: string[];
  starredCanonical?: string[];
  readTimestampsCanonical?: { [canonicalId: string]: string };
  starredTimestampsCanonical?: { [canonicalId: string]: string };
  canonicalMigratedAt?: string; // ISO timestamp
  lastVisit?: string;
  settings?: UserSettings;
}

export interface FieldProfile {
  authorId: string;       // Semantic Scholar author ID
  name: string;           // researcher's display name
  count: number;          // # publications used to build this centroid
  description?: string;   // 8-15 word LLM phrase
  addedAt: string;        // ISO timestamp
  centroid: number[];     // 256-dim normalized — needed for recompute on remove
}

export interface UserSettings {
  sidebarOrganization: 'discipline' | 'publisher' | 'recent'; // How to organize the sidebar
  theme: 'light' | 'dark' | 'sepia' | 'retro' | 'blue' | 'coral'; // Theme preference
  showThumbnails?: boolean; // Show article thumbnails
  sortMode?: string; // Feed sort preference (including "kw:*")

  defaultReferenceManager?: 'mendeley' | 'zotero' | 'bibtex' | 'endnote'; // Default reference manager for quick export
  discoverCategories?: string[]; // Selected categories for Discover tab (discipline IDs)
  articleTypes?: string[]; // Selected article types for filtering (Research, Review, etc.)
  swipeRightAction?: 'archive' | 'star'; // What right swipe does (left is opposite)
  emailNotifications?: boolean; // Opt out of broadcast emails (default true)

  // Research profiles (My Field) — multi-profile: each profile stores its
  // own centroid; field_centroid below is the AGGREGATE (avg of all profile
  // centroids, L2-normalized). Recommendations RPCs read field_centroid only,
  // so the aggregate stays the single source of truth for ranking.
  field_centroid?: number[];        // aggregate vector — what the RPCs query
  field_centroid_count?: number;    // SUM of publications across all profiles
  field_centroid_updated_at?: string;
  field_description?: string;       // legacy single-profile description (back-compat)
  field_profiles?: FieldProfile[];  // each profile with its own centroid + metadata

  keywordFilters?: KeywordFilter[]; // User's custom saved keyword filters

  // API keys: stored locally in your database; used by the fetch pipeline + embed routes (runs on your own machine).
  apiKeys?: { openai?: string; anthropic?: string };
}

