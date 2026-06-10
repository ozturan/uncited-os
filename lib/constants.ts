/**
 * Centralized constants for the application.
 * Import named constants from this file instead of scattering magic numbers.
 */

// Cache TTL values
/** 5-minute cache TTL in milliseconds (used by discover and starred-articles routes) */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** 10-minute cache TTL in milliseconds (used by articles/discover cache) */
export const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;

// Batch sizes for parallel fetching
/** Number of journals to load in a single parallel batch */
export const JOURNAL_BATCH_SIZE = 50;

/** Number of journals to load per batch when building starred-article lookup cache */
export const STARRED_BATCH_SIZE = 100;

/** Number of article embeddings to fetch per batch for recommendations scoring */
export const EMBEDDING_BATCH_SIZE = 500;

// Pagination / display limits
/** Default number of articles to display per page */
export const DEFAULT_DISPLAY_LIMIT = 100;

// Date ranges in milliseconds
/** 7 days in milliseconds */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 30 days in milliseconds */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
