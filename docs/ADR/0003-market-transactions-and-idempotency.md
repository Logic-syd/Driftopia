# ADR 0003: Escrow, ordered locks and transactional command receipts

Status: Accepted

## Context

Two buyers can request the final item at the same time. A seller can cancel while a buyer is paying. A connection can fail after PostgreSQL commits but before the browser receives the result. Preventing overselling requires more than disabling a button or reading the current quantity once.

## Decision

Listing goods removes them from the seller's inventory and places them in listing escrow. A purchase opens one PostgreSQL transaction and:

1. Acquires transaction advisory locks for buyer and seller in sorted user-ID order.
2. Looks up the authenticated user's unique idempotency key and checks the command fingerprint.
3. Locks the listing row with `FOR UPDATE`, reloads its state and validates quantity, buyer funds, dock ownership and warehouse capacity.
4. Conditionally decrements available quantity, debits the buyer, credits the seller net of the integer fee, and delivers inventory.
5. Writes the trade, seller event, command audit and replayable result before committing.

Listing cancellation takes the seller's same advisory lock, so it serializes with a purchase. Cancellation refunds only unsold escrow and fails atomically if that inventory cannot fit. Sorted player locks avoid a cycle when players trade in opposite directions. An advisory hash collision only causes additional serialization.

Important writes use `(userId, key)` as a unique command receipt. The fingerprint covers the operation and a canonical representation of its arguments. Reusing a key for a different command is rejected. A transport retry uses the original key; a genuinely new action uses a new UUID. A failure before commit leaves no successful receipt or partial settlement, allowing a retry of the original command.

Receipt payload retention is bounded; expired receipts retain their key and fingerprint as tombstones and reject replay. Deleting the entire receipt would incorrectly make an old successful command executable again. Tombstones still grow over time and need a future archival policy that preserves rejection semantics.

## Consequences

PostgreSQL's default READ COMMITTED isolation is sufficient **because every relevant write takes the common locks**. Locks hold through audit and receipt insertion. A transaction timeout rolls back the entire action; it is not evidence that a client should submit a fresh key.

Post-commit cache or notification failures must not change a committed result into a failed economic operation. Clients can always reload state and retry with the original key. Socket delivery is best effort, not part of the settlement transaction.

This design does not implement distributed exactly-once message delivery. It provides atomic settlement and safe command retry within one authoritative database. High contention on one seller or listing is intentionally serialized; throughput limits are measured in the [performance report](../PERFORMANCE.md).

## Evidence

See `mutate`, `buyListing` and `cancelListing` in [`game.ts`](../../apps/api/src/game.ts), [database model](../DATABASE.md), real PostgreSQL scenarios in [`tests/economy.integration.test.ts`](../../tests/economy.integration.test.ts), and [validation](../VALIDATION.md).
