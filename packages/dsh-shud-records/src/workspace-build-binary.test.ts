import * as fs from "node:fs";
import { join, normalize, resolve } from "node:path";
import type * as NodePath from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { BuildRecordSchema, type BuildId, type BuildRecord } from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyBuildBinary, WorkspaceRecordError, type WorkspaceRecordStage } from "./index.ts";
import { buildCase } from "./workspace-files-test-harness.ts";
import { installUnsafe, unsafeKinds } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    fstatSync: vi.fn(actual.fstatSync),
    accessSync: vi.fn(actual.accessSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    closeSync: vi.fn(actual.closeSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
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
const frozen = BuildRecordSchema.parse(buildCase.value);
const secret = "private-binary-read-payload-527";
let root: string;
let cwd: string;
let descriptors: number[];

beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(native.fstatSync);
  vi.mocked(fs.accessSync).mockReset().mockImplementation(native.accessSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
  descriptors = [];
  vi.mocked(fs.openSync)
    .mockReset()
    .mockImplementation((...args) => {
      const fd = native.openSync(...args);
      descriptors.push(fd);
      return fd;
    });
  root = native.mkdtempSync(nativePath.join(tmpdir(), "build-binary-"));
  cwd = nativePath.join(root, "workspace");
  native.mkdirSync(cwd);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const fd of descriptors) {
    try {
      native.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  native.rmSync(root, { recursive: true, force: true });
});

function seed(bytes: string | Uint8Array = "abc", mode = 0o755): string {
  const binary = nativePath.join(cwd, buildCase.value.binary_path);
  native.mkdirSync(nativePath.dirname(binary), { recursive: true });
  native.writeFileSync(binary, bytes, { mode });
  native.chmodSync(binary, mode);
  return binary;
}
function snapshot(target: string) {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(target, { bigint: true });
  return { dev, ino, mode, mtimeNs, bytes: native.readFileSync(target) };
}
function identity(target: string) {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(target, { bigint: true });
  return { dev, ino, mode, mtimeNs };
}
function failure(record: BuildRecord, stage?: WorkspaceRecordStage): Error {
  let caught: unknown;
  try {
    verifyBuildBinary(cwd, record);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceRecordError);
  if (stage !== undefined) expect(caught).toMatchObject({ stage });
  if (!(caught instanceof Error)) throw new Error("Expected controlled binary rejection");
  expect(caught.cause).toBeUndefined();
  expect(inspect(caught, { depth: null })).not.toContain(secret);
  return caught;
}
function expectNoWrites(): void {
  for (const operation of [fs.mkdirSync, fs.writeFileSync, fs.renameSync, fs.rmSync])
    expect(operation).not.toHaveBeenCalled();
}
function expectClosed(): void {
  for (const fd of descriptors) expect(() => native.fstatSync(fd)).toThrow();
}
function expectNoPathOrIO(): void {
  for (const operation of [
    join,
    resolve,
    normalize,
    fs.lstatSync,
    fs.fstatSync,
    fs.accessSync,
    fs.openSync,
    fs.readSync,
    fs.readFileSync,
    fs.closeSync,
  ])
    expect(operation).not.toHaveBeenCalled();
  expectNoWrites();
}
function fault(code = "EIO"): never {
  throw Object.assign(new Error(secret), { code });
}

test("accepts the known SHA256 of a regular executable using a closed descriptor without metadata or logs", () => {
  const binary = seed();
  const before = snapshot(binary);
  vi.clearAllMocks();

  expect(verifyBuildBinary(cwd, frozen)).toBeUndefined();

  expect(descriptors).toHaveLength(1);
  expect(fs.fstatSync).toHaveBeenCalled();
  expect(fs.readSync).toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  for (const [fd] of vi.mocked(fs.readSync).mock.calls) expect(fd).toBe(descriptors[0]);
  expect(vi.mocked(fs.accessSync).mock.calls.some(([, mode]) => mode === fs.constants.X_OK)).toBe(
    true,
  );
  expectNoWrites();
  expectClosed();
  expect(snapshot(binary)).toEqual(before);
  expect(native.readdirSync(nativePath.dirname(binary))).toEqual(["shud"]);
});

test("hashes a large executable in bounded chunks against the independent million-a SHA256 vector", () => {
  const bytes = Buffer.alloc(1_000_000, 0x61);
  const binary = seed(bytes);
  const before = snapshot(binary);
  const record = {
    ...frozen,
    binary_sha256: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  };
  vi.clearAllMocks();

  expect(verifyBuildBinary(cwd, record)).toBeUndefined();

  expect(vi.mocked(fs.readSync).mock.calls.length).toBeGreaterThan(1);
  for (const call of vi.mocked(fs.readSync).mock.calls) {
    const buffer = call[1];
    if (buffer !== undefined) expect(buffer.byteLength).toBeLessThan(bytes.byteLength);
  }
  expect(fs.readFileSync).not.toHaveBeenCalled();
  const { bytes: afterBytes, ...afterIdentity } = snapshot(binary);
  const { bytes: beforeBytes, ...beforeIdentity } = before;
  expect(afterBytes.equals(beforeBytes)).toBe(true);
  expect(afterIdentity).toEqual(beforeIdentity);
  expectNoWrites();
  expectClosed();
});

test.each([
  "../tasks/x",
  "BUILD-0001",
  "BUILD-20261102T090000-A7B8",
  "CHG-20261102T090000-a7b8",
  null,
])("rejects invalid build id %j before paths or IO", (id) => {
  failure({ ...frozen, build_id: id as BuildId }, "id");
  expectNoPathOrIO();
  expect(native.readdirSync(cwd)).toEqual([]);
});

test.each([
  { ...frozen, binary_path: "builds/foreign/shud" },
  { ...frozen, binary_sha256: "not-a-digest" },
  { ...frozen, stdout_path: "builds/foreign/make.stdout.log" },
  { ...frozen, duration_seconds: -1 },
])("rejects an invalid complete record before paths or IO", (record) => {
  failure(record, "schema");
  expectNoPathOrIO();
  expect(native.readdirSync(cwd)).toEqual([]);
});

test.each([false, true])(
  "missing binary with builds root present=%s never creates paths",
  (exists) => {
    if (exists) native.mkdirSync(nativePath.join(cwd, "builds"));
    vi.clearAllMocks();

    failure(frozen, "missing");

    expectNoWrites();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(native.readdirSync(cwd)).toEqual(exists ? ["builds"] : []);
    if (exists) expect(native.readdirSync(nativePath.join(cwd, "builds"))).toEqual([]);
  },
);

describe.each(["root", "build"] as const)("unsafe %s directory", (location) => {
  test.each(unsafeKinds)("rejects %s without reading foreign binary bytes", (kind) => {
    const outside = nativePath.join(root, "outside");
    native.mkdirSync(outside);
    const sentinel = nativePath.join(outside, "shud");
    native.writeFileSync(sentinel, "abc", { mode: 0o755 });
    const before = snapshot(sentinel);
    const target =
      location === "root"
        ? nativePath.join(cwd, "builds")
        : nativePath.join(cwd, "builds", frozen.build_id);
    if (location === "build") native.mkdirSync(nativePath.join(cwd, "builds"));
    installUnsafe(target, kind, outside);
    const targetBefore = identity(target);
    vi.clearAllMocks();

    failure(frozen, "directory");

    expect(identity(target)).toEqual(targetBefore);
    expect(snapshot(sentinel)).toEqual(before);
    expect(native.readdirSync(outside)).toEqual(["shud"]);
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.accessSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
  "rejects a %s binary before access/open/read",
  (kind) => {
    const outside = nativePath.join(root, "outside-shud");
    native.writeFileSync(outside, "abc", { mode: 0o755 });
    const before = snapshot(outside);
    const target = nativePath.join(cwd, frozen.binary_path);
    native.mkdirSync(nativePath.dirname(target), { recursive: true });
    installUnsafe(target, kind, outside);
    const targetBefore = identity(target);
    // Guard a FIFO against a broken implementation blocking the test runner.
    vi.mocked(fs.openSync).mockImplementation(() => {
      throw new Error("Unsafe binary must not be opened");
    });
    vi.clearAllMocks();

    failure(frozen, "target");

    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.accessSync).not.toHaveBeenCalled();
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(identity(target)).toEqual(targetBefore);
    expect(snapshot(outside)).toEqual(before);
    expectNoWrites();
  },
);

test("rejects a non-executable regular file even when its digest matches", () => {
  const binary = seed("abc", 0o644);
  const before = snapshot(binary);
  vi.clearAllMocks();

  failure(frozen, "target");

  expect(fs.readSync).not.toHaveBeenCalled();
  expect(snapshot(binary)).toEqual(before);
  expectNoWrites();
  expectClosed();
});

test("effective X_OK denial rejects before hashing despite execute mode bits", () => {
  const binary = seed();
  const before = snapshot(binary);
  vi.mocked(fs.accessSync).mockImplementationOnce(() => fault("EACCES"));

  failure(frozen, "target");

  expect(fs.accessSync).toHaveBeenCalled();
  expect(fs.readSync).not.toHaveBeenCalled();
  expect(snapshot(binary)).toEqual(before);
  expectNoWrites();
  expectClosed();
});

test("mode 0641 follows actual OS execute permission rather than any-bit presence", () => {
  const binary = seed("abc", 0o641);
  const before = snapshot(binary);
  let executable = true;
  try {
    native.accessSync(binary, native.constants.X_OK);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EACCES")) throw error;
    executable = false;
  }
  vi.clearAllMocks();

  if (executable) expect(verifyBuildBinary(cwd, frozen)).toBeUndefined();
  else failure(frozen, "target");

  if (!executable) expect(fs.readSync).not.toHaveBeenCalled();
  expect(snapshot(binary)).toEqual(before);
  expectNoWrites();
  expectClosed();
});

test("one flipped byte rejects without repairing or replacing the binary", () => {
  const binary = seed(Buffer.from([97, 98, 98]));
  const before = snapshot(binary);
  vi.clearAllMocks();

  failure(frozen);

  expect(descriptors).toHaveLength(1);
  expect(fs.readSync).toHaveBeenCalled();
  expect(snapshot(binary)).toEqual(before);
  expectNoWrites();
  expectClosed();
});

test.each(["open", "descriptor stat", "read", "close"] as const)(
  "%s failure retains bytes, closes descriptors, and hides the underlying payload",
  (phase) => {
    const binary = seed();
    const before = snapshot(binary);
    if (phase === "open") vi.mocked(fs.openSync).mockImplementationOnce(() => fault("EACCES"));
    if (phase === "descriptor stat") vi.mocked(fs.fstatSync).mockImplementationOnce(() => fault());
    if (phase === "read") vi.mocked(fs.readSync).mockImplementationOnce(() => fault());
    if (phase === "close") vi.mocked(fs.closeSync).mockImplementationOnce(() => fault());

    failure(frozen);

    expect(snapshot(binary)).toEqual(before);
    expectNoWrites();
    expectClosed();
  },
);

test("descriptor read and cleanup failure preserve both controlled facts without mutating the binary", () => {
  const binary = seed();
  const before = snapshot(binary);
  vi.mocked(fs.readSync).mockImplementationOnce(() => fault());
  vi.mocked(fs.closeSync).mockImplementation(() => fault("EACCES"));

  const error = failure(frozen, "read");

  expect(error.message).toContain(frozen.build_id);
  expect(error.message).toMatch(/read/iu);
  expect(error.message).toMatch(/cleanup/iu);
  expect(snapshot(binary)).toEqual(before);
  expectNoWrites();
  expect(descriptors).toHaveLength(1);
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(descriptors[0]);
  // No closure claim under a forced close failure; afterEach closes the real tracked descriptor.
});

test("a different inode opened after the path inspection is rejected before hashing", () => {
  const binary = seed();
  const detached = nativePath.join(root, "detached-binary");
  vi.mocked(fs.openSync).mockImplementationOnce((target, flags, mode) => {
    native.renameSync(binary, detached);
    native.writeFileSync(binary, "abc", { mode: 0o755 });
    const fd = native.openSync(target, flags, mode);
    descriptors.push(fd);
    return fd;
  });

  failure(frozen, "target");

  expect(fs.readSync).not.toHaveBeenCalled();
  expect(native.readFileSync(binary, "utf8")).toBe("abc");
  expect(native.readFileSync(detached, "utf8")).toBe("abc");
  expectNoWrites();
  expectClosed();
});

test("a pathname replacement after open cannot substitute its matching digest for the opened bytes", () => {
  const binary = seed("abc");
  const detached = nativePath.join(root, "opened-binary");
  const replacement = Buffer.alloc(1_000_000, 0x61);
  const record = {
    ...frozen,
    binary_sha256: "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  };
  vi.mocked(fs.openSync).mockImplementationOnce((target, flags, mode) => {
    const fd = native.openSync(target, flags, mode);
    descriptors.push(fd);
    native.renameSync(binary, detached);
    native.writeFileSync(binary, replacement, { mode: 0o755 });
    return fd;
  });

  // Either an ownership rejection or hashing the original descriptor must reject.
  // Reopening the pathname would incorrectly accept the replacement's known digest.
  failure(record);

  expect(native.readFileSync(detached, "utf8")).toBe("abc");
  expect(native.readFileSync(binary).equals(replacement)).toBe(true);
  expectNoWrites();
  expectClosed();
});
