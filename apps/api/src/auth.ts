import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { Request, Response } from "express";
import { db, env } from "./database";
import { ECONOMY, SALVAGE } from "../../../packages/game-config/src/index";
import { RuleError } from "../../../packages/game-engine/src/index";
import {
  loginSchema,
  registerSchema,
} from "../../../packages/shared/src/index";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordMatches(password: string, hash: string) {
  const [salt, digest] = hash.split(":");
  const input = scryptSync(password, salt, 64);
  return timingSafeEqual(input, Buffer.from(digest, "hex"));
}
export async function sessionUser(req: Request) {
  const token = req.cookies?.driftopia_session as unknown;
  if (typeof token !== "string")
    throw new RuleError("UNAUTHORIZED", "请先登录");
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date())
    throw new RuleError("UNAUTHORIZED", "登录已过期，请重新登录");
  return session.user;
}
async function setSession(userId: string, res: Response) {
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      tokenHash: tokenHash(token),
      userId,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  res.cookie("driftopia_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 7 * 86400000,
    path: "/",
  });
}
export async function register(raw: unknown, res: Response) {
  const data = registerSchema.parse(raw);
  const positions = [
    [12, 32],
    [80, 25],
    [87, 62],
    [18, 75],
    [51, 15],
    [55, 86],
  ];
  const user = await db.user.create({
    data: {
      email: data.email,
      passwordHash: passwordHash(data.password),
      profile: { create: { name: data.name } },
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
    },
  });
  await setSession(user.id, res);
  return { id: user.id, name: data.name };
}
export async function login(raw: unknown, res: Response) {
  const data = loginSchema.parse(raw),
    user = await db.user.findUnique({
      where: { email: data.email },
      include: { profile: true },
    });
  // Run scrypt on failed lookups too, so account existence is not disclosed by timing.
  const valid = passwordMatches(
    data.password,
    user?.passwordHash ?? `${"0".repeat(32)}:${"0".repeat(128)}`,
  );
  if (!user || !valid) throw new RuleError("UNAUTHORIZED", "邮箱或密码不正确");
  await setSession(user.id, res);
  return { id: user.id, name: user.profile!.name };
}
export async function logout(req: Request, res: Response) {
  const token = req.cookies?.driftopia_session as unknown;
  if (typeof token === "string")
    await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  res.clearCookie("driftopia_session", { path: "/" });
  return { ok: true };
}
