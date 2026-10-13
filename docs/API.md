# HTTP and realtime API — v0.3.0

The base path is `/api`. HTTP bodies are JSON except Prometheus metrics. Browser authentication uses the `driftopia_session` HttpOnly cookie; credentials are included in same-origin requests. Production cookies are `Secure` and `SameSite=Lax`. Allowed browser origins are configured explicitly in `WEB_ORIGINS`. API responses set `Cache-Control: no-store`.

## Commands and retries

Game actions, market writes, friend additions and economic configuration changes require a UUID `Idempotency-Key` header. Reuse it for a retry of the same operation and arguments; generate a new key only for a new intent. Authentication and the administrator's cache-rebuild command do not use economic command receipts.

```http
POST /api/market/11111111-1111-4111-8111-111111111111/buy
Content-Type: application/json
Idempotency-Key: 22222222-2222-4222-8222-222222222222

{"quantity":2}
```

The web client applies a twelve-second deadline to both response headers and body, then retries transport failures at most once with the original key/body. A complete business-error response is not automatically retried.

The listing ID above is illustrative. The server derives the buyer from the session and reads price, seller, available quantity, balances and capacity from PostgreSQL. A client-supplied price, reward, inventory or completion time has no authority.

A canonical fingerprint covers the operation and arguments. Same key and same command replays the saved result; different arguments return `409 IDEMPOTENCY_CONFLICT`. Receipts expire after seven days. Their retained key/fingerprint then returns `409 IDEMPOTENCY_EXPIRED`, including after maintenance removes the response payload. Do not turn an ambiguous timeout into a fresh-key purchase: first retry the original key or reload state and history. Fingerprints created by the preceding implementation remain supported for matching legacy requests.

Errors have the form:

```json
{
  "error": {
    "code": "SOLD_OUT",
    "message": "来晚一步，库存不足",
    "requestId": "server-or-validated-client-request-id"
  }
}
```

`X-Request-ID` appears on responses and correlates to structured server logs. Missing/expired authentication returns 401; role denial 403; missing records 404; invalid input 400; rule or idempotency conflicts 409; rate/quota limits 429; unavailable authentication capacity 503. An unexpected server error returns 500 without SQL details. NestJS POST handlers normally return 201 on success.

## Authentication and operational endpoints

| Method | Path             | Purpose                                                                                                                                                 |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`        | Process liveness, `{ok, version}`; does not prove the database is usable                                                                                |
| GET    | `/ready`         | PostgreSQL and required migration check; 503 if unavailable/outdated; Redis failure returns `status: degraded` while economic storage remains available |
| GET    | `/metrics`       | Prometheus text: request counts/latency buckets, CPU, RSS, uptime, WebSocket connections; production requires `Authorization: Bearer <METRICS_TOKEN>`   |
| GET    | `/auth/options`  | `{guestEnabled}` for the login screen                                                                                                                   |
| POST   | `/auth/register` | `email`, `password` (8–128 characters), `name` (2–20); creates the real initial base and session atomically                                             |
| POST   | `/auth/login`    | `email`, `password`; normal accounts receive a seven-day session                                                                                        |
| POST   | `/auth/guest`    | Creates a quota-limited real account, or returns the currently authenticated account; default lifetime 24 hours                                         |
| POST   | `/auth/logout`   | Revokes this session, clears the cookie and disconnects its sockets                                                                                     |

Guest mode never bypasses inventory, market or production rules. Guests have no reusable login password and cannot recover a session after logout/cookie loss. The server defaults to 100 guest accounts created in a rolling 24 hours and 500 retained guest accounts overall. Expired guest listings are hidden and cannot be purchased. Set `GUEST_ENABLED=false` to disable new guest creation. See [operations](OPERATIONS.md) for environment and lifetime management.

## Private game state and actions

| Method | Path               | Input / result                                                                             |
| ------ | ------------------ | ------------------------------------------------------------------------------------------ |
| GET    | `/state`           | Private state, server time, available harvests, guest status and active production recipes |
| POST   | `/game/salvage`    | `spawnId`                                                                                  |
| POST   | `/game/build`      | `kind`, integer `x`, `y`                                                                   |
| POST   | `/game/expand`     | `x`, `y`; must adjoin existing raft, within −8…8                                           |
| POST   | `/game/move`       | `buildingId`, `x`, `y`                                                                     |
| POST   | `/game/upgrade`    | `buildingId`; up to level three                                                            |
| POST   | `/game/automation` | `buildingId`, boolean `enabled`                                                            |
| POST   | `/game/produce`    | `buildingId`; manual queue limit three                                                     |
| POST   | `/game/collect`    | `buildingId`; accepts completed batches that fit                                           |
| POST   | `/game/order`      | `orderId`; one completion per persisted player order                                       |
| POST   | `/game/discard`    | `resource`, integer `quantity` (1–10000); destroys owned inventory, gives no currency      |

`GET /state` is an authenticated synchronization operation, not a cacheable public read. Under the player transaction lock it collects completed automatic batches, refills eligible queues and replenishes salvage/orders. Repeated reads cannot collect a job twice. Do not put this endpoint behind a CDN cache.

Buildings return `autoEnabled`, `autoStatus` (`off`, `running`, `warehouse_full`, `materials`), effective `recipe` and persisted `jobs`. The latest `productionReport` contains `id`, `batches`, `resources` and `createdAt`. It describes an already committed harvest; opening/dismissing it grants nothing.

Automatic queues contain at most thirty pending batches and reserve inputs immediately. Only persisted jobs mature while offline. Refill starts at current server time or the existing queue end, never retroactively. Enabling automation prevents manual enqueue; disabling it preserves all prepaid jobs. Collection leaves batches that cannot fit in the warehouse.

## Market, social and rankings

| Method | Path                           | Input / result                                                                                                  |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/market?resource=wood`        | At most 100 active listings; optional resource enum filter; bounded one-second public display cache             |
| GET    | `/market?mine=true`            | Authenticated user's own active listings, at most 20; always queries PostgreSQL and cannot select another owner |
| POST   | `/market`                      | `resource`, integer `quantity` (1–100), integer `unitPrice` (1–10000); at most 20 active listings per seller    |
| POST   | `/market/:id/buy`              | Integer `quantity` (1–100); checks both account and listing state                                               |
| POST   | `/market/:id/cancel`           | Empty object; refunds unsold escrow if it fits                                                                  |
| GET    | `/market/history`              | The current player's latest 50 purchases/sales, totals and fees                                                 |
| GET    | `/players?q=`                  | Name search, at most 40 public players, plus online presence                                                    |
| GET    | `/players/:id/island`          | Public profile/progress and read-only island geometry; no email, coins, inventory, job details or session data  |
| GET    | `/friends`                     | Persisted one-way bookmarks with public profiles and online presence                                            |
| POST   | `/friends/:id`                 | Empty object; idempotently adds a bookmark, rejects self-add                                                    |
| GET    | `/leaderboard?type=prosperity` | `prosperity`, `xp` or `weeklyPoints`; at most 20 public results                                                 |

