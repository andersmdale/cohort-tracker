#!/usr/bin/env bash
# Installs and seeds the Cohort Data Tracker on macOS (Apple silicon or Intel).
#   cd cohort-tracker && bash install-mac.sh
# Uses Homebrew for Node 22 and Postgres 16 when they are missing, creates the
# cohort_tracker database, installs packages and seeds the eight studies.
set -euo pipefail

DB_NAME="${DB_NAME:-cohort_tracker}"
HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- Homebrew -------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it from https://brew.sh and run this script again."
  exit 1
fi

# --- Node 20+ -------------------------------------------------------------
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  say "Installing Node 22"
  brew install node@22
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
echo "Node $(node -v)"

# --- Postgres -------------------------------------------------------------
if ! command -v psql >/dev/null 2>&1 && [ ! -x "$(brew --prefix)/opt/postgresql@16/bin/psql" ]; then
  say "Installing Postgres 16"
  brew install postgresql@16
fi
if ! command -v psql >/dev/null 2>&1; then export PATH="$(brew --prefix)/opt/postgresql@16/bin:$PATH"; fi
if ! pg_isready -q -h localhost 2>/dev/null; then
  say "Starting Postgres"
  brew services start postgresql@16 >/dev/null 2>&1 || brew services start postgresql >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pg_isready -q -h localhost && break; sleep 1; done
fi
pg_isready -h localhost >/dev/null || { echo "Postgres is not accepting connections on localhost:5432."; exit 1; }

if ! psql -h localhost -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
  say "Creating database $DB_NAME"
  createdb -h localhost "$DB_NAME"
fi
export DATABASE_URL="postgres://$(whoami)@localhost:5432/$DB_NAME"

# --- Packages and seed ----------------------------------------------------
say "Installing server packages"
(cd "$HERE/server" && npm install --no-audit --no-fund)
say "Installing client packages"
(cd "$HERE/client" && npm install --no-audit --no-fund)
say "Creating tables and seeding studies and deliverables"
(cd "$HERE/server" && npm run db:reset)

# Remember the connection string for later terminals
ENV_FILE="$HERE/server/.env.local"
echo "export DATABASE_URL=$DATABASE_URL" > "$ENV_FILE"

cat <<EOF

Installed. Open three Terminal tabs and run one block in each:

  # 1. Server (API + scheduler) on http://localhost:4000
  cd "$HERE/server" && source .env.local && npm run dev

  # 2. Simulated activity (optional)
  cd "$HERE/server" && source .env.local && npm run simulate

  # 3. Dashboard on http://localhost:5173
  cd "$HERE/client" && npm run dev
EOF
