import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
import type { Request, Response } from "express";
import type { Prisma, User } from "@prisma/client";
import { db, env } from "./database";
import { ECONOMY, SALVAGE } from "../../../packages/game-config/src/index";
import { RuleError } from "../../../packages/game-engine/src/index";
import {
  loginSchema,
  registerSchema,
} from "../../../packages/shared/src/index";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
let passwordWork = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (passwordWork >= env.AUTH_MAX_CONCURRENCY)
    throw new RuleError("AUTH_BUSY", "登录服务繁忙，请稍后重试");
  passwordWork++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, 64, (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
  } finally {
    passwordWork--;
  }
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
async function passwordMatches(password: string, hash: string) {
  const [salt, digest] = hash.split(":");
  if (
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(digest ?? "")
  )
    return false;
  return timingSafeEqual(
    await derive(password, salt),
    Buffer.from(digest, "hex"),
  );
}
const requests = new WeakMap<Request, Promise<User>>();
export function sessionUser(req: Request): Promise<User> {
  const existing = requests.get(req);
  if (existing) return existing;
  const result = (async () => {
    const token: unknown = req.cookies?.driftopia_session;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      throw new RuleError("UNAUTHORIZED", "请先登录");
    const session = await db.session.findUnique({
      where: { tokenHash: tokenHash(token) },
      include: { user: true },
    });
    const now = new Date();
    if (
      !session ||
      session.expiresAt <= now ||
      (session.user.isGuest &&
        (!session.user.guestExpiresAt || session.user.guestExpiresAt <= now))
    )
      throw new RuleError("UNAUTHORIZED", "登录已过期，请重新登录");
    return session.user;
  })();
  requests.set(req, result);
  return result;
}
function setCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie("driftopia_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}
async function createSession(
  tx: Prisma.TransactionClient,
  userId: string,
  expiresAt: Date,
) {
  const token = randomBytes(32).toString("hex");
  await tx.session.create({
    data: { tokenHash: tokenHash(token), userId, expiresAt },
  });
  return token;
}
function baseData(
  email: string,
  name: string,
  hash: string,
): Prisma.UserCreateInput {
  const positions = [
    [12, 32],
    [80, 25],
    [87, 62],
    [18, 75],
    [51, 15],
    [55, 86],
  ];
  return {
    email,
    passwordHash: hash,
    profile: { create: { name } },
    progress: { create: { coins: ECONOMY.initialCoins } },
    inventory: { create: { resources: ECONOMY.initial } },
    island: {
      create: {
        tiles: {
          create: Array.from({ length: 9 }, (_, i) => ({
            x: (i % 3) - 1,
            y: Math.floor(i / 3) - 1,
          })),
        },
      },
    },
    salvage: {
      create: SALVAGE.map((s, i) => ({
        kind: s.kind,
        reward: s.reward,
        x: positions[i][0],
        y: positions[i][1],
        expiresAt: new Date(Date.now() + 180000),
      })),
    },
  };
}
export async function register(raw: unknown, res: Response) {
  const data = registerSchema.parse(raw),
    hash = await passwordHash(data.password),
    expiresAt = new Date(Date.now() + 7 * 86400000);
  const result = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: baseData(data.email, data.name, hash),
    });
    const token = await createSession(tx, user.id, expiresAt);
    return { user, token };
  });
  setCookie(res, result.token, expiresAt);
  return { id: result.user.id, name: data.name };
}
export async function login(raw: unknown, res: Response) {
  const data = loginSchema.parse(raw),
    user = await db.user.findUnique({
      where: { email: data.email },
      include: { profile: true },
    });
  const valid = await passwordMatches(
    data.password,
    user?.isGuest
      ? `${"0".repeat(32)}:${"0".repeat(128)}`
      : (user?.passwordHash ?? `${"0".repeat(32)}:${"0".repeat(128)}`),
  );
  if (!user || user.isGuest || !valid)
    throw new RuleError("UNAUTHORIZED", "邮箱或密码不正确");
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  const token = await db.$transaction((tx) =>
    createSession(tx, user.id, expiresAt),
  );
  setCookie(res, token, expiresAt);
  return { id: user.id, name: user.profile!.name };
}
export const authOptions = () => ({ guestEnabled: env.GUEST_ENABLED });
export async function guest(req: Request, res: Response) {
  if (!env.GUEST_ENABLED)
    throw new RuleError("GUEST_DISABLED", "体验模式暂未开放");
  try {
    const current = await sessionUser(req);
    return {
      id: current.id,
      name: (
        await db.playerProfile.findUniqueOrThrow({
          where: { userId: current.id },
        })
      ).name,
    };
  } catch (error) {
    if (!(error instanceof RuleError && error.code === "UNAUTHORIZED"))
      throw error;
  }
  const expiresAt = new Date(Date.now() + env.GUEST_TTL_HOURS * 3600000);
  const result = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('driftopia:guest-quota'))`;
      const total = await tx.user.count({ where: { isGuest: true } });
      const daily = await tx.user.count({
        where: {
          isGuest: true,
          createdAt: { gte: new Date(Date.now() - 86400000) },
        },
      });
      if (total >= env.GUEST_TOTAL_LIMIT || daily >= env.GUEST_DAILY_LIMIT)
        throw new RuleError("GUEST_LIMIT", "今日体验名额已满，请注册账号游玩");
      const suffix = randomUUID(),
        name = `漂流体验者${suffix.slice(0, 4)}`;
      // Guest accounts have no reusable password; their server session has a fixed lifetime.
      const user = await tx.user.create({
        data: {
          ...baseData(
            `guest-${suffix}@driftopia.invalid`,
            name,
            "guest-disabled",
          ),
          isGuest: true,
          guestExpiresAt: expiresAt,
        },
      });
      const token = await createSession(tx, user.id, expiresAt);
      return { user, token, name };
    },
    { timeout: 15000, maxWait: 10000 },
  );
  setCookie(res, result.token, expiresAt);
  return { id: result.user.id, name: result.name };
}
export async function logout(req: Request, res: Response) {
  const token: unknown = req.cookies?.driftopia_session;
  if (typeof token === "string")
    await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  res.clearCookie("driftopia_session", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
  });
  return { ok: true };
}
