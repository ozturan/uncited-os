import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client for embeddings storage
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

/**
 * RSS Feed Fetcher with Multi-Source Abstract Enrichment
 *
 * This script fetches RSS feeds from scientific journals and enriches article metadata
 * with abstracts from multiple academic APIs using a cascade strategy.
 *
 * Abstract Enrichment (Cascade Strategy):
 * - ENABLED by default for articles with DOI or title
 * - Tries sources in order until an abstract is found:
 *   1. OpenAlex (best coverage, all disciplines)
 *   2. Semantic Scholar (great for CS/AI)
 *   3. Crossref (all disciplines with DOIs)
 *   4. PubMed (biomedical only)
 * - Only enriches if abstract is missing or short (<200 chars)
 * - Fails silently - won't break the feed fetch if APIs are down
 *
 * Environment Variables:
 * - ENABLE_ENRICHMENT=false : Disable abstract enrichment (enabled by default)
 * - NCBI_API_KEY : API key for PubMed (defaults to built-in key)
 *
 * Usage:
 *   node scripts/fetch.js                        # With abstract enrichment
 *   ENABLE_ENRICHMENT=false node scripts/fetch.js # Without abstract enrichment
 */

import Parser from 'rss-parser';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import cliProgress from 'cli-progress';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  customFields: {
    item: [
      ['prism:description', 'prism:description'],
      ['dc:description', 'dc:description'],
      ['content:encoded', 'content:encoded']
    ]
  }
});

