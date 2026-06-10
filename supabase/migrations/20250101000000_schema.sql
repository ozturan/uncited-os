-- ============================================================================
-- uncited-os — consolidated initial schema
-- ============================================================================
-- Single coherent reconstruction of the CURRENT desired database, distilled
-- from the source repo's accreted migrations/ history (supabase-schema.sql,
-- create-backup-tables.sql, and migrations 17–48). Replaces the unreliable
-- "replay 50 files in order" path.
--
-- Targets a FRESH local Supabase Postgres (the `auth` schema + auth.users
-- table already exist there). Requires the pgvector extension to be available
-- (Supabase ships it; halfvec needs pgvector >= 0.7.0).
--
-- Idempotent where practical (IF NOT EXISTS / CREATE OR REPLACE). Apply once
-- on an empty DB.
--
-- Sources of "the winning version" when migrations iterated:
--   * match_papers / match_papers_discover .... migration 42 (halfvec, final)
--   * recent_entries .......................... migration 36 (recent_entries_v2)
--   * dedupe RPCs ............................. migration 46 (per-column; 45 dropped)
--   * feed_for_follows[_lite] ................. migration 22 + 35 (60s timeout)
--   * journal_counts_since .................... migration 38 + 48 (12s timeout)
--   * article_embeddings ...................... post-43 shape: NO embedding_vec,
--                                               halfvec only (embedding_half).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
create extension if not exists vector;   -- pgvector (vector + halfvec types)
create extension if not exists pg_trgm;  -- trigram index for title search

-- halfvec availability guard (pgvector >= 0.7.0). Fails loudly if too old.
do $$
begin
  perform 'halfvec'::regtype;
exception when undefined_object then
  raise exception 'halfvec type not available — pgvector >= 0.7.0 required';
end $$;


-- ============================================================================
-- SECTION 1 — papers : canonical paper entity (one row per unique paper)
-- (migration 18, + tldr columns from migration 44)
-- ============================================================================
create table if not exists papers (
  canonical_id        text primary key,
  id_kind             text not null,
  title               text not null,
  title_normalized    text not null,
  abstract            text,
  authors             jsonb not null default '[]'::jsonb,
  authors_text        text,
  published_at        timestamptz,
  primary_source      text,
  primary_link        text,
  external_ids        jsonb not null default '{}'::jsonb,
  categories          text[] not null default '{}'::text[],
  type                text,
  embedding           vector(256),                 -- per-paper embedding (rarely used; RPCs read article_embeddings)
  tldr                text,                         -- migration 44: lazy per-paper LLM TL;DR cache
  tldr_generated_at   timestamptz,                 -- migration 44
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Lower-cased generated columns: safety net so unique indexes below cannot
  -- be defeated by case variation from producers.
  doi      text generated always as (lower(external_ids ->> 'doi'))      stored,
  arxiv_id text generated always as (lower(external_ids ->> 'arxiv_id')) stored,
  pmid     text generated always as (lower(external_ids ->> 'pmid'))     stored,
  pii      text generated always as (lower(external_ids ->> 'pii'))      stored,

  constraint papers_id_kind_check
    check (id_kind in ('doi', 'arxiv', 'title')),

  constraint papers_canonical_prefix_check
    check (
      (id_kind = 'doi'   and canonical_id like 'doi:%')   or
      (id_kind = 'arxiv' and canonical_id like 'arxiv:%') or
      (id_kind = 'title' and canonical_id like 'title:%')
    )
);

-- One paper per external ID (partial uniques).
create unique index if not exists uniq_papers_doi      on papers (doi)      where doi is not null;
create unique index if not exists uniq_papers_arxiv_id on papers (arxiv_id) where arxiv_id is not null;
create unique index if not exists uniq_papers_pmid     on papers (pmid)     where pmid is not null;

-- Filter / sort support.
create index if not exists idx_papers_published_at
  on papers (published_at desc);
create index if not exists idx_papers_primary_source
  on papers (primary_source);
create index if not exists idx_papers_categories_gin
  on papers using gin (categories);

-- Trigram index for similarity search (migration 18 / 19).
create index if not exists idx_papers_title_trgm
  on papers using gin (title_normalized gin_trgm_ops);

