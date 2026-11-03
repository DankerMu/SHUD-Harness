import * as fs from "node:fs";
import type * as path from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { compareRivqdown } from "./index.ts";
import { installUnsafe } from "./test-harness.ts";

const pathMocks = vi.hoisted(() => ({
  join: vi.fn<(...paths: string[]) => string>(),
  resolve: vi.fn<(...paths: string[]) => string>(),
  normalize: vi.fn<(path: string) => string>(),
}));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    statSync: vi.fn(actual.statSync),
    realpathSync: vi.fn(actual.realpathSync),
    accessSync: vi.fn(actual.accessSync),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    readFileSync: vi.fn(actual.readFileSync),
    createReadStream: vi.fn(actual.createReadStream),
    readdirSync: vi.fn(actual.readdirSync),
    closeSync: vi.fn(actual.closeSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    appendFileSync: vi.fn(actual.appendFileSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
    chmodSync: vi.fn(actual.chmodSync),
    utimesSync: vi.fn(actual.utimesSync),
  };
});
vi.mock("node:path", async (original) => {
  const actual = await original<typeof path>();
  pathMocks.join.mockImplementation((...paths) => actual.join(...paths));
  pathMocks.resolve.mockImplementation((...paths) => actual.resolve(...paths));
  pathMocks.normalize.mockImplementation((value) => actual.normalize(value));
  return { ...actual, ...pathMocks };
});

const native = await vi.importActual<typeof fs>("node:fs");
const nativePath = await vi.importActual<typeof path>("node:path");
const project = "keliya";
const relative = "output/keliya.out/keliya.rivqdown.dat";
// Published SHA256 vectors; the binary vector is the byte sequence 00 through ff.
const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const abcSha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const binarySha = "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880";
const millionASha = "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
const privatePayload = "private-native-error-payload-532";
const privateContent = "private-rivqdown-file-content-532";
const sides = ["base", "candidate"] as const;
type Side = (typeof sides)[number];
type Event = { operation: string; path: string; fd?: number };
let root: string;
let base: string;
let candidate: string;
let descriptors: number[];
let active: Map<number, string>;
let events: Event[];
let maximumActive: number;

function openOwned(...args: Parameters<typeof fs.openSync>): number {
  const fd = native.openSync(...args);
  const target = String(args[0]);
  descriptors.push(fd);
  active.set(fd, target);
  maximumActive = Math.max(maximumActive, active.size);
  events.push({ operation: "open", path: target, fd });
  return fd;
}
function closeOwned(fd: number): void {
  const target = active.get(fd) ?? "unowned";
  native.closeSync(fd);
  active.delete(fd);
  events.push({ operation: "close", path: target, fd });
}

beforeEach(() => {
  vi.mocked(fs.lstatSync)
    .mockReset()
    .mockImplementation((...args) => {
      events.push({ operation: "lstat", path: String(args[0]) });
      return native.lstatSync(...args);
    });
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(native.fstatSync);
  vi.mocked(fs.readSync)
    .mockReset()
    .mockImplementation((...args) => {
      events.push({ operation: "read", path: active.get(args[0]) ?? "unowned", fd: args[0] });
      return native.readSync(...args);
    });
  vi.mocked(fs.openSync).mockReset().mockImplementation(openOwned);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(closeOwned);
  descriptors = [];
  active = new Map();
  events = [];
  maximumActive = 0;
  root = native.mkdtempSync(nativePath.join(tmpdir(), "compare-rivqdown-"));
  base = nativePath.join(root, "base");
  candidate = nativePath.join(root, "candidate");
  native.mkdirSync(base);
  native.mkdirSync(candidate);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  // Harness recovery is deliberately separate from assertions about production closure.
  // In persistent-close tests the production descriptor state/ownership is unknown.
  for (const fd of active.keys()) {
    try {
      native.closeSync(fd);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EBADF")) throw error;
    }
  }
  native.rmSync(root, { recursive: true, force: true });
});

