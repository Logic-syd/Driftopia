# ADR 0004: Cache public views, never economic balances

Status: Accepted

## Context

Rankings are derived from player progress and may tolerate brief staleness. Money, inventory and the availability used to settle a purchase cannot. The browse view can briefly be stale if every attempted purchase is checked again against PostgreSQL. The original implementation rebuilt every ranking from all players on every leaderboard request, making reads amplify database and Redis work.

## Decision

Use Redis sorted sets for the three public leaderboards. Update a player's derived scores after successful commands, and use a controlled rebuild for initialization, recovery or administrative repair. Cache-hit leaderboard reads do not trigger a whole-database rebuild. A missing/expired 60-second validity marker or missing sorted set uses one shared in-process rebuild; a one-minute timer also repairs the projection. Weekly scores use a UTC week boundary.

PostgreSQL remains the source of truth. When Redis is unavailable or its data is missing, query the database for public ranking results. Cache maintenance errors are isolated from committed transactions. No inventory, currency, trade receipt or production eligibility depends on Redis.

Cache the public market browse view in process for one second, with at most nine keys (all resources plus each of the eight resource filters). Concurrent identical reads share one pending query. Successful market commands clear the cache and advance a generation counter; a query started before invalidation cannot repopulate the new cache generation. The owner-only `mine=true` view always queries PostgreSQL, as do all economic commands. A cached listing is an offer to attempt a purchase, not a reservation or availability guarantee.

Realtime messages invalidate a UI view; they do not carry authoritative score deltas that a client must apply exactly once. Clients refresh ranking data when notified or when reopening the view.

## Consequences

Redis failure can degrade ranking latency without allowing incorrect settlement. Lost cache writes can temporarily make the leaderboard stale. Repair is explicit and recoverable; the cache is not an audit log.

Periodic rebuilding still costs work proportional to the player population. The current design fits a bounded demo and one API instance. The in-memory market cache is also process-local; multiple replicas would need cross-instance invalidation or an explicitly accepted one-second stale display window, while settlement must remain database-backed. Before scaling, measure rebuild duration, coordinate rebuild ownership, and consider a transactional outbox or versioned cache writes if stronger freshness is needed. Expensive search, cursor pagination and historical season archives are separate future concerns.

## Evidence

See `leaderboard`, `syncRanking`, `rebuildRankings`, `weekKey` and `marketList` in [`game.ts`](../../apps/api/src/game.ts), [performance evidence](../PERFORMANCE.md), and [architecture](../ARCHITECTURE.md).
