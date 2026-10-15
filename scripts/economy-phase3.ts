import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILDINGS,
  ECONOMY,
  ORDERS,
  REGIONS,
  REGION_IDS,
  RESOURCE_IDS,
  SALVAGE,
  SHIPS,
  SHIP_IDS,
  type BuildingKind,
  type Bundle,
  type ChoiceId,
  type RegionId,
  type Resource,
  type ShipKind,
} from "../packages/game-config/src/index";
import {
  count,
  levelFor,
  productionSeconds,
  RuleError,
  transact,
  upgradeCost,
} from "../packages/game-engine/src/index";
import {
  createVoyagePlan,
  regionUnlocked,
  shipRepairCost,
  shipStats,
  shipUpgradeCost,
  type VoyagePlan,
} from "../packages/game-engine/src/exploration";

// An executable strategy model, not HTTP load testing or measured player telemetry.
// Rule functions are shared with the server; scheduling mirrors production.ts/game.ts.
const DAY = 86400;
const STEP = 5;
export const HORIZONS = [1800, 7200, DAY, DAY * 3, DAY * 7];
export const PERSONAS = [
  { id: "casual", minutesPerDay: 20, minimumSuccess: 100 },
  { id: "regular", minutesPerDay: 45, minimumSuccess: 80 },
  { id: "active", minutesPerDay: 120, minimumSuccess: 60 },
] as const;
type Persona = (typeof PERSONAS)[number];
type Job = { end: number; output: Bundle };
type Building = {
  kind: BuildingKind;
  level: number;
  auto: boolean;
  jobs: Job[];
};
type Voyage = {
  region: RegionId;
  arrives: number;
  returns?: number;
  choice?: ChoiceId;
  plan: VoyagePlan;
};
type Ship = {
  kind: ShipKind;
  level: number;
  durability: number;
  voyage?: Voyage;
};
type Ledger = {
  resourcesIn: Bundle;
  resourcesOut: Bundle;
  coinsIn: number;
  coinsOut: number;
  transactions: number;
};
const add = (target: Bundle, source: Bundle) => {
  for (const resource of RESOURCE_IDS)
    if (source[resource])
      target[resource] = (target[resource] ?? 0) + source[resource]!;
};
export function seededRandom(seed: number) {
  let value = seed >>> 0;
  return (min: number, maxExclusive: number) => {
    value += 0x6d2b79f5;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    const unit = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    return min + Math.floor(unit * (maxExclusive - min));
  };
}

