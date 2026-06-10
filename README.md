# uncited-os

Self-hostable, open-source edition of [uncited](https://uncited.org): a literature
monitoring tool for researchers. Track new papers from 3,000+ journals and
preprint servers (bioRxiv, medRxiv, arXiv) in one clean interface, running
entirely on your own machine. No cloud account, no login.

## What you get

uncited-os runs in two levels:

**Level 1 — full RSS reader (free, no API keys).**
Follow journals, browse and search papers, star and track what you have read.
Everything runs against a local database. This works out of the box.

**Level 2 — semantic recommendations (bring your own OpenAI key).**
Add an `OPENAI_API_KEY` to embed papers at ingest time. This unlocks the
"For You" and Discover feeds, which rank new papers by similarity to what you
star. Embedding papers costs money at your own OpenAI rate, so it is opt-in.

## How it works

Everything is local. `supabase start` runs Postgres + pgvector in Docker on your
machine, the app talks to it, and an RSS pipeline fills the database. The cloud
Supabase service is never involved. By default the app opens straight to the
dashboard as a single implicit user, so there is no login screen.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) or
  [OrbStack](https://orbstack.dev/) (runs the local database)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- Node.js 20+

## Quick start

```bash
git clone https://github.com/ozturan/uncited-os.git
cd uncited-os
./up.sh
```

`./up.sh` installs dependencies, starts the local Supabase stack (applying the
schema and seeding the local user), kicks off a background RSS fetch the first
time so your feed fills in, and serves the app.

Open http://localhost:3000. The dashboard opens directly. The feed is empty for
the first few minutes while papers are fetched, then fills in as you refresh.

To inspect the database, open Supabase Studio at http://127.0.0.1:54323.

## Enabling recommendations (Level 2)

1. Put your key in `.env.development`:
   ```
   OPENAI_API_KEY=sk-...
   ENABLE_EMBEDDINGS=true
   ```
2. Re-run the fetch so new papers get embedded:
   ```
   npm run populate
   ```
Papers ingested while embeddings were on become eligible for the "For You" and
Discover feeds.

## Useful commands

```bash
npm run populate     # fetch the latest papers from all followed journals
npm run db:status    # show local Supabase URLs and keys
npm run db:reset     # re-apply schema + seed (wipes local data)
npm run db:stop      # stop the local Supabase stack
```

## Project structure

```
uncited-os/
├── app/                       # Next.js App Router pages and API routes
├── lib/                       # Shared utilities, types, Supabase clients
│   └── localUser.ts           # single-user local mode
├── public/data/catalog.json   # the journal / feed catalog
├── scripts/fetch.js           # RSS ingestion pipeline
├── supabase/
│   ├── migrations/            # consolidated schema (00000000000000_init.sql)
│   └── seed.sql               # seeds the single local user
└── up.sh                      # one-command launcher
```

## License

MIT. See [LICENSE](LICENSE).
