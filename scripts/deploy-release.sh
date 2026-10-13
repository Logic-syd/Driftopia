#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/deploy-common.sh"
api_image="${1:?Provide immutable API image digest}"
web_image="${2:?Provide matching immutable web image digest}"
for release_image in "$api_image" "$web_image"; do
  [[ "$release_image" =~ ^ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Only GHCR sha256 image digests are accepted.' >&2; exit 1; }
done
# Preserve the previous deployment configuration for an operator-led rollback.
umask 077
mkdir -p "$DRIFTOPIA_ROOT/backups"
cp -- "$DRIFTOPIA_ENV_FILE" "$DRIFTOPIA_ROOT/backups/environment-$(date -u +%Y%m%dT%H%M%S)-$$.env"
python3 - "$DRIFTOPIA_ENV_FILE" "$api_image" "$web_image" <<'PY'
import os, sys, tempfile
path, api, web = sys.argv[1:]
updates={'API_IMAGE':api,'WEB_IMAGE':web}
lines=[]
for line in open(path):
    key=line.partition('=')[0]
    if key in updates:
        lines.append(f'{key}={updates.pop(key)}\n')
    else:
        lines.append(line)
lines.extend(f'{key}={value}\n' for key,value in updates.items())
fd, temp=tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)))
with os.fdopen(fd,'w') as target:
    target.writelines(lines)
os.replace(temp,path)
PY
exec "$DRIFTOPIA_ROOT/scripts/deploy.sh"