function target(side: Side): string {
  return `${side === "base" ? base : candidate}/${relative}`;
}
function seed(run: string, bytes: string | Uint8Array = "abc", name = project): string {
  const directory = `${run}/output/${name}.out`;
  native.mkdirSync(directory, { recursive: true });
  const file = `${directory}/${name}.rivqdown.dat`;
  native.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
function seedPair(left: string | Uint8Array = "abc", right: string | Uint8Array = left): void {
  seed(base, left);
  seed(candidate, right);
}
function snapshot(file: string) {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(file, { bigint: true });
  return { dev, ino, mode, mtimeNs, bytes: native.readFileSync(file) };
}
function fault(code = "EIO"): never {
  throw Object.assign(new Error(privatePayload, { cause: new Error(privateContent) }), {
    code,
    private_data: privatePayload,
  });
}
function failure(action: () => unknown, file?: string, stage?: RegExp): Error {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error))
    throw new Error("Expected comparison to throw, not return a verdict");
  if (file !== undefined) expect(caught.message).toContain(file);
  if (stage !== undefined) expect(caught.message).toMatch(stage);
  expect(caught.cause).toBeUndefined();
  const diagnostic = inspect(caught, { depth: null, showHidden: true });
  expect(diagnostic).not.toContain(privatePayload);
  expect(diagnostic).not.toContain(privateContent);
  return caught;
}
function compare() {
  return compareRivqdown(base, candidate, project);
}
function expectNoWrites(): void {
  for (const operation of [
    fs.mkdirSync,
    fs.writeFileSync,
    fs.appendFileSync,
    fs.renameSync,
    fs.unlinkSync,
    fs.rmSync,
    fs.chmodSync,
    fs.utimesSync,
  ])
    expect(operation).not.toHaveBeenCalled();
}
function expectClosed(): void {
  expect(active.size).toBe(0);
  for (const fd of descriptors) expect(() => native.fstatSync(fd)).toThrow();
}
function expectNoPathOrIO(): void {
  for (const operation of [
    pathMocks.join,
    pathMocks.resolve,
    pathMocks.normalize,
    fs.lstatSync,
    fs.statSync,
    fs.realpathSync,
    fs.accessSync,
    fs.openSync,
    fs.fstatSync,
    fs.readSync,
    fs.readFileSync,
    fs.createReadStream,
    fs.readdirSync,
    fs.closeSync,
  ])
    expect(operation).not.toHaveBeenCalled();
  expectNoWrites();
}
function expected(baseSha: string, candidateSha = baseSha, name = project) {
  return {
    compared_path: `output/${name}.out/${name}.rivqdown.dat`,
    base_sha256: baseSha,
    candidate_sha256: candidateSha,
    equal: baseSha === candidateSha,
  };
}
function expectReadOnlyFlags(): void {
  for (const [, flags] of vi.mocked(fs.openSync).mock.calls) {
    expect(typeof flags).toBe("number");
    expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  }
}

