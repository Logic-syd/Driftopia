/** Real HTTP + Socket.IO load runner. Fixtures are isolated; no economy mock is used. */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import pg from "pg";
import Redis from "ioredis";
import { io, type Socket } from "socket.io-client";

const users = Number(process.env.PERF_USERS ?? 100);
const durationSeconds = Number(process.env.PERF_DURATION_SECONDS ?? 30);
const base = new URL(process.env.PERF_BASE_URL ?? "http://127.0.0.1:3003");
const origin = process.env.PERF_ORIGIN ?? "http://localhost:5173";
const runId = process.env.PERF_RUN_ID ?? randomUUID();
const metricsToken = process.env.METRICS_TOKEN;
if (!Number.isInteger(users) || users < 2 || users > 1000)
  throw new Error("PERF_USERS must be 2..1000");
if (
  !Number.isFinite(durationSeconds) ||
  durationSeconds < 30 ||
  durationSeconds > 300
)
  throw new Error("PERF_DURATION_SECONDS must be 30..300");
if (!/^[0-9a-f-]{36}$/.test(runId))
  throw new Error("PERF_RUN_ID must be a UUID");
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for isolated fixtures");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
  process.env.PERF_ALLOW_REMOTE !== "yes"
)
  throw new Error(
    "Remote load requires explicit PERF_ALLOW_REMOTE=yes; use your own authorized target",
  );
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  application_name: `driftopia-perf-${runId}`,
});
const cache = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
cache.on("error", () => undefined);
const prefix = `perf-${runId}-`;
const actors = Array.from({ length: users }, (_, index) => ({
  id: randomUUID(),
  islandId: randomUUID(),
  dockId: randomUUID(),
  warehouseId: randomUUID(),
  purifierId: randomUUID(),
  listingId: randomUUID(),
  token: randomBytes(32).toString("hex"),
  index,
}));
type Actor = (typeof actors)[number];
type Observation = {
  scenario: string;
  endpoint: string;
  durationMs: number;
  status: number;
  code?: string;
};
type MonitorSample = {
  scenario: string;
  elapsedSeconds: number;
  apiCpuSeconds: number | null;
  apiRssBytes: number | null;
  websocketConnections: number | null;
  dbConnections: number;
  dbActiveConnections: number;
  cgroupCpuSeconds: number | null;
  cgroupMemoryBytes: number | null;
};
const observations: Observation[] = [];
const samples: MonitorSample[] = [];
const sockets: Socket[] = [];
const socketErrors: string[] = [];
let monitoring = false;
let interrupted = false;
let maxClientSockets = 0;
let currentScenario = "setup";
const runStartedAt = performance.now();
const stop = () => {
  interrupted = true;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const round = (n: number) => Number(n.toFixed(3));
function assertRunning() {
  if (interrupted)
    throw new Error("Load test interrupted; fixtures will be cleaned");
}
async function textFile(path: string) {
  return readFile(path, "utf8").catch(() => null);
}
function metric(body: string, names: string[]) {
  for (const name of names) {
    const match = body.match(
      new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, "m"),
    );
    if (match) return Number(match[1]);
  }
  return null;
}
async function monitor() {
  const response = await fetch(new URL("/api/metrics", base), {
    headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`Metrics unavailable: HTTP ${response.status}`);
  const body = await response.text();
  const [connections, cpu, memory] = await Promise.all([
    pool.query<{ total: number; active: number }>(
      "SELECT count(*)::int AS total,count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'",
    ),
    textFile("/sys/fs/cgroup/cpu.stat"),
    textFile("/sys/fs/cgroup/memory.current"),
  ]);
  const cpuTotal = metric(body, ["process_cpu_seconds_total"]);
  const cpuUser = metric(body, ["process_cpu_user_seconds_total"]);
  const cpuSystem = metric(body, ["process_cpu_system_seconds_total"]);
  const connected = metric(body, ["driftopia_websocket_connections"]);
  if (connected === null)
    throw new Error("Metrics missing driftopia_websocket_connections");
  samples.push({
    scenario: currentScenario,
    elapsedSeconds: round((performance.now() - runStartedAt) / 1000),
    apiCpuSeconds:
      cpuTotal ??
      (cpuUser !== null && cpuSystem !== null ? cpuUser + cpuSystem : null),
    apiRssBytes: metric(body, ["process_resident_memory_bytes"]),
    websocketConnections: connected,
    dbConnections: connections.rows[0].total,
    dbActiveConnections: connections.rows[0].active,
    cgroupCpuSeconds: cpu
      ? Number(cpu.match(/^usage_usec (\d+)$/m)?.[1]) / 1e6
      : null,
    cgroupMemoryBytes: memory ? Number(memory.trim()) : null,
  });
  maxClientSockets = Math.max(
    maxClientSockets,
    sockets.filter((s) => s.connected).length,
  );
}
async function monitorLoop() {
  while (monitoring) {
    await monitor().catch((error: unknown) => {
      socketErrors.push(
        `monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await sleep(1000);
  }
}
async function request(
  actor: Actor,
  endpoint: string,
  scenario: string,
  payload?: unknown,
) {
  const started = performance.now();
  let status = 0;
  let code: string | undefined;
  try {
    const response = await fetch(new URL(`/api${endpoint}`, base), {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        cookie: `driftopia_session=${actor.token}`,
        origin,
        ...(payload === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
            }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    status = response.status;
    const body = (await response.json()) as { error?: { code?: string } };
    if (!response.ok) code = body.error?.code ?? "HTTP_ERROR";
  } catch (error) {
    code = error instanceof Error ? error.name : "NETWORK_ERROR";
  }
  const observation = {
    scenario,
    endpoint: endpoint.includes("/market/") ? "/market/:id/buy" : endpoint,
    durationMs: round(performance.now() - started),
    status,
    ...(code ? { code } : {}),
  };
  if (scenario !== "warmup") observations.push(observation);
  return observation;
}
async function seed() {
  const client = await pool.connect();
  const ids = actors.map((a) => a.id);
  const islands = actors.map((a) => a.islandId);
  try {
    await client.query("BEGIN");
    await client.query(
      'INSERT INTO "User" (id,email,"passwordHash","createdAt") SELECT id,$2 || n || \'@example.test\',\'unusable-perf-fixture\',now() FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)',
      [ids, prefix],
    );
    await client.query(
      'INSERT INTO "PlayerProfile" ("userId",name) SELECT id,\'Perf sailor \' || n FROM unnest($1::text[]) WITH ORDINALITY AS t(id,n)',
      [ids],
    );
    await client.query(
      'INSERT INTO "PlayerProgress" ("userId",coins,xp,prosperity) SELECT id,1000,40,20 FROM unnest($1::text[]) AS id',
      [ids],
    );
    await client.query(
      'INSERT INTO "Inventory" ("userId",resources) SELECT id,\'{"wood":20,"water":16}\'::jsonb FROM unnest($1::text[]) AS id',
      [ids],
    );
    await client.query(
      'INSERT INTO "Session" ("tokenHash","userId","expiresAt") SELECT hash,id,now()+interval \'2 hours\' FROM unnest($1::text[],$2::text[]) AS t(hash,id)',
      [
        actors.map((a) => createHash("sha256").update(a.token).digest("hex")),
        ids,
      ],
    );
    await client.query(
      'INSERT INTO "Island" (id,"userId") SELECT * FROM unnest($1::text[],$2::text[])',
      [islands, ids],
    );
    await client.query(
      "INSERT INTO \"IslandTile\" (id,\"islandId\",x,y) SELECT island || '-' || x || '-' || y,island,x,y FROM unnest($1::text[]) AS island CROSS JOIN generate_series(-1,1) AS x CROSS JOIN generate_series(-1,1) AS y",
      [islands],
    );
    for (const [kind, actorKey, x, y] of [
      ["dock", "dockId", 1, 1],
      ["warehouse", "warehouseId", -1, -1],
      ["purifier", "purifierId", 0, 0],
    ] as const)
      await client.query(
        'INSERT INTO "Building" (id,"islandId",kind,x,y) SELECT id,island,$3,$4,$5 FROM unnest($1::text[],$2::text[]) AS t(id,island)',
        [actors.map((a) => a[actorKey]), islands, kind, x, y],
      );
    // Four water per player is held in marketplace escrow; it is absent from Inventory.
    await client.query(
      'INSERT INTO "MarketListing" (id,"sellerId",resource,quantity,"unitPrice","createdAt") SELECT id,seller,\'water\',4,7,now()-n*interval \'1 millisecond\' FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS t(id,seller,n)',
      [actors.map((a) => a.listingId), ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function cleanup() {
  const ids = actors.map((a) => a.id);
  await pool.query(
    'DELETE FROM "MarketTransaction" WHERE "buyerId" = ANY($1::text[]) OR "sellerId" = ANY($1::text[])',
    [ids],
  );
  await pool.query(
    'DELETE FROM "MarketListing" WHERE "sellerId" = ANY($1::text[])',
    [ids],
  );
  await pool.query(
    'DELETE FROM "User" WHERE id = ANY($1::text[]) AND email LIKE $2',
    [ids, `${prefix}%`],
  );
  if (cache.status === "ready") {
    const pipeline = cache.multi();
    for (const field of ["prosperity", "xp", "weeklyPoints"])
      pipeline.zrem(`ranks:${field}`, ...ids);
    await pipeline.exec();
  }
}
async function connectAll() {
  for (let offset = 0; offset < actors.length; offset += 25) {
    assertRunning();
    await Promise.all(
      actors.slice(offset, offset + 25).map(
        (actor) =>
          new Promise<void>((resolve, reject) => {
            const socket = io(base.origin, {
              transports: ["websocket"],
              reconnection: false,
              timeout: 20000,
              extraHeaders: {
                Cookie: `driftopia_session=${actor.token}`,
                Origin: origin,
              },
            });
            sockets.push(socket);
            socket.once("connect", () => resolve());
            socket.once("connect_error", (error) => {
              socketErrors.push(error.message);
              reject(error);
            });
            socket.on("disconnect", (reason) => {
              if (monitoring) socketErrors.push(`disconnect: ${reason}`);
            });
          }),
      ),
    );
    await sleep(100);
  }
  maxClientSockets = sockets.filter((s) => s.connected).length;
}
async function warmup() {
  for (let offset = 0; offset < actors.length; offset += 10) {
    assertRunning();
    const batch = await Promise.all(
      actors
        .slice(offset, offset + 10)
        .map((actor) => request(actor, "/state", "warmup")),
    );
    if (batch.some((r) => r.status !== 200))
      throw new Error(
        `Warmup failed: ${JSON.stringify(batch.filter((r) => r.status !== 200))}`,
      );
  }
}
async function periodic(
  actor: Actor,
  endpoint: string,
  intervalMs: number,
  deadline: number,
  phaseStarted: number,
) {
  let next = phaseStarted + (actor.index / users) * intervalMs;
  while (next < deadline) {
    assertRunning();
    await sleep(next - performance.now());
    if (performance.now() >= deadline) break;
    await request(actor, endpoint, "steady_reads");
    // Closed loop: one in-flight request per actor/endpoint; no unbounded catch-up.
    next = Math.max(next + intervalMs, performance.now());
  }
}
async function timedPhase(
  name: string,
  fn: (started: number, deadline: number) => Promise<void>,
) {
  currentScenario = name;
  const started = performance.now();
  const deadline = started + durationSeconds * 1000;
  await monitor();
  process.stdout.write(
    `${name}: ${users} connected users, ${durationSeconds}s target\n`,
  );
  await fn(started, deadline);
  await sleep(deadline - performance.now());
  await monitor();
  return { name, durationSeconds: round((performance.now() - started) / 1000) };
}
async function claimPhase(started: number) {
  await Promise.all(
    actors.map(async (actor) => {
      for (const wave of [0, 12, 24]) {
        assertRunning();
        await sleep(
          started + wave * 1000 + (actor.index % 20) * 25 - performance.now(),
        );
        await request(actor, "/game/collect", "production_claims", {
          buildingId: actor.purifierId,
        });
      }
    }),
  );
}
async function buyPhase(started: number) {
  await Promise.all(
    actors.map(async (actor) => {
      for (const wave of [0, 10, 20]) {
        assertRunning();
        await sleep(
          started + wave * 1000 + (actor.index % 20) * 25 - performance.now(),
        );
        await request(
          actor,
          `/market/${actors[(actor.index + 1) % users].listingId}/buy`,
          "market_purchases",
          { quantity: 1 },
        );
      }
    }),
  );
}
function stats(entries: Observation[], elapsed: number) {
  const sorted = entries.map((r) => r.durationMs).sort((a, b) => a - b);
  const percentile = (q: number) =>
    sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
  const errors = entries.filter(
    (r) => r.status < 200 || r.status >= 300 || r.code,
  );
  const errorsByStatus: Record<string, number> = {};
  for (const error of errors) {
    const key = `${error.status}:${error.code ?? "HTTP_ERROR"}`;
    errorsByStatus[key] = (errorsByStatus[key] ?? 0) + 1;
  }
  return {
    requests: entries.length,
    successfulRequests: entries.length - errors.length,
    errors: errors.length,
    errorRate: entries.length
      ? Number((errors.length / entries.length).toFixed(6))
      : null,
    throughputPerSecond: round(entries.length / elapsed),
    successfulThroughputPerSecond: round(
      (entries.length - errors.length) / elapsed,
    ),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    errorsByStatus,
  };
}
function phaseResources(name: string) {
  const points = samples.filter((sample) => sample.scenario === name);
  const first = points[0],
    last = points.at(-1);
  const max = (key: keyof MonitorSample) => {
    const values = points
      .map((p) => p[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return values.length ? Math.max(...values) : null;
  };
  const cpuPercent =
    first && last && first.apiCpuSeconds !== null && last.apiCpuSeconds !== null
      ? round(
          ((last.apiCpuSeconds - first.apiCpuSeconds) /
            (last.elapsedSeconds - first.elapsedSeconds)) *
            100,
        )
      : null;
  return {
    samples: points.length,
    apiCpuPercentOfOneCore: cpuPercent,
    apiRssPeakBytes: max("apiRssBytes"),
    websocketConnectionsPeak: max("websocketConnections"),
    dbConnectionsPeak: max("dbConnections"),
    dbActiveConnectionsPeak: max("dbActiveConnections"),
    cgroupMemoryPeakBytes: max("cgroupMemoryBytes"),
  };
}
async function verifyRuntime() {
  if (
    process.env.PERF_ALLOW_UNVERIFIED === "yes" &&
    !process.env.PERF_LAUNCH_MANIFEST
  )
    return null;
  const launch = JSON.parse(
    await readFile(
      process.env.PERF_LAUNCH_MANIFEST ?? "/tmp/driftopia-perf-launch.json",
      "utf8",
    ),
  ) as {
    artifact: string;
    sha256BeforeLaunch: string;
    pid: number;
    launchedAt: string;
  };
  process.kill(launch.pid, 0);
  const command = await readFile(`/proc/${launch.pid}/cmdline`, "utf8");
  if (!command.split("\0").includes(launch.artifact))
    throw new Error(
      "Server PID does not execute the recorded immutable artifact",
    );
  const digest = createHash("sha256")
    .update(await readFile(launch.artifact))
    .digest("hex");
  if (digest !== launch.sha256BeforeLaunch)
    throw new Error("Server artifact changed after launch");
  const response = await fetch(new URL("/api/metrics", base), {
    headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {},
  });
  const uptime = metric(await response.text(), ["process_uptime_seconds"]);
  const age = (Date.now() - Date.parse(launch.launchedAt)) / 1000;
  if (uptime === null || Math.abs(age - uptime) > 5)
    throw new Error(
      "Metrics uptime does not match the recorded server process start",
    );
  return {
    ...launch,
    sha256AfterLaunch: digest,
    processCmdlineVerified: true,
    metricsUptimeSeconds: uptime,
    verifiedAt: new Date().toISOString(),
  };
}
async function main() {
  await mkdir("docs/performance", { recursive: true });
  const output = `docs/performance/load-${users}-${runId}.json`;
  let monitorTask: Promise<void> | undefined;
  try {
    const runtimeVerification = await verifyRuntime();
    const readiness = await fetch(new URL("/api/ready", base), {
      signal: AbortSignal.timeout(5000),
    });
    if (!readiness.ok)
      throw new Error(`Target readiness HTTP ${readiness.status}`);
    await monitor();
    if (process.env.PERF_CHECK_ONLY === "true") {
      process.stdout.write(
        `${JSON.stringify({ ready: true, runtimeVerification }, null, 2)}\n`,
      );
      return;
    }
    await cache.connect();
    await seed();
    await connectAll();
    await warmup();
    monitoring = true;
    monitorTask = monitorLoop();
    const phases = [];
    phases.push(
      await timedPhase("steady_reads", (started, deadline) =>
        Promise.all(
          actors.flatMap((actor) => [
            periodic(actor, "/state", 5000, deadline, started),
            periodic(actor, "/market", 2000, deadline, started),
          ]),
        ).then(() => undefined),
      ),
    );
    // Three persisted, immutable, prepaid jobs. No timestamp changes during the measured phase.
    await pool.query(
      "INSERT INTO \"ProductionJob\" (id,\"buildingId\",input,output,\"startsAt\",\"finishesAt\") SELECT building || '-perf-' || wave,building,'{}'::jsonb,'{\"water\":3}'::jsonb,now()+(wave*12-13)*interval '1 second',now()+(wave*12-1)*interval '1 second' FROM unnest($1::text[]) AS building CROSS JOIN generate_series(0,2) AS wave",
      [actors.map((a) => a.purifierId)],
    );
    phases.push(
      await timedPhase("production_claims", (started) => claimPhase(started)),
    );
    phases.push(
      await timedPhase("market_purchases", (started) => buyPhase(started)),
    );
    const database = (
      await pool.query(
        'SELECT version() AS version,(SELECT count(*)::int FROM "User") AS users,(SELECT count(*)::int FROM "MarketListing") AS listings,(SELECT count(*)::int FROM "ProductionJob") AS production_jobs',
      )
    ).rows[0];
    const ids = actors.map((a) => a.id);
    const integrity = (
      await pool.query(
        'SELECT (SELECT sum(coins)::int FROM "PlayerProgress" WHERE "userId" = ANY($1::text[])) AS coins,(SELECT coalesce(sum(total),0)::int FROM "MarketTransaction" WHERE "buyerId" = ANY($1::text[])) AS traded_total,(SELECT coalesce(sum(fee),0)::int FROM "MarketTransaction" WHERE "buyerId" = ANY($1::text[])) AS fees,(SELECT count(*)::int FROM "MarketTransaction" WHERE "buyerId" = ANY($1::text[])) AS trades,(SELECT coalesce(sum((resources->>\'water\')::int),0)::int FROM "Inventory" WHERE "userId" = ANY($1::text[])) AS water_in_inventory,(SELECT coalesce(sum(quantity),0)::int FROM "MarketListing" WHERE "sellerId" = ANY($1::text[]) AND status=\'ACTIVE\') AS water_in_escrow,(SELECT count(*)::int FROM "ProductionJob" j JOIN "Building" b ON b.id=j."buildingId" JOIN "Island" i ON i.id=b."islandId" WHERE i."userId" = ANY($1::text[]) AND j.status=\'COLLECTED\') AS collected_jobs',
        [ids],
      )
    ).rows[0] as {
      coins: number;
      fees: number;
      trades: number;
      water_in_inventory: number;
      water_in_escrow: number;
      collected_jobs: number;
    };
    const integrityPassed =
      integrity.coins === users * 1000 - integrity.fees &&
      integrity.water_in_inventory + integrity.water_in_escrow ===
        users * 20 + integrity.collected_jobs * 3;
    monitoring = false;
    await monitorTask;
    const results = {
      runId,
      timestamp: new Date().toISOString(),
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      workingTreeDirty:
        execFileSync("git", ["status", "--porcelain"], {
          encoding: "utf8",
        }).trim().length > 0,
      runtimeVerification,
      provenance: runtimeVerification
        ? "verified-local-process"
        : "exploratory-unverified",
      apiArtifactSha256: runtimeVerification?.sha256AfterLaunch ?? null,
      target: base.origin,
      users,
      phaseTargetDurationSeconds: durationSeconds,
      method:
        "Custom Node.js closed-loop load generator using real authenticated HTTP and Socket.IO; not k6/Artillery. Fixture prep uses PostgreSQL, warmup excluded. 30s+ each phase: per-user state/5s + market/2s; three concurrent claim waves at 0/12/24s; three concurrent market purchase waves at 0/10/20s. Within a wave groups are staggered over 475ms. No client auto-refresh on socket notification: event transport/load is measured, browser refetch amplification is not. TLS, Internet RTT, asset rendering and login scrypt are outside this localhost benchmark.",
      environment: {
        node: process.version,
        prismaClient: (
          JSON.parse(
            await readFile("node_modules/@prisma/client/package.json", "utf8"),
          ) as { version: string }
        ).version,
        pgDriver: (
          JSON.parse(
            await readFile("node_modules/pg/package.json", "utf8"),
          ) as { version: string }
        ).version,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        cpuModel: os.cpus()[0]?.model,
        availableParallelism: os.availableParallelism(),
        hostMemoryBytes: os.totalmem(),
        cgroupCpuMax: (await textFile("/sys/fs/cgroup/cpu.max"))?.trim(),
        cgroupMemoryMax: (await textFile("/sys/fs/cgroup/memory.max"))?.trim(),
        database,
        apiPoolMax:
          process.env.DB_POOL_MAX ?? "server default (see launch command)",
        redisVersion: (await cache.info("server"))
          .match(/^redis_version:(.+)$/m)?.[1]
          ?.trim(),
        servicesAndGeneratorShareHost: true,
        additionalLoad:
          process.env.PERF_ADDITIONAL_LOAD ??
          "No test suites intentionally running; dev servers may remain idle. Cgroup CPU/memory includes all shared workspace processes.",
      },
      websocket: {
        attempted: users,
        maxClientConnected: maxClientSockets,
        connectedAtEnd: sockets.filter((s) => s.connected).length,
        errors: socketErrors,
      },
      scenarios: phases.map((phase) => ({
        ...phase,
        plannedRequests:
          phase.name === "steady_reads"
            ? actors.reduce(
                (sum, actor) =>
                  sum +
                  Math.ceil((durationSeconds - (actor.index / users) * 5) / 5) +
                  Math.ceil((durationSeconds - (actor.index / users) * 2) / 2),
                0,
              )
            : users * 3,
        aggregate: stats(
          observations.filter((r) => r.scenario === phase.name),
          phase.durationSeconds,
        ),
        endpoints: Object.fromEntries(
          [
            ...new Set(
              observations
                .filter((r) => r.scenario === phase.name)
                .map((r) => r.endpoint),
            ),
          ].map((endpoint) => [
            endpoint,
            stats(
              observations.filter(
                (r) => r.scenario === phase.name && r.endpoint === endpoint,
              ),
              phase.durationSeconds,
            ),
          ]),
        ),
        resources: phaseResources(phase.name),
      })),
      integrity: {
        ...integrity,
        passed: integrityPassed,
        checks:
          "Combined participant coins decrease only by fees; water inventory + active listing escrow equals initial water + collected persisted job outputs.",
      },
      samples,
      requests: observations,
    };
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ output, websocket: results.websocket, scenarios: results.scenarios, integrity: results.integrity }, null, 2)}\n`,
    );
    if (
      !integrityPassed ||
      socketErrors.length ||
      results.websocket.connectedAtEnd !== users ||
      observations.some((r) => r.status < 200 || r.status >= 300 || r.code)
    )
      process.exitCode = 1;
  } finally {
    monitoring = false;
    await monitorTask;
    for (const socket of sockets) socket.disconnect();
    await cleanup();
    await pool.end();
    cache.disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
