import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { db } from "./database";
import { tokenHash } from "./auth";
import { clientAddress, runtime } from "./runtime-config";
import { log, trackConnections } from "./observability";

export type SyncTopic = "state" | "market" | "friends" | "leaderboard";
export function sessionHashFromCookie(cookie?: string) {
  const token = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("driftopia_session="))
    ?.slice("driftopia_session=".length);
  return token && /^[a-f0-9]{64}$/.test(token) ? tokenHash(token) : undefined;
}

export class Realtime {
  readonly io: Server;
  readonly epoch = randomUUID();
  private sequence = 0;
  private online = new Map<string, Set<string>>();
  private addresses = new Map<string, number>();
  private reservedUsers = new Map<string, number>();
  private reservedCount = 0;
  private timer: ReturnType<typeof setInterval>;
  private checking = false;
  private closing = false;
  private pendingTopics = new Set<SyncTopic>();
  private broadcastTimer?: ReturnType<typeof setTimeout>;

  constructor(
    http: HttpServer,
    origins: string[],
    options: { sessionCheckMs?: number } = {},
  ) {
    this.io = new Server(http, {
      cors: { origin: origins, credentials: true },
      maxHttpBufferSize: 4096,
      pingInterval: 25000,
      pingTimeout: 20000,
      allowRequest: (req, done) => {
        const origin = req.headers.origin;
        done(
          null,
          (this.io?.engine.clientsCount ?? 0) < runtime.WS_MAX_CONNECTIONS &&
            req.headers["sec-fetch-site"] !== "cross-site" &&
            (!origin || origins.includes(origin)),
        );
      },
    });
    trackConnections(() => this.io.engine.clientsCount);
    this.io.use(async (socket, next) => {
      try {
        const hash = sessionHashFromCookie(socket.handshake.headers.cookie);
        if (!hash) return next(new Error("UNAUTHORIZED"));
        const session = await db.session.findUnique({
          where: { tokenHash: hash },
          include: { user: { select: { guestExpiresAt: true } } },
        });
        // The client may have closed while PostgreSQL authenticated the session.
        // Registering close listeners after that point would leak a reserved slot.
        if (socket.conn.readyState !== "open")
          return next(new Error("CONNECTION_CLOSED"));
        const now = new Date();
        if (
          !session ||
          session.expiresAt <= now ||
          (session.user.guestExpiresAt && session.user.guestExpiresAt <= now)
        )
          return next(new Error("UNAUTHORIZED"));
        const address = clientAddress(socket.request);
        if (
          this.reservedCount >= runtime.WS_MAX_CONNECTIONS ||
          (this.addresses.get(address) ?? 0) >= runtime.WS_MAX_PER_IP ||
          (this.reservedUsers.get(session.userId) ?? 0) >=
            runtime.WS_MAX_PER_USER
        )
          return next(new Error("CONNECTION_LIMIT"));
        // Reserve synchronously before next() so parallel handshakes cannot exceed a limit.
        this.reservedCount++;
        this.addresses.set(address, (this.addresses.get(address) ?? 0) + 1);
        this.reservedUsers.set(
          session.userId,
          (this.reservedUsers.get(session.userId) ?? 0) + 1,
        );
        socket.data = {
          userId: session.userId,
          sessionHash: hash,
          address,
          expiresAt: Math.min(
            session.expiresAt.getTime(),
            session.user.guestExpiresAt?.getTime() ?? Infinity,
          ),
        };
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.reservedCount--;
          this.decrement(this.addresses, address);
          this.decrement(this.reservedUsers, session.userId);
        };
        socket.conn.once("close", release);
        socket.once("disconnect", release);
        next();
      } catch {
        next(new Error("UNAUTHORIZED"));
      }
    });
    this.io.on("connection", (socket) => {
      const id = socket.data.userId as string;
      const existing = this.online.get(id) ?? new Set<string>();
      const first = existing.size === 0;
      existing.add(socket.id);
      this.online.set(id, existing);
      void socket.join(`user:${id}`);
      void socket.join(`session:${socket.data.sessionHash as string}`);
      socket.emit("sync:ready", {
        epoch: this.epoch,
        sequence: this.sequence,
        emittedAt: new Date().toISOString(),
      });
      if (first) void this.notifyFollowers(id);
      // No client message can select a room or mutate state. Close abusive senders.
      let messages = 0;
      let windowStart = Date.now();
      socket.onAny(() => {
        if (Date.now() - windowStart > 60000) {
          messages = 0;
          windowStart = Date.now();
        }
        if (++messages > 20) socket.disconnect(true);
      });
      const expiry = setTimeout(
        () => this.expire(socket),
        Math.max(0, (socket.data.expiresAt as number) - Date.now()),
      );
      expiry.unref();
      socket.once("disconnect", () => {
        clearTimeout(expiry);
        const sockets = this.online.get(id);
        sockets?.delete(socket.id);
        if (!sockets?.size) {
          this.online.delete(id);
          if (!this.closing) void this.notifyFollowers(id);
        }
      });
    });
    this.timer = setInterval(
      () => void this.verifySessions(),
      options.sessionCheckMs ?? 15000,
    );
    this.timer.unref();
  }
  private decrement(map: Map<string, number>, key: string) {
    const value = (map.get(key) ?? 1) - 1;
    if (value > 0) map.set(key, value);
    else map.delete(key);
  }
  private envelope(topics: SyncTopic[]) {
    return {
      eventId: randomUUID(),
      epoch: this.epoch,
      sequence: ++this.sequence,
      topics,
      emittedAt: new Date().toISOString(),
    };
  }
  notifyUsers(ids: string[], topics: SyncTopic[] = ["state"]) {
    if (ids.length)
      this.io
        .to([...new Set(ids)].map((id) => `user:${id}`))
        .emit("sync:invalidate", this.envelope(topics));
  }
  private broadcast(topic: SyncTopic) {
    this.pendingTopics.add(topic);
    if (this.broadcastTimer) return;
    // Hundreds of simultaneous trades produce one invalidation, not a refresh storm.
    this.broadcastTimer = setTimeout(() => {
      this.io.emit("sync:invalidate", this.envelope([...this.pendingTopics]));
      this.pendingTopics.clear();
      this.broadcastTimer = undefined;
    }, 200);
    this.broadcastTimer.unref();
  }
  notifyMarket() {
    this.broadcast("market");
  }
  notifyLeaderboard() {
    this.broadcast("leaderboard");
  }
  isOnline(id: string) {
    return this.online.has(id);
  }
  async notifyFollowers(id: string) {
    try {
      const followers = await db.friendship.findMany({
        where: { friendId: id },
        select: { userId: true },
      });
      this.notifyUsers(
        followers.map((f) => f.userId),
        ["friends"],
      );
    } catch {
      log("warn", { event: "presence_notification_failed" });
    }
  }
  disconnectSession(hash: string) {
    for (const socket of this.io.sockets.sockets.values())
      if (socket.data.sessionHash === hash) this.expire(socket);
  }
  private expire(socket: Socket) {
    socket.emit("session:expired");
    socket.disconnect(true);
  }
  async verifySessions() {
    if (this.checking || this.closing) return;
    this.checking = true;
    try {
      const sockets = [...this.io.sockets.sockets.values()];
      const hashes = [
        ...new Set(sockets.map((socket) => socket.data.sessionHash as string)),
      ];
      if (!hashes.length) return;
      const now = new Date();
      const sessions = await db.session.findMany({
        where: {
          tokenHash: { in: hashes },
          expiresAt: { gt: now },
          user: {
            OR: [{ guestExpiresAt: null }, { guestExpiresAt: { gt: now } }],
          },
        },
        select: { tokenHash: true },
      });
      const active = new Set(sessions.map((session) => session.tokenHash));
      for (const socket of sockets)
        if (!active.has(socket.data.sessionHash as string)) this.expire(socket);
    } catch {
      // A failed authentication recheck fails closed; reconnect will revalidate against PostgreSQL.
      for (const socket of this.io.sockets.sockets.values())
        this.expire(socket);
      log("warn", { event: "socket_session_check_failed" });
    } finally {
      this.checking = false;
    }
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    clearTimeout(this.broadcastTimer);
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
  }
}
