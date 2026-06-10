/**
 * Shared affiliation resolver — the single source of truth for the author entity
 * shown on a card: "First et al. · Last Lab · Institution" + logo + url.
 *
 * SERVER-ONLY (fetches publisher HTML and external APIs). Called by:
 *   - app/api/affiliation/route.ts        — on-demand resolution for the live UI
 *   - lib/affiliationServerCache.ts        — warm cache that attaches to the feed payload
 *
 * Strategy (validated against 100 journals + fresh/aged samples):
 *   Crossref (authors always; affiliation for some publishers)
 *     → publisher landing-page citation_* meta (Springer/Nature/Wiley/OUP/MDPI…)
 *     → OpenAlex work (authors + institution once indexed; authoritative as papers age)
 *     → author-level OpenAlex lookup, COAUTHOR-VERIFIED (fresh-paper institution; provisional)
 *     → OpenAlex /institutions (institution name → homepage → favicon)
 *
 * `confidence` lets the scheduled re-resolution overwrite a provisional author-lookup
 * guess with the authoritative paper-level answer once it exists.
 */

const MAILTO = process.env.CROSSREF_MAILTO || 'mail@uncited.org';
const UA = `Uncited RSS Reader (mailto:${MAILTO})`;

export interface ResolvedAffiliation {
    firstAuthorName: string;
    firstAuthorLastName: string;
    lastAuthorName: string;
    lastAuthorLastName: string;
    authorCount: number;
    isMultiAuthor: boolean;
    institutionName: string;
    institutionUrl: string;
    institutionLogo: string;
    source: 'crossref' | 'landing' | 'openalex' | 'author-lookup' | 'none';
    confidence: 'high' | 'provisional' | 'none';
}

// ── external API response shapes (only the fields we read) ─────────────────────

interface CrossrefAffiliation { name?: string }
interface CrossrefAuthor { given?: string; family?: string; name?: string; affiliation?: CrossrefAffiliation[] }
interface CrossrefMessage { DOI?: string; title?: string[]; author?: CrossrefAuthor[] }
interface CrossrefByDoi { message?: CrossrefMessage }
interface CrossrefByQuery { message?: { items?: CrossrefMessage[] } }

interface OAInstitution { id?: string; display_name?: string; homepage_url?: string }
interface OAAuthorship { author?: { display_name?: string }; institutions?: OAInstitution[] }
interface OAWork { title?: string; authorships?: OAAuthorship[]; publication_year?: number }
interface OAWorksResponse { results?: OAWork[] }
interface OAAuthor { id?: string; display_name?: string; last_known_institutions?: OAInstitution[]; works_count?: number }
interface OAAuthorsResponse { results?: OAAuthor[] }
interface OAInstitutionsResponse { results?: OAInstitution[] }

// ── small helpers ────────────────────────────────────────────────────────────

export function deriveDoi(doi?: string | null, arxivId?: string | null): string | null {
    if (doi) return doi.replace(/^https?:\/\/doi\.org\//, '').replace(/[?#].*$/, '').trim();
    if (arxivId) return `10.48550/arXiv.${arxivId}`;
    return null;
}

function surnameOf(name: string): string {
    const p = (name || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
    return p.length ? p[p.length - 1].toLowerCase() : '';
}

/** normalized coauthor key: first-initial + surname (e.g. "Jane Smith" → "j smith").
 *  Collides far less than surname alone, which is what makes verification trustworthy. */
function nameKey(name: string): string {
    const p = (name || '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '';
    const last = p[p.length - 1].toLowerCase();
    const firstInit = p.length > 1 ? p[0][0].toLowerCase() : '';
    return `${firstInit} ${last}`.trim();
}

function tokenize(s: string): Set<string> {
    return new Set(
        (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
            .split(' ').filter(w => w.length >= 5),
    );
}
function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size && !b.size) return 1;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    const u = a.size + b.size - inter;
    return u ? inter / u : 0;
}

const INST_KEYWORDS = ['universit', 'institut', 'hospital', 'académie', 'academ', 'college',
    'centre', 'center', 'school', 'foundation', 'clinic', 'laborator', 'polytechnic'];

/** Crossref affiliation strings are messy ("Lab of X, Y University, City, Country").
 *  Pull the highest-priority institution-bearing comma segment. */
function pickInstitution(aff: string): string {
    if (!aff) return '';
    const segs = aff.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    let best = '', rank = INST_KEYWORDS.length;
    for (const s of segs) {
        const low = s.toLowerCase();
        for (let i = 0; i < INST_KEYWORDS.length; i++) {
            if (low.includes(INST_KEYWORDS[i]) && i < rank) { best = s; rank = i; }
        }
    }
    return best || (segs.find(s => s.length > 3) || '');
}

// Bound every external call so one slow/hung request can't dominate the resolution.
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const t = AbortSignal.timeout(ms);
    if (!signal) return t;
    try { return AbortSignal.any([signal, t]); } catch { return t; }
}

async function getJSON<T>(url: string, signal?: AbortSignal, timeoutMs = 6000): Promise<T | null> {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: withTimeout(signal, timeoutMs) });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch { return null; }
}

