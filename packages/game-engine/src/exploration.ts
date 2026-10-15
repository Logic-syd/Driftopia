import {
  EXPLORATION_EVENTS,
  REGIONS,
  RESOURCE_IDS,
  SHIPS,
  type Bundle,
  type ChoiceId,
  type RegionConfig,
  type RegionId,
  type Resource,
  type ShipCost,
  type ShipKind,
} from "../../game-config/src/index";
import type {
  ExplorationChoiceView,
  ExplorationEventView,
  ShipStatsView,
  VoyageResultView,
} from "../../shared/src/exploration";
import { count, RuleError } from "./index";

export interface VoyageSnapshot {
  version: 1;
  ship: ShipStatsView & { kind: ShipKind; level: number };
  region: RegionConfig & { id: RegionId };
  event: ExplorationEventView;
}
export interface VoyagePlan {
  durationSeconds: number;
  snapshot: VoyageSnapshot;
  // Private outcomes must never be sent to the browser before a choice is committed.
  outcomes: Partial<Record<ChoiceId, VoyageResultView>>;
}
export type VoyageRandom = (min: number, maxExclusive: number) => number;

function checkShip(kind: ShipKind, level: number) {
  if (!Object.hasOwn(SHIPS, kind))
    throw new RuleError("INVALID_SHIP", "未知船型");
  if (!Number.isInteger(level) || level < 1 || level > 3)
    throw new RuleError("INVALID_SHIP_LEVEL", "船只等级必须为 1 至 3");
  return SHIPS[kind];
}
function checkRegion(regionId: RegionId) {
  if (!Object.hasOwn(REGIONS, regionId))
    throw new RuleError("INVALID_REGION", "未知海域");
  return REGIONS[regionId];
}
export function shipStats(kind: ShipKind, level: number): ShipStatsView {
  const config = checkShip(kind, level);
  return {
    capacity: config.capacity + (level - 1) * 6,
    maxDurability: 100,
    speedMultiplier:
      1 / (Math.round((config.speed + (level - 1) * 0.1) * 100) / 100),
    resistance: Math.min(60, config.resistance + (level - 1) * 7),
  };
}
export function shipUpgradeCost(
  kind: ShipKind,
  currentLevel: number,
): ShipCost {
  const config = checkShip(kind, currentLevel);
  if (currentLevel >= 3)
    throw new RuleError("SHIP_MAX_LEVEL", "船只已达到最高等级");
  return structuredClone(config.upgrades[(currentLevel + 1) as 2 | 3]);
}
export function shipRepairCost(
  kind: ShipKind,
  level: number,
  durability: number,
): ShipCost & { restore: number } {
  const stats = shipStats(kind, level);
  if (
    !Number.isSafeInteger(durability) ||
    durability < 0 ||
    durability > stats.maxDurability
  )
    throw new RuleError("INVALID_DURABILITY", "船只耐久度无效");
  const restore = stats.maxDurability - durability;
  if (!restore) return { cost: {}, coins: 0, restore: 0 };
  const packs = Math.ceil(restore / 20),
    config = SHIPS[kind].repairPer20;
  return {
    cost: Object.fromEntries(
      Object.entries(config.cost).map(([resource, amount]) => [
        resource,
        amount * packs,
      ]),
    ) as Bundle,
    coins: config.coins * packs,
    restore,
  };
}
export function regionUnlocked(
  regionId: RegionId,
  playerLevel: number,
  claimedCounts: Partial<Record<RegionId, number>>,
): { unlocked: boolean; reason: string | null } {
  const region = checkRegion(regionId);
  if (!Number.isSafeInteger(playerLevel) || playerLevel < 1)
    throw new RuleError("INVALID_LEVEL", "玩家等级无效");
  if (playerLevel < region.unlockLevel)
    return {
      unlocked: false,
      reason: `玩家等级达到 ${region.unlockLevel} 级后开放`,
    };
  if (region.requires) {
    const { regionId: previous, voyages } = region.requires;
    const completed = claimedCounts[previous] ?? 0;
    if (!Number.isSafeInteger(completed) || completed < 0)
      throw new RuleError("INVALID_PROGRESS", "航海进度无效");
    if (completed < voyages)
      return {
        unlocked: false,
        reason: `先完成并领取 ${REGIONS[previous].name} ${voyages} 次航程（${completed}/${voyages}）`,
      };
  }
  return { unlocked: true, reason: null };
}
function boundedRandom(
  random: VoyageRandom,
  min: number,
  maxExclusive: number,
) {
  const result = random(min, maxExclusive);
  if (!Number.isSafeInteger(result) || result < min || result >= maxExclusive)
    throw new RuleError("INVALID_RANDOM", "航海随机结果超出配置范围");
  return result;
}
function merge(a: Bundle, b: Bundle): Bundle {
  const result: Bundle = { ...a };
  for (const resource of RESOURCE_IDS) {
    const amount = b[resource] ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RuleError("INVALID_REWARD", "航海奖励配置无效");
    if (amount) result[resource] = (result[resource] ?? 0) + amount;
  }
  return result;
}
function fitCargo(resources: Bundle, capacity: number): Bundle {
  if (count(resources) <= capacity) return { ...resources };
  // Preserve rare research cargo first; the rest follows one stable resource order.
  const priority: Resource[] = [
    "relic",
    "alloy",
    "seed",
    ...RESOURCE_IDS.filter((id) => !["relic", "alloy", "seed"].includes(id)),
  ];
  const result: Bundle = {};
  let room = capacity;
  for (const resource of priority) {
    const amount = Math.min(resources[resource] ?? 0, room);
    if (amount) result[resource] = amount;
    room -= amount;
  }
  return result;
}

