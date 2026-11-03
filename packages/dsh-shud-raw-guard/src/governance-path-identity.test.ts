import { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decideRawAccess, normalizeRawDirs } from "./decide.ts";
import { apply } from "./index.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    opendirSync: vi.fn(actual.opendirSync),
    realpathSync: Object.assign(actual.realpathSync.bind(actual), {
      native: vi.fn(actual.realpathSync.native),
    }),
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
type Namespace =
  "sensitive" | "insensitive" | "empty" | "unreadable" | "changing" | "bound" | "close";
let cwd: string;
let mode: Namespace;
let reads: number;
let markerReads: number;
const handles = new Set<fs.Dir>();

beforeEach(() => {
  cwd = native.realpathSync.native(native.mkdtempSync(join(tmpdir(), "governance-identity-")));
  mode = "empty";
  reads = 0;
  markerReads = 0;
  vi.clearAllMocks();
  vi.mocked(fs.lstatSync).mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
    if (String(path) === join(cwd, "MARKER")) {
      return mode === "sensitive" ? undefined : native.lstatSync(join(cwd, "marker"), options);
    }
    if (mode === "changing" && String(path) === join(cwd, "marker")) {
      const result = native.lstatSync(path, { bigint: true });
      if (++markerReads > 1) result.ctimeNs += 1n;
      return result;
    }
    return native.lstatSync(path, options);
  });
  vi.mocked(fs.realpathSync.native).mockImplementation((path) => {
    if (String(path) === join(cwd, "MARKER")) return join(cwd, "marker");
    return native.realpathSync.native(path);
  });
  vi.mocked(fs.opendirSync).mockImplementation((path, options) => {
    if (mode === "unreadable") {
      throw Object.assign(new Error(`PRIVATE_NAMESPACE ${cwd}`), { code: "EACCES" });
    }
    const handle = native.opendirSync(path, options);
    handles.add(handle);
    const read = handle.readSync.bind(handle);
    const close = handle.closeSync.bind(handle);
    vi.spyOn(handle, "readSync").mockImplementation(() => {
      reads++;
      if (mode === "bound") {
        if (reads > 64) throw new Error("namespace inspection exceeded its bound");
        return native.readdirSync(cwd, { withFileTypes: true })[0];
      }
      return read();
    });
    vi.spyOn(handle, "closeSync").mockImplementation(() => {
      close();
      handles.delete(handle);
      if (mode === "close") throw new Error(`PRIVATE_CLOSE ${cwd}`);
    });
    return handle;
  });
});

afterEach(() => {
  try {
    expect(handles.size).toBe(0);
    for (const writer of [
      fs.writeFileSync,
      fs.mkdirSync,
      fs.openSync,
      fs.renameSync,
      fs.unlinkSync,
      fs.rmSync,
    ]) {
      expect(writer).not.toHaveBeenCalled();
    }
  } finally {
    for (const handle of handles) handle.closeSync();
    handles.clear();
    vi.restoreAllMocks();
    native.rmSync(cwd, { recursive: true, force: true });
  }
});

function namespace(value: Namespace) {
  mode = value;
  markerReads = 0;
  if (value === "bound") native.writeFileSync(join(cwd, "123"), "letterless entry\n");
  else if (value !== "empty") native.writeFileSync(join(cwd, "marker"), "namespace evidence\n");
}

const accesses = [
  ["write", { file_path: "CHANGES/x.json" }],
  ["bash", { command: "echo '{}' > x.json", workdir: "CHANGES" }],
] as const;

