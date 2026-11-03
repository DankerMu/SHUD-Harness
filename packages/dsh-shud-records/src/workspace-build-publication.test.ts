import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { inspect } from "node:util";
import type * as NodeCrypto from "node:crypto";
import {
  BuildIdSchema,
  BuildRecordSchema,
  type BuildId,
  type BuildRecord,
} from "@shud-harness/dsh-shud-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  publishBuildDirectory,
  readWorkspaceRecord,
  WorkspaceRecordError,
  type WorkspaceRecordStage,
} from "./index.ts";
import { buildCase } from "./workspace-files-test-harness.ts";
import { installUnsafe, unsafeKinds } from "./test-harness.ts";

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
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
const frozen = BuildRecordSchema.parse(buildCase.value);
const firstId = frozen.build_id;
const secondId = BuildIdSchema.parse("BUILD-20261102T090000-abcd");
const thirdId = BuildIdSchema.parse("BUILD-20261102T090000-1234");
const fourthId = BuildIdSchema.parse("BUILD-20261102T090000-5678");
const candidates = [firstId, secondId, thirdId, fourthId];
const secret = "private-build-producer-payload-527";
let root: string;
let cwd: string;
let descriptors: number[];

beforeEach(() => {
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(native.writeFileSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(native.renameSync);
  vi.mocked(fs.rmSync).mockReset().mockImplementation(native.rmSync);
  descriptors = [];
  vi.mocked(fs.openSync)
    .mockReset()
    .mockImplementation((...args) => {
      const fd = native.openSync(...args);
      descriptors.push(fd);
      return fd;
    });
  root = native.mkdtempSync(join(tmpdir(), "build-publication-"));
  cwd = join(root, "workspace");
  native.mkdirSync(cwd);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T09:00:00.987Z"));
  entropy.suffixes = ["a7b8", "abcd", "1234", "5678", "9999"];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
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

function metadata(id: BuildId): BuildRecord {
  return {
    ...frozen,
    build_id: id,
    binary_path: `builds/${id}/shud`,
    stdout_path: `builds/${id}/make.stdout.log`,
    stderr_path: `builds/${id}/make.stderr.log`,
  };
}
function populate(directory: string, id: BuildId): BuildRecord {
  native.writeFileSync(join(directory, "shud"), "abc", { mode: 0o755, flag: "wx" });
  native.writeFileSync(join(directory, "make.stdout.log"), "fixture compiler output\n", {
    flag: "wx",
  });
  native.writeFileSync(join(directory, "make.stderr.log"), "", { flag: "wx" });
  return metadata(id);
}
function identity(target: string) {
  const { dev, ino, mode, mtimeNs } = native.lstatSync(target, { bigint: true });
  return { dev, ino, mode, mtimeNs };
}
function reserve(relative: string, populated = true): string {
  const directory = join(cwd, "builds", relative);
  native.mkdirSync(directory, { recursive: true });
  if (populated) native.writeFileSync(join(directory, "sentinel"), "foreign directory bytes\n");
  return directory;
}
function expectClosed(): void {
  for (const fd of descriptors) expect(() => native.fstatSync(fd)).toThrow();
}
async function failure(promise: Promise<unknown>, stage: WorkspaceRecordStage): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceRecordError);
  expect(caught).toMatchObject({ stage });
  if (!(caught instanceof Error)) throw new Error("Expected a controlled build publication error");
  expect(caught.cause).toBeUndefined();
  expect(inspect(caught, { depth: null })).not.toContain(secret);
  return caught;
}
function fault(): never {
  throw Object.assign(new Error(secret), { code: "EIO" });
}
function pause() {
  // The repository targets ES2022, before Promise.withResolvers was added to the standard library.
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("publishes metadata directly inside its exclusive temporary and commits one whole directory", async () => {
  const final = join(cwd, "builds", firstId);
  const temporary = join(cwd, "builds", `.tmp-${firstId}`);
  let observed = false;
  vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
    expect(from).toBe(temporary);
    expect(to).toBe(final);
    expect(native.existsSync(final)).toBe(false);
    expect(native.readdirSync(temporary).sort()).toEqual([
      "build-record.json",
      "make.stderr.log",
      "make.stdout.log",
      "shud",
    ]);
    expect(JSON.parse(native.readFileSync(join(temporary, "build-record.json"), "utf8"))).toEqual(
      buildCase.value,
    );
    expectClosed();
    native.renameSync(from, to);
    observed = true;
  });
  const producer = vi.fn(async (directory: string, id: BuildId) => {
    expect(directory).toBe(temporary);
    expect(id).toBe(firstId);
    expect(native.lstatSync(directory).isDirectory()).toBe(true);
    expect(native.lstatSync(directory).isSymbolicLink()).toBe(false);
    expect(native.readdirSync(directory)).toEqual([]);
    expect(native.existsSync(final)).toBe(false);
    return Promise.resolve(populate(directory, id));
  });

  expect(await publishBuildDirectory(cwd, producer)).toEqual(buildCase.value);

  expect(observed).toBe(true);
  expect(producer).toHaveBeenCalledTimes(1);
  const reservations = vi
    .mocked(fs.mkdirSync)
    .mock.calls.filter(([directory]) => String(directory) === temporary);
  expect(reservations).toHaveLength(1);
  const options = reservations[0]?.[1];
  expect(typeof options === "object" && options !== null && options.recursive === true).toBe(false);
  expect(fs.renameSync).toHaveBeenCalledTimes(1);
  expect(readWorkspaceRecord(cwd, "build", firstId, { readonly: true })).toEqual(buildCase.value);
  expect(native.readFileSync(join(final, "shud"), "utf8")).toBe("abc");
  expect(fs.rmSync).not.toHaveBeenCalled();
  expect(native.readdirSync(join(cwd, "builds"))).toEqual([firstId]);
  expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  expectClosed();
});

