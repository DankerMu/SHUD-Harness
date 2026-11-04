import * as childProcess from "node:child_process";
import type * as crypto from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { BuildIdSchema } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fileSnapshot, valueOf } from "./change-create/test-harness.ts";
import { expectToolError, treeOrAbsent } from "./task-linked/test-harness.ts";
import {
  buildFixture,
  noBuilds,
  PRIVATE,
  type BuildFixture,
} from "./shud-build/matrix/test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
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
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
    copyFileSync: vi.fn(actual.copyFileSync),
    createReadStream: vi.fn(actual.createReadStream),
  };
});
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});
const native = await vi.importActual<typeof fs>("node:fs");
const processes = await vi.importActual<typeof childProcess>("node:child_process");
const ids = ["a001", "a002", "a003", "a004", "a005"].map((suffix) =>
  BuildIdSchema.parse(`BUILD-20261102T090000-${suffix}`),
);
let h: BuildFixture;
let opened: Set<number>;
let duplicateCloses: number[];
beforeEach(async () => {
  entropy.suffixes = [];
  h = await buildFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T09:00:00.987Z"));
  entropy.suffixes = ["a001", "a002", "a003", "a004", "a005"];
  opened = new Set();
  duplicateCloses = [];
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    const fd = native.openSync(...args);
    if (String(args[0]).includes("/builds/.tmp-")) opened.add(fd);
    return fd;
  });
  vi.mocked(fs.closeSync).mockImplementation((fd) => {
    if (!opened.delete(fd)) duplicateCloses.push(fd);
    native.closeSync(fd);
  });
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(fs.mkdirSync).mockImplementation(native.mkdirSync);
  vi.mocked(fs.openSync).mockImplementation(native.openSync);
  vi.mocked(fs.closeSync).mockImplementation(native.closeSync);
  vi.mocked(fs.writeFileSync).mockImplementation(native.writeFileSync);
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  vi.mocked(fs.rmSync).mockImplementation(native.rmSync);
  vi.mocked(fs.copyFileSync).mockImplementation(native.copyFileSync);
  vi.mocked(fs.createReadStream).mockImplementation(native.createReadStream);
  vi.mocked(childProcess.execFile).mockImplementation(processes.execFile);
  for (const fd of opened) {
    try {
      native.closeSync(fd);
    } catch {
      /* Fault cleanup only. */
    }
  }
  await h.dispose();
});
function root() {
  return join(native.realpathSync.native(h.cwd), "builds");
}
function temporary(id = ids[0]) {
  return join(root(), `.tmp-${id}`);
}
function fault(): never {
  throw Object.assign(new Error(PRIVATE), { code: "EIO" });
}
function closed() {
  expect(opened.size).toBe(0);
  expect(duplicateCloses).toEqual([]);
}

// Exhaustive allocator permutations remain in records/workspace-build-publication.test.ts.
// These tests exercise that same publisher through real tool admission and producer work.
test.each([
  { location: "temp", count: 1 },
  { location: "final", count: 1 },
  { location: "temp", count: 3 },
])(
  "$count occupied $location identities are retained while the tool publishes the actual replacement id",
  async ({ location, count }) => {
    const foreign = ids.slice(0, count).map((id) => {
      const directory = location === "temp" ? temporary(id) : join(root(), id);
      native.mkdirSync(directory, { recursive: true });
      native.writeFileSync(join(directory, "sentinel"), "foreign\n");
      return directory;
    });
    const snapshots = await Promise.all(foreign.map(treeOrAbsent));
    await h.preserve(async () => {
      const result = valueOf(await h.build());
      expect(result.build_id).toBe(ids[count]);
      const record = readWorkspaceRecord(h.cwd, "build", BuildIdSchema.parse(result.build_id), {
        readonly: true,
      });
      expect(record.make_argv).toContain(`builds/.tmp-${ids[count]}/src`);
      expect(record.binary_path).toBe(`builds/${ids[count]}/shud`);
      expect(
        childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
      ).toBe("base-matrix\n");
      expect(await Promise.all(foreign.map(treeOrAbsent))).toEqual(snapshots);
      closed();
    });
  },
);