// Only OS metadata is controlled. Both policy stages, dispatch and audit stay real.
test.each(["sensitive", "insensitive", "empty", "unreadable", "changing"] as const)(
  "%s missing governance namespace controls both file and shell workdir decisions",
  async (value) => {
    namespace(value);
    const ctx = new Context();
    const audit: unknown[][] = [];
    const stop = ctx.logger.exporter({
      export(message) {
        if (message.name === "shud-raw-guard") audit.push(message.args as unknown[]);
      },
    });
    const fiber = await ctx.plugin({ apply }, { rawDirs: ["unrelated-raw"] });
    try {
      const before = native.readdirSync(cwd);
      const mtime = native.statSync(cwd, { bigint: true }).mtimeNs;
      for (const [name, args] of accesses) {
        markerReads = 0;
        audit.length = 0;
        const downstream: PreToolDecision = { kind: "ask", reason: "later policy" };
        const next = vi.fn(() => Promise.resolve(downstream));
        const execution = {
          name,
          arguments: args,
          agent: { session: { header: { cwd } } },
        } as unknown as ToolExecution;
        const result = await ctx.waterfall("tools/pre-execute", execution, next);
        if (value === "sensitive") {
          expect(result).toBe(downstream);
          expect(next).toHaveBeenCalledTimes(1);
          expect(audit).toEqual([]);
        } else {
          expect(result.kind).toBe("deny");
          expect(next).not.toHaveBeenCalled();
          const code = value === "insensitive" ? "governance-immutable" : "raw-path-unavailable";
          expect(audit).toEqual([[`deny ${name} ${code}`]]);
          expect(result).toHaveProperty(
            "reason",
            expect.not.stringMatching(/PRIVATE|CHANGES|EACCES|governance-identity-/),
          );
          if (value === "insensitive") {
            expect(result).toHaveProperty("reason", expect.stringContaining("immutable"));
          }
        }
        expect(handles.size).toBe(0);
        expect(native.existsSync(join(cwd, "changes"))).toBe(false);
        expect(native.readdirSync(cwd)).toEqual(before);
        expect(native.statSync(cwd, { bigint: true }).mtimeNs).toBe(mtime);
      }
    } finally {
      await fiber.dispose();
      await stop();
    }
  },
);

test.each(accesses)(
  "%s bounds unusable namespace enumeration and releases its handle",
  (name, args) => {
    namespace("bound");
    const result = decideRawAccess(
      { name, arguments: args, cwd },
      normalizeRawDirs({ rawDirs: ["unrelated-raw"] }),
    );
    expect(result).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThanOrEqual(64);
    expect(handles.size).toBe(0);
  },
);

test("directory close failure keeps governance identity unavailable without leaking errors", () => {
  namespace("close");
  const result = decideRawAccess(
    { name: "write", arguments: { file_path: "CHANGES/x.json" }, cwd },
    normalizeRawDirs({ rawDirs: ["unrelated-raw"] }),
  );
  expect(result).toMatchObject({ kind: "deny", code: "raw-path-unavailable" });
  expect(result.reason).not.toMatch(/PRIVATE|governance-identity-/);
  expect(handles.size).toBe(0);
});

test.each(accesses)("%s obtains fresh namespace evidence on each later decision", (name, args) => {
  const options = normalizeRawDirs({ rawDirs: ["unrelated-raw"] });
  const call = { name, arguments: args, cwd };
  namespace("insensitive");
  expect(decideRawAccess(call, options)).toMatchObject({
    kind: "deny",
    code: "governance-immutable",
  });
  native.unlinkSync(join(cwd, "marker"));
  mode = "empty";
  expect(decideRawAccess(call, options)).toMatchObject({
    kind: "deny",
    code: "raw-path-unavailable",
  });
  namespace("sensitive");
  expect(decideRawAccess(call, options)).toEqual({ kind: "next", code: "unrelated" });
});

test("read, view and missing argument calls perform no identity discovery", () => {
  const options = normalizeRawDirs({ rawDirs: ["unrelated-raw"] });
  for (const [name, args] of [
    ["read", { file_path: "CHANGES/x.json" }],
    ["str_replace_editor", { command: "view", path: "CHANGES/x.json" }],
    ["write", { file_path: 7 }],
    ["bash", { command: false, workdir: "CHANGES" }],
    ["pwsh", null],
  ] as const) {
    expect(decideRawAccess({ name, arguments: args, cwd }, options)).toEqual({
      kind: "next",
      code: "unrelated",
    });
  }
  expect(fs.realpathSync.native).not.toHaveBeenCalled();
  expect(fs.opendirSync).not.toHaveBeenCalled();
  expect(fs.lstatSync).not.toHaveBeenCalled();
});
