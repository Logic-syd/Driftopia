import "dotenv/config";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
async function migrate() {
  await client.connect();
  await client.query(
    "SELECT pg_advisory_lock(hashtext('driftopia:migrations'))",
  );
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS "_driftopia_migrations" (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const entries = await readdir("prisma/migrations", { withFileTypes: true });
    for (const entry of entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const sql = await readFile(
        `prisma/migrations/${entry.name}/migration.sql`,
        "utf8",
      );
      const hash = createHash("sha256").update(sql).digest("hex");
      const prior = await client.query<{ checksum: string }>(
        'SELECT checksum FROM "_driftopia_migrations" WHERE name=$1',
        [entry.name],
      );
      if (prior.rows.length) {
        if (prior.rows[0].checksum !== hash)
          throw new Error(
            `Migration ${entry.name} was modified after application; create a new migration instead.`,
          );
        console.log(`Already applied: ${entry.name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO "_driftopia_migrations" (name,checksum) VALUES ($1,$2)',
          [entry.name, hash],
        );
        await client.query("COMMIT");
        console.log(`Applied: ${entry.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('driftopia:migrations'))",
    );
  }
}
migrate()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
