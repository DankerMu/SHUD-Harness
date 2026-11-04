import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import { readReportMarkdown, readWorkspaceRecord, writeWorkspaceRecord } from "./index.ts";
import { installUnsafe, recordCases, reportCase } from "./test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), {
      native: vi.fn(actual.realpathSync.native),
    }),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const native = await vi.importActual<typeof fs>("node:fs");
let cwd: string;
beforeEach(() => {
  cwd = native.mkdtempSync(join(tmpdir(), "report-readonly-"));
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
  vi.mocked(fs.realpathSync.native).mockReset().mockImplementation(native.realpathSync.native);
  vi.clearAllMocks();
});
afterEach(() => {
  native.rmSync(cwd, { recursive: true, force: true });
});

test("readonly report reads follow physical cwd traversal without changing either workspace", () => {
  const workspace = join(cwd, "workspace");
  native.mkdirSync(join(workspace, "child"), { recursive: true });
  const physicalWorkspace = native.realpathSync.native(workspace);
  const alias = join(cwd, "cwd-alias");
  native.symlinkSync(join(physicalWorkspace, "child"), alias);
  const aliasedCwd = `${alias}/..`;
  const reports = [
    { path: join(cwd, reportCase.relative), summary: "LEXICAL_SENTINEL" },
    { path: join(physicalWorkspace, reportCase.relative), summary: "PHYSICAL_SENTINEL" },
  ];
  const snapshots = reports.map(({ path, summary }) => {
    native.mkdirSync(dirname(path), { recursive: true });
    native.writeFileSync(path, JSON.stringify({ ...reportCase.value, summary }));
    return {
      path,
      bytes: native.readFileSync(path),
      mtimeNs: native.statSync(path, { bigint: true }).mtimeNs,
    };
  });

  expect(readWorkspaceRecord(cwd, "report", reportCase.id, { readonly: true }).summary).toBe(
    "LEXICAL_SENTINEL",
  );
  expect(
    readWorkspaceRecord(physicalWorkspace, "report", reportCase.id, { readonly: true }).summary,
  ).toBe("PHYSICAL_SENTINEL");
  expect(native.realpathSync.native(aliasedCwd)).toBe(physicalWorkspace);

  const selected = readWorkspaceRecord(aliasedCwd, "report", reportCase.id, { readonly: true });

  for (const { path, bytes, mtimeNs } of snapshots) {
    expect(native.readFileSync(path)).toEqual(bytes);
    expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(mtimeNs);
  }
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(selected.summary).toBe("PHYSICAL_SENTINEL");
});

test("readonly missing physical reports root never falls back to a populated lexical decoy", () => {
  const workspace = join(cwd, "workspace");
  native.mkdirSync(join(workspace, "child"), { recursive: true });
  const physicalWorkspace = native.realpathSync.native(workspace);
  const alias = join(cwd, "cwd-alias");
  native.symlinkSync(join(physicalWorkspace, "child"), alias);
  const aliasedCwd = `${alias}/..`;
  const id = ReportIdSchema.parse(reportCase.id);
  const reportPath = join(cwd, reportCase.relative);
  const markdownPath = join(cwd, "reports", `${id}.md`);
  native.mkdirSync(dirname(reportPath));
  native.writeFileSync(
    reportPath,
    JSON.stringify({ ...reportCase.value, summary: "LEXICAL_SENTINEL" }),
  );
  native.writeFileSync(markdownPath, "LEXICAL_MARKDOWN_SENTINEL");
  const snapshots = [reportPath, markdownPath].map((path) => ({
    path,
    bytes: native.readFileSync(path),
    mtimeNs: native.statSync(path, { bigint: true }).mtimeNs,
  }));
  expect(readWorkspaceRecord(cwd, "report", id, { readonly: true }).summary).toBe(
    "LEXICAL_SENTINEL",
  );
  expect(readReportMarkdown(cwd, id)).toBe("LEXICAL_MARKDOWN_SENTINEL");
  expect(native.realpathSync.native(aliasedCwd)).toBe(physicalWorkspace);
  expect(native.existsSync(join(physicalWorkspace, "reports"))).toBe(false);
  vi.clearAllMocks();

  expect(() => readWorkspaceRecord(aliasedCwd, "report", id, { readonly: true })).toThrow(
    /Workspace record missing failed/u,
  );
  expect(readReportMarkdown(aliasedCwd, id)).toBeUndefined();

  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(native.readdirSync(physicalWorkspace)).toEqual(["child"]);
  expect(native.readdirSync(join(cwd, "reports")).sort()).toEqual(
    [`${id}.json`, `${id}.md`].sort(),
  );
  for (const { path, bytes, mtimeNs } of snapshots) {
    expect(native.readFileSync(path)).toEqual(bytes);
    expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(mtimeNs);
  }
});

