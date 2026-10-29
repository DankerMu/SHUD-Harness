import * as fs from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTaskCard, createDataProvenance, createEvidenceReport } from "./index.ts";
import { installUnsafe, mutableCases, taskCase, unsafeKinds } from "./test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
  };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
let root: string;
let cwd: string;

beforeEach(() => {
  root = realFs.mkdtempSync(join(tmpdir(), "records-allocation-"));
  cwd = join(root, "workspace");
  realFs.mkdirSync(cwd);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T08:00:05.987Z"));
  entropy.suffixes = ["3f9c", "abcd", "1234"];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  realFs.rmSync(root, { recursive: true, force: true });
});

type MutableFixture = (typeof mutableCases)[number];
function allocate(fixture: MutableFixture, fields?: Record<string, unknown>) {
  const input: Record<string, unknown> = fields ?? { ...fixture.value };
  delete input[`${fixture.kind}_id`];
  if (fixture.kind === "task") {
    return createTaskCard(cwd, input as Parameters<typeof createTaskCard>[1]);
  }
  if (fixture.kind === "data") {
    return createDataProvenance(cwd, input as Parameters<typeof createDataProvenance>[1]);
  }
  return createEvidenceReport(cwd, input as Parameters<typeof createEvidenceReport>[1]);
}

describe.each(mutableCases)("$kind allocation", (fixture) => {
  test("synchronously publishes exactly the supplied fields with one independently generated id", () => {
    const result = allocate(fixture);
    expect(result).toEqual(fixture.value);
    const target = join(cwd, fixture.relative);
    expect(JSON.parse(realFs.readFileSync(target, "utf8"))).toEqual(fixture.value);
    expect(realFs.readdirSync(dirname(target))).toEqual([basename(target)]);
    expect(entropy.suffixes).toEqual(["abcd", "1234"]);
  });

  test("a genuine collision regenerates without changing the prior object", () => {
    const target = join(cwd, fixture.relative);
    realFs.mkdirSync(dirname(target), { recursive: true });
    realFs.writeFileSync(target, "existing evidence bytes\n");
    const before = realFs.statSync(target, { bigint: true });
    const result = allocate(fixture);
    const secondId = `${fixture.id.slice(0, -4)}abcd`;
    expect(result).toEqual({ ...fixture.value, [`${fixture.kind}_id`]: secondId });
    expect(entropy.suffixes).toEqual(["1234"]);
    expect(realFs.readFileSync(target, "utf8")).toBe("existing evidence bytes\n");
    expect(realFs.statSync(target, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(realFs.statSync(target, { bigint: true }).ino).toBe(before.ino);
    const published =
      fixture.kind === "task"
        ? join(cwd, "tasks", secondId, "task.json")
        : join(cwd, fixture.directory, `${secondId}.json`);
    expect(JSON.parse(realFs.readFileSync(published, "utf8"))).toEqual(result);
    expect(realFs.readdirSync(join(cwd, fixture.directory)).sort()).toEqual(
      fixture.kind === "task"
        ? [fixture.id, secondId].sort()
        : [`${fixture.id}.json`, `${secondId}.json`].sort(),
    );
  });

  test("invalid allocation fields reject before filesystem access", () => {
    expect(() => allocate(fixture, {})).toThrow();
    expect(fs.lstatSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(realFs.readdirSync(cwd)).toEqual([]);
  });

  test.each(unsafeKinds)("a %s root aborts without allocating elsewhere", (kind) => {
    const outside = join(root, "outside");
    realFs.mkdirSync(outside);
    realFs.writeFileSync(join(outside, "sentinel"), "foreign bytes\n");
    const directory = join(cwd, fixture.directory);
    installUnsafe(directory, kind, outside);
    const before = realFs.lstatSync(directory, { bigint: true });
    expect(() => allocate(fixture)).toThrow();
    expect(entropy.suffixes).toEqual(["abcd", "1234"]);
    expect(realFs.readdirSync(outside)).toEqual(["sentinel"]);
    expect(realFs.readFileSync(join(outside, "sentinel"), "utf8")).toBe("foreign bytes\n");
    expect(realFs.lstatSync(directory, { bigint: true }).ino).toBe(before.ino);
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "a %s target is unsafe rather than an allocation collision",
    (kind) => {
      const outside = join(root, "outside.json");
      realFs.writeFileSync(outside, "foreign bytes\n");
      const target = join(cwd, fixture.relative);
      realFs.mkdirSync(dirname(target), { recursive: true });
      installUnsafe(target, kind, outside);
      const before = realFs.lstatSync(target, { bigint: true });
      expect(() => allocate(fixture)).toThrow();
      expect(entropy.suffixes).toEqual(["abcd", "1234"]);
      expect(realFs.readFileSync(outside, "utf8")).toBe("foreign bytes\n");
      expect(realFs.lstatSync(target, { bigint: true }).ino).toBe(before.ino);
      expect(realFs.readdirSync(dirname(target))).toEqual([basename(target)]);
      expect(fs.openSync).not.toHaveBeenCalled();
      if (kind === "symlink") expect(realFs.readlinkSync(target)).toBe(outside);
      if (kind === "dangling-link") expect(realFs.existsSync(`${outside}-missing`)).toBe(false);
    },
  );
});

test("an empty pre-existing task id directory is still a collision", () => {
  const original = join(cwd, "tasks", taskCase.id);
  realFs.mkdirSync(original, { recursive: true });
  const before = realFs.statSync(original, { bigint: true });
  expect(allocate(taskCase)).toEqual({ ...taskCase.value, task_id: "TASK-20261027T080005-abcd" });
  expect(realFs.readdirSync(original)).toEqual([]);
  expect(realFs.statSync(original, { bigint: true }).ino).toBe(before.ino);
  expect(entropy.suffixes).toEqual(["1234"]);
});

test.each(unsafeKinds)("a %s nested task directory aborts instead of retrying", (kind) => {
  const outside = join(root, "outside");
  realFs.mkdirSync(outside);
  const nested = join(cwd, "tasks", taskCase.id);
  realFs.mkdirSync(dirname(nested), { recursive: true });
  installUnsafe(nested, kind, outside);
  const before = realFs.lstatSync(nested, { bigint: true });
  expect(() => allocate(taskCase)).toThrow();
  expect(entropy.suffixes).toEqual(["abcd", "1234"]);
  expect(realFs.readdirSync(outside)).toEqual([]);
  expect(realFs.lstatSync(nested, { bigint: true }).ino).toBe(before.ino);
  expect(fs.openSync).not.toHaveBeenCalled();
});