test("four occupied identities exhaust allocation without make or overwriting sentinels", async () => {
  for (const id of ids.slice(0, 4)) {
    native.mkdirSync(temporary(id), { recursive: true });
    native.writeFileSync(join(temporary(id), "sentinel"), id);
  }
  const before = await treeOrAbsent(root());
  await h.preserve(async () => {
    vi.clearAllMocks();
    expectToolError(await h.build(), /collision|conflict/iu);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(await treeOrAbsent(root())).toEqual(before);
    expect(entropy.suffixes).toEqual(["a005"]);
  });
});

test("simultaneous public builds competing for one id publish distinct complete executables", async () => {
  entropy.suffixes = ["a001", "a001", "a002"];
  await h.preserve(async () => {
    const results = await Promise.all([h.build(), h.build()]);
    expect(results.map((result) => valueOf(result).build_id).sort()).toEqual(ids.slice(0, 2));
    expect(native.readdirSync(root()).sort()).toEqual(ids.slice(0, 2));
    for (const id of ids.slice(0, 2)) {
      const record = readWorkspaceRecord(h.cwd, "build", id, { readonly: true });
      expect(native.readdirSync(join(root(), id)).sort()).toEqual([
        "build-record.json",
        "make.stderr.log",
        "make.stdout.log",
        "shud",
      ]);
      expect(
        childProcess.execFileSync(join(h.cwd, record.binary_path), [], { encoding: "utf8" }),
      ).toBe("base-matrix\n");
    }
    closed();
  });
});

test("one whole-directory rename publishes all four files after descriptors close", async () => {
  const renames: Array<[string, string]> = [];
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    renames.push([String(from), String(to)]);
    expect(native.existsSync(String(to))).toBe(false);
    expect(native.readdirSync(String(from)).sort()).toEqual([
      "build-record.json",
      "make.stderr.log",
      "make.stdout.log",
      "shud",
    ]);
    closed();
    native.renameSync(from, to);
  });
  await h.preserve(async () => {
    const result = valueOf(await h.build());
    expect(renames).toEqual([[temporary(), join(root(), String(result.build_id))]]);
    expect(native.readdirSync(root())).toEqual([result.build_id]);
  });
});

test("a final target appearing before publication is retained, never overwritten", async () => {
  let sentinel: { bytes: Buffer; mtime: bigint } | undefined;
  vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
    if (typeof args[0] === "number") {
      const final = join(root(), ids[0]);
      native.mkdirSync(final);
      native.writeFileSync(join(final, "sentinel"), "late winner\n");
      sentinel = fileSnapshot(join(final, "sentinel"));
    }
    return native.writeFileSync(...args);
  });
  await h.preserve(async () => {
    expectToolError(await h.build(), /write|publication|collision/iu);
    expect(native.readdirSync(root())).toEqual([ids[0]]);
    expect(fileSnapshot(join(root(), ids[0], "sentinel"))).toEqual(sentinel);
    closed();
  });
});

