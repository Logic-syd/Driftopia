import "dotenv/config";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const tsx = createRequire(import.meta.url).resolve("tsx");
const previousMigrations = [
  "202610120001_initial",
  "202610120002_constraints",
  "202610120003_automation",
  "202610130001_reliability",
];
const explorationMigration = "202610150001_exploration";
const databaseName = `driftopia_migration_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Client | undefined;
let isolated: pg.Client | undefined;
let directory: string | undefined;
let createdDatabase = false;
let isolatedUrl: string;
let before: Record<string, string>;
let after: Record<string, string>;
let constraintsBefore: unknown[];
let constraintsAfter: unknown[];
let migrationOutput: string;
const fixture = {
  owner: randomUUID(),
  buyer: randomUUID(),
  island: randomUUID(),
  buyerIsland: randomUUID(),
  purifier: randomUUID(),
  job: randomUUID(),
  activeOrder: randomUUID(),
  activeListing: randomUUID(),
  oldTrade: randomUUID(),
  oldReceipt: randomUUID(),
};

function connection() {
  if (!isolated)
    throw new Error("Isolated migration database was not initialized");
  return isolated;
}

// Identifiers only come from pg_catalog, generated UUID names, or this test's literals.
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function run(script: string) {
  return execute(process.execPath, ["--import", tsx, resolve(root, script)], {
    cwd: directory,
    env: {
      ...process.env,
      DATABASE_URL: isolatedUrl,
      REDIS_URL: "redis://127.0.0.1:1",
      ADMIN_EMAIL: "",
      NODE_ENV: "test",
      LEGACY_FIXTURE: JSON.stringify(fixture),
    },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
}

async function insert(table: string, data: Record<string, unknown>) {
  const fields = Object.keys(data);
  await connection().query(
    `INSERT INTO ${quote(table)} (${fields.map(quote).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(data),
  );
}

