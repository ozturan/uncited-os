import { Entry } from './types';

/**
 * Detect the type of paper based on title, abstract, and metadata
 * Uses a multi-signal approach with confidence scoring
 */
const typeCache = new Map<string, Entry['type']>();

// Journals that ONLY publish review articles
const REVIEW_ONLY_JOURNALS = [
  'annual review of',
  'nature reviews',
  'trends in ',
  'current opinion in',
  'progress in ',
  'pharmacological reviews',
  'physiological reviews',
  'clinical microbiology reviews',
  'endocrine reviews',
  'microbiology and molecular biology reviews',
  'chemical reviews',
  'reviews of modern physics',
  'psychological review',
  'nutrition reviews',
  'sleep medicine reviews',
  'neuroscience & biobehavioral reviews',
  'neuroscience and biobehavioral reviews',
  'earth-science reviews',
  'physics reports',
  'surface science reports',
];

// Popular science outlets - always News
const POPULAR_SCIENCE_OUTLETS = [
  'ars technica', 'astronomy magazine', 'bbc science', 'futurism', 'gizmodo',
  'live science', 'mit technology review', 'nautilus', 'new scientist',
  'phys.org', 'popular science', 'quanta magazine', 'science alert',
  'science daily', 'science news', 'scientific american', 'smithsonian',
  'the atlantic', 'the conversation', 'the guardian', 'the new york times',
  'the verge', 'vox', 'wired', 'sky & telescope', 'space.com', 'ieee spectrum',
];

