import * as fs from "node:fs";
import * as io from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import type * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readWorkspaceRecord, writeWorkspaceRecord, WorkspaceRecordError } from "./index.ts";
import {
  installUnsafe,
  mutableCases,
  recordCases,
  taskCase,
  stackCase,
  unsafeKinds,
} from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    existsSync: vi.fn(actual.existsSync),
    realpathSync: vi.fn(actual.realpathSync),
    accessSync: vi.fn(actual.accessSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    access: vi.fn(actual.access),
    mkdir: vi.fn(actual.mkdir),
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  };
});
vi.mock("node:path", async (original) => {
  const actual = await original<typeof NodePath>();
  return {
    ...actual,
    join: vi.fn((...parts: string[]) => actual.join(...parts)),
    resolve: vi.fn((...parts: string[]) => actual.resolve(...parts)),
    normalize: vi.fn((value: string) => actual.normalize(value)),
  };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const realPath = await vi.importActual<typeof NodePath>("node:path");
let root: string;
let cwd: string;
const secret = "private-record-payload-437";

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
  root = realFs.mkdtempSync(realPath.join(tmpdir(), "records-workspace-"));
  cwd = realPath.join(root, "workspace");
  realFs.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  realFs.rmSync(root, { recursive: true, force: true });
});

function failure(call: () => unknown, stage: string, target?: string): Error {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceRecordError);
  expect(caught).toMatchObject({ stage, ...(target === undefined ? {} : { path: target }) });
  if (!(caught instanceof Error)) throw new Error("Expected a synchronous record failure");
  expect(inspect(caught, { depth: null })).not.toContain(secret);
  return caught;
}

function expectNoPathOrFileCalls(): void {
  expect(vi.mocked(path, true).join.mock.calls).toEqual([]);
  expect(vi.mocked(path, true).resolve.mock.calls).toEqual([]);
  expect(vi.mocked(path, true).normalize.mock.calls).toEqual([]);
  for (const operation of [
    fs.lstatSync,
    fs.statSync,
    fs.existsSync,
    fs.realpathSync,
    fs.accessSync,
    fs.mkdirSync,
    fs.readFileSync,
    fs.openSync,
    fs.writeFileSync,
    fs.renameSync,
    io.lstat,
    io.stat,
    io.realpath,
    io.access,
    io.mkdir,
    io.readFile,
    io.open,
    io.writeFile,
    io.rename,
  ])
    expect(operation).not.toHaveBeenCalled();
}

function expectNoPathOrIO(): void {
  expectNoPathOrFileCalls();
  expect(realFs.readdirSync(cwd)).toEqual([]);
}

function seed(relative: string, text: string): string {
  const target = realPath.join(cwd, relative);
  realFs.mkdirSync(realPath.dirname(target), { recursive: true });
  realFs.writeFileSync(target, text);
  return target;
}

function identity(target: string) {
  const { ino, mode, mtimeNs } = realFs.lstatSync(target, { bigint: true });
  return { ino, mode, mtimeNs };
}

