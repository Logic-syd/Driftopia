import { createHash } from "node:crypto";
// JSON object key order does not change intent. Arrays remain ordered.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const requestFingerprint = (action: string, body: unknown) =>
  createHash("sha256").update(canonicalJson({ action, body })).digest("hex");

// Compatibility for receipts created by v0.2 before canonicalization.
export const legacyFingerprint = (action: string, body: unknown) =>
  createHash("sha256").update(JSON.stringify({ action, body })).digest("hex");