// Load catalog
const catalogPath = process.env.CATALOG_PATH || join(__dirname, '../public/data/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

// Output directory
const outputDir = join(__dirname, '../public/data');
mkdirSync(outputDir, { recursive: true });

// Failed feeds tracking (skip on next runs)
const failedFeedsPath = join(__dirname, '../data/failed-feeds.json');
let failedFeeds = new Set();
if (existsSync(failedFeedsPath)) {
  try {
    const arr = JSON.parse(readFileSync(failedFeedsPath, 'utf-8'));
    if (Array.isArray(arr)) failedFeeds = new Set(arr);
  } catch (err) {
    console.warn('⚠️  Could not parse failed-feeds.json, starting fresh:', err.message);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Concurrent map function (like p-map) with concurrency limit
 * @param {Array} items - Items to iterate over
 * @param {Function} mapper - Async mapper function
 * @param {number} concurrency - Max concurrent executions
 * @returns {Promise<Array>} Results
 */
async function pMap(items, mapper, concurrency) {
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const workers = new Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const { item, index } = queue.shift();
      try {
        results[index] = await mapper(item);
      } catch (err) {
        results[index] = null; // Should handle errors in mapper, but safety net
        console.error(`Error in pMap at index ${index}:`, err.message);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Log a collapsible group header for GitHub Actions
 * @param {string} title - The title of the group
 */
function logGroup(title) {
  console.log(`::group::${title}`);
}

/**
 * Close the last collapsible group for GitHub Actions
 */
function endGroup() {
  console.log('::endgroup::');
}

// ====================================================================================
// Debug / Verbose Mode
// ====================================================================================
const VERBOSE = process.env.VERBOSE === 'true';
const DEBUG = process.env.DEBUG === 'true';
const slowFeeds = []; // Track slow feeds for debugging

// Debug log helper - logs everything with timestamp
function log(msg) {
  if (DEBUG) {
    const now = new Date().toISOString().slice(11, 19);
    console.log(`[${now}] ${msg}`);
  }
}

// ====================================================================================
// Multi-Source Abstract Enrichment (Cascade Strategy)
// ====================================================================================
const ENRICHMENT_ENABLED = process.env.ENABLE_ENRICHMENT !== 'false'; // Enabled by default
const ENRICHMENT_TIMEOUT = 10000; // 10s timeout per API call
const NCBI_API_KEY = process.env.NCBI_API_KEY || ''; // Set NCBI_API_KEY env var for higher rate limits
const ELSEVIER_API_KEY = process.env.ELSEVIER_API_KEY || ''; // Set ELSEVIER_API_KEY env var for ScienceDirect API

// Enrichment statistics (global counters)
const enrichmentStats = {
  openAlex: 0,
  semanticScholar: 0,
  crossref: 0,
  pubmed: 0,
  elsevier: 0,
  total: 0
};

// ====================================================================================
// Article Type Classification
// ====================================================================================
const CLASSIFICATION_ENABLED = process.env.ENABLE_CLASSIFICATION !== 'false' && !!process.env.ANTHROPIC_API_KEY;
const CLASSIFICATION_BATCH_SIZE = 20;
const VALID_ARTICLE_TYPES = ['Research', 'Review', 'Letter', 'Commentary', 'News', 'Editorial', 'Preprint', 'Other'];

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ====================================================================================
// Embedding Generation (OpenAI)
// ====================================================================================
let EMBEDDING_ENABLED = process.env.ENABLE_EMBEDDINGS !== 'false' && !!process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'text-embedding-3-small';

// In single-user local mode the API keys may live in the database (set via
// Settings -> Setup) instead of the environment. Load them at startup so a
// self-hoster can turn on embeddings from the UI without editing env files.
// Environment variables always win.
async function loadLocalApiKeys() {
  try {
    if (!supabase) return;
    const { data } = await supabase
      .from('user_state')
      .select('settings')
      .eq('user_id', '11111111-1111-4111-8111-111111111111')
      .maybeSingle();
    const keys = (data && data.settings && data.settings.apiKeys) || {};
    if (keys.openai && !process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = keys.openai;
    if (keys.anthropic && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = keys.anthropic;
  } catch {
    // best-effort; embeddings stay off if we can't read the key
  }
  EMBEDDING_ENABLED = process.env.ENABLE_EMBEDDINGS !== 'false' && !!process.env.OPENAI_API_KEY;
}
const EMBEDDING_BATCH_SIZE = 100;

// Embedding statistics
const embeddingStats = {
  generated: 0,
  skipped: 0,
  errors: 0
};

/**
 * Generate embeddings for articles using OpenAI API and store in Supabase
 * @param {Array} articles - Articles to embed
 * @param {string} journalId - Journal ID for the articles
 * @returns {Promise<void>}
 */
async function generateEmbeddings(articles, journalId) {
  if (!EMBEDDING_ENABLED || !supabase) return;

  // Check which articles already have embeddings in Supabase.
  // Chunk — PostgREST silently truncates .in() at db.max_rows (default
  // 1000), so a large batch would miss existing rows and re-embed them.
  const articleIds = articles.map(a => a.id).filter(Boolean);
  const existingIds = new Set();
  const CHECK_CHUNK = 500;
  for (let i = 0; i < articleIds.length; i += CHECK_CHUNK) {
    const batch = articleIds.slice(i, i + CHECK_CHUNK);
    const { data: rows } = await supabase
      .from('article_embeddings')
      .select('article_id')
      .in('article_id', batch);
    for (const r of rows || []) existingIds.add(r.article_id);
  }
  const needEmbeddings = articles.filter(a => a.id && !existingIds.has(a.id));

  if (needEmbeddings.length === 0) {
    embeddingStats.skipped += articles.length;
    return;
  }

  process.stdout.write(`🧬 Generating embeddings for ${needEmbeddings.length} articles... `);

  // Process in batches
  for (let i = 0; i < needEmbeddings.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = needEmbeddings.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map(a => {
      const abstract = a.abstract || '';
      return `${a.title}. ${abstract}`.substring(0, 8000);
    });

    try {
      const embeddings = await getEmbeddingsWithRetry(texts);

      // Store embeddings in Supabase
      // Truncate to 256 dimensions (Matryoshka representation - works with minimal accuracy loss)
      // Stamp canonical_id so match_papers_* see the row (they filter canonical_id is not null).
      const { resolveCanonicalId } = await import('./lib/canonical.mjs');
      const records = batch.map((article, idx) => {
        const truncated = embeddings[idx].slice(0, 256);
        let canonical_id = null;
        try {
          const r = resolveCanonicalId({ ...article, journalId });
          canonical_id = r?.canonical_id || null;
        } catch { /* swallow — resolver failures shouldn't block ingest */ }
        return {
          article_id: article.id,
          journal_id: journalId,
          embedding_half: truncated,
          published: article.published || article.availableOnline || article.updated || null,
          canonical_id,
        };
      });

      const { error } = await supabase
        .from('article_embeddings')
        .upsert(records, { onConflict: 'article_id' });

      if (error) {
        console.error(`\n   ⚠️  Supabase error: ${error.message}`);
        embeddingStats.errors += batch.length;
      } else {
        embeddingStats.generated += batch.length;
      }

    } catch (error) {
      console.error(`\n   ⚠️  Embedding error for batch ${i}-${i + batch.length}: ${error.message}`);
      embeddingStats.errors += batch.length;
    }
  }

  embeddingStats.skipped += articles.length - needEmbeddings.length;
  process.stdout.write(`✅\n`);
}

/**
 * Call OpenAI embeddings API with retry logic
 * @param {Array<string>} texts - Texts to embed
 * @param {number} retries - Max retries
 * @returns {Promise<Array<number[]>>}
 */
async function getEmbeddingsWithRetry(texts, retries = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({ model: OPENAI_MODEL, input: texts })
      });

      if (response.status === 429) {
        const error = await response.json();
        lastError = new Error(`Rate limited: ${error.error?.message || 'Unknown'}`);
        const waitMatch = error.error.message.match(/try again in (\d+)ms/);
        const waitTime = waitMatch ? parseInt(waitMatch[1]) : Math.pow(2, attempt) * 1000;

        await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error (${response.status}): ${error}`);
      }

      const data = await response.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);

    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) throw error;

      const waitTime = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  throw new Error(`Max retries exceeded: ${lastError?.message || 'Unknown error'}`);
}

// Popular science outlets - always News
const POPULAR_SCIENCE_JOURNALS = [
  'ars technica', 'astronomy magazine', 'bbc science', 'futurism', 'gizmodo',
  'live science', 'mit technology review', 'nautilus', 'new scientist',
  'phys.org', 'popular science', 'quanta magazine', 'science alert',
  'science daily', 'science magazine (aaas)', 'science news', 'scientific american', 'smithsonian',
  'the atlantic', 'the conversation', 'the guardian', 'the new york times',
  'the verge', 'vox', 'wired'
];

// Rule-based classification - returns type if rule matches, null otherwise
function classifyByRules(article) {
  const title = article.title || '';
  const abstract = article.abstract || '';
  const link = article.link || '';
  const titleLower = title.toLowerCase();
  const journalLower = (article.journal || '').toLowerCase();

  // Layer 0: Preprints (Source Based)
  if (/arxiv|biorxiv|medrxiv|chemrxiv|psyarxiv/.test(journalLower)) return 'Preprint';
  if (link.includes('arxiv') || link.includes('biorxiv') || link.includes('medrxiv')) return 'Preprint';

  // Layer 0.5: Popular Science / News Outlets
  if (POPULAR_SCIENCE_JOURNALS.some(j => journalLower.includes(j))) return 'News';

  // Review journals
  if (/^annual review of/i.test(journalLower) || /chemical society reviews/i.test(journalLower) || /nature reviews/i.test(journalLower)) {
    // Exception: If abstract says "This perspective", it's a Commentary (Perspective)
    if (/\b(this|in this) perspective\b/i.test(abstract)) return 'Commentary';
    return 'Review';
  }

  // Nature news URL
  if (link.includes('nature.com') && link.includes('/d41586-')) return 'News';

  // Other / Corrections / Mastheads / Retractions
  if (/^(corrigendum|erratum|author correction|publisher correction|correction to)/i.test(title)) return 'Other';
  if (/issue (editorial )?masthead|issue publication information/i.test(titleLower)) return 'Other';
  if (/^obituary/i.test(title)) return 'Other';
  if (/^retraction( notice)?( to)?:/i.test(title)) return 'Other';
  if (/^expression of concern/i.test(title)) return 'Other';

  // Editorial
  if (/^editorial:/i.test(title)) return 'Editorial';
  if (/^special issue/i.test(title)) return 'Editorial';
  if (/^(commentary|opinion|viewpoint|perspective)[:\s\-–—]/i.test(titleLower)) return 'Commentary';

  // Review patterns (explicit)
  // if (/^perspective[:\s\-–—]/i.test(titleLower)) return 'Review'; // Corrected: Perspective is Commentary
  if (titleLower.includes('systematic review') || titleLower.includes('meta-analysis')) return 'Review';
  if (/\breview of (the )?literature\b/i.test(titleLower)) return 'Review';
  if (/\bcomprehensive review\b/i.test(titleLower)) return 'Review';
  if (/\bscoping review\b/i.test(titleLower)) return 'Review';
  if (/:\s*a review$/i.test(title) || /\ba review$/i.test(title)) return 'Review';
  if (/\bnarrative review\b/i.test(titleLower)) return 'Review';

  // Abstract checks for Review/Perspective
  if (/\b(in this|this) perspective\b/i.test(abstract)) return 'Commentary'; // Changed to Commentary
  if (/\bhere,? we offer a perspective\b/i.test(abstract)) return 'Commentary'; // Changed to Commentary

  // Review articles that discuss advances or offer frameworks
  if (/\b(discuss|discusses) recent (advances|developments|progress)\b/i.test(abstract)) return 'Review';
  if (/\b(colleagues|authors) (discuss|review|examine)\b/i.test(abstract)) return 'Review';
  if (/\b(offering|providing) a framework\b/i.test(abstract)) return 'Review';

  // Research heuristics
  const researchPattern = /\b(we (report|show|demonstrate|present|found|observed|propose)|our (results|findings|data|study)|here, we)\b/i;
  if (researchPattern.test(abstract) && !/\bwe review\b/i.test(abstract)) return 'Research';

  return null;
}

// Same prompt as scripts/classify-articles.js so in-fetch and standalone
// reclassification agree. If you tune one, tune both — or import from there.
const CLASSIFICATION_SYSTEM_PROMPT = `You are a scientific article classifier. Classify each article into EXACTLY ONE type:

TYPES:
- Research: Original studies presenting NEW data, experiments, methods, clinical trials, case reports, technical implementations
- Review: Synthesizes EXISTING literature. Look for: "We review", "This review", "literature survey", "systematic review", "meta-analysis"
- Letter: Brief correspondence. Look for: "Letter to editor", "Reply to", "Response to", "Comment on", "Re:"
- Commentary: Opinion/perspective pieces. NOT presenting new data. Look for: "Commentary", "Perspective", "Viewpoint", "Opinion"
- News: JOURNALISM summarizing OTHERS' work. Written by reporters, not researchers. Look for: "Scientists found", "A study shows", "Researchers at X discovered"
- Editorial: Editor's notes, introductions to journal issues. Look for: "Editorial", "Editor's note", "Preface", "Foreword"
- Preprint: arXiv, bioRxiv, medRxiv manuscripts
- Other: Corrections, retractions, errata, announcements, quizzes, book reviews, obituaries

CRITICAL DISAMBIGUATION RULES:

1. **Research vs Review**:
   - Research = Authors present THEIR OWN new findings ("We measured", "Our results show", "This study demonstrates")
   - Review = Authors summarize OTHERS' findings ("We review", "This paper surveys", "Recent advances include")
   - If title has "survey" or "advances" but abstract says "We present/propose/develop" → Research
   - Math/statistics papers presenting new theorems or methods → Research

2. **Research vs News**:
   - Research = Published in academic journals, has methods/results
   - News = Published in news outlets, interviews researchers, reports on studies
   - Articles FROM academic journals are almost NEVER "News" unless explicitly labeled as news/journalism

3. **Research vs Commentary**:
   - Research = Has data, methods, results, experiments
   - Commentary = Opinion-based, discusses implications, calls for action, no new data
   - "Perspectives on..." without new data → Commentary
   - Case studies with clinical data → Research

4. **Research vs Other**:
   - Foreign language textbook chapters (EMC journals) → Other
   - Pure mathematical proofs without application → Research
   - Clinical case reports with patient data → Research
   - Book reviews → Other

5. **News vs Editorial**:
   - News = Reports on external research
   - Editorial = Internal journal matters, editor addressing readers

EXAMPLES:
- "A deep learning model for protein folding" + "We propose a new architecture..." → Research
- "Advances in deep learning for biology" + "This review covers recent progress..." → Review
- "AI cracks protein code" + "Scientists at DeepMind have achieved..." → News
- "The future of AI in medicine" + "We argue that healthcare needs..." → Commentary (opinion, no data)
- "Reply to Smith et al." → Letter
- "Correction to: Previous paper title" → Other
- "Progress in cancer research 2025" + "Highlights key discoveries made this year..." → Review (summarizing others)
- "A novel cancer biomarker" + "We identified and validated..." → Research (their own work)

Respond with ONLY a JSON array of types. Example: ["Research","Review","Letter"]
No explanations.`;

async function classifyArticleBatch(articles) {
  if (!anthropic || articles.length === 0) return articles;

  const items = articles.map((a, i) => {
    const abstract = a.abstract ? a.abstract.substring(0, 400) : 'No abstract';
    return `Article ${i + 1}:
Title: ${a.title}
Journal: ${a.journal}
Abstract: ${abstract}`;
  });

  try {
    let text;
    const userContent = `Classify these ${articles.length} articles:\n\n${items.join('\n\n---\n\n')}`;

    // Prefer Gemini, fall back to the secondary LLM
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey) {
      const geminiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${googleKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: CLASSIFICATION_SYSTEM_PROMPT + '\n\n' + userContent }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      const geminiData = await geminiResp.json();
      text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    } else if (anthropic) {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        system: CLASSIFICATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      });
      text = response.content[0].text.trim();
    } else {
      return articles;
    }

    // Try to extract JSON array if wrapped in other text
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      text = jsonMatch[0];
    }

    const types = JSON.parse(text);

    if (Array.isArray(types)) {
      for (let i = 0; i < Math.min(articles.length, types.length); i++) {
        if (VALID_ARTICLE_TYPES.includes(types[i])) {
          articles[i].type = types[i];
        }
      }
    }
  } catch (error) {
    // Silent fail - classification is optional
    if (process.env.DEBUG) console.error('Classification error:', error.message);
  }

  return articles;
}

async function classifyNewArticles(entries) {
  if (entries.length === 0) {
    return entries;
  }

  console.log(`\n🏷️  Classifying ${entries.length} new articles...`);
  const startTime = Date.now();

  // First pass: Rule-based classification (fast, no API calls)
  const toClassifyWithLLM = [];
  let ruleClassified = 0;

  for (const entry of entries) {
    const ruleType = classifyByRules(entry);
    if (ruleType) {
      entry.type = ruleType;
      ruleClassified++;
    } else {
      toClassifyWithLLM.push(entry);
    }
  }

  console.log(`   📋 ${ruleClassified} classified by rules`);

  // Second pass: LLM classification for remaining articles (if API is available)
  if (CLASSIFICATION_ENABLED && toClassifyWithLLM.length > 0) {
    let llmClassified = 0;
    for (let i = 0; i < toClassifyWithLLM.length; i += CLASSIFICATION_BATCH_SIZE) {
      const batch = toClassifyWithLLM.slice(i, i + CLASSIFICATION_BATCH_SIZE);
      await classifyArticleBatch(batch);
      llmClassified += batch.length;

      // Progress update every 100 articles
      if (llmClassified % 100 === 0) {
        process.stdout.write(`   ${llmClassified}/${toClassifyWithLLM.length} LLM classified\r`);
      }
    }
    console.log(`   ${toClassifyWithLLM.filter(e => e.type).length} classified by LLM`);
  } else if (toClassifyWithLLM.length > 0) {
    // Default unclassified articles to Research if no API
    for (const entry of toClassifyWithLLM) {
      if (!entry.type) entry.type = 'Research';
    }
    console.log(`   ⚠️  ${toClassifyWithLLM.length} defaulted to Research (no API key)`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const withTypes = entries.filter(e => e.type).length;
  console.log(`   ✅ ${withTypes} total articles classified (${elapsed}s)`);

  return entries;
}

// Helper: Make HTTP GET request with timeout
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout'));
    }, ENRICHMENT_TIMEOUT);

    https.get(url, options, (res) => {
      clearTimeout(timeout);
      let data = '';

      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// 1. OpenAlex API - Best overall coverage
async function tryOpenAlex(doi) {
  if (!doi) return null;
  try {
    // No delay needed - pMap concurrency provides natural rate limiting
    const cleanDOI = doi.replace(/[?&#].*$/, '');
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(cleanDOI)}`;
    const data = await httpGet(url, {
      headers: { 'User-Agent': 'Uncited RSS Reader (mailto:contact@uncited.com)' }
    });
    const parsed = JSON.parse(data);
    const result = {};

    // Reconstruct abstract from inverted index (if available)
    const abstract = parsed.abstract_inverted_index;
    if (abstract) {
      const words = [];
      for (const [word, positions] of Object.entries(abstract)) {
        for (const pos of positions) {
          words[pos] = word;
        }
      }
      const reconstructed = words.filter(Boolean).join(' ');
      if (reconstructed.length > 200) result.abstract = reconstructed;
    }

    // Always try to extract authors, even without abstract
    if (parsed.authorships && Array.isArray(parsed.authorships)) {
      const authors = parsed.authorships
        .map(a => a.author && a.author.display_name)
        .filter(Boolean)
        .join(', ');
      if (authors) result.authors = authors;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    return null; // Fail silently
  }
}

// 2. Semantic Scholar API - Great for CS/AI
async function trySemanticScholar(doi, title) {
  try {
    // No delay needed - pMap concurrency provides natural rate limiting
    let url;
    if (doi) {
      const cleanDOI = doi.replace(/[?&#].*$/, '');
      url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(cleanDOI)}?fields=abstract,authors`;
    } else if (title) {
      url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&fields=abstract,authors&limit=1`;
    } else {
      return null;
    }

    const data = await httpGet(url, {
      headers: { 'User-Agent': 'Uncited RSS Reader (mailto:contact@uncited.com)' }
    });
    const parsed = JSON.parse(data);

    // Handle search result vs direct lookup
    const paper = parsed.data?.[0] || parsed;
    const result = {};

    // Extract abstract
    const abstract = paper.abstract;
    if (abstract && abstract.length > 200) result.abstract = abstract;

    // Always try to extract authors, even without abstract
    if (paper.authors && Array.isArray(paper.authors)) {
      const authors = paper.authors
        .map(a => a.name)
        .filter(Boolean)
        .join(', ');
      if (authors) result.authors = authors;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    return null; // Fail silently
  }
}

// 3. Crossref API - Covers all disciplines with DOIs
async function tryCrossref(doi) {
  if (!doi) return null;
  try {
    // No delay needed - pMap concurrency provides natural rate limiting
    const cleanDOI = doi.replace(/^https?:\/\/doi\.org\//, '').replace(/[?&#].*$/, '');
    const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDOI)}`;
    const data = await httpGet(url, {
      headers: { 'User-Agent': 'Uncited RSS Reader (mailto:contact@uncited.com)' }
    });
    const parsed = JSON.parse(data);
    const result = {};

    // Extract abstract if available
    const abstract = parsed.message?.abstract;
    if (abstract && typeof abstract === 'string') {
      // Clean XML tags that Crossref sometimes includes
      const cleaned = abstract
        .replace(/<jats:p>/g, '')
        .replace(/<\/jats:p>/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
      if (cleaned.length > 200) result.abstract = cleaned;
    }

    // Always try to extract authors, even without abstract
    if (parsed.message?.author && Array.isArray(parsed.message.author)) {
      const authors = parsed.message.author
        .map(a => {
          if (a.given && a.family) return `${a.given} ${a.family}`;
          if (a.name) return a.name; // Organization or name field
          if (a.family) return a.family;
          return null;
        })
        .filter(Boolean)
        .join(', ');
      if (authors) result.authors = authors;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    return null; // Fail silently
  }
}

// 4. PubMed API - Biomedical only
async function tryPubMed(doi) {
  if (!doi) return null;
  try {
    await delay(100); // 10 req/sec with API key
    const cleanDOI = doi.replace(/[?&#].*$/, '');

    // Search for PMID
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(cleanDOI)}[DOI]&retmode=json&tool=uncited&email=contact@uncited.com&api_key=${NCBI_API_KEY}`;
    const searchData = await httpGet(searchUrl);
    const searchParsed = JSON.parse(searchData);
    const pmid = searchParsed.esearchresult?.idlist?.[0];

    if (!pmid) return null;

    await delay(100);

    // Fetch abstract
    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml&tool=uncited&email=contact@uncited.com&api_key=${NCBI_API_KEY}`;
    const fetchData = await httpGet(fetchUrl);
    const abstractMatch = fetchData.match(/<AbstractText[^>]*>(.*?)<\/AbstractText>/is);

    const result = {};

    if (abstractMatch && abstractMatch[1]) {
      const abstract = abstractMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      if (abstract.length > 200) result.abstract = abstract;
    }

    // Extract authors from PubMed XML
    const authorMatches = [...fetchData.matchAll(/<Author[^>]*>\s*<LastName>(.*?)<\/LastName>\s*<ForeName>(.*?)<\/ForeName>/g)];
    if (authorMatches.length > 0) {
      result.authors = authorMatches
        .map(m => `${m[2]} ${m[1]}`) // First Last
        .join(', ');
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    return null; // Fail silently
  }
}

// 5. Elsevier ScienceDirect API - For Elsevier journals (requires API key).
// Elsevier RSS ships neither abstract nor DOI — only a PII in the link — so we support
// lookup by DOI (10.1016 papers) AND by PII (the DOI-less title-keyed majority).
// view=META_ABS is REQUIRED: the default META view returns metadata WITHOUT the abstract
// (dc:description). Verified live; needs no institutional entitlement (weekly quota only).
function parseElsevierArticle(parsed) {
  const core = parsed?.['full-text-retrieval-response']?.coredata
    || parsed?.coredata
    || parsed?.['abstracts-retrieval-response']?.coredata
    || {};
  const rawAbs = core['dc:description'] || parsed?.['full-text-retrieval-response']?.['dc:description'];
  let abstract = null;
  if (rawAbs && typeof rawAbs === 'string') {
    const cleaned = rawAbs
      .replace(/<[^>]+>/g, '')
      .replace(/^\s*Abstract\s*[:.-]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 50) abstract = cleaned;
  }
  let authors = null;
  const creators = core['dc:creator'];
  if (creators) {
    if (Array.isArray(creators)) authors = creators.map(c => c['$'] || c).join(', ');
    else if (typeof creators === 'string') authors = creators;
    else if (creators['$']) authors = creators['$'];
  }
  // The DOI is the whole point for DOI-less ScienceDirect RSS items: coredata
  // carries it as prism:doi (and dc:identifier as "doi:..."). Capturing it lets
  // the PII-resolved paper get a real doi: canonical_id instead of a title hash,
  // which unlocks PDFs / enrichment / recommendations for the Elsevier bulk.
  let doi = null;
  const rawDoi = core['prism:doi']
    || (typeof core['dc:identifier'] === 'string' ? core['dc:identifier'] : null);
  if (rawDoi) {
    const d = String(rawDoi).replace(/^doi:/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    if (/^10\.\d{4,9}\/\S+$/.test(d)) doi = d;
  }
  const result = {};
  if (abstract) result.abstract = abstract;
  if (authors) result.authors = authors;
  if (doi) result.doi = doi;
  return Object.keys(result).length > 0 ? result : null;
}

async function tryElsevierUrl(url) {
  try {
    const data = await httpGet(url, {
      headers: { 'X-ELS-APIKey': ELSEVIER_API_KEY, 'Accept': 'application/json' },
    });
    return parseElsevierArticle(JSON.parse(data));
  } catch (err) {
    return null; // Fail silently (incl. 429/quota — backfill handles bulk recovery)
  }
}

async function tryElsevier(doi) {
  if (!doi || !ELSEVIER_API_KEY) return null;
  const cleanDOI = doi.replace(/[?&#].*$/, '');
  if (!cleanDOI.startsWith('10.1016')) return null; // only Elsevier DOIs
  return tryElsevierUrl(`https://api.elsevier.com/content/article/doi/${encodeURIComponent(cleanDOI)}?view=META_ABS&httpAccept=application/json`);
}

// Lookup by ScienceDirect PII (for DOI-less Elsevier RSS items — the bulk of the gap).
async function tryElsevierByPII(pii) {
  if (!pii || !ELSEVIER_API_KEY) return null;
  return tryElsevierUrl(`https://api.elsevier.com/content/article/pii/${encodeURIComponent(pii)}?view=META_ABS&httpAccept=application/json`);
}

// Cascade Strategy: Try each source until we find good metadata
// OPTIMIZED: Skip APIs that require DOI when we don't have one
async function enrichArticleMetadata(doi, title, currentAbstract, currentAuthors, link) {
  // Already have good data? Skip enrichment
  const hasGoodAbstract = currentAbstract && currentAbstract.trim().length > 200;
  const hasAuthors = currentAuthors && currentAuthors.trim().length > 0;

  if (hasGoodAbstract && hasAuthors) {
    log(`⏭️ Skipping enrichment - already have abstract & authors`);
    return { abstract: currentAbstract, authors: currentAuthors, source: null };
  }

  if (!ENRICHMENT_ENABLED) {
    return { abstract: currentAbstract, authors: currentAuthors, source: null };
  }

  // Need at least DOI or title to search
  if (!doi && !title) {
    return { abstract: currentAbstract, authors: currentAuthors, source: null };
  }

  try {
    let result = { abstract: currentAbstract, authors: currentAuthors, source: null, doi: null };

    // If we have DOI, try DOI-based APIs first (they're more accurate)
    if (doi) {
      // 0. Try Elsevier API first for Elsevier DOIs (10.1016) - Direct access
      if (doi.includes('/10.1016/') || doi.startsWith('10.1016/')) {
        log(`→ Elsevier: ${doi}`);
        const elsevierData = await tryElsevier(doi);
        if (elsevierData) {
          log(`← Elsevier: ✅ found`);
          enrichmentStats.elsevier++;
          enrichmentStats.total++;

          if (elsevierData.abstract) result.abstract = elsevierData.abstract; // already gated >=50 in parser
          if (elsevierData.authors) result.authors = elsevierData.authors;
          result.source = 'elsevier';

          // Return early if we have everything
          if (result.abstract && result.authors) return result;
        } else {
          log(`← Elsevier: ❌`);
        }
      }

      // Try OpenAlex first (best coverage, fast) - REQUIRES DOI
      log(`→ OpenAlex: ${doi}`);
      const openAlexData = await tryOpenAlex(doi);
      if (openAlexData) {
        log(`← OpenAlex: ✅ found`);
        enrichmentStats.openAlex++;
        enrichmentStats.total++;

        if (openAlexData.abstract && openAlexData.abstract.length > 200) result.abstract = openAlexData.abstract;
        if (openAlexData.authors) result.authors = openAlexData.authors;
        result.source = 'openalex';

        if (result.abstract && result.authors) return result;
      } else {
        log(`← OpenAlex: ❌`);
      }

      // Try Semantic Scholar with DOI
      log(`→ Semantic Scholar: ${doi}`);
      const semanticData = await trySemanticScholar(doi, null);
      if (semanticData) {
        log(`← Semantic Scholar: ✅ found`);
        enrichmentStats.semanticScholar++;
        enrichmentStats.total++;

        if (semanticData.abstract && semanticData.abstract.length > 200) result.abstract = semanticData.abstract;
        if (semanticData.authors) result.authors = semanticData.authors;
        result.source = 'semantic-scholar';

        if (result.abstract && result.authors) return result;
      } else {
        log(`← Semantic Scholar: ❌`);
      }

      // Try Crossref - REQUIRES DOI
      log(`→ Crossref: ${doi}`);
      const crossrefData = await tryCrossref(doi);
      if (crossrefData) {
        log(`← Crossref: ✅ found`);
        enrichmentStats.crossref++;
        enrichmentStats.total++;

        if (crossrefData.abstract && crossrefData.abstract.length > 200) result.abstract = crossrefData.abstract;
        if (crossrefData.authors) result.authors = crossrefData.authors;
        result.source = 'crossref';

        if (result.abstract && result.authors) return result;
      } else {
        log(`← Crossref: ❌`);
      }

      // Try PubMed last - REQUIRES DOI
      log(`→ PubMed: ${doi}`);
      const pubmedData = await tryPubMed(doi);
      if (pubmedData) {
        log(`← PubMed: ✅ found`);
        enrichmentStats.pubmed++;
        enrichmentStats.total++;

        if (pubmedData.abstract && pubmedData.abstract.length > 200) result.abstract = pubmedData.abstract;
        if (pubmedData.authors) result.authors = pubmedData.authors;
        result.source = 'pubmed';

        if (result.abstract && result.authors) return result;
      } else {
        log(`← PubMed: ❌`);
      }

    } else if (title) {
      // NO DOI. ScienceDirect (Elsevier) RSS items have neither abstract nor DOI, only a
      // PII in the link — but Elsevier's PII endpoint returns the abstract (and DOI). This
      // is the dominant DOI-less case, so try it before the unreliable S2 title search.
      const piiMatch = link && link.match(/sciencedirect\.com\/science\/article\/pii\/(S[0-9A-Z]+)/i);
      if (piiMatch) {
        log(`→ Elsevier PII: ${piiMatch[1]}`);
        const elsevierData = await tryElsevierByPII(piiMatch[1]);
        if (elsevierData) {
          log(`← Elsevier PII: ✅ found`);
          enrichmentStats.elsevier++;
          enrichmentStats.total++;
          if (elsevierData.abstract) result.abstract = elsevierData.abstract;
          if (elsevierData.authors && !hasAuthors) result.authors = elsevierData.authors;
          // Promote the resolved DOI so the DOI-less item gets a real identity.
          if (elsevierData.doi) result.doi = elsevierData.doi;
          result.source = 'elsevier-pii';
          if (result.abstract && result.authors) return result;
        } else {
          log(`← Elsevier PII: ❌`);
        }
      }

      // NO DOI - only Semantic Scholar can search by title
      log(`→ Semantic Scholar (title only): ${title.slice(0, 40)}...`);
      const semanticData = await trySemanticScholar(null, title);
      if (semanticData) {
        log(`← Semantic Scholar: ✅ found`);
        enrichmentStats.semanticScholar++;
        enrichmentStats.total++;

        if (semanticData.abstract && semanticData.abstract.length > 200) result.abstract = semanticData.abstract;
        if (semanticData.authors) result.authors = semanticData.authors;
        result.source = 'semantic-scholar';

        return result;
      }
      log(`← Semantic Scholar: ❌`);
    }

    // Return whatever we found (could be partial or just original)
    return result;
  } catch (err) {
    // Fail silently and return what we have
    return { abstract: currentAbstract, authors: currentAuthors, source: null };
  }
}
// ====================================================================================

// Helper: Add hard timeout wrapper to any promise
function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
    )
  ]);
}

// Fetch feed with retries and timeout
async function fetchFeed(url, retries = 2) { // 2 retries with exponential backoff
  const fetchStart = Date.now();

  // Special handling for various publishers with specific requirements
  const isAnnualReviews = url.includes('annualreviews.org');
  const isELife = url.includes('elifesciences.org');
  const isOxford = url.includes('academic.oup.com');
  const isNature = url.includes('nature.com');
  const isBioMedCentral = url.includes('biomedcentral.com');
  const isIOP = url.includes('iopscience.iop.org');
  const isMDPI = url.includes('mdpi.com');
  const isMITPress = url.includes('mitpressjournals.org');
  const isACS = url.includes('pubs.acs.org');
  const isWiley = url.includes('onlinelibrary.wiley.com') || url.includes('besjournals.onlinelibrary.wiley.com');
  const isSpringer = url.includes('link.springer.com');

  // Publishers that need more retries or special handling
  const actualRetries = isAnnualReviews ? 3 : (isACS || isWiley || isSpringer ? 3 : retries);

  for (let i = 0; i < actualRetries; i++) {
    try {
      // For Annual Reviews, use a custom parser instance
      // Note: Try multiple User-Agent strategies to avoid Cloudflare blocking
      if (isAnnualReviews) {
        // Strategy 1: Try with RSS reader User-Agent (most legitimate for RSS feeds)
        const strategies = [
          {
            'User-Agent': 'FeedReader/1.0 (compatible; RSS Reader)',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
          },
          {
            'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader/1.0)',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
          },
          {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.annualreviews.org/'
          }
        ];

        for (let strategyIdx = 0; strategyIdx < strategies.length; strategyIdx++) {
          try {
            if (strategyIdx > 0) {
              await delay(1000 * strategyIdx); // Progressive delay
            }
            const annualReviewsParser = new Parser({
              timeout: 20000,
              headers: strategies[strategyIdx],
              customFields: {
                item: [
                  ['prism:description', 'prism:description'],
                  ['dc:description', 'dc:description'],
                  ['content:encoded', 'content:encoded']
                ]
              }
            });
            const feed = await withTimeout(annualReviewsParser.parseURL(url), 30000);
            // Return feed if it exists (even if empty - let main logic handle it)
            // This ensures we don't skip valid feeds that might have items
            if (feed) {
              return feed;
            }
          } catch (error) {
            // Try next strategy
            if (strategyIdx === strategies.length - 1) {
              // Last strategy failed, throw to trigger retry logic
              throw error;
            }
          }
        }
        // If all strategies tried but no feed returned, return null
        return null;
      }
      // For eLife, use longer timeout (feed can be slow)
      // Also manually fetch and decompress/strip BOM to avoid parsing errors
      else if (isELife) {
        // Manually fetch the feed content to handle decompression and BOM stripping
        const https = await import('https');
        const zlib = await import('zlib');
        const { promisify } = await import('util');
        const gunzip = promisify(zlib.gunzip);

        const response = await new Promise((resolve, reject) => {
          https.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br'
            },
            timeout: 20000
          }, resolve).on('error', reject);
        });

        const chunks = [];
        for await (const chunk of response) {
          chunks.push(chunk);
        }
        let buffer = Buffer.concat(chunks);

        // Check if content is gzipped and decompress if needed
        const contentEncoding = response.headers['content-encoding'];
        if (contentEncoding === 'gzip' || buffer[0] === 0x1f && buffer[1] === 0x8b) {
          buffer = await gunzip(buffer);
        }

        let xmlContent = buffer.toString('utf-8');

        // Strip BOM and leading whitespace
        xmlContent = xmlContent.replace(/^\uFEFF/, ''); // UTF-8 BOM
        xmlContent = xmlContent.replace(/^\s+/, ''); // Leading whitespace

        // Parse the cleaned XML
        const elifeParser = new Parser({
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await elifeParser.parseString(xmlContent);
        return feed;
      }
      // For Oxford, try with referer header and longer timeout
      else if (isOxford) {
        const oxfordParser = new Parser({
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://academic.oup.com/'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });

        // Try original URL first
        try {
          const feed = await withTimeout(oxfordParser.parseURL(url), 30000);
          // Return feed even if it has no items (let the main logic handle empty feeds)
          // This ensures we return the feed object for proper error handling
          if (feed) {
            return feed;
          }
        } catch (e) {
          // If /rss/current fails, try alternative patterns
          if (url.includes('/rss/current')) {
            const alternatives = [
              url.replace('/rss/current', '/rss/ahead'), // Advance articles
              url.replace('/rss/current', '/rss/latest'), // Latest articles
              url.replace('/rss/current', '/rss') // Just /rss
            ];

            // Try alternatives
            for (const altUrl of alternatives) {
              try {
                const feed = await withTimeout(oxfordParser.parseURL(altUrl), 30000);
                if (feed) {
                  return feed;
                }
              } catch (altError) {
                // Continue to next alternative
              }
            }
          }
          // Re-throw to trigger retry logic
          throw e;
        }
        // If we got here, feed fetch failed
        return null;
      }
      // For Nature feeds, use custom parser with specific headers
      else if (isNature) {
        const natureParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(natureParser.parseURL(url), 30000);
        return feed;
      }
      // For BioMedCentral feeds, use custom parser with specific headers
      else if (isBioMedCentral) {
        const bmcParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(bmcParser.parseURL(url), 30000);
        return feed;
      }
      // For IOP Science feeds (RDF/RSS 1.0 format), use minimal parser config
      // Minimal config (just timeout) works best for RDF/RSS 1.0 feeds
      else if (isIOP) {
        const iopParser = new Parser({
          timeout: 20000
          // No headers, no customFields - minimal config works best for RDF format
        });
        const feed = await withTimeout(iopParser.parseURL(url), 30000);
        return feed;
      }
      // For MDPI feeds, use custom parser with specific headers
      else if (isMDPI) {
        const mdpiParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Referer': 'https://www.mdpi.com/'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(mdpiParser.parseURL(url), 30000);
        return feed;
      }
      // For MIT Press feeds, use custom parser with specific headers
      else if (isMITPress) {
        const mitParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Referer': 'https://www.mitpressjournals.org/'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(mitParser.parseURL(url), 30000);
        return feed;
      }
      // For ACS (American Chemical Society) feeds, use custom parser with specific headers
      else if (isACS) {
        const acsParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Referer': 'https://pubs.acs.org/'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(acsParser.parseURL(url), 30000);
        return feed;
      }
      // For Wiley feeds, use custom parser with specific headers
      else if (isWiley) {
        const wileyParser = new Parser({
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Referer': 'https://onlinelibrary.wiley.com/'
          },
          customFields: {
            item: [
              ['prism:description', 'prism:description'],
              ['dc:description', 'dc:description'],
              ['content:encoded', 'content:encoded']
            ]
          }
        });
        const feed = await withTimeout(wileyParser.parseURL(url), 30000);
        return feed;
      }
      // For Springer feeds (BMC journals), follow redirects
      else if (isSpringer) {
        const springerParser = new Parser({
          timeout: 25000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          requestOptions: {
            followRedirect: true,
            maxRedirects: 5
          }
        });
        const feed = await withTimeout(springerParser.parseURL(url), 35000);
        return feed;
      } else {
        const feed = await withTimeout(parser.parseURL(url), 30000);
        return feed;
      }
    } catch (error) {
      if (i < actualRetries - 1) {
        // Use exponential backoff for rate-limited publishers
        let delayMs;
        if (isAnnualReviews) {
          delayMs = 2000 * (i + 1); // 2s, 4s, 6s
        } else if (isACS || isWiley || isSpringer) {
          delayMs = 1000 * (i + 1); // 1s, 2s, 3s for rate-limited publishers
        } else {
          delayMs = 500 * (i + 1); // 500ms, 1s default
        }
        await delay(delayMs);
      }
    }
  }
  return null;
}

// Process array in parallel batches with concurrency limit
async function processBatches(items, batchSize, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

function extractDOI(item) {
  // Try to extract DOI from various fields
  const doiRegex = /10\.\d{4,}\/[^\s?&#]+/;

  // First check if item.doi already has a valid DOI
  if (item.doi && item.doi.match(doiRegex)) {
    return item.doi.match(doiRegex)[0];
  }

  // For bioRxiv/medRxiv: if item.doi is just the numeric part, check link for full DOI
  if (item.doi && item.link && (item.link.includes('biorxiv.org') || item.link.includes('medrxiv.org'))) {
    const linkDOI = item.link.match(doiRegex);
    if (linkDOI) return linkDOI[0];
  }

  // Publisher-specific URL patterns
  if (item.link) {
    // Nature journals: nature.com/articles/s41598-026-38062-0 → 10.1038/s41598-026-38062-0
    const natureMatch = item.link.match(/nature\.com\/articles\/(s\d+-\d+-\d+-\d+)/);
    if (natureMatch) {
      const articleId = natureMatch[1];
      return `10.1038/${articleId}`;
    }

    // BMJ journals: Multiple patterns
    // Pattern 1: jitc.bmj.com/cgi/content/short/14/1/e012864
    const bmjMatch1 = item.link.match(/([a-z]+)\.bmj\.com\/cgi\/content\/short\/(.+?)(?:\?|$)/);
    if (bmjMatch1) {
      const [, journal, path] = bmjMatch1;
      return `10.1136/${journal}-${path.replace(/\//g, '-')}`;
    }
    // Pattern 2: www.bmj.com/content/392/bmj.s154.short
    const bmjMatch2 = item.link.match(/www\.bmj\.com\/content\/\d+\/bmj\.([a-z0-9]+)\.short/i);
    if (bmjMatch2) {
      return `10.1136/bmj.${bmjMatch2[1]}`;
    }

    // medRxiv: medrxiv.org/cgi/content/short/2025.11.25.25340992v1 → 10.1101/2025.11.25.25340992
    const medrxivMatch = item.link.match(/medrxiv\.org\/cgi\/content\/short\/(\d+\.\d+\.\d+\.\d+)/);
    if (medrxivMatch) {
      return `10.1101/${medrxivMatch[1]}`;
    }

    // bioRxiv: similar pattern
    const biorxivMatch = item.link.match(/biorxiv\.org\/content\/(?:early\/\d+\/\d+\/\d+\/)?(\d+\.\d+\.\d+\.\d+)/);
    if (biorxivMatch) {
      return `10.1101/${biorxivMatch[1]}`;
    }

    // Oxford Academic: DOI is in item.id field
    // Format: "journal-name-http://doi.org/10.1093/nar/gkag376/8667318"
    // The Silverchair article-id (the trailing /<digits>) gets concatenated
    // onto the doi.org URL by OUP's RSS — strip it. OpenAlex 404s the
    // suffixed form; the clean DOI (10.1093/nar/gkag376) resolves cleanly.
    if (item.link && item.link.includes('academic.oup.com') && item.id) {
      const oxfordDOIMatch = item.id.match(/http:\/\/doi\.org\/(10\.\d+\/[^\s]+)/);
      if (oxfordDOIMatch) {
        return oxfordDOIMatch[1].replace(/\/\d+$/, '');
      }
    }

    // Cell Press journals: cell.com/iscience/fulltext/S2589-0042(26)00246-4
    // DOI embedded in PII: S2589-0042(26)00246-4 contains year (26=2026)
    const cellMatch = item.link.match(/cell\.com\/[^\/]+\/fulltext\/(S[\d-]+\(\d+\)[\d-]+)/);
    if (cellMatch) {
      // The PII format contains the DOI - just need to add prefix
      // Cell Press uses 10.1016 prefix for most journals
      const pii = cellMatch[1];
      return `10.1016/j.${pii.toLowerCase().replace(/[()]/g, '.')}`;
    }

    // eLIFE: elifesciences.org/articles/107796 → 10.7554/eLife.107796
    const elifeMatch = item.link.match(/elifesciences\.org\/articles\/(\d+)/);
    if (elifeMatch) {
      return `10.7554/eLife.${elifeMatch[1]}`;
    }

    // IEEE: ieeexplore.ieee.org/document/11303180 → 10.1109/DOCUMENT_NUMBER
    const ieeeMatch = item.link.match(/ieeexplore\.ieee\.org\/document\/(\d+)/);
    if (ieeeMatch) {
      return `10.1109/${ieeeMatch[1]}`;
    }

    // JCI: jci.org/articles/view/203674 → 10.1172/JCI203674
    const jciMatch = item.link.match(/jci\.org\/articles\/view\/(\d+)/);
    if (jciMatch) {
      return `10.1172/JCI${jciMatch[1]}`;
    }

    // Science Magazine: science.org/doi/... or extract from content
    const scienceMatch = item.link.match(/science\.org\/doi\/([^?]+)/);
    if (scienceMatch) {
      return scienceMatch[1];
    }

    // Generic DOI in link
    const linkDOI = item.link.match(doiRegex);
    if (linkDOI) return linkDOI[0];
  }

  if (item.content && item.content.match(doiRegex)) {
    return item.content.match(doiRegex)[0];
  }
  // Check contentSnippet and summary (Nature journals put DOI here)
  if (item.contentSnippet && item.contentSnippet.match(doiRegex)) {
    return item.contentSnippet.match(doiRegex)[0];
  }
  if (item.summary && item.summary.match(doiRegex)) {
    return item.summary.match(doiRegex)[0];
  }
  return null;
}

function extractArXivId(item) {
  // Matches common arxiv reference formats and always captures the canonical ID
  // (without trailing version suffix like v2, v3, v4).
  const patterns = [
    /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i,
    /oai:arxiv\.org:(\d{4}\.\d{4,5})/i,
    /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i,
    /arxiv:?\s*(\d{4}\.\d{4,5})/i,
  ];
  const sources = [item.link, item.id, item.guid, item.doi]
    .filter(Boolean)
    .map(s => String(s));
  for (const s of sources) {
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return m[1];
    }
  }
  return null;
}

function findPDFLink(item) {
  // Look for PDF links in common patterns
  if (item.link && item.link.includes('.pdf')) {
    return item.link;
  }

  // Check for arXiv PDF
  const arxivId = extractArXivId(item);
  if (arxivId) {
    return `https://arxiv.org/pdf/${arxivId}.pdf`;
  }

  // Check enclosures
  if (item.enclosure && item.enclosure.type === 'application/pdf') {
    return item.enclosure.url;
  }

  return null;
}

function findThumbnail(item) {
  // Check media:content (used by IUCr journals)
  if (item['media:content']) {
    const media = item['media:content'];
    if (media.$ && media.$.url) {
      return media.$.url;
    }
    if (typeof media === 'object' && media.url) {
      return media.url;
    }
  }

  // Check for media:thumbnail
  if (item['media:thumbnail']) {
    const thumb = item['media:thumbnail'];
    if (thumb.$ && thumb.$.url) {
      return thumb.$.url;
    }
    if (typeof thumb === 'object' && thumb.url) {
      return thumb.url;
    }
  }

  // Check enclosure for image types
  if (item.enclosure && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
    return item.enclosure.url;
  }

  // Extract from content:encoded (IUCr includes img tags)
  const content = item['content:encoded'] || item.content || '';
  if (typeof content === 'string') {
    const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch && imgMatch[1]) {
      return imgMatch[1];
    }
  }

  return null;
}

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Strip HTML tags and decode entities
function stripHTML(html) {
  if (!html || typeof html !== 'string') return '';
  // Remove HTML tags
  let text = html.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

// Format authors as "First Author et al."
function parseAuthorName(token) {
  // Handle forms like "Last, First M." or "First M. Last"
  if (token.includes(',')) {
    const [last, rest] = token.split(',', 2).map(s => s.trim());
    // For bioRxiv format like "Last, P." or "Last, G. W.", keep the periods
    // They're part of the initials (e.g., "P." = initial P, "G. W." = initials G and W)
    // But remove trailing period if it's just punctuation (will be handled by restParts splitting)
    let restCleaned = rest.trim();
    const restParts = restCleaned.split(/\s+/).filter(Boolean);
    // Remove trailing period from the last part if it's there and seems like punctuation
    // (e.g., "G. W." -> ["G.", "W."] which is fine, keep the periods)
    const firstNames = restParts.join(' ');
    const lastName = last.split(/\s+/).slice(-1)[0];
    const full = `${firstNames} ${lastName}`.trim();
    return { firstNames, lastName, full };
  }
  const parts = token.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    const lastName = parts[0];
    return { firstNames: '', lastName, full: lastName };
  }
  const lastName = parts[parts.length - 1];
  const firstNames = parts.slice(0, -1).join(' ');
  const full = `${firstNames} ${lastName}`.trim();
  return { firstNames, lastName, full };
}

function formatAuthors(authorsString) {
  if (!authorsString || typeof authorsString !== 'string') return undefined;

  const trimmed = authorsString.trim();
  if (!trimmed) return undefined;

  // Remove any existing "et al." from the input to avoid duplication
  let cleanedAuthors = trimmed.replace(/\s+et\s+al\.?\s*$/i, '').trim();

  if (!cleanedAuthors) return undefined;

  // Detect bioRxiv format: "Last, First., Last, First., ..." pattern
  // Pattern: comma, space, then text ending with period followed by comma or end
  // Examples: "Le, P., Lal, N." or "Yeo, G. W." or "Her, H.-L."
  // Look for pattern: ", X." or ", X. Y." where X and Y are initials/names ending with period
  const biorxivPattern = /,\s+[A-Z][A-Za-z0-9.\- ]*\.(?:\s*,|\s*$)/;
  const matches = cleanedAuthors.match(biorxivPattern);
  const isBiorxivFormat = matches && matches.length > 1;

  let authors = [];

  if (isBiorxivFormat) {
    // bioRxiv format: "Last, First., Last, First., ..."
    // Split on ", " and pair up: each author is "Last, First."
    // Example: "Le, P., Lal, N., Xu, S." -> ["Le, P.", "Lal, N.", "Xu, S."]
    const parts = cleanedAuthors.split(/,\s+/);
    for (let i = 0; i < parts.length; i += 2) {
      if (i + 1 < parts.length) {
        // Merge two parts: "Last" and "First." (remove trailing comma/period from second part if needed)
        let secondPart = parts[i + 1].trim();
        // Remove trailing comma if present (from "First.," -> "First.")
        secondPart = secondPart.replace(/,\s*$/, '');
        const author = `${parts[i]}, ${secondPart}`.trim();
        if (author && author.length > 0 && author.length < 100) {
          authors.push(author);
        }
      } else if (parts[i].trim()) {
        // Handle odd case where there's a trailing author without first name
        authors.push(parts[i].trim().replace(/[,\.]\s*$/, ''));
      }
    }
  } else {
    // Standard format: Split by common separators (comma, semicolon, &, or "and")
    // Handle both "A, B, and C" and "A, B, C" formats
    authors = cleanedAuthors.split(/[,;&]/)
      .map(a => a.trim())
      .filter(a => a && a.length > 0 && a.length < 100);

    // Handle "and" that might be in the last element like "A, B, and C"
    const lastAuthor = authors[authors.length - 1];
    if (lastAuthor && /^and\s+/i.test(lastAuthor)) {
      authors[authors.length - 1] = lastAuthor.replace(/^and\s+/i, '').trim();
    }

    // Also check if any author has " and " in it (e.g., "A, B and C")
    const expanded = [];
    for (const author of authors) {
      if (/ and /i.test(author)) {
        expanded.push(...author.split(/\s+and\s+/i).map(a => a.trim()).filter(a => a));
      } else {
        expanded.push(author);
      }
    }
    authors = expanded.filter(a => a && a.length > 0 && a.length < 100);
  }

  if (authors.length === 0) return undefined;

  // Parse the first author name to get "First Last" format
  const first = parseAuthorName(authors[0]);

  // Only append "et al." when the source string actually had evidence of
  // multiple authors. Single-byline pieces like Quanta "Max G. Levy" or
  // MIT Tech Review "MIT Technology Review Insights" otherwise rendered
  // as "Levy et al." / "Insights et al." on cards.
  const isMulti =
    authors.length > 1 ||
    /\b(and|&|et\s+al\.?)\b/i.test(trimmed) ||
    /[,;]/.test(trimmed);
  return isMulti ? `${first.full} et al.` : first.full;
}

// OUP/NAR ships graphical-abstract clauses in <dc:creator>, producing
// strings like "exploiting Cas12a's allosteric sensitivity" or
// "comparing wild-type plants with the AS mutant acinus pinin". Detect
// these so we don't store them as authors.
function looksLikeProseNotAuthors(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.replace(/\s+et\s+al\.?\s*$/i, '').trim();
  if (!trimmed) return false;
  // Only flag obvious lowercase-leading prose. Stopword-based heuristics
  // false-positive on legit arXiv strings ("on behalf of the ATLAS Collab",
  // "(with an appendix by Jones)") and surnames like "From".
  return /^[a-z]/.test(trimmed);
}

function extractAuthors(item) {
  let authorsRaw = null;

  // Try various author fields and formats
  // Handle string author
  if (typeof item.author === 'string' && item.author.trim()) {
    authorsRaw = item.author.trim();
  }
  // Handle author object with name property
  else if (item.author && typeof item.author === 'object') {
    if (item.author.name && typeof item.author.name === 'string') {
      authorsRaw = item.author.name.trim();
    }
  }
  // Handle creator (Dublin Core)
  else if (typeof item.creator === 'string' && item.creator.trim()) {
    authorsRaw = item.creator.trim();
  }
  // Handle dc:creator (Dublin Core namespace)
  else if (item['dc:creator']) {
    const creators = item['dc:creator'];
    if (creators && (typeof creators === 'string' || Array.isArray(creators))) {
      // Handle array of creators (e.g. Chem Comm)
      let creatorText = Array.isArray(creators) ? creators.join(', ') : creators;
      creatorText = creatorText.trim();

      // PNAS format: Authors concatenated with affiliations
      // Example: "Graham F. HatfullaDepartment of Biological Sciences..." 
      //          "Seth GuikemaZaira Pagan-CajigasCharles FantBrent Boehlert..."
      // Pattern: Name(s) followed by affiliation starting with capital words
      // Strategy: Find where affiliation starts, then split concatenated author names
      const affiliationMarkers = /\b(Department|University|College|Institute|Center|Laboratory|School|Hospital|Medical|National|American|International|Federal|Ministry|Division|Section|Unit|Group|Program|Department of|University of|College of|Institute of|Center for|School of|Hospital of|Civil and|Industrial and|U\.S\.|Environmental|WindRiskTech)\b/i;
      const affiliationMatch = creatorText.match(affiliationMarkers);

      let authorsText = creatorText;
      if (affiliationMatch && affiliationMatch.index > 0) {
        // Extract text before affiliation
        authorsText = creatorText.substring(0, affiliationMatch.index).trim();
      }

      // Only apply PNAS-specific cleaning if we found an affiliation marker
      // This ensures we don't accidentally modify properly formatted author strings
      if (affiliationMatch && affiliationMatch.index > 0) {
        // Now split concatenated author names (PNAS-specific format)
        // Pattern: last name (capital + lowercase) followed by first name (capital) of next author
        // Example: "GuikemaZaira" -> "Guikema, Zaira"
        //          "HatfullaDepartment" -> "Hatfulla" (Department is affiliation, already removed)
        // Split on: lowercase letter(s) followed by capital letter that starts a first name
        // More precisely: last name ends with lowercase, next author's first name starts with capital
        authorsText = authorsText
          // Pattern 1: lowercase letter(s) followed by capital letter (start of new first name)
          // e.g., "GuikemaZaira" -> "Guikema, Zaira"
          .replace(/([a-z]+)([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?[A-Z][a-z]+)/g, '$1, $2')
          // Pattern 2: name ending (could be first+last) followed by capital that looks like start of first name
          // e.g., "Graham FHatfulla" -> "Graham F, Hatfulla" (less common)
          .replace(/([A-Z][a-z]+(?:\s+[A-Z]\.?)?)([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?[A-Z][a-z]+)/g, (match, p1, p2) => {
            // Only insert comma if p1 looks like a complete name (ends with last name pattern)
            // Last name pattern: capital letter + lowercase letters (at least 2 chars)
            if (/[A-Z][a-z]{2,}$/.test(p1) || p1.includes('.')) {
              return p1 + ', ' + p2;
            }
            return match;
          });
      }
      // If no affiliation marker, treat as normal author string (e.g., Annual Reviews format)

      authorsRaw = authorsText.trim();
    } else if (Array.isArray(item['dc:creator']) && item['dc:creator'].length > 0) {
      authorsRaw = item['dc:creator'].map(c => typeof c === 'string' ? c.trim() : (c && c.name ? c.name : '')).filter(Boolean).join(', ');
    }
  }
  // Handle dc:contributor
  else if (item['dc:contributor']) {
    if (typeof item['dc:contributor'] === 'string') {
      authorsRaw = item['dc:contributor'].trim();
    } else if (Array.isArray(item['dc:contributor']) && item['dc:contributor'].length > 0) {
      authorsRaw = item['dc:contributor'].map(c => typeof c === 'string' ? c.trim() : (c && c.name ? c.name : '')).filter(Boolean).join(', ');
    }
  }
  // Handle arrays of authors
  else if (Array.isArray(item.author) && item.author.length > 0) {
    authorsRaw = item.author.map(a => typeof a === 'string' ? a.trim() : (a && a.name ? a.name : '')).filter(Boolean).join(', ');
  }

  // If we found authors in metadata fields, format and return.
  // First sanity-check: OUP/NAR ships graphical-abstract clauses in
  // <dc:creator> (e.g. "integrating cell size awareness with cross-platform
  // robustness"). These are sentences, not names — drop them so downstream
  // enrichment (OpenAlex/Crossref) can supply real authors.
  if (authorsRaw && !looksLikeProseNotAuthors(authorsRaw)) {
    return formatAuthors(authorsRaw);
  }

  // Try to extract from content/description (HTML content)
  const content = item.content || item.contentSnippet || item.summary || item.description || '';
  if (typeof content === 'string' && content.trim()) {
    const textContent = stripHTML(content);

    // Priority 0: Check for bioRxiv/arXiv format - authors often in summary/description as plain text
    // bioRxiv often has format like "John Smith, Jane Doe" at the start
    // Check first 300 chars for author-like patterns
    const bioRxivPattern = textContent.substring(0, 300);
    // Pattern: "First Last, First Last, ..." or "First M. Last, First M. Last, ..."
    let match = bioRxivPattern.match(/^([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){1,20})(?:\s*\n|$|\.|,|;|Abstract|abstract)/);
    if (match && match[1]) {
      const authorText = match[1].trim();
      // Make sure it looks like authors (not just one name, has commas or multiple names)
      if (authorText.includes(',') || authorText.split(/\s+/).length >= 4) {
        if (authorText.length > 10 && authorText.length < 500) {
          return formatAuthors(authorText);
        }
      }
    }

    // Priority 1: Check for "Author(s):" pattern (common in Elsevier, ScienceDirect, etc.)
    // This pattern often appears at the start of the abstract
    // Match everything after "Author(s):" until newline or metadata marker
    match = textContent.match(/Author\(s\):\s*([^\n]+?)(?:\n\s*(?:Publication|Source|Abstract|DOI|http)|\n|$)/i);
    if (!match) {
      // Try simpler pattern - just until newline
      match = textContent.match(/Author\(s\):\s*([^\n]+)/i);
    }
    if (match && match[1]) {
      let authorText = match[1].trim();
      // Strip HTML tags from author text (in case it's like "Name, Name</p>")
      authorText = stripHTML(authorText);
      // Remove any trailing metadata markers that might have been captured
      authorText = authorText.replace(/\s*(?:Publication|Source|Abstract|DOI|http).*$/i, '').trim();
      if (authorText && authorText.length > 0 && authorText.length < 1000) {
        return formatAuthors(authorText);
      }
    }

    // Priority 1b: Check for Science journal format
    // Science often has "Authors Info & Affiliations" or "By Author Name" patterns
    // Check first 1500 chars for better coverage
    const firstPart = textContent.substring(0, 1500);

    // Try "Authors Info & Affiliations" pattern (common in Science HTML)
    match = firstPart.match(/Authors(?:\s+Info\s*)?(?:\s+&\s+Affiliations)?[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][a-z]+)*(?:\s*,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][a-z]+)*){0,20})(?:\s*\n|$|\.|,|;|Affiliations|Affiliations:|Info)/i);
    if (match && match[1]) {
      const authorText = match[1].trim();
      // Remove any trailing affiliation markers
      const cleaned = authorText.replace(/\s*(?:Affiliations?|Info|Info & Affiliations).*$/i, '').trim();
      if (cleaned.length > 5 && cleaned.length < 500 && !cleaned.toLowerCase().includes('abstract')) {
        return formatAuthors(cleaned);
      }
    }

    // Try "By Author Name" pattern (common in Science news/editorial pieces)
    match = firstPart.match(/(?:^|\n)\s*By\s+([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){0,15})(?:\s*\n|$|\.|,|;)/);
    if (match && match[1]) {
      const authorText = match[1].trim();
      if (authorText.length > 5 && authorText.length < 500 && !authorText.toLowerCase().includes('abstract')) {
        return formatAuthors(authorText);
      }
    }

    // Try "By" pattern with more flexibility (Science sometimes has just last names or different formats)
    match = firstPart.match(/(?:^|\n)\s*By\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?){1,20})(?:\s*\n|$|\.|,|;)/);
    if (match && match[1]) {
      const authorText = match[1].trim();
      if (authorText.length > 5 && authorText.length < 500 && !authorText.toLowerCase().includes('abstract') && !authorText.match(/^[A-Z]\s+[A-Z]/)) {
        return formatAuthors(authorText);
      }
    }

    // Try "Authors:" pattern
    match = firstPart.match(/(?:^|\n)\s*Authors?:\s*([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){0,15})(?:\s*\n|$|\.|,|;)/i);
    if (match && match[1]) {
      const authorText = match[1].trim();
      if (authorText.length > 5 && authorText.length < 500 && !authorText.toLowerCase().includes('abstract')) {
        return formatAuthors(authorText);
      }
    }

    // Try "Written by" pattern (less common but sometimes used)
    match = firstPart.match(/(?:^|\n)\s*Written\s+by\s+([A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][A-Za-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){0,15})(?:\s*\n|$|\.)/i);
    if (match && match[1]) {
      const authorText = match[1].trim();
      if (authorText.length > 5 && authorText.length < 500 && !authorText.toLowerCase().includes('abstract')) {
        return formatAuthors(authorText);
      }
    }

    // Try pattern for Science - sometimes authors are just listed without "By" or "Authors:"
    // Pattern: "Author Name, Author Name" at the very beginning (but be careful not to match other content)
    match = textContent.match(/^([A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+){1,20})(?:\s*\n|$|\.|,|;|Abstract)/);
    if (match && match[1]) {
      const authorText = match[1].trim();
      if (authorText.length > 10 && authorText.length < 500 && !authorText.toLowerCase().includes('abstract')) {
        return formatAuthors(authorText);
      }
    }

    // Multiple patterns to try:
    // 2. "By: Author Name", "Authors: ..."
    // NOTE: case-sensitive on purpose. With /i, lowercase "by" mid-sentence
    // matched, and [A-Z] became [A-Za-z], so abstracts ending with phrases
    // like "By integrating X with Y, ..." captured "integrating X with Y"
    // as an author name (real bug seen on OUP/NAR papers).
    match = textContent.match(/(?:^|\n|[\.:])\s*(?:By|Authors?|Written\s+by|Corresponding\s+author|Lead\s+author):?\s+([A-Z][^,\n\.]{1,80}(?:\s+[A-Z][^,\n\.]{1,80})*)/);
    if (match && match[1]) {
      return formatAuthors(match[1]);
    }

    // 2. Pattern like "Smith, J., Doe, M., ..."
    match = textContent.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]\.(?:\s*[A-Z]\.)?(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]\.(?:\s*[A-Z]\.)?)*)/);
    if (match && match[1]) {
      return formatAuthors(match[1]);
    }

    // 3. Pattern at the beginning: "Author Name et al."
    match = textContent.match(/^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+\s+(?:et al\.?|and\s+others?))/i);
    if (match && match[1]) {
      return formatAuthors(match[1]);
    }

    // 4. Look for author names pattern (First Last, First Last, ...) in first 500 chars
    // Reuse firstPart (already declared above, uses first 1000 chars which includes 500)
    match = firstPart.substring(0, 500).match(/([A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+(?:\s+[A-Z]\.?\s+[A-Z][a-z]+)*(?:\s*,\s*[A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+)*)/);
    if (match && match[1]) {
      return formatAuthors(match[1]);
    }
  }

  return undefined;
}

