import { randomInt } from "node:crypto";
import { Prisma, type Expedition, type Ship } from "@prisma/client";
import { z } from "zod";
import { db } from "./database";
import { checkCoins, json, mutate, player, stockUpdate } from "./game";
import {
  levelFor,
  RuleError,
  transact,
} from "../../../packages/game-engine/src/index";
import {
  SHIPS,
  SHIP_IDS,
  REGIONS,
  REGION_IDS,
  CHOICE_IDS,
  type ShipKind,
  type RegionId,
} from "../../../packages/game-config/src/exploration";
import {
  createVoyagePlan,
  regionUnlocked,
  shipStats,
  shipUpgradeCost,
  shipRepairCost,
} from "../../../packages/game-engine/src/exploration";
import type {
  ExplorationState,
  VoyageResultView,
  VoyageView,
} from "../../../packages/shared/src/exploration";
import type { Bundle } from "../../../packages/game-config/src/index";

type Tx = Prisma.TransactionClient;
type Plan = ReturnType<typeof createVoyagePlan>;
type Snapshot = Plan["snapshot"];
const FLEET_LIMIT = 3;
const MAX_SHIP_LEVEL = 3;
const uuid = z.string().uuid();
const intentSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("build"),
    body: z.strictObject({ kind: z.enum(SHIP_IDS) }),
  }),
  z.object({
    action: z.literal("upgrade"),
    body: z.strictObject({ shipId: uuid }),
  }),
  z.object({
    action: z.literal("repair"),
    body: z.strictObject({ shipId: uuid }),
  }),
  z.object({
    action: z.literal("dispatch"),
    body: z.strictObject({ shipId: uuid, regionId: z.enum(REGION_IDS) }),
  }),
  z.object({
    action: z.literal("choose"),
    body: z.strictObject({ voyageId: uuid, choiceId: z.enum(CHOICE_IDS) }),
  }),
  z.object({
    action: z.literal("claim"),
    body: z.strictObject({ voyageId: uuid }),
  }),
]);

function snapshotOf(voyage: Expedition): Snapshot {
  return voyage.snapshot as unknown as Snapshot;
}
function resultView(value: Prisma.JsonValue): VoyageResultView {
  const result = value as unknown as VoyageResultView;
  // Deliberately whitelist public fields instead of returning internal JSON records.
  return {
    resources: result.resources,
    coins: result.coins,
    xp: result.xp,
    damage: result.damage,
    success: result.success,
    narrative: result.narrative,
  };
}
function voyageView(voyage: Expedition, now: Date): VoyageView {
  const snapshot = snapshotOf(voyage);
  const phase =
    voyage.status === "CLAIMED"
      ? "claimed"
      : voyage.status === "RETURNING"
        ? voyage.returnsAt! <= now
          ? "ready"
          : "returning"
        : voyage.arrivesAt <= now
          ? "choice"
          : "sailing";
  return {
    id: voyage.id,
    shipId: voyage.shipId,
    shipKind: snapshot.ship.kind,
    regionId: snapshot.region.id,
    regionName: snapshot.region.name,
    phase,
    departedAt: voyage.departedAt.toISOString(),
    arrivesAt: voyage.arrivesAt.toISOString(),
    returnsAt: voyage.returnsAt?.toISOString() ?? null,
    claimedAt: voyage.claimedAt?.toISOString() ?? null,
    choiceId: voyage.choiceId as VoyageView["choiceId"],
    event:
      phase === "sailing"
        ? null
        : {
            id: snapshot.event.id,
            title: snapshot.event.title,
            description: snapshot.event.description,
            choices: snapshot.event.choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              cost: choice.cost,
              coins: choice.coins,
              successPercent: choice.successPercent,
              riskDamage: choice.riskDamage,
              returnSeconds: choice.returnSeconds,
            })),
          },
    // Unchosen outcomes stay private even after the voyage is claimed.
    result:
      voyage.choiceId && voyage.result !== null
        ? resultView(voyage.result)
        : null,
  };
}
async function completions(
  tx: Tx,
  userId: string,
): Promise<Record<RegionId, number>> {
  const counts = Object.fromEntries(REGION_IDS.map((id) => [id, 0])) as Record<
    RegionId,
    number
  >;
  const rows = await tx.expedition.groupBy({
    by: ["regionId"],
    where: { userId, status: "CLAIMED" },
    _count: { _all: true },
  });
  for (const row of rows) {
    if (REGION_IDS.includes(row.regionId as RegionId))
      counts[row.regionId as RegionId] = row._count._all;
  }
  return counts;
}
async function ownedShip(
  tx: Tx,
  userId: string,
  shipId: string,
): Promise<Ship> {
  const ship = await tx.ship.findFirst({ where: { id: shipId, userId } });
  if (!ship) throw new RuleError("NOT_FOUND", "找不到这艘船");
  return ship;
}
async function idleShip(tx: Tx, userId: string, shipId: string): Promise<Ship> {
  const ship = await ownedShip(tx, userId, shipId);
  if (
    await tx.expedition.findFirst({
      where: { shipId, userId, status: { not: "CLAIMED" } },
      select: { id: true },
    })
  ) {
    throw new RuleError(
      "SHIP_BUSY",
      "这艘船还在航行或等待卸货，请先完成本次航程",
    );
  }
  return ship;
}
async function ownedVoyage(
  tx: Tx,
  userId: string,
  voyageId: string,
): Promise<Expedition> {
  const voyage = await tx.expedition.findFirst({
    where: { id: voyageId, userId },
  });
  if (!voyage) throw new RuleError("NOT_FOUND", "找不到这段航程");
  return voyage;
}
async function pay(
  tx: Tx,
  userId: string,
  p: Awaited<ReturnType<typeof player>>,
  cost: Bundle,
  coins: number,
) {
  checkCoins(p.progress.coins, coins);
  await stockUpdate(tx, userId, transact(p.stock, cost, {}, p.capacity));
  if (coins)
    await tx.playerProgress.update({
      where: { userId },
      data: { coins: { decrement: coins } },
    });
}