// ── source 1: Crossref (authors + sometimes affiliation) ──────────────────────

async function crossrefWork(
    doi: string | null, title: string | null, signal?: AbortSignal,
): Promise<{ doi: string | null; authors: CrossrefAuthor[] } | null> {
    let msg: CrossrefMessage | null = null;
    if (doi) {
        const d = await getJSON<CrossrefByDoi>(`https://api.crossref.org/works/${encodeURIComponent(doi).replace(/%2F/gi, '/')}?mailto=${MAILTO}`, signal);
        if (d?.message) msg = d.message;
    }
    if (!msg && title && title.trim().length > 8) {
        const d = await getJSON<CrossrefByQuery>(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title.slice(0, 180))}&rows=5&select=DOI,title,author&mailto=${MAILTO}`, signal);
        const want = tokenize(title);
        const bad = ['10.2139', '10.20944', '10.21203']; // SSRN / Preprints.org / Research Square mirrors
        for (const it of (d?.message?.items || [])) {
            const t = it.title?.[0] || '';
            if (jaccard(want, tokenize(t)) >= 0.6 && !bad.some(b => (it.DOI || '').startsWith(b))) { msg = it; break; }
        }
    }
    if (!msg) return null;
    return { doi: msg.DOI || doi, authors: msg.author || [] };
}

// ── source 2: publisher landing page (Google Scholar citation_* meta tags) ─────

function decodeEntities(s: string): string {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

async function landingPageInstitution(doi: string, signal?: AbortSignal): Promise<string> {
    try {
        const res = await fetch(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
            },
            // Publisher pages are the slowest, flakiest source — cap tightly.
            signal: withTimeout(signal, 3500),
        });
        if (!res.ok) return '';
        const html = await res.text();
        const metas: [string, string][] = [];
        for (const tag of html.match(/<meta[^>]+>/gi) || []) {
            const nm = tag.match(/name=["']([^"']+)["']/i);
            const ct = tag.match(/content=["']([^"']*)["']/i);
            if (nm && ct) metas.push([nm[1].toLowerCase(), decodeEntities(ct[1].trim())]);
        }
        // interleaved citation_author / citation_author_institution → map last author's institution
        let cur: string | null = null;
        const byAuthor: Record<string, string[]> = {};
        const names: string[] = [];
        for (const [n, c] of metas) {
            if (n === 'citation_author') { cur = c; names.push(c); byAuthor[c] = byAuthor[c] || []; }
            else if ((n === 'citation_author_institution' || n === 'citation_author_affiliation') && cur) byAuthor[cur].push(c);
        }
        if (names.length && byAuthor[names[names.length - 1]]?.length) return byAuthor[names[names.length - 1]][0];
        const flat = metas.filter(([n]) => n === 'citation_author_institution' || n === 'citation_author_affiliation');
        return flat.length ? flat[flat.length - 1][1] : '';
    } catch { return ''; }
}

// ── source 3: OpenAlex work (authoritative once indexed) ───────────────────────

async function openAlexWork(doi: string | null, title: string | null, year: number | null, surnames: string[], signal?: AbortSignal): Promise<OAWork | null> {
    if (doi) {
        const d = await getJSON<OAWork>(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=authorships,title,publication_year&mailto=${MAILTO}`, signal);
        if (d?.authorships?.length) return d;
    }
    if (!title || title.trim().length <= 8) return null;
    const cleaned = title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const d = await getJSON<OAWorksResponse>(`https://api.openalex.org/works?search=${encodeURIComponent(cleaned)}&per_page=5&select=title,authorships,publication_year&mailto=${MAILTO}`, signal);
    const want = tokenize(cleaned);
    let best: OAWork | null = null, bs = -1;
    for (const w of (d?.results || [])) {
        if (year && w.publication_year && Math.abs(w.publication_year - year) > 1) continue;
        const sim = jaccard(want, tokenize(w.title || ''));
        if (sim < 0.6) continue;
        let bonus = 0;
        if (surnames.length) {
            const got = (w.authorships || []).map(a => surnameOf(a.author?.display_name || ''));
            const m = surnames.filter(s => got.includes(s));
            if (!m.length) continue;
            bonus = Math.min(0.3, m.length * 0.1);
        }
        if (sim + bonus > bs) { bs = sim + bonus; best = w; }
    }
    return best;
}

