import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ORDERS } from "../packages/game-config/src/index";
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
async function seed() {
  for (const order of ORDERS)
    await db.order.upsert({
      where: { code: order.code },
      create: { ...order },
      update: {},
    });
  if (process.env.ADMIN_EMAIL) {
    const result = await db.user.updateMany({
      where: { email: process.env.ADMIN_EMAIL.toLowerCase() },
      data: { role: "ADMIN" },
    });
    console.log(`Admin accounts assigned: ${result.count}`);
  }
  console.log(
    "Seed complete: order templates ready. Existing balancing values preserved.",
  );
}
seed().finally(() => db.$disconnect());