describe.each(recordCases)("$kind workspace reads", (fixture) => {
  test("reads a schema-valid pre-existing object without changing its bytes", () => {
    const text = `  ${JSON.stringify(fixture.value, null, 2)}\n\n`;
    const target = seed(fixture.relative, text);
    const before = identity(target);
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toEqual(fixture.value);
    expect(realFs.readFileSync(target, "utf8")).toBe(text);
    expect(identity(target)).toEqual(before);
  });

  test("missing reads create managed directories, including the task id directory, but no object", () => {
    const directory = realPath.join(cwd, fixture.directory);
    const target = realPath.join(cwd, fixture.relative);
    expect(realFs.existsSync(directory)).toBe(false);
    expect(realFs.existsSync(realPath.dirname(target))).toBe(false);

    failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), "missing", target);

    expect(realFs.lstatSync(directory).isDirectory()).toBe(true);
    expect(realFs.lstatSync(realPath.dirname(target)).isDirectory()).toBe(true);
    expect(realFs.existsSync(target)).toBe(false);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([]);
    expect(realFs.readdirSync(directory)).toEqual(fixture.kind === "task" ? [fixture.id] : []);
    expect(realFs.readdirSync(cwd)).toEqual([fixture.directory]);
  });

  test.each(["../reports/x", "TASK-0001", 437, null])(
    "rejects malformed identifier %j before path construction or filesystem access",
    (id) => {
      failure(() => readWorkspaceRecord(cwd, fixture.kind, id), "id");
      expectNoPathOrIO();
    },
  );

  test.each([
    { stage: "parse", text: `{"secret":"${secret}", broken` },
    { stage: "schema", text: JSON.stringify({ secret }) },
  ])("$stage failures retain corrupt bytes and hide payloads", ({ stage, text }) => {
    const target = seed(fixture.relative, text);
    const before = identity(target);
    const error = failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), stage, target);
    expect(error.cause).toBeUndefined();
    expect(realFs.readFileSync(target, "utf8")).toBe(text);
    expect(identity(target)).toEqual(before);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
  });

  test("unreadable objects fail distinctly without exposing the underlying error or rewriting", () => {
    const text = JSON.stringify(fixture.value);
    const target = seed(fixture.relative, text);
    const before = identity(target);
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(secret), { code: "EACCES" });
    });
    const error = failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), "read", target);
    expect(error.cause).toBeUndefined();
    expect(realFs.readFileSync(target, "utf8")).toBe(text);
    expect(identity(target)).toEqual(before);
  });

  test.each(unsafeKinds)("rejects a %s managed root without outside mutation", (kind) => {
    const outside = realPath.join(root, "outside");
    realFs.mkdirSync(outside);
    realFs.writeFileSync(realPath.join(outside, "sentinel"), "foreign bytes\n");
    const directory = realPath.join(cwd, fixture.directory);
    installUnsafe(directory, kind, outside);
    const before = identity(directory);
    failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), "directory", directory);
    if (fixture.kind !== "stack") {
      failure(() => writeWorkspaceRecord(cwd, fixture.kind, fixture.value), "directory", directory);
    }
    expect(identity(directory)).toEqual(before);
    expect(realFs.readdirSync(outside)).toEqual(["sentinel"]);
    expect(realFs.readFileSync(realPath.join(outside, "sentinel"), "utf8")).toBe("foreign bytes\n");
    if (kind === "file")
      expect(realFs.readFileSync(directory, "utf8")).toBe("original path bytes\n");
    if (kind === "symlink") expect(realFs.readlinkSync(directory)).toBe(outside);
    if (kind === "dangling-link") expect(realFs.existsSync(`${outside}-missing`)).toBe(false);
  });

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s target before reading or publishing",
    (kind) => {
      const outside = realPath.join(root, "outside.json");
      realFs.writeFileSync(outside, "foreign bytes\n");
      const target = realPath.join(cwd, fixture.relative);
      realFs.mkdirSync(realPath.dirname(target), { recursive: true });
      installUnsafe(target, kind, outside);
      const before = identity(target);
      // A broken guard must fail this test, not block the test runner on a FIFO read.
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("Unsafe targets must be rejected before reading");
      });
      vi.clearAllMocks();
      failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), "target", target);
      if (fixture.kind !== "stack") {
        failure(() => writeWorkspaceRecord(cwd, fixture.kind, fixture.value), "target", target);
      }
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(io.readFile).not.toHaveBeenCalled();
      expect(io.open).not.toHaveBeenCalled();
      expect(identity(target)).toEqual(before);
      expect(realFs.readFileSync(outside, "utf8")).toBe("foreign bytes\n");
      expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
      if (kind === "symlink") expect(realFs.readlinkSync(target)).toBe(outside);
      if (kind === "dangling-link") expect(realFs.existsSync(`${outside}-missing`)).toBe(false);
    },
  );
});

