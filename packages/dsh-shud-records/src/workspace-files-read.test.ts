import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import type * as NodePath from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  WorkspaceRecordError,
  type WorkspaceRecordStage,
} from "./index.ts";
import { installUnsafe, unsafeKinds } from "./test-harness.ts";
import { buildCase, workspaceFileCases } from "./workspace-files-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    linkSync: vi.fn(actual.linkSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    mkdir: vi.fn(actual.mkdir),
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
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

const native = await vi.importActual<typeof fs>("node:fs");
const nativePath = await vi.importActual<typeof NodePath>("node:path");
const secret = "private-workspace-file-payload-527";
const modes = [
  { name: "default", options: undefined },
  { name: "readonly", options: { readonly: true } },
] as const;
let root: string;
let cwd: string;

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  root = native.mkdtempSync(nativePath.join(tmpdir(), "workspace-files-read-"));
  cwd = nativePath.join(root, "workspace");
  native.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  native.rmSync(root, { recursive: true, force: true });
});

function seed(relative: string, text: string): string {
  const target = nativePath.join(cwd, relative);
  native.mkdirSync(nativePath.dirname(target), { recursive: true });
  native.writeFileSync(target, text);
  return target;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  mtimeNs: bigint;
}

function identity(target: string): FileIdentity {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(target, { bigint: true });
  return { dev, ino, mode, mtimeNs };
}

function failure(call: () => unknown, stage: WorkspaceRecordStage, target?: string): void {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceRecordError);
  expect(caught).toMatchObject({ stage, path: target });
  if (!(caught instanceof Error)) throw new Error("Expected a controlled workspace record error");
  expect(caught.cause).toBeUndefined();
  expect(inspect(caught, { depth: null })).not.toContain(secret);
}

function expectNoWrites(): void {
  for (const operation of [
    fs.mkdirSync,
    fs.openSync,
    fs.writeFileSync,
    fs.renameSync,
    fs.linkSync,
    fs.unlinkSync,
    fs.rmSync,
    io.mkdir,
    io.open,
    io.writeFile,
    io.rename,
    io.link,
    io.unlink,
    io.rm,
  ])
    expect(operation).not.toHaveBeenCalled();
}

function expectNoPathOrIO(): void {
  expect(join).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(normalize).not.toHaveBeenCalled();
  for (const operation of [
    fs.lstatSync,
    fs.statSync,
    fs.readFileSync,
    io.lstat,
    io.stat,
    io.readFile,
  ])
    expect(operation).not.toHaveBeenCalled();
  expectNoWrites();
}

function expectUnchanged(target: string, text: string, before: FileIdentity): void {
  expect(native.readFileSync(target, "utf8")).toBe(text);
  expect(identity(target)).toEqual(before);
  expect(native.readdirSync(nativePath.dirname(target))).toEqual([nativePath.basename(target)]);
}

