import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { Prisma } from "@prisma/client";
import { passwordHash, tokenHash } from "../apps/api/src/auth";
import { db } from "../apps/api/src/database";
import { rebuildRankings, redis } from "../apps/api/src/game";
import {
  explorationAction,
  explorationState,
} from "../apps/api/src/exploration";
import {
  EXPLORATION_EVENTS,
  REGIONS,
  SHIPS,
} from "../packages/game-config/src/exploration";
import { RESOURCE_IDS, type Bundle } from "../packages/game-config/src/index";
import type {
  ChoiceId,
  ExplorationState,
  RegionId,
  ShipKind,
  VoyageResultView,
} from "../packages/shared/src/exploration";

const base = process.env.TEST_API_URL ?? "http://127.0.0.1:3001/api";
type Account = { id: string; cookie: string };
type Reply = {
  status: number;
  body: { error?: { code: string; message: string }; [key: string]: unknown };
};
const accounts: Account[] = [];
const processes: { stop: () => Promise<void> }[] = [];

async function makePlayer() {
  // Explicit progression and storage fixtures isolate exploration invariants
  // from the already-covered introductory building and production tutorial.
  const user = await db.user.create({
    data: {
      email: `exploration-${randomUUID()}@example.test`,
      passwordHash: await passwordHash("ExplorationTest2026"),
      profile: { create: { name: "探索验收员" } },
      progress: { create: { coins: 10000, xp: 1800 } },
      inventory: {
        create: {
          resources: {
            wood: 150,
            plastic: 150,
            metal: 150,
            seaweed: 150,
            water: 150,
            fish: 150,
            plank: 150,
            parts: 150,
          },
        },
      },
      island: {
        create: {
          tiles: {
            create: Array.from({ length: 9 }, (_, i) => ({
              x: (i % 3) - 1,
              y: Math.floor(i / 3) - 1,
            })),
          },
          buildings: {
            create: Array.from({ length: 9 }, (_, i) => ({
              x: (i % 3) - 1,
              y: Math.floor(i / 3) - 1,
              kind: i === 4 ? "dock" : "warehouse",
              level: i === 4 ? 1 : 3,
            })),
          },
        },
      },
    },
  });
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const account = { id: user.id, cookie: `driftopia_session=${token}` };
  accounts.push(account);
  return account;
}
async function command(
  player: Account,
  action: string,
  body: unknown,
  key = randomUUID(),
  apiBase = base,
): Promise<Reply> {
  const response = await fetch(`${apiBase}/exploration/${action}`, {
    method: "POST",
    headers: {
      cookie: player.cookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function success(
  player: Account,
  action: string,
  body: unknown,
  key = randomUUID(),
  apiBase = base,
) {
  const result = await command(player, action, body, key, apiBase);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result;
}
async function view(
  player: Account,
  apiBase = base,
): Promise<ExplorationState> {
  const response = await fetch(`${apiBase}/exploration`, {
    headers: { cookie: player.cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ExplorationState;
}
async function buildShip(
  player: Account,
  kind: ShipKind = "skiff",
  apiBase = base,
) {
  await success(player, "build", { kind }, randomUUID(), apiBase);
  const ship = (await view(player, apiBase)).ships.find((s) => s.kind === kind);
  expect(ship).toBeDefined();
  return ship!;
}
async function voyage(player: Account, apiBase = base) {
  const ship = await buildShip(player, "skiff", apiBase);
  await success(
    player,
    "dispatch",
    { shipId: ship.id, regionId: "bay" },
    randomUUID(),
    apiBase,
  );
  const row = await db.expedition.findFirstOrThrow({
    where: { shipId: ship.id },
  });
  return { ship, row };
}
async function arrive(id: string) {
  // Advance persisted fixture timestamps together, preserving every SQL ordering
  // constraint. Browser E2E separately waits through actual voyage durations.
  await db.expedition.update({
    where: { id },
    data: {
      departedAt: new Date(Date.now() - 120000),
      arrivesAt: new Date(Date.now() - 90000),
    },
  });
}
async function returnHome(id: string) {
  await db.expedition.update({
    where: { id },
    data: {
      departedAt: new Date(Date.now() - 120000),
      arrivesAt: new Date(Date.now() - 90000),
      resolvedAt: new Date(Date.now() - 60000),
      returnsAt: new Date(Date.now() - 30000),
    },
  });
}
async function readyVoyage(player: Account) {
  const trip = await voyage(player);
  await arrive(trip.row.id);
  await success(player, "choose", {
    voyageId: trip.row.id,
    choiceId: "return",
  });
  await returnHome(trip.row.id);
  const ready = await db.expedition.findUniqueOrThrow({
    where: { id: trip.row.id },
  });
  return { ...trip, result: ready.result as unknown as VoyageResultView };
}
async function assets(player: Account) {
  const [progress, inventory] = await Promise.all([
    db.playerProgress.findUniqueOrThrow({ where: { userId: player.id } }),
    db.inventory.findUniqueOrThrow({ where: { userId: player.id } }),
  ]);
  return {
    coins: progress.coins,
    xp: progress.xp,
    stock: inventory.resources as Bundle,
  };
}
function expectStockChange(
  before: Bundle,
  after: Bundle,
  debit: Bundle = {},
  credit: Bundle = {},
) {
  for (const resource of RESOURCE_IDS)
    expect(after[resource] ?? 0, resource).toBe(
      (before[resource] ?? 0) -
        (debit[resource] ?? 0) +
        (credit[resource] ?? 0),
    );
}
async function startIndependentApi() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("No available test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/main.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    spawnError: Error | undefined;
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null || spawnError)
        return;
      child.kill("SIGTERM");
      const fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
      fallback.unref();
      await exited;
      clearTimeout(fallback);
    })());
  processes.push({ stop });
  const apiBase = `http://127.0.0.1:${port}/api`;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) break;
      try {
        const response = await fetch(`${apiBase}/ready`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return { apiBase, stop };
      } catch {
        /* Startup has not bound the port yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Independent API did not become ready: ${spawnError?.message ?? output.slice(-2000)}`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

beforeAll(async () => {
  await db.$connect();
});
afterAll(async () => {
  await Promise.all(processes.map((server) => server.stop()));
  const ids = accounts.map((p) => p.id);
  await db.marketTransaction.deleteMany({
    where: { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }] },
  });
  await db.marketListing.deleteMany({ where: { sellerId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  if (redis.status === "ready") await rebuildRankings();
  await db.$disconnect();
  redis.disconnect();
});

describe.sequential("PostgreSQL exploration consistency", () => {
  it("charges real ship construction, upgrades, and repair while preserving ownership and limits", async () => {
    const p = await makePlayer(),
      initial = await view(p),
      before = await assets(p);
    const config = initial.shipyard.find((s) => s.kind === "skiff")!;
    const ship = await buildShip(p);
    const built = await assets(p);
    expectStockChange(before.stock, built.stock, config.cost);
    expect(built.coins).toBe(before.coins - config.coins);
    const duplicate = await command(p, "build", { kind: "skiff" });
    expect(duplicate.status).toBe(409);
    expect(
      await db.ship.count({ where: { userId: p.id, kind: "skiff" } }),
    ).toBe(1);
    expect(await assets(p)).toEqual(built);
    expect(ship.upgrade).not.toBeNull();
    await success(p, "upgrade", { shipId: ship.id });
    const upgraded = await assets(p);
    expectStockChange(built.stock, upgraded.stock, ship.upgrade!.cost);
    expect(upgraded.coins).toBe(built.coins - ship.upgrade!.coins);
    expect((await view(p)).ships[0].level).toBe(2);
    await db.ship.update({ where: { id: ship.id }, data: { durability: 40 } });
    const damaged = (await view(p)).ships[0];
    expect(damaged.repair).not.toBeNull();
    await success(p, "repair", { shipId: ship.id });
    const repaired = await assets(p);
    expectStockChange(upgraded.stock, repaired.stock, damaged.repair!.cost);
    expect(repaired.coins).toBe(upgraded.coins - damaged.repair!.coins);
    expect((await view(p)).ships[0].durability).toBe(
      damaged.stats.maxDurability,
    );
  });

  it("allows only one of twenty real HTTP dispatches to occupy and charge the same ship", async () => {
    const p = await makePlayer(),
      ship = await buildShip(p),
      initial = await view(p);
    const region = initial.regions.find((r) => r.id === "bay")!;
    const before = await assets(p);
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        command(p, "dispatch", { shipId: ship.id, regionId: "bay" }),
      ),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    const failures = replies.filter((r) => r.status !== 201);
    expect(failures).toHaveLength(19);
    for (const failure of failures) {
      expect(failure.status).toBe(409);
      expect(failure.body.error?.code).toBe("SHIP_BUSY");
    }
    const after = await assets(p);
    expectStockChange(before.stock, after.stock, region.supplies);
    expect(after.coins).toBe(before.coins - region.coins);
    expect(await db.expedition.count({ where: { shipId: ship.id } })).toBe(1);
    expect(
      (await db.ship.findUniqueOrThrow({ where: { id: ship.id } })).durability,
    ).toBe(ship.durability - region.baseWear);
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "exploration:dispatch" },
      }),
    ).toBe(1);
  });

  it("replays identical dispatches and rejects changed region intent on the same key", async () => {
    const p = await makePlayer(),
      ship = await buildShip(p),
      key = randomUUID();
    const body = { shipId: ship.id, regionId: "bay" };
    const replies = await Promise.all([
      command(p, "dispatch", body, key),
      command(p, "dispatch", { regionId: "bay", shipId: ship.id }, key),
    ]);
    expect(replies.every((r) => r.status === 201)).toBe(true);
    expect(replies[0].body).toEqual(replies[1].body);
    const after = await assets(p);
    const conflict = await command(
      p,
      "dispatch",
      { shipId: ship.id, regionId: "wrecks" },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await assets(p)).toEqual(after);
    expect(await db.expedition.count({ where: { shipId: ship.id } })).toBe(1);
  });

  it("rejects locked regions, exhausted hulls, missing supplies, insufficient coins and a missing dock", async () => {
    const p = await makePlayer(),
      ship = await buildShip(p),
      before = await assets(p);
    const locked = await command(p, "dispatch", {
      shipId: ship.id,
      regionId: "wrecks",
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error?.code).toBe("REGION_LOCKED");
    expect(
      (await view(p)).regions.find((r) => r.id === "wrecks")!.lockReason,
    ).toBeTruthy();
    expect(await assets(p)).toEqual(before);
    await db.ship.update({ where: { id: ship.id }, data: { durability: 0 } });
    const worn = await command(p, "dispatch", {
      shipId: ship.id,
      regionId: "bay",
    });
    expect(worn.status).toBe(409);
    expect(worn.body.error?.code).toBe("DURABILITY_LOW");
    await db.ship.update({ where: { id: ship.id }, data: { durability: 100 } });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: {} },
    });
    const empty = await command(p, "dispatch", {
      shipId: ship.id,
      regionId: "bay",
    });
    expect(empty.status).toBe(409);
    expect(empty.body.error?.code).toBe("INSUFFICIENT_RESOURCES");
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: before.stock },
    });
    await db.playerProgress.update({
      where: { userId: p.id },
      data: { coins: 0 },
    });
    const poor = await command(p, "dispatch", {
      shipId: ship.id,
      regionId: "bay",
    });
    expect(poor.status).toBe(409);
    expect(poor.body.error?.code).toBe("INSUFFICIENT_COINS");
    await db.playerProgress.update({
      where: { userId: p.id },
      data: { coins: before.coins },
    });
    await db.building.deleteMany({
      where: { island: { userId: p.id }, kind: "dock" },
    });
    const undocked = await command(p, "dispatch", {
      shipId: ship.id,
      regionId: "bay",
    });
    expect(undocked.status).toBe(409);
    expect(undocked.body.error?.code).toBe("DOCK_REQUIRED");
    expect((await view(p)).hasDock).toBe(false);
    expect(await assets(p)).toEqual(before);
    expect(await db.expedition.count({ where: { shipId: ship.id } })).toBe(0);
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "exploration:dispatch" },
      }),
    ).toBe(0);
  });

  it("keeps a travelling ship unavailable for upgrade and repair until its cargo is claimed", async () => {
    const p = await makePlayer(),
      trip = await readyVoyage(p),
      before = await assets(p);
    for (const action of ["repair", "upgrade", "dispatch"]) {
      const body =
        action === "dispatch"
          ? { shipId: trip.ship.id, regionId: "bay" }
          : { shipId: trip.ship.id };
      const response = await command(p, action, body);
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("SHIP_BUSY");
    }
    expect(await assets(p)).toEqual(before);
    await success(p, "claim", { voyageId: trip.row.id });
    await success(p, "dispatch", { shipId: trip.ship.id, regionId: "bay" });
    expect(await db.expedition.count({ where: { shipId: trip.ship.id } })).toBe(
      2,
    );
    expect(
      await db.expedition.count({
        where: { shipId: trip.ship.id, status: { not: "CLAIMED" } },
      }),
    ).toBe(1);
  });

  it("settles stored option costs, durations and cargo after the current configuration changes", async () => {
    const p = await makePlayer(),
      trip = await voyage(p);
    await arrive(trip.row.id);
    const current = (await view(p)).voyages.find((v) => v.id === trip.row.id)!;
    const option = current.event!.choices.find(
      (choice) => choice.id !== "return",
    )!;
    const committed = trip.row.outcomes as unknown as Record<
      ChoiceId,
      VoyageResultView
    >;
    const before = await assets(p);
    const savedRegion = structuredClone(REGIONS.bay);
    const savedShip = structuredClone(SHIPS.skiff);
    const eventId = current.event!.id;
    const savedEvent = structuredClone(EXPLORATION_EVENTS[eventId]);
    try {
      // Change only this Vitest process's real config objects. The separate HTTP
      // API retains its own config; direct domain calls below use actual PG.
      REGIONS.bay.seconds = 900;
      REGIONS.bay.loot = [{ resource: "wood", min: 99, max: 99 }];
      SHIPS.skiff.capacity = 1;
      EXPLORATION_EVENTS[eventId].cost = { wood: 99 };
      EXPLORATION_EVENTS[eventId].bonus = { metal: 99 };
      EXPLORATION_EVENTS[eventId].title = "Changed after departure";
      const snapshot = await explorationState(p.id);
      expect(snapshot.regions.find((r) => r.id === "bay")!.seconds).toBe(900);
      expect(snapshot.voyages.find((v) => v.id === trip.row.id)!.event).toEqual(
        current.event,
      );
      await explorationAction(p.id, randomUUID(), "choose", {
        voyageId: trip.row.id,
        choiceId: option.id,
      });
      const row = await db.expedition.findUniqueOrThrow({
        where: { id: trip.row.id },
      });
      expect(row.snapshot).toEqual(trip.row.snapshot);
      expect(row.outcomes).toEqual(trip.row.outcomes);
      expect(row.result).toEqual(committed[option.id]);
      expect(row.returnsAt!.getTime() - row.resolvedAt!.getTime()).toBe(
        option.returnSeconds * 1000,
      );
      expectStockChange(before.stock, (await assets(p)).stock, option.cost);
      await returnHome(trip.row.id);
      await explorationAction(p.id, randomUUID(), "claim", {
        voyageId: trip.row.id,
      });
      const after = await assets(p);
      expectStockChange(
        before.stock,
        after.stock,
        option.cost,
        committed[option.id].resources,
      );
      expect(after.coins).toBe(
        before.coins - option.coins + committed[option.id].coins,
      );
      expect(after.xp).toBe(before.xp + committed[option.id].xp);
    } finally {
      REGIONS.bay = savedRegion;
      SHIPS.skiff = savedShip;
      EXPLORATION_EVENTS[eventId] = savedEvent;
    }
  });

  it("preserves persisted random outcomes during offline reads without exposing or awarding hidden cargo", async () => {
    const p = await makePlayer(),
      trip = await voyage(p),
      before = await assets(p);
    const initial = await db.expedition.findUniqueOrThrow({
      where: { id: trip.row.id },
    });
    const sailing = (await view(p)).voyages.find((v) => v.id === trip.row.id)!;
    expect(sailing.phase).toBe("sailing");
    expect(sailing.result).toBeNull();
    await arrive(trip.row.id);
    const snapshots = await Promise.all([view(p), view(p), view(p)]);
    for (const snapshot of snapshots) {
      const current = snapshot.voyages.find((v) => v.id === trip.row.id)!;
      expect(current.phase).toBe("choice");
      expect(current.event).not.toBeNull();
      expect(current.result).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain('"outcomes"');
      expect(JSON.stringify(snapshot)).not.toContain('"snapshot"');
    }
    const stored = await db.expedition.findUniqueOrThrow({
      where: { id: trip.row.id },
    });
    expect(stored.status).toBe("SAILING");
    expect(stored.snapshot).toEqual(initial.snapshot);
    expect(stored.outcomes).toEqual(initial.outcomes);
    expect(await assets(p)).toEqual(before);
    expect((await view(p)).progress.claimed).toBe(0);
  });

  it("rejects early choices, early claims, forged rewards and client supplied timestamps", async () => {
    const p = await makePlayer(),
      trip = await voyage(p),
      before = await assets(p);
    const early = await command(p, "choose", {
      voyageId: trip.row.id,
      choiceId: "return",
    });
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe("NOT_READY");
    const forged: [string, unknown][] = [
      [
        "dispatch",
        {
          shipId: trip.ship.id,
          regionId: "bay",
          arrivesAt: "2000-01-01T00:00:00Z",
        },
      ],
      [
        "dispatch",
        { shipId: trip.ship.id, regionId: "bay", reward: { relic: 999 } },
      ],
      ["choose", { voyageId: trip.row.id, choiceId: "return", success: true }],
      ["choose", { voyageId: trip.row.id, choiceId: "return", returnsAt: 0 }],
      [
        "claim",
        { voyageId: trip.row.id, resources: { wood: 999 }, coins: 99999 },
      ],
    ];
    for (const [action, body] of forged) {
      const response = await command(p, action, body);
      expect(response.status, action).toBe(400);
      expect(response.body.error?.code).toBe("VALIDATION");
    }
    expect(await assets(p)).toEqual(before);
    await arrive(trip.row.id);
    await success(p, "choose", { voyageId: trip.row.id, choiceId: "return" });
    const earlyClaim = await command(p, "claim", { voyageId: trip.row.id });
    expect(earlyClaim.status).toBe(409);
    expect(earlyClaim.body.error?.code).toBe("NOT_READY");
  });

  it("resolves twenty simultaneous event choices once using the precommitted result", async () => {
    const p = await makePlayer(),
      trip = await voyage(p);
    await arrive(trip.row.id);
    const event = (await view(p)).voyages.find(
      (v) => v.id === trip.row.id,
    )!.event!;
    const option = event.choices.find((choice) => choice.id !== "return")!;
    expect(option).toBeDefined();
    const before = await assets(p),
      beforeShip = await db.ship.findUniqueOrThrow({
        where: { id: trip.ship.id },
      });
    const committed = trip.row.outcomes as unknown as Record<
      ChoiceId,
      VoyageResultView
    >;
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        command(p, "choose", { voyageId: trip.row.id, choiceId: option.id }),
      ),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    for (const failure of replies.filter((r) => r.status !== 201)) {
      expect(failure.status).toBe(409);
      expect(failure.body.error?.code).toBe("ALREADY_CHOSEN");
    }
    const row = await db.expedition.findUniqueOrThrow({
      where: { id: trip.row.id },
    });
    expect(row.status).toBe("RETURNING");
    expect(row.choiceId).toBe(option.id);
    expect(row.result).toEqual(committed[option.id]);
    expect(row.returnsAt!.getTime() - row.resolvedAt!.getTime()).toBe(
      option.returnSeconds * 1000,
    );
    const after = await assets(p);
    expectStockChange(before.stock, after.stock, option.cost);
    expect(after.coins).toBe(before.coins - option.coins);
    expect(after.xp).toBe(before.xp);
    expect(
      (await db.ship.findUniqueOrThrow({ where: { id: trip.ship.id } }))
        .durability,
    ).toBe(Math.max(0, beforeShip.durability - committed[option.id].damage));
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "exploration:choose" },
      }),
    ).toBe(1);
  });

  it("replays the same chosen option and rejects a different option using its receipt", async () => {
    const p = await makePlayer(),
      trip = await voyage(p),
      key = randomUUID();
    await arrive(trip.row.id);
    const first = await success(
      p,
      "choose",
      { voyageId: trip.row.id, choiceId: "return" },
      key,
    );
    const before = await assets(p);
    expect(
      (
        await success(
          p,
          "choose",
          { choiceId: "return", voyageId: trip.row.id },
          key,
        )
      ).body,
    ).toEqual(first.body);
    const changed = await command(
      p,
      "choose",
      { voyageId: trip.row.id, choiceId: "venture" },
      key,
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await assets(p)).toEqual(before);
  });

  it("awards cargo, coins, XP and route progress only once under twenty concurrent HTTP claims", async () => {
    const p = await makePlayer(),
      trip = await readyVoyage(p),
      before = await assets(p);
    const replies = await Promise.all(
      Array.from({ length: 20 }, () =>
        command(p, "claim", { voyageId: trip.row.id }),
      ),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    for (const failure of replies.filter((r) => r.status !== 201)) {
      expect(failure.status).toBe(409);
      expect(failure.body.error?.code).toBe("ALREADY_CLAIMED");
    }
    const after = await assets(p);
    expectStockChange(before.stock, after.stock, {}, trip.result.resources);
    expect(after.coins).toBe(before.coins + trip.result.coins);
    expect(after.xp).toBe(before.xp + trip.result.xp);
    const snapshot = await view(p);
    expect(
      snapshot.ships.find((s) => s.id === trip.ship.id)!.activeVoyageId,
    ).toBeNull();
    expect(snapshot.progress.claimed).toBe(1);
    expect(snapshot.progress.regions.bay).toBe(1);
    expect(snapshot.history.find((v) => v.id === trip.row.id)!.result).toEqual(
      trip.result,
    );
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "exploration:claim" },
      }),
    ).toBe(1);
  });

  it("preserves cargo and the occupied ship after a full-warehouse claim then reuses the failed key", async () => {
    const p = await makePlayer(),
      trip = await readyVoyage(p),
      key = randomUUID();
    expect(
      Object.values(trip.result.resources).reduce((sum, n) => sum + n, 0),
    ).toBeGreaterThan(0);
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 2000 } },
    });
    const before = await assets(p),
      failed = await command(p, "claim", { voyageId: trip.row.id }, key);
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe("WAREHOUSE_FULL");
    expect(await assets(p)).toEqual(before);
    expect(
      (await db.expedition.findUniqueOrThrow({ where: { id: trip.row.id } }))
        .status,
    ).toBe("RETURNING");
    expect(
      (await view(p)).ships.find((s) => s.id === trip.ship.id)!.activeVoyageId,
    ).toBe(trip.row.id);
    expect(
      await db.idempotencyRecord.count({ where: { userId: p.id, key } }),
    ).toBe(0);
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: {} },
    });
    const first = await success(p, "claim", { voyageId: trip.row.id }, key);
    expect(
      (await success(p, "claim", { voyageId: trip.row.id }, key)).body,
    ).toEqual(first.body);
    expectStockChange({}, (await assets(p)).stock, {}, trip.result.resources);
    expect((await view(p)).progress.claimed).toBe(1);
  });

  it("rolls back a PostgreSQL reward overflow and recovers the same claim key without losing cargo", async () => {
    const p = await makePlayer(),
      trip = await readyVoyage(p),
      key = randomUUID();
    expect(trip.result.coins + trip.result.xp).toBeGreaterThan(0);
    const original = await assets(p);
    await db.playerProgress.update({
      where: { userId: p.id },
      data: trip.result.coins > 0 ? { coins: 2147483647 } : { xp: 2147483647 },
    });
    const before = await assets(p),
      failed = await command(p, "claim", { voyageId: trip.row.id }, key);
    expect(failed.status).toBe(500);
    expect(await assets(p)).toEqual(before);
    const retained = await db.expedition.findUniqueOrThrow({
      where: { id: trip.row.id },
    });
    expect(retained.status).toBe("RETURNING");
    expect(retained.claimedAt).toBeNull();
    expect(retained.result).toEqual(trip.result);
    expect(
      await db.idempotencyRecord.count({ where: { userId: p.id, key } }),
    ).toBe(0);
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "exploration:claim" },
      }),
    ).toBe(0);
    await db.playerProgress.update({
      where: { userId: p.id },
      data: { coins: original.coins, xp: original.xp },
    });
    await success(p, "claim", { voyageId: trip.row.id }, key);
    const after = await assets(p);
    expectStockChange(original.stock, after.stock, {}, trip.result.resources);
    expect(after.coins).toBe(original.coins + trip.result.coins);
    expect((await view(p)).progress.claimed).toBe(1);
  });

  it("rejects foreign ships and voyage choices or claims without changing either account", async () => {
    const owner = await makePlayer(),
      stranger = await makePlayer(),
      trip = await voyage(owner);
    await arrive(trip.row.id);
    const before = await assets(owner),
      foreignBefore = await assets(stranger);
    const actions: [string, unknown][] = [
      ["upgrade", { shipId: trip.ship.id }],
      ["repair", { shipId: trip.ship.id }],
      ["dispatch", { shipId: trip.ship.id, regionId: "bay" }],
      ["choose", { voyageId: trip.row.id, choiceId: "return" }],
      ["claim", { voyageId: trip.row.id }],
    ];
    for (const [action, body] of actions) {
      const result = await command(stranger, action, body);
      expect(result.status, action).toBe(404);
      expect(result.body.error?.code).toBe("NOT_FOUND");
    }
    const foreign = await view(stranger);
    expect(foreign.ships).toHaveLength(0);
    expect(foreign.voyages).toHaveLength(0);
    expect(foreign.history).toHaveLength(0);
    expect(await assets(owner)).toEqual(before);
    expect(await assets(stranger)).toEqual(foreignBefore);
  });

  it("serializes dispatch and market escrow competing for the same voyage supplies", async () => {
    const p = await makePlayer(),
      ship = await buildShip(p);
    const region = (await view(p)).regions.find((r) => r.id === "bay")!;
    const [resource, quantity] = Object.entries(region.supplies).find(
      ([, n]) => n > 0,
    )!;
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: region.supplies },
    });
    const [sent, listed] = await Promise.all([
      command(p, "dispatch", { shipId: ship.id, regionId: "bay" }),
      fetch(`${base}/market`, {
        method: "POST",
        headers: {
          cookie: p.cookie,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ resource, quantity, unitPrice: 2 }),
      }).then(async (response): Promise<Reply> => ({
        status: response.status,
        body: await response.json(),
      })),
    ]);
    expect([sent, listed].filter((r) => r.status === 201)).toHaveLength(1);
    const failed = [sent, listed].find((r) => r.status !== 201)!;
    expect(failed.status).toBe(409);
    expect(failed.body.error?.code).toBe("INSUFFICIENT_RESOURCES");
    const dispatched = sent.status === 201;
    const stock = (await assets(p)).stock;
    const escrow = await db.marketListing.findMany({
      where: { sellerId: p.id, status: "ACTIVE" },
    });
    expect(
      (stock[resource as keyof Bundle] ?? 0) +
        escrow.reduce((sum, row) => sum + row.quantity, 0) +
        (dispatched ? quantity : 0),
    ).toBe(quantity);
    expect(await db.expedition.count({ where: { shipId: ship.id } })).toBe(
      Number(dispatched),
    );
  });

  it("reuses a claim receipt after a committed HTTP response is lost to a client timeout", async () => {
    const p = await makePlayer(),
      trip = await readyVoyage(p),
      before = await assets(p),
      key = randomUUID();
    let resolveCommitted!: (reply: Reply) => void,
      rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<Reply>((resolve, reject) => {
      resolveCommitted = resolve;
      rejectCommitted = reject;
    });
    const proxy = createServer(async (req) => {
      req.resume();
      try {
        resolveCommitted(
          await command(p, "claim", { voyageId: trip.row.id }, key),
        );
      } catch (error) {
        rejectCommitted(error);
      }
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("No proxy port");
    const controller = new AbortController();
    const interrupted = expect(
      fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    try {
      const first = await committed;
      expect(first.status).toBe(201);
      controller.abort(
        new DOMException("Lost response after database commit", "TimeoutError"),
      );
      await interrupted;
      expect(
        (await success(p, "claim", { voyageId: trip.row.id }, key)).body,
      ).toEqual(first.body);
      const after = await assets(p);
      expectStockChange(before.stock, after.stock, {}, trip.result.resources);
      expect(after.coins).toBe(before.coins + trip.result.coins);
      expect(
        await db.gameEvent.count({
          where: { userId: p.id, type: "exploration:claim" },
        }),
      ).toBe(1);
    } finally {
      if (!controller.signal.aborted)
        controller.abort(new DOMException("Test cleanup", "TimeoutError"));
      await interrupted;
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("unlocks all five regions, builds all three ships from real exploration alloys and delivers a relic research order", async () => {
    const p = await makePlayer(),
      ship = await buildShip(p);
    await success(p, "upgrade", { shipId: ship.id });
    await success(p, "upgrade", { shipId: ship.id });
    const schedule: [RegionId, number][] = [
      ["bay", 2],
      ["wrecks", 2],
      ["coral", 2],
      ["storm", 3],
      ["lost", 1],
    ];
    const rareBefore = await assets(p);
    for (const resource of ["seed", "alloy", "relic"] as const)
      expect(rareBefore.stock[resource] ?? 0).toBe(0);
    for (const [regionId, count] of schedule) {
      expect(
        (await view(p)).regions.find((region) => region.id === regionId)!
          .unlocked,
        regionId,
      ).toBe(true);
      for (let n = 0; n < count; n++) {
        await success(p, "dispatch", { shipId: ship.id, regionId });
        const sailing = await db.expedition.findFirstOrThrow({
          where: { shipId: ship.id, status: "SAILING" },
        });
        await arrive(sailing.id);
        await success(p, "choose", {
          voyageId: sailing.id,
          choiceId: "return",
        });
        await returnHome(sailing.id);
        await success(p, "claim", { voyageId: sailing.id });
      }
      expect((await view(p)).progress.regions[regionId]).toBe(count);
    }
    const completed = await view(p),
      acquired = await assets(p);
    expect(completed.progress.claimed).toBe(10);
    expect(completed.regions.every((region) => region.unlocked)).toBe(true);
    for (const resource of ["seed", "alloy", "relic"] as const)
      expect(acquired.stock[resource] ?? 0, resource).toBeGreaterThan(0);
    const neededAlloy =
      (SHIPS.salvager.cost.alloy ?? 0) + (SHIPS.sailboat.cost.alloy ?? 0);
    expect(acquired.stock.alloy!).toBeGreaterThanOrEqual(neededAlloy);
    await buildShip(p, "salvager");
    await buildShip(p, "sailboat");
    const fleet = await view(p);
    expect(fleet.ships.map((s) => s.kind).sort()).toEqual([
      "sailboat",
      "salvager",
      "skiff",
    ]);
    expect((await assets(p)).stock.alloy).toBe(
      acquired.stock.alloy! - neededAlloy,
    );
    expect(fleet.ships.find((s) => s.id === ship.id)!.level).toBe(3);

    const template = await db.order.findUniqueOrThrow({
      where: { code: "relic-navigation-study" },
    });
    // Select one real seeded research template as a fixture instead of waiting
    // for recurring order rotation. Delivery and reward settlement use real HTTP.
    const order = await db.playerOrder.create({
      data: {
        userId: p.id,
        orderCode: template.code,
        name: template.name,
        description: template.description,
        input: template.input as Prisma.InputJsonObject,
        coins: template.coins,
        xp: template.xp,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const beforeOrder = await assets(p);
    const response = await fetch(`${base}/game/order`, {
      method: "POST",
      headers: {
        cookie: p.cookie,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ orderId: order.id }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(201);
    const afterOrder = await assets(p);
    expectStockChange(
      beforeOrder.stock,
      afterOrder.stock,
      template.input as Bundle,
    );
    expect(afterOrder.coins).toBe(beforeOrder.coins + template.coins);
    expect(afterOrder.xp).toBe(beforeOrder.xp + template.xp);
    expect(
      (await db.playerOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .completedAt,
    ).not.toBeNull();
  });

  it("restores a voyage and its committed outcomes across three independent API processes", async () => {
    const p = await makePlayer();
    const first = await startIndependentApi();
    let trip: Awaited<ReturnType<typeof voyage>>;
    try {
      trip = await voyage(p, first.apiBase);
    } finally {
      await first.stop();
    }
    await arrive(trip.row.id);
    const second = await startIndependentApi();
    let expected: VoyageResultView;
    try {
      const restored = (await view(p, second.apiBase)).voyages.find(
        (v) => v.id === trip.row.id,
      )!;
      expect(restored.phase).toBe("choice");
      expect(
        (await db.expedition.findUniqueOrThrow({ where: { id: trip.row.id } }))
          .outcomes,
      ).toEqual(trip.row.outcomes);
      await success(
        p,
        "choose",
        { voyageId: trip.row.id, choiceId: "return" },
        randomUUID(),
        second.apiBase,
      );
      expected = (
        await db.expedition.findUniqueOrThrow({ where: { id: trip.row.id } })
      ).result as unknown as VoyageResultView;
    } finally {
      await second.stop();
    }
    await returnHome(trip.row.id);
    const third = await startIndependentApi();
    try {
      const before = await assets(p);
      expect(
        (await view(p, third.apiBase)).voyages.find(
          (v) => v.id === trip.row.id,
        )!.phase,
      ).toBe("ready");
      await success(
        p,
        "claim",
        { voyageId: trip.row.id },
        randomUUID(),
        third.apiBase,
      );
      const after = await assets(p);
      expectStockChange(before.stock, after.stock, {}, expected.resources);
      expect(after.coins).toBe(before.coins + expected.coins);
      expect((await view(p, third.apiBase)).progress.claimed).toBe(1);
    } finally {
      await third.stop();
    }
  }, 45000);
});
