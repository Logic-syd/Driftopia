# Phase 3A validation — v0.4

Run date: 2026-10-15 UTC. Baseline `8e7aff9` preserved; additive changes in the same TypeScript monorepo. These are local execution results, not a hosted CI or public-release claim.

## Environment and commands

Node.js 24.19.0, pnpm 11.25.0, PostgreSQL 17 and Redis 7 in the existing development environment; API port 3001, Vite 5173. Playwright uses system Chromium via `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. No external deployment credentials or domain were supplied.

| Check                                           | Observed result                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install                                  | `pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store` passed; dependency graph unchanged                                                        |
| Prisma generation / migration / seed            | Client generated; old four immutable migrations retained; new exploration migration applied; missing research templates seeded without overwriting old values |
| Baseline before integration                     | 14 unit + 55 integration passed, zero skipped                                                                                                                 |
| Lint / strict TypeScript / production bundles   | Passed again including the economy model; see final check row                                                                                                 |
| Application unit tests                          | 28/28 passed (14 new exploration rules) before adding model tests                                                                                             |
| Complete PostgreSQL / HTTP / Socket integration | **81/81 passed**, 5 files, zero skipped, 26.37 seconds                                                                                                        |
| Complete Playwright run                         | **9/9 passed**, zero skipped, 2.9 minutes; seven browser scenarios and two protocol checks                                                                    |
| Final model-inclusive static/unit/build checks  | **Passed:** `pnpm lint`, `pnpm typecheck`, **31/31 unit** (zero skipped), **81/81 integration** and `pnpm build`; web/admin/API bundles built                 |
| Public HTTPS, deployed images, hosted CI        | Not executed/verified for v0.4; previous v0.3 drill evidence remains historical                                                                               |

The full integration suite initially failed 1/81 because an existing order-rotation assertion named only `repair` and `green` as possible level-two templates. The new alloy research template is also valid and sorts before them. The assertion now checks for an unlocked level-two template while retaining the no-repeat and three-slot assertions. No order code was disabled or test skipped. The complete rerun above passed.

## What the tests establish

- **Rules:** five level/route gates, minimum ship levels, all fifteen distinct events, bounded cargo across legal ship/region combinations, safe return, visible risk, repairs and upgrades, immutable configuration copies, valid randomness and rare-resource ordering.
- **Real database races:** twenty concurrent dispatches, event choices and claims yield one committed effect each. Tests verify costs, resources, coins, XP, wear and voyage progress. Existing twenty-buyer last-item market contention remains in the full run.
- **Retries and failure recovery:** changed parameters on the same key reject; same intent replays; dropped committed HTTP responses recover; forced PostgreSQL overflow rolls back inventory/XP/claim/receipt and the same key succeeds after correcting the fixture. A full warehouse preserves cargo and the busy ship until space is available.
- **Authority and privacy:** foreign ships/voyages reject, forged reward/time properties reject, early choices and claims reject, and no public exploration response reveals unchosen outcomes. Active ships cannot be repaired, upgraded or dispatched again.
- **Actual process recovery:** one real API child dispatches, exits, a second chooses, exits, and a third claims from the same PostgreSQL voyage. PIDs and child shutdown are controlled. Test fixture timestamps are moved together to exercise transitions; this does not substitute for the browser's real waiting below.
- **Regional reachability:** ten real claims across bay/wrecks/coral/storm/lost open all five regions; zero-initial rare resources arrive in inventory; exploration alloy funds the other two ship kinds; a real research template, explicitly assigned as a test fixture, is delivered through HTTP and settles inputs/coins/XP. This fixture proves reachability and consistency, not a new player's measured progression time.
- **Legacy migration:** a separate temporary PostgreSQL database receives only the old four migrations and seeded old catalog. Eighteen business tables plus old migration metadata retain identical content SHA-256 values after the new migration; inventory constraint/function identity is retained. Eight tests verify new constraints and execute old production, order and market settlement against the migrated save. The test deletes only its own uniquely named database and needs a test role with `CREATEDB`.
- **Browser voyage:** register, collect real initial salvage, build purifier/dock, produce water, build a skiff, pay departure costs, wait the real 30-second outward leg while logged out, log in, choose safe return, wait the real nine-second return, then unload. The test deliberately drops an already committed claim response; retry carries the same key and every resource/coin/XP changes once. Reload preserves the journal and assets. No administrator fixture, fabricated successful response or accelerated server clock is used in this browser flow.
- **Original game:** the full Playwright run preserves two independent players trading with exact reconciliation, construction/placement, production, offline automation, orders, upgrades/expansion, friends/reconnect, discard error feedback and real guest accounts.

Desktop and 390-pixel mobile chart/event views and fleet captures are in [screenshots](screenshots/). The test checks horizontal overflow and JavaScript page errors; screenshots were visually inspected. This is not physical-device frame-rate or battery profiling.

## User acceptance scope

| Scenario                                              | Status                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A — explore, process advanced material, special order | **Partial:** explore → rare inventory → research order/market works; new advanced processing chains await 3B                         |
| B — residents and work/needs                          | **Missing:** 3B; rescue narration does not recruit a resident                                                                        |
| C — shared server weather/events                      | **Missing:** 3C; visual day/night and storm-region descriptions are not authoritative world weather                                  |
| D — shared lighthouse/contributions                   | **Missing:** 3D                                                                                                                      |
| E — seven-day differentiated growth                   | **Partial:** real upgrades/routes plus reproducible scoped model; mature long-term economy, residents and cooperation are unfinished |
| F — engineering reliability                           | **Verified locally for delivered scope:** type/rule/PG/browser checks; hosted CI and production rollout remain unverified            |

## Remaining limits

The economy study is a model, not player telemetry or load testing. See [ECONOMY_BALANCE_REPORT.md](ECONOMY_BALANCE_REPORT.md) for the fifteen persona/seed runs, coin inflation and weak cargo differentiation. This phase does not remeasure 100/500-user performance; [PERFORMANCE.md](PERFORMANCE.md) belongs to v0.3.

Build output warns about the existing large Phaser bundle; it does not fail. PostgreSQL adapter runs emit a `pg` concurrent-query deprecation warning on the pinned pg8 client; no suite failure is suppressed. History retention, one-instance presence/rate limits, physical-device profiling and public release gates remain as documented in the roadmap.
