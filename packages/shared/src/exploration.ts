import type { Bundle } from "../../game-config/src/index";

export type ShipKind = "skiff" | "salvager" | "sailboat";
export type RegionId = "bay" | "wrecks" | "coral" | "storm" | "lost";
export type ChoiceId = "return" | "venture" | "repair" | "rescue";
export type VoyagePhase =
  "sailing" | "choice" | "returning" | "ready" | "claimed";
export interface ShipStatsView {
  capacity: number;
  maxDurability: number;
  speedMultiplier: number;
  resistance: number;
}
export interface ExplorationChoiceView {
  id: ChoiceId;
  label: string;
  description: string;
  cost: Bundle;
  coins: number;
  successPercent: number;
  riskDamage: number;
  returnSeconds: number;
}
export interface ExplorationEventView {
  id: string;
  title: string;
  description: string;
  choices: ExplorationChoiceView[];
}
export interface VoyageResultView {
  resources: Bundle;
  coins: number;
  xp: number;
  damage: number;
  success: boolean;
  narrative: string;
}
export interface VoyageView {
  id: string;
  shipId: string;
  shipKind: ShipKind;
  regionId: RegionId;
  regionName: string;
  phase: VoyagePhase;
  departedAt: string;
  arrivesAt: string;
  returnsAt: string | null;
  claimedAt: string | null;
  choiceId: ChoiceId | null;
  event: ExplorationEventView | null;
  result: VoyageResultView | null;
}
export interface ExplorationState {
  serverTime: string;
  hasDock: boolean;
  fleetLimit: number;
  shipyard: {
    kind: ShipKind;
    name: string;
    description: string;
    icon: string;
    unlockLevel: number;
    cost: Bundle;
    coins: number;
    owned: boolean;
    stats: ShipStatsView;
  }[];
  ships: {
    id: string;
    kind: ShipKind;
    name: string;
    level: number;
    durability: number;
    stats: ShipStatsView;
    activeVoyageId: string | null;
    upgrade: { cost: Bundle; coins: number } | null;
    repair: { cost: Bundle; coins: number } | null;
  }[];
  regions: {
    id: RegionId;
    name: string;
    description: string;
    color: string;
    x: number;
    y: number;
    unlockLevel: number;
    unlocked: boolean;
    lockReason: string | null;
    minShipLevel: number;
    recommendedShipLevel: number;
    seconds: number;
    riskPercent: number;
    baseWear: number;
    supplies: Bundle;
    coins: number;
    loot: { resource: keyof Bundle; min: number; max: number }[];
    completed: number;
    requires: { regionId: RegionId; voyages: number } | null;
  }[];
  voyages: VoyageView[];
  history: VoyageView[];
  progress: { claimed: number; regions: Record<RegionId, number> };
}