export function detectPaperType(entry: Entry): Entry['type'] {
  if (typeCache.has(entry.id)) return typeCache.get(entry.id)!;

  // Helper to cache and return
  const setType = (type: Entry['type']) => {
    typeCache.set(entry.id, type);
    return type;
  };

  // If article already has a valid LLM-assigned type, use it
  const validTypes = ['Research', 'Review', 'Letter', 'Commentary', 'News', 'Editorial', 'Preprint', 'Other'];
  if (entry.type && validTypes.includes(entry.type)) {
    return setType(entry.type);
  }

  const titleLower = entry.title.toLowerCase();
  const abstractLower = entry.abstract?.toLowerCase() || '';
  const linkLower = (entry.link || '').toLowerCase();
  const journalLower = (entry.journal || '').toLowerCase();
  const journalIdLower = (entry.journalId || '').toLowerCase();

  // ===========================================
  // TIER 1: Definitive signals (100% confidence)
  // ===========================================

  // 1a) Preprint servers - URL/journal ID based
  if (
    linkLower.includes('arxiv.org') ||
    linkLower.includes('biorxiv.org') ||
    linkLower.includes('medrxiv.org') ||
    linkLower.includes('ssrn.com') ||
    linkLower.includes('preprints.org') ||
    journalIdLower.includes('arxiv') ||
    journalIdLower.includes('biorxiv') ||
    journalIdLower.includes('medrxiv')
  ) {
    return setType('Preprint');
  }

  // 1b) Popular science outlets - always News
  if (POPULAR_SCIENCE_OUTLETS.some(j => journalLower.includes(j))) {
    return setType('News');
  }

  // 1c) RSS feed explicit type metadata (dc:type, prism:genre, etc.)
  const sourceType = ((entry as any).sourceType as string || '').toLowerCase();
  if (sourceType) {
    if (/\breview\b|review-article/.test(sourceType)) return setType('Review');
    if (/\beditorial\b/.test(sourceType)) return setType('Editorial');
    if (/\bletter\b|correspondence/.test(sourceType)) return setType('Letter');
    if (/\bcomment|opinion|viewpoint|perspective/.test(sourceType)) return setType('Commentary');
    // if (/\bperspective\b/.test(sourceType)) return setType('Review'); // perspective is commentary
    if (/\bnews\b|highlight/.test(sourceType)) return setType('News');
    if (/\bresearch.article|original.article|article\b/.test(sourceType)) return setType('Research');
  }

  // 1d) Title prefix patterns (Definitive article types)
  if (/^(news|news & views|news and views|research highlight|spotlight|in brief)[:\s\-–—]/i.test(titleLower)) {
    return setType('News');
  }
  if (/^(editorial)[:\s\-–—]/i.test(titleLower)) {
    return setType('Editorial');
  }
  if (/^(commentary|opinion|viewpoint|perspective)[:\s\-–—]/i.test(titleLower)) {
    return setType('Commentary');
  }
  if (/^(letter|correspondence|reply|response)[:\s\-–—]/i.test(titleLower)) {
    return setType('Letter');
  }
  // Explicit "Review:" prefix overrides journal default
  if (/^(review)[:\s\-–—]/i.test(titleLower)) {
    return setType('Review');
  }
  if (/^(correction|erratum|corrigendum|retraction)[:\s\-–—]/i.test(titleLower)) {
    return setType('Other');
  }

  // 1e) Review-only journals - only if not already classified by explicit Type
  if (REVIEW_ONLY_JOURNALS.some(j => journalLower.includes(j))) {
    // Exception: If abstract says "This perspective", it's a Commentary (Perspective)
    if (/\b(this|in this) perspective\b/i.test(abstractLower)) {
      return setType('Commentary');
    }
    return setType('Review');
  }

  // ===========================================
  // TIER 2: Strong URL path signals
  // ===========================================

  // Publisher URL structures often indicate article type
  if (/\/(editorial|editorials|from-the-editor)(\/|$|\?)/.test(linkLower)) return setType('Editorial');
  if (/\/(letter|letters|correspondence|reply)(\/|$|\?)/.test(linkLower)) return setType('Letter');
  if (/\/(comment|commentary|opinion|viewpoint|perspective)(\/|$|\?)/.test(linkLower)) return setType('Commentary');
  // if (/\/(perspective)(\/|$|\?)/.test(linkLower)) return setType('Review');
  if (/\/(news-and-views|news|research-highlight|spotlight)(\/|$|\?)/.test(linkLower)) return setType('News');
  if (/\/(review|review-article|reviews)(\/|$|\?)/.test(linkLower)) return setType('Review');



  // ===========================================
  // TIER 4: RSS categories (if available)
  // ===========================================

  const categories = (entry as any).categories as string[] | undefined;
  if (Array.isArray(categories) && categories.length > 0) {
    const catsLower = categories.map(c => (c || '').toLowerCase()).join(' ');
    if (/\breview\b/.test(catsLower)) return setType('Review');
    if (/\beditorial\b/.test(catsLower)) return setType('Editorial');
    if (/\bletter\b|correspondence/.test(catsLower)) return setType('Letter');
    if (/\bcommentary\b|opinion|perspective/.test(catsLower)) return setType('Commentary');
    // if (/\bperspective\b/.test(catsLower)) return setType('Review');
    if (/\bnews\b/.test(catsLower)) return setType('News');
  }

  // ===========================================
  // TIER 5: Content analysis (title + abstract)
  // ===========================================

  // 5a) Strong title-only patterns
  if (/\bsystematic review\b/.test(titleLower)) return setType('Review');
  if (/\bmeta[- ]?analysis\b/.test(titleLower)) return setType('Review');
  if (/\bscoping review\b/.test(titleLower)) return setType('Review');
  if (/\bumbrella review\b/.test(titleLower)) return setType('Review');
  if (/\bnarrative review\b/.test(titleLower)) return setType('Review');
  if (/\bliterature review\b/.test(titleLower)) return setType('Review');

  // 5b) Abstract authorial voice patterns - "In this review, we..."
  // These indicate the article ITSELF is a review (not just mentioning other reviews)
  const selfReferentialReviewPatterns = [
    /\b(in this|this) review\b/,
    /\bwe review\b/,
    /\bhere,? we review\b/,
    /\bthis review (article )?(summarizes|discusses|highlights|examines|provides|presents|focuses)\b/,
    /\bwe (present|provide) a (comprehensive |critical |systematic )?review\b/,
    /\bthis (article|paper) reviews\b/,
    /\bour review (of|shows|demonstrates|reveals)\b/,
    /\bin this scoping review\b/,
    // Perspective articles are often reviews -> User says Commentary
    // /\b(in this|this) perspective\b/,
    // /\bhere,? we offer a perspective\b/,
  ];
  if (selfReferentialReviewPatterns.some(p => p.test(abstractLower))) {
    return setType('Review');
  }

  // 5b2) Review articles that discuss advances or offer frameworks
  const reviewDiscussionPatterns = [
    /\b(discuss|discusses) recent (advances|developments|progress)\b/,
    /\b(colleagues|authors) (discuss|review|examine)\b/,
    /\boffering a framework\b/,
    /\bproviding a framework\b/,
  ];
  if (reviewDiscussionPatterns.some(p => p.test(abstractLower))) {
    return setType('Review');
  }

  // 5c) Commentary/Opinion authorial patterns
  const selfReferentialCommentaryPatterns = [
    /\bin this (commentary|opinion|viewpoint|perspective)\b/,
    /\bthis (commentary|opinion piece|viewpoint|perspective) (discusses|addresses|argues)\b/,
    /\bthis comment (outlines|discusses|addresses|argues|highlights)\b/,
  ];
  if (selfReferentialCommentaryPatterns.some(p => p.test(abstractLower))) {
    return setType('Commentary');
  }

  // 5d) Editorial patterns
  const selfReferentialEditorialPatterns = [
    /\bin this editorial\b/,
    /\bthis editorial (discusses|addresses|highlights)\b/,
    /\bas editor/,
  ];
  if (selfReferentialEditorialPatterns.some(p => p.test(abstractLower))) {
    return setType('Editorial');
  }

  // 5e) News & Views patterns (Nature journals)
  const newsAndViewsPatterns = [
    /\ba recent study\b/,
    /\bexcitingly, a recent study\b/,
    /\bin a recent study\b/,
  ];
  if (newsAndViewsPatterns.some(p => p.test(abstractLower))) {
    return setType('News');
  }

  // 5f) Letter patterns
  const selfReferentialLetterPatterns = [
    /\bin this letter\b/,
    /\bwe (write|respond) to\b/,
    /\bin response to (the |a )?(article|paper|letter|editorial)\b/,
    /\bdear editor\b/,
  ];
  if (selfReferentialLetterPatterns.some(p => p.test(abstractLower))) {
    return setType('Letter');
  }

  // ===========================================
  // TIER 6: Weaker heuristics (use cautiously)
  // ===========================================

  // Title patterns suggesting letter/commentary (check before weak "review" heuristic)
  if (/^(comment on|comments on|response to|reply to|in reply|serious concerns)\b/i.test(titleLower)) {
    return setType('Letter');
  }

  // Title contains "review" as standalone word (but not in phrases like "peer review", "under review")
  if (/\breview\b/.test(titleLower) && !/peer[- ]review|under review|review of |reviewed by/.test(titleLower)) {
    return setType('Review');
  }

  // ===========================================
  // DEFAULT: Research Article
  // ===========================================
  return setType('Research');
}

