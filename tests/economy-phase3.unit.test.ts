import { describe, expect, it } from "vitest";
import { PERSONAS, seededRandom, simulate } from "../scripts/economy-phase3";

describe("Phase 3A economy strategy model", () => {
  it("replays a seed exactly without leaking future RNG into decisions", () => {
    expect(simulate(PERSONAS[0], 17, 1800)).toEqual(
      simulate(PERSONAS[0], 17, 1800),
    );
    const random = seededRandom(17);
    for (let i = 0; i < 100; i++) {
      const result = random(2, 5);
      expect(Number.isInteger(result) && result >= 2 && result < 5).toBe(true);
    }
  });

  it("does not collect or refill an offline account between 30 minutes and two hours", () => {
    const run = simulate(PERSONAS[0], 20261015, 7200);
    const [first, second] = run.snapshots;
    expect(first.activeMinutes).toBe(10);
    expect(second.activeMinutes).toBe(10);
    expect(second.actions).toBe(first.actions);
    expect(second.stock).toEqual(first.stock);
    expect(second.ledger).toEqual(first.ledger);
    expect(second.coins).toBe(first.coins);
    expect(first.limits.maximumQueue).toBe(30);
    expect(first.buildings.every((building) => building.queued <= 30)).toBe(
      true,
    );
  });

  it("keeps real session budgets, finite storage and source/sink conservation for seven days", () => {
    for (const persona of PERSONAS) {
      const last = simulate(persona, 20261015).snapshots.at(-1)!;
      expect(last.activeMinutes).toBe(persona.minutesPerDay * 7);
      expect(last.actions).toBeLessThanOrEqual(persona.minutesPerDay * 7 * 12);
      expect(last.capacity).toBeLessThanOrEqual(320);
      expect(last.stored).toBeLessThanOrEqual(last.capacity);
      expect(last.ships.length).toBeLessThanOrEqual(3);
      expect(last.coins).toBe(
        100 +
          Object.values(last.ledger).reduce(
            (total, entry) => total + entry.coinsIn - entry.coinsOut,
            0,
          ),
      );
      expect(last.ledger.explorationReward.coinsIn).toBe(0);
      expect(last.ledger.shipRepair.coinsOut).toBeGreaterThan(0);
    }
  });
});
