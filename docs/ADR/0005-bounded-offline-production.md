# ADR 0005: Persist production jobs and settle a bounded offline queue

Status: Accepted

## Context

Production must finish while the browser is closed and survive API restarts. One timer per job would add process state without providing durability. Unbounded catch-up simulation could generate resources from inputs that a player only obtained after returning.

## Decision

Each `ProductionJob` stores input/output snapshots, configuration version, start time, finish time and collection state. Inputs are debited when the job is created. The server clock and persisted `finishesAt` determine eligibility; no browser callback or process timer marks a job economically complete.

Manual queues hold at most three batches. Automatic mode pre-schedules at most thirty pending batches per building using the available inputs. During authenticated state synchronization, the server takes the player's transaction lock, collects eligible persisted jobs that fit, and refills the queue from the current server time or the existing queue's end.

Jobs created on return never start in the past. A building upgrade or recipe edit affects new jobs only. Completed batches that cannot fit remain collectable; manual collection accepts a chronological prefix that fits. Turning automatic mode off preserves already paid-for jobs and switches their collection back to the player.

The latest automatic-harvest report references an already committed event. Dismissing or reopening it cannot grant another reward.

## Consequences

Offline progression survives deployments and does not need a job runner. Concurrent syncs and manual actions serialize on the same lock. Automatic production is deliberately finite: thirty batches of twelve seconds provide six minutes of purifier scheduling at level one, not an eight-hour idle simulation.

Returned goods may consume capacity before another building can collect; ordering is deterministic. Pending jobs form a bounded output buffer, so the warehouse check at scheduling time is not a reservation of future output capacity. The UI explains full-warehouse and missing-material states.

Longer idle play requires a designed economic policy and measurements, not simply a larger loop. A future background system can schedule jobs, but must preserve input reservation, immutable snapshots and the single-collection transaction rule.

## Evidence

See [`production.ts`](../../apps/api/src/production.ts), production branches in [`game.ts`](../../apps/api/src/game.ts), [economy limits](../ECONOMY.md), and offline/concurrent collection tests in [`tests/economy.integration.test.ts`](../../tests/economy.integration.test.ts).