describe.each(["final", "temporary"] as const)("occupied %s directory", (location) => {
  test.each([1, 2, 3])(
    "reallocates after %i collisions without invoking producers for occupied candidates",
    async (count) => {
      const originals = candidates.slice(0, count).map((id, index) => {
        const directory = reserve(location === "final" ? id : `.tmp-${id}`, index % 2 === 1);
        return { directory, before: identity(directory), contents: native.readdirSync(directory) };
      });
      const selected = candidates[count];
      if (selected === undefined) throw new Error("Missing allocation oracle");
      const producer = vi.fn(async (directory: string, id: BuildId) =>
        Promise.resolve(populate(directory, id)),
      );

      expect(await publishBuildDirectory(cwd, producer)).toEqual(metadata(selected));

      expect(producer).toHaveBeenCalledExactlyOnceWith(
        join(cwd, "builds", `.tmp-${selected}`),
        selected,
      );
      for (const original of originals) {
        expect(identity(original.directory)).toEqual(original.before);
        expect(native.readdirSync(original.directory)).toEqual(original.contents);
        if (original.contents.length > 0)
          expect(native.readFileSync(join(original.directory, "sentinel"), "utf8")).toBe(
            "foreign directory bytes\n",
          );
      }
      expect(native.readdirSync(join(cwd, "builds")).sort()).toEqual(
        [
          ...candidates.slice(0, count).map((id) => (location === "final" ? id : `.tmp-${id}`)),
          selected,
        ].sort(),
      );
      expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"].slice(count));
      expectClosed();
    },
  );

  test("four collisions fail without a fifth candidate or any producer invocation", async () => {
    const originals = candidates.map((id) => {
      const directory = reserve(location === "final" ? id : `.tmp-${id}`);
      return { directory, before: identity(directory) };
    });
    const producer = vi.fn(async (directory: string, id: BuildId) =>
      Promise.resolve(populate(directory, id)),
    );

    const error = await failure(publishBuildDirectory(cwd, producer), "write");

    expect(error.message).toContain(fourthId);
    expect(error.message).toMatch(/collision/iu);
    expect(producer).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["9999"]);
    for (const original of originals) {
      expect(identity(original.directory)).toEqual(original.before);
      expect(native.readFileSync(join(original.directory, "sentinel"), "utf8")).toBe(
        "foreign directory bytes\n",
      );
    }
    expect(native.readdirSync(join(cwd, "builds")).sort()).toEqual(
      originals.map(({ directory }) => basename(directory)).sort(),
    );
  });
});

