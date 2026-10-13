# Game design

## Product and visual language

Driftopia is a quiet, original ocean management game. The sea supplies materials and connects players through commerce. The browser scene uses procedurally drawn turquoise water, warm timber, isometric buildings, cream panels and sage accents. System emoji supplement icons; the project does not reuse another game's map, characters or narrative.

The environmental cycle changes ocean/light colors and the moon over eight minutes. It is a visual effect only: no weather damage, survival multiplier or hidden economic reward is implied. Distant islands and ships are decorative.

## Persistent core loop

**Salvage → build a purifier → produce and collect water → fulfil orders → expand the base → build a dock → trade with another player.**

A new player starts with a 3×3 raft, 100 coins, 18 wood, 12 plastic, four metal and two seaweed. The server creates these records with the account. Every subsequent building, resource, order completion and trade persists in PostgreSQL. Closing the browser does not reset the island.

Upgrades reduce new production-job duration and increase building prosperity. Warehouses increase inventory capacity. Additional floor tiles make room for specialized buildings. Merchant orders provide coins and XP; the market lets players exchange resources at seller-selected integer prices.

## Five-step first voyage

The tutorial observes real player state and grants no extra repeatable reward. It advances inline without a series of blocking dialogs:

| Step | Interaction                 | Lesson                                                           |
| ---- | --------------------------- | ---------------------------------------------------------------- |
| 1    | Collect a floating resource | The sea provides construction inputs                             |
| 2    | Place a purifier            | Buildings consume materials and occupy raft tiles                |
| 3    | Schedule and collect water  | Production takes server time and survives leaving                |
| 4    | Deliver a merchant order    | Resources become currency/XP and unlock progression              |
| 5    | Add a raft tile             | Expansion creates room for warehouse capacity and a trading dock |

The initial stock and twelve-second purifier recipe support a short first session. **Five minutes is a target**, not a measured first-time-player completion rate. Later economy tuning must use observed player sessions.

## Controls and feedback

- Click/tap floating wood, bottles, metal or crates to salvage. The quick-salvage button provides an accessible alternative.
- Choose a building and preview it on a raft tile. A building ghost and red/green feedback communicate geometry/material validity; the server makes the final decision. Coordinate buttons remain available when precise canvas targeting is difficult.
- Select a building for production, upgrades or movement. Production bubbles and countdowns visualize persisted jobs.
- Drag to pan; use wheel, pinch or zoom buttons for camera control, and reset to center. Camera changes are eased.
- Confirmed salvage produces ripples and a resource-flight effect toward the resource bar. A failed request does not make the collectible disappear as a successful harvest.
- Open inventory, orders, market, friends and rankings from the navigation bar. Empty, loading, retry and success/error states accompany asynchronous panels.
- Network banners explain offline/reconnecting state; reconnect and foregrounding resynchronize the server snapshot. Discarding inventory requires confirmation.
- Optional gentle synthesized feedback sounds start disabled. Reduced-motion preferences apply to UI and Phaser effects. Modal keyboard focus supports controls outside the canvas.

## Production boundaries

Manual queues contain at most three prepaid batches. Enabling automation schedules at most thirty pending batches from current materials. Persisted jobs mature offline; on return, eligible output is collected under a server lock and new jobs start from the current time or remaining queue end.

When storage is full, uncollected output remains attached to the job. Missing inputs pause further scheduling. Disabling automation preserves prepaid tasks for manual collection. The harvest summary describes the latest committed automatic collection, not a new grant triggered by reading the summary.

## Multiplayer and demonstration access

Market listings escrow resources immediately. Other players can buy a chosen quantity; both accounts see persisted balances, inventory and transaction history. A dock is required on each trading island. The “my listings” tab exposes all of a player's active escrow even if it falls outside the public latest-100 results. Listing cancellation returns only unsold stock if storage has room.

Friends are one-way bookmarks with ephemeral online presence. Visits show another player's public island as a read-only isometric thumbnail. They do not reveal inventory, currency, production jobs, email or session information. Rankings compare prosperity, XP and the current UTC week's points.

Optional guest entry creates a real account with the same economy and default 24-hour session, subject to server quotas. It is suitable for a short review session; clearing its cookie or logging out loses access, and guest-to-registered conversion is not implemented. A registered account is the current path for durable return access.

## Deliberate omissions

There is no combat, navigable exploration, resident demand simulation or weather effect on economics. Cabins add prosperity; gardens produce seaweed. Trading has no real-money payment component. Advanced characters, bilateral friendship, co-op events and extensive audio/art assets are deferred.

The current content and economic progression are tuned to expose the engineering loop quickly. They have not established first-day retention, several hours of balanced content, or a commercial survival-game progression curve. See [economy analysis](ECONOMY.md) and [roadmap](ROADMAP.md).
