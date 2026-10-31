import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeEvidenceReport } from "../../dsh-shud-records/src/report-render-test-harness.ts";
import { decideRawAccess, normalizeRawDirs, RAW_READ_PROVENANCE_REASON } from "./decide.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    opendirSync: vi.fn(actual.opendirSync),
    realpathSync: Object.assign(actual.realpathSync.bind(actual), {
      native: vi.fn(actual.realpathSync.native),
    }),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let cwd: string;
let reads: number;
const open = new Set<fs.Dir>();
let directoryFault: "none" | "read" | "close" | "bound";
beforeEach(() => {
  cwd = native.realpathSync.native(native.mkdtempSync(join(tmpdir(), "raw-path-identity-")));
  reads = 0;
  directoryFault = "none";
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.realpathSync.native).mockReset().mockImplementation(native.realpathSync.native);
  vi.mocked(fs.opendirSync)
    .mockReset()
    .mockImplementation((path, options) => {
      const directory = native.opendirSync(path, options);
      open.add(directory);
      const read = directory.readSync.bind(directory);
      const close = directory.closeSync.bind(directory);
      vi.spyOn(directory, "readSync").mockImplementation(() => {
        reads++;
        if (directoryFault === "read") throw new Error("PRIVATE_DIRECTORY_FAILURE");
        if (directoryFault === "bound") {
          if (reads > 128) throw new Error("unbounded namespace inspection");
          return native.readdirSync(cwd, { withFileTypes: true })[0];
        }
        return read();
      });
      vi.spyOn(directory, "closeSync").mockImplementation(() => {
        close();
        open.delete(directory);
        if (directoryFault === "close") throw new Error("PRIVATE_CLOSE_FAILURE");
      });
      return directory;
    });
});
afterEach(() => {
  try {
    expect(open.size).toBe(0);
  } finally {
    for (const directory of open) directory.closeSync();
    open.clear();
    vi.restoreAllMocks();
    native.rmSync(cwd, { recursive: true, force: true });
  }
});

// Only the OS metadata boundary is controlled. Production comparison, policy,
// canonical traversal and all callers remain real. The fixture marker is not raw.
function namespace(mode: "sensitive" | "insensitive" | "retained-case") {
  const marker = join(cwd, "marker");
  const alternate = join(cwd, "MARKER");
  native.writeFileSync(marker, "namespace evidence\n");
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === alternate) {
      return mode === "sensitive" ? undefined : native.lstatSync(marker, options);
    }
    return native.lstatSync(path, options);
  });
  vi.mocked(fs.realpathSync.native).mockImplementation((path) => {
    if (String(path) === alternate) return mode === "retained-case" ? alternate : marker;
    return native.realpathSync.native(path);
  });
}

function decide(name: string, args: unknown, rawDirs = ["RAW"], session = cwd) {
  const before = native.readdirSync(cwd, { recursive: true }).sort();
  try {
    return decideRawAccess({ name, arguments: args, cwd: session }, normalizeRawDirs({ rawDirs }));
  } finally {
    expect(native.readdirSync(cwd, { recursive: true }).sort()).toEqual(before);
  }
}

const task = "TASK-20261027T080005-3f9c";
const report = "REPORT-20261027T080005-3f9c";
const consumers = [
  ["write", { file_path: "raw/out" }, ["RAW"], "deny"],
  ["edit", { file_path: "raw/out" }, ["RAW"], "deny"],
  ["str_replace_editor", { command: "create", path: "raw/out" }, ["RAW"], "deny"],
  ["task_create", {}, ["TASKS"], "deny"],
  ["shud_run", { input_dir: "raw/input" }, ["RAW"], "ask"],
  ["shud_run", { input_dir: "safe", task_id: task }, ["TASKS"], "deny"],
  ["report_generate", { task_id: task }, ["REPORTS"], "deny"],
  ["report_generate", { task_id: task }, ["TASKS"], "deny"],
  ["report_validate", { report_id: report }, ["REPORTS"], "deny"],
  ["report_submit", { report_id: report }, ["REPORTS"], "deny"],
  ["report_decide", { report_id: report }, ["REPORTS"], "deny"],
  ["bash", { command: "pwd", workdir: "raw" }, ["RAW"], "ask"],
  ["pwsh", { command: "Get-Location", workdir: "raw" }, ["RAW"], "ask"],
  ["bash", { command: "tar -cf raw/out.tar source" }, ["RAW", "source"], "deny"],
] as const;

