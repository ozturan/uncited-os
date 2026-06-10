import { NextRequest, NextResponse, after } from 'next/server';
import { THUMB_BUCKET, thumbKey } from '@/lib/thumbKey';

export const runtime = 'nodejs';

// Persist a successfully extracted publisher image to Supabase Storage at the
// paper's deterministic thumbnail path, so the NEXT view (any user) is a direct
// bucket hit and never re-extracts. Best-effort: resize to ~400px JPEG (sharp)
// and upsert; any failure is swallowed (the per-view path still works).
async function persistThumb(cid: string, imageBuffer: ArrayBuffer): Promise<void> {
  try {
    const sharp = (await import('sharp')).default;
    const jpg = await sharp(Buffer.from(imageBuffer))
      .resize({ width: 400, height: 520, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
    const { serviceSupabase } = await import('@/lib/paperFeed');
    await serviceSupabase().storage
      .from(THUMB_BUCKET)
      .upload(thumbKey(cid), jpg, { contentType: 'image/jpeg', cacheControl: '604800', upsert: true });
  } catch {
    // best-effort cache; ignore (sharp decode failure, storage hiccup, etc.)
  }
}

// LRU Cache with TTL and size limit
const MAX_CACHE_SIZE = 5000;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  imageUrl: string | null;
  expires: number;
}

// Using Map which maintains insertion order - we'll use this for LRU
const cache = new Map<string, CacheEntry>();

/**
 * LRU cache helper - moves accessed key to end (most recent)
 */
function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

/**
 * LRU cache set with automatic eviction
 */
function cacheSet(key: string, value: CacheEntry): void {
  // If key exists, delete first to update position
  if (cache.has(key)) {
    cache.delete(key);
  }

  // Evict oldest entries if at capacity
  while (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    } else {
      break;
    }
  }

  cache.set(key, value);
}

/**
 * Periodic cleanup of expired entries (call occasionally, not on every request)
 */
let lastCleanup = 0;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;

  lastCleanup = now;
  for (const [key, value] of cache.entries()) {
    if (value.expires < now) {
      cache.delete(key);
    }
  }
}

// Track journals that consistently don't have images - skip extraction for these
// Pre-populate with known domains that rarely/never have extractable images
const skipExtractionDomains = new Set<string>([
  // PNAS abstracts don't typically have og:image tags
  'www.pnas.org',
  'pnas.org',
  // Add more domains here that consistently don't have og:image tags
  // Can be populated dynamically after seeing repeated failures
]);

// Simple rate limiting: track requests per domain in last minute
const rateLimit = new Map<string, { count: number; resetAt: number }>();
// Each paper is extracted at most once and then served from the bucket on every
// later view, so first-view extractions are the only load. 30/min/domain keeps
// a journal-heavy feed from defaulting (the old 5 throttled most cards) while
// still being polite to publishers.
const RATE_LIMIT_PER_DOMAIN = 30;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const FAILURE_CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours for failures (longer to avoid wasted CPU)

/**
 * Validate URL to prevent SSRF attacks
 * - Only allow http/https schemes
 * - Block private/internal IP ranges
 * - Block localhost and common internal hostnames
 */
