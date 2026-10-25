import * as childProcess from "node:child_process";
import type * as NodeChild from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { cleanupResources } from "./detached-shud/test-harness.ts";
import {
  captureCleanupFailure,
  cleanupDiagnostic,
  preserveCleanupErrors,
} from "./cleanup-diagnostics.ts";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

beforeEach(() => {
  vi.mocked(childProcess.spawnSync).mockReset().mockReturnValue({
    pid: 0,
    output: [],
    stdout: "4242 4242 S\n",
    stderr: "",
    status: 0,
    signal: null,
  });
});

function retainedFailures(value: unknown, seen = new Set<unknown>()): Set<unknown> {
  if (seen.has(value)) return seen;
  seen.add(value);
  if (value instanceof Error) {
    if ("cause" in value) retainedFailures(value.cause, seen);
    if (value instanceof AggregateError) {
      const members: unknown[] = value.errors;
      for (const error of members) retainedFailures(error, seen);
    }
  }
  return seen;
}

// Read ordinary Error evidence, not nested .errors (which retains references but hides diagnostics).
function errorEvidence(error: unknown): string {
  const seen = new Set<Error>();
  const evidence: string[] = [];
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    evidence.push(error.message, error.stack ?? "");
    error = error.cause;
  }
  return evidence.join("\n");
}

test("cleanup retains nested failure messages and stacks while attempting later releases", async () => {
  const cause = new Error("cleanup cause evidence");
  const inner = new Error("cleanup inner evidence", { cause });
  const sibling = new Error("cleanup sibling evidence");
  const nested = new AggregateError([inner, sibling], "nested cleanup failure");
  const later = new Error("later release evidence");
  const order: string[] = [];
  let failure: unknown;
  try {
    await cleanupResources([
      () => {
        order.push("nested");
        return Promise.reject(nested);
      },
      () => {
        order.push("later");
        return Promise.reject(later);
      },
      () => {
        order.push("released");
        return Promise.resolve();
      },
    ]);
  } catch (error) {
    failure = error;
  }

  expect(order).toEqual(["nested", "later", "released"]);
  const retained = retainedFailures(failure);
  for (const original of [nested, inner, cause, sibling, later]) {
    expect(retained.has(original)).toBe(true);
  }
  const evidence = errorEvidence(failure);
  for (const original of [inner, cause, sibling, later]) {
    expect(evidence).toContain(original.message);
    const frame = original.stack?.split("\n")[1]?.trim();
    expect(frame).toBeTypeOf("string");
    expect(evidence).toContain(frame);
  }
});

test("failure capture reports real snapshot fields and retains cyclic and non-Error causes", () => {
  const cyclic = new AggregateError([], "cyclic cleanup");
  cyclic.errors.push(cyclic, "non-Error rejection", { detail: "object rejection" }, undefined);
  cyclic.cause = cyclic;
  const failure = captureCleanupFailure(cyclic, [4242]);
  expect(retainedFailures(failure).has(cyclic)).toBe(true);
  expect(failure.message).toContain("circular or repeated reference");
  expect(failure.message).toContain("non-Error rejection");
  expect(failure.message).toContain("object rejection");
  expect(failure.message).toContain("undefined");
  expect(failure.message).toContain("pid=4242 pgid=4242");
  expect(failure.message).toContain("4242 4242 S");
  expect(childProcess.spawnSync).toHaveBeenCalledExactlyOnceWith(
    "ps",
    ["-axo", "pid=,pgid=,stat="],
    expect.objectContaining({ timeout: 1000, maxBuffer: 1024 * 1024, encoding: "utf8" }),
  );
  expect(captureCleanupFailure(failure)).toBe(failure);
  expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
});

