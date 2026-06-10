import { createClient as createServiceClient } from '@supabase/supabase-js';
import { LOCAL_USER_ID } from '@/lib/localUser';

// Resolve an API key for server-side use. Environment variables win; otherwise
// fall back to the key the local user saved in Settings -> Setup
// (user_state.settings.apiKeys). This is how a self-hoster enables embeddings
// and summaries by pasting a key into the UI instead of editing env files.
export async function getServerApiKey(
  name: 'openai' | 'anthropic',
): Promise<string | undefined> {
  const envKey =
    name === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (envKey) return envKey;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || url === 'mock' || !serviceKey) return undefined;

  try {
    const svc = createServiceClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    const { data } = await svc
      .from('user_state')
      .select('settings')
      .eq('user_id', LOCAL_USER_ID)
      .maybeSingle();
    const settings = (data?.settings ?? {}) as { apiKeys?: Record<string, string> };
    const k = settings.apiKeys?.[name];
    return typeof k === 'string' && k.trim() ? k.trim() : undefined;
  } catch {
    return undefined;
  }
}
