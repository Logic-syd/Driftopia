#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/deploy-common.sh"
# env files use plain KEY=value values (not executable shell).
python3 - "$DRIFTOPIA_ENV_FILE" <<'PY'
import os, re, sys
values={}
for line in open(sys.argv[1]):
    line=line.strip()
    if line and not line.startswith('#'):
        key, value=line.split('=', 1)
        values[key]=value.strip().strip('"').strip("'")
for key in ('POSTGRES_PASSWORD','POSTGRES_OWNER_PASSWORD','POSTGRES_APP_PASSWORD','REDIS_PASSWORD','METRICS_TOKEN'):
    value=os.environ.get(key,values.get(key,''))
    if not re.fullmatch(r'[a-fA-F0-9]{64}',value):
        sys.exit(f'{key} must be an independently generated 64-character random hex value')
domain=os.environ.get('DOMAIN',values.get('DOMAIN',''))
if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',domain) or domain.endswith('.example.com'):
    sys.exit('DOMAIN must be a real DNS hostname, without a scheme or path')
PY
# Bind-mounted public configuration must be readable by non-root service users,
# including checkouts created with a restrictive umask. Never chmod secrets here.
chmod 755 "$DRIFTOPIA_ROOT/infra/database/01-roles.sh"
chmod 644 "$DRIFTOPIA_ROOT/infra/monitoring/prometheus.yml" "$DRIFTOPIA_ROOT/infra/monitoring/alerts.yml"
"${compose[@]}" pull
"${compose[@]}" up -d --wait postgres redis
# Back up even before the first migration, so every deployment has a recovery point.
"$DRIFTOPIA_ROOT/scripts/backup-db.sh"
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --wait --wait-timeout 180 api web
"${compose[@]}" exec -T api node -e 'fetch("http://127.0.0.1:3001/api/ready").then(async r=>{if(!r.ok)throw new Error("Readiness failed");console.log(await r.text())})'
echo 'Application and database ready. Verify the real HTTPS domain externally before declaring deployment complete.'