test.each(["symlink", "file", "fifo"] as const)(
  "readonly rejects a managed root observed as a %s on its second inspection",
  (kind) => {
    const reports = join(cwd, "reports");
    const detached = join(cwd, "detached-reports");
    const outside = join(cwd, "outside");
    native.mkdirSync(reports);
    native.mkdirSync(join(outside, "reports"), { recursive: true });
    const original = join(cwd, reportCase.relative);
    const foreign = join(outside, reportCase.relative);
    native.writeFileSync(
      original,
      JSON.stringify({ ...reportCase.value, summary: "PHYSICAL_SENTINEL" }),
    );
    native.writeFileSync(
      foreign,
      JSON.stringify({ ...reportCase.value, summary: "FOREIGN_SENTINEL" }),
    );
    const snapshots = [original, foreign].map((path) => ({
      bytes: native.readFileSync(path),
      mtimeNs: native.statSync(path, { bigint: true }).mtimeNs,
    }));
    expect(readWorkspaceRecord(outside, "report", reportCase.id, { readonly: true }).summary).toBe(
      "FOREIGN_SENTINEL",
    );
    let inspections = 0;
    let observedUnsafe = false;
    vi.clearAllMocks();
    vi.mocked(fs.lstatSync).mockImplementation((...args) => {
      if (args[0] === reports) {
        inspections++;
        if (inspections === 2) {
          native.renameSync(reports, detached);
          installUnsafe(reports, kind, join(outside, "reports"));
        }
      }
      const observed = native.lstatSync(...args);
      if (args[0] === reports && inspections === 2) {
        observedUnsafe =
          kind === "symlink"
            ? observed?.isSymbolicLink() === true
            : kind === "file"
              ? observed?.isFile() === true
              : observed?.isFIFO() === true;
      }
      return observed;
    });
    let failure: unknown;

    try {
      readWorkspaceRecord(cwd, "report", reportCase.id, { readonly: true });
    } catch (error) {
      failure = error;
    }

    expect(inspections).toBe(2);
    expect(observedUnsafe).toBe(true);
    expect(failure).toMatchObject({ stage: "directory" });
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.realpathSync.native).not.toHaveBeenCalled();
    for (const [index, path] of [join(detached, `${reportCase.id}.json`), foreign].entries()) {
      expect(native.readFileSync(path)).toEqual(snapshots[index]?.bytes);
      expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(snapshots[index]?.mtimeNs);
    }
  },
);

