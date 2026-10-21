import type * as NodeFs from "node:fs";
import { realpathSync } from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import { caseInsensitiveRoot } from "./decide.ts";

// Isolated from decide.test.ts: native realpath delegates to the real one unless
// a row overrides it, so both platforms run every probe branch.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const native = vi.fn(actual.realpathSync.native);
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args),
    { native },
  );
  return { ...actual, realpathSync };
});
const native = vi.mocked(realpathSync.native);
const resolveTo = (path: string) => (() => path) as unknown as typeof realpathSync.native;
beforeEach(() => {
  native.mockClear();
});

test("an all-uppercase root is probed through its lowercase spelling", () => {
  native.mockImplementationOnce(resolveTo("/CASE/ROOT"));
  expect(caseInsensitiveRoot("/CASE/ROOT")).toBe(true);
  expect(native).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenLastCalledWith("/case/root");
});

test("a variant resolving to a different path is case-sensitive", () => {
  native.mockImplementationOnce(resolveTo("/case/root-other"));
  expect(caseInsensitiveRoot("/case/root")).toBe(false);
  expect(native).toHaveBeenLastCalledWith("/CASE/ROOT");
});

test("a probe that throws is case-sensitive", () => {
  native.mockImplementationOnce(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  expect(caseInsensitiveRoot("/case/root")).toBe(false);
  expect(native).toHaveBeenCalledTimes(1);
});
