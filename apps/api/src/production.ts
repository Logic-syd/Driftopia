import { Prisma, type Building, type ProductionJob } from "@prisma/client";
import {
  BUILDINGS,
  ECONOMY,
  type BuildingKind,
  type Bundle,
  type Recipe,
} from "../../../packages/game-config/src/index";
import {
  productionSeconds,
  RuleError,
  transact,
} from "../../../packages/game-engine/src/index";
import type { BuildingView } from "../../../packages/shared/src/index";
type Tx = Prisma.TransactionClient;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export async function recipes(tx: Tx) {
  const versions = await tx.gameConfigVersion.findMany({
    where: { scope: { startsWith: "recipe:" } },
    orderBy: { id: "desc" },
    distinct: ["scope"],
  });
  return Object.fromEntries(
    Object.entries(BUILDINGS)
      .filter(([, b]) => b.recipe)
      .map(([kind, b]) => {
        const version = versions.find((v) => v.scope === `recipe:${kind}`);
        return [
          kind,
          {
            recipe: (version?.value ?? b.recipe) as unknown as Recipe,
            version: version?.id ?? 1,
          },
        ];
      }),
  );
}
// Caller must hold the player's transaction advisory lock. Only persisted jobs
// can mature offline. Refill starts at now (or the end of the existing queue),
// never in the past using resources acquired after a player's return.
export async function settleAutomation(
  tx: Tx,
  userId: string,
  now: Date,
  snapshot?: {
    stock: Bundle;
    buildings: (Building & { jobs: ProductionJob[] })[];
  },
) {
  const buildings =
    snapshot?.buildings ??
    (
      await tx.island.findUniqueOrThrow({
        where: { userId },
        include: {
          buildings: {
            include: {
              jobs: {
                where: { status: "RUNNING" },
                orderBy: [{ finishesAt: "asc" }, { id: "asc" }],
              },
            },
          },
        },
      })
    ).buildings;
  const before =
    snapshot?.stock ??
    ((await tx.inventory.findUniqueOrThrow({ where: { userId } }))
      .resources as Bundle);
  let stock: Bundle = { ...before };
  const capacity =
    ECONOMY.baseCapacity +
    buildings
      .filter((b) => b.kind === "warehouse")
      .reduce((n, b) => n + ECONOMY.warehouseCapacity * b.level, 0);
  const active = buildings
    .filter((b) => b.autoEnabled)
    .sort((a, b) => a.id.localeCompare(b.id));
  const configs = await recipes(tx);
  const harvested: Bundle = {},
    collected: string[] = [],
    blocked = new Set<string>();
  const states: Record<string, BuildingView["autoStatus"]> = {};
  const ready = active
    .flatMap((b) => b.jobs)
    .filter((j) => j.finishesAt <= now)
    .sort(
      (a, b) =>
        a.finishesAt.getTime() - b.finishesAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  for (const job of ready) {
    if (blocked.has(job.buildingId)) continue;
    try {
      stock = transact(stock, {}, job.output as Bundle, capacity);
    } catch (error) {
      if (error instanceof RuleError && error.code === "WAREHOUSE_FULL") {
        blocked.add(job.buildingId);
        continue;
      }
      throw error;
    }
    collected.push(job.id);
    for (const [r, n] of Object.entries(job.output as Bundle))
      harvested[r as keyof Bundle] = (harvested[r as keyof Bundle] ?? 0) + n;
  }
  if (collected.length) {
    await tx.productionJob.updateMany({
      where: { id: { in: collected }, status: "RUNNING" },
      data: { status: "COLLECTED", collectedAt: now },
    });
    await tx.playerProgress.update({
      where: { userId },
      data: { produced: { increment: collected.length } },
    });
  }
  const done = new Set(collected);
  const jobs: Prisma.ProductionJobCreateManyInput[] = [];
  for (const building of active) {
    const config = configs[building.kind];
    if (!config) continue;
    if (blocked.has(building.id)) {
      states[building.id] = "warehouse_full";
      continue;
    }
    const pending = building.jobs.filter((j) => !done.has(j.id));
    let cursor = Math.max(
        now.getTime(),
        pending.at(-1)?.finishesAt.getTime() ?? 0,
      ),
      planned = 0;
    for (let n = pending.length; n < ECONOMY.autoQueueLimit; n++) {
      try {
        // A capacity check before reserving inputs prevents scheduling into a full warehouse.
        transact(stock, config.recipe.input, config.recipe.output, capacity);
        stock = transact(stock, config.recipe.input, {}, capacity);
      } catch (error) {
        if (!(error instanceof RuleError)) throw error;
        states[building.id] =
          pending.length + planned > 0
            ? "running"
            : error.code === "WAREHOUSE_FULL"
              ? "warehouse_full"
              : "materials";
        break;
      }
      const end =
        cursor +
        productionSeconds(
          building.kind as BuildingKind,
          building.level,
          config.recipe.seconds,
        ) *
          1000;
      jobs.push({
        buildingId: building.id,
        input: json(config.recipe.input),
        output: json(config.recipe.output),
        startsAt: new Date(cursor),
        finishesAt: new Date(end),
        configVersion: config.version,
      });
      cursor = end;
      planned++;
    }
    states[building.id] ??= "running";
  }
  if (jobs.length) await tx.productionJob.createMany({ data: jobs });
  if (collected.length || jobs.length) {
    await tx.inventory.update({
      where: { userId },
      data: { resources: json(stock) },
    });
    await tx.gameEvent.create({
      data: {
        userId,
        type: collected.length ? "production:auto" : "production:scheduled",
        payload: json({
          batches: collected.length,
          resources: harvested,
          scheduled: jobs.length,
          inventoryBefore: before,
          inventoryAfter: stock,
        }),
      },
    });
  }
  return { states, configs, changed: collected.length > 0 || jobs.length > 0 };
}
