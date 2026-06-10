// Single-user local mode.
//
// When NEXT_PUBLIC_SINGLE_USER_MODE is "true", uncited-os runs with no auth at
// all: it opens straight to the dashboard as one fixed implicit user. There is
// no login screen and no sign-in round-trip. On the server every request is
// served by a service-role client (which bypasses row-level security) and is
// reported as LOCAL_USER_ID; on the client useAuth synchronously hydrates that
// same identity so the dashboard renders immediately.
//
// LOCAL_USER_ID must match the row seeded into auth.users by supabase/seed.sql.

export const SINGLE_USER_MODE =
  process.env.NEXT_PUBLIC_SINGLE_USER_MODE === 'true';

export const LOCAL_USER_ID =
  process.env.NEXT_PUBLIC_LOCAL_USER_ID || '11111111-1111-4111-8111-111111111111';

export const LOCAL_USER_EMAIL =
  process.env.NEXT_PUBLIC_LOCAL_USER_EMAIL || 'you@localhost';
