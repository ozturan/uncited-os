/**
 * Scholar API — multi-profile My Field.
 *
 * GET  /api/scholar?q=<name>
 *   Returns up to 10 candidate authors from Semantic Scholar.
 *
 * POST /api/scholar  { authorId, name }
 *   Adds a profile: fetches author's papers, embeds, computes centroid,
 *   generates 8-15 word description, appends to user_state.settings.field_profiles,
 *   recomputes the aggregate field_centroid. Returns the updated profile list.
 *
 * DELETE /api/scholar?authorId=<id>
 *   Removes a profile, recomputes aggregate. Returns updated profile list.
 *   When the last profile is removed, clears all field_* settings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getServerApiKey } from '@/lib/serverApiKeys';
import type { FieldProfile, UserSettings } from '@/lib/types';

const SEMANTIC_SCHOLAR_BASE = 'https://api.semanticscholar.org/graph/v1';
const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 256;
const MAX_PAPERS = 30;

// ── Shared helpers ─────────────────────────────────────────────────────────────

function computeCentroid(embeddings: number[][]): number[] {
    if (embeddings.length === 0) return [];
    const dim = embeddings[0].length;
    const center = new Array(dim).fill(0);
    for (const emb of embeddings) {
        for (let d = 0; d < dim; d++) center[d] += emb[d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
        center[d] /= embeddings.length;
        norm += center[d] * center[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let d = 0; d < dim; d++) center[d] /= norm;
    }
    return center;
}

async function fetchAuthorPapers(authorId: string): Promise<{ title: string; abstract: string; year: number }[]> {
    const url = `${SEMANTIC_SCHOLAR_BASE}/author/${encodeURIComponent(authorId)}/papers?fields=title,abstract,year&limit=100`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const papers: any[] = data.data || [];
    return papers
        .filter(p => p.abstract && p.abstract.trim().length > 50)
        .sort((a, b) => (b.year || 0) - (a.year || 0))
        .slice(0, MAX_PAPERS)
        .map(p => ({ title: p.title || '', abstract: p.abstract, year: p.year || 0 }));
}

// LLM call to summarize a researcher's focus from their paper titles.
// Lifted from rxiv (api/search.py:_describe). 8-15 word phrase.
async function describeResearcher(titles: string[], apiKey: string): Promise<string> {
    const titlesStr = titles.slice(0, 20).join('\n');
    const prompt =
        `Publication titles:\n${titlesStr}\n\n` +
        `Describe this researcher's focus in 8-15 words. Be specific. ` +
        `Example: "genomic biomarkers of immunotherapy response in melanoma"\n` +
        `Return ONLY the phrase.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 40,
        }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    let text: string = data.choices?.[0]?.message?.content?.trim() || '';
    text = text.replace(/^["']|["']$/g, '').trim();
    if (!text) return text;
    // Lowercase first letter unless it's an acronym (matches rxiv's heuristic).
    const firstWord = text.split(/\s+/)[0];
    if (firstWord === firstWord.toUpperCase() && firstWord.length > 1) return text;
    return text[0].toLowerCase() + text.slice(1);
}

async function embedTexts(texts: string[], apiKey: string): Promise<number[][]> {
    const BATCH = 20;
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const res = await fetch(OPENAI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ input: batch, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMS }),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenAI embedding failed: ${res.status} ${err}`);
        }
        const data = await res.json();
        allEmbeddings.push(...(data.data || []).map((d: any) => d.embedding));
    }
    return allEmbeddings;
}

// ── GET /api/scholar?q=<name> — author search ─────────────────────────────────

export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const q = request.nextUrl.searchParams.get('q')?.trim() || '';
        if (q.length < 2) {
            return NextResponse.json({ candidates: [] });
        }

        const url = `${SEMANTIC_SCHOLAR_BASE}/author/search?query=${encodeURIComponent(q)}&fields=name,affiliations,paperCount&limit=10`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            return NextResponse.json({ candidates: [] });
        }

        const data = await res.json();
        const candidates = (data.data || []).map((a: any) => ({
            authorId: a.authorId,
            name: a.name || '',
            affiliation: a.affiliations?.[0]?.name || '',
            paperCount: a.paperCount || 0,
        }));

        return NextResponse.json({ candidates });
    } catch (error) {
        console.error('Scholar search error:', error);
        return NextResponse.json({ candidates: [] });
    }
}

// Compute the aggregate centroid (mean of all profile centroids, L2-normalized).
// Used by the recommendations RPCs as the user's "field" vector.
function aggregateCentroid(profiles: FieldProfile[]): number[] {
    const valid = profiles.filter(p => Array.isArray(p.centroid) && p.centroid.length === EMBEDDING_DIMS);
    if (valid.length === 0) return [];
    const dim = EMBEDDING_DIMS;
    const sum = new Array(dim).fill(0);
    for (const p of valid) {
        for (let d = 0; d < dim; d++) sum[d] += p.centroid[d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d++) {
        sum[d] /= valid.length;
        norm += sum[d] * sum[d];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < dim; d++) sum[d] /= norm;
    return sum;
}

// Build a settings update payload from a profiles list. Empty list clears all
// field_* keys; non-empty list sets the aggregate as the union over profiles.
function buildSettingsPatch(currentSettings: UserSettings | undefined, profiles: FieldProfile[]): Partial<UserSettings> {
    const base = { ...(currentSettings || {}) };
    if (profiles.length === 0) {
        delete base.field_centroid;
        delete base.field_centroid_count;
        delete base.field_centroid_updated_at;
        delete base.field_description;
        delete base.field_profiles;
        return base;
    }
    const agg = aggregateCentroid(profiles);
    const totalCount = profiles.reduce((s, p) => s + (p.count || 0), 0);
    return {
        ...base,
        field_centroid: agg,
        field_centroid_count: totalCount,
        field_centroid_updated_at: new Date().toISOString(),
        field_profiles: profiles,
        field_description: profiles[0]?.description, // legacy fallback — first profile's blurb
    };
}

// ── POST /api/scholar  { authorId, name } — add a profile ─────────────────────

export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient();

        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { authorId, name } = body as { authorId?: string; name?: string };

        if (!authorId || typeof authorId !== 'string' || authorId.trim().length === 0) {
            return NextResponse.json({ error: 'authorId is required' }, { status: 400 });
        }

        const openaiKey = await getServerApiKey('openai');
        if (!openaiKey) {
            return NextResponse.json({ error: 'Server configuration error: OpenAI API key missing' }, { status: 500 });
        }

        // Read existing profiles up front so we can deduplicate by authorId.
        const { data: userStateRow, error: readErr } = await supabase
            .from('user_state')
            .select('settings')
            .eq('user_id', user.id)
            .single();
        // Anti-wipe: PGRST116 = no row yet (fine for a new user). Any OTHER read
        // error means we can't trust `settings`; refuse to write rather than
        // overwrite the whole settings column (keywords, prefs) with an empty
        // default — the failure mode that wiped data on 2026-06-09.
        if (readErr && readErr.code !== 'PGRST116') {
            console.error('scholar: settings read failed, refusing to overwrite settings:', readErr);
            return NextResponse.json({ error: 'Could not load your profile right now. Please try again.' }, { status: 503 });
        }
        const settings: UserSettings = (userStateRow?.settings as UserSettings) || ({} as UserSettings);
        const existingProfiles: FieldProfile[] = Array.isArray(settings.field_profiles) ? settings.field_profiles : [];

        if (existingProfiles.some(p => p.authorId === authorId.trim())) {
            return NextResponse.json({ error: 'This researcher is already in your profile.' }, { status: 409 });
        }

        // Fetch + embed
        const papers = await fetchAuthorPapers(authorId.trim());
        if (papers.length === 0) {
            return NextResponse.json(
                { error: 'No papers with abstracts found for this author on Semantic Scholar.' },
                { status: 422 }
            );
        }

        let embeddings: number[][];
        try {
            embeddings = await embedTexts(papers.map(p => `${p.title}. ${p.abstract}`), openaiKey);
        } catch (err) {
            console.error('OpenAI embedding error:', err);
            return NextResponse.json({ error: 'Failed to process publications. Please try again.' }, { status: 500 });
        }
        if (embeddings.length === 0) {
            return NextResponse.json({ error: 'Embedding failed. Please try again.' }, { status: 500 });
        }

        const profileCentroid = computeCentroid(embeddings);
        if (profileCentroid.length !== EMBEDDING_DIMS) {
            return NextResponse.json({ error: 'Failed to compute profile centroid.' }, { status: 500 });
        }

        // Description (best-effort).
        let description = '';
        try {
            description = await describeResearcher(papers.map(p => p.title), openaiKey);
        } catch (err) {
            console.warn('describeResearcher failed:', err);
        }

        const newProfile: FieldProfile = {
            authorId: authorId.trim(),
            name: (name || '').trim() || 'Researcher',
            count: papers.length,
            description: description || undefined,
            addedAt: new Date().toISOString(),
            centroid: profileCentroid,
        };

        const updatedProfiles = [...existingProfiles, newProfile];
        const patch = buildSettingsPatch(settings, updatedProfiles);

        const { error: saveError } = await supabase
            .from('user_state')
            .upsert({ user_id: user.id, settings: patch }, { onConflict: 'user_id' });
        if (saveError) {
            console.error('Failed to save profile:', saveError);
            return NextResponse.json({ error: 'Failed to save research profile.' }, { status: 500 });
        }

        return NextResponse.json({
            profile: newProfile,
            profiles: updatedProfiles,
            field_centroid: patch.field_centroid,
            field_centroid_count: patch.field_centroid_count,
        });
    } catch (error) {
        console.error('Scholar API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// ── DELETE /api/scholar?authorId=<id> — remove a profile ──────────────────────

export async function DELETE(request: NextRequest) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const authorId = request.nextUrl.searchParams.get('authorId')?.trim() || '';
        const removeAll = request.nextUrl.searchParams.get('all') === '1';

        const { data: userStateRow, error: readErr } = await supabase
            .from('user_state')
            .select('settings')
            .eq('user_id', user.id)
            .single();
        // Anti-wipe: PGRST116 = no row yet (fine for a new user). Any OTHER read
        // error means we can't trust `settings`; refuse to write rather than
        // overwrite the whole settings column (keywords, prefs) with an empty
        // default — the failure mode that wiped data on 2026-06-09.
        if (readErr && readErr.code !== 'PGRST116') {
            console.error('scholar: settings read failed, refusing to overwrite settings:', readErr);
            return NextResponse.json({ error: 'Could not load your profile right now. Please try again.' }, { status: 503 });
        }
        const settings: UserSettings = (userStateRow?.settings as UserSettings) || ({} as UserSettings);
        const existingProfiles: FieldProfile[] = Array.isArray(settings.field_profiles) ? settings.field_profiles : [];

        const updated = removeAll
            ? []
            : existingProfiles.filter(p => p.authorId !== authorId);

        if (!removeAll && updated.length === existingProfiles.length) {
            return NextResponse.json({ error: 'profile not found' }, { status: 404 });
        }

        const patch = buildSettingsPatch(settings, updated);
        const { error: saveError } = await supabase
            .from('user_state')
            .upsert({ user_id: user.id, settings: patch }, { onConflict: 'user_id' });
        if (saveError) {
            console.error('Failed to remove profile:', saveError);
            return NextResponse.json({ error: 'Failed to update research profile.' }, { status: 500 });
        }

        return NextResponse.json({
            profiles: updated,
            field_centroid: patch.field_centroid ?? null,
            field_centroid_count: patch.field_centroid_count ?? 0,
        });
    } catch (error) {
        console.error('Scholar DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
