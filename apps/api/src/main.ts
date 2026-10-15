import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  ArgumentsHost,
  ExecutionContext,
  Injectable,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
} from "@nestjs/throttler";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { db, env } from "./database";
import {
  authOptions,
  guest,
  login,
  logout,
  register,
  sessionUser,
} from "./auth";
import { Realtime, sessionHashFromCookie } from "./realtime";
import { explorationAction, explorationState } from "./exploration";
import {
  canReadMetrics,
  logger,
  log,
  metrics,
  observeRequests,
  reportError,
} from "./observability";
import { isTrustedProxy, runtime } from "./runtime-config";
import {
  adminConfig,
  buyListing,
  cancelListing,
  createListing,
  gameAction,
  leaderboard,
  mutate,
  marketList,
  publicPlayers,
  rebuildRankings,
  redis,
  state,
} from "./game";
import { RuleError } from "../../../packages/game-engine/src/index";
import {
  BUILDINGS,
  RESOURCES,
  RESOURCE_IDS,
} from "../../../packages/game-config/src/index";
let realtime: Realtime;
const key = (req: Request) =>
  z.string().uuid().parse(req.headers["idempotency-key"]);
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500,
      code = "INTERNAL",
      message = "海上信号暂时中断，请稍后再试";
    if (error instanceof RuleError) {
      code = error.code;
      message = error.message;
      status =
        code === "UNAUTHORIZED"
          ? 401
          : ["FORBIDDEN", "GUEST_DISABLED"].includes(code)
            ? 403
            : code === "AUTH_BUSY"
              ? 503
              : code === "GUEST_LIMIT"
                ? 429
                : code === "NOT_FOUND"
                  ? 404
                  : 409;
    } else if (error instanceof ZodError) {
      status = 400;
      code = "VALIDATION";
      message = error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      status = 409;
      code = "DUPLICATE";
      message = "邮箱已注册，或位置已经被占用";
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      status = 404;
      code = "NOT_FOUND";
      message = "记录不存在";
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = "HTTP_ERROR";
      message = error.message;
    } else reportError(error, response.locals.requestId as string);
    response
      .status(status)
      .json({ error: { code, message, requestId: response.locals.requestId } });
  }
}
@Controller("api")
class ApiController {
  @Get("health") @SkipThrottle() health() {
    return { ok: true, version: "0.4.0" };
  }
  @Get("ready") @SkipThrottle() async ready(
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      await db.$queryRaw`SELECT 1`;
      const migrations = await db.$queryRaw<
        { name: string }[]
      >`SELECT name FROM "_driftopia_migrations" WHERE name = '202610150001_exploration'`;
      if (!migrations.length) throw new Error("Schema migration required");
      const cache = await redis
        .ping()
        .then(() => true)
        .catch(() => false);
      return {
        ok: true,
        database: "connected",
        schema: "current",
        redis: cache ? "connected" : "unavailable",
        status: cache ? "ready" : "degraded",
      };
    } catch {
      res.status(503);
      return {
        ok: false,
        database: "unavailable_or_schema_outdated",
        status: "not_ready",
      };
    }
  }
  @Get("metrics") @SkipThrottle() monitoring(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!canReadMetrics(req, env.NODE_ENV === "production"))
      throw new RuleError("UNAUTHORIZED", "需要监控凭据");
    res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics());
  }
  @Get("auth/options") options() {
    return authOptions();
  }
  @Post("auth/guest")
  @Throttle({ default: { limit: runtime.GUEST_RATE_LIMIT, ttl: 60000 } })
  guest(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return guest(req, res);
  }
  @Post("auth/register")
  @Throttle({ default: { limit: runtime.AUTH_RATE_LIMIT, ttl: 60000 } })
  register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return register(body, res);
  }
  @Post("auth/login")
  @Throttle({ default: { limit: runtime.AUTH_RATE_LIMIT, ttl: 60000 } })
  login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return login(body, res);
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const hash = sessionHashFromCookie(req.headers.cookie);
    const result = await logout(req, res);
    if (hash) realtime.disconnectSession(hash);
    return result;
  }
  @Get("state") async state(@Req() req: Request) {
    const startedAt = Date.now();
    const user = await sessionUser(req);
    const snapshot = await state(user.id);
    if (
      snapshot.productionReport &&
      Date.parse(snapshot.productionReport.createdAt) >= startedAt
    ) {
      realtime.notifyUsers([user.id]);
    }
    return snapshot;
  }
  @Post("game/:action") async action(
    @Req() req: Request,
    @Param("action") action: string,
    @Body() body: unknown,
  ) {
    const user = await sessionUser(req);
    const result = await gameAction(user.id, key(req), action, body);
    realtime.notifyUsers([user.id]);
    realtime.notifyLeaderboard();
    return result;
  }
  @Get("exploration") async exploration(@Req() req: Request) {
    const user = await sessionUser(req);
    return explorationState(user.id);
  }
  @Post("exploration/:action") async explore(
    @Req() req: Request,
    @Param("action") action: string,
    @Body() body: unknown,
  ) {
    const user = await sessionUser(req);
    const result = await explorationAction(user.id, key(req), action, body);
    realtime.notifyUsers([user.id]);
    realtime.notifyLeaderboard();
    return result;
  }
  @Get("market") async market(
    @Req() req: Request,
    @Query("resource") resource?: string,
    @Query("mine") mine?: string,
  ) {
    const user = await sessionUser(req);
    const filter =
      resource === undefined ? undefined : z.enum(RESOURCE_IDS).parse(resource);
    const own = z.enum(["true", "false"]).parse(mine ?? "false") === "true";
    return marketList(user.id, filter, own);
  }
  @Post("market") async sell(@Req() req: Request, @Body() body: unknown) {
    const user = await sessionUser(req);
    const result = await createListing(user.id, key(req), body);
    realtime.notifyMarket();
    realtime.notifyUsers([user.id]);
    return result;
  }
  @Get("market/history") async history(@Req() req: Request) {
    const user = await sessionUser(req);
    return db.marketTransaction.findMany({
      where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  @Post("market/:id/buy") async buy(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const user = await sessionUser(req);
    const result = await buyListing(user.id, key(req), id, body);
    realtime.notifyMarket();
    const trade = (result as unknown as { trade: { sellerId: string } }).trade;
    realtime.notifyUsers([user.id, trade.sellerId]);
    realtime.notifyLeaderboard();
    return result;
  }
  @Post("market/:id/cancel") async cancel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const user = await sessionUser(req);
    const result = await cancelListing(user.id, key(req), id);
    realtime.notifyMarket();
    realtime.notifyUsers([user.id]);
    return result;
  }
  @Get("players") async players(@Req() req: Request, @Query("q") q = "") {
    await sessionUser(req);
    return (await publicPlayers(z.string().max(30).parse(q))).map((player) => ({
      ...player,
      online: realtime.isOnline(player.id),
    }));
  }
  @Get("players/:id/island") async visit(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    await sessionUser(req);
    const p = await db.user.findUnique({
      where: { id },
      select: {
        id: true,
        profile: { select: { name: true } },
        progress: { select: { xp: true, prosperity: true } },
        island: {
          select: {
            tiles: { select: { x: true, y: true } },
            buildings: {
              select: { id: true, kind: true, x: true, y: true, level: true },
            },
          },
        },
      },
    });
    if (!p) throw new RuleError("NOT_FOUND", "玩家不存在");
    return p;
  }
  @Get("friends") async friends(@Req() req: Request) {
    const user = await sessionUser(req);
    const friends = await db.friendship.findMany({
      where: { userId: user.id },
      include: {
        friend: {
          select: {
            id: true,
            profile: { select: { name: true } },
            progress: { select: { xp: true, prosperity: true } },
          },
        },
      },
    });
    return friends.map((entry) => ({
      ...entry,
      friend: { ...entry.friend, online: realtime.isOnline(entry.friendId) },
    }));
  }
  @Post("friends/:id") async addFriend(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const user = await sessionUser(req);
    if (id === user.id) throw new RuleError("SELF_FRIEND", "不能添加自己");
    if (!(await db.user.findUnique({ where: { id } })))
      throw new RuleError("NOT_FOUND", "玩家不存在");
    const result = await mutate(
      user.id,
      key(req),
      "friend:add",
      { id },
      async (tx) =>
        tx.friendship.upsert({
          where: { userId_friendId: { userId: user.id, friendId: id } },
          create: { userId: user.id, friendId: id },
          update: {},
        }),
    );
    realtime.notifyUsers([user.id], ["friends"]);
    return result;
  }
  @Get("leaderboard") async ranks(
    @Req() req: Request,
    @Query("type") type = "prosperity",
  ) {
    await sessionUser(req);
    return leaderboard(type);
  }
  @Get("admin") async admin(@Req() req: Request) {
    const user = await sessionUser(req);
    if (user.role !== "ADMIN")
      throw new RuleError("FORBIDDEN", "需要管理员权限");
    const [players, transactions, versions, orders, total, anomalies] =
      await Promise.all([
        db.user.findMany({
          select: {
            id: true,
            email: true,
            role: true,
            profile: true,
            progress: true,
          },
          take: 100,
          orderBy: { createdAt: "desc" },
        }),
        db.marketTransaction.findMany({
          take: 50,
          orderBy: { createdAt: "desc" },
        }),
        db.gameConfigVersion.findMany({ take: 30, orderBy: { id: "desc" } }),
        db.order.findMany(),
        db.playerProgress.aggregate({
          _sum: { coins: true, orders: true },
          _count: true,
        }),
        db.$queryRaw`SELECT id FROM "MarketTransaction" WHERE "buyerId" = "sellerId" OR total < 1 OR fee < 0 OR fee > total LIMIT 50`,
      ]);
    return {
      players,
      transactions,
      versions,
      orders,
      total,
      anomalies,
      buildings: BUILDINGS,
      resources: RESOURCES,
    };
  }
  @Post("admin/config") async config(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return adminConfig(await sessionUser(req), key(req), body);
  }
  @Post("admin/rebuild-rankings") async rebuild(@Req() req: Request) {
    const user = await sessionUser(req);
    if (user.role !== "ADMIN")
      throw new RuleError("FORBIDDEN", "需要管理员权限");
    await rebuildRankings();
    realtime.notifyLeaderboard();
    return { ok: true };
  }
}
// Route definitions are canonical even when Express accepts case and trailing-slash aliases.
function canonicalRoute(req: Request) {
  const route = typeof req.route?.path === "string" ? req.route.path : req.path;
  return route.toLowerCase().replace(/\/+$/, "");
}
@Injectable()
class PlayerRateLimit extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const route = canonicalRoute(req);
    if (
      [
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/guest",
        "/api/auth/options",
      ].includes(route)
    )
      return `ip:${req.ip}`;
    try {
      return `user:${(await sessionUser(req)).id}`;
    } catch (error) {
      if (error instanceof RuleError && error.code === "UNAUTHORIZED")
        return `ip:${req.ip}`;
      throw error;
    }
  }
  protected generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    const req = context.switchToHttp().getRequest<Request>();
    const route = canonicalRoute(req);
    const bucket =
      route === "/api/auth/guest"
        ? "guest"
        : ["/api/auth/register", "/api/auth/login"].includes(route)
          ? "auth"
          : route === "/api/auth/options"
            ? "public"
            : "game";
    return `${name}:${bucket}:${suffix}`;
  }
}
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: runtime.HTTP_RATE_LIMIT }]),
  ],
  controllers: [ApiController],
  providers: [{ provide: APP_GUARD, useClass: PlayerRateLimit }],
})
class AppModule {}
async function bootstrap() {
  await db.$connect();
  await redis.connect().catch(() => undefined);
  const app = await NestFactory.create(AppModule, { logger });
  const origins = env.WEB_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    env.NODE_ENV === "production" &&
    origins.some((origin) => !origin.startsWith("https://"))
  )
    throw new Error("Production WEB_ORIGINS must use HTTPS");
  app.getHttpAdapter().getInstance().set("trust proxy", isTrustedProxy);
  app.use(observeRequests);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: origins,
    credentials: true,
    exposedHeaders: ["X-Request-ID"],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && !origins.includes(req.headers.origin)))
    ) {
      return res.status(403).json({
        error: {
          code: "ORIGIN",
          message: "不允许的请求来源",
          requestId: res.locals.requestId,
        },
      });
    }
    next();
  });
  app.useGlobalFilters(new Errors());
  realtime = new Realtime(app.getHttpServer(), origins);
  await app.listen(env.PORT, "0.0.0.0");
  log("info", { event: "listening", port: env.PORT });
  const timer = setInterval(() => {
    rebuildRankings()
      .then(() => realtime.notifyLeaderboard())
      .catch(() => log("warn", { event: "ranking_rebuild_failed" }));
  }, 60000);
  timer.unref();
  const stop = async () => {
    clearInterval(timer);
    await realtime.close();
    await app.close();
    await db.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
void bootstrap().catch((error: unknown) => {
  reportError(error, "startup");
  process.exitCode = 1;
});
