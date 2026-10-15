import type { Bundle, Resource } from "./index";

export const SHIP_IDS = ["skiff", "salvager", "sailboat"] as const;
export type ShipKind = (typeof SHIP_IDS)[number];
export const REGION_IDS = ["bay", "wrecks", "coral", "storm", "lost"] as const;
export type RegionId = (typeof REGION_IDS)[number];
export const CHOICE_IDS = ["return", "venture", "repair", "rescue"] as const;
export type ChoiceId = (typeof CHOICE_IDS)[number];
export interface ShipCost {
  cost: Bundle;
  coins: number;
}
export interface ShipConfig extends ShipCost {
  name: string;
  description: string;
  icon: string;
  color: string;
  unlockLevel: number;
  capacity: number;
  speed: number;
  resistance: number;
  durability: number;
  upgrades: Record<2 | 3, ShipCost>;
  repairPer20: ShipCost;
}
export interface RegionConfig {
  name: string;
  description: string;
  icon: string;
  color: string;
  x: number;
  y: number;
  unlockLevel: number;
  requires: { regionId: RegionId; voyages: number } | null;
  minShipLevel: number;
  recommendedShipLevel: number;
  supplies: Bundle;
  coins: number;
  baseWear: number;
  riskPercent: number;
  seconds: number;
  loot: { resource: Resource; min: number; max: number }[];
  eventIds: string[];
}
export interface ExplorationEventConfig {
  id: string;
  regionId: RegionId;
  title: string;
  description: string;
  choice: Exclude<ChoiceId, "return">;
  label: string;
  choiceDescription: string;
  cost: Bundle;
  coins: number;
  bonus: Bundle;
  successNarrative: string;
  failureNarrative: string;
}

export const SHIPS: Record<ShipKind, ShipConfig> = {
  skiff: {
    name: "木制小艇",
    description: "轻巧的近海小艇。补给少、易修理，也能升级后挑战远海。",
    icon: "🛶",
    color: "#d39a60",
    cost: { wood: 10, plastic: 4 },
    coins: 25,
    unlockLevel: 1,
    capacity: 18,
    speed: 1,
    resistance: 8,
    durability: 100,
    upgrades: {
      2: { cost: { wood: 10, metal: 3 }, coins: 35 },
      3: { cost: { plank: 6, parts: 3 }, coins: 80 },
    },
    repairPer20: { cost: { wood: 2, plastic: 1 }, coins: 2 },
  },
  salvager: {
    name: "回收船",
    description: "宽阔货舱与加固船身适合回收沉船材料，航速稍慢。",
    icon: "🚢",
    color: "#7d9eaa",
    cost: { plank: 10, parts: 6, alloy: 2 },
    coins: 120,
    unlockLevel: 3,
    capacity: 34,
    speed: 0.9,
    resistance: 24,
    durability: 100,
    upgrades: {
      2: { cost: { plank: 8, parts: 4, alloy: 2 }, coins: 100 },
      3: { cost: { plank: 12, parts: 6, alloy: 4 }, coins: 180 },
    },
    repairPer20: { cost: { plank: 1, parts: 1 }, coins: 5 },
  },
  sailboat: {
    name: "探索帆船",
    description: "凭借轻质骨架快速往返远海，货舱与抗风浪能力均衡。",
    icon: "⛵",
    color: "#bda16f",
    cost: { plank: 16, parts: 8, alloy: 4 },
    coins: 180,
    unlockLevel: 4,
    capacity: 26,
    speed: 1.2,
    resistance: 16,
    durability: 100,
    upgrades: {
      2: { cost: { plank: 10, parts: 4, alloy: 2 }, coins: 140 },
      3: { cost: { plank: 14, parts: 8, alloy: 6 }, coins: 240 },
    },
    repairPer20: { cost: { wood: 2, plank: 1 }, coins: 4 },
  },
};

