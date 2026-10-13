# Security model and verification

The API is the authority for inventory, coins, production times and rewards. All economic mutations lock the participating players in sorted order and commit inventory, progress, receipt and audit records together. Listing purchases also lock the listing and conditionally decrement stock. A client cannot select a WebSocket room or submit economic deltas through a socket.

## Accounts and sessions

- Passwords use asynchronous scrypt with random salts; bounded concurrent hashing avoids unbounded worker-pool work. Cookies are HttpOnly, SameSite=Lax and Secure in production; only token hashes are stored.
- HTTP verifies the database session on every request (memoized only within that request). Guest accounts have a fixed expiry, normal economic rules, creation rate limits and rolling 24-hour / lifetime count caps. No shared demo password.
- WebSocket validates the session and Origin, applies connection caps, disconnects the session immediately on logout, schedules expiry and rechecks revocation every 15 seconds. Revalidation failure closes connections.
- Only explicit proxy addresses/CIDRs are trusted. Production API/database/cache ports are internal. Mutating requests reject unexpected Origin and cross-site fetch metadata.

## Replay and retention

Idempotency is scoped to a user and a UUID key. Sorted-object JSON fingerprints allow equivalent parameter order and reject changed intent. Response replay lasts seven days. Maintenance drops expired response payloads while preserving key/hash tombstones; an expired key is rejected, never reopened. Historical v0.2 exact-request hashes remain replay-compatible. Tombstones and financial history still grow and need an archival design before a much larger deployment.

## Limits and disclosure

Authentication and guest creation are limited by IP; authenticated game traffic by verified user ID. Socket connections/messages, active listings and queue lengths are bounded. Deployment defines CPU, memory, process and log limits. All HTTP responses disable caching. Request IDs and sanitized error fingerprints connect user errors to logs; passwords, cookies, bodies and SQL error messages are not logged. Metrics require a secret in production and the public reverse proxy blocks the endpoint.

## Dependency review

During this upgrade, `pnpm audit --prod --audit-level high --json` identified two high advisories in Prisma's optional configuration toolchain: `effect` (GHSA-38f7-945m-qr2g) and `deepmerge-ts` (GHSA-ggr8-5vv4-36mx). Prisma/client/adapter were upgraded together from 6.19.0 to 6.19.3; a scoped `@prisma/config>deepmerge-ts: 8.0.0` override fixes the remaining advisory. Prisma client generation and migration execution were verified after the change. The subsequent production audit reported zero advisories at all severities. This is the registry's current advisory result, not a guarantee of absence of vulnerabilities.

## Explicit limits

Rate counters and presence are single-instance memory; a horizontally scaled deployment needs shared counters and the Socket.IO Redis adapter. No email verification, password recovery, external error service, WAF or independent penetration test is claimed. The target public server/domain has not been supplied; public HTTPS and operating security require deployment verification. Financial records and guest accounts are retained rather than silently deleting accounts involved in trades.
