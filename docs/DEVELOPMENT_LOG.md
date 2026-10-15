# Upgrade development log

## Stage 0 — Source audit

- Baseline: `53078af`, Driftopia v0.2. Existing checkout preserved; no reinitialization.
- Inspected application code, schema and all 3 SQL migrations, CI/Docker/scripts, unit/integration/browser tests.
- Current API responds with database/Redis connected. Baseline checks: `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint` — 7/7 unit, 21/21 PG, typecheck and lint passed.
- Principal risks: repeated leaderboard rebuild, synchronous password hashing, unbounded receipt history, stale client responses, WebSocket session/origin lifecycle, untested production deployment.
- Deployment environment currently exposes no configured server/domain/cloud identity. Requested the missing deployment target while continuing independent work.

## Stage 1 — Economy, identity and replay

- Added canonical request hashes with pre-upgrade compatibility; seven-day response expiry and non-reusable tombstone compaction. Added asynchronous bounded scrypt, atomic account/session creation and request-local session memoization.
- Added real persistent guest accounts, rolling 24h/total creation quotas, expiry checks and hidden expired-guest listings. Added indexes in `202610130001_reliability`; existing migration checksums retained.
- Fixed pure transaction rules allowing a same-resource output to fund its own missing input. The new regression failed before the fix and passed afterwards.
- Validation: 8 unit and 35 PG economy tests passed. Real HTTP twenty-buyer race: exactly one purchase, nineteen sold-out responses, assets and fee conserved. Response-loss retry and injected PostgreSQL settlement failure recovery passed.
- Auth/maintenance: 4 real PG/HTTP cases passed (guest lifecycle, expiry tombstone, legacy replay and session cleanup).

## Stage 2 — Real-time and observability

- Added authenticated invalidation envelopes, scoped rooms, origin/session/connection enforcement, reconnect full refresh, friend presence and rankings notifications. Added structured logs, request IDs, error fingerprints, protected Prometheus metrics and schema-aware readiness.
- Validation: 12 PG/Socket.IO/HTTP cases passed; typecheck passed. HTTP development services needed restart after edits; initial connection-refused tests were rerun after readiness, not counted as passes.
- Dependency audit initially found two high advisories in Prisma configuration tooling. Upgraded aligned Prisma packages to 6.19.3 and scoped deepmerge-ts8. Post-fix production audit: zero known advisories; client generation and migration replay passed.

## Stage 3 — Deployment and performance

- User confirmed there is no deployment server/domain yet. Public acceptance F remains incomplete.
- Isolated production images and HTTPS readiness with an explicitly trusted local CA were exercised; complete production gameplay and backup/restore follow after the performance window.
- Load tests run in an exclusive window without builds/E2E. Raw results and exact constraints are written by the runner to docs/performance.

## Independent review fixes

- Request-path aliases (case/trailing slash) previously escaped the authentication IP bucket. Canonical controller route matching now selects the same policy; real HTTP tests rotate logged-in cookies and verify the eleventh authentication attempt is 429.
- Public latest-100 listings could hide an older owned listing and its cancel action. Added strictly session-scoped `mine=true` and a My listings tab; real economic fixtures create 101 listings to validate recovery and ownership.
- Frontend transport now bounds response-body reading as well as headers, and retries a lost/truncated response once with the same idempotency key. Refresh waiters complete per serialized round to prevent notification storms from keeping actions busy forever.
- Validation before final visual tests: 53 PG/Socket/HTTP integration cases passed together; client transport regressions passed separately.

## Measured tuning

- Initial100-user load achieved the scheduled load with no errors; initial500-user high-frequency reads saturated (p95 about7.3s) while keeping all sockets and preserving assets. Results are retained, not replaced with an optimistic target.
- Added a bounded one-second public-market display cache with same-key request coalescing, invalidated after market commits; own listings remain direct reads. State settlement now reuses the already locked player snapshot and reloads only if automation changed it. Redis reconnects with capped backoff and no offline command queue. Repeat measurements follow under the same workload; see PERFORMANCE.md for the completed results and limitations.

