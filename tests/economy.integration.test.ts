import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { passwordHash, tokenHash } from "../apps/api/src/auth";
import { db } from "../apps/api/src/database";
import {
  adminConfig,
  buyListing,
  cancelListing,
  createListing,
  gameAction,
  leaderboard,
  rebuildRankings,
  redis,
  state,
} from "../apps/api/src/game";
import {
  BUILDINGS,
  ECONOMY,
  type Bundle,
} from "../packages/game-config/src/index";
const base = "http://127.0.0.1:3001/api";
const accounts: { id: string; cookie: string }[] = [];
async function makePlayer() {
  const user = await db.user.create({
    data: {
      email: `integration-${randomUUID()}@example.test`,
      passwordHash: await passwordHash("IntegrationTest2026"),
      profile: { create: { name: "测试漂流者" } },
      progress: { create: { coins: 100 } },
      inventory: { create: { resources: ECONOMY.initial } },
      island: {
        create: {
          tiles: {
            create: Array.from({ length: 9 }, (_, i) => ({
              x: (i % 3) - 1,
              y: Math.floor(i / 3) - 1,
            })),
          },
        },
      },
      salvage: {
        create: {
          kind: "wood",
          reward: { wood: 4 },
          x: 15,
          y: 30,
          expiresAt: new Date(Date.now() + 180000),
        },
      },
    },
  });
  const id = user.id,
    token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      userId: id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const cookie = `driftopia_session=${token}`;
  const account = { id, cookie };
  accounts.push(account);
  const island = await db.island.findUniqueOrThrow({ where: { userId: id } });
  await db.building.createMany({
    data: [
      { islandId: island.id, kind: "dock", x: 1, y: 1 },
      { islandId: island.id, kind: "warehouse", x: -1, y: -1 },
    ],
  });
  return account;
}
async function inventory(id: string) {
  return (await db.inventory.findUniqueOrThrow({ where: { userId: id } }))
    .resources as Bundle;
}
async function post(
  cookie: string,
  path: string,
  body: unknown,
  key = randomUUID(),
) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}
async function coins(id: string) {
  return (await db.playerProgress.findUniqueOrThrow({ where: { userId: id } }))
    .coins;
}
const listing = (id: string, quantity = 1, unitPrice = 5) =>
  createListing(id, randomUUID(), {
    resource: "wood",
    quantity,
    unitPrice,
  }) as Promise<{ id: string }>;
