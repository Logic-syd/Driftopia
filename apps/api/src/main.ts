import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import {
  ArgumentsHost,
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
import { Throttle, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Server } from "socket.io";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { db, env } from "./database";
import { login, logout, register, sessionUser, tokenHash } from "./auth";
import {
  adminConfig,
  buyListing,
  cancelListing,
  createListing,
  gameAction,
  leaderboard,
  mutate,
  publicPlayers,
  rebuildRankings,
  redis,
  state,
} from "./game";
import { RuleError } from "../../../packages/game-engine/src/index";
import { BUILDINGS, RESOURCES } from "../../../packages/game-config/src/index";
let io: Server;
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
      status = code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : 409;
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
    } else
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
    response.status(status).json({ error: { code, message } });
  }
}
@Controller("api")
class ApiController {
  @Get("health") async health() {
    await db.$queryRaw`SELECT 1`;
    const cache = await redis
      .ping()
      .then(() => true)
      .catch(() => false);
    return {
      ok: true,
      database: "connected",
      redis: cache ? "connected" : "unavailable",
      version: "0.2.0",
    };
  }
  @Post("auth/register")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return register(body, res);
  }
  @Post("auth/login") @Throttle({ default: { limit: 10, ttl: 60000 } }) login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return login(body, res);
  }
  @Post("auth/logout") logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return logout(req, res);
  }
  @Get("state") async state(@Req() req: Request) {
    return state((await sessionUser(req)).id);
  }
  @Post("game/:action") async action(
    @Req() req: Request,
    @Param("action") action: string,
    @Body() body: unknown,
  ) {
    const user = await sessionUser(req);
    const result = await gameAction(user.id, key(req), action, body);
    io.to(user.id).emit("state:changed");
    return result;
  }
  @Get("market") async market(
    @Req() req: Request,
    @Query("resource") resource?: string,
  ) {
    await sessionUser(req);
    return db.marketListing.findMany({
      where: { status: "ACTIVE", ...(resource ? { resource } : {}) },
      include: { seller: { select: { profile: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Post("market") async sell(@Req() req: Request, @Body() body: unknown) {
    const user = await sessionUser(req);
    const result = await createListing(user.id, key(req), body);
    io.emit("market:changed");
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
    io.emit("market:changed");
    return result;
  }
  @Post("market/:id/cancel") async cancel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const user = await sessionUser(req);
    const result = await cancelListing(user.id, key(req), id);
    io.emit("market:changed");
    return result;
  }
  @Get("players") async players(@Req() req: Request, @Query("q") q = "") {
    await sessionUser(req);
    return publicPlayers(q.slice(0, 30));
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
    return db.friendship.findMany({
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
  }
  @Post("friends/:id") async addFriend(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const user = await sessionUser(req);
    if (id === user.id) throw new RuleError("SELF_FRIEND", "不能添加自己");
    if (!(await db.user.findUnique({ where: { id } })))
      throw new RuleError("NOT_FOUND", "玩家不存在");
    return mutate(user.id, key(req), "friend:add", { id }, async (tx) =>
      tx.friendship.upsert({
        where: { userId_friendId: { userId: user.id, friendId: id } },
        create: { userId: user.id, friendId: id },
        update: {},
      }),
    );
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
    return { ok: true };
  }
}
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 240 }])],
  controllers: [ApiController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class AppModule {}
async function bootstrap() {
  await db.$connect();
  await redis.connect().catch(() => undefined);
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });
  const origins = env.WEB_ORIGINS.split(",");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: origins, credentials: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      !origins.includes(req.headers.origin)
    )
      return res
        .status(403)
        .json({ error: { code: "ORIGIN", message: "不允许的请求来源" } });
    next();
  });
  app.useGlobalFilters(new Errors());
  io = new Server(app.getHttpServer(), {
    cors: { origin: origins, credentials: true },
  });
  io.use(async (socket, next) => {
    try {
      const cookie = socket.handshake.headers.cookie
        ?.split(";")
        .find((v) => v.trim().startsWith("driftopia_session="))
        ?.trim()
        .split("=")[1];
      if (!cookie) return next(new Error("Unauthorized"));
      const session = await db.session.findUnique({
        where: { tokenHash: tokenHash(cookie) },
      });
      if (!session || session.expiresAt < new Date())
        return next(new Error("Unauthorized"));
      socket.data.userId = session.userId;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });
  io.on("connection", (socket) => socket.join(socket.data.userId as string));
  await app.listen(env.PORT, "0.0.0.0");
  console.log(`Driftopia API listening on ${env.PORT}`);
  const timer = setInterval(() => {
    rebuildRankings().catch(() => undefined);
  }, 60000);
  timer.unref();
  const stop = async () => {
    clearInterval(timer);
    io.close();
    await app.close();
    await db.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
void bootstrap();