A trading dock is required to list and buy. The purchase total is `quantity × stored unitPrice`; the seller receives `total − ceil(total × 0.05)`. Committed market writes invalidate the public display cache; generation checks prevent older pending reads from filling a new cache generation. Browsing does not reserve inventory, and buying always validates PostgreSQL state inside its transaction. History and public listing queries are bounded lists, not complete cursor-paginated archives. The owner-only listing view avoids losing access to escrow when a listing falls outside the latest 100 public results. Friendship is not a bilateral friend-request workflow.

## Administration

| Method | Path                      | Input / purpose                                                                                   |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/admin`                  | Role-protected player/transaction/configuration aggregates and basic anomaly checks               |
| POST   | `/admin/config`           | `{type: "recipe", kind, recipe: {input, output, seconds}}`, or `{type: "order", code, coins, xp}` |
| POST   | `/admin/rebuild-rankings` | Role-protected reconstruction from PostgreSQL                                                     |

Every administrator request checks the server-side role. Recipe changes create versions, and existing jobs retain their snapshots. Production administrators are explicitly assigned through seed configuration; there are no hard-coded admin credentials.

## Socket.IO protocol

Connect through `/socket.io` with the session cookie. The handshake validates the cookie against PostgreSQL, Origin and connection limits. The server assigns `user:<id>` and `session:<tokenHash>` rooms. It implements no client `join`, `subscribe` or economic command event.

| Server event      | Payload                                         | Client behavior                                                  |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `sync:ready`      | `{epoch, sequence, emittedAt}`                  | Record the process epoch and resynchronize HTTP snapshots        |
| `sync:invalidate` | `{eventId, epoch, sequence, topics, emittedAt}` | Deduplicate/ignore old notices, then refresh affected HTTP views |
| `session:expired` | No economic payload                             | Clear authenticated UI; socket is disconnected                   |

Topics are `state`, `market`, `friends`, and `leaderboard`. Private state invalidations target affected players. Market/ranking broadcasts are coalesced over 200 ms. Presence changes notify followers; online means an authenticated socket exists on this API instance.

The sequence is process-wide, so a gap can include notifications for other players; it is not proof of a lost private change. Events are not a durable log and cannot grant resources. Reconnect, process-epoch changes and foreground refresh recover via HTTP. Logout disconnects immediately, expiry has a scheduled disconnect, and database session revocation is rechecked at most every 15 seconds. Failed revocation checks close sockets until they can authenticate again.

## Abuse limits and trust boundary

Defaults are 10 registration/login requests per minute per IP in a shared auth bucket, three guest requests per minute per IP in a separate bucket, and 240 ordinary requests per minute per authenticated player (unauthenticated requests use IP). Public `/auth/options` has its own IP bucket; logout uses the authenticated-player bucket. WebSocket defaults are 1000 total connections, 600 per IP and four per user; excessive client event traffic is disconnected. These are configurable safeguards for a single API instance, not a guarantee of supported load.

Proxy forwarding headers are trusted only from explicit IP/CIDR entries in `TRUST_PROXY`. Do not set a blanket trust rule or expose the API around its production edge proxy. Cross-site write requests and disallowed socket origins are rejected. Rate-limit buckets and presence are currently in-process; multi-instance deployment needs shared coordination.