describe.each(["root", "final", "temporary"] as const)("unsafe %s path", (location) => {
  test.each(unsafeKinds)("rejects %s before producer or destructive cleanup", async (kind) => {
    const outside = join(root, "outside");
    native.mkdirSync(outside);
    native.writeFileSync(join(outside, "sentinel"), "foreign bytes\n");
    const sentinelBefore = identity(join(outside, "sentinel"));
    if (location !== "root") native.mkdirSync(join(cwd, "builds"));
    const target =
      location === "root"
        ? join(cwd, "builds")
        : join(cwd, "builds", location === "final" ? firstId : `.tmp-${firstId}`);
    installUnsafe(target, kind, outside);
    const before = identity(target);
    vi.clearAllMocks();
    const producer = vi.fn(async (directory: string, id: BuildId) =>
      Promise.resolve(populate(directory, id)),
    );

    await failure(publishBuildDirectory(cwd, producer), "directory");

    expect(producer).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(identity(target)).toEqual(before);
    expect(identity(join(outside, "sentinel"))).toEqual(sentinelBefore);
    expect(native.readFileSync(join(outside, "sentinel"), "utf8")).toBe("foreign bytes\n");
    expect(native.readdirSync(outside)).toEqual(["sentinel"]);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  });
});

test("a reservation created immediately before mkdir is preserved and consumes just one candidate", async () => {
  const temporary = join(cwd, "builds", `.tmp-${firstId}`);
  vi.mocked(fs.mkdirSync).mockImplementation((directory, options) => {
    if (String(directory) === temporary && !native.existsSync(temporary)) {
      native.mkdirSync(temporary);
      native.writeFileSync(join(temporary, "sentinel"), "late reservation\n");
    }
    return native.mkdirSync(directory, options);
  });
  const producer = vi.fn(async (directory: string, id: BuildId) =>
    Promise.resolve(populate(directory, id)),
  );

  expect(await publishBuildDirectory(cwd, producer)).toEqual(metadata(secondId));

  expect(producer).toHaveBeenCalledExactlyOnceWith(
    join(cwd, "builds", `.tmp-${secondId}`),
    secondId,
  );
  expect(native.readFileSync(join(temporary, "sentinel"), "utf8")).toBe("late reservation\n");
  expect(entropy.suffixes).toEqual(["1234", "5678", "9999"]);
});

test("cooperating same-id publishers never share or remove another producer's reservation", async () => {
  entropy.suffixes = ["a7b8", "a7b8", "abcd", "9999"];
  const entered = pause();
  const gate = pause();
  const first = publishBuildDirectory(cwd, async (directory, id) => {
    const record = populate(directory, id);
    entered.release();
    await gate.promise;
    return record;
  });
  await entered.promise;
  const temporary = join(cwd, "builds", `.tmp-${firstId}`);
  const before = identity(temporary);
  const contender = vi.fn(async (directory: string, id: BuildId) =>
    Promise.resolve(populate(directory, id)),
  );
  try {
    expect(await publishBuildDirectory(cwd, contender)).toEqual(metadata(secondId));
    expect(contender).toHaveBeenCalledExactlyOnceWith(
      join(cwd, "builds", `.tmp-${secondId}`),
      secondId,
    );
    expect(identity(temporary)).toEqual(before);
    expect(native.readFileSync(join(temporary, "shud"), "utf8")).toBe("abc");
  } finally {
    gate.release();
    await first;
  }
  expect(readWorkspaceRecord(cwd, "build", firstId)).toEqual(buildCase.value);
  expect(native.readdirSync(join(cwd, "builds")).sort()).toEqual([firstId, secondId].sort());
  expect(entropy.suffixes).toEqual(["9999"]);
});

