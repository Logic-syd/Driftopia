# v0.3 acceptance evidence

This report distinguishes current-workspace verification from remote CI and public deployment. The original v0.2 baseline is preserved in [TECHNICAL_AUDIT.md](TECHNICAL_AUDIT.md); changes and corrective reruns are in [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md).

## Environment and reproducibility

Node.js 24.19.0, pnpm 11.25.0, PostgreSQL 17, Redis 7, Prisma 6.19.3, system Chromium. Tests use the real local PostgreSQL service and HTTP API. Browser tests use independent contexts with separate cookies. No mock repository substitutes for transaction verification.

```bash
bash scripts/setup-cloud.sh
pnpm dev:api
# In another terminal, after /api/ready succeeds:
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm dev:web
# In another terminal, after the UI starts:
pnpm test:e2e
```

For a standard machine, follow the portable instructions in [README](../README.md); setup-cloud.sh deliberately targets this managed workspace. Playwright normally installs its Chromium build with `pnpm exec playwright install --with-deps chromium`; this workspace used the configured system Chromium fallback.

## Automated checks

| Check                                                                  | Result                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frozen lockfile install; Prisma generation; repeat migration execution | Passed after dependency upgrade; existing databases preserved                                                                                                                                                            |
| ESLint, strict TypeScript, production build                            | Passed: `pnpm lint`, `pnpm typecheck`, `pnpm build` (web, admin and API)                                                                                                                                                 |
| Unit tests                                                             | **14/14 passed**, zero skipped: 8 engine and 6 client transport/refresh                                                                                                                                                  |
| PostgreSQL / HTTP / Socket integration                                 | **55/55 passed**, zero skipped, 15.67 seconds: 37 economy, 14 realtime/security, 4 auth/maintenance                                                                                                                      |
| Playwright                                                             | **8/8 passed, zero skipped**, about 1.8 minutes: 6 browser scenarios and 2 notification protocol checks                                                                                                                  |
| Dependency audit                                                       | `pnpm audit --prod --audit-level high --json`: zero reported advisories at every severity after Prisma upgrade and scoped deepmerge-ts override                                                                          |
| Production image + isolated HTTPS + backup restore                     | Passed: strict TLS game loop (26.02 seconds), owner-role migrations, backup/restore with 11 table-content hashes equal, Redis recovery without API restart, protected Prometheus scrape; see [OPERATIONS](OPERATIONS.md) |
| Remote GitHub Actions                                                  | **Not verified**: GitHub API access returned HTTP 403 in this environment                                                                                                                                                |
| Public HTTPS demo                                                      | **Not deployed**: user confirmed no server/domain is available                                                                                                                                                           |

Tests that initially failed during implementation were diagnosed and rerun; they are not described as successful initial executions. In particular, development API restart, a refresh waiter starvation bug, and a test-wrapper TypeScript error were corrected before final validation.

## Requested acceptance A–F

| Test                       | Status and evidence                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Complete game loop     | **Passed in browser**: register, initial persisted base, salvage, construct, produce, collect, fulfil order, upgrade and expand. The tutorial follows five real progress milestones.                                                                                |
| B — Real multiplayer trade | **Passed in independent browser contexts**: seller escrows 2 water at 7 coins each; buyer loses 14, seller gains 13 after fee, buyer gains 2 water; transaction history and subsequent reload agree. Socket notification refreshes seller assets.                   |
| C — Last-item concurrency  | **Passed against real PostgreSQL and HTTP**: 20 concurrent requests, exactly one purchase and 19 sold-out responses; balances, escrow, inventory and fee remain consistent. Other races cover repeat production collection, build/trade competition and cancel/buy. |
| D — Offline recovery       | **Passed in browser**: enqueue production, perform real logout, wait for server completion, log in, recover and collect. PG tests also cover bounded 72-hour offline automatic queues and concurrent settlement.                                                    |
| E — Automated delivery     | **Partial**: all local CI-equivalent quality checks and isolated production HTTPS deployment passed; remote CI has not been verified. A committed workflow is not evidence that GitHub ran it successfully.                                                         |
| F — Public demo            | **Incomplete**: no public deployment resources. An isolated HTTPS smoke test does not satisfy public browser acceptance.                                                                                                                                            |

The browser suite also covers mobile layout, Canvas hit-testing, real persistent guest play, friend online/offline state and read-only visits, leaderboard display, owned-listing cancellation, failed-action feedback, reconnection and loss of network. Five actual browser captures are committed under [screenshots](screenshots/).

## Consistency and recovery coverage

Real database tests exercise 20-way final-unit buying, repeated reward collection, sorted-player locking during build/trade races, buyer/cancel contention, dropped HTTP responses retried with the same key, and PostgreSQL failure after part of a settlement followed by rollback and same-key recovery. Canonical fingerprints accept object-key reordering and reject changed intent. Expired receipts retain tombstones; old requests never execute again.

Authorization cases cover another player's buildings/jobs/listings/islands, forged rewards, admin endpoints, session expiry/revocation, authentication route aliases, socket origins/rooms/limits and a connection closed during asynchronous authentication. Public market cache tests perform all create/buy/cancel mutations through the actual API and immediately verify the refreshed list.

## Performance and limits

Measurements and raw result files are in [PERFORMANCE](PERFORMANCE.md). Final verified runs share the same immutable bundle and checked PID: 100 users completed 2,700/2,700 requests; 500 users completed 13,500/13,500, with zero HTTP/socket errors and conserved assets. Steady-read throughput was 69.991 / 349.907 requests per second, p95 21.950 / 897.283 ms respectively. At 500 users, production-claim p95 remained 4,382.524 ms and market-buy p95 5,920.705 ms; this does not demonstrate uniformly smooth gameplay under mass writes.

Original exploratory measurements, their runtime-provenance correction and an excluded interrupted run are retained. They are not a controlled causal comparison with the final build. These short tests share one machine with their database and generator, omit browser refresh amplification and TLS, and do not establish public production capacity or a long-duration SLO.

- Phaser's production chunk remains approximately 1.2 MB before compression and emits Vite's chunk-size advisory. Real low-end mobile hardware and slow-network frame times remain unmeasured.
- pg 8.x emits a concurrent-query deprecation warning through the Prisma adapter. Current tests pass; pg 9 compatibility requires verification before upgrade.
- Presence, rate limits and public-market cache are single-process. Horizontal replicas need shared rate counters, Socket.IO coordination and cache invalidation.
- Visual day/night does not change the economy. Friend relationships are one-way bookmarks; visits are read-only. Advanced weather, exploration, residents and cooperative events remain deferred.
- No remote error tracking service, external penetration test, long-term balance study or novice five-minute completion study is claimed.
