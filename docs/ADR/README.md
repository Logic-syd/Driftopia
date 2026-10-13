# Architecture decision records

These records explain decisions implemented in the current system. Accepted does not mean all production operations are complete; deployment and measurement evidence lives in the linked runbooks and reports.

| Record                                              | Decision                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| [0001](0001-modular-monolith.md)                    | Keep settlement inside a modular monolith                        |
| [0002](0002-server-authoritative-economy.md)        | Treat PostgreSQL as the economic authority                       |
| [0003](0003-market-transactions-and-idempotency.md) | Use escrow, ordered locks and transactional receipts             |
| [0004](0004-disposable-ranking-cache.md)            | Cache disposable public views without caching economic authority |
| [0005](0005-bounded-offline-production.md)          | Persist finite offline queues and reserve inputs                 |

Related: [technical audit](../TECHNICAL_AUDIT.md), [architecture](../ARCHITECTURE.md), [validation](../VALIDATION.md), [remaining work](../ROADMAP.md).