test.each(consumers)(
  "confirmed missing aliases retain %s policy for %j",
  (name, args, roots, kind) => {
    namespace("insensitive");
    const decision = decide(name, args, [...roots]);
    expect(decision).toMatchObject({
      kind,
      code: kind === "ask" ? "raw-read-provenance" : "raw-immutable",
    });
    if (kind === "ask") expect(decision.reason).toBe(RAW_READ_PROVENANCE_REASON);
  },
);

test.each(consumers)(
  "unknown missing identity denies %s rather than approving %j",
  (name, args, roots) => {
    expect(decide(name, args, [...roots])).toMatchObject({
      kind: "deny",
      code: "raw-path-unavailable",
    });
  },
);

test.each(["sensitive", "insensitive"] as const)(
  "confirmed %s namespace controls absent outputs",
  (mode) => {
    namespace(mode);
    for (const raw of ["RUNS", "STACKS", "PROVENANCE"]) {
      expect(decide("shud_run", { input_dir: "ordinary-input" }, [raw])).toMatchObject(
        mode === "sensitive"
          ? { kind: "next", code: "unrelated" }
          : { kind: "deny", code: "raw-immutable" },
      );
    }
  },
);

test("sensitive input and workdir spellings remain unrelated", () => {
  namespace("sensitive");
  expect(decide("shud_run", { input_dir: "raw/input" })).toEqual({
    kind: "next",
    code: "unrelated",
  });
  expect(decide("bash", { command: "pwd", workdir: "raw" })).toEqual({
    kind: "next",
    code: "unrelated",
  });
});

test("exact containment and sibling prefixes need no namespace inspection", () => {
  vi.mocked(fs.opendirSync).mockImplementation(() => {
    throw new Error("unrelated paths must not inspect namespaces");
  });
  expect(decide("write", { file_path: "RAW/new" })).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decide("write", { file_path: "rawx/new" })).toEqual({ kind: "next", code: "unrelated" });
  expect(fs.opendirSync).not.toHaveBeenCalled();
});

test("shell lexical missing-root spelling remains separate from path identity", () => {
  namespace("insensitive");
  expect(decide("bash", { command: "cat missing/raw/file" }, ["MISSING/RAW"])).toEqual({
    kind: "next",
    code: "unrelated",
  });
});

test.each(["read", "close"] as const)(
  "namespace %s failure denies and releases its directory",
  (fault) => {
    namespace("insensitive");
    directoryFault = fault;
    const decision = decide("write", { file_path: "raw/new" });
    expect(decision).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
    expect(decision.reason).not.toMatch(/PRIVATE|raw-path-identity/iu);
    expect(open.size).toBe(0);
  },
);

