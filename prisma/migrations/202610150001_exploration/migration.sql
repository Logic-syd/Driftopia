-- Additive Phase 3A upgrade: preserve every existing save, receipt and audit row.
-- Keep the existing Inventory CHECK attached to the same function object; extend
-- only its resource whitelist. Negative, fractional and unknown values still fail.
CREATE OR REPLACE FUNCTION driftopia_valid_inventory(resources jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(resources) = 'object' AND NOT EXISTS (
   SELECT 1 FROM jsonb_each(resources)
   WHERE key NOT IN ('wood','plastic','metal','seaweed','water','fish','plank','parts','seed','alloy','relic')
      OR jsonb_typeof(value) <> 'number'
      OR value::text !~ '^[0-9]+$'
 );
$$;

CREATE TABLE "Ship" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "durability" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Ship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Ship_valid_kind" CHECK ("kind" IN ('skiff','salvager','sailboat')),
    CONSTRAINT "Ship_valid_level" CHECK ("level" BETWEEN 1 AND 3),
    CONSTRAINT "Ship_valid_durability" CHECK ("durability" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "Ship_userId_kind_key" ON "Ship"("userId", "kind");
CREATE UNIQUE INDEX "Ship_id_userId_key" ON "Ship"("id", "userId");
ALTER TABLE "Ship" ADD CONSTRAINT "Ship_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Expedition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shipId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SAILING',
    "departedAt" TIMESTAMP(3) NOT NULL,
    "arrivesAt" TIMESTAMP(3) NOT NULL,
    "returnsAt" TIMESTAMP(3),
    "choiceId" TEXT,
    "snapshot" JSONB NOT NULL,
    "outcomes" JSONB NOT NULL,
    "result" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Expedition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Expedition_valid_status" CHECK ("status" IN ('SAILING','RETURNING','CLAIMED')),
    CONSTRAINT "Expedition_valid_region" CHECK ("regionId" IN ('bay','wrecks','coral','storm','lost')),
    CONSTRAINT "Expedition_valid_choice" CHECK ("choiceId" IS NULL OR "choiceId" IN ('return','venture','repair','rescue')),
    CONSTRAINT "Expedition_valid_times" CHECK (
        "arrivesAt" >= "departedAt"
        AND ("returnsAt" IS NULL OR "returnsAt" >= "arrivesAt")
        AND ("resolvedAt" IS NULL OR "resolvedAt" >= "arrivesAt")
        AND ("returnsAt" IS NULL OR "resolvedAt" IS NULL OR "returnsAt" >= "resolvedAt")
        AND ("claimedAt" IS NULL OR ("returnsAt" IS NOT NULL AND "claimedAt" >= "returnsAt"))
    ),
    CONSTRAINT "Expedition_valid_payloads" CHECK (
        jsonb_typeof("snapshot") = 'object'
        AND jsonb_typeof("outcomes") = 'object'
        AND ("result" IS NULL OR jsonb_typeof("result") = 'object')
    ),
    CONSTRAINT "Expedition_valid_phase" CHECK (
        ("status" = 'SAILING' AND "choiceId" IS NULL AND "returnsAt" IS NULL
            AND "result" IS NULL AND "resolvedAt" IS NULL AND "claimedAt" IS NULL)
        OR ("status" = 'RETURNING' AND "choiceId" IS NOT NULL AND "returnsAt" IS NOT NULL
            AND "result" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "claimedAt" IS NULL)
        OR ("status" = 'CLAIMED' AND "choiceId" IS NOT NULL AND "returnsAt" IS NOT NULL
            AND "result" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "claimedAt" IS NOT NULL)
    )
);
CREATE INDEX "Expedition_userId_status_createdAt_idx" ON "Expedition"("userId", "status", "createdAt");
CREATE INDEX "Expedition_userId_regionId_status_idx" ON "Expedition"("userId", "regionId", "status");
-- A ship remains occupied until cargo is claimed, including offline-ready trips.
CREATE UNIQUE INDEX "Expedition_one_active_per_ship" ON "Expedition"("shipId")
    WHERE "status" IN ('SAILING', 'RETURNING');
ALTER TABLE "Expedition" ADD CONSTRAINT "Expedition_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expedition" ADD CONSTRAINT "Expedition_shipId_userId_fkey"
    FOREIGN KEY ("shipId", "userId") REFERENCES "Ship"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