test.each([false, true])(
  "a final directory appearing during producer await, populated=%s, is never replaced",
  async (populated) => {
    const entered = pause();
    const gate = pause();
    const publishing = publishBuildDirectory(cwd, async (directory, id) => {
      const record = populate(directory, id);
      entered.release();
      await gate.promise;
      return record;
    });
    const rejected = failure(publishing, "write");
    await entered.promise;
    const final = reserve(firstId, populated);
    const before = identity(final);
    gate.release();

    const error = await rejected;

    expect(error.message).toContain(firstId);
    expect(error.message).toMatch(/collision/iu);
    expect(identity(final)).toEqual(before);
    expect(native.readdirSync(final)).toEqual(populated ? ["sentinel"] : []);
    if (populated)
      expect(native.readFileSync(join(final, "sentinel"), "utf8")).toBe(
        "foreign directory bytes\n",
      );
    expect(native.readdirSync(join(cwd, "builds"))).toEqual([firstId]);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  },
);

test.each(["temporary", "parent"] as const)(
  "a replaced %s during producer await is preserved and never traversed for cleanup",
  async (replaced) => {
    const entered = pause();
    const gate = pause();
    const publishing = publishBuildDirectory(cwd, async (directory, id) => {
      const record = populate(directory, id);
      entered.release();
      await gate.promise;
      return record;
    });
    const rejected = failure(publishing, "directory");
    await entered.promise;
    const managed = join(cwd, "builds");
    const temporary = join(managed, `.tmp-${firstId}`);
    const target = replaced === "parent" ? managed : temporary;
    const detached = join(root, "detached-owned-directory");
    native.renameSync(target, detached);
    native.mkdirSync(target);
    const foreignTemporary = replaced === "parent" ? join(target, `.tmp-${firstId}`) : target;
    if (replaced === "parent") native.mkdirSync(foreignTemporary);
    native.writeFileSync(join(foreignTemporary, "sentinel"), "replacement bytes\n");
    const before = identity(foreignTemporary);
    vi.clearAllMocks();
    gate.release();

    await rejected;

    expect(identity(foreignTemporary)).toEqual(before);
    expect(native.readFileSync(join(foreignTemporary, "sentinel"), "utf8")).toBe(
      "replacement bytes\n",
    );
    expect(native.readdirSync(foreignTemporary)).toEqual(["sentinel"]);
    expect(native.existsSync(join(managed, firstId))).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(native.existsSync(detached)).toBe(true);
  },
);

test("producer failure cannot clean a foreign symlink replacing its temporary directory", async () => {
  const entered = pause();
  const gate = pause();
  const publishing = publishBuildDirectory(cwd, async (directory, id) => {
    populate(directory, id);
    entered.release();
    await gate.promise;
    return fault();
  });
  const rejected = failure(publishing, "write");
  await entered.promise;
  const temporary = join(cwd, "builds", `.tmp-${firstId}`);
  native.renameSync(temporary, join(root, "detached-owned-directory"));
  const outside = join(root, "outside");
  native.mkdirSync(outside);
  native.writeFileSync(join(outside, "sentinel"), "foreign bytes\n");
  native.symlinkSync(outside, temporary);
  const before = identity(temporary);
  const sentinelBefore = identity(join(outside, "sentinel"));
  vi.clearAllMocks();
  gate.release();

  const error = await rejected;

  expect(error.message).toContain(firstId);
  expect(error.message).toMatch(/producer/iu);
  expect(error.message).toMatch(/cleanup/iu);
  expect(identity(temporary)).toEqual(before);
  expect(native.readlinkSync(temporary)).toBe(outside);
  expect(identity(join(outside, "sentinel"))).toEqual(sentinelBefore);
  expect(native.readFileSync(join(outside, "sentinel"), "utf8")).toBe("foreign bytes\n");
  expect(native.existsSync(join(cwd, "builds", firstId))).toBe(false);
  expect(fs.rmSync).not.toHaveBeenCalled();
});