## Stage 4 — Final regression and browser acceptance

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build` completed successfully: 14/14 unit, 55/55 real PostgreSQL/HTTP/Socket integration, web/admin/API production bundles. Integration took 15.67 seconds; no cases skipped.
- Playwright: 8/8 passed, zero skipped, about 1.8 minutes. Six browser scenarios include genuine logout/wait/login, two independent accounts trading with exact balances, guest, friends, expansion and reconnection; two additional checks cover event ordering/deduplication. Desktop/mobile screenshots refreshed and visually inspected.
- Added immediate HTTP market-cache invalidation and disconnected-during-authentication socket-capacity regressions. The socket test's asynchronous Prisma wrapper needed an explicit type boundary; after correction the full strict check and suite passed.
- Whole-repository format check exposed one pre-existing formatting issue in eslint.config.mjs; normalized its formatting without changing rules.
- Docker initially exhausted the managed vfs disk through duplicated build layers. Only rebuildable Docker cache was removed; database volumes were preserved. Heavy Docker steps were consolidated, and the corrected build reran without bypassing typechecks.

## Stage 5 — Production recovery drill

- Final production application images use Prisma 6.19.3 and a non-root API. Four migrations ran with a non-superuser schema owner; the runtime role cannot create schema objects, elevate roles, read pg_authid, delete users or modify/delete migration and financial audit history. User deletion was explicitly revoked to prevent cascading removal of GameEvent rows.
- Isolated Compose HTTPS gameplay passed in 26.02 seconds with the locally generated CA explicitly trusted. There was no disabled TLS verification and no public-domain claim.
- Redis stop/start produced degraded then connected readiness without changing API container identity/start time or persisted assets. Prometheus reported up=1; private metrics required a token and public metrics returned 404.
- Custom-format backup restored into a new database: 4 users, 1 trade and identical content hashes for all rows of 11 key tables. Existing databases were not overwritten.
- Smoke services stopped before final performance measurements. Public deployment remains unavailable because the user has no server/domain; remote CI status remains unverified after GitHub API 403.

## Performance provenance correction

The first attempt at the final load rerun was stopped after detecting that a previous port-3003 API child process had survived termination of its execution-session wrapper. The new process had failed with EADDRINUSE. That interrupted run is excluded. Original exploratory timing and asset measurements are retained, but their disk-read artifact hash/dependency fields do not establish the exact running process version. Final runs now use an immutable bundle and verify its hash, unique PID, command line, launch time and metrics uptime before measurement; PERFORMANCE.md records this distinction.

## Reusable cloud environment

Updated the saved install_script and start_skill drafts for the current checkout and readiness endpoint. They preserve existing database volumes and changes, restart missing services, use frozen dependencies, and describe verified-process load testing. Draft persistence was confirmed; publication and restoration in a new task have not been performed.

## Stage 6 — Verified load measurements

- Final 100/500 runs used the same immutable artifact SHA and checked process PID, startup time, command line and metrics uptime. Both completed every planned request with zero HTTP/socket errors and correct coin/resource reconciliation.
- 100 users: 2,700 total HTTP requests; steady 69.991 requests/s, p50/p95/p99 5.926/21.950/28.744 ms.
- 500 users: 13,500 total HTTP requests; steady 349.907 requests/s, p50/p95/p99 192.146/897.283/1,095.636 ms. Concentrated production and market writes still have p95 4.38/5.92 seconds; further mixed-load and notification-driven browser measurements remain P2.
- Verified fixture and Socket counts returned to zero; the identified performance process exited and port 3003 was released. Development services were preserved. See PERFORMANCE.md and its raw artifacts for CPU, RSS, database connections, hardware and measurement limitations.

## Final delivery checks

- The reusable performance launcher was exercised for normal startup/readiness, occupied-port rejection, explicit child shutdown and manifest-write failure cleanup. No benchmark API or fixtures remain.
- After the final script changes, whole-repository ESLint and strict TypeScript passed again. Whole-repository Prettier, `git diff --check` and local documentation link checks passed.
- Local automated acceptance totals remain 14 unit + 55 integration + 8 Playwright, all passed with zero skipped in the complete runs. Optional single-case debug runs are not counted as additional acceptance cases.
- The development API remains ready with PostgreSQL, current schema and Redis connected. Public deployment and hosted CI remain separate incomplete acceptance items.

## Phase 3A — Source audit and exploration delivery (2026-10-15)

- Started from clean v0.3 commit `8e7aff9`. Read source/schema/config/tests and reran the 14 unit / 55 integration baseline. Created PHASE3_GAMEPLAY_PLAN.md; selected the explicitly authorized complete 3A slice. No project reinitialization or save reset.
- Added three boat kinds, five route-gated regions, fifteen original encounters, bounded cargo, durability, upgrade/repair and three rare resources with real research orders/shipbuilding/market uses. Dispatch persists cryptographically generated private option outcomes and immutable rule snapshots; choose/claim use existing advisory locks, canonical receipts and audit. No worker or client timer grants cargo.
- Applied additive `202610150001_exploration` without altering four existing migration checksums. Added owner composite FK, unique active voyage per boat and SQL phase/time/value constraints. The inventory validator accepts old saves unchanged and new resources. Runtime grants protect ship/voyage history from direct deletion.
- Added interactive chart, fleet maintenance, departure/choice confirmations, cargo claim/full-warehouse feedback, journal, reconnect snapshot refresh and actual docked-boat scene objects. Screenshots capture real accounts on desktop and 390px mobile. No fake resident/weather/cooperation implementation was added.
- First complete integration run was 80/81: an old test hard-coded only two possible level-two orders, missing new alloy research. Updated the assertion to preserve its unlocked-unseen-template invariant. Full reruns passed; no failing case was skipped or removed.
- Final model-inclusive command chain passed: `pnpm economy:phase3`, lint, strict typecheck, **31/31 unit**, **81/81 integration** (26.37 seconds), and production web/admin/API build. Complete Playwright: **9/9**, zero skipped, 2.9 minutes (seven browser scenarios, two protocol checks). Existing large Phaser chunk and pg8 adapter deprecation warnings are recorded, not suppressed.
- Twenty simultaneous dispatches/choices/claims each committed once; lost response retries and injected PostgreSQL overflow recovered safely. A voyage survived three independently started API processes. Isolated migration tests preserved 18 business tables and old migration metadata by content hash and ran old production/order/market settlement. Browser exploration waited genuine 30s outward/9s return travel across logout; dropped successful claim response retried the original key with exact asset reconciliation.
- Executed 15 seeded economy runs/75 checkpoints with finite sessions, storage, order slots and prepaid queues; seven source hashes verified. Baseline seven-day casual/regular/active balances: 11,862 / 33,640 / 92,412. This exposes inflation, not measured retention. The larger cargo hold currently offers no extra goods under configured loot maxima; both issues remain P1. Phase 3B–3E systems and commercial balance are explicitly unfinished.
- Public deployment is still unavailable without a target/domain. No new cloud performance numbers, hosted CI result or v0.4 production-container drill is claimed. Existing HTTPS/backup/load results belong to v0.3. Development API reports v0.4.0 with database/schema/Redis ready.
