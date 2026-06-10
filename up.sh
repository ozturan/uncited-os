#!/usr/bin/env bash
# uncited-os — one command to bring up the local stack and open the app.
#
#   ./up.sh
#
# Starts a local Supabase (Postgres + pgvector, in Docker), applies the schema,
# seeds the single local user, populates the feed from RSS the first time, and
# runs the app at http://localhost:3000 — no cloud account, no login.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

# 1. Prerequisites ----------------------------------------------------------
if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI not found. Install it, then re-run ./up.sh:"
  echo "  brew install supabase/tap/supabase   # macOS"
  echo "  npm install -g supabase              # any platform"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop or OrbStack, then re-run ./up.sh."
  echo "  brew install orbstack    # lightweight macOS option"
  exit 1
fi

# 2. Dependencies -----------------------------------------------------------
if [ ! -d node_modules ]; then
  bold "Installing npm dependencies..."
  npm install
fi

# 3. Local Supabase ---------------------------------------------------------
# `supabase start` applies supabase/migrations + supabase/seed.sql the first
# time it initialises the database volume.
bold "Starting local Supabase (this can take a minute the first time)..."
supabase start

# Load local env so the fetch pipeline can reach the database.
set -a; source .env.development; set +a

# 4. Keep the feed fresh ----------------------------------------------------
# Fetch the latest papers now (in the background), then again on a schedule, so
# the feed is up to date every time you start and stays current while running.
# Change the cadence with FETCH_INTERVAL_HOURS (default 3). Logs: populate.log.
FETCH_INTERVAL_HOURS="${FETCH_INTERVAL_HOURS:-3}"
bold "Refreshing papers in the background now, then every ${FETCH_INTERVAL_HOURS}h (logs: populate.log)."
echo "  (the first refresh fills in over a few minutes; just refresh the app)"
(
  while true; do
    node scripts/fetch.js >> populate.log 2>&1
    sleep "$(( FETCH_INTERVAL_HOURS * 3600 ))"
  done
) &
SCHED_PID=$!
# Stop the background fetcher when you stop the app (Ctrl+C).
trap 'kill "$SCHED_PID" 2>/dev/null' INT TERM EXIT

# 5. App --------------------------------------------------------------------
bold "Starting uncited-os at http://localhost:3000"
echo "Supabase Studio (inspect the DB): http://127.0.0.1:54323"
npm run dev