// ── source 4: author-level lookup, coauthor-verified (fresh papers; provisional) ─

async function authorLevelInstitution(fullName: string, paperCoauthorKeys: Set<string>, signal?: AbortSignal): Promise<string> {
    if (!fullName || fullName.trim().split(/\s+/).length < 2) return '';
    const want = surnameOf(fullName);
    const d = await getJSON<OAAuthorsResponse>(`https://api.openalex.org/authors?search=${encodeURIComponent(fullName)}&per_page=5&select=id,display_name,last_known_institutions,works_count&mailto=${MAILTO}`, signal);
    const cands = (d?.results || [])
        .filter(a => surnameOf(a.display_name || '') === want && (a.last_known_institutions || []).length > 0)
        .sort((a, b) => (b.works_count || 0) - (a.works_count || 0))
        .slice(0, 3);
    // Fetch each candidate's recent works in PARALLEL (was sequential — the slowest
    // part of the whole resolver), then verify in candidate (works-count) order.
    const works = await Promise.all(cands.map(a => {
        const aid = (a.id || '').split('/').pop();
        return aid
            ? getJSON<{ results?: { authorships?: OAAuthorship[] }[] }>(`https://api.openalex.org/works?filter=author.id:${aid}&per_page=20&select=authorships&mailto=${MAILTO}`, signal)
            : Promise.resolve(null);
    }));
    for (let i = 0; i < cands.length; i++) {
        // require a coauthor (first-initial+surname) overlap with this paper → same research group
        const co = new Set<string>();
        for (const wk of (works[i]?.results || []))
            for (const au of (wk.authorships || [])) co.add(nameKey(au.author?.display_name || ''));
        let overlap = 0;
        for (const k of paperCoauthorKeys) if (k && co.has(k)) overlap++;
        if (overlap >= 1) return cands[i].last_known_institutions?.[0]?.display_name || '';
    }
    return '';
}

// ── source 5: institution name → homepage + favicon ────────────────────────────

const instCache = new Map<string, { name: string; url: string }>();
async function resolveInstitution(name: string, signal?: AbortSignal): Promise<{ name: string; url: string; logo: string }> {
    if (!name) return { name: '', url: '', logo: '' };
    const key = name.toLowerCase();
    let hit = instCache.get(key);
    if (!hit) {
        const d = await getJSON<OAInstitutionsResponse>(`https://api.openalex.org/institutions?search=${encodeURIComponent(name.slice(0, 120))}&per_page=1&select=display_name,homepage_url&mailto=${MAILTO}`, signal);
        const r = d?.results?.[0];
        hit = { name: r?.display_name || name, url: r?.homepage_url || '' };
        instCache.set(key, hit);
    }
    let logo = '';
    if (hit.url) {
        const domain = hit.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        logo = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    }
    return { name: hit.name, url: hit.url, logo };
}

// ── orchestrator ───────────────────────────────────────────────────────────────

export interface ResolveInput {
    doi?: string | null;
    arxivId?: string | null;
    title?: string | null;
    /** raw RSS author string, used only to disambiguate the title search */
    authors?: string | null;
    year?: number | null;
    /** allow the author-lookup booster (default on) */
    allowAuthorLookup?: boolean;
    signal?: AbortSignal;
}

interface NamePair { first: string; last: string }