test.each(unsafeKinds)("task nested directory rejects %s for reads and writes", (kind) => {
  const outside = realPath.join(root, "outside");
  realFs.mkdirSync(outside);
  realFs.writeFileSync(realPath.join(outside, "sentinel"), "foreign bytes\n");
  realFs.mkdirSync(realPath.join(cwd, "tasks"));
  const nested = realPath.join(cwd, "tasks", taskCase.id);
  installUnsafe(nested, kind, outside);
  const before = identity(nested);
  failure(() => readWorkspaceRecord(cwd, "task", taskCase.id), "directory", nested);
  failure(() => writeWorkspaceRecord(cwd, "task", taskCase.value), "directory", nested);
  expect(identity(nested)).toEqual(before);
  expect(realFs.readdirSync(outside)).toEqual(["sentinel"]);
  expect(realFs.readFileSync(realPath.join(outside, "sentinel"), "utf8")).toBe("foreign bytes\n");
  if (kind === "file") expect(realFs.readFileSync(nested, "utf8")).toBe("original path bytes\n");
});

describe.each(mutableCases)("$kind workspace writes", (fixture) => {
  test("synchronously creates its layout and publishes only schema-valid JSON", () => {
    expect(writeWorkspaceRecord(cwd, fixture.kind, fixture.value)).toBeUndefined();
    const target = realPath.join(cwd, fixture.relative);
    expect(JSON.parse(realFs.readFileSync(target, "utf8"))).toEqual(fixture.value);
    expect(realFs.readFileSync(target, "utf8").endsWith("\n")).toBe(true);
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toEqual(fixture.value);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
    expect(realFs.readdirSync(cwd)).toEqual([fixture.directory]);
  });

  test("replaces an existing regular object without leftover temporary files", () => {
    const target = seed(fixture.relative, "prior object bytes\n");
    writeWorkspaceRecord(cwd, fixture.kind, fixture.value);
    expect(JSON.parse(realFs.readFileSync(target, "utf8"))).toEqual(fixture.value);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
  });

  test("rejects a malformed primary identifier before path construction or IO", () => {
    failure(
      () =>
        writeWorkspaceRecord(cwd, fixture.kind, {
          ...fixture.value,
          [`${fixture.kind}_id`]: "../reports/x",
        }),
      "id",
    );
    expectNoPathOrIO();
  });

  test("rejects an incomplete object before creating directories or publishing", () => {
    failure(
      () => writeWorkspaceRecord(cwd, fixture.kind, { [`${fixture.kind}_id`]: fixture.id, secret }),
      "schema",
    );
    expectNoPathOrIO();
  });

  test("invalid writes preserve an existing object's bytes and identity", () => {
    const target = seed(fixture.relative, "prior object bytes\n");
    const before = identity(target);
    failure(
      () => writeWorkspaceRecord(cwd, fixture.kind, { [`${fixture.kind}_id`]: fixture.id, secret }),
      "schema",
    );
    expect(realFs.readFileSync(target, "utf8")).toBe("prior object bytes\n");
    expect(identity(target)).toEqual(before);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
  });

  test("rename failure after a real temporary write retains the original and cleans the temporary", () => {
    const target = seed(fixture.relative, "prior object bytes\n");
    const before = identity(target);
    let temporaryObserved = false;
    vi.mocked(fs.renameSync).mockImplementationOnce((source, destination) => {
      expect(destination).toBe(target);
      expect(JSON.parse(realFs.readFileSync(source, "utf8"))).toEqual(fixture.value);
      expect(realFs.readFileSync(target, "utf8")).toBe("prior object bytes\n");
      temporaryObserved = true;
      throw Object.assign(new Error(secret), { code: "EIO" });
    });
    const error = failure(
      () => writeWorkspaceRecord(cwd, fixture.kind, fixture.value),
      "write",
      target,
    );
    expect(error.cause).toBeUndefined();
    expect(temporaryObserved).toBe(true);
    expect(realFs.readFileSync(target, "utf8")).toBe("prior object bytes\n");
    expect(identity(target)).toEqual(before);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
  });
});