export async function explorationState(
  userId: string,
): Promise<ExplorationState> {
  return db.$transaction(
    async (tx) => {
      // Enforce a read-only snapshot at the database level as well as in application code.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const now = new Date();
      const p = await player(tx, userId);
      const ships = await tx.ship.findMany({
        where: { userId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const voyages = await tx.expedition.findMany({
        where: { userId, status: { not: "CLAIMED" } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: FLEET_LIMIT,
      });
      const history = await tx.expedition.findMany({
        where: { userId, status: "CLAIMED" },
        orderBy: [{ claimedAt: "desc" }, { id: "desc" }],
        take: 20,
      });
      const completed = await completions(tx, userId);
      const level = levelFor(p.progress.xp);
      return {
        serverTime: now.toISOString(),
        hasDock: p.island.buildings.some(
          (building) => building.kind === "dock",
        ),
        fleetLimit: FLEET_LIMIT,
        shipyard: SHIP_IDS.map((kind) => ({
          kind,
          name: SHIPS[kind].name,
          description: SHIPS[kind].description,
          icon: SHIPS[kind].icon,
          unlockLevel: SHIPS[kind].unlockLevel,
          cost: SHIPS[kind].cost,
          coins: SHIPS[kind].coins,
          owned: ships.some((ship) => ship.kind === kind),
          stats: shipStats(kind, 1),
        })),
        ships: ships.map((ship) => {
          const kind = ship.kind as ShipKind;
          const stats = shipStats(kind, ship.level);
          const repair = shipRepairCost(kind, ship.level, ship.durability);
          return {
            id: ship.id,
            kind,
            name: SHIPS[kind].name,
            level: ship.level,
            durability: ship.durability,
            stats,
            activeVoyageId:
              voyages.find((voyage) => voyage.shipId === ship.id)?.id ?? null,
            upgrade:
              ship.level < MAX_SHIP_LEVEL
                ? shipUpgradeCost(kind, ship.level)
                : null,
            repair:
              repair.restore > 0
                ? { cost: repair.cost, coins: repair.coins }
                : null,
          };
        }),
        regions: REGION_IDS.map((id) => {
          const region = REGIONS[id];
          const unlock = regionUnlocked(id, level, completed);
          return {
            id,
            name: region.name,
            description: region.description,
            color: region.color,
            x: region.x,
            y: region.y,
            unlockLevel: region.unlockLevel,
            unlocked: unlock.unlocked,
            lockReason: unlock.reason,
            minShipLevel: region.minShipLevel,
            recommendedShipLevel: region.recommendedShipLevel,
            seconds: region.seconds,
            riskPercent: region.riskPercent,
            baseWear: region.baseWear,
            supplies: region.supplies,
            coins: region.coins,
            loot: region.loot,
            completed: completed[id],
            requires: region.requires,
          };
        }),
        voyages: voyages.map((voyage) => voyageView(voyage, now)),
        history: history.map((voyage) => voyageView(voyage, now)),
        progress: {
          claimed: Object.values(completed).reduce((sum, n) => sum + n, 0),
          regions: completed,
        },
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 15000,
      maxWait: 10000,
    },
  );
}

export async function explorationAction(
  userId: string,
  key: string,
  action: string,
  raw: unknown,
) {
  const intent = intentSchema.parse({ action, body: raw });
  return mutate(
    userId,
    key,
    `exploration:${intent.action}`,
    intent.body,
    async (tx) => {
      const p = await player(tx, userId);
      const now = new Date();
      if (intent.action === "build") {
        const { kind } = intent.body;
        const config = SHIPS[kind];
        if (!p.island.buildings.some((building) => building.kind === "dock"))
          throw new RuleError(
            "DOCK_REQUIRED",
            "先建造交易码头，再组建探索船队",
          );
        if (levelFor(p.progress.xp) < config.unlockLevel)
          throw new RuleError(
            "LOCKED",
            `漂流等级 ${config.unlockLevel} 解锁${config.name}`,
          );
        const fleet = await tx.ship.findMany({
          where: { userId },
          select: { kind: true },
        });
        if (fleet.some((ship) => ship.kind === kind))
          throw new RuleError("SHIP_EXISTS", "每种船型只能拥有一艘");
        if (fleet.length >= FLEET_LIMIT)
          throw new RuleError("FLEET_LIMIT", "船队最多容纳三艘船");
        await pay(tx, userId, p, config.cost, config.coins);
        const ship = await tx.ship.create({
          data: { userId, kind, durability: shipStats(kind, 1).maxDurability },
        });
        return { message: `${config.name}已下水`, shipId: ship.id };
      }
      if (intent.action === "upgrade") {
        const ship = await idleShip(tx, userId, intent.body.shipId);
        if (ship.level >= MAX_SHIP_LEVEL)
          throw new RuleError("MAX_LEVEL", "这艘船已经达到最高等级");
        const cost = shipUpgradeCost(ship.kind as ShipKind, ship.level);
        await pay(tx, userId, p, cost.cost, cost.coins);
        await tx.ship.update({
          where: { id: ship.id },
          data: { level: { increment: 1 } },
        });
        return { message: "船只升级完成，原有耐久保持不变", shipId: ship.id };
      }
      if (intent.action === "repair") {
        const ship = await idleShip(tx, userId, intent.body.shipId);
        const quote = shipRepairCost(
          ship.kind as ShipKind,
          ship.level,
          ship.durability,
        );
        if (quote.restore <= 0)
          throw new RuleError("SHIP_HEALTHY", "这艘船无需修理");
        await pay(tx, userId, p, quote.cost, quote.coins);
        await tx.ship.update({
          where: { id: ship.id },
          data: { durability: { increment: quote.restore } },
        });
        return { message: "船只已修复，可以再次出航", shipId: ship.id };
      }
      if (intent.action === "dispatch") {
        const ship = await idleShip(tx, userId, intent.body.shipId);
        if (!p.island.buildings.some((building) => building.kind === "dock"))
          throw new RuleError(
            "DOCK_REQUIRED",
            "先建造交易码头，再派遣船只出航",
          );
        const region = REGIONS[intent.body.regionId];
        const unlock = regionUnlocked(
          intent.body.regionId,
          levelFor(p.progress.xp),
          await completions(tx, userId),
        );
        if (!unlock.unlocked)
          throw new RuleError(
            "REGION_LOCKED",
            unlock.reason ?? "这片海域尚未解锁",
          );
        if (ship.level < region.minShipLevel)
          throw new RuleError(
            "SHIP_LEVEL",
            `这片海域需要 ${region.minShipLevel} 级船只`,
          );
        if (ship.durability < region.baseWear)
          throw new RuleError("DURABILITY_LOW", "船只耐久不足，请先修理");
        await pay(tx, userId, p, region.supplies, region.coins);
        const plan = createVoyagePlan(
          ship.kind as ShipKind,
          ship.level,
          intent.body.regionId,
          randomInt,
        );
        const voyage = await tx.expedition.create({
          data: {
            userId,
            shipId: ship.id,
            regionId: intent.body.regionId,
            departedAt: now,
            arrivesAt: new Date(now.getTime() + plan.durationSeconds * 1000),
            snapshot: json(plan.snapshot),
            outcomes: json(plan.outcomes),
          },
        });
        await tx.ship.update({
          where: { id: ship.id },
          data: { durability: { decrement: region.baseWear } },
        });
        return {
          message: `${SHIPS[ship.kind as ShipKind].name}已出航`,
          voyageId: voyage.id,
        };
      }
      if (intent.action === "choose") {
        const voyage = await ownedVoyage(tx, userId, intent.body.voyageId);
        if (voyage.status !== "SAILING")
          throw new RuleError("ALREADY_CHOSEN", "这段航程已经选择了行动");
        if (voyage.arrivesAt > now)
          throw new RuleError("NOT_READY", "船只仍在途中，到达后才能选择行动");
        const snapshot = snapshotOf(voyage);
        const choice = snapshot.event.choices.find(
          (option) => option.id === intent.body.choiceId,
        );
        const result = (voyage.outcomes as unknown as Plan["outcomes"])[
          intent.body.choiceId
        ];
        if (!choice || !result)
          throw new RuleError("INVALID_CHOICE", "当前事件没有这项行动");
        const ship = await ownedShip(tx, userId, voyage.shipId);
        if (ship.durability < choice.riskDamage)
          throw new RuleError(
            "DURABILITY_LOW",
            "船只耐久不足以承担这项行动，可以选择安全返航",
          );
        await pay(tx, userId, p, choice.cost, choice.coins);
        await tx.ship.update({
          where: { id: ship.id },
          data: { durability: { decrement: result.damage } },
        });
        await tx.expedition.update({
          where: { id: voyage.id },
          data: {
            status: "RETURNING",
            choiceId: choice.id,
            result: json(result),
            resolvedAt: now,
            returnsAt: new Date(now.getTime() + choice.returnSeconds * 1000),
          },
        });
        return { message: "行动结果已记录，船只正在返航", voyageId: voyage.id };
      }
      const voyage = await ownedVoyage(tx, userId, intent.body.voyageId);
      if (voyage.status === "CLAIMED")
        throw new RuleError("ALREADY_CLAIMED", "这次航程的货物已经入库");
      if (
        voyage.status !== "RETURNING" ||
        !voyage.returnsAt ||
        voyage.returnsAt > now ||
        !voyage.result
      )
        throw new RuleError("NOT_READY", "船只还没有完成返航");
      const result = resultView(voyage.result);
      await stockUpdate(
        tx,
        userId,
        transact(p.stock, {}, result.resources, p.capacity),
      );
      await tx.playerProgress.update({
        where: { userId },
        data: {
          coins: { increment: result.coins },
          xp: { increment: result.xp },
        },
      });
      await tx.expedition.update({
        where: { id: voyage.id },
        data: { status: "CLAIMED", claimedAt: now },
      });
      return {
        message: "远航货物已入库，航海日志已更新",
        voyageId: voyage.id,
        result,
      };
    },
  );
}