-- Btree on title_normalized for EQUALITY lookups used by dedupe_known_titles
-- (migration 47). Distinct from the trgm index above.
create index if not exists idx_papers_title_normalized_btree
  on papers (title_normalized)
  where title_normalized is not null;

-- Composite keyset index for recent_entries_v2 (migration 39).
create index if not exists idx_papers_published_canonical
  on papers (published_at desc, canonical_id asc);

-- Covering index for journal_counts_since index-only scan (migration 48).
create index if not exists papers_pubdate_source_idx
  on papers (published_at, primary_source);

-- HNSW over the (usually empty) per-paper embedding column (migration 18).
create index if not exists idx_papers_embedding_hnsw
  on papers using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- updated_at trigger (migration 18).
create or replace function papers_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_papers_set_updated_at on papers;
create trigger trg_papers_set_updated_at
  before update on papers
  for each row execute function papers_set_updated_at();

-- RLS: read-only for authenticated; writes via service role only.
alter table papers enable row level security;
drop policy if exists "papers readable by authenticated" on papers;
create policy "papers readable by authenticated"
  on papers for select to authenticated using (true);


-- ============================================================================
-- SECTION 2 — sightings : each appearance of a paper in an RSS feed
-- (migration 18)
-- ============================================================================
create table if not exists sightings (
  paper_id        text not null references papers(canonical_id) on delete cascade,
  source_feed     text not null,
  legacy_entry_id text,
  feed_guid       text,
  feed_link       text,
  feed_categories text[] not null default '{}'::text[],
  first_seen_at   timestamptz not null default now(),
  seen_at         timestamptz not null default now(),
  primary key (paper_id, source_feed)
);

create index if not exists idx_sightings_source_feed
  on sightings (source_feed);
create index if not exists idx_sightings_seen_at
  on sightings (seen_at desc);
create index if not exists idx_sightings_legacy_entry_id
  on sightings (legacy_entry_id) where legacy_entry_id is not null;

alter table sightings enable row level security;
drop policy if exists "sightings readable by authenticated" on sightings;
create policy "sightings readable by authenticated"
  on sightings for select to authenticated using (true);


-- ============================================================================
-- SECTION 3 — id_map : legacy article_id → canonical_id forensic map
-- (migration 18; written by fetch.js dual-write + read by dedupe/triggers)
-- ============================================================================
create table if not exists id_map (
  legacy_entry_id text primary key,
  canonical_id    text not null references papers(canonical_id) on delete cascade,
  resolved_via    text not null,
  resolved_at     timestamptz not null default now(),
  constraint id_map_resolved_via_check
    check (resolved_via in ('doi', 'arxiv', 'title-hash', 'hard-fallback', 'sighting-backfill'))
);

create index if not exists idx_id_map_canonical
  on id_map (canonical_id);

alter table id_map enable row level security;
drop policy if exists "id_map readable by authenticated" on id_map;
create policy "id_map readable by authenticated"
  on id_map for select to authenticated using (true);


-- ============================================================================
-- SECTION 4 — article_embeddings : vector store used by match_papers_* RPCs
-- ============================================================================
-- This table was originally created out-of-band (Supabase dashboard) in the
-- source project, so no committed CREATE TABLE exists. Reconstructed from
-- usage: migration 01 (HNSW/btree indexes), 20 (canonical_id), 40 (halfvec),
-- 43 (drop embedding_vec), and the INSERT shape in scripts/fetch.js
-- generateEmbeddings() (article_id, journal_id, embedding_half, published,
-- canonical_id). FINAL post-43 shape: NO embedding_vec column; halfvec only.
--
-- TODO(verify): the original out-of-band table may have carried extra columns
-- (e.g. embedding_model, created_at). None are referenced by the app or RPCs,
-- so they are omitted here. Add them if a production dump shows otherwise.
-- ============================================================================
create table if not exists article_embeddings (
  article_id     text primary key,                 -- onConflict target in fetch.js
  journal_id     text,
  published      timestamptz,
  canonical_id   text,                             -- migration 20
  embedding_half halfvec(256)                      -- migration 40; embedding_vec dropped in 43
);