async function snapshot(tables?: string[]) {
  const names =
    tables ??
    (
      await connection().query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const condition =
      name === "_driftopia_migrations"
        ? "WHERE t.name <> '202610150001_exploration'"
        : "";
    const rows = await connection().query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM ${quote(name)} t ${condition} ORDER BY row_to_json(t)::text`,
    );
    hashes[name] = createHash("sha256")
      .update(JSON.stringify(rows.rows))
      .digest("hex");
  }
  return hashes;
}

async function inventoryConstraintIdentity() {
  return (
    await connection().query(
      `SELECT c.oid::text AS constraint_oid, p.oid::text AS function_oid, c.convalidated
     FROM pg_constraint c JOIN pg_proc p ON p.proname='driftopia_valid_inventory'
     WHERE c.conname='nonnegative_inventory' AND c.conrelid='"Inventory"'::regclass`,
    )
  ).rows;
}

async function createLegacySave() {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${scryptSync("legacy-migration-password", salt, 64).toString("hex")}`;
  const past = new Date(Date.now() - 60000);
  const future = new Date(Date.now() + 3600000);
  for (const [id, islandId, coins, name] of [
    [fixture.owner, fixture.island, 300, "Legacy sailor"],
    [fixture.buyer, fixture.buyerIsland, 200, "Legacy trader"],
  ] as const) {
    await insert("User", { id, email: `${id}@migration.test`, passwordHash });
    await insert("PlayerProfile", { userId: id, name });
    await insert("PlayerProgress", {
      userId: id,
      coins,
      xp: 60,
      prosperity: 38,
      salvaged: 4,
      produced: 2,
      orders: 1,
      weeklyPoints: 30,
      weekKey: "2026-10-12",
    });
    await insert("Inventory", {
      userId: id,
      resources: {
        wood: 18,
        plastic: 12,
        metal: 4,
        seaweed: 4,
        water: 2,
        fish: 6,
        plank: 4,
        parts: 2,
      },
    });
    await insert("Island", { id: islandId, userId: id });
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        await insert("IslandTile", { id: randomUUID(), islandId, x, y });
      }
    }
    await insert("Building", {
      id: randomUUID(),
      islandId,
      kind: "dock",
      x: -1,
      y: 0,
    });
  }
  await insert("Building", {
    id: randomUUID(),
    islandId: fixture.island,
    kind: "warehouse",
    x: 0,
    y: 0,
    level: 2,
  });
  await insert("Building", {
    id: fixture.purifier,
    islandId: fixture.island,
    kind: "purifier",
    x: 1,
    y: 0,
  });
  await insert("ProductionJob", {
    id: fixture.job,
    buildingId: fixture.purifier,
    input: {},
    output: { water: 3 },
    startsAt: new Date(past.getTime() - 12000),
    finishesAt: past,
  });
  await insert("Session", {
    tokenHash: "a".repeat(64),
    userId: fixture.owner,
    expiresAt: future,
  });
  await insert("SalvageSpawn", {
    id: randomUUID(),
    userId: fixture.owner,
    kind: "wood",
    reward: { wood: 4 },
    x: 12,
    y: 32,
    expiresAt: future,
  });
  await insert("SalvageSpawn", {
    id: randomUUID(),
    userId: fixture.owner,
    kind: "metal",
    reward: { metal: 2 },
    x: 80,
    y: 25,
    expiresAt: past,
    claimedAt: past,
  });
  await insert("PlayerOrder", {
    id: fixture.activeOrder,
    userId: fixture.owner,
    orderCode: "fresh-catch",
    name: "Legacy active order",
    description: "Retain the accepted reward snapshot",
    input: { fish: 3, seaweed: 2 },
    coins: 42,
    xp: 25,
    expiresAt: future,
  });
  await insert("PlayerOrder", {
    id: randomUUID(),
    userId: fixture.owner,
    orderCode: "first-water",
    name: "Legacy completed order",
    description: "Completed before the exploration migration",
    input: { water: 3, wood: 4 },
    coins: 35,
    xp: 30,
    expiresAt: future,
    completedAt: past,
  });
  const soldListing = randomUUID();
  await insert("MarketListing", {
    id: soldListing,
    sellerId: fixture.owner,
    resource: "metal",
    quantity: 0,
    unitPrice: 7,
    status: "SOLD",
  });
  await insert("MarketListing", {
    id: fixture.activeListing,
    sellerId: fixture.owner,
    resource: "wood",
    quantity: 2,
    unitPrice: 4,
  });
  await insert("MarketTransaction", {
    id: fixture.oldTrade,
    listingId: soldListing,
    buyerId: fixture.buyer,
    sellerId: fixture.owner,
    resource: "metal",
    quantity: 2,
    total: 14,
    fee: 1,
  });
  await insert("Friendship", {
    userId: fixture.owner,
    friendId: fixture.buyer,
  });
  await insert("GameEvent", {
    id: randomUUID(),
    userId: fixture.owner,
    type: "market:sold",
    payload: { tradeId: fixture.oldTrade, coinsDelta: 13, fee: 1 },
  });
  await insert("IdempotencyRecord", {
    userId: fixture.owner,
    key: fixture.oldReceipt,
    requestHash: "b".repeat(64),
    result: { message: "Historical receipt", tradeId: fixture.oldTrade },
  });
  await insert("GameConfigVersion", {
    actorId: fixture.owner,
    scope: "recipe:purifier",
    value: { input: {}, output: { water: 3 }, seconds: 12 },
  });
}

async function rejectsConstraint(
  sql: string,
  values: unknown[],
  code: string,
  constraint?: string,
) {
  await connection().query("SAVEPOINT expected_constraint");
  try {
    await expect(connection().query(sql, values)).rejects.toMatchObject({
      code,
      ...(constraint ? { constraint } : {}),
    });
  } finally {
    await connection().query("ROLLBACK TO SAVEPOINT expected_constraint");
    await connection().query("RELEASE SAVEPOINT expected_constraint");
  }
}

async function ship(kind = "skiff") {
  const id = randomUUID();
  await insert("Ship", { id, userId: fixture.owner, kind });
  return id;
}

function voyage(shipId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    userId: fixture.owner,
    shipId,
    regionId: "bay",
    departedAt: new Date("2026-10-01T00:00:00Z"),
    arrivesAt: new Date("2026-10-01T00:01:00Z"),
    snapshot: { level: 1, shipKind: "skiff" },
    outcomes: { return: { coins: 3 } },
    ...overrides,
  };
}