// Clean abstract by removing metadata (publication date, source, authors) that was extracted
function cleanAbstract(abstract, extractedAuthors) {
  if (!abstract || typeof abstract !== 'string') return abstract;

  // First strip HTML tags and decode entities to get plain text
  let cleaned = stripHTML(abstract);
  const originalLength = cleaned.length;

  // Remove author information if it was extracted (but keep it if not extracted)
  if (extractedAuthors) {
    // Handle "by Author1, Author2..." pattern FIRST (common in PLOS, etc.)
    // This pattern appears at the start and needs special handling
    // Match "by" followed by author names (capitalized names with commas)
    const byAuthorPattern = /^by\s+[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)*(?:\s+|$)/i;
    let match = cleaned.match(byAuthorPattern);
    if (match && match[0]) {
      // Remove the "by Author1, Author2..." prefix - the abstract follows
      const afterAuthors = cleaned.substring(match[0].length).trim();
      // Only remove if there's substantial abstract content after (not just metadata)
      if (afterAuthors.length > 50) {
        cleaned = afterAuthors;
      }
    }

    // Remove "Author(s): ..." patterns (works on plain text now)
    cleaned = cleaned.replace(/Author\(s\):\s*[^\n]*(?:\n|$)/gi, '');
    // Remove other author patterns with labels (but NOT "by" at start, already handled)
    cleaned = cleaned.replace(/(?:^|\n)\s*(?:Authors?|Written by):?\s*[^\n]*(?:\n|$)/gi, '');

    // Remove author names at the beginning of the abstract (common in bioRxiv/arXiv)
    // Pattern: Author names without labels like "John Smith, Jane Doe" at the start
    // Note: stripHTML normalizes all whitespace to single spaces, so we work with space-separated text
    // Check first 500 chars for author-like patterns
    const firstPart = cleaned.substring(0, 500);

    // Pattern 1: "First Last, First Last, ..." at the very beginning (NOT prefixed with "by")
    // This matches patterns like "John Smith, Jane Doe" or "J. Smith, J. Doe"
    // Stop at common abstract-starting words or punctuation followed by space
    let authorPattern = /^([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+){1,20})(?:\s+|$|\.\s|,\s|;\s|Abstract|abstract|Background|Introduction|We\s|The\s|This\s|Here\s)/;
    match = firstPart.match(authorPattern);
    if (match && match[1]) {
      const authorText = match[1].trim();
      // Make sure it looks like authors (has commas or multiple names, reasonable length)
      if ((authorText.includes(',') || authorText.split(/\s+/).length >= 4) &&
        authorText.length > 10 && authorText.length < 500) {
        // Check if there's substantial content after
        const afterMatch = cleaned.substring(match[0].length).trim();
        // Only remove if the remaining text is short (likely metadata)
        if (afterMatch.length < 100) {
          cleaned = afterMatch;
        } else {
          // Keep the abstract, just remove the author line
          cleaned = afterMatch;
        }
      }
    } else {
      // Pattern 2: "Last, First M., Last, First M., ..." format (less common but possible)
      authorPattern = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]\.(?:\s*[A-Z]\.)?(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]\.(?:\s*[A-Z]\.)?){1,20})(?:\s+|$|\.\s|,\s|;\s|Abstract|abstract|Background|Introduction|We\s|The\s|This\s|Here\s)/;
      match = firstPart.match(authorPattern);
      if (match && match[1]) {
        const authorText = match[1].trim();
        if (authorText.length > 10 && authorText.length < 500) {
          const afterMatch = cleaned.substring(match[0].length).trim();
          if (afterMatch.length < 100) {
            cleaned = afterMatch;
          } else {
            cleaned = afterMatch;
          }
        }
      }
    }

    // Pattern 3: Remove any remaining author-like text at the very beginning
    // Look for "First Last et al." or similar at start (but be conservative)
    const etAlPattern = /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)+\s+(?:et\s+al\.?|and\s+others?))(?:\s+\n|\n\n|$)/i;
    match = cleaned.match(etAlPattern);
    if (match) {
      const afterMatch = cleaned.substring(match[0].length).trim();
      if (afterMatch.length >= 50) { // Only remove if there's substantial content after
        cleaned = afterMatch;
      }
    }
  }

  // Remove publication metadata that shouldn't be in abstract
  cleaned = cleaned.replace(/Publication\s+date:\s*[^\n]*(?:\n|$)/gi, '');
  cleaned = cleaned.replace(/Source:\s*[^\n]*(?:\n|$)/gi, '');
  cleaned = cleaned.replace(/Volume\s+\d+[^\n]*(?:\n|$)/gi, '');
  cleaned = cleaned.replace(/Issue\s+\d+[^\n]*(?:\n|$)/gi, '');

  // Remove Nature-specific metadata patterns
  // Remove "Nature, Published online: ..." patterns (with or without DOI)
  cleaned = cleaned.replace(/^Nature,\s*Published\s+online:\s*\d+\s+\w+\s+\d{4};\s*doi:[^\n]+\s*/i, '');
  cleaned = cleaned.replace(/^Nature,\s*Published\s+online:[^\n]+\s*/i, '');
  cleaned = cleaned.replace(/(?:^|\n)\s*Nature,\s*Published\s+online:\s*\d+\s+\w+\s+\d{4};\s*doi:[^\n]+(?:\n|$)/gi, '');
  cleaned = cleaned.replace(/(?:^|\n)\s*Nature,\s*Published\s+online:[^\n]+(?:\n|$)/gi, '');

  // Clean up multiple consecutive newlines and whitespace
  cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

  // If after cleaning the abstract is empty, too short, or we removed too much (>90%), return undefined
  if (!cleaned || cleaned.trim().length === 0) {
    return undefined;
  }

  // If we removed more than 90% of the content, it was probably all metadata
  if (originalLength > 0 && cleaned.length < originalLength * 0.1) {
    return undefined;
  }

  return cleaned;
}


