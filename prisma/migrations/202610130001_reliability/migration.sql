-- Additive reliability upgrade; historical balances, jobs and trades are retained.
ALTER TABLE "User" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "guestExpiresAt" TIMESTAMP(3);
CREATE INDEX "User_isGuest_createdAt_idx" ON "User"("isGuest", "createdAt");
ALTER TABLE "IdempotencyRecord" ALTER COLUMN result DROP NOT NULL;
ALTER TABLE "IdempotencyRecord" ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (now() + interval '7 days');
UPDATE "IdempotencyRecord" SET "expiresAt" = "createdAt" + interval '7 days';
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");
CREATE INDEX "MarketListing_status_createdAt_idx" ON "MarketListing"(status, "createdAt");
CREATE INDEX "MarketListing_sellerId_status_idx" ON "MarketListing"("sellerId", status);
CREATE INDEX "GameEvent_userId_type_createdAt_id_idx" ON "GameEvent"("userId", type, "createdAt", id);
CREATE INDEX "Friendship_friendId_idx" ON "Friendship"("friendId");
