#!/usr/bin/env bash
# Shared by operations scripts; no secret file is executed as shell code.
set -euo pipefail
DRIFTOPIA_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DRIFTOPIA_ENV_FILE="${DRIFTOPIA_ENV_FILE:-$DRIFTOPIA_ROOT/.env.production}"
if [[ ! -f "$DRIFTOPIA_ENV_FILE" ]]; then
  echo "Missing production environment file: $DRIFTOPIA_ENV_FILE" >&2
  exit 1
fi
compose=(docker compose --env-file "$DRIFTOPIA_ENV_FILE" -f "$DRIFTOPIA_ROOT/compose.production.yaml")
# Override is useful for isolated smoke/restore exercises; never inferred.
if [[ -n "${DRIFTOPIA_COMPOSE_OVERRIDE:-}" ]]; then
  compose+=(-f "$DRIFTOPIA_COMPOSE_OVERRIDE")
fi
if [[ -n "${DRIFTOPIA_PROJECT:-}" ]]; then
  compose+=(-p "$DRIFTOPIA_PROJECT")
fi
"${compose[@]}" config --quiet
