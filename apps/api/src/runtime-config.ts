import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { z } from "zod";

const positive = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);
export const runtime = z
  .object({
    TRUST_PROXY: z.string().default(""),
    METRICS_TOKEN: z.string().min(32).optional(),
    WS_MAX_CONNECTIONS: positive(1000),
    WS_MAX_PER_IP: positive(600),
    WS_MAX_PER_USER: positive(4),
    HTTP_RATE_LIMIT: positive(240),
    AUTH_RATE_LIMIT: positive(10),
    GUEST_RATE_LIMIT: positive(3),
  })
  .parse(process.env);

const trusted = new BlockList();
const cleanAddress = (address: string) => address.replace(/^::ffff:/, "");
for (const entry of runtime.TRUST_PROXY.split(",")
  .map((v) => v.trim())
  .filter(Boolean)) {
  const ranges = entry === "loopback" ? ["127.0.0.0/8", "::1/128"] : [entry];
  for (const range of ranges) {
    const [rawAddress, prefix] = range.split("/");
    const address = cleanAddress(rawAddress);
    const family = isIP(address);
    if (
      !family ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || +prefix > (family === 4 ? 32 : 128)))
    ) {
      throw new Error(
        "TRUST_PROXY must contain explicit IP addresses, CIDRs, or loopback",
      );
    }
    if (prefix === undefined)
      trusted.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else trusted.addSubnet(address, +prefix, family === 4 ? "ipv4" : "ipv6");
  }
}
export function isTrustedProxy(raw: string) {
  const address = cleanAddress(raw);
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 4 ? "ipv4" : "ipv6");
}
export function clientAddress(req: IncomingMessage) {
  const remote = cleanAddress(req.socket.remoteAddress ?? "unknown");
  if (!isTrustedProxy(remote)) return remote;
  const header = req.headers["x-forwarded-for"];
  const chain = (typeof header === "string" ? header.split(",").slice(-20) : [])
    .map((v) => cleanAddress(v.trim()))
    .filter((v) => isIP(v));
  let current = remote;
  for (const address of chain.reverse()) {
    if (!isTrustedProxy(current)) break;
    current = address;
  }
  return current;
}
