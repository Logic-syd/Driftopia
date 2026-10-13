import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { db } from "../apps/api/src/database";
import { tokenHash } from "../apps/api/src/auth";
import { Realtime } from "../apps/api/src/realtime";
import { reportError } from "../apps/api/src/observability";

const origin = "http://localhost:5173";
const api = process.env.TEST_API_URL ?? "http://127.0.0.1:3001";
const http = createServer();
const accounts: string[] = [];
const sockets: Socket[] = [];
let realtime: Realtime;
let base: string;
type Envelope = {
  eventId: string;
  epoch: string;
  sequence: number;
  topics: string[];
  emittedAt: string;
};
async function account(expiresIn = 3600000) {
  const user = await db.user.create({
    data: {
      email: `socket-${randomUUID()}@example.test`,
      passwordHash: "session-only-test-fixture",
      profile: { create: { name: "Socket 测试员" } },
    },
  });
  accounts.push(user.id);
  const token = randomBytes(32).toString("hex");
  const hash = tokenHash(token);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + expiresIn),
    },
  });
  return { id: user.id, hash, cookie: `driftopia_session=${token}` };
}
function client(
  cookie?: string,
  options: { origin?: string; base?: string } = {},
) {
  const socket = io(options.base ?? base, {
    autoConnect: false,
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: options.origin ?? origin,
    },
  });
  sockets.push(socket);
  return socket;
}
function once<T>(socket: Socket, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function handler(value: T) {
      clearTimeout(timer);
      resolve(value);
    }
    socket.once(event, handler);
  });
}
async function connect(socket: Socket) {
  const ready = once<{ epoch: string; sequence: number; emittedAt: string }>(
    socket,
    "sync:ready",
  );
  socket.connect();
  return ready;
}
beforeAll(async () => {
  await db.$connect();
  realtime = new Realtime(http, [origin]);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  vi.restoreAllMocks();
  await new Promise((resolve) => setTimeout(resolve, 30));
});
afterAll(async () => {
  await realtime.close();
  await db.user.deleteMany({ where: { id: { in: accounts } } });
  await db.$disconnect();
});
describe.sequential("authenticated realtime and operational HTTP", () => {
  it("rejects missing, unknown, and expired sessions against real PostgreSQL", async () => {
    const expired = await account(-1000);
    for (const cookie of [
      undefined,
      `driftopia_session=${"a".repeat(64)}`,
      expired.cookie,
    ]) {
      const socket = client(cookie);
      const error = once<Error>(socket, "connect_error");
      socket.connect();
      expect((await error).message).toBe("UNAUTHORIZED");
      expect(socket.connected).toBe(false);
    }
  });
  it("rejects a cross-origin WebSocket handshake even with a valid cookie", async () => {
    const user = await account();
    const socket = client(user.cookie, { origin: "https://attacker.example" });
    const rejected = once<Error>(socket, "connect_error");
    socket.connect();
    expect((await rejected).message).toContain("websocket error");
    expect(realtime.isOnline(user.id)).toBe(false);
  });
  it("assigns private rooms on the server and ignores forged join messages", async () => {
    const a = await account(),
      b = await account();
    const aSocket = client(a.cookie),
      bSocket = client(b.cookie);
    await Promise.all([connect(aSocket), connect(bSocket)]);
    const received: Envelope[] = [];
    aSocket.on("sync:invalidate", (event: Envelope) => received.push(event));
    aSocket.emit("join", `user:${b.id}`);
    const delivery = once<Envelope>(bSocket, "sync:invalidate");
    realtime.notifyUsers([b.id]);
    expect((await delivery).topics).toEqual(["state"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(0);
  });
  it("provides unique ordered events, coalesces broadcasts, and resynchronizes reconnects", async () => {
    const user = await account(),
      socket = client(user.cookie);
    const ready = await connect(socket);
    const received: Envelope[] = [];
    const delivery = new Promise<void>((resolve) =>
      socket.on("sync:invalidate", (event: Envelope) => {
        received.push(event);
        if (received.length === 3) resolve();
      }),
    );
    realtime.notifyUsers([user.id]);
    realtime.notifyUsers([user.id], ["friends"]);
    for (let i = 0; i < 20; i++) {
      realtime.notifyMarket();
      realtime.notifyLeaderboard();
    }
    await delivery;
    expect(new Set(received.map((event) => event.eventId)).size).toBe(3);
    expect(
      received.every(
        (event) =>
          event.epoch === ready.epoch && event.sequence > ready.sequence,
      ),
    ).toBe(true);
    expect(received.map((event) => event.sequence)).toEqual(
      [...received.map((event) => event.sequence)].sort((a, b) => a - b),
    );
    expect(received[2].topics.sort()).toEqual(["leaderboard", "market"]);
    socket.disconnect();
    const recovered = await connect(socket);
    expect(recovered.epoch).toBe(ready.epoch);
    expect(recovered.sequence).toBeGreaterThanOrEqual(received[2].sequence);
  });
  it("notifies only followers when a player comes online and goes offline", async () => {
    const follower = await account(),
      friend = await account(),
      stranger = await account();
    await db.friendship.create({
      data: { userId: follower.id, friendId: friend.id },
    });
    const followerSocket = client(follower.cookie),
      strangerSocket = client(stranger.cookie);
    await Promise.all([connect(followerSocket), connect(strangerSocket)]);
    const strangerEvents: Envelope[] = [];
    strangerSocket.on("sync:invalidate", (event: Envelope) =>
      strangerEvents.push(event),
    );
    const online = once<Envelope>(followerSocket, "sync:invalidate");
    const friendSocket = client(friend.cookie);
    await connect(friendSocket);
    expect((await online).topics).toEqual(["friends"]);
    expect(realtime.isOnline(friend.id)).toBe(true);
    const offline = once<Envelope>(followerSocket, "sync:invalidate");
    friendSocket.disconnect();
    expect((await offline).topics).toEqual(["friends"]);
    expect(realtime.isOnline(friend.id)).toBe(false);
    expect(strangerEvents).toHaveLength(0);
  });
  it("disconnects a database-revoked session and rejects reconnection", async () => {
    const user = await account(),
      socket = client(user.cookie);
    await connect(socket);
    await db.session.delete({ where: { tokenHash: user.hash } });
    const expired = once<void>(socket, "session:expired");
    const disconnected = once<string>(socket, "disconnect");
    await realtime.verifySessions();
    await expired;
    expect(await disconnected).toBe("io server disconnect");
    const rejected = once<Error>(socket, "connect_error");
    socket.connect();
    expect((await rejected).message).toBe("UNAUTHORIZED");
  });
  it("disconnects at the exact server-side session expiry", async () => {
    const user = await account(1500),
      socket = client(user.cookie);
    await connect(socket);
    const expired = once<void>(socket, "session:expired");
    const disconnected = once<string>(socket, "disconnect");
    await expired;
    expect(await disconnected).toBe("io server disconnect");
  });
  it("does not leak connection slots when transport closes during a real PostgreSQL authentication query", async () => {
    const user = await account();
    let queried!: () => void, resume!: () => void;
    const queryStarted = new Promise<void>((resolve) => {
      queried = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalQuery = db.session.findUnique;
    const realQuery = originalQuery.bind(db.session);
    // Only delay delivery of a real PostgreSQL result; do not fabricate an authenticated session.
    db.session.findUnique = ((
      args: Parameters<typeof db.session.findUnique>[0],
    ) => {
      return realQuery(args).then(async (result) => {
        queried();
        await paused;
        return result;
      });
      // The handshake awaits this query; the test deliberately substitutes a plain Promise
      // to delay delivery while preserving the actual PostgreSQL result.
    }) as unknown as typeof db.session.findUnique;
    const closedOnServer = new Promise<void>((resolve) =>
      realtime.io.engine.once("connection", (connection) =>
        connection.once("close", () => resolve()),
      ),
    );
    const interrupted = client(user.cookie);
    interrupted.connect();
    try {
      await queryStarted;
      interrupted.io.engine.close();
      await closedOnServer;
    } finally {
      resume();
      db.session.findUnique = originalQuery;
    }
    const attempts = Array.from({ length: 4 }, () => client(user.cookie));
    const results = await Promise.all(
      attempts.map(
        (socket) =>
          new Promise<string>((resolve) => {
            socket.once("connect", () => resolve("connected"));
            socket.once("connect_error", (error: Error) =>
              resolve(error.message),
            );
            socket.connect();
          }),
      ),
    );
    expect(results).toEqual([
      "connected",
      "connected",
      "connected",
      "connected",
    ]);
  });
  it("enforces the per-user limit during simultaneous handshakes", async () => {
    const user = await account();
    const attempts = Array.from({ length: 5 }, () => client(user.cookie));
    const results = await Promise.all(
      attempts.map(
        (socket) =>
          new Promise<string>((resolve) => {
            socket.once("connect", () => resolve("connected"));
            socket.once("connect_error", (error: Error) =>
              resolve(error.message),
            );
            socket.connect();
          }),
      ),
    );
    expect(results.filter((result) => result === "connected")).toHaveLength(4);
    expect(
      results.filter((result) => result === "CONNECTION_LIMIT"),
    ).toHaveLength(1);
  });
  it("disconnects abusive client messages instead of accepting room commands", async () => {
    const user = await account(),
      socket = client(user.cookie);
    await connect(socket);
    const disconnected = once<string>(socket, "disconnect");
    for (let i = 0; i < 21; i++) socket.emit("join", "admin");
    expect(await disconnected).toBe("io server disconnect");
  });
  it("revokes a live socket immediately through the real HTTP logout route", async () => {
    const user = await account(),
      socket = client(user.cookie, { base: api });
    await connect(socket);
    const expired = once<void>(socket, "session:expired");
    const disconnected = once<string>(socket, "disconnect");
    const response = await fetch(`${api}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: user.cookie, Origin: origin },
    });
    expect(response.status).toBe(201);
    await expired;
    expect(await disconnected).toBe("io server disconnect");
    expect(await db.session.count({ where: { tokenHash: user.hash } })).toBe(0);
  });
  it("exposes separate liveness, schema-aware readiness, bounded metrics and request IDs", async () => {
    const requestId = `realtime-test-${randomUUID()}`;
    const health = await fetch(`${api}/api/health`, {
      headers: { "X-Request-ID": requestId },
    });
    expect(health.headers.get("x-request-id")).toBe(requestId);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toMatchObject({ ok: true });
    const ready = await fetch(`${api}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      schema: "current",
      database: "connected",
    });
    const metrics = await fetch(`${api}/api/metrics`, {
      headers: process.env.METRICS_TOKEN
        ? { Authorization: `Bearer ${process.env.METRICS_TOKEN}` }
        : {},
    });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("driftopia_websocket_connections");
    expect(text).toContain("process_resident_memory_bytes");
    expect(text).toContain("driftopia_http_request_duration_seconds_bucket");
    const unauthorized = await fetch(`${api}/api/state`, {
      headers: { "X-Request-ID": requestId },
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: "UNAUTHORIZED", requestId },
    });
  });
  it("shares authentication IP quotas across route aliases and different signed-in accounts", async () => {
    const users = [await account(), await account()];
    // An isolated source address preserves the normal browser/CI IP quota; defaults stay enabled.
    const octets = randomBytes(2);
    const localAddress = `127.77.${octets[0]}.${octets[1]}`;
    const send = (path: string, method: string, cookie: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          new URL(path, api),
          {
            method,
            localAddress,
            headers: {
              Cookie: cookie,
              Origin: origin,
              "Content-Type": "application/json",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode!));
          },
        );
        req.once("error", reject);
        req.setTimeout(5000, () =>
          req.destroy(new Error("HTTP alias test timeout")),
        );
        req.end(method === "POST" ? "{}" : undefined);
      });
    const aliases = [
      "/api/auth/register",
      "/API/AUTH/register/",
      "/api/auth/login/",
      "/API/AUTH/LOGIN",
    ];
    for (let i = 0; i < 10; i++) {
      expect(
        await send(aliases[i % aliases.length], "POST", users[i % 2].cookie),
      ).toBe(400);
    }
    expect(await send("/API/AUTH/REGISTER/", "POST", users[0].cookie)).toBe(
      429,
    );
    expect(await send("/api/auth/login", "POST", users[1].cookie)).toBe(429);
    // Reading options and resuming a guest use independent buckets.
    expect(await send("/API/AUTH/OPTIONS/", "GET", users[0].cookie)).toBe(200);
    const guestAliases = [
      "/api/auth/guest",
      "/API/AUTH/GUEST/",
      "/Api/Auth/Guest",
    ];
    for (let i = 0; i < guestAliases.length; i++) {
      expect(await send(guestAliases[i], "POST", users[i % 2].cookie)).toBe(
        201,
      );
    }
    expect(await send("/api/auth/guest/", "POST", users[0].cookie)).toBe(429);
    expect(await send("/API/AUTH/LOGOUT/", "POST", users[1].cookie)).toBe(201);
  });
  it("does not log secrets embedded in multiline error messages", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("SQL failure\nsecret-password-or-cookie");
    reportError(error, "request-123");
    expect(spy).toHaveBeenCalledOnce();
    const output = String(spy.mock.calls[0][0]);
    expect(output).toContain("request-123");
    expect(output).toContain("fingerprint");
    expect(output).not.toContain("secret-password-or-cookie");
  });
});