test.each(["status", "signal", "stderr", "empty", "malformed", "error", "throw"])(
  "unavailable snapshot (%s) never replaces the original failure",
  (mode) => {
    const original = new Error("original cleanup failure");
    const denied = Object.assign(new Error("snapshot denied"), { code: "EACCES" });
    vi.mocked(childProcess.spawnSync).mockImplementation(() => {
      if (mode === "throw") throw denied;
      return {
        pid: 0,
        output: [],
        stdout: mode === "empty" ? "" : mode === "malformed" ? "invalid row" : "4242 4242 S\n",
        stderr: mode === "stderr" ? "denied" : "",
        status: mode === "status" ? 1 : 0,
        signal: mode === "signal" ? "SIGTERM" : null,
        error: mode === "error" ? denied : undefined,
      };
    });
    const failure = captureCleanupFailure(original);
    expect(retainedFailures(failure).has(original)).toBe(true);
    expect(failure.message).toContain(original.message);
    expect(failure.message).toContain("identity unknown");
    expect(failure.message).toContain("unavailable");
    if (mode === "error" || mode === "throw") expect(failure.message).toContain("EACCES");
    if (mode === "status") expect(failure.message).toContain("status=1");
  },
);

test("snapshot is captured before the next cleanup action changes process state", async () => {
  const original = new Error("first release failed");
  const failure: unknown = await cleanupResources([
    () => Promise.reject(original),
    () => {
      vi.mocked(childProcess.spawnSync).mockReturnValue({
        pid: 0,
        output: [],
        stdout: "5151 5151 Z\n",
        stderr: "",
        status: 0,
        signal: null,
      });
      return Promise.resolve();
    },
  ]).catch((error: unknown) => error);
  expect(errorEvidence(failure)).toContain("4242 4242 S");
  expect(errorEvidence(failure)).not.toContain("5151 5151 Z");
  expect(retainedFailures(failure).has(original)).toBe(true);
});

test("bounded diagnostics retain original oversized and deeply nested failures", () => {
  const large = new Error("x".repeat(40000));
  const oversized = captureCleanupFailure(large, [9999]);
  expect(oversized.message).toContain("diagnostic truncated");
  expect(oversized.message).toContain("no rows for known groups");
  expect(oversized.message).toContain("pid=9999 pgid=9999");
  expect(retainedFailures(oversized).has(large)).toBe(true);
  let deep: Error = new Error("deep leaf");
  for (let index = 0; index < 20; index++) deep = new Error(`depth ${index}`, { cause: deep });
  expect(captureCleanupFailure(deep).message).toContain("diagnostic truncated");
  const many = new AggregateError(Array.from({ length: 140 }, (_, index) => new Error(`${index}`)));
  expect(captureCleanupFailure(many).message).toContain("diagnostic truncated");
});

test("successful cleanup preserves body identity and expected pending rejection without snapshots", async () => {
  const original = new Error("body only");
  const order: string[] = [];
  const failed = preserveCleanupErrors(
    () => Promise.reject(original),
    () => {
      order.push("cleanup");
      return Promise.resolve();
    },
  );
  await expect(failed).rejects.toBe(original);
  const pendingError = new Error("asserted pending");
  await preserveCleanupErrors(
    async (observe) => {
      const pending = Promise.reject(pendingError);
      expect(observe(pending)).toBe(pending);
      await expect(pending).rejects.toBe(pendingError);
    },
    () => cleanupResources([() => Promise.resolve()]),
  );
  expect(order).toEqual(["cleanup"]);
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
});

test("body and immediately observed pending failures coexist with cleanup errors", async () => {
  const body = new Error("primary identity");
  const pending = new Error("pending identity");
  const cleanup = new Error("cleanup identity");
  const failure: unknown = await preserveCleanupErrors(
    (observe) => {
      void observe(Promise.reject(pending));
      throw body;
    },
    () => Promise.reject(cleanup),
    () => [4242],
  ).catch((error: unknown) => error);
  const retained = retainedFailures(failure);
  for (const original of [body, pending, cleanup]) {
    expect(retained.has(original)).toBe(true);
    expect(errorEvidence(failure)).toContain(original.message);
  }
  expect(errorEvidence(failure)).toContain("pid=4242 pgid=4242");
  expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
});

test("body error remains the same object when cleanup succeeds", async () => {
  const body = new Error("body error identity evidence");
  await expect(
    preserveCleanupErrors(
      () => Promise.reject(body),
      () => Promise.resolve(),
    ),
  ).rejects.toBe(body);
  const original = new Error("nested sibling evidence");
  const diagnostic = cleanupDiagnostic("surface cleanup", [
    captureCleanupFailure(new AggregateError([original], "inner aggregate")),
  ]);
  expect(errorEvidence(diagnostic)).toContain(original.message);
  expect(retainedFailures(diagnostic).has(original)).toBe(true);
});
