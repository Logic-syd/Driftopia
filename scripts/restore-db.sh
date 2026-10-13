#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/deploy-common.sh"
archive="${1:?Usage: restore-db.sh path/to/backup.dump new_restore_database}"
target_db="${2:?Choose a NEW isolated database name beginning with restore_}"
if [[ ! "$target_db" =~ ^restore_[a-z0-9_]{1,48}$ ]]; then
  echo 'Only a new restore_* database is allowed. The running driftopia database is never overwritten.' >&2
  exit 1
fi
[[ -f "$archive" && -f "$archive.sha256" ]] || { echo 'Archive and .sha256 are required.' >&2; exit 1; }
expected="$(awk '{print $1}' "$archive.sha256")"
actual="$(sha256sum -- "$archive" | awk '{print $1}')"
[[ "$expected" =~ ^[0-9a-f]{64}$ && "$expected" == "$actual" ]] || { echo 'Backup checksum mismatch.' >&2; exit 1; }
"${compose[@]}" exec -T postgres createdb -U driftopia_bootstrap -O driftopia_owner -- "$target_db"
"${compose[@]}" exec -T postgres pg_restore -U driftopia_owner -d "$target_db" --exit-on-error --single-transaction --no-owner --no-privileges < "$archive"
has_game_tables="$("${compose[@]}" exec -T postgres psql -U driftopia_owner -d "$target_db" -At -c "SELECT to_regclass('public.\"User\"') IS NOT NULL")"
if [[ "$has_game_tables" == "t" ]]; then
  "${compose[@]}" exec -T postgres psql -U driftopia_owner -d "$target_db" -v ON_ERROR_STOP=1 -c 'SELECT count(*) AS users FROM "User"; SELECT count(*) AS transactions FROM "MarketTransaction"; SELECT count(*) AS migrations FROM "_driftopia_migrations";'
else
  echo 'Archive predates the first game migration; empty game database restored.'
fi
echo "Restored successfully into isolated database: $target_db"
echo 'Production cutover is a separate maintenance operation; validate game state and schema compatibility first.'
