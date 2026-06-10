import HomeClient from './page-client';
import { prefetchUser } from '@/lib/serverPrefetch';

// Single-user local mode: prefetchUser always returns the fixed local user, so
// there is no anonymous/landing branch. Authed traffic gets dynamic SSR
// (per-user data is loaded client-side after the shell paints).
export default async function Home() {
  const prefetched = await prefetchUser();

  // HomeClient's client paths (useUserState.loadState, useEntries) load
  // user_state and entries after the shell is already on screen.
  return (
    <HomeClient
      initialUser={prefetched.user}
      initialState={prefetched.state}
      initialEntries={prefetched.entries}
    />
  );
}