test.each([
  {
    name: "foreign id with internally valid paths",
    stage: "identity",
    transform: () => metadata(secondId),
  },
  {
    name: "invalid derived binary path",
    stage: "schema",
    transform: () => ({ ...frozen, binary_path: "builds/elsewhere/shud" }),
  },
  {
    name: "invalid derived log path",
    stage: "schema",
    transform: () => ({ ...frozen, stdout_path: "make.stdout.log" }),
  },
] as const)(
  "rejects producer metadata with $name and removes only its reservation",
  async ({ stage, transform }) => {
    const producer = vi.fn(async (directory: string, id: BuildId) => {
      populate(directory, id);
      return Promise.resolve(transform());
    });

    const error = await failure(publishBuildDirectory(cwd, producer), stage);

    expect(error.message).toContain(firstId);
    expect(native.readdirSync(join(cwd, "builds"))).toEqual([]);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  },
);

test.each(["producer", "metadata write", "rename"] as const)(
  "%s failure removes owned temporary state without publishing",
  async (phase) => {
    if (phase === "metadata write")
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => fault());
    if (phase === "rename") vi.mocked(fs.renameSync).mockImplementationOnce(() => fault());
    const producer = vi.fn(async (directory: string, id: BuildId) => {
      const record = populate(directory, id);
      if (phase === "producer") fault();
      return Promise.resolve(record);
    });

    const error = await failure(publishBuildDirectory(cwd, producer), "write");

    expect(error.message).toContain(firstId);
    expect(native.readdirSync(join(cwd, "builds"))).toEqual([]);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  },
);

test.each(["producer", "metadata write", "rename"] as const)(
  "%s failure plus cleanup failure retains controlled primary and cleanup facts",
  async (phase) => {
    if (phase === "metadata write")
      vi.mocked(fs.writeFileSync).mockImplementationOnce(() => fault());
    if (phase === "rename") vi.mocked(fs.renameSync).mockImplementationOnce(() => fault());
    vi.mocked(fs.rmSync).mockImplementationOnce(() => fault());
    const producer = vi.fn(async (directory: string, id: BuildId) => {
      const record = populate(directory, id);
      if (phase === "producer") fault();
      return Promise.resolve(record);
    });

    const error = await failure(publishBuildDirectory(cwd, producer), "write");

    expect(error.message).toContain(firstId);
    expect(error.message).toMatch(
      phase === "producer" ? /producer/iu : phase === "rename" ? /rename/iu : /record|metadata/iu,
    );
    expect(error.message).toMatch(/cleanup/iu);
    expect(native.existsSync(join(cwd, "builds", firstId))).toBe(false);
    expect(native.readdirSync(join(cwd, "builds"))).toEqual([`.tmp-${firstId}`]);
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
    expectClosed();
  },
);

test("metadata write and descriptor cleanup failure preserve both facts and remove only the owned reservation", async () => {
  const foreign = reserve("unrelated-build");
  const before = identity(foreign);
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => fault());
  vi.mocked(fs.closeSync).mockImplementation(() => fault());
  const producer = vi.fn(async (directory: string, id: BuildId) => {
    return Promise.resolve(populate(directory, id));
  });

  const error = await failure(publishBuildDirectory(cwd, producer), "write");

  expect(error.message).toContain(firstId);
  expect(error.message).toMatch(/metadata/iu);
  expect(error.message).toMatch(/cleanup/iu);
  expect(producer).toHaveBeenCalledTimes(1);
  expect(native.existsSync(join(cwd, "builds", firstId))).toBe(false);
  expect(native.readdirSync(join(cwd, "builds"))).toEqual(["unrelated-build"]);
  expect(identity(foreign)).toEqual(before);
  expect(native.readFileSync(join(foreign, "sentinel"), "utf8")).toBe("foreign directory bytes\n");
  expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(descriptors).toHaveLength(1);
  expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(descriptors[0]);
  // The injected close failure leaves the descriptor for the native afterEach cleanup.
});

