# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Optional public CA mount is required only in managed proxy environments.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@11.25.0 --strict-ssl=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/game-config/package.json ./packages/game-config/package.json
COPY packages/game-engine/package.json ./packages/game-engine/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
# Keep the heavy steps in one layer: managed Docker uses vfs, which copies
# complete snapshots per RUN. Preserve the JS client across a clean prod install.
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    DATABASE_URL=postgresql://build:build@localhost:5432/build pnpm db:generate; \
    pnpm build; \
    pnpm exec vite build --config apps/admin/vite.config.ts --base /admin/; \
    pnpm exec tsup scripts/migrate.ts scripts/maintenance.ts prisma/seed.ts --format cjs --out-dir dist/ops --external @prisma/client; \
    node -e 'const fs=require("fs"),p=require("path");fs.cpSync(p.resolve(p.dirname(require.resolve("@prisma/client/package.json")),"../../.prisma/client"),"/tmp/generated-prisma",{recursive:true})'; \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules; \
    pnpm install --prod --frozen-lockfile --ignore-scripts; \
    node -e 'const fs=require("fs"),p=require("path");fs.cpSync("/tmp/generated-prisma",p.resolve(p.dirname(require.resolve("@prisma/client/package.json")),"../../.prisma/client"),{recursive:true})'; \
    rm -rf /tmp/generated-prisma

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/api ./dist/api
COPY --from=build --chown=node:node /app/dist/ops ./dist/ops
COPY --from=build --chown=node:node /app/prisma/migrations ./prisma/migrations
COPY --chown=node:node infra/database/apply-grants.mjs ./dist/ops/apply-grants.mjs
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3001/api/ready").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "dist/api/main.js"]

FROM caddy:2.10-alpine AS web
COPY --from=build /app/dist/web /srv/web
COPY --from=build /app/dist/admin /srv/admin
COPY infra/Caddyfile /etc/caddy/Caddyfile