/**
 * Get paper figure thumbnail URL
 * Extracts actual figures from papers using Open Graph images
 * Most journals (Nature, Science, Cell, PLOS, etc.) include their main figure as og:image
 * Uses our API route which extracts og:image server-side to avoid CORS issues
 */
export function getPaperThumbnail(entry: Entry): string {
  // Use our API route to extract Open Graph images server-side
  // This avoids CORS issues and handles extraction more reliably
  return `/api/thumbnail?url=${encodeURIComponent(entry.link)}`;
}

/**
 * Soft gradient fallback thumbnail. Deterministic per journal: a smooth
 * two-tone diagonal gradient with a couple of blurred radial blobs, no text.
 * Rendered client-side as a data-URI, so it costs nothing and every paper gets
 * a calm, non-broken-looking thumbnail immediately. Real images (rendered
 * page-1, publisher og:image) replace it when available.
 */
export function generateThumbnail(entry: Entry): string {
  const journalId = entry.journalId || entry.journal || entry.id || 'default';

  // Deterministic hue per journal; a complementary-ish second hue for depth.
  const hash = journalId.split('').reduce((acc, c) => c.charCodeAt(0) + ((acc << 5) - acc), 0);
  const hue = Math.abs(hash % 360);
  const hue2 = (hue + 40) % 360;
  const safeId = journalId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 24) || 'd';

  const c1 = `hsl(${hue}, 62%, 70%)`;
  const c2 = `hsl(${hue2}, 58%, 60%)`;
  const blob1 = `hsl(${hue}, 70%, 82%)`;
  const blob2 = `hsl(${hue2}, 66%, 50%)`;

  const svg = `<svg width="240" height="135" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg-${safeId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </linearGradient>
      <filter id="blur-${safeId}" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="22"/>
      </filter>
    </defs>
    <rect width="240" height="135" fill="url(#bg-${safeId})"/>
    <g filter="url(#blur-${safeId})">
      <circle cx="56" cy="40" r="46" fill="${blob1}" opacity="0.7"/>
      <circle cx="196" cy="104" r="54" fill="${blob2}" opacity="0.6"/>
    </g>
  </svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Get a badge color for paper type
 * Uses a vibrant, unified color palette that works across all themes
 * (light, dark, sepia, retro, blue, coral)
 */
export function getPaperTypeBadgeColor(type: Entry['type']): { bg: string; text: string } {
  switch (type) {
    case 'Research':
      return { bg: '#0d9488', text: '#ffffff' }; // Teal - primary research (most common type)
    case 'Review':
      return { bg: '#4f46e5', text: '#ffffff' }; // Indigo - comprehensive reviews
    case 'Letter':
      return { bg: '#f59e0b', text: '#ffffff' }; // Amber - correspondence
    case 'Commentary':
      return { bg: '#0284c7', text: '#ffffff' }; // Sky Blue - informative commentary
    case 'News':
      return { bg: '#e11d48', text: '#ffffff' }; // Rose - bold, opinion-driven
    case 'Editorial':
      return { bg: '#64748b', text: '#ffffff' }; // Slate - neutral, authoritative
    case 'Preprint':
      return { bg: '#8b5cf6', text: '#ffffff' }; // Violet - work in progress
    case 'Other':
      return { bg: '#6b7280', text: '#ffffff' }; // Gray - corrections, errata
    default:
      return { bg: '#6b7280', text: '#ffffff' }; // Gray - fallback
  }
}

/**
 * Robust author parsing helpers
 */
function splitAuthorTokens(authors: string): string[] {
  // Common separators: ",", ";", " and ", " & "
  // We first replace ' and ' / ' & ' with commas to unify, then split by commas/semicolons
  const unified = authors
    .replace(/\s+(and|&)\s+/gi, ',')
    .replace(/;+/g, ',');
  return unified.split(',').map(s => s.trim()).filter(Boolean);
}

function parseAuthorName(token: string, allTokens?: string[]): { firstNames: string; lastName: string; full: string } {
  // Handle forms like "Last, First M." or "First M. Last"
  if (token.includes(',')) {
    const [last, rest] = token.split(',', 2).map(s => s.trim());
    const restParts = rest.split(/\s+/).filter(Boolean);
    const firstNames = restParts.join(' ');
    // For "Last, First" format, the last name is the first part before comma
    // Handle hyphenated names: "van der Berg, John" -> lastName should be "van der Berg"
    // We take the entire first part as it might contain prefixes
    const lastParts = last.split(/\s+/);
    const lastName = lastParts.length > 1 && /^(van|de|der|le|la|du|von|del|da|dos|des|el)$/i.test(lastParts[0])
      ? last // Keep prefix + last name together for prefixed names
      : lastParts[lastParts.length - 1]; // Otherwise just the last word
    const full = `${firstNames} ${lastName}`.trim();
    // Only return if we actually have a first name
    if (firstNames) {
      return { firstNames, lastName, full };
    }
  }

  const parts = token.split(/\s+/).filter(Boolean);

  // If only one word, try to get first name from next token if available
  if (parts.length === 1) {
    const lastName = parts[0];

    // If we have more tokens, maybe the format is "Smith J" or "Smith, J"
    if (allTokens && allTokens.length > 1) {
      const nextToken = allTokens[1].trim();
      // Check if next token looks like initials (e.g., "J", "J. M.", "J M")
      if (/^[A-Z](\.?\s*[A-Z]?\.?)?$/.test(nextToken)) {
        // Use initials as first name
        const firstNames = nextToken.replace(/\s+/g, ' ');
        return { firstNames, lastName, full: `${firstNames} ${lastName}` };
      }
      // Check if next token is a first name (starts with capital, has lowercase)
      if (/^[A-Z][a-z]+/.test(nextToken) && !nextToken.includes(',')) {
        // Might be formatted as "Smith John" - reverse order
        return { firstNames: nextToken, lastName, full: `${nextToken} ${lastName}` };
      }
    }

    // If we can't find a first name, return null to indicate we need to skip this
    return { firstNames: '', lastName, full: lastName };
  }

  // Normal case: "First M. Last" or "First Middle Last"
  // Handle prefixed names like "John van der Berg" - lastName should be "van der Berg"
  // Check if there's a prefix before the last word (e.g., "John van der Berg")
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2]?.toLowerCase();
    const last = parts[parts.length - 1];

    // Common name prefixes
    const prefixPattern = /^(van|de|der|le|la|du|von|del|da|dos|des|el)$/i;

    // If second-to-last is a prefix, include it and all prefixes before it in last name
    if (secondLast && prefixPattern.test(secondLast)) {
      // Find all consecutive prefixes before the last word
      let lastNameStart = parts.length - 2;
      while (lastNameStart > 0 && prefixPattern.test(parts[lastNameStart - 1]?.toLowerCase())) {
        lastNameStart--;
      }

      // Build last name from prefix(es) + last word
      const lastName = parts.slice(lastNameStart).join(' ');
      const firstNames = parts.slice(0, lastNameStart).join(' ');
      const full = `${firstNames} ${lastName}`.trim();
      return { firstNames, lastName, full };
    }

    // Handle hyphenated last names: "John Smith-Jones" -> lastName is "Smith-Jones"
    if (last.includes('-')) {
      // Already hyphenated, use as is
      const lastName = last;
      const firstNames = parts.slice(0, -1).join(' ');
      const full = `${firstNames} ${lastName}`.trim();
      return { firstNames, lastName, full };
    }
  }

  // Standard case: last word is the last name
  const lastName = parts[parts.length - 1];
  const firstNames = parts.slice(0, -1).join(' ');
  const full = `${firstNames} ${lastName}`.trim();
  return { firstNames, lastName, full };
}

export function formatAuthors(authors: string | undefined): string {
  if (!authors || authors.trim() === '') return '';

  // Remove any existing "et al." from the input to avoid duplication
  // Handle various formats: "et al.", "et al", "et. al.", etc.
  let cleanedAuthors = authors.trim().replace(/\s+et\s+al\.?\s*$/i, '').trim();

  if (!cleanedAuthors) return '';

  const tokens = splitAuthorTokens(cleanedAuthors);
  if (tokens.length === 0) return '';

  // Try to parse the first author name
  const first = parseAuthorName(tokens[0], tokens);

  // If we only got a last name (no first name), try harder to find one
  if (!first.firstNames && tokens.length > 1) {
    // Try parsing the second token as a potential first name
    // Handle cases like "Smith, J" or "Smith J. M."
    const combined = tokens.slice(0, 2).join(', ');
    const retry = parseAuthorName(combined, tokens);
    if (retry.firstNames) {
      return `${retry.full} et al.`;
    }
  }

  // Only return if we have both first and last name
  if (first.firstNames && first.lastName) {
    return `${first.full} et al.`;
  }

  // If we still only have a last name, check if there are multiple tokens suggesting multiple authors
  // In that case, maybe the format is unusual - try to construct a better name
  if (!first.firstNames && tokens.length > 1) {
    // Maybe the format is like "Smith, Doe, Johnson" where each is a last name
    // Or "Smith J" where J is on the next token
    // Try combining first two tokens with a space
    const combinedToken = tokens[0] + ' ' + tokens[1];
    const combined = parseAuthorName(combinedToken, tokens);
    if (combined.firstNames) {
      return `${combined.full} et al.`;
    }
  }

  // Last resort: if we only have a last name, return "Unknown authors" to be safe
  if (!first.firstNames) {
    return 'Unknown authors';
  }

  // Always return "first last et al." format, even for single authors
  return `${first.full} et al.`;
}

// Some publishers (OUP/NAR most prominently) put graphical-abstract or
// significance-statement fragments in <dc:creator>, producing strings like
// "exploiting Cas12a's allosteric sensitivity" or "comparing wild-type
// plants with the AS mutant acinus pinin". These read as one-line English
// sentences, never as a list of names.
function looksLikeProseNotAuthors(s: string): boolean {
  const trimmed = s.replace(/\s+et\s+al\.?\s*$/i, '').trim();
  if (!trimmed) return false;
  // Real names start with a capital. A leading lowercase is the strongest
  // signal — every NAR garbage row observed starts with "integrating" /
  // "comparing" / "exploiting" / "targeting" / "combining" (lowercase).
  // Restrict to the lowercase-start check only. Earlier heuristics on
  // stopwords ("with", "from", "of the") false-positived on legit
  // arXiv author strings: "Smith (with an appendix by Jones)",
  // "(on behalf of the ATLAS Collaboration)", and surnames like "From".
  return /^[a-z]/.test(trimmed);
}

/**
 * Extract last name from first author for display
 * Returns empty string if authors can't be parsed
 * Format: "Last Name" for single author, "Last Name et al." for multiple
 */
export function formatAuthorLastName(authors: string | undefined): string {
  if (!authors || authors.trim() === '') return '';

  const originalAuthors = authors.trim();

  // Reject prose-shaped strings. OUP/NAR ships graphical-abstract clauses
  // in dc:creator (e.g. "integrating cell size awareness with cross-platform
  // robustness"), which without this check render as "[clause] et al."
  if (looksLikeProseNotAuthors(originalAuthors)) return '';

  // Determine if there are multiple authors by checking the original string
  // Check for: commas, semicolons, "and/&", or "et al." which all indicate multiple authors
  const hasComma = originalAuthors.includes(',');
  const hasSemicolon = originalAuthors.includes(';');
  const hasAnd = /\s+(and|&)\s+/i.test(originalAuthors);
  const hasEtAl = /\bet\s*al\.?\s*$/i.test(originalAuthors);

  // Special case: "Last, First" single-author format (one comma, second
  // half is initials or a single first name). Without this, "Smith, J."
  // gets parsed as two authors and shows "Smith et al."
  if (hasComma && !hasSemicolon && !hasAnd && !hasEtAl) {
    const commaParts = originalAuthors.split(',').map(s => s.trim()).filter(Boolean);
    if (commaParts.length === 2) {
      const second = commaParts[1];
      // Initials like "J.", "J. M.", "J M" — or short single first name "John", "Mary Anne"
      const looksLikeFirstName =
        /^([A-Z]\.?\s*)+$/.test(second) ||
        (second.length <= 25 && /^[A-Z][a-z]+(\s+[A-Z][a-z]+)?$/.test(second));
      if (looksLikeFirstName) {
        const lastNameParts = commaParts[0].split(/\s+/);
        return lastNameParts[lastNameParts.length - 1];
      }
    }
  }

  // Multiple authors if: has comma/semicolon, OR has "and/&", OR has "et al."
  // We'll also check token count after parsing as a fallback

  // Remove any existing "et al." from the input for parsing
  let cleanedAuthors = originalAuthors.replace(/\s+et\s+al\.?\s*$/i, '').trim();

  if (!cleanedAuthors) return '';

  const tokens = splitAuthorTokens(cleanedAuthors);
  if (tokens.length === 0) return '';

  // Determine if multiple authors based on original string markers OR token count
  // Multiple authors if: has comma/semicolon/and/et al. in original, OR has multiple tokens
  const isMultipleAuthors = hasComma || hasSemicolon || hasAnd || hasEtAl || tokens.length > 1;

  // Parse the first author name
  let first = parseAuthorName(tokens[0], tokens);

  // If we only got a last name (no first name), try harder to find one
  if (!first.firstNames && tokens.length > 1) {
    // Try parsing the second token as a potential first name
    const combined = tokens.slice(0, 2).join(', ');
    const retry = parseAuthorName(combined, tokens);
    if (retry.firstNames && retry.lastName) {
      // Return with or without "et al." based on author count
      return isMultipleAuthors ? `${retry.lastName} et al.` : retry.lastName;
    }
  }

  // If we still only have a last name, try combining tokens
  if (!first.firstNames && tokens.length > 1) {
    const combinedToken = tokens[0] + ' ' + tokens[1];
    const combined = parseAuthorName(combinedToken, tokens);
    if (combined.firstNames && combined.lastName) {
      // Multiple tokens always means multiple authors
      return `${combined.lastName} et al.`;
    }
    // If we truly only have a last name but there are multiple tokens, 
    // treat first token as last name (might be "Smith" format)
    if (combined.lastName) {
      // Multiple tokens always means multiple authors
      return `${combined.lastName} et al.`;
    }
  }

  // If we have a last name, return it
  if (first.lastName && first.lastName.trim()) {
    // Special case: if the entire token is just initials like "M.", "J. K.", etc.
    // and there's only one token, we can't determine last name
    if (tokens.length === 1 && /^[A-Z]\.?\s*([A-Z]\.?\s*)?$/i.test(tokens[0])) {
      return '';
    }

    // Use our author count determination
    if (isMultipleAuthors) {
      // Multiple authors - add "et al."
      return `${first.lastName} et al.`;
    } else {
      // Single author - no "et al."
      return first.lastName;
    }
  }

  // Can't parse - return empty string (don't show anything)
  return '';
}

/**
 * Get lab name (last author's last name) - only returns if there are multiple authors
 * Returns empty string if authors can't be parsed or there's only one author
 */
export function getLabName(authors: string | undefined): string {
  if (!authors || authors.trim() === '') return '';

  const originalAuthors = authors.trim();

  // Check if there are multiple authors BEFORE removing "et al."
  // Look for indicators: commas, semicolons, or "and"/"&" in the original string
  const hasComma = originalAuthors.includes(',');
  const hasSemicolon = originalAuthors.includes(';');
  const hasAnd = /\s+(and|&)\s+/i.test(originalAuthors);

  // If no indicators of multiple authors, return empty
  if (!hasComma && !hasSemicolon && !hasAnd) {
    // Even if there's "et al.", if there's no separator, it's likely a single author
    // that was formatted as "First Last et al."
    return '';
  }

  // Remove any existing "et al." from the input
  let cleanedAuthors = originalAuthors.replace(/\s+et\s+al\.?\s*$/i, '').trim();

  if (!cleanedAuthors) return '';

  const tokens = splitAuthorTokens(cleanedAuthors);

  // Only show lab name if there are multiple authors
  if (tokens.length <= 1) return '';

  // Parse the last author name
  const last = parseAuthorName(tokens[tokens.length - 1], tokens);

  // Return last name if we found one
  if (last.lastName && last.lastName.trim()) {
    return last.lastName;
  }

  // Can't parse - return empty string
  return '';
}

/**
 * Format date as "Feb 21, 2025"
 * Handles UTC dates properly to avoid timezone issues
 */
export function formatDate(dateString: string | undefined): string {
  if (!dateString) return '';
  try {
    const date = new Date(dateString);
    // Check if date is valid
    if (isNaN(date.getTime())) return '';

    // Use UTC methods to avoid timezone conversion issues
    // This ensures dates like "2025-11-02T21:37:42.155Z" display as Nov 2, not Nov 3
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Check if the date string is in ISO format with timezone info
    // ISO dates can end with 'Z' (UTC) or have timezone offset (+HH:MM or -HH:MM)
    // Also check if it contains 'T' separator which indicates ISO format
    const isISOFormat = dateString.includes('T');
    const endsWithZ = dateString.endsWith('Z');
    const hasTimezoneOffset = /[+-]\d{2}:?\d{2}$/.test(dateString);

    // If it's an ISO format date (which all our stored dates are), use UTC methods
    // This prevents timezone conversion from shifting the date by one day
    if (isISOFormat && (endsWithZ || hasTimezoneOffset)) {
      // ISO date with timezone - use UTC methods to preserve the intended date
      return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
    } else {
      // Local date or no timezone - use local methods
      return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }
  } catch {
    return '';
  }
}

/**
 * Format publication dates, showing online date if available and different from published date
 * Returns empty string if no valid dates
 */
export function formatPublicationDate(published: string | undefined, availableOnline: string | undefined): string {
  if (!published) {
    // If no published date, try to use online date
    return formatDate(availableOnline);
  }

  const publishedDate = formatDate(published);
  if (!publishedDate) {
    return formatDate(availableOnline);
  }

  // If no online date or same date, just return published date
  if (!availableOnline) {
    return publishedDate;
  }

  const onlineDate = formatDate(availableOnline);
  if (!onlineDate) {
    return publishedDate;
  }

  // Check if dates are the same (compare by date only, ignoring time)
  try {
    const publishedDateObj = new Date(published);
    const onlineDateObj = new Date(availableOnline);

    // Check if both dates are valid
    if (isNaN(publishedDateObj.getTime()) || isNaN(onlineDateObj.getTime())) {
      return publishedDate;
    }

    // Compare dates using UTC to avoid timezone issues
    // Compare year, month, and day
    if (
      publishedDateObj.getUTCFullYear() === onlineDateObj.getUTCFullYear() &&
      publishedDateObj.getUTCMonth() === onlineDateObj.getUTCMonth() &&
      publishedDateObj.getUTCDate() === onlineDateObj.getUTCDate()
    ) {
      return publishedDate;
    }

    // Different dates - show both
    return `${onlineDate} (published ${publishedDate})`;
  } catch {
    // If date parsing fails, just return published date
    return publishedDate;
  }
}

/**
 * Get journal logo with proper fallbacks for special cases (PLOS, Cell Press, etc.)
 * This ensures consistent logo handling across landing page and dashboard
 */
/**
 * Check if an article is new since the last visit
 * Uses published date or availableOnline date if published is not available
 */
export function isNewSinceLastVisit(entry: Entry, lastVisit: string | undefined): boolean {
  if (!lastVisit) return false;

  // Use availableOnline if available, otherwise use published
  const articleDate = entry.availableOnline || entry.published;
  if (!articleDate) return false;

  try {
    const articleDateObj = new Date(articleDate);
    const lastVisitDateObj = new Date(lastVisit);

    // Article is new if it was published after the last visit
    return articleDateObj > lastVisitDateObj;
  } catch {
    return false;
  }
}

export function getJournalLogo(logoFromCatalog: string | undefined, journalName: string, articleLink: string): string {
  const journalLower = journalName.toLowerCase();

  // Special handling for Cell Press journals (Cancer Cell, Cell, etc.)
  // Exclude Nature journals (e.g., "Nature Cell Biology", "Nature Reviews Molecular Cell Biology")
  const isNatureJournal = journalLower.startsWith('nature');
  const isCellPressJournal = !isNatureJournal && (
    journalLower.includes('cancer cell') ||
    journalLower.includes('cell ') ||
    journalLower === 'cell' ||
    journalLower.includes('trends in')
  );

  if (isCellPressJournal) {
    try {
      const url = new URL(articleLink);
      // If it's from sciencedirect but is a Cell Press journal, use cell.com
      if (url.hostname.includes('sciencedirect.com') || url.hostname.includes('cell.com')) {
        return `https://www.google.com/s2/favicons?domain=cell.com&sz=64`;
      }
    } catch {
      // URL parsing failed - fall through to default
    }
    // Always use cell.com for Cell Press journals
    return `https://www.google.com/s2/favicons?domain=cell.com&sz=64`;
  }

  // Special handling for PLOS - subdomains don't exist, use journals.plos.org
  try {
    const url = new URL(articleLink);
    if (url.hostname === 'journals.plos.org' || url.hostname.includes('plos.org')) {
      // Use journals.plos.org for all PLOS journals (subdomains don't work)
      return `https://www.google.com/s2/favicons?domain=journals.plos.org&sz=64`;
    }
  } catch {
    // URL parsing failed - fall through to catalog logo check
  }

  // If catalog logo exists and looks valid, use it (but fix PLOS/Cell Press if needed)
  if (logoFromCatalog && logoFromCatalog.trim() !== '' && logoFromCatalog.startsWith('http')) {
    // Replace PLOS subdomain logos with journals.plos.org (subdomains don't exist)
    if (logoFromCatalog.includes('plos') && logoFromCatalog.includes('google.com/s2/favicons')) {
      return `https://www.google.com/s2/favicons?domain=journals.plos.org&sz=64`;
    }
    // Replace ScienceDirect logos with cell.com for Cell Press journals
    if (isCellPressJournal && logoFromCatalog.includes('sciencedirect.com')) {
      return `https://www.google.com/s2/favicons?domain=cell.com&sz=64`;
    }
    return logoFromCatalog;
  }

  // Fallback: generate from article link domain
  try {
    const url = new URL(articleLink);
    let domain = url.hostname.replace('www.', '');

    // Handle PLOS in fallback too
    if (domain === 'journals.plos.org' || domain.includes('plos.org')) {
      domain = 'journals.plos.org';
    }

    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  } catch {
    return `https://www.google.com/s2/favicons?domain=scholar.google.com&sz=64`;
  }
}