test("reservation permission failure rejects without producer invocation, reallocation, or cleanup", async () => {
  const managed = join(cwd, "builds");
  native.mkdirSync(managed);
  const before = identity(managed);
  vi.mocked(fs.mkdirSync).mockImplementationOnce(() => {
    throw Object.assign(new Error(secret), { code: "EACCES" });
  });
  const producer = vi.fn(async (directory: string, id: BuildId) => {
    return Promise.resolve(populate(directory, id));
  });

  const error = await failure(publishBuildDirectory(cwd, producer), "write");

  expect(error.message).toContain(firstId);
  expect(error.message).toMatch(/publication/iu);
  expect(producer).not.toHaveBeenCalled();
  expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fs.mkdirSync).mock.calls[0]?.[0]).toBe(join(managed, `.tmp-${firstId}`));
  expect(fs.rmSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
  expect(identity(managed)).toEqual(before);
  expect(native.readdirSync(managed)).toEqual([]);
  expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
});

test.each(["cleans", "commits"] as const)(
  "a winner that %s after native reservation EEXIST does not prevent second-id publication",
  async (outcome) => {
    const foreign = reserve("foreign-build");
    const sentinel = join(foreign, "sentinel");
    const sentinelBefore = identity(sentinel);
    const temporary = join(cwd, "builds", `.tmp-${firstId}`);
    const winnerFinal = join(cwd, "builds", firstId);
    let winnerBefore: unknown;
    let collisions = 0;
    vi.mocked(fs.mkdirSync).mockImplementation((directory, options) => {
      if (String(directory) !== temporary) return native.mkdirSync(directory, options);
      // The winner reserves after our precheck, then retires its reservation before reinspection.
      native.mkdirSync(directory);
      native.writeFileSync(join(temporary, "build-record.json"), JSON.stringify(buildCase.value));
      native.writeFileSync(join(temporary, "sentinel"), "winner bytes\n");
      try {
        return native.mkdirSync(directory, options);
      } catch (error) {
        expect(error).toMatchObject({ code: "EEXIST" });
        collisions += 1;
        if (outcome === "cleans") {
          native.rmSync(temporary, { recursive: true });
        } else {
          native.renameSync(temporary, winnerFinal);
          winnerBefore = {
            directory: identity(winnerFinal),
            sentinel: identity(join(winnerFinal, "sentinel")),
            metadata: identity(join(winnerFinal, "build-record.json")),
          };
        }
        throw error;
      }
    });
    const producer = vi.fn(async (directory: string, id: BuildId) =>
      Promise.resolve(populate(directory, id)),
    );

    expect(await publishBuildDirectory(cwd, producer)).toEqual(metadata(secondId));

    expect(collisions).toBe(1);
    expect(producer).toHaveBeenCalledExactlyOnceWith(
      join(cwd, "builds", `.tmp-${secondId}`),
      secondId,
    );
    expect(readWorkspaceRecord(cwd, "build", secondId)).toEqual(metadata(secondId));
    expect(native.existsSync(temporary)).toBe(false);
    expect(identity(sentinel)).toEqual(sentinelBefore);
    expect(native.readFileSync(sentinel, "utf8")).toBe("foreign directory bytes\n");
    expect(native.readdirSync(join(cwd, "builds")).sort()).toEqual(
      (outcome === "commits"
        ? ["foreign-build", firstId, secondId]
        : ["foreign-build", secondId]
      ).sort(),
    );
    if (outcome === "commits") {
      expect({
        directory: identity(winnerFinal),
        sentinel: identity(join(winnerFinal, "sentinel")),
        metadata: identity(join(winnerFinal, "build-record.json")),
      }).toEqual(winnerBefore);
      expect(native.readFileSync(join(winnerFinal, "sentinel"), "utf8")).toBe("winner bytes\n");
      expect(native.readFileSync(join(winnerFinal, "build-record.json"), "utf8")).toBe(
        JSON.stringify(buildCase.value),
      );
    }
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(entropy.suffixes).toEqual(["1234", "5678", "9999"]);
    expectClosed();
  },
);

