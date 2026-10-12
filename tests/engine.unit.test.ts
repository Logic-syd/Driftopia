import { describe, expect, it } from "vitest";
import {
  levelFor,
  productionSeconds,
  transact,
  tradeAmounts,
  validatePlacement,
} from "../packages/game-engine/src/index";
describe("server-independent economic invariants", () => {
  it("cannot make a resource negative", () =>
    expect(() => transact({ wood: 2 }, { wood: 3 }, {}, 80)).toThrow(
      "资源还不够",
    ));
  it("rejects invalid quantities and over-capacity output", () => {
    expect(() => transact({}, {}, { water: -1 }, 80)).toThrow();
    expect(() => transact({ wood: 79 }, {}, { fish: 2 }, 80)).toThrow(
      "仓库满了",
    );
  });
  it("atomically consumes inputs and creates output", () =>
    expect(transact({ wood: 6 }, { wood: 4 }, { plank: 2 }, 80)).toMatchObject({
      wood: 2,
      plank: 2,
    }));
  it("disallows overlapping buildings and missing floors", () => {
    expect(() =>
      validatePlacement([{ x: 0, y: 0 }], [{ id: "a", x: 0, y: 0 }], 0, 0),
    ).toThrow("已经有建筑");
    expect(() => validatePlacement([], [], 0, 0)).toThrow("地板");
  });
  it("allows keeping the same position during a move", () =>
    expect(() =>
      validatePlacement([{ x: 0, y: 0 }], [{ id: "a", x: 0, y: 0 }], 0, 0, "a"),
    ).not.toThrow());
  it("uses integer fees and rejects invalid trades", () => {
    expect(tradeAmounts(3, 7)).toEqual({
      total: 21,
      fee: 2,
      sellerReceives: 19,
    });
    expect(() => tradeAmounts(0, 2)).toThrow();
  });
  it("levels and upgrades follow configuration", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(40)).toBe(2);
    expect(productionSeconds("purifier", 1)).toBe(12);
    expect(productionSeconds("purifier", 3)).toBe(8);
  });
});
