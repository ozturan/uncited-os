-- uncited-os local seed
--
-- Creates the single implicit user that SINGLE_USER_MODE serves every request
-- as. Its UUID must match NEXT_PUBLIC_LOCAL_USER_ID (see lib/localUser.ts).
-- Supabase runs this file automatically after migrations on `supabase db reset`.
--
-- The password hash below is a throwaway placeholder; nothing ever authenticates
-- as this user (single-user mode has no login), it only needs to exist so the
-- user_state / stars / reads / follows foreign keys to auth.users resolve.

insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated', 'you@localhost',
  '$2a$10$3euPcmQFCiblsZeEu5s7p.9OVHgeHWFDk9nhMqZ0m/3pd/lhwZ.Hu', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  now(), now(),
  '', '', '', ''
)
on conflict (id) do nothing;

-- The API routes (recommendations, discover, ...) expect a user_state row for
-- the current user. Create an empty one for the local user so the dashboard
-- works on first load; follows/stars/settings fill in as you use the app.
insert into public.user_state (user_id)
values ('11111111-1111-4111-8111-111111111111')
on conflict (user_id) do nothing;

-- Local single-user mode has no auth session, so the browser talks to the
-- database as the anon role. Relax RLS on the tables the local client reads
-- and writes so it can manage its own state. LOCAL ONLY: seed.sql never runs
-- in a hosted deployment, so the shared migration schema stays strict.
do $$
declare t text;
begin
  foreach t in array array['user_state','stars','reads','follows','papers','sightings','article_embeddings','id_map','broadcasts'] loop
    execute format('drop policy if exists "local anon full access" on public.%I', t);
    execute format('create policy "local anon full access" on public.%I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