export function simulate(persona: Persona, seed: number, until = DAY * 7) {
  const random = seededRandom(seed);
  let stock: Bundle = { ...ECONOMY.initial };
  let coins = ECONOMY.initialCoins;
  let xp = 0;
  let time = 0;
  let actions = 0;
  let activeSeconds = 0;
  let lastSpawn = 0;
  let ordersCompleted = 0;
  let maximumQueue = 0;
  let maximumStock = count(stock);
  let blockedProductionReads = 0;
  let blockedVoyageClaims = 0;
  const buildings: Building[] = [];
  const ships: Ship[] = [];
  const claimed = Object.fromEntries(REGION_IDS.map((id) => [id, 0])) as Record<
    RegionId,
    number
  >;
  const ledger: Record<string, Ledger> = {};
  const milestones: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  const orderCounts: Record<string, number> = {};
  const issued = new Map<string, number>();
  let orders: { template: (typeof ORDERS)[number]; expires: number }[] = [];
  let spawns: { reward: Bundle; expires: number }[] = SALVAGE.map((item) => ({
    reward: item.reward,
    expires: 180,
  }));
  const capacity = () =>
    ECONOMY.baseCapacity +
    buildings
      .filter((b) => b.kind === "warehouse")
      .reduce((total, b) => total + b.level * ECONOMY.warehouseCapacity, 0);
  const has = (kind: BuildingKind) => buildings.some((b) => b.kind === kind);
  const canPay = (input: Bundle, price = 0) =>
    coins >= price &&
    RESOURCE_IDS.every((id) => (stock[id] ?? 0) >= (input[id] ?? 0));
  function exchange(
    category: string,
    input: Bundle = {},
    output: Bundle = {},
    price = 0,
    income = 0,
  ) {
    if (!canPay(input, price)) return false;
    try {
      const next = transact(stock, input, output, capacity());
      stock = next;
      coins += income - price;
      const entry = (ledger[category] ??= {
        resourcesIn: {},
        resourcesOut: {},
        coinsIn: 0,
        coinsOut: 0,
        transactions: 0,
      });
      add(entry.resourcesIn, output);
      add(entry.resourcesOut, input);
      entry.coinsIn += income;
      entry.coinsOut += price;
      entry.transactions++;
      maximumStock = Math.max(maximumStock, count(stock));
      assert.ok(coins >= 0 && count(stock) <= capacity());
      return true;
    } catch (error) {
      if (error instanceof RuleError && error.code === "WAREHOUSE_FULL")
        return false;
      throw error;
    }
  }
  const mark = (key: string) => {
    milestones[key] ??= time;
  };
  const target = (resource: Resource) =>
    ({
      wood: 36,
      plastic: 22,
      metal: 20,
      water: ships.length >= 2 ? 36 : 18,
      fish: ships.length >= 2 ? 27 : 12,
      seaweed: 16,
      plank: ships.length >= 2 ? 32 : 20,
      parts: 24,
      alloy: 12,
      seed: 6,
      relic: 3,
    })[resource];
  const pending = (resource: Resource) =>
    buildings
      .flatMap((b) => b.jobs)
      .reduce((sum, job) => sum + (job.output[resource] ?? 0), 0);
  const outputNeeded = (b: Building) => {
    const recipe = BUILDINGS[b.kind].recipe!;
    return Object.keys(recipe.output).some(
      (resource) =>
        (stock[resource as Resource] ?? 0) + pending(resource as Resource) <
        target(resource as Resource),
    );
  };

  // No work is scheduled during absence: only prepaid jobs can become ready.
  function settleAndRefresh() {
    const blocked = new Set<Building>();
    const ready = buildings
      .filter((b) => b.auto)
      .flatMap((b) =>
        b.jobs.filter((job) => job.end <= time).map((job) => ({ b, job })),
      )
      .sort((a, b) => a.job.end - b.job.end);
    for (const { b, job } of ready) {
      if (blocked.has(b)) continue;
      if (exchange("productionOutput", {}, job.output))
        b.jobs.splice(b.jobs.indexOf(job), 1);
      else {
        blocked.add(b);
        blockedProductionReads++;
      }
    }
    for (const b of buildings.filter((building) => building.auto)) {
      if (blocked.has(b)) continue;
      const recipe = BUILDINGS[b.kind].recipe!;
      while (b.jobs.length < ECONOMY.autoQueueLimit && canPay(recipe.input)) {
        try {
          transact(stock, recipe.input, recipe.output, capacity());
        } catch (error) {
          if (!(error instanceof RuleError)) throw error;
          break;
        }
        assert.ok(exchange("productionInput", recipe.input));
        b.jobs.push({
          end:
            Math.max(time, b.jobs.at(-1)?.end ?? time) +
            productionSeconds(b.kind, b.level),
          output: { ...recipe.output },
        });
      }
      maximumQueue = Math.max(maximumQueue, b.jobs.length);
      assert.ok(b.jobs.length <= ECONOMY.autoQueueLimit);
    }
    spawns = spawns.filter((spawn) => spawn.expires > time);
    const amount = Math.min(
      ECONOMY.salvageLimit - spawns.length,
      Math.floor((time - lastSpawn) / ECONOMY.salvageSeconds),
    );
    for (let i = 0; i < amount; i++)
      spawns.push({
        reward: SALVAGE[random(0, SALVAGE.length)].reward,
        expires: time + ECONOMY.salvageLifetimeSeconds,
      });
    if (amount > 0) lastSpawn = time;
    orders = orders.filter((order) => order.expires > time);
    const available = ORDERS.filter(
      (order) => order.level <= levelFor(xp),
    ).sort(
      (a, b) =>
        (issued.get(a.code) ?? 0) - (issued.get(b.code) ?? 0) ||
        a.level - b.level ||
        a.code.localeCompare(b.code),
    );
    if (!ordersCompleted)
      available.sort(
        (a, b) =>
          Number(b.code === "first-water") - Number(a.code === "first-water"),
      );
    for (const template of available
      .filter((order) => !orders.some((o) => o.template.code === order.code))
      .slice(0, 3 - orders.length)) {
      const expires = time + ECONOMY.orderLifetimeSeconds;
      orders.push({ template, expires });
      issued.set(template.code, expires);
    }
  }
  function upgradeWarehouse() {
    const b = buildings.find(
      (item) => item.kind === "warehouse" && item.level < 3,
    );
    if (
      !b ||
      !exchange(
        "buildingUpgrade",
        upgradeCost(b.kind, b.level),
        {},
        30 * b.level,
      )
    )
      return false;
    b.level++;
    xp += 10;
    mark(`building:warehouse:${b.level}`);
    return true;
  }
  function makeSpace() {
    if (upgradeWarehouse()) return true;
    const resources = [...RESOURCE_IDS].sort(
      (a, b) => (stock[b] ?? 0) - target(b) - ((stock[a] ?? 0) - target(a)),
    );
    const resource = resources[0];
    const excess = (stock[resource] ?? 0) - target(resource);
    if (excess <= 0) return false;
    return exchange("discard", { [resource]: Math.min(excess, 30) });
  }
  function completeOrder() {
    for (const entry of orders) {
      const order = entry.template;
      // Save basic infrastructure/repair wood and alloy for the three real ship types.
      if (
        order.input.wood &&
        (stock.wood ?? 0) - order.input.wood <
          (has("warehouse") && has("dock") ? 12 : 24)
      )
        continue;
      if (
        order.input.alloy &&
        (stock.alloy ?? 0) - order.input.alloy < (ships.length < 3 ? 6 : 2)
      )
        continue;
      if (!exchange("orders", order.input, {}, 0, order.coins)) continue;
      xp += order.xp;
      ordersCompleted++;
      orderCounts[order.code] = (orderCounts[order.code] ?? 0) + 1;
      orders.splice(orders.indexOf(entry), 1);
      mark("firstOrder");
      if (
        ["seed", "alloy", "relic"].some(
          (resource) => order.input[resource as Resource],
        )
      )
        mark("firstResearchOrder");
      return true;
    }
    return false;
  }
  function build(kind: BuildingKind) {
    const config = BUILDINGS[kind];
    if (
      has(kind) ||
      levelFor(xp) < config.unlock ||
      buildings.length >= 9 ||
      !exchange("buildingBuild", config.cost, {}, config.coins)
    )
      return false;
    buildings.push({ kind, level: 1, auto: false, jobs: [] });
    xp += ECONOMY.buildXp;
    mark(`building:${kind}:1`);
    return true;
  }
  function fleetInvest() {
    if (!has("dock")) return false;
    for (const kind of SHIP_IDS) {
      const config = SHIPS[kind];
      if (
        ships.some((s) => s.kind === kind) ||
        levelFor(xp) < config.unlockLevel
      )
        continue;
      if (kind !== "skiff" && coins < config.coins + 80) continue;
      if (!exchange("shipBuild", config.cost, {}, config.coins)) continue;
      ships.push({
        kind,
        level: 1,
        durability: shipStats(kind, 1).maxDurability,
      });
      mark(`ship:${kind}:1`);
      return true;
    }
    for (const ship of ships) {
      const needLevel = claimed.storm >= 3 ? 3 : claimed.wrecks >= 2 ? 2 : 1;
      if (ship.voyage || ship.level >= needLevel) continue;
      const cost = shipUpgradeCost(ship.kind, ship.level);
      if (
        coins < cost.coins + 20 ||
        !exchange("shipUpgrade", cost.cost, {}, cost.coins)
      )
        continue;
      ship.level++;
      mark(`ship:${ship.kind}:${ship.level}`);
      return true;
    }
    return false;
  }
  function manageVoyage() {
    for (const ship of ships) {
      const voyage = ship.voyage;
      if (!voyage || voyage.arrives > time) continue;
      if (!voyage.choice) {
        const candidate = voyage.plan.snapshot.event.choices[1];
        const option =
          candidate.successPercent >= persona.minimumSuccess &&
          ship.durability >= candidate.riskDamage &&
          canPay(candidate.cost, candidate.coins)
            ? candidate
            : voyage.plan.snapshot.event.choices[0];
        assert.ok(exchange("eventChoice", option.cost, {}, option.coins));
        voyage.choice = option.id;
        voyage.returns = time + option.returnSeconds;
        ship.durability -= voyage.plan.outcomes[option.id]!.damage;
        decisions[option.id] = (decisions[option.id] ?? 0) + 1;
        return true;
      }
      if (voyage.returns! > time) continue;
      const result = voyage.plan.outcomes[voyage.choice]!;
      if (
        !exchange("explorationReward", {}, result.resources, 0, result.coins)
      ) {
        blockedVoyageClaims++;
        if (makeSpace()) return true;
        continue;
      }
      xp += result.xp;
      claimed[voyage.region]++;
      mark(`explored:${voyage.region}`);
      delete ship.voyage;
      return true;
    }
    return false;
  }
  function dispatch() {
    const unlocked = REGION_IDS.filter(
      (id) => regionUnlocked(id, levelFor(xp), claimed).unlocked,
    );
    for (const ship of ships.filter((s) => !s.voyage)) {
      const eligible = unlocked.filter(
        (id) => ship.level >= REGIONS[id].minShipLevel,
      );
      const rank = (id: RegionId) => {
        const next = REGION_IDS.find(
          (region) => REGIONS[region].requires?.regionId === id,
        );
        if (next && claimed[id] < REGIONS[next].requires!.voyages)
          return 100 + REGION_IDS.indexOf(id);
        if ((stock.alloy ?? 0) < 8 && id === "wrecks") return 80;
        if ((stock.seed ?? 0) < 4 && id === "coral") return 75;
        if ((stock.relic ?? 0) < 2 && id === "lost") return 70;
        if ((stock.wood ?? 0) < 16 && id === "bay") return 60;
        return REGION_IDS.indexOf(id);
      };
      eligible.sort((a, b) => rank(b) - rank(a));
      for (const regionId of eligible) {
        const config = REGIONS[regionId];
        if (ship.durability < config.baseWear + 10) {
          const cost = shipRepairCost(ship.kind, ship.level, ship.durability);
          if (exchange("shipRepair", cost.cost, {}, cost.coins)) {
            ship.durability = shipStats(ship.kind, ship.level).maxDurability;
            return true;
          }
        }
        if (
          ship.durability < config.baseWear ||
          !exchange("dispatch", config.supplies, {}, config.coins)
        )
          continue;
        const plan = createVoyagePlan(ship.kind, ship.level, regionId, random);
        ship.durability -= config.baseWear;
        ship.voyage = {
          region: regionId,
          arrives: time + plan.durationSeconds,
          plan,
        };
        mark("firstDispatch");
        return true;
      }
    }
    return false;
  }
  function production() {
    for (const b of buildings.filter(
      (item) => !item.auto && item.jobs.some((job) => job.end <= time),
    )) {
      let collected = 0;
      for (const job of [...b.jobs].filter((job) => job.end <= time)) {
        if (!exchange("productionOutput", {}, job.output)) break;
        b.jobs.splice(b.jobs.indexOf(job), 1);
        collected++;
      }
      if (collected) return true;
    }
    for (const b of buildings.filter(
      (item) =>
        BUILDINGS[item.kind].recipe &&
        !item.auto &&
        item.jobs.length < ECONOMY.queueLimit &&
        outputNeeded(item),
    )) {
      const recipe = BUILDINGS[b.kind].recipe!;
      if (recipe.input.wood && (stock.wood ?? 0) - recipe.input.wood < 16)
        continue;
      if (!exchange("productionInput", recipe.input)) continue;
      b.jobs.push({
        end:
          Math.max(time, b.jobs.at(-1)?.end ?? time) +
          productionSeconds(b.kind, b.level),
        output: { ...recipe.output },
      });
      maximumQueue = Math.max(maximumQueue, b.jobs.length);
      return true;
    }
    return false;
  }
  function salvage() {
    if (
      !spawns.length ||
      !["wood", "plastic", "metal", "seaweed"].some(
        (id) => (stock[id as Resource] ?? 0) < target(id as Resource),
      )
    )
      return false;
    // The player sees kind, not private reward. Consume in spawn order; never peek to select a better roll.
    if (!exchange("salvage", {}, spawns[0].reward)) return false;
    spawns.shift();
    mark("firstSalvage");
    return true;
  }
  function decide(sessionSeconds: number, sessionLength: number) {
    const closing = sessionSeconds >= sessionLength - 30;
    if (!closing) {
      const automated = buildings.find((b) => b.auto);
      if (automated) {
        automated.auto = false;
        return true;
      }
    } else {
      const manual = buildings.find((b) => BUILDINGS[b.kind].recipe && !b.auto);
      if (manual) {
        manual.auto = true;
        settleAndRefresh();
        return true;
      }
    }
    if (manageVoyage()) return true;
    if (completeOrder()) return true;
    // Do not spend the first storage expansion materials on another building.
    if (!has("warehouse")) {
      if (build("purifier") || build("warehouse") || salvage() || production())
        return true;
      return makeSpace();
    }
    for (const kind of [
      "purifier",
      "warehouse",
      "fishnet",
      "dock",
      "workshop",
      "garden",
      "recycler",
    ] as BuildingKind[])
      if (build(kind)) return true;
    if (fleetInvest()) return true;
    if (count(stock) > capacity() * 0.7 && upgradeWarehouse()) return true;
    if (production()) return true;
    if (dispatch()) return true;
    if (salvage()) return true;
    if (coins > 150 && build("cabin")) return true;
    if (time > 600 && coins > 180) {
      for (const b of buildings.filter(
        (item) =>
          item.level < 3 &&
          item.kind !== "warehouse" &&
          BUILDINGS[item.kind].recipe,
      )) {
        if (
          !exchange(
            "buildingUpgrade",
            upgradeCost(b.kind, b.level),
            {},
            30 * b.level,
          )
        )
          continue;
        b.level++;
        xp += 10;
        mark(`building:${b.kind}:${b.level}`);
        return true;
      }
    }
    if (count(stock) > capacity() * 0.9) return makeSpace();
    return false;
  }
  function verify() {
    const all = Object.values(ledger);
    assert.equal(
      coins,
      ECONOMY.initialCoins +
        all.reduce((sum, e) => sum + e.coinsIn - e.coinsOut, 0),
      "Coin conservation",
    );
    for (const id of RESOURCE_IDS) {
      assert.equal(
        stock[id] ?? 0,
        (ECONOMY.initial[id] ?? 0) +
          all.reduce(
            (sum, entry) =>
              sum +
              (entry.resourcesIn[id] ?? 0) -
              (entry.resourcesOut[id] ?? 0),
            0,
          ),
        `${id} conservation`,
      );
      assert.ok(Number.isSafeInteger(stock[id] ?? 0) && (stock[id] ?? 0) >= 0);
    }
    assert.ok(count(stock) <= capacity());
    for (const ship of ships)
      assert.ok(ship.durability >= 0 && ship.durability <= 100);
    for (const b of buildings)
      assert.ok(b.jobs.length <= ECONOMY.autoQueueLimit);
  }
  function snapshot() {
    verify();
    return structuredClone({
      elapsedSeconds: time,
      activeMinutes: activeSeconds / 60,
      actions,
      level: levelFor(xp),
      xp,
      coins,
      ordersCompleted,
      orderCounts,
      capacity: capacity(),
      stored: count(stock),
      stock,
      buildings: buildings.map((b) => ({
        kind: b.kind,
        level: b.level,
        auto: b.auto,
        queued: b.jobs.length,
        ready: b.jobs.filter((j) => j.end <= time).length,
      })),
      ships: ships.map((s) => ({
        kind: s.kind,
        level: s.level,
        durability: s.durability,
        voyage: s.voyage
          ? {
              region: s.voyage.region,
              phase: !s.voyage.choice
                ? s.voyage.arrives <= time
                  ? "choice"
                  : "sailing"
                : s.voyage.returns! <= time
                  ? "ready"
                  : "returning",
            }
          : null,
      })),
      claimed,
      unlocked: REGION_IDS.filter(
        (id) => regionUnlocked(id, levelFor(xp), claimed).unlocked,
      ),
      ledger,
      milestonesSeconds: milestones,
      decisions,
      limits: {
        maximumStock,
        maximumQueue,
        blockedProductionReads,
        blockedVoyageClaims,
      },
    });
  }
  const snapshots = [];
  for (time = 0; time <= until; time += STEP) {
    if (HORIZONS.includes(time) || time === until) snapshots.push(snapshot());
    if (time === until) break;
    const sessionLength = persona.minutesPerDay * 30;
    const sessionSeconds = time % (DAY / 2);
    if (sessionSeconds >= sessionLength) continue;
    activeSeconds += STEP;
    settleAndRefresh();
    if (decide(sessionSeconds, sessionLength)) actions++;
    verify();
  }
  return {
    persona: persona.id,
    minutesPerDay: persona.minutesPerDay,
    seed,
    snapshots,
  };
}

