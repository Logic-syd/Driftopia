import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { LoggerService } from "@nestjs/common";
import { runtime } from "./runtime-config";

const buckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const measurements = new Map<
  string,
  { count: number; sum: number; buckets: number[] }
>();
let connections = () => 0;
export function trackConnections(read: () => number) {
  connections = read;
}
export function log(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: "driftopia-api",
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}
export const logger: LoggerService = {
  log: (message: unknown) =>
    log("info", { event: "application", message: String(message) }),
  warn: (message: unknown) =>
    log("warn", { event: "application", message: String(message) }),
  error: (message: unknown) =>
    log("error", {
      event: "application",
      errorType: message instanceof Error ? message.name : "ApplicationError",
    }),
};
export function reportError(error: unknown, requestId: string) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const stack =
    error instanceof Error
      ? error.stack
          ?.split("\n")
          .filter((line) => /^\s+at\s/.test(line))
          .slice(0, 6)
          .map((line) => line.trim())
      : [];
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code).slice(0, 40)
      : undefined;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ name, code, stack }))
    .digest("hex")
    .slice(0, 16);
  // Never log request bodies, headers, cookies, database URLs, or error messages that may embed SQL inputs.
  log("error", {
    event: "request_failed",
    requestId,
    name,
    code,
    fingerprint,
    stack,
  });
}
export function observeRequests(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const supplied = req.headers["x-request-id"];
  const requestId =
    typeof supplied === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(supplied)
      ? supplied
      : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("Cache-Control", "no-store");
  const started = performance.now();
  res.once("finish", () => {
    const duration = (performance.now() - started) / 1000;
    const route =
      typeof req.route?.path === "string" ? req.route.path : "unmatched";
    const method = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ].includes(req.method)
      ? req.method
      : "OTHER";
    const label = `method=${JSON.stringify(method)},route=${JSON.stringify(route)},status=${JSON.stringify(String(res.statusCode))}`;
    const item = measurements.get(label) ?? {
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    item.count++;
    item.sum += duration;
    buckets.forEach((bound, i) => {
      if (duration <= bound) item.buckets[i]++;
    });
    measurements.set(label, item);
    if (!["/api/health", "/api/ready", "/api/metrics"].includes(route)) {
      log(res.statusCode >= 500 ? "error" : "info", {
        event: "http_request",
        requestId,
        method,
        route,
        status: res.statusCode,
        durationMs: Math.round(duration * 1000),
      });
    }
  });
  next();
}
export function canReadMetrics(req: Request, production: boolean) {
  if (!runtime.METRICS_TOKEN) return !production;
  const provided = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expected = Buffer.from(runtime.METRICS_TOKEN);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function metrics() {
  const cpu = process.cpuUsage();
  const lines = [
    "# TYPE driftopia_http_requests_total counter",
    "# TYPE driftopia_http_request_duration_seconds histogram",
  ];
  for (const [labels, item] of measurements) {
    lines.push(`driftopia_http_requests_total{${labels}} ${item.count}`);
    buckets.forEach((bound, i) =>
      lines.push(
        `driftopia_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${item.buckets[i]}`,
      ),
    );
    lines.push(
      `driftopia_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`,
    );
    lines.push(
      `driftopia_http_request_duration_seconds_count{${labels}} ${item.count}`,
    );
    lines.push(
      `driftopia_http_request_duration_seconds_sum{${labels}} ${item.sum}`,
    );
  }
  lines.push(
    "# TYPE driftopia_websocket_connections gauge",
    `driftopia_websocket_connections ${connections()}`,
    "# TYPE process_resident_memory_bytes gauge",
    `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    "# TYPE process_cpu_user_seconds_total counter",
    `process_cpu_user_seconds_total ${cpu.user / 1e6}`,
    "# TYPE process_cpu_system_seconds_total counter",
    `process_cpu_system_seconds_total ${cpu.system / 1e6}`,
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime()}`,
  );
  return `${lines.join("\n")}\n`;
}
