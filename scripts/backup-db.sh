#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/deploy-common.sh"
umask 077
backup_dir="${BACKUP_DIR:-$DRIFTOPIA_ROOT/backups}"
mkdir -p -- "$backup_dir"
backup_file="$backup_dir/driftopia-$(date -u +%Y%m%dT%H%M%S)-$$.dump"
partial="$backup_file.partial"
trap 'rm -f -- "$partial"' EXIT
"${compose[@]}" exec -T postgres pg_dump -U driftopia_owner -d driftopia --format=custom > "$partial"
# Read the archive directory before declaring the backup usable.
"${compose[@]}" exec -T postgres pg_restore --list < "$partial" > /dev/null
mv -- "$partial" "$backup_file"
sha256sum -- "$backup_file" > "$backup_file.sha256"
echo "Backup created and archive directory verified: $backup_file"
echo 'Copy the archive and checksum to encrypted off-host storage; a local volume is not disaster recovery.'