test.each(["parent", "temporary"])(
  "foreign %s replacement during Git await is neither traversed nor deleted",
  async (kind) => {
    const retained = join(h.root, "retained-owned");
    let replaced = false;
    let sentinel: { bytes: Buffer; mtime: bigint } | undefined;
    vi.mocked(childProcess.execFile).mockImplementation((...args) => {
      if (Array.isArray(args[1]) && args[1].includes("archive") && !replaced) {
        return processes.execFile(args[0], args[1], args[2], (error, stdout, stderr) => {
          replaced = true;
          const target = kind === "parent" ? root() : temporary();
          native.renameSync(target, retained);
          native.mkdirSync(target);
          native.writeFileSync(join(target, "sentinel"), "foreign replacement\n");
          sentinel = fileSnapshot(join(target, "sentinel"));
          args[3]?.(error, stdout, stderr);
        });
      }
      return processes.execFile(...args);
    });
    await h.preserve(async () => {
      const message = expectToolError(await h.build(), /ownership|directory/iu);
      expect(message).toMatch(/cleanup/iu);
      const target = kind === "parent" ? root() : temporary();
      expect(native.readdirSync(target)).toEqual(["sentinel"]);
      expect(fileSnapshot(join(target, "sentinel"))).toEqual(sentinel);
      expect(native.existsSync(retained)).toBe(true);
    });
  },
);

test.each([
  "log-open",
  "copy",
  "hash-stream",
  "log-hash-stream",
  "metadata-short-write",
  "rename",
  "close",
])("%s IO failure closes owned descriptors and removes unpublished output", async (kind) => {
  let hit = false;
  if (kind === "log-open")
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]).endsWith("make.stderr.log")) {
        hit = true;
        fault();
      }
      const fd = native.openSync(...args);
      if (String(args[0]).includes("/builds/.tmp-")) opened.add(fd);
      return fd;
    });
  if (kind === "copy")
    vi.mocked(fs.copyFileSync).mockImplementation(() => {
      hit = true;
      fault();
    });
  if (kind === "hash-stream" || kind === "log-hash-stream") {
    let logReads = 0;
    vi.mocked(fs.createReadStream).mockImplementation((...args) => {
      const stream = native.createReadStream(...args);
      const finalLogRead = String(args[0]).endsWith("make.stdout.log") && ++logReads === 2;
      if (kind === "hash-stream" || finalLogRead) {
        stream.once("data", () => {
          hit = true;
          stream.destroy(new Error(PRIVATE));
        });
      }
      return stream;
    });
  }
  if (kind === "metadata-short-write")
    vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
      if (typeof args[0] === "number") {
        hit = true;
        native.writeFileSync(args[0], "{");
        fault();
      }
      return native.writeFileSync(...args);
    });
  if (kind === "rename")
    vi.mocked(fs.renameSync).mockImplementation(() => {
      hit = true;
      fault();
    });
  if (kind === "close")
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      if (!opened.delete(fd)) duplicateCloses.push(fd);
      native.closeSync(fd);
      if (!hit) {
        hit = true;
        fault();
      }
    });
  await h.preserve(async () => {
    const message = expectToolError(await h.build(), /failed/iu);
    if (kind === "log-hash-stream") {
      expect(message).toMatch(/make\.stdout\.log evidence validation failed/u);
    }
    expect(hit).toBe(true);
    expect(message).not.toContain(PRIVATE);
    expect(message).not.toContain(".tmp-");
    noBuilds(h);
    closed();
  });
});

test("producer failure plus cleanup failure preserves both controlled facts and retained owned evidence", async () => {
  vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    if (Array.isArray(args[1]) && args[1].includes("archive")) {
      return processes.execFile(
        process.execPath,
        ["-e", `process.stderr.write('${PRIVATE}');process.exit(23)`],
        args[2],
        args[3],
      );
    }
    return processes.execFile(...args);
  });
  vi.mocked(fs.rmSync).mockImplementation((path, options) => {
    if (basename(String(path)).startsWith(".tmp-BUILD-")) fault();
    return native.rmSync(path, options);
  });
  await h.preserve(async () => {
    const message = expectToolError(await h.build(), /source archive failed \(exit 23\)/u);
    expect(message).toMatch(/cleanup.*failed/iu);
    expect(message).not.toContain(PRIVATE);
    expect(message).not.toContain(".tmp-");
    expect(native.readdirSync(root())).toEqual([`.tmp-${ids[0]}`]);
    expect(native.existsSync(join(temporary(), "build-record.json"))).toBe(false);
    closed();
  });
});
