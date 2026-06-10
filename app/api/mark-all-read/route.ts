import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { serviceSupabase } from '@/lib/paperFeed';

export const runtime = 'nodejs';

// Bulk mark-as-read endpoint. The client previously called
// supabase.from('reads').upsert(...) directly with anon credentials,
// but the round-trip silently failed in some setups (likely a stale
// auth token / cookie mismatch on production). Routing through the
// server with auth-from-cookie + service-role write bypasses all of
// that and surfaces real errors in Vercel logs.
export async function POST(req: Request) {
  let body: { entryIds?: string[]; alsoUnstar?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Dedupe — Postgres rejects ON CONFLICT batches with duplicate keys
  // ("cannot affect row a second time"). Sightings of the same paper
  // across multiple feeds share canonical_id but produce distinct
  // legacy_entry_ids, so duplicates are rare but happen.
  const entryIds = Array.isArray(body.entryIds)
    ? Array.from(new Set(body.entryIds.filter(x => typeof x === 'string')))
    : [];
  const alsoUnstar = !!body.alsoUnstar;
  if (entryIds.length === 0) {
    return NextResponse.json({ inserted: 0 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const admin = serviceSupabase();
  const timestamp = new Date().toISOString();
  const rows = entryIds.map(entry_id => ({
    user_id: user.id,
    entry_id,
    created_at: timestamp,
  }));

  const { error: readsErr } = await admin
    .from('reads')
    .upsert(rows, { onConflict: 'user_id,entry_id' });
  if (readsErr) {
    console.error('[mark-all-read] reads upsert failed', readsErr);
    return NextResponse.json({ error: readsErr.message }, { status: 500 });
  }

  if (alsoUnstar) {
    const { error: starsErr } = await admin
      .from('stars')
      .delete()
      .eq('user_id', user.id)
      .in('entry_id', entryIds);
    if (starsErr) {
      console.error('[mark-all-read] stars delete failed', starsErr);
      return NextResponse.json({ error: starsErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ inserted: rows.length });
}
