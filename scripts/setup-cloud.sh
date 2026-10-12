#!/usr/bin/env bash
set -euo pipefail
cd /workspace/Driftopia
# The cloud task is already isolated; use this checkout, not a new worktree.
export XDG_DATA_HOME=/workspace/.local/share
export XDG_CACHE_HOME=/workspace/.cache
pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose up -d --wait
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm typecheck