export async function resolveAffiliation(input: ResolveInput): Promise<ResolvedAffiliation | null> {
    const lookupDoi = deriveDoi(input.doi, input.arxivId);
    const title = input.title || null;
    const surnames = extractSurnames(input.authors || null);

    // ---- authors (names): Crossref first, then OpenAlex ----
    let authorNames: NamePair[] = [];
    let count = 0;
    let crossrefAffs: CrossrefAffiliation[][] = [];
    let resolvedDoi = lookupDoi;

    const cr = await crossrefWork(lookupDoi, title, input.signal);
    if (cr?.authors?.length) {
        resolvedDoi = cr.doi || lookupDoi;
        count = cr.authors.length;
        authorNames = cr.authors.map(a => ({ first: a.given || '', last: a.family || (a.name ? surnameOf(a.name) : '') }));
        crossrefAffs = cr.authors.map(a => a.affiliation || []);
    }

    let oaWork: OAWork | null = null;
    if (!authorNames.length) {
        oaWork = await openAlexWork(resolvedDoi, title, input.year ?? null, surnames, input.signal);
        if (oaWork?.authorships?.length) {
            count = oaWork.authorships.length;
            authorNames = oaWork.authorships.map(a => splitName(a.author?.display_name || ''));
        }
    }
    if (!authorNames.length) return null;

    const first = authorNames[0];
    const last = authorNames[authorNames.length - 1];

    // ---- institution (waterfall, most-authoritative first) ----
    let instRaw = '', cleanNeeded = false;
    let source: ResolvedAffiliation['source'] = 'none';
    let confidence: ResolvedAffiliation['confidence'] = 'none';

    // 1. Crossref affiliation (last author preferred, else any)
    const lastAff = crossrefAffs[crossrefAffs.length - 1]?.[0]?.name
        || crossrefAffs.find(a => a[0]?.name)?.[0]?.name || '';
    if (lastAff) { instRaw = lastAff; cleanNeeded = true; source = 'crossref'; confidence = 'high'; }

    // 2. publisher landing-page meta
    if (!instRaw && resolvedDoi) {
        const la = await landingPageInstitution(resolvedDoi, input.signal);
        if (la) { instRaw = la; cleanNeeded = true; source = 'landing'; confidence = 'high'; }
    }

    // 3. OpenAlex work institution (authoritative)
    if (!instRaw) {
        if (!oaWork) oaWork = await openAlexWork(resolvedDoi, title, input.year ?? null, surnames, input.signal);
        const aus = oaWork?.authorships;
        if (aus?.length) {
            const insts = aus[aus.length - 1].institutions || aus[0].institutions || [];
            if (insts[0]?.display_name) { instRaw = insts[0].display_name; cleanNeeded = false; source = 'openalex'; confidence = 'high'; }
        }
    }

    // 4. author-level lookup, coauthor-verified (fresh papers only; provisional)
    if (!instRaw && input.allowAuthorLookup !== false) {
        const lastFull = `${last.first} ${last.last}`.trim();
        const coKeys = new Set(authorNames.slice(0, -1).map(a => nameKey(`${a.first} ${a.last}`)));
        const ai = await authorLevelInstitution(lastFull, coKeys, input.signal);
        if (ai) { instRaw = ai; cleanNeeded = false; source = 'author-lookup'; confidence = 'provisional'; }
    }

    let inst = { name: '', url: '', logo: '' };
    if (instRaw) {
        const cand = cleanNeeded ? pickInstitution(instRaw) : instRaw;
        if (cand) inst = await resolveInstitution(cand, input.signal);
    }

    return {
        firstAuthorName: `${first.first} ${first.last}`.trim(),
        firstAuthorLastName: first.last,
        lastAuthorName: `${last.first} ${last.last}`.trim(),
        lastAuthorLastName: last.last,
        authorCount: count,
        isMultiAuthor: count > 1,
        institutionName: inst.name,
        institutionUrl: inst.url,
        institutionLogo: inst.logo,
        source: inst.name ? source : 'none',
        confidence: inst.name ? confidence : 'none',
    };
}

function splitName(display: string): NamePair {
    const p = (display || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return { first: '', last: '' };
    if (p.length === 1) return { first: '', last: p[0] };
    return { first: p.slice(0, -1).join(' '), last: p[p.length - 1] };
}

export function extractSurnames(raw: string | null): string[] {
    if (!raw) return [];
    const cleaned = raw.replace(/\s+et\s+al\.?\s*$/i, '').trim();
    if (!cleaned) return [];
    return cleaned.split(/\s*,\s*|\s+&\s+|\s+and\s+/i)
        .map(s => surnameOf(s)).filter(s => s.length >= 2);
}
