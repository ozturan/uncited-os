// Helper utilities for fetching the journal catalog. Per-journal article
// JSONs (`/data/journals/<id>.json`) are no longer written by the
// pipeline as of Phase 4 — the website queries Supabase live via
// /api/articles, /api/journal-count, and friends. Only the static catalog
// (the list of journals + display metadata) is still served from disk.

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Get the base URL for fetching static assets from CDN
function getBaseUrl(): string {
  // IMPORTANT: We fetch from the deployment URL, which serves static files from CDN edge
  // This is NOT a circular dependency because static files bypass serverless functions

  // In development, signal to use filesystem
  if (process.env.NODE_ENV === 'development') {
    return null as any;
  }

  // In production: VERCEL_URL is not reliable at runtime, use production domain
  // Static files are served from CDN regardless of which URL we use
  return 'https://uncited.org';
}

// Fetch the catalog to get all journal IDs
let catalogCache: any = null;
let catalogCacheTime = 0;

export async function fetchCatalog(): Promise<any> {
  const now = Date.now();

  // Return cached catalog if still valid
  if (catalogCache && (now - catalogCacheTime) < CACHE_TTL) {
    return catalogCache;
  }

  try {
    const baseUrl = getBaseUrl();

    // In development, use filesystem
    if (!baseUrl) {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const catalogPath = join(process.cwd(), 'public', 'data', 'catalog.json');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

      // Cache the result
      catalogCache = catalog;
      catalogCacheTime = now;
      return catalog;
    }

    // In production, fetch from CDN
    const url = `${baseUrl}/data/catalog.json`;

    const response = await fetch(url, {
      cache: 'default',
      next: { revalidate: 3600 } // Cache for 1 hour
    });

    if (!response.ok) {
      return { disciplines: [] };
    }

    const catalog = await response.json();

    // Cache the result
    catalogCache = catalog;
    catalogCacheTime = now;

    return catalog;
  } catch (error) {
    console.error('Failed to fetch catalog:', error);
    return { disciplines: [] };
  }
}

// Get all journal IDs from the catalog
export async function getAllJournalIds(): Promise<string[]> {
  try {
    const catalog = await fetchCatalog();
    const journalIds: string[] = [];

    catalog.disciplines?.forEach((discipline: any) => {
      discipline.journals?.forEach((journal: any) => {
        if (journal.id) {
          journalIds.push(journal.id);
        }
      });
    });

    return journalIds;
  } catch (error) {
    console.error('Failed to get journal IDs:', error);
    return [];
  }
}
