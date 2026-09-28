#!/usr/bin/env bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
if [ ! -f node_modules/.install-ok ]; then
  rm -rf node_modules
  npm install --omit=dev && node -e "require('better-sqlite3'); require('express')" && touch node_modules/.install-ok \
    || { echo "Install failed. Check your internet connection and run again."; rm -rf node_modules; exit 1; }
fi
echo "Open http://localhost:3000"
exec node server.js