export const REGIONS: Record<RegionId, RegionConfig> = {
  bay: {
    name: "宁静海湾",
    description: "拾光浅湾的平缓潮线围着故乡，旧浮标藏着第一份远航收获。",
    icon: "🌤️",
    color: "#72bdb6",
    x: 18,
    y: 73,
    unlockLevel: 1,
    requires: null,
    minShipLevel: 1,
    recommendedShipLevel: 1,
    supplies: { water: 1 },
    coins: 2,
    baseWear: 3,
    riskPercent: 12,
    seconds: 30,
    loot: [
      { resource: "wood", min: 3, max: 5 },
      { resource: "plastic", min: 2, max: 3 },
      { resource: "metal", min: 0, max: 1 },
    ],
    eventIds: ["tide-lantern", "quiet-buoy", "stranded-oarsman"],
  },
  wrecks: {
    name: "漂流残骸区",
    description: "睡鲸湾的旧船壳露出海面，锈迹之间仍有可用的合金。",
    icon: "⚓",
    color: "#7fa0b5",
    x: 35,
    y: 52,
    unlockLevel: 2,
    requires: { regionId: "bay", voyages: 2 },
    minShipLevel: 1,
    recommendedShipLevel: 2,
    supplies: { water: 2, fish: 1 },
    coins: 4,
    baseWear: 6,
    riskPercent: 24,
    seconds: 60,
    loot: [
      { resource: "metal", min: 2, max: 4 },
      { resource: "plastic", min: 1, max: 3 },
      { resource: "alloy", min: 1, max: 1 },
    ],
    eventIds: ["whale-rib-hold", "silent-dock-light", "capsized-surveyor"],
  },
  coral: {
    name: "珊瑚群岛",
    description: "星壳礁环拦住海流，废弃苗圃和鲜活种子在其间漂浮。",
    icon: "🪸",
    color: "#c78f9e",
    x: 57,
    y: 68,
    unlockLevel: 3,
    requires: { regionId: "wrecks", voyages: 2 },
    minShipLevel: 2,
    recommendedShipLevel: 2,
    supplies: { water: 3, fish: 2 },
    coins: 6,
    baseWear: 8,
    riskPercent: 32,
    seconds: 90,
    loot: [
      { resource: "seaweed", min: 3, max: 5 },
      { resource: "fish", min: 1, max: 3 },
      { resource: "seed", min: 1, max: 2 },
    ],
    eventIds: ["blue-algae-nursery", "cracked-reef-marker", "reef-botanist"],
  },
  storm: {
    name: "风暴海域",
    description: "风琴浪带敲响空心浮筒，等待风隙才能带回深海材料。",
    icon: "🌩️",
    color: "#898eaf",
    x: 68,
    y: 34,
    unlockLevel: 4,
    requires: { regionId: "coral", voyages: 2 },
    minShipLevel: 2,
    recommendedShipLevel: 3,
    supplies: { water: 4, fish: 3 },
    coins: 10,
    baseWear: 13,
    riskPercent: 46,
    seconds: 150,
    loot: [
      { resource: "plank", min: 2, max: 4 },
      { resource: "parts", min: 1, max: 3 },
      { resource: "alloy", min: 1, max: 2 },
      { resource: "wood", min: 2, max: 4 },
    ],
    eventIds: ["storm-organ", "broken-wave-gate", "weatherwatch-escort"],
  },
  lost: {
    name: "失落航道",
    description: "雾灯旧港的灯影指向深处，封存遗物等待新的研究者。",
    icon: "🗿",
    color: "#b6a369",
    x: 85,
    y: 16,
    unlockLevel: 5,
    requires: { regionId: "storm", voyages: 3 },
    minShipLevel: 3,
    recommendedShipLevel: 3,
    supplies: { water: 5, fish: 4 },
    coins: 14,
    baseWear: 18,
    riskPercent: 58,
    seconds: 210,
    loot: [
      { resource: "plank", min: 2, max: 4 },
      { resource: "parts", min: 2, max: 3 },
      { resource: "alloy", min: 1, max: 2 },
      { resource: "relic", min: 1, max: 1 },
    ],
    eventIds: ["echo-archive", "last-lighthouse", "fogbound-cartographer"],
  },
};