function isValidExternalUrl(urlString: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(urlString);

    // Only allow http/https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'Only http/https URLs are allowed' };
    }

    const hostname = url.hostname.toLowerCase();

    // Block localhost variations
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return { valid: false, error: 'Localhost URLs are not allowed' };
    }

    // Block common internal hostnames
    if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.lan')) {
      return { valid: false, error: 'Internal hostnames are not allowed' };
    }

    // Block private IP ranges (IPv4)
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      // 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x (link-local)
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
        return { valid: false, error: 'Private IP addresses are not allowed' };
      }
      // Block 127.x.x.x loopback range
      if (a === 127) {
        return { valid: false, error: 'Loopback addresses are not allowed' };
      }
    }

    // Block IPv6 private ranges (simplified check)
    if (hostname.startsWith('[') || hostname.includes(':')) {
      // For simplicity, block all IPv6 addresses - journal domains use hostnames
      return { valid: false, error: 'IPv6 addresses are not allowed' };
    }

    // Require hostname to have at least one dot (block single-label hostnames)
    if (!hostname.includes('.')) {
      return { valid: false, error: 'Single-label hostnames are not allowed' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Helper function to fetch with redirects
 * Uses default fetch redirect behavior but can handle manual redirects if needed
 */
async function fetchWithRedirects(url: string, options: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  // Try with default redirect behavior first (follows redirects automatically)
  try {
    const response = await fetch(url, {
      ...options,
      // Don't set redirect: 'manual' - let fetch handle it automatically
    });
    return response;
  } catch (error) {
    // If that fails, try manual redirect handling
    let currentUrl = url;
    for (let i = 0; i < maxRedirects; i++) {
      try {
        const response = await fetch(currentUrl, {
          ...options,
          // @ts-ignore - redirect option might not be in types but may be supported
          redirect: 'manual',
        });

        if (response.status >= 200 && response.status < 300) {
          return response;
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            try {
              currentUrl = new URL(location, currentUrl).href;
              continue;
            } catch {
              break;
            }
          }
        }

        return response;
      } catch (err) {
        if (i === 0) {
          // If manual redirects don't work, fall back to normal fetch
          return fetch(url, options);
        }
        throw err;
      }
    }
    throw new Error('Too many redirects');
  }
}

/**
 * Extract JSON-LD structured data - comprehensive extraction
 */
function extractJSONLD(html: string): { image?: string } | null {
  const jsonLdPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  const candidates: string[] = [];

  while ((match = jsonLdPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);

      // Helper to extract image from any object
      const extractImage = (obj: any): string | null => {
        if (!obj) return null;

        // Direct image property
        if (obj.image) {
          if (typeof obj.image === 'string' && obj.image.startsWith('http')) {
            return obj.image;
          } else if (obj.image.url && typeof obj.image.url === 'string') {
            return obj.image.url;
          } else if (obj.image.contentUrl && typeof obj.image.contentUrl === 'string') {
            return obj.image.contentUrl;
          } else if (Array.isArray(obj.image) && obj.image.length > 0) {
            const firstImg = obj.image[0];
            if (typeof firstImg === 'string' && firstImg.startsWith('http')) {
              return firstImg;
            } else if (firstImg?.url) {
              return firstImg.url;
            } else if (firstImg?.contentUrl) {
              return firstImg.contentUrl;
            }
          }
        }

        // Check for thumbnail
        if (obj.thumbnailUrl && typeof obj.thumbnailUrl === 'string' && obj.thumbnailUrl.startsWith('http')) {
          return obj.thumbnailUrl;
        }

        // Check for associatedMedia
        if (obj.associatedMedia && Array.isArray(obj.associatedMedia)) {
          for (const media of obj.associatedMedia) {
            if (media.contentUrl || media.url) {
              const url = media.contentUrl || media.url;
              if (typeof url === 'string' && url.startsWith('http') && url.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
                return url;
              }
            }
          }
        }

        return null;
      };

      // Try to find image in main object
      const mainImage = extractImage(json);
      if (mainImage) {
        candidates.push(mainImage);
      }

      // Also check for @graph format (multiple objects)
      if (json['@graph'] && Array.isArray(json['@graph'])) {
        for (const item of json['@graph']) {
          const itemImage = extractImage(item);
          if (itemImage) {
            candidates.push(itemImage);
          }

          // Check nested objects (e.g., mainEntity)
          if (item.mainEntity) {
            const nestedImage = extractImage(item.mainEntity);
            if (nestedImage) {
              candidates.push(nestedImage);
            }
          }
        }
      }

      // Check for mainEntity
      if (json.mainEntity) {
        const mainEntityImage = extractImage(json.mainEntity);
        if (mainEntityImage) {
          candidates.push(mainEntityImage);
        }
      }
    } catch {
      // Invalid JSON, continue
    }
  }

  // Return the first valid candidate (prefer larger images)
  if (candidates.length > 0) {
    // Filter out small thumbnails and prefer larger images
    const validCandidates = candidates.filter(url =>
      url &&
      url.startsWith('http') &&
      (url.match(/\.(jpg|jpeg|png|gif|webp)/i) || url.includes('image') || url.includes('figure')) &&
      !url.match(/\/\d+x\d+\./) // Not a small resized thumbnail
    );

    if (validCandidates.length > 0) {
      return { image: validCandidates[0] };
    }

    // If no valid candidates, return the first one anyway
    return { image: candidates[0] };
  }

  return null;
}

