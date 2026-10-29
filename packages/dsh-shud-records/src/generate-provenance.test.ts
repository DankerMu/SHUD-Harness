import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DataProvenanceSchema, type DataProvenance } from "@shud-harness/dsh-shud-core";
import { createDataProvenance, generateProvenance, readWorkspaceRecord } from "./index.ts";
import { installUnsafe, unsafeKinds } from "./test-harness.ts";

const enumeration = vi.hoisted(() => ({ directory: "", name: undefined as Buffer | undefined }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    readdirSync: vi.fn((...args: Parameters<typeof actual.readdirSync>) => {
      if (args[0] === enumeration.directory && enumeration.name !== undefined) {
        return [enumeration.name];
      }
      return actual.readdirSync(...args);
    }),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const realIo = await vi.importActual<typeof NodeIo>("node:fs/promises");

// Independent SHA-256 and byte-count oracle, established with shasum and hashlib.
// Literal fixtures are intentionally self-contained: no runtime .workplans dependency.
const vectors = [
  {
    path: "empty",
    hex: "",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    size_bytes: 0,
  },
  {
    path: "nested/a.bin",
    hex: "00ff010a0d2a",
    sha256: "93e58b5d4bb897e28621cd06bb68c22bed699e0f5d18a3d95aa009eacb76914e",
    size_bytes: 6,
  },
  {
    path: "nested/雨.txt",
    hex: "e9998de6b0b40a",
    sha256: "f599553871b38ad55a81fc0ef0a519d59c26c119a9eefac9c6b4ecd0ff5f7d2d",
    size_bytes: 7,
  },
  {
    path: "z.txt",
    hex: "636f7069656420696e70757420616674657220454e44207570646174650a",
    sha256: "628a573976028ea29eeb775edd0854f0240161af745b0d3964725a9fef4c2be8",
    size_bytes: 30,
  },
] as const;
const expectedFiles = vectors.map(({ path, sha256, size_bytes }) => ({ path, sha256, size_bytes }));
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const payload = "private-provenance-fixture-payload";
const project = "ccw";
let root: string;
let workspace: string;
let runDir: string;
let copyRoot: string;
let original: string;
let provenance: string;
let streams: NodeFs.ReadStream[];
let liveStreams: number;
let peakStreams: number;
let observedBytes: number;
let chunks: number;
let largestChunk: number;
let failedRead: string;
let disappeared: string;

function trackedStream(...args: Parameters<typeof realFs.createReadStream>): NodeFs.ReadStream {
  if (args[0] === disappeared) realFs.unlinkSync(disappeared);
  const stream = realFs.createReadStream(...args);
  streams.push(stream);
  liveStreams += 1;
  peakStreams = Math.max(peakStreams, liveStreams);
  stream.once("close", () => {
    liveStreams -= 1;
  });
  stream.on("data", (chunk: Buffer | string) => {
    observedBytes += Buffer.byteLength(chunk);
    largestChunk = Math.max(largestChunk, Buffer.byteLength(chunk));
    chunks += 1;
    if (args[0] === failedRead) stream.destroy(Object.assign(new Error(payload), { code: "EIO" }));
  });
  return stream;
}

beforeEach(() => {
  root = realFs.realpathSync(realFs.mkdtempSync(join(tmpdir(), "records-provenance-")));
  workspace = join(root, "workspace");
  runDir = join(workspace, "physical-runs", "RUN-20261027T080005-3f9c");
  copyRoot = join(runDir, "input", project);
  original = join(root, "original-input");
  provenance = join(workspace, "provenance");
  realFs.mkdirSync(copyRoot, { recursive: true });
  realFs.mkdirSync(original);
  for (const vector of [...vectors].reverse()) {
    const path = join(copyRoot, vector.path);
    realFs.mkdirSync(dirname(path), { recursive: true });
    realFs.writeFileSync(path, Buffer.from(vector.hex, "hex"));
  }
  realFs.mkdirSync(join(copyRoot, "empty-directory"));
  realFs.writeFileSync(join(original, "z.txt"), "original input BEFORE END update\n");
  realFs.writeFileSync(join(original, "original-only.txt"), "not copied\n");
  streams = [];
  liveStreams = 0;
  peakStreams = 0;
  observedBytes = 0;
  chunks = 0;
  largestChunk = 0;
  failedRead = "";
  disappeared = "";
  enumeration.directory = "";
  enumeration.name = undefined;
  vi.mocked(fs.createReadStream).mockReset().mockImplementation(trackedStream);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  vi.mocked(io.readFile).mockReset().mockImplementation(realIo.readFile);
});

afterEach(async () => {
  for (const stream of streams) {
    if (!stream.closed) {
      await new Promise<void>((resolve) => {
        stream.once("close", resolve);
        stream.destroy();
      });
    }
  }
  vi.restoreAllMocks();
  realFs.rmSync(root, { recursive: true, force: true });
});

function publishedFiles(): string[] {
  return realFs.existsSync(provenance) ? realFs.readdirSync(provenance).sort() : [];
}

function snapshot(path: string) {
  const stat = realFs.statSync(path, { bigint: true });
  return { bytes: realFs.readFileSync(path), mtimeNs: stat.mtimeNs, ino: stat.ino };
}

function priorEvidence() {
  const prior = createDataProvenance(workspace, {
    basin: "prior-basin",
    sources: { input_root: original, files: [] },
    event_window: { start: null, end: null },
    preprocess: null,
    uncertainty_notes: null,
  });
  const path = join(provenance, `${prior.data_id}.json`);
  return { path, before: snapshot(path), files: publishedFiles() };
}

function expectClosed(): void {
  expect(streams.length).toBeGreaterThan(0);
  expect(liveStreams).toBe(0);
  for (const stream of streams) {
    expect(stream.closed).toBe(true);
    expect(stream.destroyed).toBe(true);
  }
}

async function failure(run = runDir, basin = project, input = original): Promise<Error> {
  let caught: unknown;
  try {
    await generateProvenance(run, basin, input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("Expected provenance failure");
  return caught;
}

describe("generateProvenance", () => {
  test("inventories exact copied bytes in ordinal POSIX order and publishes at the physical run grandparent", async () => {
    const before = vectors.map(({ path }) => snapshot(join(copyRoot, path)));
    const originalBefore = snapshot(join(original, "z.txt"));
    const result: DataProvenance = await generateProvenance(runDir, project, original);
    expect(DataProvenanceSchema.parse(result)).toEqual(result);
    expect(result).toEqual({
      data_id: result.data_id,
      basin: project,
      sources: { input_root: original, files: expectedFiles },
      event_window: { start: null, end: null },
      preprocess: null,
      uncertainty_notes: null,
    });
    expect(result.data_id).toMatch(/^DATA-\d{8}T\d{6}-[0-9a-f]{4}$/u);
    expect(publishedFiles()).toEqual([`${result.data_id}.json`]);
    expect(readWorkspaceRecord(workspace, "data", result.data_id)).toEqual(result);
    const path = join(provenance, `${result.data_id}.json`);
    expect(realFs.readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    expect(realFs.statSync(path).mode & 0o777).toBe(0o600);
    expect(realFs.existsSync(join(runDir, "provenance"))).toBe(false);
    expect(realFs.existsSync(join(workspace, "runs"))).toBe(false);
    expect(vectors.map(({ path: relative }) => snapshot(join(copyRoot, relative)))).toEqual(before);
    expect(snapshot(join(original, "z.txt"))).toEqual(originalBefore);
    expect(observedBytes).toBe(43);
    expectClosed();
  });

  test("identical copied input allocates two ids without rewriting the first provenance", async () => {
    const first = await generateProvenance(runDir, project, original);
    const path = join(provenance, `${first.data_id}.json`);
    const before = snapshot(path);
    const second = await generateProvenance(runDir, project, original);
    expect(second.data_id).not.toBe(first.data_id);
    expect(second).toEqual({ ...first, data_id: second.data_id });
    expect(snapshot(path)).toEqual(before);
    expect(publishedFiles()).toEqual([`${first.data_id}.json`, `${second.data_id}.json`].sort());
  });

  test("original input is absolute metadata, not a directory that must still exist", async () => {
    realFs.rmSync(original, { recursive: true });
    const result = await generateProvenance(runDir, project, original);
    expect(result.sources).toEqual({ input_root: original, files: expectedFiles });
    expect(realFs.existsSync(original)).toBe(false);
  });

  test("an empty copy tree and nested empty directories are valid", async () => {
    realFs.rmSync(copyRoot, { recursive: true });
    realFs.mkdirSync(join(copyRoot, "empty", "nested"), { recursive: true });
    const result = await generateProvenance(runDir, project, original);
    expect(result.sources.files).toEqual([]);
    expect(publishedFiles()).toEqual([`${result.data_id}.json`]);
  });

  test("genuine replacement, BOM, punctuation and case-sensitive names retain exact ordinal spelling", async () => {
    realFs.rmSync(copyRoot, { recursive: true });
    realFs.mkdirSync(copyRoot);
    const names = ['A space\nquote".txt', "z.txt", "流域.txt", "\uFEFFbom.txt", "\uFFFD.txt"];
    for (const name of [...names].reverse()) realFs.writeFileSync(join(copyRoot, name), "");
    const result = await generateProvenance(runDir, project, original);
    expect(result.sources.files).toEqual(
      names.map((path) => ({ path, sha256: emptyDigest, size_bytes: 0 })),
    );
  });

  test.each([0xff, 0xfe])(
    "invalid native UTF-8 filename byte %i rejects without publication on every platform",
    async (byte) => {
      // A replacement decoder would successfully read this real file instead of rejecting.
      realFs.writeFileSync(join(copyRoot, "\uFFFD"), "");
      const prior = priorEvidence();
      enumeration.directory = copyRoot;
      enumeration.name = Buffer.from([byte]);
      await failure();
      expect(publishedFiles()).toEqual(prior.files);
      expect(snapshot(prior.path)).toEqual(prior.before);
    },
  );

  test("byte-enumeration injection also accepts a real leading-BOM filename", async () => {
    const name = "\uFEFFvalid.txt";
    realFs.writeFileSync(join(copyRoot, name), "");
    enumeration.directory = copyRoot;
    enumeration.name = Buffer.from(name, "utf8");
    const result = await generateProvenance(runDir, project, original);
    expect(result.sources.files).toEqual([{ path: name, sha256: emptyDigest, size_bytes: 0 }]);
  });

  test.each(["relative run", "relative original", "escaping project"])(
    "%s fails before publication",
    async (kind) => {
      const prior = priorEvidence();
      await failure(
        kind === "relative run" ? "relative-run" : runDir,
        kind === "escaping project" ? "../../outside" : project,
        kind === "relative original" ? "relative-input" : original,
      );
      expect(publishedFiles()).toEqual(prior.files);
      expect(snapshot(prior.path)).toEqual(prior.before);
    },
  );

  test.each(["input container", "project root"] as const)(
    "missing %s is not an empty inventory",
    async (kind) => {
      const path = kind === "input container" ? dirname(copyRoot) : copyRoot;
      realFs.rmSync(path, { recursive: true });
      await failure();
      expect(publishedFiles()).toEqual([]);
    },
  );

  describe.each(["input container", "project root"] as const)("%s safety", (location) => {
    test.each(unsafeKinds)("a %s is rejected before traversing outside the copy", async (kind) => {
      const prior = priorEvidence();
      const target = location === "input container" ? dirname(copyRoot) : copyRoot;
      realFs.rmSync(target, { recursive: true });
      const outside = join(root, "outside");
      realFs.mkdirSync(join(outside, project), { recursive: true });
      const sentinel = join(outside, project, "sentinel");
      realFs.writeFileSync(sentinel, "outside bytes\n");
      const before = snapshot(sentinel);
      installUnsafe(target, kind, outside);
      const inode = realFs.lstatSync(target, { bigint: true }).ino;
      await failure();
      expect(publishedFiles()).toEqual(prior.files);
      expect(snapshot(prior.path)).toEqual(prior.before);
      expect(snapshot(sentinel)).toEqual(before);
      expect(realFs.lstatSync(target, { bigint: true }).ino).toBe(inode);
      expect(streams).toEqual([]);
    });
  });

  test.each(["symlink", "dangling-link", "fifo"] as const)(
    "a nested %s fails without partial publication or following the target",
    async (kind) => {
      const prior = priorEvidence();
      const outside = join(root, "outside.txt");
      realFs.writeFileSync(outside, "outside bytes\n");
      const before = snapshot(outside);
      const target = join(copyRoot, "nested", "unsafe");
      installUnsafe(target, kind, outside);
      await failure();
      expect(publishedFiles()).toEqual(prior.files);
      expect(snapshot(prior.path)).toEqual(prior.before);
      expect(snapshot(outside)).toEqual(before);
      expect(streams.every((stream) => stream.closed)).toBe(true);
    },
  );

  test.each(["unreadable", "disappearing", "mid-read"] as const)(
    "a %s copied file fails after partial inventory and releases input resources",
    async (kind) => {
      const prior = priorEvidence();
      const target = join(copyRoot, "z.txt");
      if (kind === "unreadable") {
        vi.mocked(fs.createReadStream).mockImplementation((...args) => {
          if (args[0] === target) throw Object.assign(new Error(payload), { code: "EACCES" });
          return trackedStream(...args);
        });
      } else if (kind === "disappearing") disappeared = target;
      else failedRead = target;
      const error = await failure();
      expect(inspect(error, { depth: 10 })).not.toContain(payload);
      expect(observedBytes).toBeGreaterThan(0);
      expectClosed();
      expect(publishedFiles()).toEqual(prior.files);
      expect(snapshot(prior.path)).toEqual(prior.before);
    },
  );

  test("large input is read incrementally without whole-file reads or tree-wide open streams", async () => {
    const size = 2 * 1024 * 1024;
    realFs.writeFileSync(join(copyRoot, "large.bin"), Buffer.alloc(size, 0x61));
    for (let index = 0; index < 32; index += 1)
      realFs.writeFileSync(join(copyRoot, `part-${index}.bin`), "x");
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(copyRoot))
        throw new Error("Whole-file input read");
      return realFs.readFileSync(...args);
    });
    vi.mocked(io.readFile).mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(copyRoot))
        throw new Error("Whole-file input read");
      return realIo.readFile(...args);
    });
    const result = await generateProvenance(runDir, project, original);
    expect(result.sources.files.find((file) => file.path === "large.bin")).toEqual({
      path: "large.bin",
      sha256: "5256ec18f11624025905d057d6befb03d77b243511ac5f77ed5e0221ce6d84b5",
      size_bytes: 2097152,
    });
    expect(result.sources.files).toHaveLength(37);
    expect(observedBytes).toBe(size + 43 + 32);
    expect(chunks).toBeGreaterThan(1);
    expect(largestChunk).toBeLessThan(size);
    expect(peakStreams).toBe(1);
    expectClosed();
  });

  test.each(unsafeKinds)(
    "a %s provenance root cannot redirect or replace publication",
    async (kind) => {
      const outside = join(root, "outside");
      realFs.mkdirSync(outside);
      const sentinel = join(outside, "sentinel");
      realFs.writeFileSync(sentinel, "foreign bytes\n");
      installUnsafe(provenance, kind, outside);
      const inode = realFs.lstatSync(provenance, { bigint: true }).ino;
      const before = snapshot(sentinel);
      await failure();
      expect(realFs.lstatSync(provenance, { bigint: true }).ino).toBe(inode);
      expect(snapshot(sentinel)).toEqual(before);
      expect(realFs.readdirSync(outside)).toEqual(["sentinel"]);
    },
  );

  test("failed atomic publication removes its completed temporary and preserves prior evidence", async () => {
    const prior = priorEvidence();
    let observed = false;
    vi.mocked(fs.renameSync).mockImplementationOnce((temporary, destination) => {
      expect(dirname(String(destination))).toBe(provenance);
      const pending = DataProvenanceSchema.parse(
        JSON.parse(realFs.readFileSync(temporary, "utf8")),
      );
      expect(pending.sources).toEqual({ input_root: original, files: expectedFiles });
      expectClosed();
      observed = true;
      throw Object.assign(new Error(payload), { code: "EIO" });
    });
    const error = await failure();
    expect(observed).toBe(true);
    expect(inspect(error, { depth: 10 })).not.toContain(payload);
    expect(publishedFiles()).toEqual(prior.files);
    expect(snapshot(prior.path)).toEqual(prior.before);
    expectClosed();
  });
});
