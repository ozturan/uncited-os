'use client';

import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/localUser';

// Single-user local mode: there is no login, no session, no sign-out. The app
// always runs as the fixed local user, so useAuth just hands that user back
// synchronously and never loads.
export function useAuth(_initialUser: { id: string; email?: string | null } | null = null) {
  const user: any = { id: LOCAL_USER_ID, email: LOCAL_USER_EMAIL };
  return {
    user,
    userLoading: false,
  };
}
