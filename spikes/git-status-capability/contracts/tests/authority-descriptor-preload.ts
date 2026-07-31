import { mock } from "bun:test";
import * as originalFfi from "bun:ffi";
import * as originalFs from "node:fs";

type PreloadMode = "fd0" | "at_fdcwd" | "fstat0" | "close0" | "lifecycle" | "guard_order";
type RawPrimitive = "openat" | "fstat_sync" | "read_sync" | "close_sync";
type GuardRawPrimitive = "open_sync" | "openat" | "read_sync";
type CounterName = "attempted" | "intercepted" | "native";

const mode = process.env.SHUD_DESCRIPTOR_PRELOAD_MODE as PreloadMode | undefined;
const eventPath = process.env.SHUD_DESCRIPTOR_PRELOAD_EVENT_PATH;
const sideEffectPath = process.env.SHUD_DESCRIPTOR_PRELOAD_SIDE_EFFECT_PATH;
const auditPath = process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_PATH;

if (
  (mode !== "fd0" && mode !== "at_fdcwd" && mode !== "fstat0" && mode !== "close0" &&
    mode !== "lifecycle" && mode !== "guard_order") ||
  !eventPath ||
  !sideEffectPath
) {
  throw new Error("descriptor preload requires a proof mode and receipt paths");
}

const counters = {
  attempted: { openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 },
  intercepted: { openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 },
  native: { openat: 0, fstat_sync: 0, read_sync: 0, close_sync: 0 },
  target_bytes: 0
} satisfies Record<CounterName, Record<RawPrimitive, number>> & { target_bytes: number };
const guardOrderCounters = {
  attempted: { open_sync: 0, openat: 0, read_sync: 0 },
  intercepted: { open_sync: 0, openat: 0, read_sync: 0 },
  native: { open_sync: 0, openat: 0, read_sync: 0 },
  target_bytes: 0
} satisfies Record<CounterName, Record<GuardRawPrimitive, number>> & { target_bytes: number };

function writeCounters(): void {
  const receipt = mode === "guard_order" ? guardOrderCounters : counters;
  originalFs.writeFileSync(sideEffectPath, `${JSON.stringify(receipt)}\n`);
}

function count(counter: CounterName, operation: RawPrimitive): void {
  counters[counter][operation] += 1;
  writeCounters();
}

function countGuard(counter: CounterName, operation: GuardRawPrimitive): void {
  guardOrderCounters[counter][operation] += 1;
  writeCounters();
}

writeCounters();

function isLifecycleAction(): boolean {
  return mode === "lifecycle" && process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE === "action";
}

function isGuardOrderAction(): boolean {
  return mode === "guard_order" && process.env.SHUD_DESCRIPTOR_PRELOAD_COUNTER_PHASE === "action";
}

function auditDescriptor(value: unknown): void {
  const label = process.env.SHUD_DESCRIPTOR_PRELOAD_AUDIT_LABEL;
  if (!auditPath || !label || typeof value !== "number") return;
  originalFs.appendFileSync(auditPath, `${JSON.stringify({ label, descriptor: value })}\n`);
}

function denyRawOperation(
  operation: RawPrimitive,
  reason: "unproven_descriptor" | "unproven_parent",
  descriptor: number
): never {
  count("intercepted", operation);
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

const originalOpenSync = originalFs.openSync;
const originalReadSync = originalFs.readSync;
const originalFstatSync = originalFs.fstatSync;
const originalCloseSync = originalFs.closeSync;
mock.module("node:fs", () => ({
  ...originalFs,
  openSync(...args: Parameters<typeof originalOpenSync>) {
    if (!isGuardOrderAction()) return originalOpenSync(...args);
    countGuard("attempted", "open_sync");
    countGuard("native", "open_sync");
    return originalOpenSync(...args);
  },
  readSync(...args: Parameters<typeof originalReadSync>) {
    if (isGuardOrderAction()) {
      countGuard("attempted", "read_sync");
      countGuard("native", "read_sync");
      const bytes = originalReadSync(...args);
      guardOrderCounters.target_bytes += bytes;
      writeCounters();
      return bytes;
    }
    if (isLifecycleAction()) {
      count("attempted", "read_sync");
      count("native", "read_sync");
      const bytes = originalReadSync(...args);
      counters.target_bytes += bytes;
      writeCounters();
      return bytes;
    }
    if (args[0] === 0) {
      count("attempted", "read_sync");
      if (mode === "fd0") return denyRawOperation("read_sync", "unproven_descriptor", 0);
      count("native", "read_sync");
      const bytes = originalReadSync(...args);
      counters.target_bytes += bytes;
      writeCounters();
      return bytes;
    }
    return originalReadSync(...args);
  },
  fstatSync(...args: Parameters<typeof originalFstatSync>) {
    auditDescriptor(args[0]);
    if (isLifecycleAction()) {
      count("attempted", "fstat_sync");
      count("native", "fstat_sync");
      return originalFstatSync(...args);
    }
    if (args[0] === 0) {
      count("attempted", "fstat_sync");
      if (mode === "fstat0") return denyRawOperation("fstat_sync", "unproven_descriptor", 0);
      count("native", "fstat_sync");
    }
    return originalFstatSync(...args);
  },
  closeSync(...args: Parameters<typeof originalCloseSync>) {
    if (isLifecycleAction()) {
      count("attempted", "close_sync");
      count("native", "close_sync");
      return originalCloseSync(...args);
    }
    if (args[0] === 0) {
      count("attempted", "close_sync");
      if (mode === "close0") return denyRawOperation("close_sync", "unproven_descriptor", 0);
      count("native", "close_sync");
    }
    return originalCloseSync(...args);
  }
}));

const originalDlopen = originalFfi.dlopen;
mock.module("bun:ffi", () => ({
  ...originalFfi,
  dlopen(...args: Parameters<typeof originalDlopen>) {
    const library = originalDlopen(...args);
    if (mode !== "at_fdcwd" && mode !== "lifecycle" && mode !== "guard_order") return library;
    const nativeOpenAt = library.symbols.openat as unknown as (parent: number, path: Buffer, flags: number) => number;
    return {
      ...library,
      symbols: {
        ...library.symbols,
        openat(parent: number, path: Buffer, flags: number): number {
          if (isGuardOrderAction()) {
            countGuard("attempted", "openat");
            countGuard("native", "openat");
            return nativeOpenAt(parent, path, flags);
          }
          if (isLifecycleAction()) {
            count("attempted", "openat");
            count("native", "openat");
            return nativeOpenAt(parent, path, flags);
          }
          if (mode === "at_fdcwd" && parent === -100) {
            count("attempted", "openat");
            return denyRawOperation("openat", "unproven_parent", -100);
          }
          return nativeOpenAt(parent, path, flags);
        }
      }
    } as typeof library;
  }
}));
