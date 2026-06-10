/**
 * TL;DR API — generates a 2-sentence paper summary on-demand and caches
 * forever in papers.tldr.
 *
 * Auth required (prevents random abuse). LLM is GPT-4o-mini for cost
 * discipline (~$0.0001 per generation).
 *
 * Pattern lifted from rxiv (api/tldr.py): cache hit returns immediately,
 * cache miss generates via OpenAI and stores. The frontend calls this
 * lazily — only when a user clicks the TL;DR button on a card.
 *
 * POST /api/tldr  { canonicalId: string }
 *   Returns { tldr: string, cached: boolean } | { error: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { serviceSupabase } from '@/lib/paperFeed';
import { getServerApiKey } from '@/lib/serverApiKeys';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o-mini';
const ABSTRACT_TRUNCATE = 1200;

// Same prompt rxiv uses — well-tuned, two factual sentences, no meta-commentary.
function buildPrompt(title: string, abstract: string): string {
    return (
        `Title: ${title}\n` +
        `Abstract: ${abstract.slice(0, ABSTRACT_TRUNCATE)}\n\n` +
        'Write exactly 2 sentences summarizing this paper.\n' +
        'Sentence 1: What was done and how.\n' +
        'Sentence 2: What was found or achieved.\n\n' +
        'FORMATTING:\n' +
        '- Plain text only. Do NOT use any markdown: no bold, no italics, no ** or * markers.\n\n' +
        'ABSOLUTE RULES:\n' +
        '- Your output must be EXACTLY 2 factual sentences. Nothing else.\n' +
        '- NEVER write meta-commentary like "the abstract does not contain" or "no specific results are mentioned".\n' +
        '- NEVER say "this paper", "the authors", "this study", "we", or "the abstract".\n' +
        '- If the abstract is short, infer what you can from the title and abstract combined.\n' +
        '- Both sentences must describe the WORK, not describe the abstract.\n' +
        'Output the 2 sentences only.'
    );
}

async function callOpenAI(prompt: string, apiKey: string): Promise<string> {
    const res = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 400,
        }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenAI error ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    return text.replace(/^["']|["']$/g, '').trim();
}

export async function POST(request: NextRequest) {
    try {
        // Auth
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json().catch(() => ({}));
        const canonicalId: string = (body.canonicalId || '').trim();
        if (!canonicalId) {
            return NextResponse.json({ error: 'canonicalId required' }, { status: 400 });
        }

        const service = serviceSupabase();

        // 1) Cache hit?
        const { data: existing } = await service
            .from('papers')
            .select('tldr, title, abstract')
            .eq('canonical_id', canonicalId)
            .single();

        if (!existing) {
            return NextResponse.json({ error: 'paper not found' }, { status: 404 });
        }

        if (existing.tldr) {
            return NextResponse.json({ tldr: existing.tldr, cached: true });
        }

        // 2) Need title + abstract to generate.
        if (!existing.title || !existing.abstract || existing.abstract.length < 100) {
            return NextResponse.json(
                { error: 'paper has no abstract — cannot generate TL;DR' },
                { status: 422 },
            );
        }

        // 3) Generate.
        const apiKey = await getServerApiKey('openai');
        if (!apiKey) {
            return NextResponse.json({ error: 'LLM not configured' }, { status: 500 });
        }

        const prompt = buildPrompt(existing.title, existing.abstract);
        const tldr = await callOpenAI(prompt, apiKey);
        if (!tldr) {
            return NextResponse.json({ error: 'empty TL;DR returned' }, { status: 502 });
        }

        // 4) Cache.
        await service
            .from('papers')
            .update({ tldr, tldr_generated_at: new Date().toISOString() })
            .eq('canonical_id', canonicalId);

        return NextResponse.json({ tldr, cached: false });
    } catch (error) {
        console.error('[/api/tldr] error:', error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