test("StackLocks cannot be replaced even through an untyped JavaScript call", () => {
  const text = JSON.stringify(stackCase.value);
  const target = seed(stackCase.relative, text);
  const before = identity(target);
  const untypedWrite = writeWorkspaceRecord as (cwd: string, kind: string, value: unknown) => void;
  vi.clearAllMocks();
  failure(() => untypedWrite(cwd, "stack", stackCase.value), "write");
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(vi.mocked(path, true).join.mock.calls).toEqual([]);
  expect(realFs.readFileSync(target, "utf8")).toBe(text);
  expect(identity(target)).toEqual(before);
  expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
});

describe.each(recordCases)("$kind rejects coercible record kinds", (fixture) => {
  const representations = [
    {
      name: "JSON array",
      wrap: (kind: string): unknown => JSON.parse(JSON.stringify([kind])),
    },
    {
      name: "boxed string",
      wrap: (kind: string): unknown => Reflect.construct(String, [kind]),
    },
  ];

  test.each(representations)("read rejects a $name before path construction or IO", ({ wrap }) => {
    const text = JSON.stringify(fixture.value);
    const target = seed(fixture.relative, text);
    const before = identity(target);
    const untypedRead = readWorkspaceRecord as (cwd: string, kind: unknown, id: unknown) => unknown;
    const kind = wrap(fixture.kind);
    vi.clearAllMocks();

    const error = failure(() => untypedRead(cwd, kind, fixture.id), "kind");

    expect(error.cause).toBeUndefined();
    expectNoPathOrFileCalls();
    expect(realFs.readFileSync(target, "utf8")).toBe(text);
    expect(identity(target)).toEqual(before);
    expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
  });

  test.each(representations)(
    "write rejects a $name without replacing existing evidence",
    ({ wrap }) => {
      const text = JSON.stringify(fixture.value);
      const target = seed(fixture.relative, text);
      const before = identity(target);
      const untypedWrite = writeWorkspaceRecord as (
        cwd: string,
        kind: unknown,
        value: unknown,
      ) => void;
      const replacement = {
        ...fixture.value,
        ...(fixture.kind === "stack" ? { created_at: "2026-10-29T08:00:05Z" } : {}),
      };
      const kind = wrap(fixture.kind);
      vi.clearAllMocks();

      const error = failure(() => untypedWrite(cwd, kind, replacement), "kind");

      expect(error.cause).toBeUndefined();
      expectNoPathOrFileCalls();
      expect(realFs.readFileSync(target, "utf8")).toBe(text);
      expect(identity(target)).toEqual(before);
      expect(realFs.readdirSync(realPath.dirname(target))).toEqual([realPath.basename(target)]);
    },
  );
});

test.each([
  { name: "null", kind: null },
  { name: "undefined", kind: undefined },
  { name: "number", kind: 437 },
  { name: "boolean", kind: true },
  { name: "unknown primitive string", kind: "unknown" },
  { name: "toString prototype key", kind: "toString" },
  { name: "constructor prototype key", kind: "constructor" },
  { name: "__proto__ prototype key", kind: "__proto__" },
])("$name is rejected at both record boundaries before path construction or IO", ({ kind }) => {
  const untypedRead = readWorkspaceRecord as (cwd: string, kind: unknown, id: unknown) => unknown;
  const untypedWrite = writeWorkspaceRecord as (cwd: string, kind: unknown, value: unknown) => void;

  const readError = failure(() => untypedRead(cwd, kind, taskCase.id), "kind");
  const writeError = failure(() => untypedWrite(cwd, kind, taskCase.value), "kind");

  expect(readError.cause).toBeUndefined();
  expect(writeError.cause).toBeUndefined();
  expectNoPathOrIO();
});