test("four native reservation collisions still exhaust the budget when every winner removes its reservation", async () => {
  const foreign = reserve("foreign-build");
  const sentinel = join(foreign, "sentinel");
  const sentinelBefore = identity(sentinel);
  const attempted: string[] = [];
  const temporaryPaths = candidates.map((id) => join(cwd, "builds", `.tmp-${id}`));
  vi.mocked(fs.mkdirSync).mockImplementation((directory, options) => {
    const target = String(directory);
    if (!temporaryPaths.includes(target)) return native.mkdirSync(directory, options);
    native.mkdirSync(directory);
    try {
      return native.mkdirSync(directory, options);
    } catch (error) {
      expect(error).toMatchObject({ code: "EEXIST" });
      attempted.push(target);
      native.rmSync(directory, { recursive: true });
      throw error;
    }
  });
  const producer = vi.fn(async (directory: string, id: BuildId) =>
    Promise.resolve(populate(directory, id)),
  );

  const error = await failure(publishBuildDirectory(cwd, producer), "write");

  expect(error.message).toContain(fourthId);
  expect(error.message).toMatch(/collision/iu);
  expect(attempted).toEqual(temporaryPaths);
  expect(producer).not.toHaveBeenCalled();
  expect(fs.rmSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
  expect(native.readdirSync(join(cwd, "builds"))).toEqual(["foreign-build"]);
  expect(identity(sentinel)).toEqual(sentinelBefore);
  expect(native.readFileSync(sentinel, "utf8")).toBe("foreign directory bytes\n");
  expect(entropy.suffixes).toEqual(["9999"]);
});

test.each(["parent", "temporary"] as const)(
  "post-reservation %s inspection failure reports incomplete cleanup without guessing ownership",
  async (location) => {
    const foreign = reserve("foreign-build");
    const sentinel = join(foreign, "sentinel");
    const sentinelBefore = identity(sentinel);
    const managed = join(cwd, "builds");
    const temporary = join(managed, `.tmp-${firstId}`);
    const inspection = location === "parent" ? managed : temporary;
    let reserved = false;
    let injected = false;
    let reservationBefore: unknown;
    vi.mocked(fs.mkdirSync).mockImplementation((directory, options) => {
      const result = native.mkdirSync(directory, options);
      if (String(directory) === temporary) {
        reservationBefore = identity(temporary);
        reserved = true;
      }
      return result;
    });
    vi.mocked(fs.lstatSync).mockImplementation((target, options) => {
      if (reserved && !injected && String(target) === inspection) {
        injected = true;
        fault();
      }
      return native.lstatSync(target, options);
    });
    const producer = vi.fn(async (directory: string, id: BuildId) =>
      Promise.resolve(populate(directory, id)),
    );

    const error = await failure(publishBuildDirectory(cwd, producer), "directory");

    expect(reserved).toBe(true);
    expect(injected).toBe(true);
    expect(error.message).toContain(firstId);
    expect(error.message).toMatch(/directory/iu);
    expect(error.message).toMatch(/cleanup.*(?:failed|incomplete)/iu);
    expect(producer).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(identity(temporary)).toEqual(reservationBefore);
    expect(native.readdirSync(temporary)).toEqual([]);
    expect(native.existsSync(join(managed, firstId))).toBe(false);
    expect(native.readdirSync(managed).sort()).toEqual([`.tmp-${firstId}`, "foreign-build"].sort());
    expect(identity(sentinel)).toEqual(sentinelBefore);
    expect(native.readFileSync(sentinel, "utf8")).toBe("foreign directory bytes\n");
    expect(entropy.suffixes).toEqual(["abcd", "1234", "5678", "9999"]);
  },
);