beforeAll(async () => {
  await db.$connect();
  await redis.connect().catch(() => undefined);
});
afterAll(async () => {
  const ids = accounts.map((a) => a.id);
  await db.gameConfigVersion.deleteMany({ where: { actorId: { in: ids } } });
  await db.marketTransaction.deleteMany({
    where: { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }] },
  });
  await db.marketListing.deleteMany({ where: { sellerId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await rebuildRankings();
  await db.$disconnect();
  redis.disconnect();
});
describe.sequential("PostgreSQL economic consistency", () => {
  it("rolls back unaffordable construction and preserves nonnegative inventory", async () => {
    const p = await makePlayer();
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: {} },
    });
    await expect(
      gameAction(p.id, randomUUID(), "build", { kind: "purifier", x: 0, y: 0 }),
    ).rejects.toThrow("资源还不够");
    expect((await state(p.id)).coins).toBe(100);
    expect((await state(p.id)).buildings).toHaveLength(2);
  });
  it("validates salvage ownership and ignores client supplied rewards", async () => {
    const p = await makePlayer(),
      other = await makePlayer();
    const s = (await state(p.id)).salvage[0];
    await expect(
      gameAction(other.id, randomUUID(), "salvage", { spawnId: s.id }),
    ).rejects.toThrow("漂流物");
    const row = await db.salvageSpawn.findUniqueOrThrow({
      where: { id: s.id },
    });
    const before = await inventory(p.id);
    await gameAction(p.id, randomUUID(), "salvage", {
      spawnId: s.id,
      reward: { wood: 100000 },
    });
    const after = await inventory(p.id);
    expect((after.wood ?? 0) - (before.wood ?? 0)).toBe(
      (row.reward as Bundle).wood ?? 0,
    );
    await expect(
      gameAction(p.id, randomUUID(), "salvage", { spawnId: s.id }),
    ).rejects.toThrow("漂流物");
  });
  it("settles offline production once and rejects duplicate collection", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const building = (await state(p.id)).buildings.find(
      (b) => b.kind === "purifier",
    )!;
    await gameAction(p.id, randomUUID(), "produce", {
      buildingId: building.id,
    });
    await db.productionJob.updateMany({
      where: { buildingId: building.id },
      data: {
        startsAt: new Date(Date.now() - 60000),
        finishesAt: new Date(Date.now() - 1000),
      },
    });
    expect((await state(p.id)).offlineReady).toBe(1);
    const key = randomUUID();
    await gameAction(p.id, key, "collect", { buildingId: building.id });
    await gameAction(p.id, key, "collect", { buildingId: building.id });
    expect((await inventory(p.id)).water).toBe(3);
    await expect(
      gameAction(p.id, randomUUID(), "collect", { buildingId: building.id }),
    ).rejects.toThrow("还需要");
    expect(
      await db.productionJob.count({
        where: { buildingId: building.id, status: "COLLECTED" },
      }),
    ).toBe(1);
  });
  it("prevents overlapping placement and editing another player’s building", async () => {
    const p = await makePlayer(),
      other = await makePlayer();
    const s = await state(p.id);
    await expect(
      gameAction(p.id, randomUUID(), "build", { kind: "purifier", x: 1, y: 1 }),
    ).rejects.toThrow("已经有建筑");
    await expect(
      gameAction(other.id, randomUUID(), "upgrade", {
        buildingId: s.buildings[0].id,
      }),
    ).rejects.toThrow("找不到");
  });
  it("sells the last unit to only one of two simultaneous buyers", async () => {
    const seller = await makePlayer(),
      a = await makePlayer(),
      b = await makePlayer();
    const l = await listing(seller.id);
    const results = await Promise.allSettled([
      buyListing(a.id, randomUUID(), l.id, { quantity: 1 }),
      buyListing(b.id, randomUUID(), l.id, { quantity: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(1);
    expect(
      (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
        .quantity,
    ).toBe(0);
    const balances = await db.playerProgress.findMany({
      where: { userId: { in: [a.id, b.id, seller.id] } },
    });
    expect(balances.reduce((n, p) => n + p.coins, 0)).toBe(299);
  });
  it("replays an identical purchase without charging twice", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id, 2);
    const key = randomUUID();
    const results = await Promise.all([
      buyListing(buyer.id, key, l.id, { quantity: 1 }),
      buyListing(buyer.id, key, l.id, { quantity: 1 }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await state(buyer.id)).coins).toBe(95);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(1);
    await expect(
      buyListing(buyer.id, key, l.id, { quantity: 2 }),
    ).rejects.toThrow("请求编号");
  });
  it("serializes cancellation against purchase without duplicating inventory", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id);
    const results = await Promise.allSettled([
      cancelListing(seller.id, randomUUID(), l.id),
      buyListing(buyer.id, randomUUID(), l.id, { quantity: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sum =
      ((await inventory(seller.id)).wood ?? 0) +
      ((await inventory(buyer.id)).wood ?? 0);
    expect(sum).toBe(ECONOMY.initial.wood! * 2);
  });
  it("rolls back failed purchases and prohibits self-purchases", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id, 1, 101);
    await expect(
      buyListing(buyer.id, randomUUID(), l.id, { quantity: 1 }),
    ).rejects.toThrow("金币不足");
    expect(
      (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
        .quantity,
    ).toBe(1);
    expect((await state(buyer.id)).coins).toBe(100);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(0);
    await expect(
      buyListing(seller.id, randomUUID(), l.id, { quantity: 1 }),
    ).rejects.toThrow("自己的商品");
  });
  it("keeps full-warehouse output collectible without losing the job", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(p.id)).buildings.find((b) => b.kind === "purifier")!;
    await gameAction(p.id, randomUUID(), "produce", { buildingId: b.id });
    await db.productionJob.updateMany({
      where: { buildingId: b.id },
      data: {
        startsAt: new Date(Date.now() - 5000),
        finishesAt: new Date(Date.now() - 1000),
      },
    });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 160 } },
    });
    await expect(
      gameAction(p.id, randomUUID(), "collect", { buildingId: b.id }),
    ).rejects.toThrow("仓库满");
    expect(
      await db.productionJob.count({
        where: { buildingId: b.id, status: "RUNNING" },
      }),
    ).toBe(1);
  });
  it("completes an order atomically and cannot pay its reward twice", async () => {
    const p = await makePlayer();
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 4, water: 3 } },
    });
    const order = (await state(p.id)).orders.find((o) =>
      o.name.includes("一杯水"),
    )!;
    await gameAction(p.id, randomUUID(), "order", { orderId: order.id });
    expect((await state(p.id)).coins).toBe(100 + order.coins);
    await expect(
      gameAction(p.id, randomUUID(), "order", { orderId: order.id }),
    ).rejects.toThrow("完成或过期");
    expect((await inventory(p.id)).water).toBe(0);
  });
  it("rebuilds Redis leaderboards from authoritative progress", async () => {
    const p = await makePlayer();
    await db.playerProgress.update({
      where: { userId: p.id },
      data: { prosperity: 9999 },
    });
    await redis.del("ranks:prosperity");
    await rebuildRankings();
    expect(await redis.zscore("ranks:prosperity", p.id)).toBe("9999");
    expect((await leaderboard("prosperity"))[0].id).toBe(p.id);
  });
  it("denies regular users admin endpoints and rejects cross-origin mutations", async () => {
    const p = await makePlayer();
    const res = await fetch(`${base}/admin`, { headers: { cookie: p.cookie } });
    expect(res.status).toBe(403);
    const bad = await fetch(`${base}/game/expand`, {
      method: "POST",
      headers: {
        cookie: p.cookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ x: 2, y: 1 }),
    });
    expect(bad.status).toBe(403);
    const anonymous = await fetch(`${base}/state`);
    expect(anonymous.status).toBe(401);
  });
  it("snapshots running production across administrator recipe changes", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(p.id)).buildings.find((b) => b.kind === "purifier")!;
    await gameAction(p.id, randomUUID(), "produce", { buildingId: b.id });
    const admin = await db.user.update({
      where: { id: p.id },
      data: { role: "ADMIN" },
    });
    await adminConfig(admin, randomUUID(), {
      type: "recipe",
      kind: "purifier",
      recipe: { input: {}, output: { water: 4 }, seconds: 15 },
    });
    await gameAction(p.id, randomUUID(), "produce", { buildingId: b.id });
    const jobs = await db.productionJob.findMany({
      where: { buildingId: b.id },
      orderBy: { startsAt: "asc" },
    });
    expect(jobs.map((j) => j.output)).toEqual([{ water: 3 }, { water: 4 }]);
    await db.gameConfigVersion.deleteMany({ where: { actorId: p.id } });
  });
  it("rolls back earlier writes when seller settlement fails inside the transaction", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer();
    await db.playerProgress.update({
      where: { userId: seller.id },
      data: { coins: 2147483647 },
    });
    const l = await listing(seller.id);
    await expect(
      buyListing(buyer.id, randomUUID(), l.id, { quantity: 1 }),
    ).rejects.toThrow();
    expect((await state(buyer.id)).coins).toBe(100);
    expect((await inventory(buyer.id)).wood).toBe(ECONOMY.initial.wood);
    expect(
      (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
        .quantity,
    ).toBe(1);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(0);
  });
  it("frees warehouse space with an audited, idempotent discard", async () => {
    const p = await makePlayer(),
      key = randomUUID();
    await gameAction(p.id, key, "discard", {
      resource: "plastic",
      quantity: 2,
    });
    await gameAction(p.id, key, "discard", {
      resource: "plastic",
      quantity: 2,
    });
    expect((await inventory(p.id)).plastic).toBe(ECONOMY.initial.plastic! - 2);
    expect((await state(p.id)).coins).toBe(100);
    await expect(
      gameAction(p.id, randomUUID(), "discard", {
        resource: "plastic",
        quantity: 100,
      }),
    ).rejects.toThrow();
    expect(
      await db.gameEvent.count({ where: { userId: p.id, type: "discard" } }),
    ).toBe(1);
  });
  it("bounds offline automation to persisted jobs and serializes concurrent settlement", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(p.id)).buildings.find((b) => b.kind === "purifier")!;
    const key = randomUUID();
    await gameAction(p.id, key, "automation", {
      buildingId: b.id,
      enabled: true,
    });
    await gameAction(p.id, key, "automation", {
      buildingId: b.id,
      enabled: true,
    });
    expect(await db.productionJob.count({ where: { buildingId: b.id } })).toBe(
      30,
    );
    await db.productionJob.updateMany({
      where: { buildingId: b.id },
      data: {
        startsAt: new Date(Date.now() - 4 * 86400000),
        finishesAt: new Date(Date.now() - 3 * 86400000),
      },
    });
    const before = Date.now();
    const snapshots = await Promise.all([
      state(p.id),
      state(p.id),
      state(p.id),
    ]);
    for (const s of snapshots) {
      expect(s.inventory.water).toBe(90);
      expect(s.stats.produced).toBe(30);
      expect(s.productionReport?.batches).toBe(30);
      expect(s.buildings.find((x) => x.id === b.id)?.jobs).toHaveLength(30);
    }
    expect(new Set(snapshots.map((s) => s.productionReport?.id)).size).toBe(1);
    const scheduled = await db.productionJob.findMany({
      where: { buildingId: b.id, status: "RUNNING" },
    });
    expect(scheduled.every((j) => j.startsAt.getTime() >= before)).toBe(true);
    expect(
      await db.gameEvent.count({
        where: { userId: p.id, type: "production:auto" },
      }),
    ).toBe(1);
  });
  it("reserves materials once and preserves paid queues when automation is disabled", async () => {
    const p = await makePlayer();
    const island = await db.island.findUniqueOrThrow({
      where: { userId: p.id },
    });
    const b = await db.building.create({
      data: { islandId: island.id, kind: "workshop", x: 0, y: 0 },
    });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 10 } },
    });
    await gameAction(p.id, randomUUID(), "automation", {
      buildingId: b.id,
      enabled: true,
    });
    expect((await inventory(p.id)).wood).toBe(2);
    expect(await db.productionJob.count({ where: { buildingId: b.id } })).toBe(
      2,
    );
    await expect(
      gameAction(p.id, randomUUID(), "produce", { buildingId: b.id }),
    ).rejects.toThrow("关闭自动续产");
    await gameAction(p.id, randomUUID(), "automation", {
      buildingId: b.id,
      enabled: false,
    });
    await db.productionJob.updateMany({
      where: { buildingId: b.id },
      data: {
        startsAt: new Date(Date.now() - 10000),
        finishesAt: new Date(Date.now() - 1000),
      },
    });
    const snapshot = await state(p.id);
    expect(snapshot.productionReport).toBeNull();
    expect(snapshot.buildings.find((x) => x.id === b.id)?.jobs).toHaveLength(2);
    expect(snapshot.inventory.plank ?? 0).toBe(0);
    await gameAction(p.id, randomUUID(), "collect", { buildingId: b.id });
    expect((await inventory(p.id)).plank).toBe(4);
    expect((await inventory(p.id)).wood).toBe(2);
  });
  it("pauses at warehouse capacity and resumes without losing or duplicating batches", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(p.id)).buildings.find((b) => b.kind === "purifier")!;
    await gameAction(p.id, randomUUID(), "automation", {
      buildingId: b.id,
      enabled: true,
    });
    await db.productionJob.updateMany({
      where: { buildingId: b.id },
      data: {
        startsAt: new Date(Date.now() - 10000),
        finishesAt: new Date(Date.now() - 1000),
      },
    });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 157 } },
    });
    const full = await state(p.id);
    expect(full.inventory.water).toBe(3);
    expect(full.buildings.find((x) => x.id === b.id)?.autoStatus).toBe(
      "warehouse_full",
    );
    expect(full.buildings.find((x) => x.id === b.id)?.jobs).toHaveLength(29);
    await gameAction(p.id, randomUUID(), "discard", {
      resource: "wood",
      quantity: 6,
    });
    const resumed = await state(p.id);
    expect(resumed.inventory.water).toBe(9);
    expect(resumed.stats.produced).toBe(3);
    expect(resumed.buildings.find((x) => x.id === b.id)?.jobs).toHaveLength(27);
    await gameAction(p.id, randomUUID(), "automation", {
      buildingId: b.id,
      enabled: false,
    });
    await gameAction(p.id, randomUUID(), "discard", {
      resource: "wood",
      quantity: 3,
    });
    await gameAction(p.id, randomUUID(), "collect", { buildingId: b.id });
    expect((await inventory(p.id)).water).toBe(12);
    expect(
      await db.productionJob.count({
        where: { buildingId: b.id, status: "RUNNING" },
      }),
    ).toBe(26);
  });
  it("retries material-starved automation and rejects ownership or recipe violations", async () => {
    const p = await makePlayer(),
      other = await makePlayer();
    const island = await db.island.findUniqueOrThrow({
      where: { userId: p.id },
    });
    const b = await db.building.create({
      data: { islandId: island.id, kind: "workshop", x: 0, y: 0 },
    });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: {} },
    });
    await expect(
      gameAction(other.id, randomUUID(), "automation", {
        buildingId: b.id,
        enabled: true,
      }),
    ).rejects.toThrow("建筑");
    const dock = (await state(p.id)).buildings.find((b) => b.kind === "dock")!;
    await expect(
      gameAction(p.id, randomUUID(), "automation", {
        buildingId: dock.id,
        enabled: true,
      }),
    ).rejects.toThrow("生产");
    await gameAction(p.id, randomUUID(), "automation", {
      buildingId: b.id,
      enabled: true,
    });
    expect(
      (await state(p.id)).buildings.find((x) => x.id === b.id)?.autoStatus,
    ).toBe("materials");
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: { wood: 4 } },
    });
    const resumed = await state(p.id);
    expect(resumed.inventory.wood).toBe(0);
    expect(resumed.buildings.find((x) => x.id === b.id)?.jobs).toHaveLength(1);
    expect(resumed.buildings.find((x) => x.id === b.id)?.autoStatus).toBe(
      "running",
    );
  });
  it("fills order slots with unseen unlocked templates before repeating old ones", async () => {
    const p = await makePlayer();
    const initial = await state(p.id);
    const first = initial.orders.find((o) => o.name.includes("一杯水"))!;
    const newlyUnlocked = await db.order.findMany({
      where: { level: 2 },
      select: { code: true },
    });
    await db.playerProgress.update({
      where: { userId: p.id },
      data: { xp: 40 },
    });
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: first.input },
    });
    await gameAction(p.id, randomUUID(), "order", { orderId: first.id });
    const next = await state(p.id);
    expect(next.orders).toHaveLength(3);
    expect(next.orders.some((o) => o.name === first.name)).toBe(false);
    const issued = await db.playerOrder.findMany({
      where: { userId: p.id, completedAt: null },
    });
    // The catalog now also includes alloy research at level two. The invariant
    // is an unseen unlocked template, not either of two old hard-coded codes.
    expect(
      issued.some((o) =>
        newlyUnlocked.some((template) => template.code === o.orderCode),
      ),
    ).toBe(true);
  });
  it("settles a bulk purchase with one rounded fee and retains unbought escrow", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id, 5, 7);
    const key = randomUUID();
    await buyListing(buyer.id, key, l.id, { quantity: 3 });
    await buyListing(buyer.id, key, l.id, { quantity: 3 });
    expect((await state(buyer.id)).coins).toBe(79);
    expect((await state(seller.id)).coins).toBe(119);
    expect((await inventory(buyer.id)).wood).toBe(21);
    expect(
      (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
        .quantity,
    ).toBe(2);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(1);
    await cancelListing(seller.id, randomUUID(), l.id);
    expect((await inventory(seller.id)).wood).toBe(15);
  });
  it("sells the last unit once under twenty concurrent real HTTP purchase requests", async () => {
    const seller = await makePlayer();
    const buyers: (typeof accounts)[number][] = [];
    for (let n = 0; n < 20; n++) buyers.push(await makePlayer());
    const l = await listing(seller.id, 1, 7);
    const results = await Promise.all(
      buyers.map(async (buyer) => {
        const response = await post(buyer.cookie, `/market/${l.id}/buy`, {
          quantity: 1,
        });
        return { buyer, status: response.status, body: await response.json() };
      }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rejected = results.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.status === 409)).toBe(true);
    expect(rejected.every((r) => r.body.error.code === "SOLD_OUT")).toBe(true);

    const trades = await db.marketTransaction.findMany({
      where: { listingId: l.id },
    });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ quantity: 1, total: 7, fee: 1 });
    expect(
      await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }),
    ).toMatchObject({ status: "SOLD", quantity: 0 });
    expect(await coins(seller.id)).toBe(106);
    expect((await inventory(seller.id)).wood).toBe(ECONOMY.initial.wood! - 1);
    for (const result of results) {
      const won = result.status === 201;
      expect(await coins(result.buyer.id)).toBe(won ? 93 : 100);
      expect((await inventory(result.buyer.id)).wood).toBe(
        ECONOMY.initial.wood! + Number(won),
      );
      expect(
        await db.idempotencyRecord.count({
          where: { userId: result.buyer.id },
        }),
      ).toBe(Number(won));
    }
    const ids = [seller.id, ...buyers.map((p) => p.id)];
    const balances = await db.playerProgress.findMany({
      where: { userId: { in: ids } },
    });
    const stocks = await db.inventory.findMany({
      where: { userId: { in: ids } },
    });
    expect(balances.reduce((sum, p) => sum + p.coins, 0) + trades[0].fee).toBe(
      2100,
    );
    expect(
      stocks.reduce((sum, p) => sum + ((p.resources as Bundle).wood ?? 0), 0),
    ).toBe(ECONOMY.initial.wood! * 21);
    expect(
      await db.gameEvent.count({
        where: {
          userId: { in: buyers.map((p) => p.id) },
          type: `market:buy:${l.id}`,
        },
      }),
    ).toBe(1);
  });
  it("collects a matured production reward only once under twenty concurrent attempts", async () => {
    const p = await makePlayer();
    await gameAction(p.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(p.id)).buildings.find((b) => b.kind === "purifier")!;
    await gameAction(p.id, randomUUID(), "produce", { buildingId: b.id });
    await db.productionJob.updateMany({
      where: { buildingId: b.id },
      data: {
        startsAt: new Date(Date.now() - 60000),
        finishesAt: new Date(Date.now() - 1000),
      },
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        gameAction(p.id, randomUUID(), "collect", { buildingId: b.id }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(19);
    for (const result of rejected)
      expect(result.reason).toMatchObject({ code: "NOT_READY" });
    expect((await inventory(p.id)).water).toBe(3);
    expect(
      (await db.playerProgress.findUniqueOrThrow({ where: { userId: p.id } }))
        .produced,
    ).toBe(1);
    expect(
      await db.productionJob.count({
        where: { buildingId: b.id, status: "COLLECTED" },
      }),
    ).toBe(1);
    expect(
      await db.gameEvent.count({ where: { userId: p.id, type: "collect" } }),
    ).toBe(1);
  });
  it("serializes building and selling against the same limited inventory", async () => {
    const p = await makePlayer();
    const stock = {
      wood: BUILDINGS.purifier.cost.wood!,
      plastic: BUILDINGS.purifier.cost.plastic!,
    };
    await db.inventory.update({
      where: { userId: p.id },
      data: { resources: stock },
    });
    const results = await Promise.allSettled([
      gameAction(p.id, randomUUID(), "build", { kind: "purifier", x: 0, y: 0 }),
      listing(p.id, stock.wood),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const island = await db.island.findUniqueOrThrow({
      where: { userId: p.id },
      include: { buildings: true },
    });
    const built = island.buildings.some((b) => b.kind === "purifier");
    const escrow = await db.marketListing.findMany({
      where: { sellerId: p.id, status: "ACTIVE" },
    });
    const remaining = await inventory(p.id);
    expect(
      (remaining.wood ?? 0) +
        escrow.reduce((sum, l) => sum + l.quantity, 0) +
        (built ? stock.wood : 0),
    ).toBe(stock.wood);
    expect(remaining.plastic).toBe(built ? 0 : stock.plastic);
    expect(await coins(p.id)).toBe(
      100 - (built ? BUILDINGS.purifier.coins : 0),
    );
    expect(escrow).toHaveLength(built ? 0 : 1);
  });
  it("preserves both mutations when building and purchasing happen simultaneously", async () => {
    const builder = await makePlayer(),
      seller = await makePlayer();
    const l = await listing(seller.id, 2, 7);
    await Promise.all([
      gameAction(builder.id, randomUUID(), "build", {
        kind: "purifier",
        x: 0,
        y: 0,
      }),
      buyListing(builder.id, randomUUID(), l.id, { quantity: 2 }),
    ]);
    expect((await inventory(builder.id)).wood).toBe(
      ECONOMY.initial.wood! - BUILDINGS.purifier.cost.wood! + 2,
    );
    expect((await inventory(builder.id)).plastic).toBe(
      ECONOMY.initial.plastic! - BUILDINGS.purifier.cost.plastic!,
    );
    expect(await coins(builder.id)).toBe(100 - BUILDINGS.purifier.coins - 14);
    expect(await coins(seller.id)).toBe(113);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(1);
    expect(
      (await state(builder.id)).buildings.filter((b) => b.kind === "purifier"),
    ).toHaveLength(1);
  });
  it("conserves all assets when cancellation races twenty purchase attempts", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer();
    const l = await listing(seller.id, 1, 7);
    const attempts = await Promise.allSettled([
      cancelListing(seller.id, randomUUID(), l.id),
      ...Array.from({ length: 20 }, () =>
        buyListing(buyer.id, randomUUID(), l.id, { quantity: 1 }),
      ),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const closed = await db.marketListing.findUniqueOrThrow({
      where: { id: l.id },
    });
    const trades = await db.marketTransaction.findMany({
      where: { listingId: l.id },
    });
    const sold = closed.status === "SOLD";
    expect(["SOLD", "CANCELLED"]).toContain(closed.status);
    expect(closed.quantity).toBe(sold ? 0 : 1);
    expect(trades).toHaveLength(Number(sold));
    expect((await inventory(seller.id)).wood).toBe(
      ECONOMY.initial.wood! - Number(sold),
    );
    expect((await inventory(buyer.id)).wood).toBe(
      ECONOMY.initial.wood! + Number(sold),
    );
    expect(await coins(seller.id)).toBe(sold ? 106 : 100);
    expect(await coins(buyer.id)).toBe(sold ? 93 : 100);
    expect(
      (await coins(seller.id)) +
        (await coins(buyer.id)) +
        (trades[0]?.fee ?? 0),
    ).toBe(200);
  });
  it("replays a committed purchase after a real HTTP response is lost to a client timeout", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer();
    const l = await listing(seller.id, 2, 7),
      key = randomUUID();
    let resolveCommitted!: (value: { status: number; body: unknown }) => void;
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        resolveCommitted = resolve;
        rejectCommitted = reject;
      },
    );
    // The proxy calls the real API and deliberately withholds its response after
    // PostgreSQL commits. No repository, transport response, or transaction is mocked.
    const proxy = createServer(async (req) => {
      req.resume();
      try {
        const response = await post(
          buyer.cookie,
          `/market/${l.id}/buy`,
          { quantity: 1 },
          key,
        );
        resolveCommitted({
          status: response.status,
          body: await response.json(),
        });
      } catch (error) {
        rejectCommitted(error);
      }
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("Missing proxy address");
    const controller = new AbortController();
    const firstAttempt = fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      signal: controller.signal,
    });
    // Attach the rejection handler before triggering cancellation.
    const interrupted = expect(firstAttempt).rejects.toMatchObject({
      name: "TimeoutError",
    });
    try {
      const first = await committed;
      expect(first.status).toBe(201);
      controller.abort(
        new DOMException(
          "Simulated client timeout after commit",
          "TimeoutError",
        ),
      );
      await interrupted;
      const retry = await post(
        buyer.cookie,
        `/market/${l.id}/buy`,
        { quantity: 1 },
        key,
      );
      expect(retry.status).toBe(201);
      expect(await retry.json()).toEqual(first.body);
      expect(await coins(buyer.id)).toBe(93);
      expect(await coins(seller.id)).toBe(106);
      expect((await inventory(buyer.id)).wood).toBe(ECONOMY.initial.wood! + 1);
      expect(
        await db.marketTransaction.count({ where: { listingId: l.id } }),
      ).toBe(1);
      expect(
        (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
          .quantity,
      ).toBe(1);
      expect(
        await db.idempotencyRecord.count({ where: { userId: buyer.id, key } }),
      ).toBe(1);
    } finally {
      if (!controller.signal.aborted)
        controller.abort(
          new DOMException("Simulated client timeout", "TimeoutError"),
        );
      await interrupted;
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("rolls back a PostgreSQL settlement failure and successfully retries the same key", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer();
    const l = await listing(seller.id),
      key = randomUUID();
    // int4 overflow occurs after listing, inventory, and buyer balance updates.
    await db.playerProgress.update({
      where: { userId: seller.id },
      data: { coins: 2147483647 },
    });
    await expect(
      buyListing(buyer.id, key, l.id, { quantity: 1 }),
    ).rejects.toThrow();
    expect(await coins(buyer.id)).toBe(100);
    expect((await inventory(buyer.id)).wood).toBe(ECONOMY.initial.wood);
    expect(
      await db.idempotencyRecord.count({ where: { userId: buyer.id, key } }),
    ).toBe(0);
    expect(
      await db.gameEvent.count({
        where: { userId: buyer.id, type: `market:buy:${l.id}` },
      }),
    ).toBe(0);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(0);
    expect(
      await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }),
    ).toMatchObject({ quantity: 1, status: "ACTIVE" });
    await db.playerProgress.update({
      where: { userId: seller.id },
      data: { coins: 100 },
    });
    const success = await buyListing(buyer.id, key, l.id, { quantity: 1 });
    expect(await buyListing(buyer.id, key, l.id, { quantity: 1 })).toEqual(
      success,
    );
    expect(await coins(buyer.id)).toBe(95);
    expect(await coins(seller.id)).toBe(104);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(1);
    expect(
      await db.idempotencyRecord.count({ where: { userId: buyer.id, key } }),
    ).toBe(1);
  });
  it("normalizes parameter order for retries while rejecting a changed operation", async () => {
    const p = await makePlayer(),
      key = randomUUID();
    const first = await post(
      p.cookie,
      "/game/build",
      { kind: "purifier", x: 0, y: 0 },
      key,
    );
    expect(first.status).toBe(201);
    const value = await first.json();
    const retry = await post(
      p.cookie,
      "/game/build",
      { y: 0, x: 0, kind: "purifier" },
      key,
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(value);
    const changed = await post(
      p.cookie,
      "/game/build",
      { kind: "purifier", x: 0, y: 1 },
      key,
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    const otherAction = await post(
      p.cookie,
      "/game/expand",
      { x: 2, y: 1 },
      key,
    );
    expect(otherAction.status).toBe(409);
    expect((await otherAction.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (await state(p.id)).buildings.filter((b) => b.kind === "purifier"),
    ).toHaveLength(1);
  });
  it("rejects cross-player writes and exposes only public visit data", async () => {
    const owner = await makePlayer(),
      attacker = await makePlayer();
    await gameAction(owner.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const snapshot = await state(owner.id),
      b = snapshot.buildings.find((b) => b.kind === "purifier")!;
    const l = await listing(owner.id);
    const before = await inventory(owner.id);
    const cases: [string, unknown][] = [
      ["/game/produce", { buildingId: b.id }],
      ["/game/collect", { buildingId: b.id }],
      ["/game/upgrade", { buildingId: b.id }],
      ["/game/move", { buildingId: b.id, x: 0, y: 1 }],
      ["/game/automation", { buildingId: b.id, enabled: true }],
      ["/game/order", { orderId: snapshot.orders[0].id }],
      [`/market/${l.id}/cancel`, {}],
      [
        "/admin/config",
        {
          type: "recipe",
          kind: "purifier",
          recipe: { input: {}, output: { water: 99 }, seconds: 3 },
        },
      ],
      ["/admin/rebuild-rankings", {}],
    ];
    for (const [path, body] of cases) {
      const response = await post(attacker.cookie, path, body);
      const expectedCode = path.startsWith("/admin")
        ? "FORBIDDEN"
        : path === "/game/order"
          ? "ORDER_GONE"
          : "NOT_FOUND";
      expect(response.status, path).toBe(
        expectedCode === "FORBIDDEN"
          ? 403
          : expectedCode === "NOT_FOUND"
            ? 404
            : 409,
      );
      expect((await response.json()).error.code, path).toBe(expectedCode);
    }
    expect(await inventory(owner.id)).toEqual(before);
    expect(await coins(owner.id)).toBe(100 - BUILDINGS.purifier.coins);
    expect(await db.productionJob.count({ where: { buildingId: b.id } })).toBe(
      0,
    );
    const visit = await fetch(`${base}/players/${owner.id}/island`, {
      headers: { cookie: attacker.cookie },
    });
    expect(visit.status).toBe(200);
    const publicData = await visit.json();
    expect(publicData.id).toBe(owner.id);
    for (const secret of [
      "email",
      "passwordHash",
      "sessions",
      "inventory",
      "coins",
    ]) {
      expect(JSON.stringify(publicData)).not.toContain(`"${secret}"`);
    }
    const history = await fetch(`${base}/market/history?userId=${owner.id}`, {
      headers: { cookie: attacker.cookie },
    });
    expect(await history.json()).toEqual([]);
  });
  it("rejects invalid economic inputs before creating receipts or changing assets", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id, 3);
    const stockBefore = await inventory(buyer.id);
    const cases: [string, unknown][] = [
      [`/market/${l.id}/buy`, { quantity: -1 }],
      [`/market/${l.id}/buy`, { quantity: 0 }],
      [`/market/${l.id}/buy`, { quantity: 1.5 }],
      [`/market/${l.id}/buy`, { quantity: "1" }],
      [`/market/${l.id}/buy`, { quantity: 101 }],
      ["/market", { resource: "coins", quantity: 1, unitPrice: 1 }],
      ["/market", { resource: "wood", quantity: 1, unitPrice: -7 }],
      ["/market", { resource: "wood", quantity: 1, unitPrice: 10001 }],
      ["/game/build", { kind: "purifier", x: 9, y: 0 }],
      ["/game/build", { kind: "money-printer", x: 0, y: 0 }],
      ["/game/discard", { resource: "wood", quantity: -1 }],
      [
        "/game/collect",
        { buildingId: "not-a-uuid", finishesAt: 0, output: { water: 10000 } },
      ],
    ];
    for (const [path, body] of cases) {
      const response = await post(buyer.cookie, path, body);
      expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(400);
      expect((await response.json()).error.code).toBe("VALIDATION");
    }
    const missingKey = await fetch(`${base}/market/${l.id}/buy`, {
      method: "POST",
      headers: { cookie: buyer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(missingKey.status).toBe(400);
    expect(await inventory(buyer.id)).toEqual(stockBefore);
    expect(await coins(buyer.id)).toBe(100);
    expect(
      await db.idempotencyRecord.count({ where: { userId: buyer.id } }),
    ).toBe(0);
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(0);
  });
  it("ignores client supplied prices, balances, and reward timing", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer(),
      l = await listing(seller.id, 1, 7);
    const response = await post(buyer.cookie, `/market/${l.id}/buy`, {
      quantity: 1,
      total: 0,
      unitPrice: 0,
      fee: 0,
      coins: 999999,
      sellerId: buyer.id,
    });
    expect(response.status).toBe(201);
    expect(await coins(buyer.id)).toBe(93);
    expect(await coins(seller.id)).toBe(106);
    await gameAction(buyer.id, randomUUID(), "build", {
      kind: "purifier",
      x: 0,
      y: 0,
    });
    const b = (await state(buyer.id)).buildings.find(
      (b) => b.kind === "purifier",
    )!;
    const started = Date.now();
    const production = await post(buyer.cookie, "/game/produce", {
      buildingId: b.id,
      finishesAt: "2000-01-01T00:00:00Z",
      seconds: 0,
      output: { water: 999999 },
    });
    expect(production.status).toBe(201);
    const job = await db.productionJob.findFirstOrThrow({
      where: { buildingId: b.id },
    });
    expect(job.output).toEqual({ water: 3 });
    expect(job.finishesAt.getTime() - job.startsAt.getTime()).toBe(12000);
    expect(job.startsAt.getTime()).toBeGreaterThanOrEqual(started);
    const collect = await post(buyer.cookie, "/game/collect", {
      buildingId: b.id,
      ready: true,
    });
    expect(collect.status).toBe(409);
    expect((await collect.json()).error.code).toBe("NOT_READY");
  });
  it("rejects expired and revoked sessions on authoritative state requests", async () => {
    const p = await makePlayer();
    const expiredToken = randomBytes(32).toString("hex");
    await db.session.create({
      data: {
        userId: p.id,
        tokenHash: tokenHash(expiredToken),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const expired = await fetch(`${base}/state`, {
      headers: { cookie: `driftopia_session=${expiredToken}` },
    });
    expect(expired.status).toBe(401);
    const logout = await post(p.cookie, "/auth/logout", {});
    expect(logout.status).toBe(201);
    const revoked = await fetch(`${base}/state`, {
      headers: { cookie: p.cookie },
    });
    expect(revoked.status).toBe(401);
  });
  it("preserves escrow on full-warehouse cancellation and retries after space is freed", async () => {
    const seller = await makePlayer(),
      l = await listing(seller.id, 2),
      key = randomUUID();
    await db.inventory.update({
      where: { userId: seller.id },
      data: { resources: { wood: 160 } },
    });
    await expect(cancelListing(seller.id, key, l.id)).rejects.toMatchObject({
      code: "WAREHOUSE_FULL",
    });
    expect(
      await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }),
    ).toMatchObject({ status: "ACTIVE", quantity: 2 });
    expect((await inventory(seller.id)).wood).toBe(160);
    expect(
      await db.idempotencyRecord.count({ where: { userId: seller.id, key } }),
    ).toBe(0);
    await gameAction(seller.id, randomUUID(), "discard", {
      resource: "wood",
      quantity: 2,
    });
    await cancelListing(seller.id, key, l.id);
    await cancelListing(seller.id, key, l.id);
    expect((await inventory(seller.id)).wood).toBe(160);
    expect(
      (await db.marketListing.findUniqueOrThrow({ where: { id: l.id } }))
        .status,
    ).toBe("CANCELLED");
    expect(
      await db.marketTransaction.count({ where: { listingId: l.id } }),
    ).toBe(0);
    expect(await coins(seller.id)).toBe(100);
  });
  it("enforces nonnegative inventory and currency at the PostgreSQL boundary", async () => {
    const p = await makePlayer(),
      before = await inventory(p.id);
    await expect(
      db.inventory.update({
        where: { userId: p.id },
        data: { resources: { wood: -1 } },
      }),
    ).rejects.toThrow();
    await expect(
      db.inventory.update({
        where: { userId: p.id },
        data: { resources: { wood: 1.5 } },
      }),
    ).rejects.toThrow();
    await expect(
      db.inventory.update({
        where: { userId: p.id },
        data: { resources: { unknown: 1 } },
      }),
    ).rejects.toThrow();
    await expect(
      db.playerProgress.update({
        where: { userId: p.id },
        data: { coins: -1 },
      }),
    ).rejects.toThrow();
    expect(await inventory(p.id)).toEqual(before);
    expect(await coins(p.id)).toBe(100);
  });
  it("keeps an older owned listing cancellable beyond the public market's first hundred rows", async () => {
    const owner = await makePlayer();
    const old = await listing(owner.id, 1, 7);
    await db.marketListing.update({
      where: { id: old.id },
      data: { createdAt: new Date("2020-01-01T00:00:00Z") },
    });
    const otherSellers: (typeof accounts)[number][] = [];
    for (let sellerIndex = 0; sellerIndex < 5; sellerIndex++) {
      const seller = await makePlayer();
      otherSellers.push(seller);
      // Explicit fixture allocation: each seller owns twenty wood before
      // normal domain commands escrow one unit into each of twenty listings.
      await db.inventory.update({
        where: { userId: seller.id },
        data: { resources: { wood: 20 } },
      });
      for (let n = 0; n < 20; n++) await listing(seller.id, 1, 7);
      expect((await inventory(seller.id)).wood).toBe(0);
      expect(
        await db.marketListing.count({
          where: { sellerId: seller.id, status: "ACTIVE" },
        }),
      ).toBe(20);
    }
    const publicResponse = await fetch(`${base}/market?resource=wood`, {
      headers: { cookie: owner.cookie },
    });
    expect(publicResponse.status).toBe(200);
    const publicRows = (await publicResponse.json()) as {
      id: string;
      sellerId: string;
    }[];
    expect(publicRows).toHaveLength(100);
    expect(publicRows.some((row) => row.id === old.id)).toBe(false);

    const mineResponse = await fetch(`${base}/market?mine=true`, {
      headers: { cookie: owner.cookie },
    });
    expect(mineResponse.status).toBe(200);
    const mine = (await mineResponse.json()) as {
      id: string;
      sellerId: string;
    }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: old.id, sellerId: owner.id });
    const forgedResponse = await fetch(
      `${base}/market?mine=true&sellerId=${otherSellers[0].id}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(forgedResponse.status).toBe(200);
    const forged = (await forgedResponse.json()) as {
      id: string;
      sellerId: string;
    }[];
    expect(forged).toHaveLength(1);
    expect(forged[0]).toMatchObject({ id: old.id, sellerId: owner.id });

    const cancelled = await post(owner.cookie, `/market/${old.id}/cancel`, {});
    expect(cancelled.status).toBe(201);
    expect((await inventory(owner.id)).wood).toBe(ECONOMY.initial.wood);
    expect(await coins(owner.id)).toBe(100);
    const afterResponse = await fetch(`${base}/market?mine=true`, {
      headers: { cookie: owner.cookie },
    });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual([]);
    expect(
      await db.marketTransaction.count({ where: { listingId: old.id } }),
    ).toBe(0);
  });
  it("invalidates a warmed public market cache immediately after HTTP create, buy, and cancel", async () => {
    const seller = await makePlayer(),
      buyer = await makePlayer();
    const readMarket = async (cookie: string) => {
      const response = await fetch(`${base}/market?resource=wood`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string; quantity: number }[];
    };
    // Both reads and writes go through the same running API process. A direct
    // service call would invalidate only this test process's independent cache.
    await readMarket(buyer.cookie);
    const created = await post(seller.cookie, "/market", {
      resource: "wood",
      quantity: 3,
      unitPrice: 2,
    });
    expect(created.status).toBe(201);
    const listing = (await created.json()) as { id: string };
    expect(
      (await readMarket(buyer.cookie)).find((row) => row.id === listing.id),
    ).toMatchObject({ quantity: 3 });

    const bought = await post(buyer.cookie, `/market/${listing.id}/buy`, {
      quantity: 1,
    });
    expect(bought.status).toBe(201);
    expect(
      (await readMarket(seller.cookie)).find((row) => row.id === listing.id),
    ).toMatchObject({ quantity: 2 });

    const cancelled = await post(
      seller.cookie,
      `/market/${listing.id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(201);
    expect(
      (await readMarket(buyer.cookie)).some((row) => row.id === listing.id),
    ).toBe(false);
    expect((await inventory(seller.id)).wood).toBe(ECONOMY.initial.wood! - 1);
    expect((await inventory(buyer.id)).wood).toBe(ECONOMY.initial.wood! + 1);
    expect(await coins(seller.id)).toBe(101);
    expect(await coins(buyer.id)).toBe(98);
    const trades = await db.marketTransaction.findMany({
      where: { listingId: listing.id },
    });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ quantity: 1, total: 2, fee: 1 });
  });
});
