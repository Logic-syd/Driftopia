# Roadmap and release boundaries

Source implementation, executed tests and a live deployment are different milestones. This roadmap records scope; [validation](VALIDATION.md) records observed acceptance results, [performance](PERFORMANCE.md) records measurements, and [deployment](DEPLOYMENT.md) records release status.

## Delivered foundation

- [x] TypeScript monorepo, React/Phaser game, NestJS API, PostgreSQL/Redis and separate admin UI.
- [x] Real accounts and initial islands; server-authoritative salvage, construction, movement, upgrades and expansion.
- [x] Persisted recipe snapshots, manual production, bounded automatic production and offline recovery.
- [x] Merchant orders, currency/XP, progression, warehouse limits and an explicit resource-discard escape hatch.
- [x] Escrow market, bulk purchase totals, transaction history, owner-only listing retrieval, cancellation and atomic settlement.
- [x] One-way friends, public read-only island visits and three derived leaderboards.

## Portfolio upgrade implementation

- [x] Canonical idempotency fingerprints, legacy compatibility, expiry rejection and response compaction with retained tombstones.
- [x] Async bounded password hashing, transactional account/session creation and real guest accounts with fixed lifetime and quotas.
- [x] Session/Origin-authenticated Socket.IO, private rooms, revocation, connection limits, invalidation envelopes and snapshot recovery.
- [x] Structured request/error logs, request IDs, separate liveness/readiness and protected Prometheus metrics.
- [x] Normal ranking cache hits avoid full rebuilds; targeted indexes and bounded database pool configuration. The public market view has a one-second bounded cache with concurrent-query sharing and commit invalidation; state settlement reuses its locked snapshot.
- [x] Real PostgreSQL contention and rollback scenarios, transport/security tests and expanded browser acceptance scenarios. Results belong in the validation report; source presence alone is not a pass.
- [x] Reproducible 100/500-user workload harness with raw-artifact and environment reporting; only completed runs in the performance report count as measurement evidence.
- [x] Same-origin production Compose/Caddy configuration, build/release quality gates, constrained services and backup/restore scripts. Runbook evidence distinguishes local smoke checks from public deployment.
- [x] Guest entry, network/retry states, discard confirmation, keyboard modal focus and a five-step tutorial.
- [x] Placement ghost/validity feedback, smooth camera controls, confirmed salvage effects, production bubbles, visual day/night cycle, optional sound and reduced motion.
- [x] Source-backed technical audit, architecture diagrams, data model, API contracts, five ADRs and explicit trade-offs.

## P0 — correctness gates to preserve

- Run lint, typecheck, unit tests, real PostgreSQL integration tests, build and browser acceptance for every release candidate. A failed stage blocks release.
- Keep twenty-way last-item contention, repeat collection, build/trade races, buy/cancel races, dropped-response retries and rollback recovery in the test suite.
- Apply additive migrations to existing saves and preserve audit, escrow and command-replay invariants.
- Do not accept frontend-only rewards, cache-derived balances or socket-only durable state.

## P1 — public release remains conditional

- [ ] Provision a deployment target, owned DNS name and scoped deployment credentials; run the protected release workflow against it.
- [ ] Verify remote CI for the exact deployed commit and record its run URL. GitHub API access from this workspace returned 403; hosted run status remains unknown.
- [ ] Complete public HTTPS acceptance from an external browser using two accounts, including reconnect and offline production.
- [ ] Run backups on a schedule, keep copies away from the application host and repeat a restore drill on the actual target.
- [ ] Connect persistent metrics/log collection and alert delivery; exported metrics and documented alerts alone do not deliver notifications.
- [ ] Define production retention and deletion: audit/history, old jobs/orders, guest accounts and idempotency tombstones. Guest conversion/account recovery is not implemented.
- [ ] Add email verification, password recovery, session management and account deletion before expanding beyond a bounded demo.

## P2 — measured performance and product depth

- [ ] Repeat load tests against the final HTTPS topology with a separate generator and representative long-lived player data. Investigate state synchronization query/lock cost and authentication bursts before increasing limits.
- [ ] Evaluate narrower state reads, production/config query reuse, cursor pagination and leaderboard repair cadence against measured workloads.
- [ ] Revise the optimistic economic simulation for automatic queues and real session cadence; tune currency sinks, XP, order cadence and production duration.
- [ ] Measure the tutorial with first-time players. Five minutes is a design goal, not a measured completion-time claim.
- [ ] Profile physical mobile devices, browser audio restrictions, battery use and large-island rendering; headless Chromium coverage is insufficient for those claims.
- [ ] Plan longer offline progress explicitly. Current queues are thirty prepaid batches, not eight hours of catch-up rewards.

## P3 — deliberately deferred

- Bilateral friend requests, invitations, social moderation and a fully navigable friend's Phaser island.
- Resident needs, exploration, cooperative events, task chapters, character movement and richer weather/audio.
- WeChat Mini Game bridges and platform-specific publishing.
- Multi-instance scaling: distributed rate limits, shared presence, Socket.IO Redis adapter, coordinated cache rebuilds and possibly a durable outbox.
- Multi-region availability, season archives and a commercially balanced content roadmap.

No unchecked deployment item is satisfied by a local development port, a workflow YAML file, or a screenshot. The latest audit-to-implementation history is in [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md).
