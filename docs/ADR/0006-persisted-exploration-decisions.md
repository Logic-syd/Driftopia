# ADR 0006 — Persist exploration decisions and outcomes

Status: accepted for Phase 3A.

## Context

Exploration must continue while a player is offline, survive API restarts and resist reward rerolling. It shares inventory and coins with production and trading. A timer-based in-memory implementation would lose work on restart; independent balance writers would race existing transactions.

## Decision

Keep exploration in the modular monolith. Pure configuration and rules define ships, regions, fifteen events, bounded cargo, durability and costs. The API supplies cryptographic randomness and commits all possible branch outcomes and rule snapshots when dispatching. These private outcomes never leave the server; the public API reveals the event after arrival and only the chosen result after the choice commits.

Use persisted `SAILING`, `RETURNING`, `CLAIMED` states and server timestamps. Arrival and readiness are derived read views. The player can choose or claim at any later time without a deadline. No task worker is needed at this scale. Future rule changes affect new voyages only.

Reuse the existing per-player transaction lock, command fingerprint, receipt and audit. Charge departure costs and base wear at dispatch; extra choice costs and damage at choice; transfer cargo and XP at claim. An active-voyage unique index and composite ship/owner foreign key reinforce application validation. Warehouse overflow rolls back the entire claim and keeps the cargo aboard. Safe return always remains possible after departure.

HTTP snapshots remain authoritative. Socket.IO invalidation and client boundary refreshes merely request a fresh snapshot. They never grant rewards or advance stored economic state.

## Consequences and limits

This produces restart-safe offline travel without another service, supports exactly-once economic effects under retries and makes current risk probabilities visible. Delaying a choice delays the return; this is an explicit interaction point, not unattended automatic exploration. A ship remains occupied until unloading. There is no ship destruction or missed-login loss.

Precommitting branch outcomes prevents rerolls but is not a publicly verifiable fairness protocol. Existing database/operator access can inspect private outcomes; never expose that JSON in public/admin logs. At three ships per player and twenty displayed history entries, the read workload is bounded, but retained history still needs a future archival policy. Shared weather, residents and cooperative projects are separate planned modules, not implied by narrative events.