test("native root resolution failure is not missing and never reads or writes records", () => {
  const path = join(cwd, reportCase.relative);
  native.mkdirSync(dirname(path));
  native.writeFileSync(path, JSON.stringify(reportCase.value));
  const before = {
    bytes: native.readFileSync(path),
    mtimeNs: native.statSync(path, { bigint: true }).mtimeNs,
  };
  vi.mocked(fs.realpathSync.native).mockImplementationOnce(() => {
    throw Object.assign(new Error("PRIVATE_NATIVE_RESOLUTION"), { code: "EACCES" });
  });
  expect(() => readWorkspaceRecord(cwd, "report", reportCase.id, { readonly: true })).toThrow(
    /directory/u,
  );
  expect(fs.realpathSync.native).toHaveBeenCalledExactlyOnceWith(`${cwd}/reports`);
  expect(fs.readFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
  expect(native.readFileSync(path)).toEqual(before.bytes);
  expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

for (const operation of ["read", "write"] as const) {
  test.each([undefined, null, false, 0, {}])(
    `${operation} rejects nonstring cwd %j before IO or coercion`,
    (value) => {
      const coerce = vi.fn(() => cwd);
      if (typeof value === "object" && value !== null) {
        Object.assign(value, { [Symbol.toPrimitive]: coerce });
      }
      const invalid = value as string;
      const operations = [
        fs.lstatSync,
        fs.realpathSync,
        fs.realpathSync.native,
        fs.readFileSync,
        fs.mkdirSync,
        fs.openSync,
        fs.writeFileSync,
        fs.renameSync,
      ];
      try {
        for (const io of operations) {
          vi.mocked(io).mockImplementation(() => {
            throw new Error("Unexpected filesystem access");
          });
        }
        expect(() =>
          operation === "read"
            ? readWorkspaceRecord(invalid, "report", reportCase.id, { readonly: true })
            : writeWorkspaceRecord(invalid, "report", reportCase.value),
        ).toThrow();
        expect(coerce).not.toHaveBeenCalled();
        for (const io of operations) expect(io).not.toHaveBeenCalled();
      } finally {
        vi.mocked(fs.lstatSync).mockReset().mockImplementation(native.lstatSync);
        vi.mocked(fs.realpathSync).mockReset().mockImplementation(native.realpathSync);
        vi.mocked(fs.realpathSync.native)
          .mockReset()
          .mockImplementation(native.realpathSync.native);
        vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
        vi.mocked(fs.mkdirSync).mockReset().mockImplementation(native.mkdirSync);
        vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
        vi.mocked(fs.writeFileSync).mockReset().mockImplementation(native.writeFileSync);
        vi.mocked(fs.renameSync).mockReset().mockImplementation(native.renameSync);
      }
    },
  );
}

test("malformed record input rejects before native root resolution", () => {
  expect(() => writeWorkspaceRecord(cwd, "report", { ...reportCase.value, summary: 42 })).toThrow();
  expect(() => readWorkspaceRecord(cwd, "unknown" as "report", reportCase.id)).toThrow();
  expect(() => readWorkspaceRecord(cwd, "report", "../escape")).toThrow();
  for (const io of [
    fs.lstatSync,
    fs.realpathSync.native,
    fs.readFileSync,
    fs.mkdirSync,
    fs.openSync,
    fs.writeFileSync,
  ]) {
    expect(io).not.toHaveBeenCalled();
  }
});

for (const fixture of recordCases) {
  test(`${fixture.kind} readonly missing read never creates directories; legacy read still does`, () => {
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(native.readdirSync(cwd)).toEqual([]);
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id)).toThrow();
    expect(native.existsSync(join(cwd, fixture.directory))).toBe(true);
    if (fixture.kind === "task")
      expect(native.existsSync(dirname(join(cwd, fixture.relative)))).toBe(true);
  });
  test(`${fixture.kind} readonly returns schema-bound identity without byte or mtime changes`, () => {
    const path = join(cwd, fixture.relative);
    native.mkdirSync(dirname(path), { recursive: true });
    native.writeFileSync(path, JSON.stringify(fixture.value));
    const before = native.statSync(path, { bigint: true });
    const expectedOutput =
      fixture.kind === "task"
        ? {
            ...fixture.value,
            linked_changes: [],
            linked_verifications: [],
            source_base_commit: null,
          }
        : fixture.kind === "stack"
          ? { ...fixture.value, build_id: null }
          : fixture.kind === "data"
            ? { ...fixture.value, sources: { ...fixture.value.sources, external_files: [] } }
            : { ...fixture.value, change_ids: [], verification_ids: [] };
    expect(readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toEqual(
      expectedOutput,
    );
    expect(native.statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
  test(`${fixture.kind} readonly rejects a schema-valid foreign embedded id`, () => {
    const path = join(cwd, fixture.relative);
    native.mkdirSync(dirname(path), { recursive: true });
    native.writeFileSync(
      path,
      JSON.stringify({
        ...fixture.value,
        [`${fixture.kind}_id`]: `${fixture.id.slice(0, -4)}ffff`,
      }),
    );
    const before = native.readFileSync(path);
    expect(() => readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true })).toThrow();
    expect(native.readFileSync(path)).toEqual(before);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
  test.each(["symlink", "dangling-link", "fifo", "directory"] as const)(
    `${fixture.kind} readonly rejects %s target`,
    (kind) => {
      const path = join(cwd, fixture.relative);
      native.mkdirSync(dirname(path), { recursive: true });
      const outside = join(cwd, "outside.json");
      native.writeFileSync(outside, JSON.stringify(fixture.value));
      installUnsafe(path, kind, outside);
      vi.clearAllMocks();
      expect(() =>
        readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true }),
      ).toThrow();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(native.readFileSync(outside, "utf8")).toBe(JSON.stringify(fixture.value));
    },
  );
  test.each(["symlink", "file", "fifo"] as const)(
    `${fixture.kind} readonly rejects %s managed ancestor`,
    (kind) => {
      const outside = join(cwd, "outside");
      native.mkdirSync(outside);
      installUnsafe(join(cwd, fixture.directory), kind, outside);
      expect(() =>
        readWorkspaceRecord(cwd, fixture.kind, fixture.id, { readonly: true }),
      ).toThrow();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(native.readdirSync(outside)).toEqual([]);
    },
  );
  test(`${fixture.kind} malformed id rejects before path IO`, () => {
    expect(() => readWorkspaceRecord(cwd, fixture.kind, "../escape", { readonly: true })).toThrow();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.lstatSync).not.toHaveBeenCalled();
  });
}

test.each(["read", "write"] as const)(
  "empty-string cwd retains relative %s traversal without test-process side effects",
  (operation) => {
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ISOLATED_EMPTY_CWD_PREFLIGHT"), { code: "EACCES" });
    });
    expect(() =>
      operation === "read"
        ? readWorkspaceRecord("", "report", reportCase.id, { readonly: true })
        : writeWorkspaceRecord("", "report", reportCase.value),
    ).toThrow(/directory/u);
    expect(fs.lstatSync).toHaveBeenCalledExactlyOnceWith("./reports", { throwIfNoEntry: false });
    expect(fs.realpathSync.native).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  },
);