describe("raw byte comparison", () => {
  test.each([
    { label: "empty", bytes: Buffer.alloc(0), digest: emptySha },
    { label: "ASCII abc", bytes: Buffer.from("abc"), digest: abcSha },
    {
      label: "non-UTF8 including NUL",
      bytes: Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      digest: binarySha,
    },
  ])("returns exactly four fields for identical $label files", ({ bytes, digest }) => {
    seedPair(bytes);
    const before = sides.map((side) => snapshot(target(side)));

    expect(compare()).toEqual(expected(digest));

    expect(sides.map((side) => snapshot(target(side)))).toEqual(before);
    expectReadOnlyFlags();
    expectNoWrites();
    expectClosed();
  });

  test.each([
    {
      label: "one changed byte",
      left: "abc",
      right: "abb",
      leftSha: abcSha,
      rightSha: "715edf8ba8729420cd4d1ce85ed61954a9f531f8c548df728c407effe839296d",
    },
    {
      label: "numerically equivalent text",
      left: "1\n",
      right: "1.0\n",
      leftSha: "4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865",
      rightSha: "5717e7c840171019a4eeab5b79a7f894a4986eaff93d04ec5b12c9a189f594bf",
    },
  ])("compares both independent digests for $label", ({ left, right, leftSha, rightSha }) => {
    seedPair(left, right);
    const before = sides.map((side) => snapshot(target(side)));

    expect(compare()).toEqual({ ...expected(leftSha, rightSha), equal: false });

    expect(sides.map((side) => snapshot(target(side)))).toEqual(before);
    expectNoWrites();
    expectClosed();
  });

  test("allows comparing the same path without inventing a distinct-run policy", () => {
    seed(base);
    const before = snapshot(target("base"));
    expect(compareRivqdown(base, base, project)).toEqual(expected(abcSha));
    expect(snapshot(target("base"))).toEqual(before);
    expectNoWrites();
    expectClosed();
  });

  test("preflights both targets and hashes large evidence with one bounded descriptor at a time", () => {
    seedPair(Buffer.alloc(1_000_000, 0x61));
    const unrelated = [
      `${base}/stdout.log`,
      `${candidate}/stderr.log`,
      `${base}/output/${project}.out/cvode_stats.txt`,
      `${candidate}/output/${project}.out/other.dat`,
    ];
    for (const file of unrelated) native.writeFileSync(file, privateContent);
    const files = [...sides.map(target), ...unrelated];
    const before = files.map(snapshot);

    expect(compare()).toEqual(expected(millionASha));

    const firstOpen = events.findIndex((event) => event.operation === "open");
    for (const side of sides) {
      const inspected = events.findIndex(
        (event) => event.operation === "lstat" && event.path === target(side),
      );
      expect(inspected).toBeGreaterThanOrEqual(0);
      expect(inspected).toBeLessThan(firstOpen);
      const reads = events.filter(
        (event) => event.operation === "read" && event.path === target(side),
      );
      expect(reads.length).toBeGreaterThan(1);
    }
    expect(events.filter((event) => event.operation === "open").map((event) => event.path)).toEqual(
      [target("base"), target("candidate")],
    );
    const baseClose = events.findIndex(
      (event) => event.operation === "close" && event.path === target("base"),
    );
    const candidateOpen = events.findIndex(
      (event) => event.operation === "open" && event.path === target("candidate"),
    );
    expect(baseClose).toBeGreaterThan(firstOpen);
    expect(baseClose).toBeLessThan(candidateOpen);
    expect(maximumActive).toBe(1);
    for (const call of vi.mocked(fs.readSync).mock.calls) {
      const buffer = call[1];
      expect(buffer).toBeDefined();
      if (buffer !== undefined) expect(buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
      const positionalLength = (call as readonly unknown[])[3];
      const requested =
        typeof positionalLength === "number"
          ? positionalLength
          : (call[2]?.length ?? buffer?.byteLength);
      expect(requested).toBeGreaterThan(0);
      expect(requested).toBeLessThanOrEqual(64 * 1024);
    }
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
    for (const file of unrelated) expect(events.some((event) => event.path === file)).toBe(false);
    const after = files.map(snapshot);
    for (const [index, prior] of before.entries()) {
      const current = after[index];
      expect(current?.bytes.equals(prior.bytes)).toBe(true);
      expect({ ...current, bytes: undefined }).toEqual({ ...prior, bytes: undefined });
    }
    expectReadOnlyFlags();
    expectNoWrites();
    expectClosed();
  });
});

describe("input validation and physical paths", () => {
  test.each(
    ["", ".", "..", "a/b", "a\\b", "a\0b", null, undefined, 7, {}, ["keliya"]].map((value) => ({
      value,
    })),
  )("rejects project $value before target construction or IO", ({ value }) => {
    failure(() => compareRivqdown(base, candidate, value as string));
    expectNoPathOrIO();
  });

  describe.each(sides)("invalid %s root", (side) => {
    test.each(
      ["", ".", "relative/run", "../run", null, undefined, 7, {}, ["/tmp"]].map((value) => ({
        value,
      })),
    )("rejects $value before target construction or IO", ({ value }) => {
      failure(() =>
        compareRivqdown(
          side === "base" ? (value as string) : base,
          side === "candidate" ? (value as string) : candidate,
          project,
        ),
      );
      expectNoPathOrIO();
    });
  });

  test.each(["a..b", "...", ".hidden", " ", " spaced ", "流域", "line\nbreak", "x;$(echo nope)&'"])(
    "preserves the canonical accepted project spelling %j",
    (name) => {
      seed(base, "abc", name);
      seed(candidate, "abc", name);
      expect(compareRivqdown(base, candidate, name)).toEqual(expected(abcSha, abcSha, name));
      expectNoWrites();
      expectClosed();
    },
  );

  test("accepts run-root aliases and trailing separators without rejecting ancestors", () => {
    seedPair();
    const alias = nativePath.join(root, "base-alias");
    native.symlinkSync(base, alias);
    expect(compareRivqdown(`${alias}///`, `${candidate}//`, project)).toEqual(expected(abcSha));
    expectNoWrites();
    expectClosed();
  });

  test("follows physical symlink-parent traversal rather than hashing lexical decoys", () => {
    const physical = nativePath.join(root, "physical");
    native.mkdirSync(`${physical}/child`, { recursive: true });
    native.symlinkSync(`${physical}/child`, `${base}/alias`);
    seed(physical, "abc");
    seed(base, ""); // resolve(base/alias/..) would incorrectly select this file.
    seed(candidate, "abc");
    const before = [snapshot(`${physical}/${relative}`), snapshot(target("base"))];

    expect(compareRivqdown(`${base}/alias/..`, candidate, project)).toEqual(expected(abcSha));
    expect(compareRivqdown(candidate, `${base}/alias/..`, project)).toEqual(expected(abcSha));

    expect([snapshot(`${physical}/${relative}`), snapshot(target("base"))]).toEqual(before);
    expectNoWrites();
    expectClosed();
  });
});

describe.each(sides)("%s evidence safety", (side) => {
  test.each(["missing", "symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s final target before either content read",
    (kind) => {
      seedPair();
      const file = target(side);
      const outside = `${root}/outside`;
      native.writeFileSync(outside, privateContent);
      const before = snapshot(outside);
      native.unlinkSync(file);
      if (kind !== "missing") installUnsafe(file, kind, outside);
      vi.clearAllMocks();
      // Never let a broken preflight hang on a real FIFO.
      vi.mocked(fs.openSync).mockImplementation(() => fault());

      failure(compare, file);

      expect(fs.openSync).not.toHaveBeenCalled();
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(snapshot(outside)).toEqual(before);
      expectNoWrites();
      expectClosed();
    },
  );

  test.each(["file", "symlink", "directory", "fifo"] as const)(
    "rejects replacement with a different %s between preflight and open",
    (kind) => {
      seedPair();
      const file = target(side);
      const detached = `${root}/detached`;
      const outside = `${root}/outside`;
      native.writeFileSync(outside, privateContent);
      const outsideBefore = snapshot(outside);
      let replaced = false;
      vi.mocked(fs.openSync).mockImplementation((...args) => {
        if (String(args[0]) === file && !replaced) {
          replaced = true;
          native.renameSync(file, detached);
          if (kind === "file") native.writeFileSync(file, "abc");
          else if (kind === "directory") native.mkdirSync(file);
          else if (kind === "symlink") native.symlinkSync(outside, file);
          else installUnsafe(file, kind, outside);
          // A missing flag must fail assertions below, not block the runner or follow a link.
          if (
            typeof args[1] !== "number" ||
            !(args[1] & fs.constants.O_NONBLOCK) ||
            !(args[1] & fs.constants.O_NOFOLLOW)
          )
            fault();
        }
        return openOwned(...args);
      });

      failure(compare, file);

      expect(replaced).toBe(true);
      expectReadOnlyFlags();
      expect(events.filter((event) => event.operation === "read" && event.path === file)).toEqual(
        [],
      );
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(snapshot(outside)).toEqual(outsideBefore);
      expect(native.readFileSync(detached, "utf8")).toBe("abc");
      expectNoWrites();
      expectClosed();
    },
  );

  test.each(["dev", "ino", "type"] as const)(
    "rejects a descriptor %s mismatch before reading it",
    (field) => {
      seedPair();
      const file = target(side);
      let injected = false;
      vi.mocked(fs.fstatSync).mockImplementation((...args) => {
        const stat = native.fstatSync(...args);
        if (active.get(args[0]) === file) {
          injected = true;
          if (field === "type") stat.isFile = () => false;
          else Object.defineProperty(stat, field, { value: Number(stat[field]) + 1 });
        }
        return stat;
      });

      failure(compare, file);

      expect(injected).toBe(true);
      expect(events.filter((event) => event.operation === "read" && event.path === file)).toEqual(
        [],
      );
      expectNoWrites();
      expectClosed();
    },
  );

  test.each(["lstat", "open", "fstat", "read"] as const)(
    "controls a %s failure and releases owned descriptors when cleanup succeeds",
    (phase) => {
      seedPair(privateContent);
      const file = target(side);
      const before = sides.map((value) => snapshot(target(value)));
      let injected = false;
      if (phase === "lstat")
        vi.mocked(fs.lstatSync).mockImplementation((...args) => {
          if (String(args[0]) === file) {
            injected = true;
            fault("EACCES");
          }
          return native.lstatSync(...args);
        });
      if (phase === "open")
        vi.mocked(fs.openSync).mockImplementation((...args) => {
          if (String(args[0]) === file) {
            injected = true;
            fault("EACCES");
          }
          return openOwned(...args);
        });
      if (phase === "fstat")
        vi.mocked(fs.fstatSync).mockImplementation((...args) => {
          if (active.get(args[0]) === file) {
            injected = true;
            fault();
          }
          return native.fstatSync(...args);
        });
      if (phase === "read")
        vi.mocked(fs.readSync).mockImplementation((...args) => {
          if (active.get(args[0]) === file) {
            injected = true;
            fault();
          }
          return native.readSync(...args);
        });
      const stages = {
        lstat: /lstat|inspect|target/iu,
        open: /open|read/iu,
        fstat: /fstat|descriptor|read/iu,
        read: /read/iu,
      };

      failure(compare, file, stages[phase]);

      expect(injected).toBe(true);
      if (phase === "lstat") expect(fs.openSync).not.toHaveBeenCalled();
      expect(sides.map((value) => snapshot(target(value)))).toEqual(before);
      expectNoWrites();
      expectClosed();
    },
  );

  test("does not return a verdict on persistent primary-close failure or claim release", () => {
    seedPair(privateContent);
    const file = target(side);
    const before = sides.map((value) => snapshot(target(value)));
    let closeFailures = 0;
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      if (active.get(fd) === file) {
        closeFailures += 1;
        fault();
      }
      closeOwned(fd);
    });

    failure(compare, file, /close|read/iu);

    expect(closeFailures).toBe(1);
    if (side === "base")
      expect(
        events.some((event) => event.operation === "open" && event.path === target("candidate")),
      ).toBe(false);
    expect(sides.map((value) => snapshot(target(value)))).toEqual(before);
    expectNoWrites();
    // Deliberately no expectClosed/no-leak assertion: close failure leaves ownership unknown.
  });

  test.each(["fstat", "read"] as const)(
    "preserves the primary %s failure when cleanup-close persistently fails",
    (phase) => {
      seedPair(privateContent);
      const file = target(side);
      const before = sides.map((value) => snapshot(target(value)));
      let primaryFailures = 0;
      let cleanupFailures = 0;
      if (phase === "fstat")
        vi.mocked(fs.fstatSync).mockImplementation((...args) => {
          if (active.get(args[0]) === file) {
            primaryFailures += 1;
            fault();
          }
          return native.fstatSync(...args);
        });
      if (phase === "read")
        vi.mocked(fs.readSync).mockImplementation((...args) => {
          if (active.get(args[0]) === file) {
            primaryFailures += 1;
            fault();
          }
          return native.readSync(...args);
        });
      vi.mocked(fs.closeSync).mockImplementation((fd) => {
        if (active.get(fd) === file) {
          cleanupFailures += 1;
          fault("EACCES");
        }
        closeOwned(fd);
      });

      const error = failure(compare, file, phase === "read" ? /read/iu : /fstat|descriptor|read/iu);

      expect(error.message).toMatch(/cleanup/iu);
      expect(primaryFailures).toBe(1);
      expect(cleanupFailures).toBe(1);
      if (side === "base")
        expect(
          events.some((event) => event.operation === "open" && event.path === target("candidate")),
        ).toBe(false);
      expect(sides.map((value) => snapshot(target(value)))).toEqual(before);
      expectNoWrites();
      // Harness recovery below is not evidence that production closed this descriptor.
    },
  );
});
