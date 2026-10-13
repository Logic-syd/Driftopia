import {
  BUILDINGS,
  ECONOMY,
  RESOURCE_IDS,
  type Bundle,
  type BuildingKind,
} from "../../game-config/src/index";
export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const count = (stock: Bundle) =>
  RESOURCE_IDS.reduce((total, id) => total + (stock[id] ?? 0), 0);
export const levelFor = (xp: number) =>
  Math.max(1, ECONOMY.levelXp.filter((value) => value <= xp).length);
export function transact(
  stock: Bundle,
  input: Bundle,
  output: Bundle,
  capacity: number,
): Bundle {
  const next = { ...stock };
  for (const resource of RESOURCE_IDS) {
    const debit = input[resource] ?? 0,
      credit = output[resource] ?? 0;
    if (![debit, credit].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new RuleError("INVALID_AMOUNT", "资源数量无效");
    if ((next[resource] ?? 0) < debit)
      throw new RuleError(
        "INSUFFICIENT_RESOURCES",
        "资源还不够，去海上打捞一些吧",
      );
    next[resource] = (next[resource] ?? 0) - debit + credit;
    if (next[resource]! < 0)
      throw new RuleError(
        "INSUFFICIENT_RESOURCES",
        "资源还不够，去海上打捞一些吧",
      );
  }
  if (count(next) > capacity)
    throw new RuleError("WAREHOUSE_FULL", "仓库满了，请先使用资源或扩建仓库");
  return next;
}
export function validatePlacement(
  tiles: { x: number; y: number }[],
  buildings: { id?: string; x: number; y: number }[],
  x: number,
  y: number,
  movingId?: string,
) {
  if (!tiles.some((t) => t.x === x && t.y === y))
    throw new RuleError("NO_TILE", "请把建筑放在木筏地板上");
  if (buildings.some((b) => b.id !== movingId && b.x === x && b.y === y))
    throw new RuleError("OCCUPIED", "这块地板已经有建筑了");
}
export function productionSeconds(
  kind: BuildingKind,
  level: number,
  seconds?: number,
) {
  return Math.max(
    3,
    Math.ceil(
      (seconds ?? BUILDINGS[kind].recipe!.seconds) / (1 + (level - 1) * 0.25),
    ),
  );
}
export function upgradeCost(kind: BuildingKind, level: number): Bundle {
  return Object.fromEntries(
    Object.entries(BUILDINGS[kind].cost).map(([k, n]) => [k, n * level]),
  );
}
export function tradeAmounts(quantity: number, unitPrice: number) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isSafeInteger(unitPrice) ||
    unitPrice < 1
  )
    throw new RuleError("INVALID_AMOUNT", "交易数量或价格无效");
  const total = quantity * unitPrice;
  if (!Number.isSafeInteger(total))
    throw new RuleError("INVALID_AMOUNT", "交易金额过大");
  const fee = Math.ceil((total * ECONOMY.marketFeePercent) / 100);
  return { total, fee, sellerReceives: total - fee };
}
