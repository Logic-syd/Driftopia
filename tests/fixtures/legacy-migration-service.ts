// Run in its own process so Prisma never shares the main integration database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../../apps/api/src/database";
import { buyListing, gameAction, redis, state } from "../../apps/api/src/game";

async function verify() {
  const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  assert.match(name, /^driftopia_migration_[a-f0-9]{32}$/);
  const fixture = JSON.parse(process.env.LEGACY_FIXTURE!) as {
    owner: string;
    buyer: string;
    purifier: string;
    job: string;
    activeOrder: string;
    activeListing: string;
    oldTrade: string;
    oldReceipt: string;
  };
  const before = await state(fixture.owner);
  assert.equal(before.name, "Legacy sailor");
  assert.equal(before.inventory.water, 2);
  assert.equal(
    before.buildings.find((building) => building.id === fixture.purifier)?.jobs
      .length,
    1,
  );
  assert.equal(await db.ship.count(), 0);
  assert.equal(await db.expedition.count(), 0);
  await gameAction(fixture.owner, randomUUID(), "collect", {
    buildingId: fixture.purifier,
  });
  assert.equal(
    (await db.productionJob.findUniqueOrThrow({ where: { id: fixture.job } }))
      .status,
    "COLLECTED",
  );
  assert.equal((await state(fixture.owner)).inventory.water, 5);
  await gameAction(fixture.owner, randomUUID(), "order", {
    orderId: fixture.activeOrder,
  });
  const ownerAfterOrder = await db.playerProgress.findUniqueOrThrow({
    where: { userId: fixture.owner },
  });
  assert.equal(ownerAfterOrder.coins, 342);
  assert.equal(ownerAfterOrder.xp, 85);
  const key = randomUUID();
  const bought = await buyListing(fixture.buyer, key, fixture.activeListing, {
    quantity: 2,
  });
  const replay = await buyListing(fixture.buyer, key, fixture.activeListing, {
    quantity: 2,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(bought)), replay);
  const buyer = await state(fixture.buyer);
  assert.equal(buyer.coins, 192);
  assert.equal(buyer.inventory.wood, 20);
  assert.equal(
    (
      await db.playerProgress.findUniqueOrThrow({
        where: { userId: fixture.owner },
      })
    ).coins,
    349,
  );
  assert.equal(
    await db.marketTransaction.count({
      where: { listingId: fixture.activeListing },
    }),
    1,
  );
  assert.equal(
    (
      await db.marketTransaction.findUniqueOrThrow({
        where: { id: fixture.oldTrade },
      })
    ).total,
    14,
  );
  assert.deepEqual(
    (
      await db.idempotencyRecord.findUniqueOrThrow({
        where: {
          userId_key: { userId: fixture.owner, key: fixture.oldReceipt },
        },
      })
    ).result,
    {
      message: "Historical receipt",
      tradeId: fixture.oldTrade,
    },
  );
  console.log(
    JSON.stringify({
      legacyServiceChecks: "passed",
      coins: { owner: 349, buyer: 192 },
      oldProduction: "COLLECTED",
      newTradeCount: 1,
    }),
  );
}

verify()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.disconnect();
    await db.$disconnect();
  });
