import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(20),
    GUEST_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    GUEST_DAILY_LIMIT: z.coerce.number().int().min(1).max(10000).default(100),
    GUEST_TOTAL_LIMIT: z.coerce.number().int().min(1).max(100000).default(500),
    GUEST_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(24),
    AUTH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
    WEB_ORIGINS: z
      .string()
      .default("http://localhost:5173,http://localhost:5174"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .parse(process.env);
export const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    application_name: "driftopia-api",
  }),
});
