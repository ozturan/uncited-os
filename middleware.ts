import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Simple in-memory sliding window rate limiter
// Key: IP address, Value: array of request timestamps
const rateLimitMap = new Map<string, number[]>()
const RATE_LIMIT_MAX = 10        // max requests
const RATE_LIMIT_WINDOW = 60_000 // 1 minute in ms
// Bound the Map so a long-lived instance with many unique IPs doesn't
// grow unboundedly. Once we hit this, sweep expired entries, and if still
// over, drop the oldest — LRU-ish behavior without a real LRU.
const RATE_LIMIT_MAX_KEYS = 5_000
let lastRateLimitSweep = Date.now()
const RATE_LIMIT_SWEEP_INTERVAL = 5 * 60_000 // 5 min

function getRateLimitedIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  return (request as any).ip ?? 'unknown'
}

function sweepRateLimitMap(now: number) {
  const windowStart = now - RATE_LIMIT_WINDOW
  for (const [ip, ts] of rateLimitMap) {
    const recent = ts.filter(t => t > windowStart)
    if (recent.length === 0) rateLimitMap.delete(ip)
    else if (recent.length !== ts.length) rateLimitMap.set(ip, recent)
  }
  // Hard cap: if still too big, drop the lowest-traffic entries.
  if (rateLimitMap.size > RATE_LIMIT_MAX_KEYS) {
    const excess = rateLimitMap.size - RATE_LIMIT_MAX_KEYS
    const keys = rateLimitMap.keys()
    for (let i = 0; i < excess; i++) rateLimitMap.delete(keys.next().value!)
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  if (now - lastRateLimitSweep > RATE_LIMIT_SWEEP_INTERVAL) {
    sweepRateLimitMap(now)
    lastRateLimitSweep = now
  }
  const windowStart = now - RATE_LIMIT_WINDOW
  const timestamps = rateLimitMap.get(ip) ?? []

  // Remove timestamps outside the current window
  const recent = timestamps.filter(t => t > windowStart)

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent)
    return false // exceeded
  }

  recent.push(now)
  rateLimitMap.set(ip, recent)
  return true // allowed
}

// Rate limiting disabled: uncited-os is a local single-user app, no abuse to limit.
const RATE_LIMITED_PATHS: string[] = []

const MAINTENANCE_MODE = process.env.NEXT_PUBLIC_MAINTENANCE_MODE === 'true'

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>uncited — maintenance</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0a; color: #e5e5e5;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
  }
  main { max-width: 480px; padding: 2rem; text-align: center; }
  h1 { font-size: 1.75rem; margin: 0 0 1rem; font-weight: 600; letter-spacing: -0.02em; }
  p  { font-size: 1rem; line-height: 1.6; color: #a3a3a3; margin: 0.5rem 0; }
  code { background: #1a1a1a; padding: 0.15rem 0.35rem; border-radius: 4px; color: #e5e5e5; }
</style>
</head>
<body>
  <main>
    <h1>uncited is down for maintenance</h1>
    <p>We're migrating the database to fix cross-feed duplicates.</p>
    <p>Your starred and read history is safe.</p>
    <p style="margin-top: 2rem; font-size: 0.85rem; color: #666;">Be back shortly.</p>
  </main>
</body>
</html>`

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (MAINTENANCE_MODE) {
    // Let _next assets and the maintenance page itself through; everything
    // else — pages and API routes — returns the maintenance HTML (503).
    if (!pathname.startsWith('/_next') && !pathname.startsWith('/favicon')) {
      return new NextResponse(MAINTENANCE_HTML, {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '600',
          'Cache-Control': 'no-store',
        },
      })
    }
  }

  if (RATE_LIMITED_PATHS.some(p => pathname.startsWith(p))) {
    const ip = getRateLimitedIp(request)
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait before trying again.' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    }
  }

  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * While MAINTENANCE_MODE is on we need to catch every route (including
     * API) so visitors hit the maintenance page instead of a half-working
     * endpoint. Only exclude framework assets.
     *
     * Turn MAINTENANCE_MODE off in Vercel env once the migration is done.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
