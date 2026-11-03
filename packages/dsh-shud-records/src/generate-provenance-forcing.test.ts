import * as fs from "node:fs";
import * as io from "node:fs/promises";
import * as crypto from "node:crypto";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDataProvenance, generateProvenance } from "./index.ts";
import { installUnsafe } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    readFile: vi.fn(actual.readFile),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
const native = await vi.importActual<typeof fs>("node:fs");
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");

// Standard SHA-256 vectors and the existing independently established 2 MiB 'a' vector.
// Expected digests do not invoke the producer or hash bytes read through its FS mocks.
const abc = {
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  size_bytes: 3,
};
const empty = {
  sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  size_bytes: 0,
};
const large = {
  sha256: "5256ec18f11624025905d057d6befb03d77b243511ac5f77ed5e0221ce6d84b5",
  size_bytes: 2097152,
};
const privatePayload = "PRIVATE scientific payload must not escape";
type FileSnapshot = { bytes: Buffer; mtimeNs: bigint; ino: bigint };
let root: string;
let workspace: string;
let run: string;
let copy: string;
let external: string;
let manifest: string;
let prior: { path: string; before: FileSnapshot; files: string[] };
let streams: fs.ReadStream[];
let opened: string[];
let active: number;
let peak: number;
let largestChunk: number;
let chunkCount: number;

function snapshot(path: string): FileSnapshot {
  const stat = native.statSync(path, { bigint: true });
  return { bytes: native.readFileSync(path), mtimeNs: stat.mtimeNs, ino: stat.ino };
}

function published(): string[] {
  return native.readdirSync(join(workspace, "provenance")).sort();
}

function write(path: string, bytes: string | Buffer = "abc"): void {
  native.mkdirSync(dirname(path), { recursive: true });
  native.writeFileSync(path, bytes);
}

function setManifest(directory: string, names: string[], ending = "\n"): void {
  write(
    manifest,
    [
      `${names.length} ignored-date`,
      directory,
      "ID Filename",
      ...names.map((name) => `x ${name}`),
    ].join(ending) + ending,
  );
}

function tracked(...args: Parameters<typeof native.createReadStream>): fs.ReadStream {
  const stream = native.createReadStream(...args);
  streams.push(stream);
  opened.push(String(args[0]));
  active += 1;
  peak = Math.max(peak, active);
  stream.once("close", () => {
    active -= 1;
  });
  stream.on("data", (chunk: Buffer | string) => {
    largestChunk = Math.max(largestChunk, Buffer.byteLength(chunk));
    chunkCount += 1;
  });
  return stream;
}

function expectClosed(): void {
  expect(active).toBe(0);
  expect(peak).toBe(1);
  expect(streams.every((stream) => stream.closed && stream.destroyed)).toBe(true);
}

function generate(project = "ccw") {
  return generateProvenance(run, project, join(root, "original-metadata-only"));
}

