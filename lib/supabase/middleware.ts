import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  // Skip middleware if Supabase is not configured (dev mode)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  if (!supabaseUrl || !supabaseKey || supabaseUrl === 'mock' || supabaseKey === 'mock') {
    return supabaseResponse
  }
  
  // Additional validation: ensure URL looks valid (starts with http:// or https://)
  try {
    const url = new URL(supabaseUrl)
    if (!url.protocol.startsWith('http')) {
      // Invalid URL format, skip Supabase
      return supabaseResponse
    }
  } catch {
    // URL parsing failed, skip Supabase
    return supabaseResponse
  }

  // Wrap the entire Supabase client creation and usage in try-catch
  // This prevents any errors from crashing the middleware
  try {
    const supabase = createServerClient(
      supabaseUrl,
      supabaseKey,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
            supabaseResponse = NextResponse.next({
              request,
            })
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    // IMPORTANT: Avoid writing any logic between createServerClient and
    // supabase.auth.getUser(). A simple mistake could make it very hard to debug
    // issues with users being randomly logged out.

    // Wrap getUser with timeout to prevent hanging
    // Use Promise.race with a timeout to prevent hanging requests
    const getUserPromise = supabase.auth.getUser()
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Supabase auth timeout')), 2000)
    )
    
    await Promise.race([getUserPromise, timeoutPromise]).catch((error) => {
      // Silently ignore timeout and other errors
      if (process.env.NODE_ENV === 'development') {
        console.warn('Supabase auth error in middleware (non-fatal):', error instanceof Error ? error.message : String(error))
      }
    })
  } catch (error) {
    // Catch any errors during client creation or auth
    // Log in development but continue without Supabase
    if (process.env.NODE_ENV === 'development') {
      console.warn('Supabase middleware error (non-fatal):', error instanceof Error ? error.message : String(error))
    }
    // Return the response anyway - app works without Supabase
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is. If you're
  // creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely.

  return supabaseResponse
}