describe("exploration migration on a real, isolated legacy PostgreSQL database", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error(
        "DATABASE_URL is required for migration integration tests",
      );
    const url = new URL(process.env.DATABASE_URL);
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quote(databaseName)}`);
    createdDatabase = true;
    url.pathname = `/${databaseName}`;
    isolatedUrl = url.toString();
    isolated = new pg.Client({ connectionString: isolatedUrl });
    await isolated.connect();
    directory = await mkdtemp(join(tmpdir(), "driftopia-migration-"));
    await mkdir(join(directory, "prisma/migrations"), { recursive: true });
    for (const name of previousMigrations) {
      await cp(
        join(root, "prisma/migrations", name),
        join(directory, "prisma/migrations", name),
        { recursive: true },
      );
    }
    await run("scripts/migrate.ts");
    await run("prisma/seed.ts");
    // Reproduce the pre-exploration catalog even when the current seed adds orders.
    await connection().query(
      'DELETE FROM "Order" WHERE NOT (code = ANY($1::text[]))',
      [["first-water", "fresh-catch", "recycled-supplies", "repair", "green"]],
    );
    await createLegacySave();
    before = await snapshot();
    constraintsBefore = await inventoryConstraintIdentity();
    await cp(
      join(root, "prisma/migrations", explorationMigration),
      join(directory, "prisma/migrations", explorationMigration),
      { recursive: true },
    );
    migrationOutput = (await run("scripts/migrate.ts")).stdout;
    after = await snapshot(Object.keys(before));
    constraintsAfter = await inventoryConstraintIdentity();
  }, 60000);

  afterAll(async () => {
    await isolated?.end();
    try {
      // Never derive this DROP target from DATABASE_URL or caller-supplied input.
      if (
        createdDatabase &&
        /^driftopia_migration_[a-f0-9]{32}$/.test(databaseName)
      ) {
        await admin?.query(`DROP DATABASE ${quote(databaseName)} WITH (FORCE)`);
      }
    } finally {
      await admin?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    await connection().query("BEGIN");
  });
  afterEach(async () => {
    await isolated?.query("ROLLBACK");
  });

  it("preserves every old field and row, including migration checksums and receipts", async () => {
    expect(Object.keys(before)).toHaveLength(19);
    expect(after).toEqual(before);
    expect(constraintsAfter).toEqual(constraintsBefore);
    expect(constraintsAfter).toHaveLength(1);
    for (const name of previousMigrations)
      expect(migrationOutput).toContain(`Already applied: ${name}`);
    expect(migrationOutput).toContain(`Applied: ${explorationMigration}`);
    expect(
      (await connection().query('SELECT count(*)::int AS count FROM "Ship"'))
        .rows[0].count,
    ).toBe(0);
    expect(
      (
        await connection().query(
          'SELECT count(*)::int AS count FROM "Expedition"',
        )
      ).rows[0].count,
    ).toBe(0);
    const repeated = await run("scripts/migrate.ts");
    expect(repeated.stdout).toContain(
      `Already applied: ${explorationMigration}`,
    );
  });

  it("extends inventory to three new resources while retaining the existing integer/nonnegative whitelist CHECK", async () => {
    await connection().query(
      'UPDATE "Inventory" SET resources=resources || $1::jsonb WHERE "userId"=$2',
      [JSON.stringify({ seed: 3, alloy: 2, relic: 1 }), fixture.owner],
    );
    for (const invalid of [
      { seed: -1 },
      { alloy: 1.5 },
      { relic: "1" },
      { forged: 1 },
    ]) {
      await rejectsConstraint(
        'UPDATE "Inventory" SET resources=$1::jsonb WHERE "userId"=$2',
        [JSON.stringify(invalid), fixture.owner],
        "23514",
        "nonnegative_inventory",
      );
    }
  });

  it("enforces ship kind, level, durability and one ship of each kind per owner", async () => {
    const id = await ship();
    for (const [field, value, constraint] of [
      ["kind", "warship", "Ship_valid_kind"],
      ["level", 0, "Ship_valid_level"],
      ["level", 4, "Ship_valid_level"],
      ["durability", -1, "Ship_valid_durability"],
      ["durability", 101, "Ship_valid_durability"],
    ] as const) {
      await rejectsConstraint(
        `UPDATE "Ship" SET ${quote(field)}=$1 WHERE id=$2`,
        [value, id],
        "23514",
        constraint,
      );
    }
    await rejectsConstraint(
      'INSERT INTO "Ship" (id,"userId",kind) VALUES ($1,$2,$3)',
      [randomUUID(), fixture.owner, "skiff"],
      "23505",
      "Ship_userId_kind_key",
    );
    await ship("salvager");
    await ship("sailboat");
  });

  it("rejects a voyage belonging to a different owner than its ship", async () => {
    const id = await ship();
    const trip = voyage(id);
    await insert("Expedition", trip);
    await rejectsConstraint(
      'UPDATE "Expedition" SET "userId"=$1 WHERE id=$2',
      [fixture.buyer, trip.id],
      "23503",
      "Expedition_shipId_userId_fkey",
    );
  });

  it("allows only one sailing/returning trip per ship and releases it after a consistent claim", async () => {
    const id = await ship();
    const trip = voyage(id);
    await insert("Expedition", trip);
    const duplicate =
      'INSERT INTO "Expedition" (id,"userId","shipId","regionId","departedAt","arrivesAt",snapshot,outcomes) SELECT $1,"userId","shipId","regionId","departedAt","arrivesAt",snapshot,outcomes FROM "Expedition" WHERE id=$2';
    await rejectsConstraint(
      duplicate,
      [randomUUID(), trip.id],
      "23505",
      "Expedition_one_active_per_ship",
    );
    await connection().query(
      `UPDATE "Expedition" SET status='RETURNING', "choiceId"='return', "resolvedAt"="arrivesAt", "returnsAt"="arrivesAt" + interval '1 minute', result='{}'::jsonb WHERE id=$1`,
      [trip.id],
    );
    await rejectsConstraint(
      duplicate,
      [randomUUID(), trip.id],
      "23505",
      "Expedition_one_active_per_ship",
    );
    await connection().query(
      `UPDATE "Expedition" SET status='CLAIMED', "claimedAt"="returnsAt" WHERE id=$1`,
      [trip.id],
    );
    await insert("Expedition", voyage(id));
    expect(
      (
        await connection().query(
          'SELECT count(*)::int AS count FROM "Expedition" WHERE "shipId"=$1',
          [id],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it("rejects incomplete phases, invalid region/choice/status, and non-object secret payloads", async () => {
    const trip = voyage(await ship());
    await insert("Expedition", trip);
    for (const [assignment, constraint] of [
      ["status='RETURNING'", "Expedition_valid_phase"],
      ["status='CLAIMED'", "Expedition_valid_phase"],
      ["status='FORGED'", "Expedition_valid_phase"],
      ["\"regionId\"='unknown'", "Expedition_valid_region"],
      ["\"choiceId\"='hacked'", "Expedition_valid_choice"],
      ["snapshot='[]'::jsonb", "Expedition_valid_payloads"],
      ["outcomes='null'::jsonb", "Expedition_valid_payloads"],
    ]) {
      await rejectsConstraint(
        `UPDATE "Expedition" SET ${assignment} WHERE id=$1`,
        [trip.id],
        "23514",
        constraint,
      );
    }
    await connection().query(
      `UPDATE "Expedition" SET status='RETURNING', "choiceId"='venture', "resolvedAt"="arrivesAt", "returnsAt"="arrivesAt" + interval '2 minutes', result='{}'::jsonb WHERE id=$1`,
      [trip.id],
    );
    await rejectsConstraint(
      `UPDATE "Expedition" SET result='[]'::jsonb WHERE id=$1`,
      [trip.id],
      "23514",
      "Expedition_valid_payloads",
    );
  });

  it("requires departure <= arrival <= resolution <= return <= claim", async () => {
    const trip = voyage(await ship());
    await insert("Expedition", trip);
    await rejectsConstraint(
      'UPDATE "Expedition" SET "arrivesAt"="departedAt" - interval \'1 second\' WHERE id=$1',
      [trip.id],
      "23514",
      "Expedition_valid_times",
    );
    await connection().query(
      `UPDATE "Expedition" SET status='RETURNING', "choiceId"='repair', "resolvedAt"="arrivesAt" + interval '1 minute', "returnsAt"="arrivesAt" + interval '2 minutes', result='{}'::jsonb WHERE id=$1`,
      [trip.id],
    );
    for (const assignment of [
      '"resolvedAt"="arrivesAt" - interval \'1 second\'',
      '"returnsAt"="arrivesAt" - interval \'1 second\'',
      '"returnsAt"="resolvedAt" - interval \'1 second\'',
      "status='CLAIMED', \"claimedAt\"=\"returnsAt\" - interval '1 second'",
    ]) {
      await rejectsConstraint(
        `UPDATE "Expedition" SET ${assignment} WHERE id=$1`,
        [trip.id],
        "23514",
        "Expedition_valid_times",
      );
    }
  });

  it("loads the migrated save through real services and settles old production, orders and idempotent trading", async () => {
    const result = await run("tests/fixtures/legacy-migration-service.ts");
    expect(result.stdout).toContain('"legacyServiceChecks":"passed"');
  });
});
