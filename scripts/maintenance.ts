import { maintainData } from "../apps/api/src/maintenance";
import { db } from "../apps/api/src/database";
const apply = process.argv.includes("--apply");
maintainData(apply)
  .then((result) =>
    console.log(JSON.stringify({ event: "maintenance", ...result })),
  )
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "maintenance_failed",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