async function rejected(affected: string): Promise<void> {
  let caught: unknown;
  try {
    await generate();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("Expected invalid forcing to reject");
  expect(caught.message).toMatch(/provenance/iu);
  expect(caught.message).toContain(affected);
  expect(inspect(caught, { depth: 10 })).not.toContain(privatePayload);
  expect(caught.cause).toBeUndefined();
  expect(crypto.randomBytes).not.toHaveBeenCalled();
  expect(published()).toEqual(prior.files);
  expect(snapshot(prior.path)).toEqual(prior.before);
  expectClosed();
}

beforeEach(() => {
  root = native.realpathSync(native.mkdtempSync(join(tmpdir(), "records-forcing-")));
  workspace = join(root, "workspace");
  run = join(workspace, "runs", "RUN-20261103T080005-3f9c");
  copy = join(run, "input", "ccw");
  external = join(root, "forcing with spaces");
  manifest = join(copy, "ccw.tsd.forc");
  write(join(copy, "internal.csv"));
  write(join(external, "station.csv"));
  setManifest(external, ["station.csv"]);
  const evidence = createDataProvenance(workspace, {
    basin: "prior",
    sources: { input_root: root, files: [] },
    event_window: { start: null, end: null },
    preprocess: null,
    uncertainty_notes: null,
  });
  const path = join(workspace, "provenance", `${evidence.data_id}.json`);
  prior = { path, before: snapshot(path), files: published() };
  streams = [];
  opened = [];
  active = 0;
  peak = 0;
  largestChunk = 0;
  chunkCount = 0;
  vi.mocked(fs.createReadStream).mockReset().mockImplementation(tracked);
  vi.mocked(fs.readFile).mockReset().mockImplementation(native.readFile);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
  vi.mocked(fs.readdirSync).mockReset().mockImplementation(native.readdirSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(crypto.randomBytes).mockClear();
});

afterEach(async () => {
  for (const stream of streams) {
    if (!stream.closed) {
      const closed = new Promise<void>((resolve) => {
        stream.once("close", resolve);
      });
      stream.destroy();
      await closed;
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  native.rmSync(root, { recursive: true, force: true });
});

describe("generateProvenance forcing manifest", () => {
  test.each(["LF", "CRLF", "unterminated"])(
    "accepts %s without interpreting scientific fields",
    async (ending) => {
      const separator = ending === "CRLF" ? "\r\n" : "\n";
      const text = [
        "  0002 not-a-date arbitrary later fields  ",
        `  ${external}  `,
        " ID\tLon Lat Filename ",
        "not-an-id not-a-longitude not-a-latitude station.csv",
        "  \t ",
        "x y z ./station.csv",
      ].join(separator);
      write(manifest, ending === "unterminated" ? text : text + separator);
      const result = await generate();
      expect(result.sources.external_files).toEqual([
        { path: join(external, "station.csv"), ...abc },
      ]);
      expectClosed();
    },
  );

  test("zero stations still validates the directory and header", async () => {
    setManifest(external, []);
    const result = await generate();
    expect(result.sources.external_files).toEqual([]);
    expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
    expectClosed();
  });

  test.each([
    ["empty", ""],
    ["two lines", "0\nDIRECTORY\n"],
    ["empty directory", "0\n  \nID Filename\n"],
    ["missing count", "\nDIRECTORY\nID Filename\n"],
    ["partial integer", "1x\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["negative", "-1\nDIRECTORY\nID Filename\n"],
    ["signed", "+1\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["fraction", "1.0\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["exponent", "1e0\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["overflow", "9007199254740992\nDIRECTORY\nID Filename\n"],
    ["integer after garbage", "garbage 1\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["empty header", "0\nDIRECTORY\n\n"],
    ["wrong header", "0\nDIRECTORY\nID File\n"],
    ["Filename not final", "0\nDIRECTORY\nFilename ID\n"],
    ["short row", "1\nDIRECTORY\nID Filename\nstation.csv\n"],
    ["wide row", "1\nDIRECTORY\nID Filename\nx y station.csv\n"],
    ["too few rows", "2\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["too many rows", "1\nDIRECTORY\nID Filename\nx station.csv\ny station.csv\n"],
    ["zero with a row", "0\nDIRECTORY\nID Filename\nx station.csv\n"],
    ["NUL directory", "0\nDIRECTORY\0suffix\nID Filename\n"],
    ["NUL filename", "1\nDIRECTORY\nID Filename\nx station.csv\0suffix\n"],
    ["private malformed row", `1\nDIRECTORY\nID Filename\n${privatePayload}\n`],
  ])("rejects %s without allocating or publishing evidence", async (_name, text) => {
    write(manifest, text.replace("DIRECTORY", external));
    await rejected(manifest);
    expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
  });

  test.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe9, 0x9b]])(
    "rejects malformed UTF-8 bytes %j",
    async (...bytes) => {
      write(
        manifest,
        Buffer.concat([
          Buffer.from(`0 ${privatePayload}\n${external}\nID Filename\n`),
          Buffer.from(bytes),
        ]),
      );
      await rejected(manifest);
    },
  );

  test("decodes split UTF-8, CRLF and final-line metadata incrementally", async () => {
    write(join(external, "雨.csv"));
    write(manifest, `1 ignored\r\n${external}\r\nID Filename\r\nx 雨.csv`);
    vi.mocked(fs.createReadStream).mockImplementation((path) =>
      tracked(path, { highWaterMark: 1 }),
    );
    const result = await generate();
    expect(result.sources.external_files).toEqual([{ path: join(external, "雨.csv"), ...abc }]);
    expect(largestChunk).toBe(1);
    expectClosed();
  });
});

describe("generateProvenance per-file forcing classification", () => {
  test("includes exactly 32 of 34 external files in codepoint order without discovery or mutation", async () => {
    native.unlinkSync(join(external, "station.csv"));
    const names = [
      ...Array.from({ length: 30 }, (_, index) => `station-${String(index).padStart(2, "0")}.csv`),
      "\uE000.csv",
      "\u{10000}.csv",
    ];
    const unreferenced = ["Prcp_Correction.csv", "Rawdata_CMFD_TS.png"];
    for (const [index, name] of [...names, ...unreferenced].entries()) {
      write(join(external, name), index % 2 === 0 ? "abc" : "");
    }
    const before = [...names, ...unreferenced].map((name) => snapshot(join(external, name)));
    setManifest("../../../forcing with spaces", [...names].reverse());
    const manifestBefore = snapshot(manifest);
    const expectedInternal = [
      {
        path: "ccw.tsd.forc",
        sha256: "60ed337402868bbfdc7282dfb25f72ae3fc87607b08d604bdd8f50634b4eda3a",
        size_bytes: 588,
      },
      { path: "internal.csv", ...abc },
    ];
    vi.mocked(fs.readdirSync).mockImplementation((...args) => {
      if (String(args[0]).startsWith(external))
        throw new Error("External directory discovery forbidden");
      return native.readdirSync(...args);
    });
    const expected = names.map((name, index) => ({
      path: join(external, name),
      ...(index % 2 === 0 ? abc : empty),
    }));
    const first = await generate();
    const firstPath = join(workspace, "provenance", `${first.data_id}.json`);
    const firstBefore = snapshot(firstPath);
    const second = await generate();
    expect(first.sources.external_files).toEqual(expected);
    expect(first.sources.files).toEqual(expectedInternal);
    expect(second.sources).toEqual(first.sources);
    expect(second.data_id).not.toBe(first.data_id);
    expect(snapshot(firstPath)).toEqual(firstBefore);
    expect(opened.filter((path) => path.startsWith(external)).sort()).toEqual(
      names.flatMap((name) => [join(external, name), join(external, name)]).sort(),
    );
    expect([...names, ...unreferenced].map((name) => snapshot(join(external, name)))).toEqual(
      before,
    );
    expect(native.readdirSync(external).sort()).toEqual([...names, ...unreferenced].sort());
    expect(snapshot(manifest)).toEqual(manifestBefore);
    expect(snapshot(prior.path)).toEqual(prior.before);
    expectClosed();
  });

  test.each(["relative", "absolute", "root symlink"])(
    "resolves an %s forcing directory from the run cwd",
    async (kind) => {
      const alias = join(root, "forcing-alias");
      native.symlinkSync(external, alias);
      setManifest(
        kind === "relative" ? relative(run, external) : kind === "absolute" ? external : alias,
        ["station.csv"],
      );
      const result = await generate();
      expect(result.sources.external_files).toEqual([
        { path: join(external, "station.csv"), ...abc },
      ]);
    },
  );

  test("preserves physical parent traversal in the forcing directory", async () => {
    const parent = join(root, "physical-parent");
    native.mkdirSync(join(parent, "child"), { recursive: true });
    write(join(parent, "station.csv"));
    native.symlinkSync(join(parent, "child"), join(run, "directory-alias"));
    setManifest("directory-alias/..", ["station.csv"]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([{ path: join(parent, "station.csv"), ...abc }]);
  });

  test("an internal forcing directory can reference outside the copied tree", async () => {
    native.mkdirSync(join(copy, "nested"));
    const outsideFile = join(root, "outside.csv");
    write(outsideFile);
    const escaped = relative(copy, outsideFile);
    setManifest("./input/ccw", ["internal.csv", `nested/../${escaped}`]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([{ path: outsideFile, ...abc }]);
    expect(result.sources.files.find((file) => file.path === "internal.csv")).toEqual({
      path: "internal.csv",
      ...abc,
    });
  });

  test("an external forcing directory can reference back into the copied tree", async () => {
    setManifest(external, [`${relative(external, copy)}/internal.csv`, "station.csv"]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([
      { path: join(external, "station.csv"), ...abc },
    ]);
    expect(opened.filter((path) => path === join(copy, "internal.csv"))).toHaveLength(1);
  });

  test("nested dot and parent aliases deduplicate only canonical paths, not hardlinks", async () => {
    write(join(external, "nested", "station.csv"));
    native.mkdirSync(join(external, "nested", "child"));
    native.linkSync(join(external, "nested", "station.csv"), join(external, "hardlink.csv"));
    setManifest(external, [
      "nested/station.csv",
      "./nested/./station.csv",
      "nested/child/../station.csv",
      "hardlink.csv",
    ]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([
      { path: join(external, "hardlink.csv"), ...abc },
      { path: join(external, "nested", "station.csv"), ...abc },
    ]);
    expect(opened.filter((path) => path.startsWith(external))).toHaveLength(2);
  });

  test("leading Filename separators concatenate rather than override the forcing directory", async () => {
    setManifest(external, ["/station.csv", "//station.csv"]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([
      { path: join(external, "station.csv"), ...abc },
    ]);
  });

  test("case aliases preserve native spelling and internal containment where supported", async () => {
    const mixed = join(copy, "CaseStation.csv");
    write(mixed);
    const lowerRoot = join(dirname(copy), "CCW");
    const caseInsensitive = native.existsSync(join(lowerRoot, "casestation.csv"));
    setManifest(caseInsensitive ? lowerRoot : copy, [
      caseInsensitive ? "casestation.csv" : "CaseStation.csv",
    ]);
    const result = await generate();
    expect(result.sources.external_files).toEqual([]);
    expect(result.sources.files.find((file) => file.path === "CaseStation.csv")).toEqual({
      path: "CaseStation.csv",
      ...abc,
    });
    if (caseInsensitive) {
      write(join(external, "CaseStation.csv"));
      setManifest(external, ["casestation.csv", "CASESTATION.CSV"]);
      const externalResult = await generate();
      expect(externalResult.sources.external_files).toEqual([
        { path: join(external, "CaseStation.csv"), ...abc },
      ]);
    }
  });

  test("a project containing spaces uses the whole directory line", async () => {
    const project = "basin with spaces";
    const customCopy = join(run, "input", project);
    write(join(customCopy, "station.csv"));
    write(
      join(customCopy, `${project}.tsd.forc`),
      `1\n./input/${project}\nID Filename\nx station.csv\n`,
    );
    const result = await generate(project);
    expect(result.basin).toBe(project);
    expect(result.sources.external_files).toEqual([]);
    expect(result.sources.files.find((file) => file.path === "station.csv")).toEqual({
      path: "station.csv",
      ...abc,
    });
  });

  test.each(["manifest fallback", "tilde", "environment"])(
    "does not apply %s directory expansion",
    async (kind) => {
      vi.stubEnv("HOME", root);
      const directory =
        kind === "manifest fallback"
          ? "fallback"
          : kind === "tilde"
            ? "~/forcing"
            : "$HOME/forcing";
      write(join(root, "forcing", "station.csv"));
      write(join(copy, "fallback", "station.csv"));
      setManifest(directory, ["station.csv"]);
      await rejected(directory);
      expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
    },
  );

  test.each(["missing", "file", "zero missing"])("rejects a %s forcing directory", async (kind) => {
    const directory = join(root, "invalid-root");
    if (kind === "file") write(directory);
    setManifest(directory, kind === "zero missing" ? [] : ["station.csv"]);
    await rejected(directory);
  });

  test.each(["internal", "external"])(
    "rejects a missing %s reference before reading any external contents",
    async (kind) => {
      const missing =
        kind === "internal" ? `${relative(external, copy)}/missing.csv` : "missing.csv";
      setManifest(external, ["station.csv", missing]);
      await rejected("missing.csv");
      expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
    },
  );

  test("missing references under an internal forcing root cannot become an empty inventory", async () => {
    setManifest("./input/ccw", ["missing.csv"]);
    await rejected("missing.csv");
  });

  test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
    "rejects a final %s without reading it",
    async (kind) => {
      const unsafe = join(external, "unsafe");
      installUnsafe(unsafe, kind, join(external, "station.csv"));
      setManifest(external, ["station.csv", "unsafe"]);
      vi.mocked(fs.createReadStream).mockImplementation((...args) => {
        if (String(args[0]).startsWith(external))
          throw new Error("Unsafe reference set must not be read");
        return tracked(...args);
      });
      await rejected("unsafe");
      expect(
        vi
          .mocked(fs.createReadStream)
          .mock.calls.some(([path]) => String(path).startsWith(external)),
      ).toBe(false);
    },
  );

  test.each([
    "alias/station.csv",
    "alias/../station.csv",
    "missing/../station.csv",
    "station.csv/../station.csv",
    "pipe/../station.csv",
  ])("valid duplicate cannot mask unsafe traversal %s", async (name) => {
    native.symlinkSync(external, join(external, "alias"));
    installUnsafe(join(external, "pipe"), "fifo", external);
    setManifest(external, ["station.csv", name]);
    await rejected(external);
    expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
  });

  test.each(["station.csv/", "station.csv/.", "nested/..", ".", ".."])(
    "rejects non-file final spelling %s",
    async (name) => {
      native.mkdirSync(join(external, "nested"));
      setManifest(external, [name]);
      await rejected(external);
      expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
    },
  );
});

describe("generateProvenance forcing resource ownership", () => {
  test("large metadata and external content remain incremental and count observed bytes", async () => {
    write(join(external, "station.csv"), Buffer.alloc(large.size_bytes, 0x61));
    write(manifest, `1 ${"ignored".repeat(20000)}\n${external}\nID Filename\nx station.csv\n`);
    vi.mocked(fs.readFileSync).mockImplementation((...args) => {
      if (String(args[0]).startsWith(copy) || String(args[0]).startsWith(external))
        throw new Error("Whole-file input read");
      return native.readFileSync(...args);
    });
    vi.mocked(fs.readFile).mockImplementation(() => {
      throw new Error("Whole-file input read");
    });
    vi.mocked(io.readFile).mockImplementation(() => {
      throw new Error("Whole-file input read");
    });
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      const stat = native.lstatSync(...args);
      if (args[0] === join(external, "station.csv")) Object.assign(stat, { size: 1 });
      return stat;
    });
    const result = await generate();
    expect(result.sources.external_files).toEqual([
      { path: join(external, "station.csv"), ...large },
    ]);
    expect(chunkCount).toBeGreaterThan(3);
    expect(largestChunk).toBeLessThan(140000);
    expectClosed();
  });

  describe.each(["manifest", "external"] as const)("%s stream failure", (location) => {
    test.each(["open", "read", "mid-read"] as const)(
      "%s errors close descriptors and preserve prior evidence",
      async (kind) => {
        const target = location === "manifest" ? manifest : join(external, "station.csv");
        write(join(external, "station.csv"), "abcdefghi");
        write(join(external, "a-first.csv"));
        setManifest(external, ["a-first.csv", "station.csv"]);
        let targetOpens = 0;
        let injected = false;
        let chunksBeforeFailure = 0;
        vi.mocked(fs.createReadStream).mockImplementation((path) => {
          const hit = path === target && ++targetOpens === (location === "manifest" ? 2 : 1);
          const error = Object.assign(new Error(privatePayload), {
            code: "EIO",
            cause: new Error(privatePayload),
          });
          if (hit && kind === "open") {
            injected = true;
            throw error;
          }
          const stream = tracked(path, { highWaterMark: 2 });
          if (hit && kind === "read") {
            injected = true;
            queueMicrotask(() => stream.destroy(error));
          } else if (hit && kind === "mid-read") {
            stream.on("data", () => {
              chunksBeforeFailure += 1;
              if (chunksBeforeFailure === 2) {
                injected = true;
                stream.destroy(error);
              }
            });
          }
          return stream;
        });
        await rejected(target);
        expect(injected).toBe(true);
        if (kind === "mid-read") expect(chunksBeforeFailure).toBe(2);
        if (location === "external") expect(opened).toContain(join(external, "a-first.csv"));
        if (location === "manifest")
          expect(opened.filter((path) => path.startsWith(external))).toEqual([]);
      },
    );
  });
});
