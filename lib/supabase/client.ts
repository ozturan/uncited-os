import { createBrowserClient } from '@supabase/ssr'
import { SINGLE_USER_MODE, LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/localUser'

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  // Return a mock client if credentials are not configured or set to 'mock'
  if (!supabaseUrl || !supabaseKey || supabaseUrl === 'mock' || supabaseKey === 'mock') {
    return createMockClient()
  }
  
  // Additional validation: ensure URL looks valid
  try {
    const url = new URL(supabaseUrl)
    if (!url.protocol.startsWith('http')) {
      // Invalid URL format, use mock client
      return createMockClient()
    }
  } catch {
    // URL parsing failed, use mock client
    return createMockClient()
  }
  
  const client = createBrowserClient(supabaseUrl, supabaseKey)
  if (SINGLE_USER_MODE) {
    // There is no real session in single-user mode, but the storage layer gates
    // every DB write on getUser(). Report the fixed local user so follows, stars,
    // and reads persist to the database (RLS is relaxed for the local anon role).
    const localUser = { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL } as unknown
    client.auth.getUser = (async () => ({ data: { user: localUser }, error: null })) as typeof client.auth.getUser
  }
  return client
}

// Mock client for development without Supabase
function createMockClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
      signUp: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
      signInWithOAuth: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
      resetPasswordForEmail: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: (callback: any) => {
        // Immediately call with no user
        callback('SIGNED_OUT', null)
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: { message: 'Supabase not configured' } }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  } as any
}

