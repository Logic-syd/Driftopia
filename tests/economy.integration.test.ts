import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
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
import { ECONOMY, type Bundle } from "../packages/game-config/src/index";
const base = "http://127.0.0.1:3001/api";
const accounts: { id: string; cookie: string }[] = [];
async function makePlayer() {
  const user = await db.user.create({
    data: {
      email: `integration-${randomUUID()}@example.test`,
      passwordHash: passwordHash("IntegrationTest2026"),
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
    expect(issued.some((o) => ["repair", "green"].includes(o.orderCode))).toBe(
      true,
    );
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
});