-- IVFFlat index on the halfvec column (migration 41). lists≈sqrt(n); 1000 is
-- the source default for ~644k rows. For a small/fresh DB this is fine; it is
-- only consulted by match_papers_discover (which also sets ivfflat.probes).
-- TODO(verify): on a tiny seed corpus an HNSW or no index performs equally;
-- IVFFlat with lists=1000 on few rows just falls back to near-exact scan.
create index if not exists idx_article_embeddings_half_ivf
  on article_embeddings
  using ivfflat (embedding_half halfvec_cosine_ops)
  with (lists = 1000);

-- Date filter (migration 01, retained on the surviving column).
create index if not exists idx_article_embeddings_published
  on article_embeddings (published);

-- canonical_id join index (migration 20).
create index if not exists idx_article_embeddings_canonical
  on article_embeddings (canonical_id)
  where canonical_id is not null;

-- RLS: authenticated read; writes via service role (supabase-schema.sql).
alter table article_embeddings enable row level security;
drop policy if exists "Authenticated users can select article embeddings" on article_embeddings;
create policy "Authenticated users can select article embeddings"
  on article_embeddings for select to authenticated using (true);


-- ============================================================================
-- SECTION 5 — user_state : per-user follows/read/starred + settings
-- (supabase-schema.sql + canonical columns from migration 18)
-- ============================================================================
create table if not exists user_state (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null unique,
  follows text[] default '{}' not null,
  read    text[] default '{}' not null,
  starred text[] default '{}' not null,
  settings jsonb,                                   -- holds field_centroid (My Field), profile, etc.
  -- Canonical mirror columns (migration 18). Kept for schema parity; the app
  -- no longer maintains them (exclusion goes through user_excluded_canonical).
  starred_canonical     text[] not null default '{}'::text[],
  read_canonical        text[] not null default '{}'::text[],
  starred_ts_canonical  jsonb,
  read_ts_canonical     jsonb,
  canonical_migrated_at timestamptz,
  last_visit            timestamptz,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists user_state_user_id_idx on user_state(user_id);
create index if not exists idx_user_state_starred_canonical
  on user_state using gin (starred_canonical);
create index if not exists idx_user_state_read_canonical
  on user_state using gin (read_canonical);

alter table user_state enable row level security;

drop policy if exists "Users can view their own state" on user_state;
create policy "Users can view their own state"
  on user_state for select using (auth.uid() = user_id);

drop policy if exists "Users can insert their own state" on user_state;
create policy "Users can insert their own state"
  on user_state for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update their own state" on user_state;
create policy "Users can update their own state"
  on user_state for update using (auth.uid() = user_id);

drop policy if exists "Users can delete their own state" on user_state;
create policy "Users can delete their own state"
  on user_state for delete using (auth.uid() = user_id);


-- ============================================================================
-- SECTION 6 — stars : per-user starred articles
-- (supabase-schema.sql + canonical_id from migration 18)
-- ============================================================================
create table if not exists stars (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  entry_id text not null,
  canonical_id text,                                -- migration 18
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(user_id, entry_id)
);

create index if not exists idx_stars_entry_id   on stars(entry_id);
create index if not exists idx_stars_user_id     on stars(user_id);
create index if not exists idx_stars_created_at  on stars(created_at desc);
create index if not exists idx_stars_canonical_id
  on stars (canonical_id) where canonical_id is not null;

alter table stars enable row level security;

drop policy if exists "Users can view all stars" on stars;
create policy "Users can view all stars"
  on stars for select to authenticated using (true);

drop policy if exists "Users can insert their own stars" on stars;
create policy "Users can insert their own stars"
  on stars for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own stars" on stars;
create policy "Users can delete their own stars"
  on stars for delete using (auth.uid() = user_id);


-- ============================================================================
-- SECTION 7 — reads : per-user read/archived articles
-- (create-backup-tables.sql + canonical_id migration 31 + RLS migration 33)
-- ============================================================================
create table if not exists reads (
  user_id uuid references auth.users(id) on delete cascade,
  entry_id text not null,
  canonical_id text,                                -- migration 31
  created_at timestamp with time zone default now(),
  primary key (user_id, entry_id)
);

create index if not exists reads_user_id_idx    on reads(user_id);
create index if not exists reads_created_at_idx  on reads(created_at);
create index if not exists idx_reads_user_id     on reads (user_id);
create index if not exists idx_reads_canonical_id
  on reads (canonical_id) where canonical_id is not null;

alter table reads enable row level security;

drop policy if exists "Users can view their own reads" on reads;
create policy "Users can view their own reads"
  on reads for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can insert their own reads" on reads;
create policy "Users can insert their own reads"
  on reads for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users can update their own reads" on reads;
create policy "Users can update their own reads"
  on reads for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own reads" on reads;
create policy "Users can delete their own reads"
  on reads for delete to authenticated using (auth.uid() = user_id);


-- ============================================================================
-- SECTION 8 — follows : per-user followed journals (backup table)
-- (create-backup-tables.sql)
-- ============================================================================
create table if not exists follows (
  user_id uuid references auth.users(id) on delete cascade,
  journal_id text not null,
  created_at timestamp with time zone default now(),
  primary key (user_id, journal_id)
);

create index if not exists follows_user_id_idx    on follows(user_id);
create index if not exists follows_created_at_idx  on follows(created_at);

alter table follows enable row level security;

drop policy if exists "Users can view own follows" on follows;
create policy "Users can view own follows"
  on follows for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own follows" on follows;
create policy "Users can insert own follows"
  on follows for insert with check (auth.uid() = user_id);

drop policy if exists "Users can delete own follows" on follows;
create policy "Users can delete own follows"
  on follows for delete using (auth.uid() = user_id);


-- ============================================================================
-- SECTION 9 — analytics_events : event tracking
-- (supabase-schema.sql)
-- ============================================================================
create table if not exists analytics_events (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null,
  event_data jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists analytics_events_user_id_idx    on analytics_events(user_id);
create index if not exists analytics_events_created_at_idx  on analytics_events(created_at);
create index if not exists analytics_events_event_type_idx  on analytics_events(event_type);

alter table analytics_events enable row level security;

drop policy if exists "Users can insert their own analytics events" on analytics_events;
create policy "Users can insert their own analytics events"
  on analytics_events for insert with check (auth.uid() = user_id);

drop policy if exists "Users can view their own analytics events" on analytics_events;
create policy "Users can view their own analytics events"
  on analytics_events for select using (auth.uid() = user_id);


-- ============================================================================
-- SECTION 10 — broadcasts : sent-email history (admin / service-role only)
-- (migration 17)
-- ============================================================================
create table if not exists broadcasts (
  id bigint generated always as identity primary key,
  subject text not null,
  body text not null,
  sent int not null default 0,
  failed int not null default 0,
  total int not null default 0,
  opted_out int not null default 0,
  has_more boolean not null default false,
  next_offset int not null default 0,
  created_at timestamptz not null default now()
);

alter table broadcasts enable row level security;
-- No SELECT/INSERT policy: accessed only via service role, which bypasses RLS.


-- ============================================================================
-- SECTION 11 — triggers that auto-populate canonical_id on reads/stars insert
-- (migration 32)
-- ============================================================================
create or replace function populate_reads_canonical_id()
returns trigger as $$
begin
  if new.canonical_id is null and new.entry_id is not null then
    select im.canonical_id into new.canonical_id
    from id_map im
    where im.legacy_entry_id = new.entry_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists reads_set_canonical_id on reads;
create trigger reads_set_canonical_id
  before insert on reads
  for each row execute function populate_reads_canonical_id();

create or replace function populate_stars_canonical_id()
returns trigger as $$
begin
  if new.canonical_id is null and new.entry_id is not null then
    select im.canonical_id into new.canonical_id
    from id_map im
    where im.legacy_entry_id = new.entry_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists stars_set_canonical_id on stars;
create trigger stars_set_canonical_id
  before insert on stars
  for each row execute function populate_stars_canonical_id();


-- ============================================================================
-- SECTION 12 — RPC: match_papers (For-You / My Field over followed feeds)
-- (migration 42 — halfvec, final winning version)
-- ============================================================================
create or replace function match_papers(
  query_embedding        vector(256),
  match_count            int,
  p_filter_feeds         text[],
  min_published_date     timestamptz,
  excluded_canonical_ids text[]
) returns table (
  canonical_id   text,
  source_feed    text,
  published_at   timestamptz,
  similarity     float
) as $$
  with user_papers as materialized (
    select s.paper_id as canonical_id,
           min(s.source_feed) as source_feed
    from sightings s
    join papers p on p.canonical_id = s.paper_id
    where s.source_feed = any(p_filter_feeds)
      and p.published_at >= min_published_date
    group by s.paper_id
  ),
  excluded as materialized (
    select unnest(coalesce(excluded_canonical_ids, array[]::text[])) as id
  ),
  scored as (
    select up.canonical_id,
           up.source_feed,
           ae.published,
           1 - (ae.embedding_half <=> query_embedding::halfvec(256)) as similarity
    from user_papers up
    join article_embeddings ae on ae.canonical_id = up.canonical_id
    where ae.embedding_half is not null
      and not exists (select 1 from excluded e where e.id = up.canonical_id)
    order by ae.embedding_half <=> query_embedding::halfvec(256)
    limit match_count
  )
  select s.canonical_id, s.source_feed, s.published, s.similarity
  from scored s
  order by s.similarity desc;
$$ language sql stable;

alter function match_papers(vector(256), int, text[], timestamptz, text[])
  set statement_timeout = '30s';

grant execute on function match_papers(vector(256), int, text[], timestamptz, text[])
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 13 — RPC: match_papers_discover (Discover / paper-similar)
-- (migration 42 — halfvec, final winning version)
-- ============================================================================
create or replace function match_papers_discover(
  query_embedding    vector(256),
  match_count        int,
  min_published_date timestamptz,
  p_excluded_feeds   text[]
) returns table (
  canonical_id text,
  source_feed  text,
  published_at timestamptz,
  similarity   float
) as $$
begin
  -- IVFFlat probes — higher = better recall, more rows scanned.
  perform set_config('ivfflat.probes', '20', true);
  return query
    with candidates as (
      select ae.canonical_id,
             ae.published,
             1 - (ae.embedding_half <=> query_embedding::halfvec(256)) as similarity
      from article_embeddings ae
      where ae.canonical_id is not null
        and ae.embedding_half is not null
        and ae.published >= min_published_date
      order by ae.embedding_half <=> query_embedding::halfvec(256)
      limit match_count * 3
    )
    select distinct on (c.canonical_id)
      c.canonical_id,
      s.source_feed,
      c.published,
      c.similarity
    from candidates c
    join sightings s on s.paper_id = c.canonical_id
    where p_excluded_feeds is null
       or s.source_feed <> all(p_excluded_feeds)
    order by c.canonical_id, c.similarity desc;
end;
$$ language plpgsql stable;

alter function match_papers_discover(vector(256), int, timestamptz, text[])
  set statement_timeout = '30s';

grant execute on function match_papers_discover(vector(256), int, timestamptz, text[])
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 14 — RPC: feed_for_follows / feed_for_follows_lite
-- (migration 22; statement_timeout 60s from migration 35)
-- ============================================================================
create or replace function feed_for_follows(
  p_follows text[],
  p_since   timestamptz,
  p_limit   int default 5000
) returns table (
  canonical_id    text,
  source_feed     text,
  legacy_entry_id text,
  feed_link       text,
  title           text,
  abstract        text,
  authors         jsonb,
  authors_text    text,
  published_at    timestamptz,
  primary_source  text,
  primary_link    text,
  external_ids    jsonb,
  categories      text[],
  type            text
)
language sql stable security definer
as $$
  select
    p.canonical_id, s.source_feed, s.legacy_entry_id, s.feed_link,
    p.title, p.abstract, p.authors, p.authors_text, p.published_at,
    p.primary_source, p.primary_link, p.external_ids, p.categories, p.type
  from sightings s
  join papers p on p.canonical_id = s.paper_id
  where s.source_feed = any(p_follows)
    and p.published_at >= p_since
  order by p.published_at desc
  limit p_limit;
$$;

alter function feed_for_follows(text[], timestamptz, int)
  set statement_timeout = '60s';

grant execute on function feed_for_follows(text[], timestamptz, int)
  to anon, authenticated, service_role;


create or replace function feed_for_follows_lite(
  p_follows text[],
  p_since   timestamptz,
  p_limit   int default 5000
) returns table (
  canonical_id    text,
  source_feed     text,
  legacy_entry_id text,
  feed_link       text,
  title           text,
  authors_text    text,
  published_at    timestamptz,
  primary_source  text,
  primary_link    text,
  external_ids    jsonb,
  categories      text[],
  type            text
)
language sql stable security definer
as $$
  select
    p.canonical_id, s.source_feed, s.legacy_entry_id, s.feed_link,
    p.title, p.authors_text, p.published_at,
    p.primary_source, p.primary_link, p.external_ids, p.categories, p.type
  from sightings s
  join papers p on p.canonical_id = s.paper_id
  where s.source_feed = any(p_follows)
    and p.published_at >= p_since
  order by p.published_at desc
  limit p_limit;
$$;

alter function feed_for_follows_lite(text[], timestamptz, int)
  set statement_timeout = '60s';

grant execute on function feed_for_follows_lite(text[], timestamptz, int)
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 15 — RPC: recent_entries_v2 (existing-entries loader for fetch.js)
-- (migration 36 — supersedes recent_entries_since from migration 30)
-- ============================================================================
create or replace function recent_entries_v2(
  p_since      timestamptz,
  p_cursor_pub timestamptz default null,
  p_cursor_id  text        default null,
  p_limit      int         default 5000
) returns table (
  canonical_id    text,
  source_feed     text,
  legacy_entry_id text,
  feed_link       text,
  title           text,
  abstract        text,
  authors         jsonb,
  authors_text    text,
  published_at    timestamptz,
  primary_source  text,
  primary_link    text,
  external_ids    jsonb,
  categories      text[],
  type            text
) as $$
  select
    p.canonical_id, s.source_feed, s.legacy_entry_id, s.feed_link,
    p.title, p.abstract, p.authors, p.authors_text, p.published_at,
    p.primary_source, p.primary_link, p.external_ids, p.categories, p.type
  from papers p
  left join lateral (
    select source_feed, legacy_entry_id, feed_link
    from sightings
    where paper_id = p.canonical_id
    limit 1
  ) s on true
  where p.published_at >= p_since
    and (
      p_cursor_pub is null
      or p.published_at < p_cursor_pub
      or (p.published_at = p_cursor_pub and p.canonical_id > p_cursor_id)
    )
  order by p.published_at desc, p.canonical_id asc
  limit p_limit;
$$ language sql stable;

alter function recent_entries_v2(timestamptz, timestamptz, text, int)
  set statement_timeout = '60s';

grant execute on function recent_entries_v2(timestamptz, timestamptz, text, int)
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 16 — RPC: user_excluded_canonical (read+star exclude set)
-- (migration 32)
-- ============================================================================
create or replace function user_excluded_canonical(p_user_id uuid)
returns text[] as $$
  select coalesce(array_agg(distinct canonical_id), array[]::text[])
  from (
    select canonical_id from reads where user_id = p_user_id and canonical_id is not null
    union
    select canonical_id from stars where user_id = p_user_id and canonical_id is not null
  ) t;
$$ language sql stable;

alter function user_excluded_canonical(uuid) set statement_timeout = '30s';

grant execute on function user_excluded_canonical(uuid)
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 17 — RPC: get_user_activity (reads + stars in one jsonb payload)
-- (migration 34)
-- ============================================================================
create or replace function get_user_activity(p_user_id uuid)
returns jsonb as $$
  select jsonb_build_object(
    'reads', coalesce(
      (select jsonb_agg(
        jsonb_build_object('entry_id', entry_id, 'canonical_id', canonical_id, 'created_at', created_at)
        order by created_at desc
      ) from reads where user_id = p_user_id),
      '[]'::jsonb
    ),
    'stars', coalesce(
      (select jsonb_agg(
        jsonb_build_object('entry_id', entry_id, 'canonical_id', canonical_id, 'created_at', created_at)
        order by created_at desc
      ) from stars where user_id = p_user_id),
      '[]'::jsonb
    )
  );
$$ language sql stable;

alter function get_user_activity(uuid) set statement_timeout = '30s';

grant execute on function get_user_activity(uuid)
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 18 — RPC: engagement_type_breakdown (analytics pie chart)
-- (migration 37)
-- ============================================================================
create or replace function engagement_type_breakdown()
returns table (
  type  text,
  stars bigint,
  reads bigint,
  total bigint
) as $$
  with star_counts as (
    select coalesce(p.type, 'Other') as type, count(*)::bigint as stars
    from stars s
    left join papers p on p.canonical_id = s.canonical_id
    where s.canonical_id is not null
    group by coalesce(p.type, 'Other')
  ),
  read_counts as (
    select coalesce(p.type, 'Other') as type, count(*)::bigint as reads
    from reads r
    left join papers p on p.canonical_id = r.canonical_id
    where r.canonical_id is not null
    group by coalesce(p.type, 'Other')
  )
  select
    coalesce(s.type, r.type)                     as type,
    coalesce(s.stars, 0)                         as stars,
    coalesce(r.reads, 0)                         as reads,
    coalesce(s.stars, 0) + coalesce(r.reads, 0)  as total
  from star_counts s
  full outer join read_counts r on r.type = s.type
  order by total desc;
$$ language sql stable;

alter function engagement_type_breakdown()
  set statement_timeout = '60s';

grant execute on function engagement_type_breakdown()
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 19 — RPC: journal_counts_since (journal-grid badge counts)
-- (migration 38; statement_timeout tightened to 12s in migration 48)
-- ============================================================================
create or replace function journal_counts_since(
  p_since timestamptz
) returns table (
  primary_source text,
  count          bigint
) as $$
  select primary_source, count(*)::bigint as count
  from papers
  where published_at >= p_since
    and primary_source is not null
  group by primary_source
  order by count desc;
$$ language sql stable;

alter function journal_counts_since(timestamptz)
  set statement_timeout = '12s';

grant execute on function journal_counts_since(timestamptz)
  to anon, authenticated, service_role;


-- ============================================================================
-- SECTION 20 — dedupe RPCs (per-column; used by scripts/fetch.js)
-- (migration 46 — the combined dedupe_incoming from migration 45 was dropped)
-- ============================================================================
create or replace function dedupe_known_ids(p_ids text[])
returns text[] language sql stable as $$
  select coalesce(array_agg(legacy_entry_id), array[]::text[])
  from id_map
  where legacy_entry_id = any(p_ids);
$$;
alter function dedupe_known_ids(text[]) set statement_timeout = '30s';
grant execute on function dedupe_known_ids(text[]) to anon, authenticated, service_role;

create or replace function dedupe_known_dois(p_dois text[])
returns text[] language sql stable as $$
  select coalesce(array_agg(doi), array[]::text[])
  from papers
  where doi = any(p_dois);
$$;
alter function dedupe_known_dois(text[]) set statement_timeout = '30s';
grant execute on function dedupe_known_dois(text[]) to anon, authenticated, service_role;

create or replace function dedupe_known_arxiv(p_arxiv_ids text[])
returns text[] language sql stable as $$
  select coalesce(array_agg(arxiv_id), array[]::text[])
  from papers
  where arxiv_id = any(p_arxiv_ids);
$$;
alter function dedupe_known_arxiv(text[]) set statement_timeout = '30s';
grant execute on function dedupe_known_arxiv(text[]) to anon, authenticated, service_role;

create or replace function dedupe_known_titles(p_title_hashes text[])
returns text[] language sql stable as $$
  select coalesce(array_agg(p.title_normalized), array[]::text[])
  from unnest(p_title_hashes) as t(title_normalized)
  join papers p on p.title_normalized = t.title_normalized;
$$;
alter function dedupe_known_titles(text[]) set statement_timeout = '30s';
grant execute on function dedupe_known_titles(text[]) to anon, authenticated, service_role;

-- Done.