/**
 * Load all existing entries from journal files
 * This is the primary source of truth for deduplication
 * Journal files contain all articles that have been fetched previously
 */
// Window for "existing" entries. Must exceed our practical retention so
// that in-flight RSS re-posts are recognized as duplicates, not reingested.
const EXISTING_ENTRIES_WINDOW_DAYS = 120;

// Phase 4 (post-Phase-2) dedup model: don't pre-load 543k existing
// papers. Return [] here and let dedupeNewEntriesAgainstSupabase
// (called after RSS fetch) check only the ~150k incoming items
// against id_map + papers via PK-indexed batches.
//
// This function is kept as a stub so old call sites and the
// merge-only path keep working; if the user genuinely needs the
// historical bulk fetch they can flip ENABLE_BULK_LOADER=true.
async function loadExistingEntriesFromSupabase() {
  if (process.env.ENABLE_BULK_LOADER !== 'true') {
    console.log('📚 Skipping bulk historical load (per-batch dedup runs after RSS fetch).');
    return [];
  }
  return loadExistingEntriesBulk();
}

async function loadExistingEntriesBulk() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('⚠️  Supabase creds missing — cannot load existing entries from DB');
    return null;
  }

  // Lazy import — module may be optional in some environments.
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  const since = new Date(Date.now() - EXISTING_ENTRIES_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  console.log(`📚 Loading existing entries from Supabase (last ${EXISTING_ENTRIES_WINDOW_DAYS} days)...`);

  // Two-query keyset pagination per page:
  //   1. papers ordered by (published_at desc, canonical_id asc) using
  //      idx_papers_published_canonical (mig 39) for index-only access.
  //   2. sightings .in('paper_id', batch) for a representative source
  //      feed + legacy_entry_id per paper.
  // The previous recent_entries_v2 RPC bundled both via LATERAL LIMIT 1
  // — Postgres mis-planned that as a quasi-cross-join and tripped the
  // 60s statement_timeout around row 200k. App-side join is consistently
  // ~1s per page on Pro tier.
  const entries = [];
  const PAGE = 2000;
  let cursorPub = null;
  let cursorId = null;
  for (;;) {
    let papersQ = sb
      .from('papers')
      .select('canonical_id, title, abstract, authors, authors_text, published_at, primary_source, primary_link, external_ids, categories, type')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .order('canonical_id', { ascending: true })
      .limit(PAGE);
    if (cursorPub) {
      // Composite-cursor predicate: (published_at, canonical_id) <
      // (cursorPub, cursorId). PostgREST can't express this directly,
      // so emulate via .or().
      papersQ = papersQ.or(`published_at.lt.${cursorPub},and(published_at.eq.${cursorPub},canonical_id.gt.${cursorId})`);
    }
    const { data: papersRows, error: papersErr } = await papersQ;
    if (papersErr) {
      console.error('   ❌ Supabase papers page error:', papersErr.message);
      return null;
    }
    if (!papersRows || papersRows.length === 0) break;

    // Bulk-fetch one sighting per paper. Multiple sightings can exist
    // per paper; we deduplicate to first occurrence by paper_id.
    const ids = papersRows.map(p => p.canonical_id);
    const sightingByPaper = new Map();
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const { data: sightings, error: sErr } = await sb
        .from('sightings')
        .select('paper_id, source_feed, legacy_entry_id, feed_link')
        .in('paper_id', batch);
      if (sErr) {
        console.error('   ❌ Supabase sightings chunk error:', sErr.message);
        return null;
      }
      for (const s of sightings || []) {
        if (!sightingByPaper.has(s.paper_id)) sightingByPaper.set(s.paper_id, s);
      }
    }

    for (const row of papersRows) {
      if (!row.title) continue;
      const sighting = sightingByPaper.get(row.canonical_id) || {};
      const ext = row.external_ids || {};
      entries.push({
        id: sighting.legacy_entry_id || row.canonical_id,
        canonicalId: row.canonical_id,
        title: row.title,
        abstract: row.abstract || '',
        authors: row.authors_text || (Array.isArray(row.authors)
          ? row.authors.map(a => typeof a === 'string' ? a : a?.name || '').filter(Boolean).join(', ')
          : ''),
        published: row.published_at,
        doi: typeof ext.doi === 'string' ? ext.doi : undefined,
        arxivId: typeof ext.arxiv_id === 'string' ? ext.arxiv_id : undefined,
        journalId: sighting.source_feed,
        journal: row.primary_source || sighting.source_feed,
        link: sighting.feed_link || row.primary_link || '',
        categories: row.categories || [],
        type: row.type || undefined,
      });
    }
    process.stdout.write(`\r   loaded ${entries.length.toLocaleString()}`);
    if (papersRows.length < PAGE) break;
    const last = papersRows[papersRows.length - 1];
    cursorPub = last.published_at;
    cursorId = last.canonical_id;
  }
  console.log(`\n   ${entries.length.toLocaleString()} existing entries loaded from Supabase`);

  // Sort newest first
  entries.sort((a, b) => {
    try { return new Date(b.published || 0).getTime() - new Date(a.published || 0).getTime(); }
    catch { return 0; }
  });
  return entries;
}

