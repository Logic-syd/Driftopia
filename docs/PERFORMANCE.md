# Performance measurement

This project uses a small custom Node.js load runner, PostgreSQL fixtures, real HTTP requests and `socket.io-client`. It does **not** claim to use k6 or Artillery. Measurements below come from the checked-in JSON artifacts; theoretical or unexecuted capacity is not presented as a result.

Current verified build: **100 users / 69.991 read req/s / p95 21.950 ms; 500 users / 349.907 read req/s / p95 897.283 ms**, with zero HTTP errors and reconciled assets. Burst writes at 500 users remain slow. See the [verified results](#verified-current-build-load-results) and the explicit [provenance correction](performance/PROVENANCE_CORRECTION.json) for earlier exploratory runs.

## Reproduce

Start PostgreSQL/Redis, apply migrations and seed order templates using the root README. Use a disposable local database or an explicitly authorized staging database. The runner creates isolated `perf-<UUID>-…@example.test` accounts, real persisted session hashes, starter islands, production job snapshots and inventory-backed market listings. It removes only its own account IDs and associated data in `finally`. SIGINT/SIGTERM request a graceful cleanup; SIGKILL or a machine crash can leave fixture accounts, which should be removed by their exact run UUID. Never delete unrelated players to reset a benchmark.

Start a **separate compiled API process**, so source hot reloads cannot interrupt a run:

```bash
pnpm exec tsup apps/api/src/main.ts --format cjs --out-dir dist/perf-api --sourcemap --external @prisma/client
PORT=3003 DB_POOL_MAX=20 PERF_LAUNCH_MANIFEST=/tmp/driftopia-perf-launch.json \
  pnpm exec tsx scripts/perf-server.ts > /tmp/driftopia-perf-api.log 2>&1
```

The launcher refuses an occupied port, copies the bundle to an immutable SHA-named `.cjs` file, records its real child PID/start timestamp and writes the launch manifest. It forwards normal terminal stop signals to the child. Keep the terminal running; do not assume closing an orchestration tool session stopped its child.

From another terminal, with the same `.env` database/Redis settings, verify identity/readiness without generating load first:

```bash
PERF_CHECK_ONLY=true pnpm perf
```

Then run the two workloads:

```bash
PERF_USERS=100 PERF_DURATION_SECONDS=30 DB_POOL_MAX=20 \
  PERF_BASE_URL=http://127.0.0.1:3003 pnpm perf

PERF_USERS=500 PERF_DURATION_SECONDS=30 DB_POOL_MAX=20 \
  PERF_BASE_URL=http://127.0.0.1:3003 pnpm perf
```

`PERF_LAUNCH_MANIFEST` defaults to `/tmp/driftopia-perf-launch.json`. Verified benchmarking requires Linux `/proc` (use Linux, WSL or a Linux container); native Windows game startup is supported separately, but this process-verification path is not native-Windows compatible. Linux `/proc/PID/cmdline`, artifact hash and API uptime checks are **required by default**. An explicit `PERF_ALLOW_UNVERIFIED=yes` without a manifest opts into `exploratory-unverified` mode and leaves `apiArtifactSha256` null; do not present such a run as a verified build measurement. For remote targets process verification needs a separate attestation method; the explicit exploratory flag does not supply one.

Stop the exact recorded process, then confirm the PID has exited and its port is no longer listening:

```bash
node -e "const fs=require('node:fs'); process.kill(JSON.parse(fs.readFileSync('/tmp/driftopia-perf-launch.json','utf8')).pid,'SIGTERM')"
ss -lnt 'sport = :3003'
```

`PERF_ORIGIN` defaults to `http://localhost:5173` and must be in `WEB_ORIGINS`. If the API sets `METRICS_TOKEN`, give the runner that same secret through the environment; the runner never writes it to results. Production metrics always require a token. `PERF_RUN_ID` accepts a UUID for traceability. HTTP rate limits, WebSocket authentication and connection caps stay enabled: 240 authenticated requests/minute/user, 4 sockets/user, 600 sockets/IP and 1,000 sockets/instance by default. The intended traffic is below each user's request limit. Remote targets require explicit `PERF_ALLOW_REMOTE=yes`; the default only permits loopback hosts.

Do not run integration/E2E suites or rebuild application assets during measurements. The load command exits nonzero on HTTP/socket errors or failed economic reconciliation and still writes the completed run's results. Setup errors are reported on stderr and are not reported as successful benchmark runs.

## Workload and measurement boundaries

Every run holds 100 or 500 authenticated Socket.IO connections for all three measured phases. Connections ramp in batches of 25. A warmup reads each player's authoritative state; setup, socket ramp and warmup are excluded from latency/throughput figures.

| Phase             | Duration            | Work                                                                                                                                                                                                                                                            |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steady reads      | At least 30 seconds | Every player reads `/api/state` every 5 seconds and `/api/market` every 2 seconds, with evenly distributed start offsets. The 500-user target is 350 combined requests/second.                                                                                  |
| Production claims | At least 30 seconds | Three waves at 0/12/24 seconds claim three immutable persisted jobs per player. Each wave schedules every participant within a 475 ms window. Jobs have real server-validated completion times; their timestamps are never changed during the phase.            |
| Market purchases  | At least 30 seconds | Three waves at 0/10/20 seconds. Each player buys one resource from the next player's listing, so every participant acts as buyer and seller. Listings have four escrowed units at a price of 7; normal fee, capacity, locks, audit and idempotency paths apply. |

This is a **closed-loop** generator: at most one pending request per player and endpoint. Under saturation it does not enqueue unlimited catch-up requests. Results include intended request count alongside actual throughput; low errors alone do not demonstrate the intended request rate was sustained. Claim/purchase throughput is averaged over the whole burst phase, including time between waves. Latency percentiles include failed HTTP requests; errors are broken down by status/code. The request timeout is 30 seconds.

The runner records every request latency and samples server metrics and `pg_stat_activity` approximately once per second. API CPU is the change in process user+system CPU time divided by elapsed wall time; **100% means one CPU core**, not all assigned cores. RSS is the API process peak observed by sampling. PostgreSQL connections include other connections to the same database plus the monitor; active counts include the sample query itself. Cgroup memory covers the entire shared workspace, not only the API. Socket counts come from the server gauge and independently from clients.

The load generator receives real socket events but does not perform browser refreshes in response to every notification. Thus it measures authenticated connection/event transport cost but **does not model additional frontend refresh amplification**. It excludes TLS, Internet RTT, web asset loading, rendering, password hashing, autoscaling and multi-instance coordination. These are local backend measurements, not a claim that a public deployment supports 500 simultaneous browsers at the same latency.

Post-run reconciliation checks that participants' combined coins decreased only by trade fees and that inventory water plus market escrow equals initial water plus outputs from collected jobs. All fixture mutations are removed after recording the result. No measured operation bypasses the server's economy implementation.

## Environment

Recorded from the actual managed workspace: Node.js 24.19.0, Prisma Client 6.19.3, pg 8.23.1, PostgreSQL 17.11, Redis 7.4.11, AMD EPYC 9V74 with 4 available CPU cores (`cpu.max = 400000 100000`), 32 GiB cgroup memory limit. The API, PostgreSQL, Redis, load generator and idle development services share the host. Each main run records the exact CPU model, OS, Redis version, data counts, timestamp and source revision/dirty flag. The API pool is 20 connections. The API was a compiled host process, not the resource-limited production Compose container; deployment-specific CPU/memory limits were not applied to these runs. These short runs are not endurance or memory-leak tests.

## Measured query/cache optimization

A repeatable low-load microbenchmark directly invokes `leaderboard("prosperity")` against real PostgreSQL and Redis. It uses 1,000 temporary profiles/listings plus 27 pre-existing users and 5 existing listings; five warmup calls, then 60 serial calls and 60 calls in batches of 10. It excludes HTTP and authentication.

| Leaderboard service | Before p50 / p95 / p99         | After p50 / p95 / p99       | Before → after throughput |
| ------------------- | ------------------------------ | --------------------------- | ------------------------- |
| Serial              | 17.790 / 30.535 / 37.001 ms    | 4.015 / 8.920 / 16.153 ms   | 50.231 → 201.905 req/s    |
| 10 concurrent       | 139.990 / 169.620 / 170.811 ms | 26.161 / 48.480 / 53.321 ms | 67.577 → 289.926 req/s    |

Before, every leaderboard read rebuilt all three Redis sorted sets from the entire progress table. After, reads use the existing cache until its week/version marker expires, with a single in-process rebuild in flight. Committed player writes update the affected scores. The connection pool also changed from the pg default of 10 to an explicit 20; this is **not a controlled single-variable experiment**. Serial p95 improved by about 70.8%, concurrent p95 by about 71.4% in these runs.

The default market query at 1,005 listings changed from `Seq Scan → top-N Sort` to `Index Scan` using `MarketListing_status_createdAt_idx`. A single `EXPLAIN (ANALYZE, BUFFERS)` reported 0.821 ms before and 0.039 ms after. These are individual query-plan observations, not stable end-to-end latency percentiles or proof at a larger data size.

Artifacts: [before](performance/leaderboard-before.json), [after](performance/leaderboard-after.json). Re-run on the current implementation with `pnpm exec tsx scripts/perf-baseline.ts recheck`; it creates a separately named JSON file. Running `before` on current code does not recreate the old implementation.

## Exploratory first load results (runtime provenance not attested)

Measured on **2026-10-13 UTC**, against a real API on port 3003. The coordinator paused other builds and test suites for the measurement window. A later restart investigation found that terminating the tool session had left the older API child running. The first runner's bundle hash and Prisma version were read from **files on disk**, so those fields do not attest what the running process had already loaded. The HTTP, WebSocket, resource and economic measurements below remain real observations, but **these runs are exploratory and are not a controlled version comparison or final-build measurements**. See the preserved [provenance correction](performance/PROVENANCE_CORRECTION.json).

An attempted rerun, [run 4b631aa3](performance/load-100-4b631aa3-290e-4ad9-9757-79ced7772baf.json), also reached the retained listener after the new process reported `EADDRINUSE`. It was deliberately interrupted, all clients disconnected, and it is **invalid/excluded**. Its raw file is retained. The old API PIDs were subsequently terminated directly, port 3003 was verified free, and fixture cleanup was confirmed before launching the verified rerun.

| Online sockets | Phase          | Actual / planned requests | Duration | Throughput    | p50 / p95 / p99 (ms)              | HTTP errors |
| -------------- | -------------- | ------------------------- | -------- | ------------- | --------------------------------- | ----------- |
| 100            | Steady reads   | 2,100 / 2,100             | 30.005 s | 69.988 req/s  | 7.888 / 20.812 / 25.808           | 0           |
| 100            | Claim waves    | 300 / 300                 | 30.003 s | 9.999 req/s   | 479.301 / 604.659 / 619.832       | 0           |
| 100            | Purchase waves | 300 / 300                 | 30.005 s | 9.998 req/s   | 609.451 / 837.925 / 873.532       | 0           |
| 500            | Steady reads   | 6,000 / 10,500            | 33.870 s | 177.148 req/s | 4,490.444 / 7,343.843 / 7,509.970 | 0           |
| 500            | Claim waves    | 1,500 / 1,500             | 30.004 s | 49.993 req/s  | 2,633.773 / 4,171.216 / 4,219.719 | 0           |
| 500            | Purchase waves | 1,500 / 1,500             | 30.002 s | 49.997 req/s  | 3,636.244 / 5,490.144 / 5,563.950 | 0           |

**The 500-user high-frequency read workload saturated this instance.** Its intended rate was 350 req/s; the closed-loop generator delivered only 177.148 req/s and 6,000 of 10,500 planned requests. Requests in flight extended the 30-second send window to 33.870 seconds. Zero errors and 500 established sockets do not make this a successful 500-active-player latency target. The 100-user read scenario sustained its intended 70 req/s. No production capacity guarantee is inferred from either run.

Read endpoint details:

| Online sockets | Endpoint      | Requests | Throughput   | p50 / p95 / p99 (ms)              |
| -------------- | ------------- | -------- | ------------ | --------------------------------- |
| 100            | `/api/state`  | 600      | 19.997 req/s | 18.004 / 24.940 / 29.388          |
| 100            | `/api/market` | 1,500    | 49.992 req/s | 7.162 / 10.686 / 14.418           |
| 500            | `/api/state`  | 3,000    | 88.574 req/s | 4,260.626 / 4,689.073 / 4,753.730 |
| 500            | `/api/market` | 3,000    | 88.574 req/s | 6,067.463 / 7,443.481 / 7,525.184 |

Server resources, sampled approximately once per second:

| Online sockets | Phase          | API average CPU (one core = 100%) | API sampled peak RSS | DB sampled peak connections / active | WS peak / final |
| -------------- | -------------- | --------------------------------- | -------------------- | ------------------------------------ | --------------- |
| 100            | Steady reads   | 39.172%                           | 285.1 MiB            | 23 / 2                               | 100 / 100       |
| 100            | Claim waves    | 11.171%                           | 288.4 MiB            | 22 / 2                               | 100 / 100       |
| 100            | Purchase waves | 13.942%                           | 288.6 MiB            | 22 / 10                              | 100 / 100       |
| 500            | Steady reads   | 111.583%                          | 549.3 MiB            | 23 / 2                               | 500 / 500       |
| 500            | Claim waves    | 47.247%                           | 549.3 MiB            | 22 / 3                               | 500 / 500       |
| 500            | Purchase waves | 63.234%                           | 547.1 MiB            | 23 / 5                               | 500 / 500       |

The database contained 127/527 total users and 105/505 listings in the 100/500 runs, respectively. Persisted production jobs at measurement end were 405/1,605, including 105 pre-existing jobs. All 100/500 test sockets remained connected with no reported disconnect or monitoring errors. Economic reconciliation passed: the 100-user run collected 300 jobs and completed 300 trades, leaving 99,700 combined coins after 300 in fees; the 500-user run collected 1,500 jobs and completed 1,500 trades, leaving 498,500 combined coins after 1,500 in fees. Inventory plus escrow also reconciled exactly. These are prepared performance fixtures, not a claim that 500 players registered or completed onboarding during the benchmark.

All requests, sampled resource values, errors, environment metadata and reconciliation totals are preserved in [100-user raw results](performance/load-100-046d0444-4dab-4668-a882-365e52f7920c.json) and [500-user raw results](performance/load-500-06bfac24-fcfb-4ae2-9fb6-ba596b28dcdc.json). Both runner invocations exited 0 and removed their fixture data. The 500 high-frequency throughput shortfall remains a recorded limitation despite the absence of transport/server errors.

## Verified current-build load results

The corrected runner can take `PERF_LAUNCH_MANIFEST`: it verifies the recorded PID's command line points to an immutable hash-named bundle, checks the SHA-256 before/after launch and checks server metrics uptime against the recorded start time. The new API was launched at 2026-10-13T05:02:59.982 UTC as PID 1013147 from `main-7838b7d8a281e38d43133001c7ec983613b9ddc655ac40e62c02b5d2e5c7e9fb.cjs`. Its listening log, successful readiness response and matching uptime were verified before traffic.

Both verified runs completed with zero HTTP, socket or monitoring errors. All planned requests were delivered. The 500-user high-frequency read scenario reached its intended 350 req/s; its p95 remained **897.283 ms**, so it should not be described as uniformly low-latency gameplay. Simultaneous 500-account write waves remain slow: claim p95 **4.383 seconds**, purchase p95 **5.921 seconds**.

| Online sockets | Phase             | Actual / planned | Duration | Throughput    | p50 / p95 / p99 (ms)           | Errors |
| -------------- | ----------------- | ---------------- | -------- | ------------- | ------------------------------ | ------ |
| 100            | steady_reads      | 2,100 / 2,100    | 30.004 s | 69.991 req/s  | 5.926 / 21.950 / 28.744        | 0      |
| 100            | production_claims | 300 / 300        | 30.003 s | 9.999 req/s   | 454.503 / 594.234 / 610.407    | 0      |
| 100            | market_purchases  | 300 / 300        | 30.005 s | 9.998 req/s   | 720.103 / 925.599 / 972.014    | 0      |
| 500            | steady_reads      | 10,500 / 10,500  | 30.008 s | 349.907 req/s | 192.146 / 897.283 / 1095.636   | 0      |
| 500            | production_claims | 1,500 / 1,500    | 30.004 s | 49.993 req/s  | 2816.911 / 4382.524 / 4591.772 | 0      |
| 500            | market_purchases  | 1,500 / 1,500    | 30.006 s | 49.990 req/s  | 3919.430 / 5920.705 / 6123.533 | 0      |

Read endpoint detail:

| Users | Endpoint      | Requests | Throughput    | p50 / p95 / p99 (ms)         |
| ----- | ------------- | -------- | ------------- | ---------------------------- |
| 100   | `/api/market` | 1,500    | 49.993 req/s  | 5.143 / 8.985 / 13.039       |
| 100   | `/api/state`  | 600      | 19.997 req/s  | 17.544 / 27.675 / 32.286     |
| 500   | `/api/market` | 7,500    | 249.933 req/s | 123.026 / 823.700 / 1117.029 |
| 500   | `/api/state`  | 3,000    | 99.973 req/s  | 296.745 / 917.492 / 1031.912 |

Sampled server resources:

| Users | Phase             | API CPU (one core = 100%) | API peak RSS | DB connections / active | WS peak / final |
| ----- | ----------------- | ------------------------- | ------------ | ----------------------- | --------------- |
| 100   | steady_reads      | 34.052%                   | 261.1 MiB    | 23 / 2                  | 100 / 100       |
| 100   | production_claims | 11.108%                   | 275.2 MiB    | 22 / 2                  | 100 / 100       |
| 100   | market_purchases  | 14.892%                   | 284.6 MiB    | 22 / 11                 | 100 / 100       |
| 500   | steady_reads      | 103.561%                  | 400.9 MiB    | 23 / 3                  | 500 / 500       |
| 500   | production_claims | 50.188%                   | 401.1 MiB    | 22 / 4                  | 500 / 500       |
| 500   | market_purchases  | 67.142%                   | 401.2 MiB    | 22 / 4                  | 500 / 500       |

The verified 100/500 databases contained 135/535 users, 107/507 listings and 439/1,639 production jobs at measurement end. API pool size was 20, and all original limits stayed enabled. The 100 run completed 300 claims and 300 trades; the 500 run completed 1,500 claims and 1,500 trades. Both reconciled every participant coin and produced/escrowed water. The original 35 non-fixture users were retained.

The current implementation caches public market listings for one second with bounded keys and in-flight request coalescing. Committed market mutations invalidate the cache; purchases always validate PostgreSQL. Unchanged state reads reuse the already loaded player/building/inventory snapshot when checking automatic production. These changes followed the exploratory saturation finding. Because the first run lacked runtime attestation and the pre-existing data counts also changed, the numeric difference is **not presented as a controlled causal improvement percentage**.

Artifacts: [verified 100-user run](performance/load-100-8afe0f61-03a2-4d29-8a00-45a17e30c55e.json), [verified 500-user run](performance/load-500-a1826216-348c-4a53-8c98-6eb55143507a.json), [fixture/socket/process cleanup verification](performance/verified-cleanup.json). Both artifacts embed matching PID, launch time, immutable bundle SHA and successful command-line/uptime verification. Fixture users and WebSockets were confirmed at zero before the exact PID received SIGTERM; the process disappeared and port 3003 was empty.

The reusable launcher was then independently checked with a fresh PID: launch → readiness + runtime identity check → a second launch on the occupied port correctly rejected with EADDRINUSE → exact-child SIGTERM → process exit and empty port. This smoke check created no load fixtures.

## Remaining performance work

- Run a longer distributed/browser-aware test over HTTPS on the actual demo hardware, including notification-triggered refreshes and mobile asset/render timings.
- Test larger persisted histories and automated production queues. State reads currently hold a per-player transaction lock and perform authoritative settlement plus several queries.
- **P2: reduce measured write-wave tail latency.** The verified 500-user claim/buy p95 values remain 4.383/5.921 seconds. Profile per-player lock wait, transaction/ORM query counts and API event-loop delay before changing pool or locking semantics.
- **P2: mixed-load and endurance evidence is missing.** The measured phases run sequentially; constant market reads combined with frequent trade invalidations may receive less cache benefit. Test genuine browser refresh amplification, longer-lived large histories and production container limits over HTTPS. Preserve the exploratory saturation result and invalid-run correction alongside future measurements.
- Current Socket.IO rooms and in-process rate limiting are designed for one API instance; more instances require a Redis adapter, shared rate-limit storage and cache rebuild coordination.
