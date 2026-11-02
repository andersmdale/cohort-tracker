#!/bin/bash
# Stops the running tracker, updates packages, recreates the database for the current
# version (demo data), then starts everything again.
cd "$(dirname "$0")"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
[ -d "$(brew --prefix 2>/dev/null)/opt/node@22/bin" ] && export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
[ -d "$(brew --prefix 2>/dev/null)/opt/postgresql@16/bin" ] && export PATH="$(brew --prefix)/opt/postgresql@16/bin:$PATH"
source server/.env.local

echo "==> Stopping the running tracker"
lsof -ti tcp:4000 -ti tcp:5173 2>/dev/null | xargs kill 2>/dev/null
pkill -f "tsx src/simulate.ts" 2>/dev/null
sleep 1

if [ -d .git ]; then
  echo "==> Syncing with GitHub"
  git fetch -q origin && git reset -q --mixed origin/main && git checkout -q -- . && git log --oneline -1
fi

echo "==> Updating packages"
(cd server && npm install --no-audit --no-fund) && (cd client && npm install --no-audit --no-fund) || { echo "npm install failed"; read -n 1 -s; exit 1; }

echo "==> Recreating the database with demo data"
(cd server && npm run db:reset) || { echo "Database reset failed"; read -n 1 -s; exit 1; }

echo "==> Starting"
exec ./"Start Tracker.command"