describe.each(workspaceFileCases)("$kind workspace file", (fixture) => {
  describe.each(modes)("$name reads", ({ options }) => {
    test("returns the complete schema-valid object from its published layout without rewriting", () => {
      expect(fixture.schema.safeParse(fixture.value).success).toBe(true);
      const text = `  ${JSON.stringify(fixture.value, null, 2)}\n\n`;
      const target = seed(fixture.relative, text);
      const before = identity(target);
      vi.clearAllMocks();

      // Build metadata is readable without a binary or logs; verification binds vc_id.
      expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id, options)).toEqual(fixture.value);

      expectUnchanged(target, text, before);
      expectNoWrites();
      expect(native.readdirSync(cwd)).toEqual([fixture.directory]);
    });

    test.each([
      { stage: "parse", text: `{"secret":"${secret}", broken` },
      { stage: "schema", text: JSON.stringify({ ...fixture.value, created_at: secret }) },
    ] as const)("preserves $stage-invalid evidence and hides raw contents", ({ stage, text }) => {
      const target = seed(fixture.relative, text);
      const before = identity(target);
      vi.clearAllMocks();

      failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, options), stage, target);

      expectUnchanged(target, text, before);
      expectNoWrites();
    });

    test("rejects a schema-valid foreign embedded identity even without readonly", () => {
      // Derived paths move with the foreign id, so this is identity failure, not schema failure.
      expect(fixture.schema.safeParse(fixture.foreignValue).success).toBe(true);
      const text = ` ${JSON.stringify(fixture.foreignValue)}\n`;
      const target = seed(fixture.relative, text);
      const before = identity(target);
      vi.clearAllMocks();

      failure(
        () => readWorkspaceRecord(cwd, fixture.kind, fixture.id, options),
        "identity",
        target,
      );

      expectUnchanged(target, text, before);
      expectNoWrites();
    });

    test.each([
      "../tasks/x",
      "CHG-0001",
      "VC-0001",
      "BUILD-0001",
      fixture.id.toUpperCase(),
      "TASK-20261102T090000-a1b2",
      `${fixture.id}/child`,
      527,
      null,
    ])("rejects malformed routing id %j before paths or filesystem access", (id) => {
      failure(() => readWorkspaceRecord(cwd, fixture.kind, id, options), "id");
      expectNoPathOrIO();
      expect(native.readdirSync(cwd)).toEqual([]);
    });

    test.each(unsafeKinds)(
      "rejects a %s managed root without touching outside evidence",
      (kind) => {
        const outside = nativePath.join(root, "outside");
        native.mkdirSync(outside);
        const sentinel = nativePath.join(outside, "sentinel");
        native.writeFileSync(sentinel, "foreign bytes\n");
        const directory = nativePath.join(cwd, fixture.directory);
        installUnsafe(directory, kind, outside);
        const before = identity(directory);
        const sentinelBefore = identity(sentinel);
        vi.clearAllMocks();

        failure(
          () => readWorkspaceRecord(cwd, fixture.kind, fixture.id, options),
          "directory",
          directory,
        );

        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(io.readFile).not.toHaveBeenCalled();
        expectNoWrites();
        expect(identity(directory)).toEqual(before);
        expectUnchanged(sentinel, "foreign bytes\n", sentinelBefore);
        if (kind === "file")
          expect(native.readFileSync(directory, "utf8")).toBe("original path bytes\n");
        if (kind === "symlink") expect(native.readlinkSync(directory)).toBe(outside);
        if (kind === "dangling-link") expect(native.existsSync(`${outside}-missing`)).toBe(false);
      },
    );

    test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
      "rejects a %s record target before reading it",
      (kind) => {
        const outside = nativePath.join(root, "outside.json");
        native.writeFileSync(outside, "foreign bytes\n");
        const target = nativePath.join(cwd, fixture.relative);
        native.mkdirSync(nativePath.dirname(target), { recursive: true });
        installUnsafe(target, kind, outside);
        const before = identity(target);
        const outsideBefore = identity(outside);
        // A broken guard fails rather than blocking the runner on a FIFO read.
        vi.mocked(fs.readFileSync).mockImplementation(() => {
          throw new Error("Unsafe evidence must not be read");
        });
        vi.clearAllMocks();

        failure(
          () => readWorkspaceRecord(cwd, fixture.kind, fixture.id, options),
          "target",
          target,
        );

        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(io.readFile).not.toHaveBeenCalled();
        expectNoWrites();
        expect(identity(target)).toEqual(before);
        expect(native.readFileSync(outside, "utf8")).toBe("foreign bytes\n");
        expect(identity(outside)).toEqual(outsideBefore);
        expect(native.readdirSync(nativePath.dirname(target))).toEqual([
          nativePath.basename(target),
        ]);
        if (kind === "symlink") expect(native.readlinkSync(target)).toBe(outside);
        if (kind === "dangling-link") expect(native.existsSync(`${outside}-missing`)).toBe(false);
      },
    );
  });

  test.each([false, true])(
    "readonly absence with managed root present=%s creates no paths",
    (exists) => {
      const directory = nativePath.join(cwd, fixture.directory);
      const target = nativePath.join(cwd, fixture.relative);
      if (exists) native.mkdirSync(directory);
      vi.clearAllMocks();

      failure(
        () => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true }),
        "missing",
        target,
      );

      expectNoWrites();
      expect(native.readdirSync(cwd)).toEqual(exists ? [fixture.directory] : []);
      if (exists) expect(native.readdirSync(directory)).toEqual([]);
      expect(native.existsSync(target)).toBe(false);
    },
  );

  test("default absence may create the managed root, but never a published object or build id directory", () => {
    const directory = nativePath.join(cwd, fixture.directory);
    const target = nativePath.join(cwd, fixture.relative);

    failure(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id), "missing", target);

    expect(native.lstatSync(directory).isDirectory()).toBe(true);
    expect(native.readdirSync(directory)).toEqual([]);
    expect(native.readdirSync(cwd)).toEqual([fixture.directory]);
    expect(native.existsSync(target)).toBe(false);
    if (fixture.kind === "build") expect(native.existsSync(nativePath.dirname(target))).toBe(false);
  });

  test.each([false, true])(
    "generic JavaScript write rejects new kinds with existing record=%s",
    (exists) => {
      const text = ` ${JSON.stringify(fixture.value)}\n`;
      const target = exists ? seed(fixture.relative, text) : undefined;
      const before = target === undefined ? undefined : identity(target);
      const untypedWrite = writeWorkspaceRecord as (
        cwd: string,
        kind: string,
        value: unknown,
      ) => void;
      vi.clearAllMocks();

      failure(() => untypedWrite(cwd, fixture.kind, fixture.value), "write");

      expectNoPathOrIO();
      if (target !== undefined && before !== undefined) expectUnchanged(target, text, before);
      else expect(native.readdirSync(cwd)).toEqual([]);
    },
  );
});

