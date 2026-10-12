import {
  BUILDINGS,
  ECONOMY,
  ORDERS,
  SALVAGE,
  type BuildingKind,
  type Bundle,
} from "../packages/game-config/src/index";
import { count, levelFor, transact } from "../packages/game-engine/src/index";
// Deterministic single-player reference simulation, using the same costs and recipes.
// Active for the first 30 min, then 10 min per hour; no market or administrator overrides.
function simulate(horizon: number) {
  let stock: Bundle = { ...ECONOMY.initial },
    coins = ECONOMY.initialCoins,
    xp = 0,
    capacity = ECONOMY.baseCapacity,
    orders = 0,
    lootIndex = 0,
    blocked = 0,
    lastSpawn = 0;
  const buildings: BuildingKind[] = [];
  let jobs: { kind: BuildingKind; end: number; output: Bundle }[] = [];
  const milestones: Record<string, number> = {};
  const exchange = (input: Bundle, output: Bundle) => {
    try {
      stock = transact(stock, input, output, capacity);
      return true;
    } catch {
      return false;
    }
  };
  for (let time = 0; time <= horizon; time += 5) {
    const active = time <= 1800 || time % 3600 < 600;
    if (!active) continue;
    for (const job of [...jobs])
      if (job.end <= time && exchange({}, job.output))
        jobs = jobs.filter((j) => j !== job);
    const spawns =
      time === 0
        ? 6
        : Math.min(6, Math.floor((time - lastSpawn) / ECONOMY.salvageSeconds));
    if (spawns) {
      lastSpawn = time;
      for (let i = 0; i < spawns; i++) {
        const loot = SALVAGE[lootIndex++ % SALVAGE.length];
        if (exchange({}, loot.reward)) milestones.firstSalvage ??= time;
        else blocked++;
      }
    }
    for (const kind of [
      "purifier",
      "fishnet",
      "warehouse",
      "workshop",
      "garden",
      "dock",
      "recycler",
      "cabin",
    ] as BuildingKind[]) {
      const cfg = BUILDINGS[kind];
      if (
        !buildings.includes(kind) &&
        levelFor(xp) >= cfg.unlock &&
        coins >= cfg.coins &&
        exchange(cfg.cost, {})
      ) {
        buildings.push(kind);
        coins -= cfg.coins;
        xp += ECONOMY.buildXp;
        if (kind === "warehouse") capacity += ECONOMY.warehouseCapacity;
        milestones[`build:${kind}`] = time;
      }
    }
    for (const order of ORDERS) {
      if (!buildings.includes("warehouse") && order.input.wood) continue;
      if (!buildings.includes("workshop") && order.input.wood) continue;
      if (levelFor(xp) >= order.level && exchange(order.input, {})) {
        coins += order.coins;
        xp += order.xp;
        orders++;
        milestones.firstOrder ??= time;
      }
    }
    if (count(stock) > capacity - 12) {
      const resource = Object.entries(stock).sort(
        (a, b) => b[1] - a[1],
      )[0]?.[0] as keyof Bundle;
      if (resource && stock[resource]! > 20) exchange({ [resource]: 5 }, {});
    }
    for (const kind of buildings) {
      const recipe = BUILDINGS[kind].recipe;
      if (!recipe) continue;
      let queue = jobs.filter((j) => j.kind === kind);
      while (
        queue.length < ECONOMY.queueLimit &&
        count(stock) < capacity - 10 &&
        exchange(recipe.input, {})
      ) {
        const start = queue.at(-1)?.end ?? time;
        const job = {
          kind,
          end: Math.max(time, start) + recipe.seconds,
          output: recipe.output,
        };
        jobs.push(job);
        queue = [...queue, job];
      }
    }
  }
  return {
    hours: horizon / 3600,
    level: levelFor(xp),
    coins,
    xp,
    orders,
    capacity,
    stored: count(stock),
    stock,
    buildings,
    blockedSalvage: blocked,
    milestonesSeconds: milestones,
  };
}
console.log(
  JSON.stringify(
    {
      assumptions:
        "first 30 minutes active, then 10 minutes/hour; deterministic salvage; capacity respected; no trading, upgrade or config overrides",
      results: [1800, 7200, 86400].map(simulate),
    },
    null,
    2,
  ),
);
