import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { SINGLE_USER_MODE, LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/localUser'

export async function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Single-user local mode: no auth. Serve every request with a service-role
  // client (bypasses RLS) and report a fixed local user, so the getUser()-based
  // API routes all resolve the same implicit account without anyone logging in.
  if (SINGLE_USER_MODE) {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && supabaseUrl !== 'mock' && serviceKey) {
      const svc = createServiceClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      svc.auth.getUser = (async () => ({
        data: { user: { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL } },
        error: null,
      })) as typeof svc.auth.getUser
      return svc
    }
  }

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

  const cookieStore = await cookies()

  return createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

// Mock client for development without Supabase
function createMockClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
        }),
      }),
      upsert: async () => ({ error: null }),
    }),
  } as any
}

