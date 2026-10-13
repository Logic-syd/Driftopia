import { expect, test } from "@playwright/test";
import { createSyncGate, type SyncNotice } from "../../apps/web/src/realtime";
const notice = (
  sequence: number,
  topics: SyncNotice["topics"] = ["state"],
  epoch = "a",
): SyncNotice => ({
  eventId: `${epoch}-${sequence}`,
  epoch,
  sequence,
  topics,
  emittedAt: new Date().toISOString(),
});

test("duplicate and reordered socket notifications cannot regress state", () => {
  const gate = createSyncGate();
  gate.ready({ epoch: "a", sequence: 4 });
  expect(gate.accept(notice(6, ["market"]))).toEqual(["market"]);
  expect(gate.accept(notice(6, ["market"]))).toEqual([]);
  expect(gate.accept(notice(5))).toEqual([]);
  expect(gate.accept({ ...notice(7), eventId: "a-6" })).toEqual([]);
  expect(gate.accept(notice(8, ["friends"]))).toEqual(["friends"]);
});

test("server restart and reconnect recover from authoritative full state", () => {
  const gate = createSyncGate();
  gate.ready({ epoch: "a", sequence: 999 });
  expect(gate.accept(notice(1, ["market"], "b"))).toEqual([
    "state",
    "market",
    "friends",
    "leaderboard",
  ]);
  gate.ready({ epoch: "b", sequence: 4 });
  expect(gate.accept(notice(3, ["state"], "b"))).toEqual([]);
  expect(gate.accept(notice(5, ["state"], "b"))).toEqual(["state"]);
});