// Existing-entries loader. Supabase is the source of truth — Phase 4
// dropped the journal-files fallback. The default path is now
// per-batch dedup (loader returns [], dedupeNewEntriesAgainstSupabase
// runs after RSS fetch). Set ENABLE_BULK_LOADER=true to opt back into
// the historical preload (still slow on free-tier compute).
async function loadExistingEntries() {
  const entries = await loadExistingEntriesFromSupabase();
  if (entries === null) throw new Error('Supabase existing-entries load failed');
  return entries;
}

// Pre-load all existing id_map.legacy_entry_id keys so we can skip
// enrichment for items that are obviously already in our DB. Without this,
// fetch.js was hitting OpenAlex/S2/Crossref ~120k times per run even though
// only ~600 items were actually new.
//
// ~929k IDs × ~80 bytes = ~75 MB in memory. Loaded via paginated SELECT
// so we stay within Pro Micro's per-statement timeout (~1k pages × 200ms ≈
// 3 min upfront, saves ~5+ min of per-item external API calls downstream).
const existingLegacyIds = new Set();
async function preloadExistingLegacyIds() {
  if (!supabase) return;
  process.stdout.write('📋 Pre-loading existing id_map keys... ');
  const t0 = Date.now();
  const PAGE = 10000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('id_map')
      .select('legacy_entry_id')
      .not('legacy_entry_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(`\n   ⚠️  page ${from} error: ${error.message} — bailing, fetch will enrich everything`);
      existingLegacyIds.clear();
      return;
    }
    if (!data || data.length === 0) break;
    for (const r of data) existingLegacyIds.add(r.legacy_entry_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`✓ ${existingLegacyIds.size.toLocaleString()} keys in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Drop incoming RSS items that are already in Supabase. PK-indexed
// lookups against id_map (entry IDs) and papers (DOI/arxiv/title-hash).
// ~138k incoming items per run, processed in 1k-id chunks: 100s of
// short queries vs one mega-load. Comfortable under any timeout.
async function dedupeNewEntriesAgainstSupabase(newEntries) {
  if (!supabase || newEntries.length === 0) return newEntries;

  process.stdout.write(`🔎 Dedup against Supabase for ${newEntries.length.toLocaleString()} fresh items... `);
  const t0 = Date.now();

  const lower = (v) => (typeof v === 'string' && v ? v.toLowerCase() : null);

  const idCandidates = new Set();
  const doiCandidates = new Set();
  const arxivCandidates = new Set();
  const titleHashCandidates = new Set();

  // Build lookup keys from each incoming entry. We look up each kind in
  // bulk, then mark the entry "known" if any kind matched.
  const entryKeys = newEntries.map(e => {
    const doi = lower(e.doi);
    const arxivId = lower(e.arxivId || extractArXivId(e));
    const titleHash = (!doi && !arxivId) ? normalizeTitle(e.title || '') : null;
    if (e.id) idCandidates.add(e.id);
    if (doi) doiCandidates.add(doi);
    if (arxivId) arxivCandidates.add(arxivId);
    if (titleHash) titleHashCandidates.add(titleHash);
    return { entry: e, doi, arxivId, titleHash };
  });

  const knownIds = new Set();
  const knownDois = new Set();
  const knownArxiv = new Set();
  const knownTitles = new Set();

  // Server-side dedup via 4 single-column RPCs (mig 46). Each runs against
  // its own well-planned index. Client calls all 4 in parallel via Promise.all
  // — wall time is max(4) not sum(4). The previous combined function (mig 45)
  // made the planner pick a seq-scan on title_normalized inside the function
  // body, timing out at 30s for >200 keys.
  async function rpcSingleColumn(fnName, keys, target) {
    if (!keys || keys.length === 0) return;
    const CHUNK = 2000;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const batch = keys.slice(i, i + CHUNK);
      let lastErr = null;
      let ok = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { data, error } = await supabase.rpc(fnName, getRpcArg(fnName, batch));
          if (error) throw error;
          for (const v of data || []) target.add(v);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          if (e?.code === 'PGRST202' || (e?.message || '').includes('Could not find the function')) {
            throw e; // signal mig 46 not applied → caller falls back
          }
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
      }
      if (!ok) throw lastErr || new Error(`${fnName} chunk failed`);
    }
  }

  function getRpcArg(fnName, batch) {
    switch (fnName) {
      case 'dedupe_known_ids':    return { p_ids: batch };
      case 'dedupe_known_dois':   return { p_dois: batch };
      case 'dedupe_known_arxiv':  return { p_arxiv_ids: batch };
      case 'dedupe_known_titles': return { p_title_hashes: batch };
      default: throw new Error(`unknown rpc: ${fnName}`);
    }
  }

  async function rpcDedupAll() {
    const ids = [...idCandidates];
    const dois = [...doiCandidates];
    const arx = [...arxivCandidates];
    const tit = [...titleHashCandidates];
    await Promise.all([
      rpcSingleColumn('dedupe_known_ids',    ids, knownIds),
      rpcSingleColumn('dedupe_known_dois',   dois, knownDois),
      rpcSingleColumn('dedupe_known_arxiv',  arx, knownArxiv),
      rpcSingleColumn('dedupe_known_titles', tit, knownTitles),
    ]);
  }

  async function chunkedIn(table, column, values, size = 200) {
    const arr = [...values];
    const found = new Set();
    let processed = 0;
    let droppedChunks = 0;
    for (let i = 0; i < arr.length; i += size) {
      const batch = arr.slice(i, i + size);
      let lastErr = null;
      let success = false;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const { data, error } = await supabase
            .from(table)
            .select(column)
            .in(column, batch);
          if (error) {
            lastErr = error;
            // 4xx (URL too long, etc.) won't get better with retries — split.
            if (typeof error.code === 'string' && error.code.startsWith('PGRST')) break;
            // Retry transient errors with exponential backoff.
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
            continue;
          }
          for (const row of data || []) if (row[column]) found.add(row[column]);
          success = true;
          break;
        } catch (e) {
          // Node fetch transient errors land here (TypeError: fetch failed)
          lastErr = e;
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        }
      }

      // If it's a 400-class issue (probably URL too long), split the batch
      // in half and try each piece — recursion bounded by sample size.
      if (!success && batch.length > 25) {
        const mid = Math.ceil(batch.length / 2);
        const sub1 = await chunkedIn(table, column, batch.slice(0, mid), Math.ceil(mid / 2));
        const sub2 = await chunkedIn(table, column, batch.slice(mid), Math.ceil((batch.length - mid) / 2));
        for (const v of sub1) found.add(v);
        for (const v of sub2) found.add(v);
        success = true;
      }

      if (!success) {
        droppedChunks++;
        console.warn(`\n   ⚠️  ${table}.${column} chunk ${i} failed after retries: ${lastErr?.message || lastErr}`);
      }

      processed += batch.length;
      if (processed % 5000 < size) {
        process.stdout.write(`\r🔎 ${table}.${column}: ${processed.toLocaleString()}/${arr.length.toLocaleString()}`);
      }
    }
    if (droppedChunks > 0) {
      console.warn(`\n   ⚠️  ${table}.${column}: ${droppedChunks} chunks lost — duplicates may slip through`);
    }
    return found;
  }

  // Try the server-side RPC first (one round trip per 5k keys).
  // Falls back to per-column chunked .in() if the RPC isn't installed yet
  // (mig 45 not applied) or fails for any reason.
  let usedRpc = false;
  try {
    await rpcDedupAll();
    usedRpc = true;
    console.log(`\n   ✓ used dedupe_incoming RPC`);
  } catch (e) {
    console.warn(`\n   ⚠️  RPC dedup unavailable (${e?.message || e}) — falling back to per-column chunked .in()`);
  }

  if (!usedRpc) {
    // Sequential, not parallel — 4× concurrent chunked .in() floods the pool.
    const idRes = await chunkedIn('id_map', 'legacy_entry_id', idCandidates);
    for (const v of idRes) knownIds.add(v);
    const doiRes = await chunkedIn('papers', 'doi', doiCandidates);
    for (const v of doiRes) knownDois.add(v);
    const arxivRes = await chunkedIn('papers', 'arxiv_id', arxivCandidates);
    for (const v of arxivRes) knownArxiv.add(v);
    const titleRes = await chunkedIn('papers', 'title_normalized', titleHashCandidates);
    for (const v of titleRes) knownTitles.add(v);
  }
  console.log();

  const truly = entryKeys.filter(({ entry, doi, arxivId, titleHash }) => {
    if (entry.id && knownIds.has(entry.id)) return false;
    if (doi && knownDois.has(doi)) return false;
    if (arxivId && knownArxiv.has(arxivId)) return false;
    if (titleHash && knownTitles.has(titleHash)) return false;
    return true;
  }).map(x => x.entry);

  const dropped = newEntries.length - truly.length;
  console.log(`✅ ${truly.length.toLocaleString()} truly new (dropped ${dropped.toLocaleString()} dups) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return truly;
}

// Generate embeddings for the new RSS items, grouped by journal so the
// inner OpenAI batch call stays small and the rate-limit retry path can
// recover per-journal. Phase 4 dropped the per-journal JSON file writes
// — Supabase + the website's API routes are the source of truth now.
async function generateEmbeddingsForNewArticles(newEntries) {
  if (newEntries.length === 0) return;
  process.stdout.write('🧬 Generating embeddings for new articles... ');

  const validNew = newEntries.filter(e => e && e.id && e.title && e.journalId);

  // Group by journalId so we keep the same per-journal batching contract
  // generateEmbeddings expects.
  const journalMap = new Map();
  for (const entry of validNew) {
    if (!journalMap.has(entry.journalId)) journalMap.set(entry.journalId, []);
    journalMap.get(entry.journalId).push(entry);
  }

  let embeddedJournals = 0;
  let processed = 0;
  const total = journalMap.size;

  await pMap(Array.from(journalMap.entries()), async ([journalId, articles]) => {
    articles.sort((a, b) => {
      try { return new Date(b.published).getTime() - new Date(a.published).getTime(); }
      catch { return 0; }
    });
    if (articles.length > 0) {
      await generateEmbeddings(articles, journalId);
      embeddedJournals++;
    }
    processed++;
    if (processed % 100 === 0) {
      console.log(`\n🧬 Processed ${processed}/${total} journals...`);
    }
  }, 50);

  console.log(`✅ embedded ${validNew.length.toLocaleString()} new articles across ${embeddedJournals.toLocaleString()} journals`);
}

/**
 * Generate entry-index.json for fast lookup by entry ID
 * This is used by popular and top routes for quick article lookup
 */
function generateEntryIndex(allEntries) {
  console.log('⚠️  generateEntryIndex is deprecated and disabled to prevent memory crashes.');
  return;

  process.stdout.write('📑 Generating entry index... ');

  // Filter out invalid entries (must have both id and title)
  const validEntries = allEntries.filter(entry =>
    entry && entry.id && entry.title
  );

  // Create index: entry_id -> entry object (excluding heavy embeddings)
  const entryIndex = {};
  for (const entry of validEntries) {
    // precise copy to avoid modifying original
    const { embedding, embedding_model, ...entryWithoutEmbedding } = entry;
    entryIndex[entry.id] = entryWithoutEmbedding;
  }

  const indexPath = join(outputDir, 'entry-index.json');
  writeFileSync(indexPath, JSON.stringify(entryIndex));
  const size = statSync(indexPath).size;
  const sizeMB = (size / 1024 / 1024).toFixed(2);

  console.log(`✅ ${Object.keys(entryIndex).length.toLocaleString()} entries, ${sizeMB} MB`);

  // Also generate a small lookup index: article_id -> journal_id
  // This is used for fast lookups in popular/top APIs
  process.stdout.write('📑 Generating article-journal lookup... ');
  const lookupIndex = {};
  for (const entry of validEntries) {
    if (entry.journalId) {
      lookupIndex[entry.id] = entry.journalId;
    }
  }
  const lookupPath = join(outputDir, 'article-lookup.json');
  writeFileSync(lookupPath, JSON.stringify(lookupIndex));
  const lookupSize = statSync(lookupPath).size;
  const lookupSizeMB = (lookupSize / 1024 / 1024).toFixed(2);
  console.log(`✅ ${Object.keys(lookupIndex).length.toLocaleString()} entries, ${lookupSizeMB} MB`);
}

// Support command line argument: --merge-only (for build process)
const isMergeOnly = process.argv.includes('--merge-only');

async function main() {
  // Phase timing for debugging
  const phaseTiming = {
    start: Date.now(),
    loading: 0,
    fetching: 0,
    classification: 0,
    writing: 0,
    maintenance: 0
  };

  // Pick up API keys saved in the UI (Settings -> Setup) if not set in the env.
  await loadLocalApiKeys();

  // --merge-only: regenerate landing-page.json from Supabase without
  // running the full RSS fetch. stats.json no longer exists — its
  // consumer (/api/article-counts) queries Supabase live.
  if (isMergeOnly) {
    console.log('🔄 Merge-only mode: regenerating landing-page.json from Supabase…\n');
    await generateLandingPage([]); // null/empty triggers Supabase live fetch
    console.log('\n✅ Complete\n');
    return;
  }

  // Step 1: Load existing entries from journal files to merge with new ones
  // CRITICAL: Always load existing entries first to preserve all historical articles
  // This ensures articles are never lost even if RSS feeds stop including them
  // Journal files are the only source of truth
  const loadStart = Date.now();
  logGroup('📚 Loading Existing Data');
  const journalEntries = await loadExistingEntries();
  // Pre-load existing entry IDs so we can skip enrichment for items
  // we already have (the dominant case — ~99% of RSS items per cycle).
  await preloadExistingLegacyIds();
  endGroup();
  phaseTiming.loading = Date.now() - loadStart;
  console.log(`⏱️  Loading phase: ${(phaseTiming.loading / 1000).toFixed(1)}s\n`);

  let existingEntries = [];

  if (journalEntries.length > 0) {
    existingEntries = journalEntries;
  }

  // Log enrichment status
  if (ENRICHMENT_ENABLED) {
    console.log('🔬 Abstract enrichment: ENABLED\n');
  }

  let existingEntryIds = new Set();
  let existingContentKeys = new Set(); // Track by content (DOI/arXiv/title) too

  if (existingEntries.length > 0) {
    existingEntryIds = new Set(existingEntries.map(e => e.id));
    // Also track by content for better duplicate detection
    // Use same logic as in main loop: prefer DOI, then arXiv ID, then normalized title (if not empty)
    existingEntries.forEach(e => {
      const normalizedTitle = normalizeTitle(e.title || '');
      // Re-extract canonical arxiv ID in case the existing entry was stored with empty arxivId
      const canonicalArxiv = extractArXivId(e);
      const dedupKey = canonicalArxiv || e.doi || (normalizedTitle && normalizedTitle.trim() !== '' ? normalizedTitle : null);
      if (dedupKey && dedupKey.trim() !== '') {
        existingContentKeys.add(dedupKey);
      }
    });
    // Tracking info removed for cleaner output
  }

  const newEntries = [];
  const seenKeys = new Set(); // For deduplication within this run
  const failedThisRun = new Set();

  // Single-user local mode: only fetch journals the user follows. No point
  // pulling all ~3,600 catalog feeds when you follow a handful. If follows
  // can't be read, fall back to fetching everything.
  let followedIds = null;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('user_state')
        .select('follows')
        .eq('user_id', '11111111-1111-4111-8111-111111111111')
        .maybeSingle();
      if (data && Array.isArray(data.follows)) followedIds = new Set(data.follows);
    } catch {
      // fall back to all journals
    }
  }

  // Collect all journals to process (try all feeds, even previously failed ones)
  const allJournals = [];
  for (const discipline of catalog.disciplines) {
    for (const journal of discipline.journals) {
      if (followedIds && !followedIds.has(journal.id)) continue;
      // Handle both single RSS feed (string) and multiple RSS feeds (array)
      const rssFeeds = Array.isArray(journal.rss) ? journal.rss : [journal.rss];

      for (const rssFeed of rssFeeds) {
        // Create a journal object with single RSS feed for processing
        const journalWithSingleFeed = { ...journal, rss: rssFeed };
        allJournals.push({ journal: journalWithSingleFeed, discipline: discipline.name });
      }
    }
  }
  if (followedIds) {
    console.log(`\nFollowed-only mode: ${allJournals.length} feed(s) for ${followedIds.size} followed journal(s).`);
  }


  const fetchStart = Date.now();
  logGroup('📡 Fetching Feeds');
  console.log(`\nFetching ${allJournals.length.toLocaleString()} feeds in parallel batches...`);

  let processed = 0;
  let totalItems = 0;
  let articlesWithRSSAbstract = 0; // Track abstracts from RSS
  let articlesNeedingEnrichment = 0; // Track how many needed API enrichment
  const startTime = Date.now();
  let lastProgressTime = startTime;
  let successfulFeeds = 0;
  let failedFeedsCount = 0;
  let newEntriesCount = 0; // Track new entries count separately

  // Create progress bar using cli-progress
  const progressBar = new cliProgress.SingleBar({
    format: '📊 Progress |{bar}| {percentage}% | {value}/{total} | ✅{successful} ❌{failed} | 📄{items} 🆕{new} | ⏱️ {duration}s | ETA: {eta}s',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
    clearOnComplete: false
  }, cliProgress.Presets.shades_classic);

  // Start the progress bar
  progressBar.start(allJournals.length, 0, {
    successful: 0,
    failed: 0,
    items: 0,
    new: 0
  });
  // Update progress bar periodically
  const progressInterval = setInterval(() => {
    progressBar.update(processed, {
      successful: successfulFeeds,
      failed: failedFeedsCount,
      items: totalItems.toLocaleString(),
      new: newEntriesCount
    });
  }, 1000); // Update every second

  // Process journals with continuous concurrency (100 active requests)
  // This is better than batches because it doesn't wait for the slowest feed in the batch
  const batchResults = await pMap(allJournals, async ({ journal, discipline }) => {
    const rssUrl = journal.rss.trim().replace(/%20$/, '').replace(/rss%20$/, 'rss');

    // Track timing for debugging slow feeds
    const feedStart = Date.now();
    const feed = await fetchFeed(rssUrl);
    const feedDuration = Date.now() - feedStart;

    // Track and log slow feeds (>5 seconds) in real-time
    if (feedDuration > 5000) {
      slowFeeds.push({ journal: journal.name, url: rssUrl, duration: feedDuration, success: !!feed });
      // Always log slow feeds for debugging
      console.log(`\n⏱️  SLOW: ${journal.name} took ${(feedDuration / 1000).toFixed(1)}s ${feed ? '✅' : '❌'}`);
    }

    processed++; // Update processed count for progress bar

    if (!feed || !feed.items) {
      failedThisRun.add(journal.rss);
      failedFeeds++;
      return [];
    }

    successfulFeeds++;

    const entries = [];
    totalItems += feed.items.length;

    for (const item of feed.items) {
      // `let` (not const): a DOI-less item (ScienceDirect/Elsevier RSS) can have
      // its DOI resolved during enrichment and reassigned below (~line 3007).
      // Was `const`, which threw "Assignment to constant variable" for every such
      // item and silently dropped its enrichment.
      let doi = extractDOI(item);
      const arxivId = extractArXivId(item);
      const normalizedTitle = normalizeTitle(item.title || '');

      // Deduplication key: prefer arXiv ID (version-stripped, canonical) over DOI,
      // so arxiv papers with v2/v3/v4 variants collapse to one entry.
      const dedupKey = arxivId || doi || (normalizedTitle && normalizedTitle.trim() !== '' ? normalizedTitle : null);
      // Safely extract GUID and Link as strings to avoid "Cannot convert object to primitive value" errors
      let safeGuid = item.guid;
      if (safeGuid && typeof safeGuid === 'object') {
        // Handle object GUIDs (common in some RSS feeds, e.g. with attributes)
        // Try common properties or fallback to string representation
        safeGuid = safeGuid._ || safeGuid.$t || (safeGuid.toString ? safeGuid.toString() : '');
        if (typeof safeGuid === 'object') {
          try { safeGuid = JSON.stringify(safeGuid); } catch (e) { safeGuid = 'unknown-guid'; }
        }
      }

      let safeLink = item.link;
      if (safeLink && typeof safeLink === 'object') {
        safeLink = safeLink.href || (safeLink.toString ? safeLink.toString() : '');
        if (typeof safeLink === 'object') {
          try { safeLink = JSON.stringify(safeLink); } catch (e) { safeLink = 'unknown-link'; }
        }
      }

      const entryId = doi || arxivId || `${journal.id}-${safeGuid || safeLink}`;

      // If we have a dedupKey, check for duplicates
      if (dedupKey) {
        // Skip if we've seen this in the current run
        if (seenKeys.has(dedupKey)) {
          continue;
        }
        seenKeys.add(dedupKey);

        // Skip if this article already exists by content (DOI/arXiv/title)
        // This handles cases where RSS feeds update GUIDs/links but it's the same article
        // We always preserve the original/existing entry to maintain historical data
        if (existingContentKeys.has(dedupKey)) {
          continue;
        }
      }

      // Skip if this article already exists by ID (we'll keep the existing one)
      // This check happens after content check because ID might change but content is same
      if (existingEntryIds.has(entryId)) {
        continue;
      }

      // Pull categories/tags if present
      const categories = Array.isArray(item.categories)
        ? item.categories.map(c => (typeof c === 'string' ? c : (c && (c.label || c.term)) || '')).filter(Boolean)
        : [];

      // Pull explicit type from common metadata if present
      const sourceType = item['dc:type'] || item['prism:genre'] || item['prism:section'] || item['article:section'] || undefined;

      // Extract authors first, then clean abstract (so we know if authors were extracted)
      const authors = extractAuthors(item);
      // Try multiple sources for abstract - RSS feeds vary widely in format
      // Priority order: content:encoded (Nature), content (full HTML), PRISM/Dublin Core metadata, description, summary, contentSnippet
      let rawAbstract = '';

      // Check if this is a Nature or Elsevier feed
      const isNature = item.link && (item.link.includes('nature.com') || item.link.includes('feeds.nature.com'));
      const isElsevier = item.link && (item.link.includes('sciencedirect.com') || item.link.includes('elsevier.com'));

      // Strategy 1: For Nature, prioritize content:encoded (contains abstract)
      if (isNature && !rawAbstract) {
        const contentEncoded = item['content:encoded'];
        if (contentEncoded && typeof contentEncoded === 'string' && contentEncoded.trim()) {
          // Nature's content:encoded often contains metadata like "Nature, Published online: ..." followed by title and abstract
          // We need to extract just the abstract part, skipping the metadata and title
          let descText = stripHTML(contentEncoded);

          // Remove Nature metadata patterns at the start:
          // "Nature, Published online: 11 November 2025; doi:10.1038/..."
          // "Nature, Published online: ..."
          descText = descText.replace(/^Nature,\s*Published\s+online:\s*\d+\s+\w+\s+\d{4};\s*doi:[^\n]+\s*/i, '');
          descText = descText.replace(/^Nature,\s*Published\s+online:[^\n]+\s*/i, '');

          // Remove DOI patterns that might appear at the start
          descText = descText.replace(/^doi:\s*[^\n]+\s*/i, '');

          // Remove "Nature" at the start if it's just metadata
          descText = descText.replace(/^Nature\s*,\s*/i, '');

          // The title often appears after metadata, followed by the abstract
          // Look for patterns like "Title text." followed by abstract text
          // Split into lines and find where the abstract actually starts
          const lines = descText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

          if (lines.length > 1) {
            // Find the first line that looks like an abstract (longer, contains common abstract words)
            let abstractStartIndex = 0;
            const abstractIndicators = /\b(abstract|background|introduction|here|we|this|these|results|methods|conclusion|summary|objective|aim|purpose)\b/i;

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              // Skip very short lines (likely title or metadata)
              if (line.length < 50) continue;

              // If line contains abstract indicators or is substantially long, it's likely the abstract
              if (abstractIndicators.test(line) || line.length > 200) {
                abstractStartIndex = i;
                break;
              }

              // If we've seen 2-3 short lines and then a long one, the long one is likely the abstract
              if (i >= 2 && line.length > 150) {
                abstractStartIndex = i;
                break;
              }
            }

            // Use everything from abstractStartIndex onwards
            if (abstractStartIndex > 0) {
              descText = lines.slice(abstractStartIndex).join('\n');
            } else if (lines.length > 1) {
              // Fallback: if first line is short and second is long, skip first
              const firstLine = lines[0];
              const secondLine = lines[1];
              if (firstLine.length < 150 && secondLine.length > 100) {
                descText = lines.slice(1).join('\n');
              }
            }
          }

          // Only use if we have substantial content after cleaning (at least 100 chars)
          if (descText.trim().length > 100) {
            rawAbstract = descText.trim();
          }
        }
      }

      // Strategy 2: Try content first (usually has full abstract in HTML, but for Elsevier it's often just metadata)
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        if (item.content && typeof item.content === 'string' && item.content.trim()) {
          const contentText = stripHTML(item.content);
          // For Elsevier, content often contains only metadata (Publication date, Source, Author(s))
          // Check if it looks like an abstract (has substantial text beyond metadata)
          if (isElsevier) {
            // Skip if it's just metadata (starts with "Publication date" or "Source" or "Author(s)")
            const isJustMetadata = /^(Publication\s+date|Source|Author\(s\)):/i.test(contentText.trim());
            if (!isJustMetadata && contentText.trim().length > 100) {
              rawAbstract = contentText;
            }
          } else {
            // For non-Elsevier, use content as-is
            rawAbstract = contentText;
          }
        }
      }

      // Strategy 3: Try PRISM description (used by Nature, Elsevier, Springer, etc.)
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        const prismDesc = item['prism:description'];
        if (prismDesc && typeof prismDesc === 'string' && prismDesc.trim()) {
          const descText = stripHTML(prismDesc);
          if (descText.trim().length > 50) {
            rawAbstract = descText;
          }
        }
      }

      // Strategy 4: Try Dublin Core description
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        const dcDesc = item['dc:description'];
        if (dcDesc && typeof dcDesc === 'string' && dcDesc.trim()) {
          const descText = stripHTML(dcDesc);
          if (descText.trim().length > 50) {
            rawAbstract = descText;
          }
        }
      }

      // Strategy 5: Try content:encoded (for non-Nature feeds, or if Nature strategy didn't work)
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        const contentEncoded = item['content:encoded'];
        if (contentEncoded && typeof contentEncoded === 'string' && contentEncoded.trim()) {
          const descText = stripHTML(contentEncoded);
          if (descText.trim().length > 50) {
            rawAbstract = descText;
          }
        }
      }

      // Strategy 6: If content is empty or too short, try description/summary
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        const description = item.description || item.summary || '';
        if (description && typeof description === 'string' && description.trim()) {
          // Description might be HTML or plain text - strip HTML to be safe
          const descText = stripHTML(description);
          // For Elsevier, check if it's just metadata
          if (isElsevier) {
            const isJustMetadata = /^(Publication\s+date|Source|Author\(s\)):/i.test(descText.trim());
            if (!isJustMetadata && descText.trim().length > 100) {
              rawAbstract = descText;
            }
          } else {
            // Only use if it's substantial (likely an abstract, not just metadata)
            if (descText.trim().length > 50) {
              rawAbstract = descText;
            }
          }
        }
      }

      // Strategy 7: Fallback to contentSnippet (often truncated but better than nothing)
      if (!rawAbstract || rawAbstract.trim().length < 50) {
        if (item.contentSnippet && typeof item.contentSnippet === 'string' && item.contentSnippet.trim()) {
          const snippetText = stripHTML(item.contentSnippet);
          // For Elsevier, check if it's just metadata
          if (isElsevier) {
            const isJustMetadata = /^(Publication\s+date|Source|Author\(s\)):/i.test(snippetText.trim());
            if (!isJustMetadata && snippetText.trim().length > 100) {
              rawAbstract = snippetText;
            }
          } else {
            rawAbstract = snippetText;
          }
        }
      }

      // Extract dates from raw abstract/metadata before cleaning
      let publicationDateFromAbstract = null;
      let availableOnlineDateFromAbstract = null;

      if (rawAbstract) {
        // Extract "Publication date: ..." pattern
        const pubDateMatch = rawAbstract.match(/Publication\s+date:\s*([^\n]+)/i);
        if (pubDateMatch && pubDateMatch[1]) {
          try {
            const dateStr = pubDateMatch[1].trim();
            // Parse common date formats: "Available online 20 October 2025", "October 2025", "2025-10-20", etc.
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
              publicationDateFromAbstract = parsedDate.toISOString();
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }

        // Extract "Available online ..." pattern
        const onlineDateMatch = rawAbstract.match(/Available\s+online\s+([^\n]+)/i);
        if (onlineDateMatch && onlineDateMatch[1]) {
          try {
            const dateStr = onlineDateMatch[1].trim();
            const parsedDate = new Date(dateStr);
            if (!isNaN(parsedDate.getTime())) {
              availableOnlineDateFromAbstract = parsedDate.toISOString();
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
      }

      // Only clean if we have a substantial abstract (at least 50 chars)
      // This avoids cleaning short snippets that might just be metadata
      const cleanedAbstract = rawAbstract && rawAbstract.trim().length >= 50
        ? cleanAbstract(rawAbstract, authors)
        : (rawAbstract && rawAbstract.trim().length > 0 ? rawAbstract.trim() : undefined);
      // Only include abstract field if we have a valid abstract (not undefined or empty)
      // This ensures the field exists in JSON when there's content, but we don't store empty strings

      // Prioritize publication-specific date fields over generic pubDate
      // Many academic journals use PRISM or Dublin Core metadata
      // Priority: publicationDateFromAbstract > availableOnlineDateFromAbstract > prism:publicationDate > dc:date > pubDate > isoDate
      let publishedDate = publicationDateFromAbstract ||
        item['prism:publicationDate'] ||
        item['dc:date'] ||
        item.pubDate ||
        item.isoDate ||
        new Date().toISOString();

      // If we got a date string, ensure it's in ISO format
      if (publishedDate && typeof publishedDate === 'string') {
        try {
          // Convert to Date and back to ISO to normalize format
          const dateObj = new Date(publishedDate);
          if (!isNaN(dateObj.getTime())) {
            publishedDate = dateObj.toISOString();
          }
        } catch (e) {
          // If parsing fails, keep original or fall back to current date
          publishedDate = new Date().toISOString();
        }
      }

      // Set availableOnline date - prefer extracted, otherwise use publishedDate if they're the same
      let availableOnlineDate = availableOnlineDateFromAbstract || null;

      // If we have both dates and they're the same, only keep one
      if (availableOnlineDate && publishedDate) {
        const pubDate = new Date(publishedDate);
        const onlineDate = new Date(availableOnlineDate);
        // Compare dates at day level (ignore time)
        if (pubDate.toDateString() === onlineDate.toDateString()) {
          availableOnlineDate = null; // Same date, don't store separately
        }
      }

      // Drop heading-only / citation-stub "abstracts" (Springer "Background
      // Methods Results Conclusions", Nature "Published online: ...; doi:10...")
      // to undefined so the enrichment cascade fills a real one, and strip
      // feed/CMS boilerplate tails ("The post X appeared first on Y", the
      // ScienceAlert subscribe blurb). Shared with scripts/fix-junk-abstracts.mjs.
      const { cleanForStore } = await import('./lib/abstractClean.mjs');
      // Enrich article metadata using cascade strategy (OpenAlex → Semantic Scholar → Crossref → PubMed)
      let finalAbstract = cleanForStore(cleanedAbstract) || undefined;
      const hadRSSAbstract = finalAbstract && finalAbstract.length > 200;
      let finalAuthors = authors;
      const hadRSSAuthors = finalAuthors && finalAuthors.trim().length > 0;

      // Skip enrichment if we already have this entry — no point hitting
      // external APIs for a paper we'll dedup-filter out anyway. Saves
      // ~99% of enrichment calls per run.
      const alreadyKnown = existingLegacyIds.size > 0 && entryId && existingLegacyIds.has(entryId);

      if (ENRICHMENT_ENABLED && !alreadyKnown && (doi || item.title)) {
        const enrichStart = Date.now();
        const enrichResult = await enrichArticleMetadata(doi, item.title, finalAbstract, finalAuthors, item.link);
        finalAbstract = enrichResult.abstract;
        finalAuthors = enrichResult.authors;
        // A DOI-less item (e.g. ScienceDirect RSS) whose DOI we just resolved
        // via the Elsevier PII endpoint: adopt it so the entry below gets a real
        // doi: identity (dedup + canonical_id key off entry.doi).
        if ((!doi || !String(doi).trim()) && enrichResult.doi) doi = enrichResult.doi;

        // Log slow enrichment calls (>2s) and progress every 50 articles
        const enrichDuration = Date.now() - enrichStart;
        if (enrichDuration > 2000) {
          console.log(`\n🔬 SLOW ENRICHMENT: ${item.title?.slice(0, 50)}... took ${(enrichDuration / 1000).toFixed(1)}s`);
        }
        articlesNeedingEnrichment++;
        if (articlesNeedingEnrichment % 50 === 0) {
          console.log(`\n🔬 Enriched ${articlesNeedingEnrichment} articles...`);
        }

        // Track stats
        if (hadRSSAbstract) {
          articlesWithRSSAbstract++;
        }
      } else if (hadRSSAbstract) {
        articlesWithRSSAbstract++;
      }

      const entry = {
        id: entryId,
        title: item.title || 'Untitled',
        authors: finalAuthors || undefined, // Use undefined so JSON.stringify removes it if missing
        abstract: finalAbstract,
        journal: journal.name,
        journalId: journal.id,
        published: publishedDate,
        availableOnline: availableOnlineDate || undefined, // Store separately if different from published
        doi: doi
          ? doi
            .replace(/10\.64898\//g, '10.1101/') // Convert bioRxiv new DOI prefix (10.64898) to standard (10.1101)
            .replace(/\?rss=1/, '')
            .replace(/(10\.1101\/\S+?)v\d+$/i, '$1') // Strip the bioRxiv version suffix (…v1) — not part of the DOI
            .trim()
          : (arxivId ? `10.48550/arXiv.${arxivId}` : undefined), // Generate DOI from arXiv ID if no DOI found
        arxivId: arxivId || undefined,
        link: (item.link || '').replace(/\/10\.1101\/10\.64898\//g, '/10.64898/').replace(/\n/g, '').trim(), // Fix bioRxiv new DOI format and remove newlines
        pdfLink: findPDFLink(item) || undefined,
        thumbnail: findThumbnail(item) || undefined,
        categories,
        sourceType
      };

      entries.push(entry);
      newEntriesCount++; // Track new entries for progress bar
    }

    return entries;
  }, 100); // 100 concurrent feeds

  // Flatten results from all batches
  for (const batch of batchResults) {
    if (batch) { // Handle null results from pMap errors
      newEntries.push(...batch);
    }
  }

  // Stop progress interval and update progress bar one final time
  clearInterval(progressInterval);
  progressBar.update(processed, {
    successful: successfulFeeds,
    failed: failedFeeds,
    items: totalItems.toLocaleString(),
    new: newEntriesCount
  });
  progressBar.stop();
  console.log(''); // Add newline after progress bar
  console.log('═'.repeat(70));
  console.log('📊 FETCH COMPLETE');
  console.log('═'.repeat(70));
  console.log(`Processed: ${totalItems.toLocaleString()} total items`);
  console.log(`Found: ${newEntries.length.toLocaleString()} new entries`);
  console.log(`Successful feeds: ${successfulFeeds.toLocaleString()}`);
  console.log(`Failed feeds: ${failedFeeds.toLocaleString()}`);
  console.log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Report slow feeds
  if (slowFeeds.length > 0) {
    console.log(`\n⏱️  SLOW FEEDS (>${5}s): ${slowFeeds.length} feeds`);
    const sortedSlow = slowFeeds.sort((a, b) => b.duration - a.duration).slice(0, 20);
    for (const sf of sortedSlow) {
      console.log(`   ${(sf.duration / 1000).toFixed(1)}s ${sf.success ? '✅' : '❌'} ${sf.journal}`);
    }
    if (slowFeeds.length > 20) {
      console.log(`   ... and ${slowFeeds.length - 20} more slow feeds`);
    }
  }
  console.log('═'.repeat(70) + '\n');

  // Track failed feeds for reporting only (but we'll still try them next time)
  if (failedThisRun.size > 0) {
    const union = new Set([...Array.from(failedFeeds), ...Array.from(failedThisRun)]);
    try {
      writeFileSync(failedFeedsPath, JSON.stringify(Array.from(union), null, 2));
    } catch (e) {
      console.error('Failed to write failed feeds list:', e?.message || e);
    }
  }

  endGroup();
  phaseTiming.fetching = Date.now() - fetchStart;
  console.log(`⏱️  Fetching phase: ${(phaseTiming.fetching / 1000).toFixed(1)}s\n`);

  // Per-batch dedup against Supabase. The bulk-loader path was retired
  // — the inline dedup against existingContentKeys/existingEntryIds runs
  // against an empty set when ENABLE_BULK_LOADER is false (the default),
  // so newEntries here contains every RSS item that survived in-run dedup.
  // This pass drops anything already in id_map or papers.
  const verified = await dedupeNewEntriesAgainstSupabase(newEntries);
  // Replace newEntries contents in place. push.apply blows the stack on
  // 128k args (V8's max function arg count); chunked push avoids that.
  newEntries.length = 0;
  for (let i = 0; i < verified.length; i += 10000) {
    newEntries.push(...verified.slice(i, i + 10000));
  }

  // Classify new articles using LLM (if ANTHROPIC_API_KEY is set)
  const classifyStart = Date.now();
  logGroup('🏷️ Classification');
  await classifyNewArticles(newEntries);
  endGroup();
  phaseTiming.classification = Date.now() - classifyStart;
  console.log(`⏱️  Classification phase: ${(phaseTiming.classification / 1000).toFixed(1)}s\n`);

  // Merge new entries with existing ones (keep all articles indefinitely for bookmarking)
  const allEntries = [...existingEntries, ...newEntries];

  // Deduplicate based on content (DOI, arXiv ID, or normalized title) to handle cases where
  // the same article has different IDs (e.g., if RSS feed updates GUID/link)
  // This ensures we preserve all unique articles while removing true duplicates
  const deduplicatedEntries = [];
  const seenContent = new Map(); // Map<dedupKey, bestEntry>

  for (const entry of allEntries) {
    // Generate deduplication key: prefer canonical arXiv ID over DOI, then title
    const canonicalArxiv = extractArXivId(entry);
    const dedupKey = canonicalArxiv || entry.arxivId || entry.doi || normalizeTitle(entry.title || '');

    if (!dedupKey || dedupKey.trim() === '') {
      // If no dedup key, keep all entries (they're unique by ID)
      deduplicatedEntries.push(entry);
      continue;
    }

    // Check if we've seen this content before
    const existing = seenContent.get(dedupKey);

    if (!existing) {
      // First time seeing this content - keep it
      seenContent.set(dedupKey, entry);
      deduplicatedEntries.push(entry);
    } else {
      // Duplicate found - ALWAYS keep the existing/older entry to preserve historical data
      // This ensures we never lose articles that were previously saved
      // The existing entry was already added to deduplicatedEntries, so we just skip the new one
      // This preserves all articles from when the website launched, even if RSS feeds update
      continue;
    }
  }

  // Sort by published date (newest first)
  deduplicatedEntries.sort((a, b) => {
    try {
      return new Date(b.published).getTime() - new Date(a.published).getTime();
    } catch {
      return 0;
    }
  });

  // Summary will be shown at the end

  // Write step — Phase 4 reduced this to:
  //   * embed new articles only (no per-journal JSON writes)
  //   * regenerate landing-page.json (consumed by /api/landing)
  // popular.json + stats.json are no longer written: /api/popular and
  // /api/article-counts now query Supabase live.
  const writeStart = Date.now();
  logGroup('💾 Writing Data');
  await generateEmbeddingsForNewArticles(newEntries);

  process.stdout.write('📄 Generating landing page...\n');
  // Pass [] so generateLandingPage queries Supabase for the live last-7-days
  // window. deduplicatedEntries here is only the truly-new subset under
  // per-batch dedup, which is too narrow for landing-page diversity.
  await generateLandingPage([]);
  console.log('✅');
  endGroup();
  phaseTiming.writing = Date.now() - writeStart;
  console.log(`⏱️  Writing phase: ${(phaseTiming.writing / 1000).toFixed(1)}s\n`);

  // Cleanup old embeddings to save space/cost
  const maintStart = Date.now();
  logGroup('🧹 Maintenance');
  await cleanupOldEmbeddings();
  endGroup();
  phaseTiming.maintenance = Date.now() - maintStart;
  console.log(`⏱️  Maintenance phase: ${(phaseTiming.maintenance / 1000).toFixed(1)}s\n`);

  // ========================================================================
  // Phase 1 dual-write: new articles → Supabase papers/sightings/id_map.
  // Gated behind DUAL_WRITE_CANONICAL=true so the SQL migration can be
  // applied first. Failures are logged and swallowed — the legacy JSON
  // path is still the source of truth until the full migration completes.
  // ========================================================================
  const DUAL_WRITE_CANONICAL =
    (process.env.DUAL_WRITE_CANONICAL || '').toLowerCase() === 'true';
  if (DUAL_WRITE_CANONICAL && supabase && newEntries.length > 0) {
    const dwStart = Date.now();
    logGroup('🧬 Dual-write papers/sightings');
    try {
      const { syncPapersAndSightings } = await import('./lib/paper-sync.mjs');
      const stats = await syncPapersAndSightings(newEntries, supabase);
      console.log(
        `   synced ${newEntries.length} new articles → ` +
        `papers=${stats.papersUpserted}, sightings=${stats.sightingsUpserted}, ` +
        `id_map=${stats.idMapUpserted}, errors=${stats.errors}`
      );

      // Catch-up pass: any article_embeddings row for articles we just saw
      // that still has canonical_id=null gets filled via a scoped UPDATE.
      // Only touches rows whose article_id is in this batch — cheap.
      try {
        const legacyIds = [...new Set(newEntries.map(e => e.id).filter(Boolean))];
        if (legacyIds.length > 0) {
          for (let i = 0; i < legacyIds.length; i += 200) {
            const batch = legacyIds.slice(i, i + 200);
            const { data: idMapRows } = await supabase
              .from('id_map')
              .select('legacy_entry_id,canonical_id')
              .in('legacy_entry_id', batch);
            if (!idMapRows?.length) continue;
            await Promise.all(idMapRows.map(r =>
              supabase.from('article_embeddings')
                .update({ canonical_id: r.canonical_id })
                .eq('article_id', r.legacy_entry_id)
                .is('canonical_id', null)
            ));
          }
        }
      } catch (e) {
        console.error('   ⚠️  embedding canonical catch-up failed (non-fatal):', e?.message || e);
      }
    } catch (e) {
      console.error('   ⚠️  dual-write failed (non-fatal):', e?.message || e);
    }
    endGroup();
    console.log(`⏱️  Dual-write phase: ${((Date.now() - dwStart) / 1000).toFixed(1)}s\n`);
  }

  // Final summary
  const duplicatesRemoved = allEntries.length - deduplicatedEntries.length;
  const totalTime = Date.now() - phaseTiming.start;

  console.log('\n' + '═'.repeat(70));
  console.log('📊 FINAL SUMMARY');
  console.log('═'.repeat(70));
  console.log(`\n⏱️  PHASE TIMING BREAKDOWN:`);
  console.log(`   Loading:        ${(phaseTiming.loading / 1000).toFixed(1)}s`);
  console.log(`   Fetching:       ${(phaseTiming.fetching / 1000).toFixed(1)}s`);
  console.log(`   Classification: ${(phaseTiming.classification / 1000).toFixed(1)}s`);
  console.log(`   Writing:        ${(phaseTiming.writing / 1000).toFixed(1)}s`);
  console.log(`   Maintenance:    ${(phaseTiming.maintenance / 1000).toFixed(1)}s`);
  console.log(`   ─────────────────────`);
  console.log(`   TOTAL:          ${(totalTime / 1000).toFixed(1)}s\n`);
  console.log(`Total unique articles: ${deduplicatedEntries.length.toLocaleString()}`);
  console.log(`Existing articles: ${existingEntries.length.toLocaleString()}`);
  console.log(`New articles added: ${newEntries.length.toLocaleString()}`);
  console.log(`Duplicates removed: ${duplicatesRemoved.toLocaleString()}`);

  if (newEntries.length > 0) {
    const articlesWithoutAbstract = newEntries.length - articlesWithRSSAbstract - enrichmentStats.total;
    console.log(`\n📄 Abstract statistics (new articles):`);
    console.log(`   - From RSS feed: ${articlesWithRSSAbstract.toLocaleString()}`);
    if (ENRICHMENT_ENABLED) {
      console.log(`   - From API enrichment: ${enrichmentStats.total.toLocaleString()}`);
      if (enrichmentStats.openAlex > 0) console.log(`     • OpenAlex: ${enrichmentStats.openAlex.toLocaleString()}`);
      if (enrichmentStats.semanticScholar > 0) console.log(`     • Semantic Scholar: ${enrichmentStats.semanticScholar.toLocaleString()}`);
      if (enrichmentStats.crossref > 0) console.log(`     • Crossref: ${enrichmentStats.crossref.toLocaleString()}`);
      if (enrichmentStats.pubmed > 0) console.log(`     • PubMed: ${enrichmentStats.pubmed.toLocaleString()}`);
    }
    console.log(`   - No abstract: ${articlesWithoutAbstract.toLocaleString()}`);
    const coveragePct = ((articlesWithRSSAbstract + enrichmentStats.total) / newEntries.length * 100).toFixed(1);
    console.log(`   - Coverage: ${coveragePct}%`);
  }

  if (failedThisRun.size > 0) {
    const union = new Set([...Array.from(failedFeeds), ...Array.from(failedThisRun)]);
    console.log(`\n⚠️  Recorded ${failedThisRun.size} failing feeds this run (${union.size} total)`);
    console.log(`   Note: These feeds will still be attempted on next run.`);
  }

  console.log('═'.repeat(70));
}

// Landing page generation functions
function formatAuthorsSimple(authorsStr) {
  if (!authorsStr) return '';
  const parts = authorsStr.split(/\s*[,;]\s*/).filter(p => p.trim());
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].trim();
  const firstAuthor = parts[0].trim();
  return `${firstAuthor} et al.`;
}

function cleanHTML(html) {
  if (!html) return '';
  let cleaned = html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
  cleaned = cleaned.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  cleaned = cleaned.replace(/&#x([a-f\d]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/\bCancel Cell\b/gi, 'Cancer Cell');
  return cleaned.trim();
}

// Fetch last-7-days papers from Supabase for landing-page generation.
// One paged scan over papers.published_at >= 7d (~30k rows max), plus
// one bulk sightings .in() to attach source feed + feed_link per paper.
async function fetchRecentPapersForLanding() {
  if (!supabase) return [];
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const PAGE = 2000;
  let cursorPub = null;
  let cursorId = null;
  const papersAll = [];
  for (;;) {
    let q = supabase
      .from('papers')
      .select('canonical_id, title, abstract, authors, authors_text, published_at, primary_source, primary_link, external_ids, type')
      .gte('published_at', since)
      .order('published_at', { ascending: false })
      .order('canonical_id', { ascending: true })
      .limit(PAGE);
    if (cursorPub) {
      q = q.or(`published_at.lt.${cursorPub},and(published_at.eq.${cursorPub},canonical_id.gt.${cursorId})`);
    }
    const { data, error } = await q;
    if (error) {
      console.warn(`   ⚠️  landing fetch error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    papersAll.push(...data);
    if (data.length < PAGE) break;
    const last = data[data.length - 1];
    cursorPub = last.published_at;
    cursorId = last.canonical_id;
  }

  // Attach one sighting per paper for journalId / link.
  const ids = papersAll.map(p => p.canonical_id);
  const sightingByPaper = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from('sightings')
      .select('paper_id, source_feed, legacy_entry_id, feed_link')
      .in('paper_id', batch);
    if (error) continue;
    for (const s of data || []) {
      if (!sightingByPaper.has(s.paper_id)) sightingByPaper.set(s.paper_id, s);
    }
  }

  const articles = [];
  for (const p of papersAll) {
    const s = sightingByPaper.get(p.canonical_id) || {};
    const ext = p.external_ids || {};
    articles.push({
      id: s.legacy_entry_id || p.canonical_id,
      canonicalId: p.canonical_id,
      title: p.title,
      abstract: p.abstract || '',
      authors: p.authors_text || (Array.isArray(p.authors)
        ? p.authors.map(a => typeof a === 'string' ? a : a?.name || '').filter(Boolean).join(', ')
        : ''),
      published: p.published_at,
      doi: typeof ext.doi === 'string' ? ext.doi : undefined,
      arxivId: typeof ext.arxiv_id === 'string' ? ext.arxiv_id : undefined,
      journalId: s.source_feed,
      journal: p.primary_source || s.source_feed,
      link: s.feed_link || p.primary_link || '',
      type: p.type || undefined,
    });
  }
  return articles;
}

async function generateLandingPage(allArticles) {
  try {
    const startTime = Date.now();

    // If the caller passes no entries (per-batch dedup default), fetch
    // last-7-days papers live from Supabase. Otherwise honour what was
    // passed (back-compat for the legacy bulk-loader path).
    if (!allArticles || allArticles.length === 0) {
      console.log('   Fetching last-7-days papers from Supabase for landing page...');
      allArticles = await fetchRecentPapersForLanding();
      console.log(`   ${allArticles.length.toLocaleString()} candidate articles loaded`);
    }

    const catalogPath = join(__dirname, '../public/data/catalog.json');
    const outputPath = join(__dirname, '../public/data/landing-page.json');

    // Load catalog
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    // Build set of journal IDs from popular-science discipline
    const popularScienceJournalIds = new Set();
    const popularScienceDiscipline = catalog.disciplines.find((d) => d.id === 'popular-science');
    if (popularScienceDiscipline) {
      popularScienceDiscipline.journals.forEach((journal) => {
        popularScienceJournalIds.add(journal.id);
      });
    }

    // Build map of journalId to logo and publisher
    const logoMap = {};
    const publisherMap = {}; // journalId -> publisher name
    catalog.disciplines.forEach((discipline) => {
      discipline.journals.forEach((journal) => {
        logoMap[journal.id] = journal.logo;
        publisherMap[journal.id] = journal.publisher || 'Unknown';
      });
    });

    // Filter articles to only those published in the last 7 days
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const sevenDaysAgoTime = sevenDaysAgo.getTime();
    const nowTime = now.getTime();

    // Process articles (already sorted newest first)
    // We want ONE article per journal, and MAX 2 articles per publisher for diversity
    const selectedArticles = [];
    const usedJournalIds = new Set();
    const publisherCount = {}; // publisher -> count of articles selected
    const maxArticles = 100;
    const maxPerPublisher = 2; // Limit articles per publisher for diversity

    // Helper to check if title is a real article
    const isRealArticle = (title) => {
      if (!title) return false;
      const lower = title.toLowerCase();
      const badPatterns = [
        'table of contents', 'issue information', 'cover image', 'front cover',
        'back cover', 'issue highlights', 'this issue', 'in this issue',
        'editorial board', 'masthead'
      ];
      if (lower === 'editorial' || lower === 'contents') return false;
      return !badPatterns.some(p => lower.includes(p));
    };

    console.log('   Stats: processing articles...');

    for (let i = 0; i < allArticles.length; i++) {
      if (selectedArticles.length >= maxArticles) break;

      const article = allArticles[i];
      if (!article || !article.title || !article.link || !article.journalId || !article.published) continue;

      // Skip if we already have an article from this journal
      if (usedJournalIds.has(article.journalId)) continue;

      // Skip articles from popular-science category
      if (popularScienceJournalIds.has(article.journalId)) continue;

      // Skip non-articles
      if (!isRealArticle(article.title)) continue;

      // Check publisher limit for diversity
      const publisher = publisherMap[article.journalId] || 'Unknown';
      if ((publisherCount[publisher] || 0) >= maxPerPublisher) continue;

      const publishedTime = new Date(article.published).getTime();

      // Skip articles older than 7 days, but don't break - keep scanning for diversity
      if (publishedTime < sevenDaysAgoTime) {
        continue;
      }

      if (publishedTime <= nowTime) {
        // Found a candidate!
        selectedArticles.push(article);
        usedJournalIds.add(article.journalId);
        publisherCount[publisher] = (publisherCount[publisher] || 0) + 1;
      }
    }

    // Log publisher distribution
    const publisherStats = Object.entries(publisherCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`   ✓ Selected ${selectedArticles.length} articles from ${usedJournalIds.size} unique journals (last 7 days)`);
    console.log(`   ✓ Publisher distribution (top 10): ${publisherStats.map(([p, c]) => `${p}:${c}`).join(', ')}`);

    // Shuffle final articles for random order on display
    for (let i = selectedArticles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selectedArticles[i], selectedArticles[j]] = [selectedArticles[j], selectedArticles[i]];
    }

    // Map to display format
    const displayArticles = selectedArticles.map(article => {
      let domain = '';
      try {
        const url = new URL(article.link);
        domain = url.hostname.replace('www.', '');
      } catch (e) {
        domain = 'scholar.google.com';
      }

      let logo = logoMap[article.journalId];
      const isValidLogo = logo && logo.trim() !== '' && logo !== 'undefined' && logo !== 'null' && logo.startsWith('http');

      if (!isValidLogo) {
        if (article.journalId && article.journalId.includes('biorxiv')) {
          logo = 'https://www.google.com/s2/favicons?domain=biorxiv.org&sz=64';
        } else {
          logo = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        }
      } else if (logo.includes('biorxiv') && logo.includes('connect')) {
        logo = 'https://www.google.com/s2/favicons?domain=biorxiv.org&sz=64';
      }

      return {
        title: cleanHTML(article.title),
        journal: cleanHTML(article.journal),
        authors: formatAuthorsSimple(article.authors),
        logo: logo,
        link: article.link
      };
    });

    const landingData = {
      articles: displayArticles,
      journalCount: usedJournalIds.size // This is just the count of journals in the landing page, not total journals system-wide
    };

    writeFileSync(outputPath, JSON.stringify(landingData, null, 2));

  } catch (error) {
    console.error('❌ Failed to generate landing page data:', error?.message || error);
    // Non-fatal, continue
  }
}

/**
 * Clean up old articles from Supabase article_embeddings table
 * Keeps only articles from the last 30 days to control storage costs
 * IMPORTANT: Preserves embeddings for starred articles (needed for user profiles)
 * Full article history is preserved in the journal JSON files
 */
async function cleanupOldEmbeddings() {
  if (!supabase) {
    console.log('⏭️  Skipping cleanup (no Supabase connection)');
    return;
  }

  console.log('🧹 Cleaning up old embeddings from Supabase...');

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoffDate = thirtyDaysAgo.toISOString();

  try {
    // Step 1: Get all starred article IDs across all users
    const { data: userStates } = await supabase
      .from('user_state')
      .select('starred');

    const starredIds = new Set();
    for (const state of userStates || []) {
      for (const id of state.starred || []) {
        starredIds.add(id);
      }
    }
    console.log(`   📌 Preserving ${starredIds.size} starred articles`);

    // Step 2: Get old articles that are NOT starred
    const { data: oldArticles } = await supabase
      .from('article_embeddings')
      .select('article_id')
      .lt('published', cutoffDate);

    const toDelete = (oldArticles || [])
      .filter(a => !starredIds.has(a.article_id))
      .map(a => a.article_id);

    if (toDelete.length === 0) {
      console.log('   ✅ No old non-starred articles to remove');
      return;
    }

    // Step 3: Delete in batches (Supabase has limits)
    const BATCH_SIZE = 500;
    let deletedTotal = 0;

    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('article_embeddings')
        .delete()
        .in('article_id', batch);

      if (error) {
        console.error('   ⚠️  Cleanup batch error:', error.message);
      } else {
        deletedTotal += batch.length;
      }
    }

    console.log(`   ✅ Removed ${deletedTotal} old articles (preserved ${starredIds.size} starred)`);
  } catch (err) {
    console.error('   ⚠️  Cleanup failed:', err.message);
  }
}

main()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
