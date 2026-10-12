import { Prisma, type User } from "@prisma/client";
import { createHash, randomInt } from "node:crypto";
import Redis from "ioredis";
import { z } from "zod";
import { db, env } from "./database";
import { settleAutomation } from "./production";
import {
  BUILDINGS,
  ECONOMY,
  SALVAGE,
  type Bundle,
  type BuildingKind,
  type Resource,
} from "../../../packages/game-config/src/index";
import {
  count,
  levelFor,
  productionSeconds,
  RuleError,
  transact,
  tradeAmounts,
  upgradeCost,
  validatePlacement,
} from "../../../packages/game-engine/src/index";
import {
  buildSchema,
  buySchema,
  listingSchema,
  pointSchema,
  type PlayerState,
} from "../../../packages/shared/src/index";

type Tx = Prisma.TransactionClient;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
redis.on("error", () => {
  /* PostgreSQL remains authoritative when the cache is unavailable. */
});
export function weekKey(now = new Date()) {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
async function lock(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
}
async function player(tx: Tx, id: string) {
  const user = await tx.user.findUnique({
    where: { id },
    include: {
      profile: true,
      progress: true,
      inventory: true,
      island: {
        include: {
          tiles: true,
          buildings: {
            include: {
              jobs: {
                where: { status: "RUNNING" },
                orderBy: { finishesAt: "asc" },
              },
            },
          },
        },
      },
    },
  });
  if (!user?.island || !user.inventory || !user.progress || !user.profile)
    throw new RuleError("NOT_FOUND", "找不到这位漂流者");
  return {
    user,
    island: user.island,
    progress: user.progress,
    stock: user.inventory.resources as Bundle,
    capacity:
      ECONOMY.baseCapacity +
      user.island.buildings
        .filter((b) => b.kind === "warehouse")
        .reduce((n, b) => n + ECONOMY.warehouseCapacity * b.level, 0),
  };
}
async function stockUpdate(tx: Tx, id: string, stock: Bundle) {
  await tx.inventory.update({
    where: { userId: id },
    data: { resources: json(stock) },
  });
}
function checkCoins(coins: number, cost: number) {
  if (coins < cost)
    throw new RuleError("INSUFFICIENT_COINS", "金币不足，先去完成一些委托吧");
}
function ensureDock(buildings: { kind: string }[]) {
  if (!buildings.some((b) => b.kind === "dock"))
    throw new RuleError("DOCK_REQUIRED", "先建造交易码头，再与其他漂流者交易");
}
export async function rebuildRankings() {
  const rows = await db.playerProgress.findMany();
  const current = weekKey();
  const pipeline = redis.multi();
  for (const type of ["prosperity", "xp", "weeklyPoints"] as const) {
    const temp = `ranks:${type}:rebuild`;
    pipeline.del(temp);
    if (rows.length) {
      for (const p of rows)
        pipeline.zadd(
          temp,
          type === "weeklyPoints" && p.weekKey !== current ? 0 : p[type],
          p.userId,
        );
      pipeline.rename(temp, `ranks:${type}`);
    } else pipeline.del(`ranks:${type}`);
  }
  const result = await pipeline.exec();
  if (result?.some(([err]) => err))
    throw new Error("Leaderboard cache rebuild failed");
}
export async function syncRanking(id: string) {
  const p = await db.playerProgress.findUnique({ where: { userId: id } });
  if (p)
    await redis
      .multi()
      .zadd("ranks:prosperity", p.prosperity, id)
      .zadd("ranks:xp", p.xp, id)
      .zadd(
        "ranks:weeklyPoints",
        p.weekKey === weekKey() ? p.weeklyPoints : 0,
        id,
      )
      .exec()
      .catch(() => undefined);
}
export async function mutate(
  id: string,
  key: string,
  action: string,
  body: unknown,
  fn: (tx: Tx) => Promise<unknown>,
  others: string[] = [],
) {
  z.string().uuid().parse(key);
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ action, body }))
    .digest("hex");
  const result = await db.$transaction(
    async (tx) => {
      await lock(tx, [id, ...others]);
      const prior = await tx.idempotencyRecord.findUnique({
        where: { userId_key: { userId: id, key } },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new RuleError(
            "IDEMPOTENCY_CONFLICT",
            "请求编号已用于另一项操作",
          );
        return prior.result;
      }
      const before = await tx.playerProgress.findUniqueOrThrow({
        where: { userId: id },
      });
      const inventoryBefore = await tx.inventory.findUniqueOrThrow({
        where: { userId: id },
      });
      const value = json(await fn(tx));
      const after = await tx.playerProgress.findUniqueOrThrow({
        where: { userId: id },
      });
      const inventoryAfter = await tx.inventory.findUniqueOrThrow({
        where: { userId: id },
      });
      await tx.gameEvent.create({
        data: {
          userId: id,
          type: action,
          payload: json({
            body,
            coinsBefore: before.coins,
            coinsAfter: after.coins,
            inventoryBefore: inventoryBefore.resources,
            inventoryAfter: inventoryAfter.resources,
          }),
        },
      });
      await tx.idempotencyRecord.create({
        data: { userId: id, key, requestHash, result: value },
      });
      return value;
    },
    { timeout: 15000, maxWait: 10000 },
  );
  await Promise.all([id, ...others].map(syncRanking));
  return result;
}
export async function state(id: string): Promise<PlayerState> {
  return db.$transaction(
    async (tx) => {
      await lock(tx, [id]);
      const now = new Date();
      const automation = await settleAutomation(tx, id, now);
      const p = await player(tx, id);
      const report = await tx.gameEvent.findFirst({
        where: { userId: id, type: "production:auto" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const reportData = report?.payload as
        { batches: number; resources: Bundle } | undefined;
      const active = await tx.salvageSpawn.count({
        where: { userId: id, claimedAt: null, expiresAt: { gt: now } },
      });
      const elapsed = Math.floor(
        (now.getTime() - p.progress.lastSalvageAt.getTime()) /
          (ECONOMY.salvageSeconds * 1000),
      );
      const amount = Math.min(ECONOMY.salvageLimit - active, elapsed);
      const positions = [
        [12, 32],
        [80, 25],
        [87, 62],
        [18, 75],
        [51, 15],
        [55, 86],
      ];
      if (amount > 0) {
        for (let i = 0; i < amount; i++) {
          const loot = SALVAGE[randomInt(SALVAGE.length)],
            pos = positions[(active + i) % positions.length];
          await tx.salvageSpawn.create({
            data: {
              userId: id,
              kind: loot.kind,
              reward: json(loot.reward),
              x: pos[0] + randomInt(-3, 4),
              y: pos[1] + randomInt(-3, 4),
              expiresAt: new Date(
                now.getTime() + ECONOMY.salvageLifetimeSeconds * 1000,
              ),
            },
          });
        }
        await tx.playerProgress.update({
          where: { userId: id },
          data: { lastSalvageAt: now },
        });
      }
      const currentOrders = await tx.playerOrder.findMany({
        where: { userId: id, completedAt: null, expiresAt: { gt: now } },
      });
      if (currentOrders.length < 3) {
        const available = await tx.order.findMany({
          where: { level: { lte: levelFor(p.progress.xp) } },
        });
        const seen = await tx.playerOrder.groupBy({
          by: ["orderCode"],
          where: { userId: id },
          _max: { expiresAt: true },
        });
        const issued = new Map(
          seen.map((o) => [o.orderCode, o._max.expiresAt?.getTime() ?? 0]),
        );
        available.sort(
          (a, b) =>
            (issued.get(a.code) ?? 0) - (issued.get(b.code) ?? 0) ||
            a.level - b.level ||
            a.code.localeCompare(b.code),
        );
        // Always introduce the tutorial's water order first on a new island.
        if (p.progress.orders === 0)
          available.sort(
            (a, b) =>
              Number(b.code === "first-water") -
              Number(a.code === "first-water"),
          );
        for (const template of available
          .filter((o) => !currentOrders.some((c) => c.orderCode === o.code))
          .slice(0, 3 - currentOrders.length)) {
          const { code, level: _level, ...snapshot } = template;
          await tx.playerOrder.create({
            data: {
              ...snapshot,
              input: json(snapshot.input),
              userId: id,
              orderCode: code,
              expiresAt: new Date(
                now.getTime() + ECONOMY.orderLifetimeSeconds * 1000,
              ),
            },
          });
        }
      }
      const salvage = await tx.salvageSpawn.findMany({
        where: { userId: id, claimedAt: null, expiresAt: { gt: now } },
        select: { id: true, kind: true, x: true, y: true, expiresAt: true },
      });
      const orders = await tx.playerOrder.findMany({
        where: { userId: id, completedAt: null, expiresAt: { gt: now } },
        select: {
          id: true,
          name: true,
          description: true,
          input: true,
          coins: true,
          xp: true,
          expiresAt: true,
        },
        orderBy: { expiresAt: "asc" },
      });
      return JSON.parse(
        JSON.stringify({
          id,
          name: p.user.profile!.name,
          role: p.user.role,
          coins: p.progress.coins,
          xp: p.progress.xp,
          level: levelFor(p.progress.xp),
          prosperity: p.progress.prosperity,
          capacity: p.capacity,
          inventory: p.stock,
          tiles: p.island.tiles.map(({ x, y }) => ({ x, y })),
          buildings: p.island.buildings.map((b) => ({
            ...b,
            autoStatus: b.autoEnabled
              ? (automation.states[b.id] ?? "running")
              : "off",
            recipe: automation.configs[b.kind]?.recipe,
          })),
          productionReport:
            report && reportData
              ? {
                  id: report.id,
                  batches: reportData.batches,
                  resources: reportData.resources,
                  createdAt: report.createdAt,
                }
              : null,
          salvage,
          orders,
          stats: {
            salvaged: p.progress.salvaged,
            produced: p.progress.produced,
            orders: p.progress.orders,
          },
          serverTime: now,
          offlineReady: p.island.buildings
            .flatMap((b) => b.jobs)
            .filter((j) => j.finishesAt <= now).length,
        }),
      ) as PlayerState;
    },
    { timeout: 15000, maxWait: 10000 },
  );
}
export async function gameAction(
  id: string,
  key: string,
  action: string,
  raw: unknown,
) {
  return mutate(id, key, action, raw, async (tx) => {
    const p = await player(tx, id),
      now = new Date();
    if (action === "salvage") {
      const { spawnId } = z.object({ spawnId: z.string().uuid() }).parse(raw);
      const s = await tx.salvageSpawn.findFirst({
        where: {
          id: spawnId,
          userId: id,
          claimedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (!s) throw new RuleError("SALVAGE_GONE", "漂流物已经被打捞或漂远了");
      await stockUpdate(
        tx,
        id,
        transact(p.stock, {}, s.reward as Bundle, p.capacity),
      );
      await tx.salvageSpawn.update({
        where: { id: spawnId },
        data: { claimedAt: now },
      });
      await tx.playerProgress.update({
        where: { userId: id },
        data: { salvaged: { increment: 1 } },
      });
      return { message: "打捞成功", reward: s.reward };
    }
    if (action === "discard") {
      const data = z
        .object({
          resource: z.enum([
            "wood",
            "plastic",
            "metal",
            "seaweed",
            "water",
            "fish",
            "plank",
            "parts",
          ]),
          quantity: z.number().int().min(1).max(10000),
        })
        .parse(raw);
      await stockUpdate(
        tx,
        id,
        transact(p.stock, { [data.resource]: data.quantity }, {}, p.capacity),
      );
      return { message: `已丢弃 ${data.quantity} 个资源，仓库腾出了一点空间` };
    }
    if (action === "build") {
      const b = buildSchema.parse(raw),
        cfg = BUILDINGS[b.kind];
      if (levelFor(p.progress.xp) < cfg.unlock)
        throw new RuleError("LOCKED", `漂流等级 ${cfg.unlock} 解锁`);
      validatePlacement(p.island.tiles, p.island.buildings, b.x, b.y);
      checkCoins(p.progress.coins, cfg.coins);
      await stockUpdate(tx, id, transact(p.stock, cfg.cost, {}, p.capacity));
      await tx.building.create({ data: { ...b, islandId: p.island.id } });
      await tx.playerProgress.update({
        where: { userId: id },
        data: {
          coins: { decrement: cfg.coins },
          xp: { increment: ECONOMY.buildXp },
          prosperity: { increment: cfg.prosperity },
        },
      });
      return { message: `${cfg.name}建好了！` };
    }
    if (action === "expand") {
      const point = pointSchema.parse(raw);
      if (
        p.island.tiles.some((t) => t.x === point.x && t.y === point.y) ||
        !p.island.tiles.some(
          (t) => Math.abs(t.x - point.x) + Math.abs(t.y - point.y) === 1,
        )
      )
        throw new RuleError("INVALID_TILE", "新地板需要紧邻现有木筏");
      await stockUpdate(
        tx,
        id,
        transact(p.stock, ECONOMY.floorCost, {}, p.capacity),
      );
      await tx.islandTile.create({ data: { ...point, islandId: p.island.id } });
      return { message: "木筏又长大了一点" };
    }
    if (action === "automation") {
      const { buildingId, enabled } = z
        .object({ buildingId: z.string().uuid(), enabled: z.boolean() })
        .parse(raw);
      const building = p.island.buildings.find((b) => b.id === buildingId);
      if (!building) throw new RuleError("NOT_FOUND", "找不到你的建筑");
      if (!BUILDINGS[building.kind as BuildingKind].recipe)
        throw new RuleError("NO_RECIPE", "这栋建筑不进行生产");
      await tx.building.update({
        where: { id: buildingId },
        data: { autoEnabled: enabled },
      });
      if (enabled) await settleAutomation(tx, id, now);
      return {
        message: enabled
          ? "自动生产已开启，材料预留后排入队列"
          : "自动续产已关闭，已排任务保留并可手动收取",
      };
    }
    if (["produce", "collect", "upgrade", "move"].includes(action)) {
      const { buildingId } = z
        .object({ buildingId: z.string().uuid() })
        .parse(raw);
      const b = p.island.buildings.find((b) => b.id === buildingId);
      if (!b) throw new RuleError("NOT_FOUND", "找不到你的建筑");
      const kind = b.kind as BuildingKind,
        cfg = BUILDINGS[kind];
      if (action === "move") {
        const point = pointSchema.parse(raw);
        validatePlacement(
          p.island.tiles,
          p.island.buildings,
          point.x,
          point.y,
          b.id,
        );
        await tx.building.update({ where: { id: b.id }, data: point });
        return { message: "搬家完成" };
      }
      if (action === "upgrade") {
        if (b.level >= 3)
          throw new RuleError("MAX_LEVEL", "建筑已达到最高等级");
        checkCoins(p.progress.coins, 30 * b.level);
        await stockUpdate(
          tx,
          id,
          transact(p.stock, upgradeCost(kind, b.level), {}, p.capacity),
        );
        await tx.building.update({
          where: { id: b.id },
          data: { level: { increment: 1 } },
        });
        await tx.playerProgress.update({
          where: { userId: id },
          data: {
            coins: { decrement: 30 * b.level },
            prosperity: { increment: cfg.prosperity },
            xp: { increment: 10 },
          },
        });
        return { message: "升级成功" };
      }
      if (!cfg.recipe) throw new RuleError("NO_RECIPE", "这栋建筑不进行生产");
      if (action === "produce") {
        if (b.autoEnabled)
          throw new RuleError("AUTO_ENABLED", "请先关闭自动续产再手动添加生产");
        if (b.jobs.length >= ECONOMY.queueLimit)
          throw new RuleError("QUEUE_FULL", "生产队列已满，请先收取产出");
        const override = await tx.gameConfigVersion.findFirst({
          where: { scope: `recipe:${kind}` },
          orderBy: { id: "desc" },
        });
        const recipe = (override?.value ??
          cfg.recipe) as unknown as typeof cfg.recipe;
        const last = b.jobs.at(-1)?.finishesAt ?? now;
        const startsAt = new Date(Math.max(now.getTime(), last.getTime()));
        await stockUpdate(
          tx,
          id,
          transact(p.stock, recipe.input, {}, p.capacity),
        );
        await tx.productionJob.create({
          data: {
            buildingId: b.id,
            input: json(recipe.input),
            output: json(recipe.output),
            startsAt,
            finishesAt: new Date(
              startsAt.getTime() +
                productionSeconds(kind, b.level, recipe.seconds) * 1000,
            ),
            configVersion: override?.id ?? 1,
          },
        });
        return { message: "生产已安排，离线也会继续" };
      }
      const ready = b.jobs.filter((j) => j.finishesAt <= now);
      if (!ready.length) throw new RuleError("NOT_READY", "还需要一点时间");
      let next = p.stock;
      const accepted: typeof ready = [];
      for (const job of ready) {
        try {
          next = transact(next, {}, job.output as Bundle, p.capacity);
          accepted.push(job);
        } catch (error) {
          if (error instanceof RuleError && error.code === "WAREHOUSE_FULL")
            break;
          throw error;
        }
      }
      if (!accepted.length)
        throw new RuleError(
          "WAREHOUSE_FULL",
          "仓库满了，请先使用资源或扩建仓库",
        );
      await stockUpdate(tx, id, next);
      await tx.productionJob.updateMany({
        where: { id: { in: accepted.map((j) => j.id) }, status: "RUNNING" },
        data: { status: "COLLECTED", collectedAt: now },
      });
      await tx.playerProgress.update({
        where: { userId: id },
        data: { produced: { increment: accepted.length } },
      });
      return {
        message: `收获了 ${accepted.length} 批资源${accepted.length < ready.length ? "，其余产出等待仓库空间" : ""}`,
      };
    }
    if (action === "order") {
      const { orderId } = z.object({ orderId: z.string().uuid() }).parse(raw);
      const order = await tx.playerOrder.findFirst({
        where: {
          id: orderId,
          userId: id,
          completedAt: null,
          expiresAt: { gt: now },
        },
      });
      if (!order) throw new RuleError("ORDER_GONE", "委托已完成或过期");
      await stockUpdate(
        tx,
        id,
        transact(p.stock, order.input as Bundle, {}, p.capacity),
      );
      await tx.playerOrder.update({
        where: { id: order.id },
        data: { completedAt: now },
      });
      await tx.playerProgress.update({
        where: { userId: id },
        data: {
          coins: { increment: order.coins },
          xp: { increment: order.xp },
          orders: { increment: 1 },
          weekKey: weekKey(now),
          weeklyPoints:
            (p.progress.weekKey === weekKey(now)
              ? p.progress.weeklyPoints
              : 0) + order.xp,
        },
      });
      return {
        message: `商船出发了！+${order.coins} 金币 · +${order.xp} 经验`,
      };
    }
    throw new RuleError("INVALID_ACTION", "不支持的操作");
  });
}
export async function createListing(id: string, key: string, raw: unknown) {
  const data = listingSchema.parse(raw);
  return mutate(id, key, "market:create", data, async (tx) => {
    const p = await player(tx, id);
    ensureDock(p.island.buildings);
    const active = await tx.marketListing.count({
      where: { sellerId: id, status: "ACTIVE" },
    });
    if (active >= 20)
      throw new RuleError("LISTING_LIMIT", "最多同时上架 20 笔商品");
    await stockUpdate(
      tx,
      id,
      transact(p.stock, { [data.resource]: data.quantity }, {}, p.capacity),
    );
    return tx.marketListing.create({ data: { ...data, sellerId: id } });
  });
}
export async function buyListing(
  id: string,
  key: string,
  listingId: string,
  raw: unknown,
) {
  const data = buySchema.parse(raw);
  const initial = await db.marketListing.findUnique({
    where: { id: listingId },
  });
  if (!initial) throw new RuleError("NOT_FOUND", "商品不存在");
  if (initial.sellerId === id)
    throw new RuleError("SELF_TRADE", "不能购买自己的商品");
  return mutate(
    id,
    key,
    `market:buy:${listingId}`,
    data,
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "MarketListing" WHERE id = ${listingId} FOR UPDATE`;
      const l = await tx.marketListing.findUniqueOrThrow({
        where: { id: listingId },
      });
      if (l.status !== "ACTIVE" || l.quantity < data.quantity)
        throw new RuleError("SOLD_OUT", "来晚一步，库存不足");
      const p = await player(tx, id);
      ensureDock(p.island.buildings);
      const amounts = tradeAmounts(data.quantity, l.unitPrice);
      checkCoins(p.progress.coins, amounts.total);
      const next = transact(
        p.stock,
        {},
        { [l.resource]: data.quantity },
        p.capacity,
      );
      const changed = await tx.marketListing.updateMany({
        where: {
          id: listingId,
          status: "ACTIVE",
          quantity: { gte: data.quantity },
        },
        data: {
          quantity: { decrement: data.quantity },
          status: l.quantity === data.quantity ? "SOLD" : "ACTIVE",
        },
      });
      if (changed.count !== 1) throw new RuleError("SOLD_OUT", "商品已售罄");
      await stockUpdate(tx, id, next);
      await tx.playerProgress.update({
        where: { userId: id },
        data: { coins: { decrement: amounts.total } },
      });
      await tx.playerProgress.update({
        where: { userId: l.sellerId },
        data: { coins: { increment: amounts.sellerReceives } },
      });
      const trade = await tx.marketTransaction.create({
        data: {
          listingId,
          buyerId: id,
          sellerId: l.sellerId,
          resource: l.resource,
          quantity: data.quantity,
          total: amounts.total,
          fee: amounts.fee,
        },
      });
      await tx.gameEvent.create({
        data: {
          userId: l.sellerId,
          type: "market:sold",
          payload: json({
            tradeId: trade.id,
            coinsDelta: amounts.sellerReceives,
            fee: amounts.fee,
          }),
        },
      });
      return { message: "交易完成，资源已入库", trade };
    },
    [initial.sellerId],
  );
}
export async function cancelListing(
  id: string,
  key: string,
  listingId: string,
) {
  return mutate(id, key, `market:cancel:${listingId}`, {}, async (tx) => {
    const l = await tx.marketListing.findFirst({
      where: { id: listingId, sellerId: id, status: "ACTIVE" },
    });
    if (!l) throw new RuleError("NOT_FOUND", "商品已售出或下架");
    const p = await player(tx, id);
    await stockUpdate(
      tx,
      id,
      transact(p.stock, {}, { [l.resource]: l.quantity }, p.capacity),
    );
    await tx.marketListing.update({
      where: { id: l.id },
      data: { status: "CANCELLED" },
    });
    return { message: "已下架，未售出的资源已退回仓库" };
  });
}
export async function publicPlayers(query = "") {
  const profiles = await db.playerProfile.findMany({
    where: { name: { contains: query, mode: "insensitive" } },
    include: { user: { include: { progress: true } } },
    take: 40,
    orderBy: { name: "asc" },
  });
  return profiles.map((p) => ({
    id: p.userId,
    name: p.name,
    xp: p.user.progress!.xp,
    level: levelFor(p.user.progress!.xp),
    prosperity: p.user.progress!.prosperity,
    weeklyPoints:
      p.user.progress!.weekKey === weekKey()
        ? p.user.progress!.weeklyPoints
        : 0,
  }));
}
export async function leaderboard(type: string) {
  const field = z.enum(["prosperity", "xp", "weeklyPoints"]).parse(type);
  let ids: string[] = [];
  try {
    await rebuildRankings();
    ids = await redis.zrevrange(`ranks:${field}`, 0, 19);
  } catch {
    /* Database fallback */
  }
  const rows = await db.playerProgress.findMany({
    where: ids.length ? { userId: { in: ids } } : undefined,
    include: { user: { include: { profile: true } } },
    orderBy: { [field]: "desc" },
    take: ids.length ? undefined : 100,
  });
  return rows
    .map((p) => ({
      id: p.userId,
      name: p.user.profile!.name,
      level: levelFor(p.xp),
      xp: p.xp,
      prosperity: p.prosperity,
      weeklyPoints: p.weekKey === weekKey() ? p.weeklyPoints : 0,
    }))
    .sort((a, b) => b[field] - a[field])
    .slice(0, 20);
}
export const recipeSchema = z.object({
  input: z.partialRecord(
    z.enum([
      "wood",
      "plastic",
      "metal",
      "seaweed",
      "water",
      "fish",
      "plank",
      "parts",
    ]),
    z.number().int().min(0).max(100),
  ),
  output: z
    .partialRecord(
      z.enum([
        "wood",
        "plastic",
        "metal",
        "seaweed",
        "water",
        "fish",
        "plank",
        "parts",
      ]),
      z.number().int().min(0).max(100),
    )
    .refine((v) => count(v) > 0),
  seconds: z.number().int().min(3).max(86400),
});
export async function adminConfig(user: User, key: string, raw: unknown) {
  if (user.role !== "ADMIN") throw new RuleError("FORBIDDEN", "需要管理员权限");
  const data = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("recipe"),
        kind: z.enum(["purifier", "fishnet", "workshop", "recycler", "garden"]),
        recipe: recipeSchema,
      }),
      z.object({
        type: z.literal("order"),
        code: z.string().max(80),
        coins: z.number().int().min(1).max(10000),
        xp: z.number().int().min(1).max(1000),
      }),
    ])
    .parse(raw);
  return mutate(user.id, key, "admin:config", data, async (tx) => {
    if (data.type === "recipe")
      return tx.gameConfigVersion.create({
        data: {
          actorId: user.id,
          scope: `recipe:${data.kind}`,
          value: json(data.recipe),
        },
      });
    await tx.order.update({
      where: { code: data.code },
      data: { coins: data.coins, xp: data.xp },
    });
    return tx.gameConfigVersion.create({
      data: {
        actorId: user.id,
        scope: `order:${data.code}`,
        value: json(data),
      },
    });
  });
}
export type { Resource };