describe.each(modes)("$name build directory reads", ({ options }) => {
  test.each(unsafeKinds)("rejects a %s published build directory without following it", (kind) => {
    const outside = nativePath.join(root, "outside");
    native.mkdirSync(outside);
    const sentinel = nativePath.join(outside, "build-record.json");
    const text = JSON.stringify(buildCase.value);
    native.writeFileSync(sentinel, text);
    native.mkdirSync(nativePath.join(cwd, "builds"));
    const directory = nativePath.join(cwd, "builds", buildCase.id);
    installUnsafe(directory, kind, outside);
    const before = identity(directory);
    const sentinelBefore = identity(sentinel);
    vi.clearAllMocks();

    failure(() => readWorkspaceRecord(cwd, "build", buildCase.id, options), "directory", directory);

    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(io.readFile).not.toHaveBeenCalled();
    expectNoWrites();
    expect(identity(directory)).toEqual(before);
    expectUnchanged(sentinel, text, sentinelBefore);
    if (kind === "file")
      expect(native.readFileSync(directory, "utf8")).toBe("original path bytes\n");
    if (kind === "symlink") expect(native.readlinkSync(directory)).toBe(outside);
    if (kind === "dangling-link") expect(native.existsSync(`${outside}-missing`)).toBe(false);
  });

  test("an absent id directory stays absent under an existing builds root", () => {
    const directory = nativePath.join(cwd, "builds");
    const target = nativePath.join(cwd, buildCase.relative);
    native.mkdirSync(directory);
    const before = identity(directory);
    vi.clearAllMocks();

    failure(() => readWorkspaceRecord(cwd, "build", buildCase.id, options), "missing", target);

    expectNoWrites();
    expect(identity(directory)).toEqual(before);
    expect(native.readdirSync(directory)).toEqual([]);
  });

  test("a published directory without metadata is not repaired", () => {
    const target = nativePath.join(cwd, buildCase.relative);
    const directory = nativePath.dirname(target);
    native.mkdirSync(directory, { recursive: true });
    native.writeFileSync(nativePath.join(directory, "shud"), "existing binary bytes\n");
    const before = identity(directory);
    vi.clearAllMocks();

    failure(() => readWorkspaceRecord(cwd, "build", buildCase.id, options), "missing", target);

    expectNoWrites();
    expect(identity(directory)).toEqual(before);
    expect(native.readdirSync(directory)).toEqual(["shud"]);
    expect(native.readFileSync(nativePath.join(directory, "shud"), "utf8")).toBe(
      "existing binary bytes\n",
    );
  });
});
