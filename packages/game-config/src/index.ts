export const RESOURCE_IDS = [
  "wood",
  "plastic",
  "metal",
  "seaweed",
  "water",
  "fish",
  "plank",
  "parts",
  "seed",
  "alloy",
  "relic",
] as const;
export type Resource = (typeof RESOURCE_IDS)[number];
export type Bundle = Partial<Record<Resource, number>>;
export const RESOURCES: Record<
  Resource,
  { name: string; icon: string; color: string }
> = {
  wood: { name: "木材", icon: "🪵", color: "#bb8051" },
  plastic: { name: "塑料", icon: "🧴", color: "#65bec7" },
  metal: { name: "金属碎片", icon: "⚙️", color: "#94a8b8" },
  seaweed: { name: "海藻", icon: "🌿", color: "#74b775" },
  water: { name: "淡水", icon: "💧", color: "#62bdea" },
  fish: { name: "鲜鱼", icon: "🐟", color: "#edac79" },
  plank: { name: "木板", icon: "🪚", color: "#d49e68" },
  parts: { name: "金属零件", icon: "🔩", color: "#aab4c5" },
  seed: { name: "海岛种子", icon: "🌰", color: "#86a96d" },
  alloy: { name: "耐蚀合金", icon: "🔗", color: "#9aa9b5" },
  relic: { name: "航海遗物", icon: "🏺", color: "#c8a36a" },
};
export const BUILDING_IDS = [
  "warehouse",
  "purifier",
  "fishnet",
  "workshop",
  "recycler",
  "garden",
  "dock",
  "cabin",
] as const;
export type BuildingKind = (typeof BUILDING_IDS)[number];
export interface Recipe {
  input: Bundle;
  output: Bundle;
  seconds: number;
}
export interface BuildingConfig {
  name: string;
  description: string;
  icon: string;
  cost: Bundle;
  coins: number;
  unlock: number;
  prosperity: number;
  recipe?: Recipe;
}
export const BUILDINGS: Record<BuildingKind, BuildingConfig> = {
  warehouse: {
    name: "仓库",
    description: "给海上的小日子，多留一点空间。容量 +80。",
    icon: "📦",
    cost: { wood: 16, plastic: 8 },
    coins: 20,
    unlock: 1,
    prosperity: 8,
  },
  purifier: {
    name: "净水器",
    description: "把海水变成清甜的淡水。新生活的第一步。",
    icon: "💧",
    cost: { wood: 8, plastic: 4 },
    coins: 10,
    unlock: 1,
    prosperity: 10,
    recipe: { input: {}, output: { water: 3 }, seconds: 12 },
  },
  fishnet: {
    name: "捕鱼网",
    description: "随海浪起伏，收获今天的鲜鱼。",
    icon: "🐟",
    cost: { wood: 10, plastic: 6 },
    coins: 15,
    unlock: 1,
    prosperity: 12,
    recipe: { input: {}, output: { fish: 3 }, seconds: 24 },
  },
  workshop: {
    name: "木工坊",
    description: "一块块木板，搭起更大的梦想。",
    icon: "🪚",
    cost: { wood: 18, metal: 4 },
    coins: 35,
    unlock: 2,
    prosperity: 18,
    recipe: { input: { wood: 4 }, output: { plank: 2 }, seconds: 36 },
  },
  recycler: {
    name: "回收站",
    description: "让旧日残骸，成为新的可能。",
    icon: "♻️",
    cost: { plank: 8, plastic: 10 },
    coins: 50,
    unlock: 3,
    prosperity: 22,
    recipe: {
      input: { metal: 3, plastic: 2 },
      output: { parts: 2 },
      seconds: 48,
    },
  },
  garden: {
    name: "海上花园",
    description: "在海面上，种下一小片绿意。",
    icon: "🌱",
    cost: { plank: 4, plastic: 6 },
    coins: 30,
    unlock: 2,
    prosperity: 16,
    recipe: { input: { water: 2 }, output: { seaweed: 5 }, seconds: 30 },
  },
  dock: {
    name: "交易码头",
    description: "向远方的漂流者，打开一扇门。",
    icon: "⛵",
    cost: { wood: 12, plastic: 4 },
    coins: 20,
    unlock: 1,
    prosperity: 20,
  },
  cabin: {
    name: "居民小屋",
    description: "一盏暖灯，就是海上的家。",
    icon: "🏡",
    cost: { plank: 6, wood: 10 },
    coins: 35,
    unlock: 2,
    prosperity: 25,
  },
};
export const ECONOMY = {
  initial: { wood: 18, plastic: 12, metal: 4, seaweed: 2 } as Bundle,
  initialCoins: 100,
  baseCapacity: 80,
  warehouseCapacity: 80,
  floorCost: { wood: 4, plastic: 2 } as Bundle,
  salvageSeconds: 10,
  salvageLifetimeSeconds: 180,
  salvageLimit: 6,
  queueLimit: 3,
  autoQueueLimit: 30,
  marketFeePercent: 5,
  maxListingQuantity: 100,
  maxPrice: 10000,
  orderLifetimeSeconds: 1800,
  levelXp: [0, 40, 140, 320, 650, 1100, 1800],
  buildXp: 10,
};
export const SALVAGE = [
  { kind: "wood", reward: { wood: 4 } },
  { kind: "plastic", reward: { plastic: 3 } },
  { kind: "wood", reward: { wood: 3, seaweed: 1 } },
  { kind: "metal", reward: { metal: 2 } },
  { kind: "plastic", reward: { plastic: 2, seaweed: 2 } },
  { kind: "rare", reward: { wood: 5, metal: 3, plastic: 3 } },
] as const;
export const ORDERS = [
  {
    code: "first-water",
    name: "给远航的人一杯水",
    description: "灯塔守望者 · 入门委托",
    input: { water: 3, wood: 4 } as Bundle,
    coins: 35,
    xp: 30,
    level: 1,
  },
  {
    code: "fresh-catch",
    name: "今晚，吃点新鲜的",
    description: "海风食堂 · 日常补给",
    input: { fish: 3, seaweed: 2 } as Bundle,
    coins: 42,
    xp: 25,
    level: 1,
  },
  {
    code: "recycled-supplies",
    name: "旧物也有新旅程",
    description: "再生补给站 · 回收委托",
    input: { plastic: 6, metal: 3 } as Bundle,
    coins: 24,
    xp: 15,
    level: 1,
  },
  {
    code: "repair",
    name: "修补远航的船",
    description: "蓝鲸商队 · 建材委托",
    input: { plank: 6, water: 3 } as Bundle,
    coins: 90,
    xp: 50,
    level: 2,
  },
  {
    code: "green",
    name: "漂浮花园计划",
    description: "岛屿研究所 · 生态委托",
    input: { seaweed: 8, fish: 3 } as Bundle,
    coins: 70,
    xp: 40,
    level: 2,
  },
  {
    code: "island-seed-study",
    name: "让失落的绿意重生",
    description: "海岛种质站 · 研究委托",
    input: { seed: 3, water: 6 } as Bundle,
    coins: 90,
    xp: 45,
    level: 3,
  },
  {
    code: "alloy-corrosion-study",
    name: "抵挡盐与时间",
    description: "海上材料所 · 研究委托",
    input: { alloy: 2, metal: 2 } as Bundle,
    coins: 75,
    xp: 35,
    level: 2,
  },
  {
    code: "relic-navigation-study",
    name: "读懂旧航标的方向",
    description: "群岛档案馆 · 研究委托",
    input: { relic: 1, plank: 2, water: 4 } as Bundle,
    coins: 140,
    xp: 60,
    level: 5,
  },
];

export * from "./exploration";
