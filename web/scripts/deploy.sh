#!/usr/bin/env bash
# Builds the static site and deploys it to Cloudflare Pages (project "calember").
#   web/dist   the app (VITE_STATIC=1: no Python server; snapshot + browser engine + Pages Functions)
#   web/snap   precomputed data (pipeline/build_snapshot.py, build_region_tiles.py, build_engine_static.py)
# Usage (from the repository root, after `wrangler login`):  bash web/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VITE_STATIC=1 pnpm build
rm -rf .deploy
cp -r dist .deploy
cp -rl snap .deploy/snap 2>/dev/null || cp -r snap .deploy/snap
echo "files: $(find .deploy -type f | wc -l) (Cloudflare Pages limit 20,000)"
big=$(find .deploy -type f -size +24M | head -5)
if [ -n "$big" ]; then echo "files over 25 MiB: $big"; exit 1; fi
npx wrangler pages deploy .deploy --project-name calember --branch main --commit-dirty=true
