import { createHash } from "node:crypto";
import type { StackLock } from "../schemas/index.ts";

// Identity, creation time and the self-referential digest never describe the environment.
const EXCLUDED_KEYS: ReadonlySet<string> = new Set(["stack_id", "created_at", "fingerprint"]);

/**
 * "sha256:" + hex SHA-256 of the canonical JSON of `lock` without stack_id/created_at/fingerprint.
 * Canonical JSON: object keys sorted by UTF-16 code unit at every level, arrays in order,
 * primitives via JSON.stringify, no whitespace. Input is assumed schema-valid (no undefined).
 */
export function computeStackFingerprint(
  lock: Omit<StackLock, "fingerprint"> & { fingerprint?: string },
): string {
  const content = Object.fromEntries(
    Object.entries(lock).filter(([key]) => !EXCLUDED_KEYS.has(key)),
  );
  const digest = createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
