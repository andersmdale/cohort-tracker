#!/bin/bash
# Starts the server (API + scheduler), the simulator and the dashboard, then opens the dashboard.
cd "$(dirname "$0")"
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
[ -d "$(brew --prefix 2>/dev/null)/opt/node@22/bin" ] && export PATH="$(brew --prefix)/opt/node@22/bin:$PATH"
source server/.env.local
mkdir -p logs
(cd server && npm run dev > ../logs/server.log 2>&1) &
sleep 4
(cd server && npm run simulate > ../logs/simulate.log 2>&1) &
(cd client && npm run dev > ../logs/client.log 2>&1) &
sleep 4
open http://localhost:5173
echo "Running. Logs are in $(pwd)/logs. Close this window or press Ctrl-C to stop everything."
trap 'kill 0' INT TERM EXIT
wait