export const EXPLORATION_EVENTS: Record<string, ExplorationEventConfig> = {
  "tide-lantern": {
    id: "tide-lantern",
    regionId: "bay",
    title: "漂灯下的木箱",
    description:
      "熄灭的浮灯拖着半沉木箱。靠近回收可能多带回材料，也可能撞上水下木桩。",
    choice: "venture",
    label: "靠近回收",
    choiceDescription: "冒险检查浮灯下的木箱；失败仍带回已有货物。",
    cost: {},
    coins: 0,
    bonus: { wood: 3, metal: 1 },
    successNarrative: "你绕开木桩，取回浮灯底座和一只完好的金属扣。",
    failureNarrative: "木箱滑入深水。船身轻擦木桩，你带着已有货物返航。",
  },
  "quiet-buoy": {
    id: "quiet-buoy",
    regionId: "bay",
    title: "失声的引潮浮标",
    description:
      "浮标的支架松脱，备用材料箱还挂在一旁。修好它，下一位漂流者就能识别浅滩。",
    choice: "repair",
    label: "修复浮标",
    choiceDescription: "使用材料修好航标，收取旁边标记可回收的备用件。",
    cost: { wood: 2, plastic: 1 },
    coins: 0,
    bonus: { metal: 2, plastic: 3 },
    successNarrative:
      "浮标重新立起。你回收了弃置的备用件，安全航线也更清晰了。",
    failureNarrative: "你保留修复记录，沿原航线带回已有货物。",
  },
  "stranded-oarsman": {
    id: "stranded-oarsman",
    regionId: "bay",
    title: "沙脊上的划桨人",
    description:
      "一位船员的小艇卡在退潮沙脊上。他需要淡水，并希望有人陪他划到安全浮台。",
    choice: "rescue",
    label: "护送到安全浮台",
    choiceDescription: "提供补给，护送船员划向附近的安全浮台。",
    cost: { water: 1 },
    coins: 0,
    bonus: { wood: 2, fish: 2 },
    successNarrative:
      "船员已抵达安全浮台，并送你几条鱼和备用木料。救援写入了航海日志。",
    failureNarrative:
      "横流阻断了靠近路线。你留下补给与方向标记后返航，日志记录了未完成的护送。",
  },
  "whale-rib-hold": {
    id: "whale-rib-hold",
    regionId: "wrecks",
    title: "睡鲸的肋骨舱",
    description: "废船侧舱露出一线合金光泽，涨潮前还有机会靠近。",
    choice: "venture",
    label: "进入侧舱打捞",
    choiceDescription: "尝试回收更深处的合金与零件。",
    cost: {},
    coins: 0,
    bonus: { alloy: 1, parts: 2 },
    successNarrative: "侧舱里的封箱保存完好，你找到合金板与可用零件。",
    failureNarrative: "旧舱架突然移位。你及时退出，但船舷多了几道划痕。",
  },
  "silent-dock-light": {
    id: "silent-dock-light",
    regionId: "wrecks",
    title: "旧港的哑灯",
    description: "无人栈桥上的反光灯支架断了，维修架旁留着一卷合金补片。",
    choice: "repair",
    label: "重新固定反光灯",
    choiceDescription: "修复这处航线标记，回收多余补片。",
    cost: { wood: 2, metal: 1 },
    coins: 0,
    bonus: { alloy: 1, metal: 2 },
    successNarrative:
      "反光灯再次朝向航道。多余补片装入货舱，维修过程记入日志。",
    failureNarrative: "你记录了损坏位置，带着已有货物返航。",
  },
  "capsized-surveyor": {
    id: "capsized-surveyor",
    regionId: "wrecks",
    title: "翻舟的测深员",
    description: "测深员抱着防水包等待帮助，需要有人把他送到附近的检修平台。",
    choice: "rescue",
    label: "护送测深员",
    choiceDescription: "消耗食物和淡水，尝试沿碎船间隙护送到安全点。",
    cost: { water: 1, fish: 1 },
    coins: 0,
    bonus: { parts: 2, alloy: 1 },
    successNarrative:
      "测深员安全抵达检修平台，将备用零件交给你致谢，挥手目送你的船离开。",
    failureNarrative:
      "漂流船板挡住通道。你送出补给、留下安全方向后撤回，船身受到擦损。",
  },
  "blue-algae-nursery": {
    id: "blue-algae-nursery",
    regionId: "coral",
    title: "夜蓝藻环中的苗圃",
    description: "发光藻环围着废弃育苗篮，活种子可能仍封存在干燥内盒。",
    choice: "venture",
    label: "靠近育苗篮",
    choiceDescription: "尝试取出更多种子，避免触碰礁石。",
    cost: {},
    coins: 0,
    bonus: { seed: 2, seaweed: 3 },
    successNarrative: "干燥内盒里有保存良好的种子，你轻轻带走脱落的海藻。",
    failureNarrative:
      "涌浪盖过育苗篮。你选择退开，保住已有货物，船底留下擦痕。",
  },
  "cracked-reef-marker": {
    id: "cracked-reef-marker",
    regionId: "coral",
    title: "裂开的星壳路标",
    description: "一处人工礁标被浪冲歪，旁边封着研究站遗留的种子交换盒。",
    choice: "repair",
    label: "扶正礁标",
    choiceDescription: "用材料修复人工路标，带走交换盒中的种子。",
    cost: { plank: 1, plastic: 2 },
    coins: 0,
    bonus: { seed: 2, water: 2 },
    successNarrative: "路标重新对齐潮线。你得到研究站留下的种子和密封淡水。",
    failureNarrative: "你记录了倾斜的路标，沿安全航道返回。",
  },
  "reef-botanist": {
    id: "reef-botanist",
    regionId: "coral",
    title: "被潮水困住的植物学者",
    description: "采样船失去了桨，植物学者需要补给与护送，才能回到外侧浮台。",
    choice: "rescue",
    label: "护送采样船",
    choiceDescription: "提供补给，协助采样船抵达外侧的安全浮台。",
    cost: { water: 2, fish: 1 },
    coins: 0,
    bonus: { seed: 2, fish: 3 },
    successNarrative:
      "采样船已抵达浮台。学者分享了备用种子，救援经过留在日志中。",
    failureNarrative:
      "急流阻止了拖带。你转交补给并标记采样船位置，带着已有货物返航。",
  },
  "storm-organ": {
    id: "storm-organ",
    regionId: "storm",
    title: "敲响风浪的空心浮筒",
    description: "风从废弃浮筒穿过，发出低沉和声。内部检修仓可能藏着抗锈部件。",
    choice: "venture",
    label: "趁风隙检修仓打捞",
    choiceDescription: "冒险换取更多加工材料，失败也不丢失出发时的船。",
    cost: {},
    coins: 0,
    bonus: { alloy: 2, parts: 3 },
    successNarrative: "你赶在下一阵风前取回抗锈部件，浮筒的和声渐渐远去。",
    failureNarrative:
      "风隙提前结束。你脱离浮筒，船舷被浪撞伤，但已有货物仍在。",
  },
  "broken-wave-gate": {
    id: "broken-wave-gate",
    regionId: "storm",
    title: "断裂的避浪门",
    description:
      "一座无人修理浮台的挡浪门脱落，重固定它就能打开旁边的备用材料柜。",
    choice: "repair",
    label: "加固挡浪门",
    choiceDescription: "消耗木板和零件，完成一次安全的设施修复。",
    cost: { plank: 2, parts: 1 },
    coins: 0,
    bonus: { alloy: 2, plank: 3 },
    successNarrative:
      "挡浪门重新锁住。你回收了柜中的旧备用料，并记下修复位置。",
    failureNarrative: "你记录了断裂的挡浪门后返航。",
  },
  "weatherwatch-escort": {
    id: "weatherwatch-escort",
    regionId: "storm",
    title: "守风人的求助旗",
    description: "风向记录员的小船难以越过浪带，他想抵达背风面的观测浮台。",
    choice: "rescue",
    label: "护送到背风浮台",
    choiceDescription: "付出补给，尝试与受困小船一同穿过风隙。",
    cost: { water: 2, fish: 2 },
    coins: 0,
    bonus: { parts: 3, alloy: 1 },
    successNarrative:
      "两艘船都抵达背风浮台。记录员赠送备用器件，护送记入航海日志。",
    failureNarrative:
      "风隙不足以拖带小船。你留下补给与风向标记后返回，船体受到浪击。",
  },
  "echo-archive": {
    id: "echo-archive",
    regionId: "lost",
    title: "回声里的潮汐档案",
    description: "空心旧仓回响着海浪，密封匣里似乎保存着失落群岛的记录。",
    choice: "venture",
    label: "进入旧仓寻匣",
    choiceDescription: "冒险进入摇晃的旧仓，寻找封存的航海遗物。",
    cost: {},
    coins: 0,
    bonus: { relic: 1, alloy: 2, parts: 2 },
    successNarrative:
      "密封匣中保存着旧航标和合金工具。研究所需要这样的材料来还原旧航道。",
    failureNarrative:
      "旧仓开始摇晃。你立刻退回，已有遗物安全留在货舱，船身受到擦伤。",
  },
  "last-lighthouse": {
    id: "last-lighthouse",
    regionId: "lost",
    title: "最后一座反光灯塔",
    description:
      "灯塔早已无人值守，反光板仍可修复。检修台上留着一枚标记过的旧航标。",
    choice: "repair",
    label: "修复灯塔反光板",
    choiceDescription: "修复旧导航设施，回收检修台上的研究遗物。",
    cost: { plank: 2, parts: 2 },
    coins: 0,
    bonus: { relic: 1, alloy: 2 },
    successNarrative: "反光板重新转向海面。旧航标装入货舱，修复记录随船带回。",
    failureNarrative: "你记录下反光板的位置，带回已经找到的遗物。",
  },
  "fogbound-cartographer": {
    id: "fogbound-cartographer",
    regionId: "lost",
    title: "浓雾中的制图人",
    description:
      "制图人的船失去了参照物。他愿分享旧档案，希望有人护送到雾外安全航标。",
    choice: "rescue",
    label: "护送制图人离雾",
    choiceDescription: "消耗补给，护送制图人的小船抵达雾外安全航标。",
    cost: { water: 3, fish: 2 },
    coins: 0,
    bonus: { relic: 1, plank: 3 },
    successNarrative:
      "制图人已找到安全航标，交给你一份封存旧档案。此次护送完成并写入日志。",
    failureNarrative:
      "雾流迫使两船暂停靠近。你留下补给和方向标记，船体轻损后返航。",
  },
};
