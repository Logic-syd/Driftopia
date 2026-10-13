import { Prisma } from "@prisma/client";
import { db } from "./database";
// Keep the key/hash tombstone forever: deleting a key would allow a late retry
// to execute the same economic intent again. Only the bulky response is pruned.
export async function maintainData(apply = false, batchSize = 1000) {
  const now = new Date();
  const expiredSessions = await db.session.count({
    where: { expiresAt: { lte: now } },
  });
  const expiredReceipts = await db.idempotencyRecord.count({
    where: {
      expiresAt: { lte: now },
      NOT: { result: { equals: Prisma.DbNull } },
    },
  });
  if (!apply) return { apply, expiredSessions, expiredReceipts };
  return db.$transaction(async (tx) => {
    const sessions =
      await tx.$executeRaw`WITH expired AS (SELECT "tokenHash" FROM "Session" WHERE "expiresAt" <= ${now} LIMIT ${batchSize} FOR UPDATE SKIP LOCKED) DELETE FROM "Session" s USING expired e WHERE s."tokenHash"=e."tokenHash"`;
    const receipts =
      await tx.$executeRaw`WITH expired AS (SELECT "userId",key FROM "IdempotencyRecord" WHERE "expiresAt" <= ${now} AND result IS NOT NULL LIMIT ${batchSize} FOR UPDATE SKIP LOCKED) UPDATE "IdempotencyRecord" r SET result=NULL FROM expired e WHERE r."userId"=e."userId" AND r.key=e.key`;
    return {
      apply,
      expiredSessions,
      expiredReceipts,
      deletedSessions: sessions,
      compactedReceipts: receipts,
    };
  });
}
