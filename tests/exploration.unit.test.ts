import { describe, expect, it } from "vitest";
import {
  CHOICE_IDS,
  EXPLORATION_EVENTS,
  ORDERS,
  REGIONS,
  REGION_IDS,
  RESOURCE_IDS,
  SHIPS,
  SHIP_IDS,
  type Bundle,
  type RegionId,
  type ShipKind,
} from "../packages/game-config/src/index";
import { count, transact } from "../packages/game-engine/src/index";
import {
  createVoyagePlan,
  regionUnlocked,
  shipRepairCost,
  shipStats,
  shipUpgradeCost,
  type VoyageRandom,
} from "../packages/game-engine/src/exploration";

const minimum: VoyageRandom = (min) => min;
function eventRandom(eventIndex: number, highRoll = false): VoyageRandom {
  let first = true;
  return (min, max) => {
    if (first) {
      first = false;
      return eventIndex;
    }
    return highRoll ? max - 1 : min;
  };
}
function seeded(seed: number): VoyageRandom {
  return (min, max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return min + (seed % (max - min));
  };
}

describe("exploration rules and frozen voyage outcomes", () => {
  it("keeps all three hulls within the fixed database durability contract while upgrades improve capabilities", () => {
    for (const kind of SHIP_IDS) {
      const levels = [1, 2, 3].map((level) => shipStats(kind, level));
      expect(SHIPS[kind].durability).toBe(100);
      expect(levels.every((s) => s.maxDurability === 100)).toBe(true);
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i].capacity).toBeGreaterThan(levels[i - 1].capacity);
        expect(levels[i].speedMultiplier).toBeLessThan(
          levels[i - 1].speedMultiplier,
        );
        expect(levels[i].resistance).toBeGreaterThan(levels[i - 1].resistance);
      }
    }
  });

  it("makes the first skiff outbound leg exactly 30 seconds and never compresses any leg below 20 seconds", () => {
    expect(createVoyagePlan("skiff", 1, "bay", minimum).durationSeconds).toBe(
      30,
    );
    for (const kind of SHIP_IDS)
      for (const level of [1, 2, 3]) {
        const plan = createVoyagePlan(kind, level, "bay", minimum);
        expect(plan.durationSeconds).toBeGreaterThanOrEqual(20);
        expect(plan.durationSeconds).toBe(
          Math.max(
            20,
            Math.ceil(
              REGIONS.bay.seconds * shipStats(kind, level).speedMultiplier,
            ),
          ),
        );
      }
    expect(
      createVoyagePlan("sailboat", 3, "storm", minimum).durationSeconds,
    ).toBeLessThan(
      createVoyagePlan("salvager", 3, "storm", minimum).durationSeconds,
    );
  });

  it("requires both player level and claimed voyages in the preceding region", () => {
    expect(regionUnlocked("bay", 1, {})).toEqual({
      unlocked: true,
      reason: null,
    });
    for (const id of REGION_IDS.slice(1)) {
      const region = REGIONS[id],
        gate = region.requires!;
      expect(regionUnlocked(id, 7, {})).toMatchObject({ unlocked: false });
      expect(
        regionUnlocked(id, region.unlockLevel - 1, {
          [gate.regionId]: gate.voyages,
        }),
      ).toMatchObject({ unlocked: false });
      expect(
        regionUnlocked(id, region.unlockLevel, {
          [gate.regionId]: gate.voyages - 1,
        }),
      ).toMatchObject({ unlocked: false });
      expect(
        regionUnlocked(id, region.unlockLevel, {
          [gate.regionId]: gate.voyages,
        }),
      ).toEqual({ unlocked: true, reason: null });
      expect(REGION_IDS.indexOf(gate.regionId)).toBeLessThan(
        REGION_IDS.indexOf(id),
      );
    }
  });

  it("cannot plan a deep voyage with an under-level ship even if the caller skips the region UI", () => {
    expect(() => createVoyagePlan("skiff", 1, "coral", minimum)).toThrow(
      "2 级船只",
    );
    expect(() => createVoyagePlan("sailboat", 2, "lost", minimum)).toThrow(
      "3 级船只",
    );
    expect(() => createVoyagePlan("skiff", 3, "lost", minimum)).not.toThrow();
  });

  it("provides fifteen distinct events with a free safe return and each of the three meaningful encounter types", () => {
    const seen = new Set<string>();
    for (const id of REGION_IDS) {
      expect(REGIONS[id].eventIds).toHaveLength(3);
      const choices = new Set<string>();
      for (let index = 0; index < 3; index++) {
        const plan = createVoyagePlan("skiff", 3, id, eventRandom(index));
        const event = plan.snapshot.event;
        expect(seen.has(event.id)).toBe(false);
        seen.add(event.id);
        expect(EXPLORATION_EVENTS[event.id].regionId).toBe(id);
        expect(
          event.choices.find((choice) => choice.id === "return"),
        ).toMatchObject({
          cost: {},
          coins: 0,
          successPercent: 100,
          riskDamage: 0,
        });
        expect(plan.outcomes.return).toMatchObject({
          coins: 0,
          damage: 0,
          success: true,
        });
        for (const choice of event.choices) {
          expect(CHOICE_IDS).toContain(choice.id);
          expect(plan.outcomes[choice.id]).toBeDefined();
          if (choice.id !== "return") choices.add(choice.id);
        }
      }
      expect([...choices].sort()).toEqual(["repair", "rescue", "venture"]);
    }
    expect(seen.size).toBe(15);
  });

  it("locks success and failure to the dispatch random stream and never takes cargo away on a failed encounter", () => {
    const won = createVoyagePlan("skiff", 3, "lost", eventRandom(0));
    const failed = createVoyagePlan("skiff", 3, "lost", eventRandom(0, true));
    expect(won.outcomes.venture?.success).toBe(true);
    expect(failed.outcomes.venture?.success).toBe(false);
    expect(failed.outcomes.venture?.resources).toEqual(
      failed.outcomes.return?.resources,
    );
    expect(failed.outcomes.venture?.damage).toBe(
      failed.snapshot.event.choices.find((choice) => choice.id === "venture")!
        .riskDamage,
    );
    expect(failed.outcomes.venture!.damage).toBeLessThanOrEqual(100);
    expect(createVoyagePlan("skiff", 3, "lost", seeded(42))).toEqual(
      createVoyagePlan("skiff", 3, "lost", seeded(42)),
    );
  });

  it("guarantees a paid facility repair with no extra hull risk and keeps rescue as a recorded escort", () => {
    for (const id of REGION_IDS) {
      const repair = createVoyagePlan("skiff", 3, id, eventRandom(1, true));
      const choice = repair.snapshot.event.choices.find(
        (c) => c.id === "repair",
      )!;
      expect(count(choice.cost)).toBeGreaterThan(0);
      expect(choice).toMatchObject({ successPercent: 100, riskDamage: 0 });
      expect(repair.outcomes.repair).toMatchObject({
        success: true,
        damage: 0,
      });
      const rescue = createVoyagePlan("skiff", 3, id, eventRandom(2));
      expect(
        count(
          rescue.snapshot.event.choices.find((c) => c.id === "rescue")!.cost,
        ),
      ).toBeGreaterThan(0);
      expect(rescue.outcomes.rescue?.narrative).toMatch(/抵达|安全/);
      expect(rescue.outcomes.rescue).not.toHaveProperty("resident");
    }
  });

  it("keeps configuration, public event choices and private rolled outcomes in separate immutable-by-copy objects", () => {
    const plan = createVoyagePlan("skiff", 1, "bay", minimum);
    const saved = JSON.stringify(plan);
    const originalSeconds = REGIONS.bay.seconds;
    const originalLoot = REGIONS.bay.loot[0].max;
    const originalBonus = EXPLORATION_EVENTS[plan.snapshot.event.id].bonus;
    try {
      REGIONS.bay.seconds = 999;
      REGIONS.bay.loot[0].max = 999;
      EXPLORATION_EVENTS[plan.snapshot.event.id].bonus = { relic: 999 };
      expect(JSON.stringify(plan)).toBe(saved);
    } finally {
      REGIONS.bay.seconds = originalSeconds;
      REGIONS.bay.loot[0].max = originalLoot;
      EXPLORATION_EVENTS[plan.snapshot.event.id].bonus = originalBonus;
    }
    expect(plan.snapshot).not.toHaveProperty("outcomes");
    expect(plan.snapshot.event).not.toHaveProperty("bonus");
    expect(plan.snapshot.event).not.toHaveProperty("successNarrative");
    const key = Object.keys(plan.outcomes.return!.resources)[0] as keyof Bundle;
    const originalSafe = plan.outcomes.return!.resources[key];
    plan.outcomes.venture!.resources[key] = 999;
    expect(plan.outcomes.return!.resources[key]).toBe(originalSafe);
  });

  it("enforces integer nonnegative cargo within ship capacity over all legal routes and deterministic random samples", () => {
    for (const kind of SHIP_IDS)
      for (const level of [1, 2, 3])
        for (const id of REGION_IDS) {
          if (level < REGIONS[id].minShipLevel) continue;
          for (let seed = 0; seed < 15; seed++) {
            const plan = createVoyagePlan(kind, level, id, seeded(seed));
            expect(Object.keys(plan.outcomes).sort()).toEqual(
              plan.snapshot.event.choices.map((c) => c.id).sort(),
            );
            for (const choice of plan.snapshot.event.choices) {
              const result = plan.outcomes[choice.id]!;
              expect(count(result.resources)).toBeLessThanOrEqual(
                shipStats(kind, level).capacity,
              );
              for (const [resource, amount] of Object.entries(
                result.resources,
              )) {
                expect(RESOURCE_IDS).toContain(resource);
                expect(Number.isSafeInteger(amount) && amount >= 0).toBe(true);
              }
              expect(result.coins).toBe(0);
              expect(result.damage).toBeLessThanOrEqual(choice.riskDamage);
              expect(result.damage).toBeGreaterThanOrEqual(0);
            }
          }
        }
  });

  it("still caps future oversized rewards while preserving research cargo before common materials", () => {
    const event = EXPLORATION_EVENTS[REGIONS.bay.eventIds[0]],
      original = event.bonus;
    try {
      event.bonus = { wood: 500, relic: 2 };
      const plan = createVoyagePlan("skiff", 1, "bay", minimum);
      expect(count(plan.outcomes.venture!.resources)).toBe(
        shipStats("skiff", 1).capacity,
      );
      expect(plan.outcomes.venture!.resources.relic).toBe(2);
    } finally {
      event.bonus = original;
    }
  });

  it("charges full repair packs only for missing durability and cannot refund or overfill an intact hull", () => {
    for (const kind of SHIP_IDS) {
      expect(shipRepairCost(kind, 1, 100)).toEqual({
        cost: {},
        coins: 0,
        restore: 0,
      });
      const one = shipRepairCost(kind, 1, 99),
        twenty = shipRepairCost(kind, 1, 80),
        two = shipRepairCost(kind, 1, 79);
      expect(one.coins).toBe(twenty.coins);
      expect(one.cost).toEqual(twenty.cost);
      expect(one.restore).toBe(1);
      expect(two.restore).toBe(21);
      expect(two.coins).toBe(one.coins * 2);
      expect(count(two.cost)).toBe(count(one.cost) * 2);
      expect(shipRepairCost(kind, 3, 0).restore).toBe(100);
    }
  });

  it("validates level, kind, durability, progress and random boundaries instead of producing exploitable plans", () => {
    for (const level of [0, 4, 1.5, NaN])
      expect(() => shipStats("skiff", level)).toThrow();
    expect(() => shipStats("constructor" as ShipKind, 1)).toThrow("未知船型");
    for (const value of [-1, 101, 2.5, NaN])
      expect(() => shipRepairCost("skiff", 1, value)).toThrow("耐久度无效");
    expect(() => regionUnlocked("constructor" as RegionId, 7, {})).toThrow(
      "未知海域",
    );
    expect(() => regionUnlocked("wrecks", 7, { bay: -1 })).toThrow(
      "航海进度无效",
    );
    expect(() =>
      createVoyagePlan("skiff", 1, "bay", (_min, max) => max),
    ).toThrow("随机结果");
    expect(() => createVoyagePlan("skiff", 1, "bay", () => 0.5)).toThrow(
      "随机结果",
    );
  });

  it("uses current level for upgrade prices and returns copies that callers cannot mutate into a cheaper upgrade", () => {
    for (const kind of SHIP_IDS) {
      expect(shipUpgradeCost(kind, 1)).toEqual(SHIPS[kind].upgrades[2]);
      expect(shipUpgradeCost(kind, 2)).toEqual(SHIPS[kind].upgrades[3]);
      expect(() => shipUpgradeCost(kind, 3)).toThrow("最高等级");
      const cost = shipUpgradeCost(kind, 1);
      cost.coins = 0;
      cost.cost.wood = 0;
      expect(shipUpgradeCost(kind, 1).coins).toBeGreaterThan(0);
      expect(shipUpgradeCost(kind, 1)).toEqual(SHIPS[kind].upgrades[2]);
    }
  });

  it("gives each new research material a reachable cargo source and a persisted-template order sink", () => {
    for (const resource of ["seed", "alloy", "relic"] as const) {
      const source = REGION_IDS.find((id) =>
        REGIONS[id].loot.some(
          (drop) => drop.resource === resource && drop.min > 0,
        ),
      );
      expect(source).toBeDefined();
      const plan = createVoyagePlan("skiff", 3, source!, minimum);
      expect(plan.outcomes.return!.resources[resource]).toBeGreaterThan(0);
      expect(ORDERS.some((order) => (order.input[resource] ?? 0) > 0)).toBe(
        true,
      );
      expect(
        transact({ [resource]: 2 }, { [resource]: 1 }, {}, 80)[resource],
      ).toBe(1);
    }
  });
});
