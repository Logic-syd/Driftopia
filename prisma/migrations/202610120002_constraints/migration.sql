ALTER TABLE "PlayerProgress" ADD CONSTRAINT positive_progress CHECK (coins >= 0 AND xp >= 0 AND prosperity >= 0);
ALTER TABLE "MarketListing" ADD CONSTRAINT valid_listing CHECK (quantity >= 0 AND "unitPrice" > 0 AND status IN ('ACTIVE','SOLD','CANCELLED'));
ALTER TABLE "MarketTransaction" ADD CONSTRAINT valid_trade CHECK (quantity > 0 AND total > 0 AND fee >= 0 AND fee <= total AND "buyerId" <> "sellerId");
ALTER TABLE "Building" ADD CONSTRAINT valid_level CHECK (level BETWEEN 1 AND 3);
ALTER TABLE "Friendship" ADD CONSTRAINT distinct_friends CHECK ("userId" <> "friendId");
ALTER TABLE "ProductionJob" ADD CONSTRAINT valid_job CHECK ("finishesAt" >= "startsAt" AND status IN ('RUNNING','COLLECTED'));
CREATE FUNCTION driftopia_valid_inventory(resources jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(resources) = 'object' AND NOT EXISTS (
   SELECT 1 FROM jsonb_each(resources) WHERE key NOT IN ('wood','plastic','metal','seaweed','water','fish','plank','parts') OR jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$'
 );
$$;
ALTER TABLE "Inventory" ADD CONSTRAINT nonnegative_inventory CHECK (driftopia_valid_inventory(resources));