test("failed alternate lookup is unknown, not evidence of sensitivity", () => {
  namespace("insensitive");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === join(cwd, "MARKER")) {
      throw Object.assign(new Error("PRIVATE_LOOKUP_FAILURE"), { code: "EACCES" });
    }
    return lookup(path, options);
  });
  expect(decide("shud_run", { input_dir: "raw/input" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test("retained-case realpath does not turn inode coincidence into alias proof", () => {
  namespace("retained-case");
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test.each(["symlink", "hardlink"] as const)(
  "%s evidence cannot prove namespace case folding",
  (kind) => {
    const outside = native.mkdtempSync(join(tmpdir(), "raw-case-entry-"));
    try {
      const original = join(outside, "original");
      native.writeFileSync(original, "indirect evidence\n");
      if (kind === "symlink") native.symlinkSync(original, join(cwd, "marker"));
      else native.linkSync(original, join(cwd, "marker"));
      expect(decide("write", { file_path: "raw/new" })).toMatchObject({
        kind: "deny",
        code: "raw-path-unavailable",
      });
    } finally {
      native.rmSync(outside, { recursive: true, force: true });
    }
  },
);

test("unusable entry inspection is bounded and closes its handle", () => {
  native.writeFileSync(join(cwd, "123"), "letterless evidence\n");
  directoryFault = "bound";
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(128);
  expect(open.size).toBe(0);
});

test("later decisions reacquire namespace evidence rather than caching sensitivity", () => {
  namespace("insensitive");
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({ code: "raw-immutable" });
  native.unlinkSync(join(cwd, "marker"));
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({ code: "raw-path-unavailable" });
  namespace("sensitive");
  expect(decide("write", { file_path: "raw/new" })).toEqual({ kind: "next", code: "unrelated" });
});

test("a changing entry invalidates otherwise insensitive namespace evidence", () => {
  namespace("insensitive");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let observations = 0;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === join(cwd, "marker")) {
      const stat = native.lstatSync(path, { bigint: true });
      if (++observations > 1) stat.ctimeNs += 1n;
      return stat;
    }
    return lookup(path, options);
  });
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test("an inaccessible namespace is unknown without exposing the lookup error", () => {
  vi.mocked(fs.opendirSync).mockImplementation(() => {
    throw Object.assign(new Error("PRIVATE_OPEN_FAILURE"), { code: "EACCES" });
  });
  const decision = decide("write", { file_path: "raw/new" });
  expect(decision).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
  expect(decision.reason).not.toMatch(/PRIVATE|EACCES|raw-path-identity/u);
});

test("a case-aliased mountpoint name does not establish its contents sensitivity", () => {
  namespace("sensitive");
  const lookup = vi.mocked(fs.realpathSync.native).getMockImplementation()!;
  vi.mocked(fs.realpathSync.native).mockImplementation((path) =>
    String(path) === cwd.toUpperCase() ? cwd : lookup(path),
  );
  expect(decide("shud_run", { input_dir: "ordinary-input" }, ["RUNS"])).toEqual({
    kind: "next",
    code: "unrelated",
  });
});

test.each(["runs", "stacks", "provenance"])(
  "existing %s retains native case identity without changing the directory",
  (output) => {
    native.mkdirSync(join(cwd, output));
    const aliases = native.lstatSync(join(cwd, output.toUpperCase()), { throwIfNoEntry: false });
    expect(decide("shud_run", { input_dir: "ordinary-input" }, [output.toUpperCase()])).toEqual(
      aliases
        ? expect.objectContaining({ kind: "deny", code: "raw-immutable" })
        : { kind: "next", code: "unrelated" },
    );
  },
);

test("physical symlink/parent traversal still selects the actual missing-path namespace", () => {
  native.writeFileSync(join(cwd, "marker"), "independent native marker\n");
  const aliases = native.lstatSync(join(cwd, "MARKER"), { throwIfNoEntry: false });
  native.mkdirSync(join(cwd, "deep"));
  const outside = native.mkdtempSync(join(tmpdir(), "raw-physical-parent-"));
  try {
    native.symlinkSync(join(cwd, "deep"), join(outside, "link"));
    const session = `${outside}/link/..`;
    expect(decide("write", { file_path: "raw/new" }, ["RAW"], session)).toEqual(
      aliases
        ? expect.objectContaining({ kind: "deny", code: "raw-immutable" })
        : { kind: "next", code: "unrelated" },
    );
    expect(decide("write", { file_path: "rawx/new" }, ["RAW"], session)).toEqual({
      kind: "next",
      code: "unrelated",
    });
  } finally {
    native.rmSync(outside, { recursive: true, force: true });
  }
});

test("folded missing parents use the exposed child namespace, not its parent", () => {
  namespace("insensitive");
  native.mkdirSync(join(cwd, "child"));
  // The child is empty: no namespace evidence, even if its parent folds case.
  expect(decide("write", { file_path: "child/raw/new" }, ["missing/../child/RAW"])).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test.each([
  ["same missing spelling", "raw", true, "raw-immutable"],
  ["unproved missing spelling", "RAW", true, "raw-path-unavailable"],
  ["distinct physical anchors", "raw", false, "unrelated"],
] as const)("retained-case existing anchors preserve %s", (_label, raw, sameAnchor, code) => {
  const lower = join(cwd, "namespace");
  const upper = join(cwd, "NAMESPACE");
  const other = join(cwd, "other");
  native.mkdirSync(lower);
  native.mkdirSync(other);
  vi.mocked(fs.realpathSync.native).mockImplementation((path) =>
    String(path) === upper ? upper : native.realpathSync.native(path),
  );
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) =>
    native.lstatSync(String(path) === upper ? (sameAnchor ? lower : other) : path, options),
  );
  const openDirectory = vi.mocked(fs.opendirSync).getMockImplementation()!;
  vi.mocked(fs.opendirSync).mockImplementation((path, options) =>
    openDirectory(String(path) === upper ? lower : path, options),
  );
  expect(decide("write", { file_path: "namespace/raw/new" }, [`NAMESPACE/${raw}`])).toMatchObject({
    kind: sameAnchor ? "deny" : "next",
    code,
  });
});

test("a separate alternate-case symlink is not filesystem folding evidence", () => {
  namespace("insensitive");
  const outside = native.mkdtempSync(join(tmpdir(), "raw-alternate-entry-"));
  try {
    const link = join(outside, "link");
    native.symlinkSync(join(cwd, "marker"), link);
    const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
    vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) =>
      String(path) === join(cwd, "MARKER")
        ? native.lstatSync(link, options)
        : lookup(path, options),
    );
    expect(decide("write", { file_path: "raw/new" })).toMatchObject({
      kind: "deny",
      code: "raw-path-unavailable",
    });
  } finally {
    native.rmSync(outside, { recursive: true, force: true });
  }
});

// One explicit OS entry mapping, not a case-folding filesystem model: native
// lookup still validates the real entry before returning the caller's spelling.
function retainExistingEntry(spelling: string, entry: string) {
  const configured = join(cwd, spelling);
  const physical = join(cwd, entry);
  const stat = native.lstatSync(physical);
  expect(stat.isFile() || stat.isDirectory()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  vi.mocked(fs.realpathSync.native).mockImplementation((path) => {
    const matched = String(path) === configured;
    const resolved = native.realpathSync.native(matched ? physical : path);
    return matched ? configured : resolved;
  });
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) =>
    native.lstatSync(String(path) === configured ? physical : path, options),
  );
}

test.each([
  ["RUNS", "runs"],
  ["STACKS", "stacks"],
  ["PROVENANCE", "provenance"],
])("fully existing retained-case %s/%s still denies its fixed output", (raw, output) => {
  native.mkdirSync(join(cwd, output));
  retainExistingEntry(raw, output);
  const before = native.lstatSync(join(cwd, output), { bigint: true });
  expect(decide("shud_run", { input_dir: "ordinary-input" }, [raw])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  // Read-only directory enumeration may advance atime on Linux.
  expect(native.lstatSync(join(cwd, output), { bigint: true })).toMatchObject({
    dev: before.dev,
    ino: before.ino,
    mode: before.mode,
    nlink: before.nlink,
    size: before.size,
    mtimeNs: before.mtimeNs,
    ctimeNs: before.ctimeNs,
  });
  expect(fs.opendirSync).not.toHaveBeenCalled();
});

test.each([
  ["write", { file_path: "observations.csv" }],
  ["edit", { file_path: "observations.csv" }],
  ["str_replace_editor", { command: "str_replace", path: "observations.csv" }],
] as const)("fully existing retained-case file preserves %s immutability", (name, args) => {
  const path = join(cwd, "observations.csv");
  const bytes = "original observations\n";
  native.writeFileSync(path, bytes);
  expect(native.lstatSync(path).nlink).toBe(1);
  retainExistingEntry("OBSERVATIONS.CSV", "observations.csv");
  expect(decide(name, args, ["OBSERVATIONS.CSV"])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(native.readFileSync(path, "utf8")).toBe(bytes);
});

test.each([
  ["task_create", {}, "TASKS", "tasks"],
  ["report_generate", { task_id: task }, "REPORTS", "reports"],
] as const)("fully existing retained-case namespace protects %s", (name, args, raw, output) => {
  native.mkdirSync(join(cwd, output));
  retainExistingEntry(raw, output);
  expect(decide(name, args, [raw])).toMatchObject({ kind: "deny", code: "raw-immutable" });
});

test.each(["shud_run", "report_generate"])(
  "fully existing retained-case task file remains protected for %s",
  (name) => {
    const directory = join(cwd, "tasks", task);
    native.mkdirSync(directory, { recursive: true });
    const bytes = "original task bytes; denial precedes task consumption\n";
    native.writeFileSync(join(directory, "task.json"), bytes);
    const raw = `tasks/${task}/TASK.JSON`;
    retainExistingEntry(raw, `tasks/${task}/task.json`);
    expect(decide(name, { task_id: task, input_dir: "ordinary-input" }, [raw])).toMatchObject({
      kind: "deny",
      code: "raw-immutable",
    });
    expect(native.readFileSync(join(directory, "task.json"), "utf8")).toBe(bytes);
  },
);

test.each(["report_validate", "report_submit", "report_decide"])(
  "fully existing retained-case report file remains protected for %s",
  (name) => {
    const evidence = makeEvidenceReport();
    native.mkdirSync(join(cwd, "reports"));
    const actual = `reports/${evidence.report_id}.json`;
    const raw = `reports/${evidence.report_id}.JSON`;
    const bytes = JSON.stringify(evidence);
    native.writeFileSync(join(cwd, actual), bytes);
    retainExistingEntry(raw, actual);
    expect(decide(name, { report_id: evidence.report_id }, [raw])).toMatchObject({
      kind: "deny",
      code: "raw-immutable",
    });
    expect(native.readFileSync(join(cwd, actual), "utf8")).toBe(bytes);
  },
);

test.each(["data", "data/input"])(
  "fully existing retained-case raw input %s requires provenance approval",
  (input_dir) => {
    native.mkdirSync(join(cwd, "data", "input"), { recursive: true });
    retainExistingEntry("DATA", "data");
    expect(decide("shud_run", { input_dir }, ["DATA"])).toMatchObject({
      kind: "ask",
      code: "raw-read-provenance",
      reason: RAW_READ_PROVENANCE_REASON,
    });
  },
);

test.each(["bash", "pwsh"])(
  "fully existing retained-case workdir keeps %s provenance policy",
  (name) => {
    native.mkdirSync(join(cwd, "data"));
    retainExistingEntry("DATA", "data");
    expect(decide(name, { command: "pwd", workdir: "data" }, ["DATA"])).toMatchObject({
      kind: "ask",
      code: "raw-read-provenance",
      reason: RAW_READ_PROVENANCE_REASON,
    });
  },
);

test("fully existing retained-case archive target remains immutable", () => {
  const bytes = "original archive bytes\n";
  native.writeFileSync(join(cwd, "archive.tar"), bytes);
  native.mkdirSync(join(cwd, "source"));
  retainExistingEntry("ARCHIVE.TAR", "archive.tar");
  expect(
    decide("bash", { command: "tar -cf archive.tar source" }, ["ARCHIVE.TAR", "source"]),
  ).toMatchObject({ kind: "deny", code: "raw-immutable" });
  expect(native.readFileSync(join(cwd, "archive.tar"), "utf8")).toBe(bytes);
});

test.each(["directory", "file"])(
  "retained-case existing %s with distinct physical identities remains unrelated",
  (kind) => {
    if (kind === "directory") {
      native.mkdirSync(join(cwd, "raw"));
      native.mkdirSync(join(cwd, "distinct"));
    } else {
      native.writeFileSync(join(cwd, "raw"), "ordinary target\n");
      native.writeFileSync(join(cwd, "distinct"), "separate protected entry\n");
    }
    const target = native.lstatSync(join(cwd, "raw"));
    const protectedEntry = native.lstatSync(join(cwd, "distinct"));
    expect([target.dev, target.ino]).not.toEqual([protectedEntry.dev, protectedEntry.ino]);
    retainExistingEntry("RAW", "distinct");
    expect(decide("write", { file_path: "raw" })).toEqual({ kind: "next", code: "unrelated" });
  },
);

test("ordinary existing containment and disjoint siblings retain native policy", () => {
  native.mkdirSync(join(cwd, "raw"));
  native.mkdirSync(join(cwd, "rawx"));
  expect(decide("write", { file_path: "raw" }, ["raw"])).toMatchObject({
    kind: "deny",
    code: "raw-immutable",
  });
  expect(decide("write", { file_path: "rawx" }, ["raw"])).toEqual({
    kind: "next",
    code: "unrelated",
  });
});

test("changed anchor metadata invalidates stable insensitive entry evidence and closes the handle", () => {
  namespace("insensitive");
  const marker = join(cwd, "marker");
  const before = native.lstatSync(marker, { bigint: true });
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let anchorObservations = 0;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === cwd) {
      const stat = native.lstatSync(path, { bigint: true });
      if (++anchorObservations > 1) stat.ctimeNs += 1n;
      return stat;
    }
    return lookup(path, options);
  });
  expect(decide("write", { file_path: "raw/new" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  expect(anchorObservations).toBeGreaterThan(1);
  expect(native.lstatSync(marker, { bigint: true })).toEqual(before);
  expect(reads).toBeGreaterThan(0);
  expect(open.size).toBe(0);
});

test.each(["report_validate", "report_submit", "report_decide"])(
  "fully existing retained-case linked task file remains protected for %s",
  (name) => {
    const evidence = makeEvidenceReport();
    native.mkdirSync(join(cwd, "reports"));
    native.writeFileSync(
      join(cwd, "reports", `${evidence.report_id}.json`),
      JSON.stringify(evidence),
    );
    const directory = `tasks/${evidence.task_id}`;
    native.mkdirSync(join(cwd, directory), { recursive: true });
    const bytes = "original linked task bytes\n";
    native.writeFileSync(join(cwd, directory, "task.json"), bytes);
    const raw = `${directory}/TASK.JSON`;
    retainExistingEntry(raw, `${directory}/task.json`);
    expect(decide(name, { report_id: evidence.report_id }, [raw])).toMatchObject({
      kind: "deny",
      code: "raw-immutable",
    });
    expect(native.readFileSync(join(cwd, directory, "task.json"), "utf8")).toBe(bytes);
  },
);

test.each(["directory", "file"])(
  "native existing %s spellings follow actual same-object or distinct-object identity",
  (kind) => {
    const lower = join(cwd, "raw");
    const upper = join(cwd, "RAW");
    if (kind === "directory") native.mkdirSync(lower);
    else native.writeFileSync(lower, "lower entry\n", { flag: "wx" });
    try {
      if (kind === "directory") native.mkdirSync(upper);
      else native.writeFileSync(upper, "upper entry\n", { flag: "wx" });
    } catch (error) {
      expect(error).toMatchObject({ code: "EEXIST" });
    }
    const left = native.lstatSync(lower);
    const right = native.lstatSync(upper);
    const sameObject = left.dev === right.dev && left.ino === right.ino;
    expect(decide("write", { file_path: "raw" })).toEqual(
      sameObject
        ? expect.objectContaining({ kind: "deny", code: "raw-immutable" })
        : { kind: "next", code: "unrelated" },
    );
  },
);

test("fully existing multiply linked file evidence denies without claiming a case alias", () => {
  native.writeFileSync(join(cwd, "raw"), "protected bytes\n");
  native.linkSync(join(cwd, "raw"), join(cwd, "other-name"));
  retainExistingEntry("RAW", "raw");
  expect(decide("write", { file_path: "raw" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  expect(fs.opendirSync).not.toHaveBeenCalled();
});

test("fully existing alias identity lookup failure is controlled rather than unrelated", () => {
  native.mkdirSync(join(cwd, "raw"));
  retainExistingEntry("RAW", "raw");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === join(cwd, "RAW")) {
      throw Object.assign(new Error("PRIVATE_EXISTING_IDENTITY_FAILURE"), { code: "EACCES" });
    }
    return lookup(path, options);
  });
  const decision = decide("write", { file_path: "raw" });
  expect(decision).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
  expect(decision.reason).not.toMatch(/PRIVATE|EACCES|raw-path-identity/u);
});

test("changing fully existing alias metadata invalidates same-object evidence", () => {
  native.mkdirSync(join(cwd, "raw"));
  retainExistingEntry("RAW", "raw");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  let observations = 0;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === join(cwd, "RAW")) {
      const stat = native.lstatSync(join(cwd, "raw"), { bigint: true });
      if (++observations > 1) stat.ctimeNs += 1n;
      return stat;
    }
    return lookup(path, options);
  });
  expect(decide("write", { file_path: "raw" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  expect(observations).toBeGreaterThan(1);
});

test("a symlink replacement cannot establish fully existing alias identity", () => {
  native.writeFileSync(join(cwd, "raw"), "protected bytes\n");
  native.symlinkSync(join(cwd, "raw"), join(cwd, "replacement"));
  retainExistingEntry("RAW", "raw");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) =>
    String(path) === join(cwd, "RAW")
      ? native.lstatSync(join(cwd, "replacement"), options)
      : lookup(path, options),
  );
  expect(decide("write", { file_path: "raw" })).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test("same single-link file identity across distinct parents is not case-alias proof", () => {
  native.mkdirSync(join(cwd, "data"));
  native.mkdirSync(join(cwd, "other"));
  native.writeFileSync(join(cwd, "data", "file"), "protected bytes\n");
  retainExistingEntry("DATA/FILE", "data/file");
  const lookup = vi.mocked(fs.lstatSync).getMockImplementation()!;
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) =>
    String(path) === join(cwd, "DATA")
      ? native.lstatSync(join(cwd, "other"), options)
      : lookup(path, options),
  );
  expect(decide("write", { file_path: "data/file" }, ["DATA/FILE"])).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
});

test.each(["ELOOP", "ENOTDIR"])(
  "secondary folded-parent %s failure returns a controlled unavailable-path denial",
  (code) => {
    native.mkdirSync(join(cwd, "child"));
    const failingPath = join(cwd, "CHILD", "RAW");
    const fault = Object.assign(new Error("PRIVATE_SECONDARY_PATH_FAILURE"), {
      code,
      path: failingPath,
    });
    vi.mocked(fs.realpathSync.native).mockImplementation((path) => {
      if (String(path) === failingPath) throw fault;
      return native.realpathSync.native(path);
    });
    const decision = decide("write", { file_path: "child/raw/new" }, ["missing/../CHILD/RAW"]);
    expect(decision).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
    expect(decision.reason).toMatch(/unavailable/u);
    expect(decision.reason).not.toMatch(/PRIVATE|ELOOP|ENOTDIR/u);
    expect(decision.reason).not.toContain(cwd);
  },
);

test.each(["ELOOP", "ENOTDIR"])(
  "primary %s resolution failure still propagates the original filesystem error",
  (code) => {
    native.mkdirSync(join(cwd, "child"));
    const failingPath = join(cwd, "CHILD", "RAW");
    const fault = Object.assign(new Error("PRIVATE_PRIMARY_PATH_FAILURE"), {
      code,
      path: failingPath,
    });
    vi.mocked(fs.realpathSync.native).mockImplementation((path) => {
      if (String(path) === failingPath) throw fault;
      return native.realpathSync.native(path);
    });
    let thrown: unknown;
    try {
      decide("write", { file_path: "child/raw/new" }, ["CHILD/RAW"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(fault);
  },
);
