/** Launch an immutable local benchmark artifact and record the exact child PID. */
import "dotenv/config";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

async function main() {
  const port = Number(process.env.PORT ?? 3003);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PORT must be 1024..65535");
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const source = process.env.PERF_SOURCE_ARTIFACT ?? "dist/perf-api/main.js";
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const artifact = path.join(path.dirname(source), `main-${digest}.cjs`);
  await writeFile(artifact, bytes, { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  if (
    createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex") !== digest
  )
    throw new Error("Existing immutable artifact does not match its checksum");
  const manifestPath =
    process.env.PERF_LAUNCH_MANIFEST ?? "/tmp/driftopia-perf-launch.json";
  const launchedAt = new Date().toISOString();
  const child = spawn(process.execPath, [artifact], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      DB_POOL_MAX: process.env.DB_POOL_MAX ?? "20",
    },
  });
  let failed = false;
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.once("error", (error) => {
    failed = true;
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.exitCode = failed
      ? 1
      : (code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1));
  });
  try {
    if (!child.pid) throw new Error("API process did not start");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ artifact, sha256BeforeLaunch: digest, pid: child.pid, launchedAt, node: process.execPath, port, verifiedPortFreeBeforeLaunch: true }, null, 2)}\n`,
    );
    process.stdout.write(
      `Performance launch manifest: ${manifestPath}; API PID ${child.pid}\n`,
    );
  } catch (error) {
    failed = true;
    child.kill("SIGTERM");
    throw error;
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