/** All randomness is consumed at dispatch. Choosing/claiming never rolls again. */
export function createVoyagePlan(
  kind: ShipKind,
  level: number,
  regionId: RegionId,
  randomInt: VoyageRandom,
): VoyagePlan {
  const stats = shipStats(kind, level);
  const region = structuredClone(checkRegion(regionId));
  if (level < region.minShipLevel)
    throw new RuleError(
      "SHIP_LEVEL_REQUIRED",
      `此海域需要 ${region.minShipLevel} 级船只`,
    );
  const eventId =
    region.eventIds[boundedRandom(randomInt, 0, region.eventIds.length)];
  const event = structuredClone(EXPLORATION_EVENTS[eventId]);
  if (!event || event.regionId !== regionId)
    throw new RuleError("INVALID_EVENT", "海域事件配置无效");
  const base: Bundle = {};
  for (const drop of region.loot) {
    if (
      !Number.isSafeInteger(drop.min) ||
      !Number.isSafeInteger(drop.max) ||
      drop.min < 0 ||
      drop.max < drop.min
    )
      throw new RuleError("INVALID_REWARD", "航海奖励配置无效");
    const amount = boundedRandom(randomInt, drop.min, drop.max + 1);
    if (amount) base[drop.resource] = (base[drop.resource] ?? 0) + amount;
  }
  const durationSeconds = Math.max(
    20,
    Math.ceil(region.seconds * stats.speedMultiplier),
  );
  const returnSeconds = Math.max(
    8,
    Math.ceil(region.seconds * 0.3 * stats.speedMultiplier),
  );
  const rank = Object.keys(REGIONS).indexOf(regionId) + 1;
  const safe: ExplorationChoiceView = {
    id: "return",
    label: "安全返航",
    description: "带回已装船的货物，不再付出补给或承担额外损伤。",
    cost: {},
    coins: 0,
    successPercent: 100,
    riskDamage: 0,
    returnSeconds,
  };
  const successPercent =
    event.choice === "repair"
      ? 100
      : Math.min(
          95,
          Math.max(
            30,
            100 -
              region.riskPercent +
              stats.resistance +
              (event.choice === "rescue" ? 5 : 0),
          ),
        );
  const riskDamage =
    event.choice === "repair"
      ? 0
      : Math.max(
          1,
          Math.ceil(((region.baseWear + 8) * (100 - stats.resistance)) / 100),
        );
  const option: ExplorationChoiceView = {
    id: event.choice,
    label: event.label,
    description: event.choiceDescription,
    cost: { ...event.cost },
    coins: event.coins,
    successPercent,
    riskDamage,
    returnSeconds:
      returnSeconds +
      (event.choice === "venture" ? 6 : event.choice === "repair" ? 10 : 15),
  };
  const success =
    successPercent === 100 || boundedRandom(randomInt, 0, 100) < successPercent;
  const outcomes: VoyagePlan["outcomes"] = {
    return: {
      resources: fitCargo(base, stats.capacity),
      coins: 0,
      xp: 5 + rank * 3,
      damage: 0,
      success: true,
      narrative: `你选择沿安全航线离开${region.name}，已装船的货物随船返航。`,
    },
    [event.choice]: {
      resources: fitCargo(
        success ? merge(base, event.bonus) : base,
        stats.capacity,
      ),
      coins: 0,
      xp: 5 + rank * 3 + (success ? (event.choice === "rescue" ? 12 : 8) : 2),
      damage: success ? 0 : riskDamage,
      success,
      narrative: success ? event.successNarrative : event.failureNarrative,
    },
  };
  return {
    durationSeconds,
    snapshot: {
      version: 1,
      ship: { kind, level, ...stats },
      region: { id: regionId, ...region },
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        choices: [safe, option],
      },
    },
    outcomes,
  };
}
