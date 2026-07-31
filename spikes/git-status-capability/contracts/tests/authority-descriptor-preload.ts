import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";

type PreloadMode = "fd0" | "at_fdcwd";

const mode = process.env.SHUD_DESCRIPTOR_PRELOAD_MODE as PreloadMode | undefined;
const eventPath = process.env.SHUD_DESCRIPTOR_PRELOAD_EVENT_PATH;
const sideEffectPath = process.env.SHUD_DESCRIPTOR_PRELOAD_SIDE_EFFECT_PATH;

if ((mode !== "fd0" && mode !== "at_fdcwd") || !eventPath || !sideEffectPath) {
  throw new Error("descriptor preload requires a proof mode and receipt paths");
}

originalFs.writeFileSync(sideEffectPath, "0\n");

function denyRawOperation(
  operation: "read_sync" | "openat",
  reason: "unproven_descriptor" | "unproven_parent",
  descriptor: number
): never {
  originalFs.appendFileSync(eventPath, `${JSON.stringify({
    schema_version: "shud.contract.descriptor-denial.v1",
    operation,
    reason,
    descriptor,
    generation: null,
    phase: "post_admission"
  })}\n`);
  throw new Error("CONTRACT_CAPABILITY_DESCRIPTOR_DENIED");
}

const originalReadSync = originalFs.readSync;
mock.module("node:fs", () => ({
  ...originalFs,
  readSync(...args: Parameters<typeof originalReadSync>) {
    if (mode === "fd0" && args[0] === 0) return denyRawOperation("read_sync", "unproven_descriptor", 0);
    return originalReadSync(...args);
  }
}));

const originalDlopen = originalFfi.dlopen;
mock.module("bun:ffi", () => ({
  ...originalFfi,
  dlopen(...args: Parameters<typeof originalDlopen>) {
    const library = originalDlopen(...args);
    if (mode !== "at_fdcwd") return library;
    const nativeOpenAt = library.symbols.openat as unknown as (parent: number, path: Buffer, flags: number) => number;
    return {
      ...library,
      symbols: {
        ...library.symbols,
        openat(parent: number, path: Buffer, flags: number): number {
          if (parent === -100) return denyRawOperation("openat", "unproven_parent", -100);
          return nativeOpenAt(parent, path, flags);
        }
      }
    } as typeof library;
  }
}));
