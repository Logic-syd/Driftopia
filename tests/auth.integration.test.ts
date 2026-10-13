import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { db } from "../apps/api/src/database";
import { gameAction, state, redis } from "../apps/api/src/game";
import { maintainData } from "../apps/api/src/maintenance";
import { legacyFingerprint } from "../apps/api/src/idempotency";
const base = process.env.TEST_API_URL ?? "http://127.0.0.1:3001/api";
const ids: string[] = [];
beforeAll(async () => {
  await db.$connect();
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
  redis.disconnect();
});
async function account() {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `auth-${randomUUID()}@example.test`,
      name: "认证验收员",
      password: "LongEnoughTest2026",
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  ids.push(body.id);
  return {
    id: body.id as string,
    cookie: res.headers.get("set-cookie")!.split(";")[0],
  };
}
it("creates a bounded persistent guest, resumes its session, and rejects expired guests", async () => {
  const options = await (await fetch(`${base}/auth/options`)).json();
  expect(options.guestEnabled).toBe(true);
  const response = await fetch(`${base}/auth/guest`, { method: "POST" });
  expect(response.status).toBe(201);
  const body = await response.json();
  ids.push(body.id);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  const snapshot = await (
    await fetch(`${base}/state`, { headers: { cookie } })
  ).json();
  expect(snapshot.id).toBe(body.id);
  expect(snapshot.isGuest).toBe(true);
  expect(snapshot.tiles).toHaveLength(9);
  expect(snapshot.coins).toBe(100);
  expect(Date.parse(snapshot.guestExpiresAt)).toBeGreaterThan(Date.now());
  const resumed = await (
    await fetch(`${base}/auth/guest`, { method: "POST", headers: { cookie } })
  ).json();
  expect(resumed.id).toBe(body.id);
  const move = await fetch(`${base}/game/build`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ kind: "purifier", x: 0, y: 0, coins: 99999 }),
  });
  expect(move.status).toBe(201);
  expect((await state(body.id)).coins).toBe(90);
  await db.user.update({
    where: { id: body.id },
    data: { guestExpiresAt: new Date(Date.now() - 1000) },
  });
  expect((await fetch(`${base}/state`, { headers: { cookie } })).status).toBe(
    401,
  );
  expect(
    (
      await db.island.findUniqueOrThrow({
        where: { userId: body.id },
        include: { buildings: true },
      })
    ).buildings,
  ).toHaveLength(1);
});
it("compacts expired response payloads while retaining tombstones that reject late replay", async () => {
  const p = await account(),
    key = randomUUID(),
    body = { resource: "wood", quantity: 1 };
  await gameAction(p.id, key, "discard", body);
  await db.idempotencyRecord.update({
    where: { userId_key: { userId: p.id, key } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const before = (await state(p.id)).inventory.wood;
  expect((await maintainData(false)).expiredReceipts).toBeGreaterThanOrEqual(1);
  await maintainData(true);
  const tombstone = await db.idempotencyRecord.findUniqueOrThrow({
    where: { userId_key: { userId: p.id, key } },
  });
  expect(tombstone.result).toBeNull();
  expect(tombstone.requestHash).toHaveLength(64);
  await expect(gameAction(p.id, key, "discard", body)).rejects.toMatchObject({
    code: "IDEMPOTENCY_EXPIRED",
  });
  expect((await state(p.id)).inventory.wood).toBe(before);
  await expect(
    gameAction(p.id, key, "discard", { resource: "wood", quantity: 2 }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
it("retains exact-request replay compatibility with pre-upgrade v0.2 fingerprints", async () => {
  const p = await account(),
    key = randomUUID(),
    body = { resource: "wood", quantity: 1 };
  await gameAction(p.id, key, "discard", body);
  await db.idempotencyRecord.update({
    where: { userId_key: { userId: p.id, key } },
    data: { requestHash: legacyFingerprint("discard", body) },
  });
  const before = (await state(p.id)).inventory.wood;
  await gameAction(p.id, key, "discard", body);
  expect((await state(p.id)).inventory.wood).toBe(before);
});
it("expires stored sessions without deleting any player assets", async () => {
  const p = await account();
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      userId: p.id,
      tokenHash: token,
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  await maintainData(true);
  expect(
    await db.session.findUnique({ where: { tokenHash: token } }),
  ).toBeNull();
  expect((await state(p.id)).coins).toBe(100);
});
