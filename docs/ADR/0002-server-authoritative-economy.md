# ADR 0002: PostgreSQL owns the game economy

Status: Accepted

## Context

An H5 client is inspectable and modifiable. Client clocks, displayed inventory and submitted reward values cannot prove that a player owns resources or completed a task. Refreshes, disconnected tabs and two devices also make local state unreliable.

## Decision

The client submits intent: a building kind and position, a persisted spawn/order/building ID, or a listing ID and purchase quantity. The server loads the authenticated player's state and computes costs, rewards, capacity, ownership and completion time. All lasting economic changes go to PostgreSQL.

`Inventory`, `PlayerProgress`, `Building`, `ProductionJob`, `PlayerOrder`, `MarketListing` and `MarketTransaction` are persisted models. Pure rules in `game-engine` validate calculations; database uniqueness and CHECK constraints provide a second boundary. `GameEvent` records economic changes for investigation.

The client uses server timestamps to draw countdowns. Finishing an animation never grants a resource. Zustand stores the latest server snapshot, and local storage stores presentation preferences and dismissed-report IDs only.

## Consequences

Playing requires network access for mutations. An optimistic visual effect may acknowledge input, but the UI must reconcile the result with the server and must not announce successful rewards on failure.

`GET /api/state` performs bounded lazy maintenance: it settles eligible automatic production and replenishes world state inside the player's transaction lock. This avoids per-player timers, but makes this endpoint more expensive than a pure read. It must be private and uncached at the edge. A future split into an explicit synchronization command and a cheap snapshot read should preserve the same transaction invariants.

Database constraints do not replace authorization. Every path that changes player economics must acquire the same player lock and check resource ownership; introducing a bypassing maintenance or admin path would invalidate the concurrency argument.

## Evidence

See [`game.ts`](../../apps/api/src/game.ts), [`production.ts`](../../apps/api/src/production.ts), [`game-engine`](../../packages/game-engine/src/index.ts), [database constraints](../../prisma/migrations/202610120002_constraints/migration.sql), and [validation](../VALIDATION.md).