export function runStudy() {
  const seeds = [20261015, 20261016, 20261017, 20261018, 20261019];
  const runs = PERSONAS.flatMap((persona) =>
    seeds.map((seed) => simulate(persona, seed)),
  );
  const files = [
    "packages/game-config/src/index.ts",
    "packages/game-config/src/exploration.ts",
    "packages/game-engine/src/index.ts",
    "packages/game-engine/src/exploration.ts",
    "apps/api/src/game.ts",
    "apps/api/src/production.ts",
    "scripts/economy-phase3.ts",
  ];
  const sourceHashes = Object.fromEntries(
    files.map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  const report = {
    model: "phase3a-session-strategy-v1",
    generatedAt: new Date().toISOString(),
    node: process.version,
    sourceHashes,
    assumptions: {
      sessions:
        "Two equal sessions per day, at elapsed 00:00 and 12:00. No warm-up, gifts, administrator overrides or clock acceleration. Day N snapshots are taken before the next day's login.",
      decisions:
        "At most one intent per 5 seconds. Read/automatic settlement before each intent. Priorities and resource reserves are deterministic heuristics, not an optimal strategy.",
      production:
        "Manual queue limit 3; enable automatic prepaid queue limit 30 in last 30 seconds of each session; disable on next login. Pending jobs remain stored when warehouse is full. Automatic settlement order is fixed building creation order instead of random UUID order.",
      storage:
        "Actual base capacity + one warehouse upgraded to level 3; no unlimited warehouse. No extra floor needed for at most 8 buildings on the 9 original tiles. Explicit discard is a recorded sink.",
      rng: "Five fixed seeds, uniform salvage selection and actual pure exploration engine. Production outcomes and choices are not rerolled. Candidate selection uses displayed probability, never hidden outcome.",
      orders:
        "Only three simultaneous player orders, real oldest-issued template rotation, actual 30 minute expiry, level gates, same inputs/coins/xp as seed configuration. Model refreshes at each active 5 second tick.",
      absent:
        "No reads, recurring production refill, salvage claims, event decisions or reward claims while offline; only already prepaid jobs and dispatched voyage timestamps advance.",
      market:
        "Zero trades: no asserted clearing prices or synthetic buyer demand. 5% fee is analyzed separately.",
      scope:
        "No residents, housing consumption, specialties, new multi-step processing chains, weather or cooperative rewards exist in this model; they are not yet implemented. Existing cabin has only prosperity, no resident upkeep.",
      limitations:
        "Strategy model only; not live server measurements, API performance, retention forecast or equilibrium proof. Low-level timing matches configuration but network latency, human learning and failed HTTP requests are excluded. Administrative recipe overrides excluded.",
    },
    runs,
  };
  mkdirSync("docs/economy-phase3", { recursive: true });
  writeFileSync(
    "docs/economy-phase3/simulation.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const run of runs.filter((item) => item.seed === seeds[0])) {
    console.log(
      run.persona,
      JSON.stringify(
        run.snapshots.map((s) => ({
          hours: s.elapsedSeconds / 3600,
          activeMinutes: s.activeMinutes,
          level: s.level,
          coins: s.coins,
          orders: s.ordersCompleted,
          voyages: Object.values(s.claimed).reduce((sum, n) => sum + n, 0),
          regions: s.unlocked.length,
          ships: s.ships.map((ship) => `${ship.kind}:${ship.level}`),
          stock: `${s.stored}/${s.capacity}`,
        })),
      ),
    );
  }
  console.log(
    "Wrote docs/economy-phase3/simulation.json; all inventory, queue, coin and durability assertions passed.",
  );
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  runStudy();
