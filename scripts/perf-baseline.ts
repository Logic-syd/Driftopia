import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { db } from "../apps/api/src/database";
import { leaderboard, rebuildRankings, redis } from "../apps/api/src/game";

const label = process.argv[2] ?? "baseline";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Use a simple result label");
const count = Number(process.env.PERF_BASELINE_USERS ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 5000)
  throw new Error("PERF_BASELINE_USERS must be 1..5000");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
const ids = Array.from({ length: count }, () => randomUUID());
const prefix = `perf-baseline-${randomUUID()}`;
const ms = (n: number) => Number(n.toFixed(3));
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.ceil(sorted.length * q) - 1];
  return {
    count: values.length,
    p50Ms: ms(percentile(0.5)),
    p95Ms: ms(percentile(0.95)),
    p99Ms: ms(percentile(0.99)),
    rawMs: values.map(ms),
  };
}
async function benchmark(concurrency: number, requests: number) {
  const measurements: number[] = [];
  const start = performance.now();
  for (let offset = 0; offset < requests; offset += concurrency)
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, requests - offset) },
        async () => {
          const before = performance.now();
          const result = await leaderboard("prosperity");
          if (!Array.isArray(result) || result.length !== 20)
            throw new Error("Invalid ranking result");
          measurements.push(performance.now() - before);
        },
      ),
    );
  const durationMs = performance.now() - start;
  return {
    concurrency,
    elapsedMs: ms(durationMs),
    requestsPerSecond: ms(requests / (durationMs / 1000)),
    ...summary(measurements),
  };
}
async function main() {
  try {
    await db.$connect();
    await redis.connect().catch(() => undefined);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO \"User\" (id,email,\"passwordHash\",\"createdAt\") SELECT id, $2 || '-' || n || '@example.test', 'unusable-perf-fixture', now() FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)",
        [ids, prefix],
      );
      await client.query(
        'INSERT INTO "PlayerProfile" ("userId",name) SELECT id, \'Perf baseline \' || n FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)',
        [ids],
      );
      await client.query(
        'INSERT INTO "PlayerProgress" ("userId",prosperity,xp) SELECT id, n::int, n::int FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)',
        [ids],
      );
      await client.query(
        'INSERT INTO "MarketListing" (id,"sellerId",resource,quantity,"unitPrice","createdAt") SELECT id || \'-listing\',id,\'water\',1,7,now()-n*interval \'1 second\' FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)',
        [ids],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await pool.query('ANALYZE "PlayerProgress"');
    await pool.query('ANALYZE "MarketListing"');
    const environment = await pool.query(
      'SELECT version() AS postgres, (SELECT COUNT(*)::int FROM "User") AS users, (SELECT COUNT(*)::int FROM "MarketListing") AS listings',
    );
    const plan = await pool.query(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM "MarketListing" WHERE status = \'ACTIVE\' ORDER BY "createdAt" DESC LIMIT 100',
    );
    for (let i = 0; i < 5; i++) await leaderboard("prosperity");
    const results = {
      label,
      timestamp: new Date().toISOString(),
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      method:
        "Direct service call to leaderboard(prosperity), real PostgreSQL + Redis; excludes HTTP/auth; 5 warmup requests; 1000 isolated fixture users by default; single-process module loaded before benchmark.",
      fixtureUsers: count,
      environment: environment.rows[0],
      marketPlan: plan.rows[0],
      serial: await benchmark(1, 60),
      concurrent: await benchmark(10, 60),
    };
    await mkdir("docs/performance", { recursive: true });
    await writeFile(
      `docs/performance/leaderboard-${label}.json`,
      `${JSON.stringify(results, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ label, serial: { ...results.serial, rawMs: undefined }, concurrent: { ...results.concurrent, rawMs: undefined } })}\n`,
    );
  } finally {
    await pool.query(
      'DELETE FROM "MarketListing" WHERE "sellerId" = ANY($1::text[])',
      [ids],
    );
    await pool.query('DELETE FROM "User" WHERE id = ANY($1::text[])', [ids]);
    await rebuildRankings().catch(() => undefined);
    await pool.end();
    await db.$disconnect();
    redis.disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
