# ADR 0001: A modular monolith for a small multiplayer economy

Status: Accepted

## Context

Driftopia needs accounts, islands, production, orders, market settlement and social views. Its hardest operation transfers inventory and currency between two players. The project has one repository, a small operational footprint and no independent teams requiring separate deployments.

## Decision

Keep one NestJS API deployment and one PostgreSQL database. Separate responsibilities through TypeScript modules and workspace packages:

- `game-config`: resource and building definitions, prices, recipes and progression thresholds.
- `game-engine`: deterministic, side-effect-free rules for inventory, placement, production duration and fees.
- `shared`: input schemas and transport types.
- API modules: authentication, game transactions, production, realtime and operations.
- React handles UI and the server snapshot; Phaser handles presentation and input.

The browser sends commands through HTTP. A successful transaction is the point at which an economic action takes effect. Socket.IO improves freshness without taking ownership of state.

## Alternatives considered

Microservices would introduce distributed settlement, deployment coordination and message delivery concerns before any measured need. A single unstructured application would be easier to start but would make rules harder to test independently. The current approach keeps database transactions local while isolating the most reusable logic.

## Consequences

The system is understandable and can be run with four infrastructure roles: edge/static delivery, API, PostgreSQL and Redis. Shared TypeScript types reduce accidental drift, but runtime Zod validation remains necessary because clients are untrusted.

The API is a **single-instance design**. Its controller and game service still contain several business capabilities in relatively large files. Split these along stable feature boundaries when changes justify it; adding services is not the first remedy for file size. Multiple API replicas would first require shared rate limits, Socket.IO fan-out and presence, coordinated cache maintenance, and load testing of database contention.

## Evidence

See [`apps/api/src`](../../apps/api/src), [`packages`](../../packages), [architecture](../ARCHITECTURE.md) and [baseline audit](../TECHNICAL_AUDIT.md).