/**
 * Normalize image URL to absolute
 */
function normalizeImageUrl(imageUrl: string, baseUrl: string): string {
  imageUrl = imageUrl.trim();

  // Remove HTML entities
  imageUrl = imageUrl.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // Make relative URLs absolute
  if (imageUrl.startsWith('//')) {
    const urlObj = new URL(baseUrl);
    return `${urlObj.protocol}${imageUrl}`;
  } else if (imageUrl.startsWith('/')) {
    const urlObj = new URL(baseUrl);
    return `${urlObj.protocol}//${urlObj.host}${imageUrl}`;
  } else if (!imageUrl.startsWith('http')) {
    const urlObj = new URL(baseUrl);
    return `${urlObj.protocol}//${urlObj.host}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
  }

  return imageUrl;
}

/**
 * API route to extract paper figure thumbnails
 * Extracts Open Graph images from paper URLs (most journals include main figure as og:image)
 * Uses caching to avoid repeated HTML fetches
 * Works like Twitter/X by extracting og:image, twitter:image, and JSON-LD structured data
 * 
 * OPTIMIZED: Reduced timeouts, improved caching, added rate limiting
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const url = searchParams.get('url');
  const cid = searchParams.get('cid')?.trim() || '';

  if (!url) {
    return NextResponse.json({ error: 'URL parameter required' }, { status: 400 });
  }

  // Validate URL to prevent SSRF attacks
  const urlValidation = isValidExternalUrl(url);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: urlValidation.error }, { status: 400 });
  }

  // Check rate limiting
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    // Check if domain is in skip list
    if (skipExtractionDomains.has(domain)) {
      const transparentPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      return new NextResponse(transparentPng, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // Rate limiting check
    const now = Date.now();
    const domainLimit = rateLimit.get(domain);
    if (domainLimit) {
      if (now < domainLimit.resetAt) {
        if (domainLimit.count >= RATE_LIMIT_PER_DOMAIN) {
          // Rate limited - return cached result or transparent PNG
          const cached = cacheGet(url);
          if (cached && cached.expires > now && cached.imageUrl) {
            // Return cached image if available
            try {
              const imageResponse = await fetch(cached.imageUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Referer': url,
                },
                signal: AbortSignal.timeout(3000), // Short timeout for cached URLs
              });
              if (imageResponse.ok) {
                const imageBuffer = await imageResponse.arrayBuffer();
                return new NextResponse(imageBuffer, {
                  headers: {
                    'Content-Type': imageResponse.headers.get('content-type') || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                  },
                });
              }
            } catch {
              // Intentionally swallowed - falls through to transparent PNG fallback
            }
          }
          // Return transparent PNG if rate limited
          const transparentPng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64'
          );
          return new NextResponse(transparentPng, {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=300', // Short cache for rate-limited responses
            },
          });
        }
        domainLimit.count++;
      } else {
        // Reset window
        rateLimit.set(domain, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      }
    } else {
      rateLimit.set(domain, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    }
  } catch {
    // Invalid URL, continue with extraction
  }

  // Run periodic cleanup of expired entries
  cleanupExpiredEntries();

  // Check cache first (LRU - moves to most recent on access)
  const cached = cacheGet(url);
  if (cached && cached.expires > Date.now()) {
    if (cached.imageUrl) {
      // If we have a cached image URL, try to proxy it again
      try {
        const imageResponse = await fetch(cached.imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': url,
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(5000),
        });

        if (imageResponse.ok) {
          const imageBuffer = await imageResponse.arrayBuffer();
          const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

          return new NextResponse(imageBuffer, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=86400',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      } catch {
        // If cached URL fails, fall through to return transparent PNG
      }
    }

    // No cached image or cached URL failed - return transparent placeholder
    const transparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    return new NextResponse(transparentPng, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  let imageUrl: string | null = null;

  // Extract og:image directly from HTML (faster and more reliable than Microlink)
  // OPTIMIZED: Reduced timeouts and retry attempts to save CPU
  let html = '';
  let fetchSuccess = false;

  // Reduced to 2 attempts max (was 3) with shorter timeouts
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Build headers object conditionally to avoid undefined values
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      };

      // Add referer on retry attempts
      if (attempt > 0) {
        headers['Referer'] = 'https://www.google.com/';
      }

      // OPTIMIZED: Reduced timeouts significantly (was 15s/20s, now 5s/8s)
      const response = await fetchWithRedirects(url, {
        headers,
        signal: AbortSignal.timeout(attempt === 0 ? 5000 : 8000), // 5s first try, 8s on retry
      });

      if (response.ok) {
        fetchSuccess = true;
        const isScienceOrg = url.includes('science.org');
        const isBioRxivLocal = url.includes('biorxiv.org');
        const isMedRxiv = url.includes('medrxiv.org');
        // Read more HTML for sites that load content dynamically
        const isNatureLocal = url.includes('nature.com') || url.includes('springer.com');
        const isCellLocal = url.includes('cell.com');
        // OPTIMIZED: Reduced HTML size limits significantly to save CPU and memory
        const maxSize = isScienceOrg ? 200000 : (isBioRxivLocal || isMedRxiv) ? 150000 : (isNatureLocal || isCellLocal) ? 120000 : 80000; // Reduced by ~50%
        const maxChunks = isScienceOrg ? 80 : (isBioRxivLocal || isMedRxiv) ? 70 : (isNatureLocal || isCellLocal) ? 50 : 40; // Reduced chunk count

        // Read HTML - use streaming reader to avoid body consumption issues
        // Clone the response first so we can retry if needed
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let chunkCount = 0;
          let foundMetaTags = false;

          while (chunkCount < maxChunks && html.length < maxSize) {
            const { done, value } = await reader.read();
            if (done) break;
            html += decoder.decode(value, { stream: true });
            chunkCount++;

            // Check if we found meta tags early - OPTIMIZED: exit immediately when found
            if (!foundMetaTags && (html.includes('og:image') || html.includes('twitter:image') || html.includes('application/ld+json'))) {
              foundMetaTags = true;
              // Continue reading a bit more to ensure we have the full tag/script
              // OPTIMIZED: Reduced additional reading (was 200KB, now 100KB)
              while (html.length < Math.min(maxSize, 100000) && chunkCount < maxChunks) {
                const { done: done2, value: value2 } = await reader.read();
                if (done2) break;
                html += decoder.decode(value2, { stream: true });
                chunkCount++;
              }
              // If we found tags early, we can stop (but already read enough)
              break;
            }
          }

          // OPTIMIZED: Reduced extended reading - if we don't find tags early, give up faster
          if (!foundMetaTags && html.length >= maxSize * 0.8 && chunkCount < maxChunks) {
            // Continue reading to find meta tags further in the document, but with stricter limits
            while (chunkCount < maxChunks && html.length < maxSize * 1.2) {
              const { done, value } = await reader.read();
              if (done) break;
              html += decoder.decode(value, { stream: true });
              chunkCount++;

              if (html.includes('og:image') || html.includes('twitter:image') || html.includes('application/ld+json')) {
                // Read a bit more to ensure we have the full tag
                while (html.length < Math.min(maxSize * 1.2, 150000) && chunkCount < maxChunks) {
                  const { done: done2, value: value2 } = await reader.read();
                  if (done2) break;
                  html += decoder.decode(value2, { stream: true });
                  chunkCount++;
                }
                break;
              }
            }
          }
        } else {
          // Fallback: try text() if reader is not available
          try {
            const fullText = await response.text();
            html = fullText.substring(0, Math.min(maxSize * 2, fullText.length));
          } catch (textError) {
            // If both fail, continue with empty html (will return placeholder)
          }
        }

        // Extract og:image meta tag (comprehensive patterns to handle all formats)
        // Priority: og:image:secure_url > og:image
        const ogImagePatterns = [
          // og:image:secure_url (HTTPS version) - highest priority
          /<meta\s+property\s*=\s*["']og:image:secure_url["']\s+content\s*=\s*["']([^"']+)["']/i,
          /<meta\s+content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["']og:image:secure_url["']/i,
          /<meta\s+property=["']og:image:secure_url["']\s+content=([^\s>]+)/i,
          // Standard og:image - many variations
          /<meta\s+property\s*=\s*["']og:image["']\s+content\s*=\s*["']([^"']+)["']/i,
          /<meta\s+content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["']og:image["']/i,
          /<meta\s+property=["']og:image["']\s+content=([^\s>]+)/i,
          /<meta\s+content=([^\s>]+)\s+property=["']og:image["']/i,
          // Handle HTML5 format (no quotes, with whitespace)
          /<meta\s+property\s*=\s*og:image\s+content\s*=\s*([^\s>]+)/i,
          /<meta\s+property\s*=\s*og:image:secure_url\s+content\s*=\s*([^\s>]+)/i,
          // Handle single quotes
          /<meta\s+property=['"]og:image["']\s+content=['"]([^'"]+)["']/i,
          /<meta\s+property=['"]og:image:secure_url["']\s+content=['"]([^'"]+)["']/i,
          // Handle newlines and extra whitespace
          /<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
          /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i,
        ];

        for (const pattern of ogImagePatterns) {
          const match = html.match(pattern);
          if (match && match[1]) {
            let candidate = match[1]
              .replace(/["']/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&#x27;/g, "'")
              .replace(/&#x2F;/g, '/')
              .trim();

            if (candidate && candidate.length > 0) {
              imageUrl = candidate;
              // Stop at secure_url if found
              if (pattern.source.includes('secure_url')) {
                break;
              }
            }
          }
        }

        // Try twitter:image as fallback (Twitter cards)
        if (!imageUrl) {
          const twitterImagePatterns = [
            /<meta\s+name\s*=\s*["']twitter:image:src["']\s+content\s*=\s*["']([^"']+)["']/i,
            /<meta\s+content\s*=\s*["']([^"']+)["']\s+name\s*=\s*["']twitter:image:src["']/i,
            /<meta\s+name\s*=\s*["']twitter:image["']\s+content\s*=\s*["']([^"']+)["']/i,
            /<meta\s+content\s*=\s*["']([^"']+)["']\s+name\s*=\s*["']twitter:image["']/i,
            /<meta\s+property\s*=\s*["']twitter:image["']\s+content\s*=\s*["']([^"']+)["']/i,
            /<meta\s+name=["']twitter:image["']\s+content=([^\s>]+)/i,
            /<meta\s+name=['"]twitter:image["']\s+content=['"]([^'"]+)["']/i,
          ];

          for (const pattern of twitterImagePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1]
                .replace(/["']/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim();

              if (candidate && candidate.length > 0) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // Try JSON-LD structured data (used by many modern sites)
        if (!imageUrl) {
          const jsonLd = extractJSONLD(html);
          if (jsonLd?.image) {
            imageUrl = jsonLd.image;
          }
        }

        // Publisher-specific extraction strategies
        const isNature = url.includes('nature.com') || url.includes('springer.com');
        const isScience = url.includes('science.org');
        const isCell = url.includes('cell.com');
        const isElsevier = url.includes('sciencedirect.com') || url.includes('elsevier.com');
        const isPLOS = url.includes('plos.org');
        const isBioRxiv = url.includes('biorxiv.org');
        const isArXiv = url.includes('arxiv.org');
        const isPNAS = url.includes('pnas.org');

        // For Science.org specifically, try to find figure images in the HTML
        if (!imageUrl && isScience) {
          const sciencePatterns = [
            // Look for figure images in various containers
            /<img[^>]+class=["'][^"']*figure[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+src=["']([^"']+figure[^"']+)["'][^>]*>/i,
            /<figure[^>]*>[\s\S]{0,2000}<img[^>]+src=["']([^"']+)["']/i,
            /<img[^>]+data-src=["']([^"']+figure[^"']+)["'][^>]*>/i,
            // Look for images in article content areas
            /<div[^>]+class=["'][^"']*article-content[^"']*["'][^>]*>[\s\S]{0,5000}<img[^>]+src=["']([^"']+)["']/i,
            /<div[^>]+class=["'][^"']*figure-container[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
            // Look for lazy-loaded images
            /<img[^>]+data-lazy-src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
            /<img[^>]+data-original=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
          ];

          for (const pattern of sciencePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) || candidate.includes('figure') || candidate.includes('image')) {
                // Filter out small icons and logos
                if (!candidate.match(/(logo|icon|avatar|favicon|thumbnail.*small|small.*thumbnail)/i)) {
                  imageUrl = candidate;
                  break;
                }
              }
            }
          }
        }

        // For bioRxiv and medRxiv - Highwire Press structure
        if (!imageUrl && (isBioRxiv || url.includes('medrxiv.org'))) {
          const biorxivPatterns = [
            // Highwire Press figure images
            /<img[^>]+class=["'][^"']*highwire-fragment[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+class=["'][^"']*figure[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<figure[^>]+class=["'][^"']*figure[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
            // Look for images in figure containers
            /<div[^>]+class=["'][^"']*figure[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
            /<div[^>]+id=["'][^"']*fig[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
            // Look for lazy-loaded images
            /<img[^>]+data-src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
            /<img[^>]+data-lazy-src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
            // Look for images in article content
            /<div[^>]+class=["'][^"']*article-body[^"']*["'][^>]*>[\s\S]{0,5000}<img[^>]+src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["']/i,
            // Look for figure URLs in data attributes
            /<img[^>]+data-figure-url=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
          ];

          for (const pattern of biorxivPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              // Must be an image file and not a logo/icon
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) &&
                !candidate.match(/(logo|icon|avatar|favicon|thumbnail.*small|small.*thumbnail|spinner|loading)/i)) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // For Nature/Springer - look for article images
        if (!imageUrl && isNature) {
          const naturePatterns = [
            /<img[^>]+class=["'][^"']*article-image[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+class=["'][^"']*hero-image[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+data-src=["']([^"']+)["'][^>]*class=["'][^"']*article[^"']*["']/i,
            /<div[^>]+class=["'][^"']*article-image[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
          ];

          for (const pattern of naturePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) && !candidate.includes('logo') && !candidate.includes('icon')) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // For Cell - look for figure previews (Cell works, but let's make sure we catch all variations)
        if (!imageUrl && isCell) {
          const cellPatterns = [
            /<img[^>]+class=["'][^"']*figure[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+data-lazy-src=["']([^"']+)["'][^>]*>/i,
            /<div[^>]+class=["'][^"']*figure[^"']*["'][^>]*>[\s\S]{0,3000}<img[^>]+src=["']([^"']+)["']/i,
          ];

          for (const pattern of cellPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i)) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // For Elsevier/ScienceDirect - look for figure thumbnails
        if (!imageUrl && isElsevier) {
          const elsevierPatterns = [
            /<img[^>]+class=["'][^"']*figure[^"']*["'][^>]+src=["']([^"']+)["']/i,
            /<img[^>]+data-src=["']([^"']+figure[^"']+)["'][^>]*>/i,
            /<figure[^>]*>[\s\S]{0,2000}<img[^>]+src=["']([^"']+)["']/i,
          ];

          for (const pattern of elsevierPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) && !candidate.includes('logo')) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // Generic fallback: look for any large image in meta or link tags
        if (!imageUrl) {
          const linkImagePatterns = [
            /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
            /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i,
            /<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/i,
          ];

          for (const pattern of linkImagePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              // Only use if it looks like an image (not favicon sizes)
              if (candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) && !candidate.match(/\/\d+x\d+\./)) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // Final fallback: Look for any large images in article/main content areas
        if (!imageUrl) {
          const articleImagePatterns = [
            // Look for images in article containers
            /<article[^>]*>[\s\S]{0,5000}<img[^>]+src=["']([^"']+)["'][^>]*>/i,
            /<main[^>]*>[\s\S]{0,5000}<img[^>]+src=["']([^"']+)["'][^>]*>/i,
            // Look for data-src or lazy-loaded images
            /<img[^>]+data-src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
            /<img[^>]+data-lazy-src=["']([^"']+\.(jpg|jpeg|png|gif|webp))["'][^>]*>/i,
          ];

          for (const pattern of articleImagePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              let candidate = match[1].replace(/["']/g, '').replace(/&amp;/g, '&').trim();
              // Filter out small images, logos, icons, avatars
              if (candidate &&
                candidate.match(/\.(jpg|jpeg|png|gif|webp)/i) &&
                !candidate.match(/(logo|icon|avatar|favicon|thumbnail.*small|small.*thumbnail)/i) &&
                !candidate.match(/\/\d+x\d+\./) && // Not a resized thumbnail
                candidate.length > 10) {
                imageUrl = candidate;
                break;
              }
            }
          }
        }

        // Normalize the image URL to absolute
        if (imageUrl) {
          // Clean up HTML entities that might still be in the URL
          imageUrl = imageUrl
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/&#x2F;/g, '/')
            .replace(/\s+/g, '') // Remove any whitespace
            .trim();

          imageUrl = normalizeImageUrl(imageUrl, url);

          // Filter out data URIs and obviously invalid URLs
          // But allow URLs that start with // (protocol-relative)
          if (imageUrl.startsWith('data:') || (!imageUrl.match(/^https?:\/\//i) && !imageUrl.startsWith('//'))) {
            imageUrl = null;
          } else {
            // Convert protocol-relative URLs to HTTPS
            if (imageUrl.startsWith('//')) {
              imageUrl = 'https:' + imageUrl;
            }
            // Success! Break out of retry loop
            break;
          }
        }
      } // Close if (response.ok)
    } catch (error) {
      // On last attempt, log the error
      if (attempt === 1 && error instanceof Error && error.name !== 'TimeoutError') {
        console.error('[Thumbnail API] HTML extraction error for', url, error.message);
      }
      // OPTIMIZED: Reduced retry delay (was exponential, now fixed shorter delay)
      if (attempt < 1) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Reduced from 1000-2000ms to 500ms
      }
    }
  }

  // OPTIMIZED: Cache failures for longer to avoid wasted CPU on known failures
  // Cache successes for 24 hours, failures for 48 hours (to avoid repeated attempts)
  const cacheExpiry = imageUrl
    ? Date.now() + CACHE_TTL  // 24 hours for success
    : Date.now() + FAILURE_CACHE_TTL; // 48 hours for failures (longer to save CPU)

  cacheSet(url, {
    imageUrl,
    expires: cacheExpiry
  });

  // If no image found, track failures per domain to optimize future requests
  if (!imageUrl) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      // Count failures for this domain (lower threshold: if we have 20+ cached failures, skip)
      // Lower threshold because once we see a pattern, we want to stop wasting resources
      let failureCount = 0;
      let successCount = 0;
      for (const [key, value] of cache.entries()) {
        try {
          const keyDomain = new URL(key).hostname;
          if (keyDomain === domain) {
            if (value.imageUrl) {
              successCount++;
              // If we have successes, don't skip this domain
              if (successCount >= 5) break;
            } else {
              failureCount++;
            }
          }
        } catch {
          // Skip invalid URLs
        }
      }

      // Skip if we have 20+ failures and no successes (or failure rate > 95%)
      if (failureCount >= 20 && (successCount === 0 || failureCount / (failureCount + successCount) > 0.95)) {
        skipExtractionDomains.add(domain);
      }
    } catch {
      // Skip if URL parsing fails
    }
  }

  // Note: Cache cleanup is now handled by LRU eviction in cacheSet() and periodic cleanupExpiredEntries()

  // If we found an image, proxy it through our API to avoid CORS issues
  if (imageUrl) {
    try {
      // Fetch the actual image with redirect following and return it directly
      // Try multiple times with different strategies
      let imageResponse: Response | null = null;

      // OPTIMIZED: Reduced retry attempts and timeouts for image fetching
      for (let imgAttempt = 0; imgAttempt < 2; imgAttempt++) {
        try {
          imageResponse = await fetchWithRedirects(imageUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': url, // Some sites check referer
              'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(imgAttempt === 0 ? 5000 : 8000), // OPTIMIZED: Reduced from 10s/15s to 5s/8s
          });

          if (imageResponse.ok) {
            break; // Success, exit retry loop
          }
        } catch (error) {
          // On last attempt, we'll check if imageResponse is null
          if (imgAttempt === 1 && error instanceof Error && error.name !== 'TimeoutError') {
            console.error('[Thumbnail API] Image fetch error:', imageUrl, error.message);
          }
          // OPTIMIZED: Reduced retry delay
          if (imgAttempt < 1) {
            await new Promise(resolve => setTimeout(resolve, 500)); // Reduced from 1000-2000ms to 500ms
          }
        }
      }

      if (imageResponse && imageResponse.ok) {
        const imageBuffer = await imageResponse.arrayBuffer();

        // Validate it's actually an image by checking content-type or magic bytes
        const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) {
          throw new Error('Not an image');
        }

        // Check magic bytes for common image formats
        const bytes = new Uint8Array(imageBuffer);
        const isValidImage =
          (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) || // JPEG
          (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) || // PNG
          (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) || // GIF
          (bytes.length > 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) || // WebP (RIFF)
          contentType.startsWith('image/');

        if (isValidImage && imageBuffer.byteLength > 100) {
          // Cache this image to Storage so the next view is a direct bucket hit
          // (PaperThumbnail tries the bucket first). Background, doesn't delay
          // the response. Only when we have the paper's canonical id.
          if (cid) after(() => persistThumb(cid, imageBuffer));
          return new NextResponse(imageBuffer, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
              'Access-Control-Allow-Origin': '*', // Allow CORS
            },
          });
        }
      }
    } catch (error) {
      // If proxying fails, cache the failure and return transparent PNG
      if (error instanceof Error && error.name !== 'TimeoutError') {
        console.error('[Thumbnail API] Failed to proxy image:', imageUrl, error.message);
      }
    }
  }

  // No image found - return a transparent 1x1 pixel PNG with status 200
  // This prevents browser errors while still allowing the component to show fallback
  // The component can detect if the image is effectively empty and show generateThumbnail
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  return new NextResponse(transparentPng, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      'X-No-Thumbnail': 'true', // Header to indicate no actual thumbnail
    },
  });
}
