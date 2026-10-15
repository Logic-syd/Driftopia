# Phase 3 — Living Ocean incremental gameplay plan

## Source audit and scope

Baseline: `8e7aff9` (v0.3), inspected directly before edits. The working tree was clean. Existing PostgreSQL/Redis and API readiness respond successfully; historical test results are not substituted for this phase's regression run.

- React/Phaser/Zustand client; Nest modular monolith; shared configuration and pure rules; Prisma/pg, PostgreSQL 17, Redis ranking cache, authenticated Socket.IO invalidations.
- Eight resources, eight buildings. Real salvage, bounded manual/automatic production, upgrades, orders, escrow trading, one-way friends and read-only visits are implemented. `dock` only gates trading; `cabin` only adds prosperity. Decorative boats/islands are not controllable exploration content.
- Four immutable migrations; per-player advisory locks and transaction-scoped idempotency/audit are the correct extension point. Reads must not silently award exploration cargo. New resource IDs also require updating the PostgreSQL inventory-validation function and server-side validation; changing TypeScript alone is insufficient.
- Current water/fish have zero input costs, seaweed is cheap, five recurring order templates mint coins/XP, and parts have few sinks. Existing economic simulation does not accurately model queue/offline/session constraints. Do not cite it as measured player progression.
- No Ship/Expedition, residents, global weather, shared lighthouse or cleanup activity models exist. There is no current public demo deployment. No existing save or applied migration will be reset or rewritten.

## Ordered implementation

This execution prioritizes **the complete Phase 3A vertical slice**, as explicitly permitted by the request. Supporting UI, security tests and a scoped economy simulation accompany it. The remaining phases are planned, not claimed as implemented.

| Phase                         | Increment                                                                                                                                                                                    | Completion gate                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 3A (current)                  | Five regions, three ship types, ship upgrades/repair, persisted trips, at least 15 original decision events, server-generated cargo, offline return, exploration journal and interactive map | Real-account browser voyage and original game flow; real PostgreSQL races/rollback/IDOR; additive legacy-save migration; lint/typecheck/build |
| 3B (next)                     | Three multilevel production chains, specializations, production overview/bulk claim, recruitable residents/work/needs                                                                        | Job snapshots freeze specialization/worker effects; assignment uniqueness; recoverable low-pressure needs; advanced-material order scenario   |
| 3C (next)                     | Persisted shared weather schedule, visiting merchants and periodic world events                                                                                                              | Two users observe identical server state; restarts preserve schedule; running jobs retain their effects snapshot                              |
| 3D (next)                     | Shared multistage lighthouse, transactional contributions, claims, cleanup scoring/ranks                                                                                                     | Player + project lock order, unique contribution receipts and reward claims; concurrent two-user browser completion                           |
| 3E (incremental, partial now) | Exploration visuals, readable choices and fleet feedback now; residents/weather animation and full seven-day all-system balancing later                                                      | Actual screenshots, device tests, reproducible simulation assumptions and explicit limitations                                                |

## 3A rules and persistence

- Ships: wooden skiff, salvage boat, exploration sailboat; one of each type per player (three maximum), levels 1–3, bounded durability/cargo/speed/storm resistance. Build/upgrade/repair consume existing resources and coins. Durability loss is repairable; ships are never permanently destroyed.
- Regions: quiet bay, wreck field, coral islands, storm sea and lost shipping lane. Each has levels, prior-voyage progress, minimum/recommended ship level, duration, risk, supplies and a configured loot pool. Map nodes form a visible connected route.
- Dispatch requires the player's trading dock, own idle ship, unlocked region, sufficient durability and supplies. It atomically charges costs and persists immutable ship/region/event/risk/reward snapshots. A partial unique index permits only one active voyage per ship. Rare seeds/alloy/relics gain real inventory, market and research-order uses; deeper processing belongs to 3B.
- Server crypto randomness selects the event and precommits hidden option outcomes at dispatch. The public response never exposes random values, hidden outcomes or unchosen rewards. This prevents polling/retry/reroll exploits and insulates active voyages from future configuration changes.
- A persisted arrival timestamp opens a decision; safe return is always available. Other choices offer explicit probabilities, costs and damage/loot trade-offs. Rescue events escort stranded sailors to safety and record the outcome; they do not pretend to implement the future resident recruitment system.
- A choice atomically charges its cost, fixes its already-committed result, applies repairable damage and schedules return. A return timestamp makes cargo claimable. Claim atomically transfers bounded cargo, coins and XP, records completion and frees the ship. A full warehouse preserves the cargo; clearing inventory allows a retry. No deadlines punish a player who stays offline.
- Every economic action reuses existing player locks, idempotency fingerprints, receipts and transaction audit. Same-key altered parameters reject. Reads only derive the current phase from server time and persisted timestamps; there is no in-memory task timer or required worker process.
- Socket.IO reuses authenticated state invalidation. The UI reloads exploration from the database after actions, reconnect and arrival boundaries. HTTP state remains authoritative.

## Validation and acceptance boundaries

Add real PostgreSQL tests for twenty concurrent dispatches/claims, simultaneous event choices, ownership, forged rewards, insufficient resources, full-warehouse recovery, database failure rollback, deterministic persisted outcomes and independent-process recovery. Verify migration from the previous schema using preserved player records. Run the original production/market suites and browser flows again.

The new browser flow must build a real boat, dispatch, genuinely log out/wait/log in, choose an event, return and claim exactly once. Five map regions must show actual unlock reasons and prices; locked routes do not simulate success. Capture mobile/desktop exploration views.

Full user scenarios A (advanced processing), B (residents), C (shared weather), D (lighthouse) and complete seven-day E remain incomplete until 3B–3E. This slice demonstrates exploration → real inventory → research order/market, not the unimplemented advanced-processing chain. Scenario F covers the code actually delivered.

## Economy model plan

Create a reproducible, seeded model at 30 minutes, 2 hours, 24 hours, day 3 and day 7 for casual (20 min/day), regular (45 min/day) and active (120 min/day) policies. Include finite offline queues, storage, voyage/decision timing, ship costs/repair, order limits and realistic active sessions. Separate modeled results from measured browser behavior. Do not invent resident costs, world-event rewards, player market prices or full Phase 3 balance before those systems exist. Report bottlenecks and the remaining inflation/long-term balance risk in ECONOMY_BALANCE_REPORT.md.

## Execution record

- Audit completed against source/schema/config/tests; existing services ready. Baseline regression re-executed: 14/14 unit and 55/55 real PostgreSQL/HTTP/Socket integration passed (zero skipped), before the new modules were integrated. Additive implementation follows.

- Phase 3A implementation completed: shared rules/config/transport types; additive Ship/Expedition persistence; six strict transactional commands; read-only private snapshot; three new resources and research templates; interactive map/fleet/event/journal UI and actual moored ships.
- Verification completed: 31 unit, 81 real PostgreSQL/HTTP/Socket integration and 9 Playwright checks passed with no skips. Includes separate legacy-save migration and three-process task restoration, real browser logout/wait/retry, original market and production regression. See PHASE3_VALIDATION.md for failed-first-run correction and exact limits.
- Seeded economy study executed: 15 persona/seed runs and 75 checkpoints. Current demo pacing causes large coin/XP accumulation, and the larger holds do not increase cargo under current loot maxima. These remain P1 tuning issues; residents, advanced chains, world weather and cooperation remain pending Phase 3B–3E.
