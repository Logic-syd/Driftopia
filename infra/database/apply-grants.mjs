// Run after migrations using the non-superuser schema owner. No credentials log.
import pg from "pg";
import process from "node:process";
import console from "node:console";
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await client.connect();
  await client.query(`
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO driftopia;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO driftopia;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO driftopia;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO driftopia;
    REVOKE ALL ON TABLE "_driftopia_migrations" FROM driftopia;
    GRANT SELECT ON TABLE "_driftopia_migrations" TO driftopia;
    REVOKE UPDATE, DELETE ON TABLE "MarketTransaction", "GameEvent" FROM driftopia;
    REVOKE DELETE ON TABLE "User" FROM driftopia;
  `);
  console.log(
    "Application grants applied; migration history and financial audit are protected.",
  );
})()
  .catch(() => {
    console.error("Failed to apply production database grants");
    process.exitCode = 1;
  })
  .finally(() => client.end());
