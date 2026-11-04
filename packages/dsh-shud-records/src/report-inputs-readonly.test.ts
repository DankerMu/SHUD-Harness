import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderReport, validateReport } from "./index.ts";
import {
  CHECK_SHAPE,
  makeValidationWorkspace,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";
import { renderingInputs } from "./report-workspace-test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});
const nativeFs = await vi.importActual<typeof fs>("node:fs");
let workspace: ValidationWorkspace;
beforeEach(() => {
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(nativeFs.mkdirSync);
  workspace = makeValidationWorkspace();
});
afterEach(() => {
  nativeFs.rmSync(workspace.root, { recursive: true, force: true });
});

test.each(["ordinary", "alias", "physical-parent"] as const)(
  "%s rendering and thirteen-check validation use physical references rather than populated lexical decoys",
  (mode) => {
    const physical = nativeFs.realpathSync.native(workspace.cwd);
    nativeFs.mkdirSync(join(physical, "child"));
    const alias = join(workspace.root, "cwd-alias");
    nativeFs.symlinkSync(mode === "physical-parent" ? join(physical, "child") : physical, alias);
    const cwd = mode === "ordinary" ? workspace.cwd : mode === "alias" ? alias : `${alias}/..`;
    expect(nativeFs.realpathSync.native(cwd)).toBe(physical);
    const decoys = renderingInputs(workspace.fixture).map((input) => {
      const path = join(workspace.root, input.path);
      nativeFs.mkdirSync(dirname(path), { recursive: true });
      const value =
        input.kind === "report"
          ? { ...input.value, summary: "LEXICAL_REPORT_SENTINEL" }
          : input.kind === "run"
            ? { ...input.value, resources: { wall_seconds: 999, peak_memory_mb: null } }
            : input.value;
      nativeFs.writeFileSync(path, JSON.stringify(value));
      return {
        path,
        bytes: nativeFs.readFileSync(path),
        mtimeNs: nativeFs.statSync(path, { bigint: true }).mtimeNs,
      };
    });
    const before = workspace.snapshot();
    const golden = nativeFs.readFileSync(
      new URL("./report-render.golden.md", import.meta.url),
      "utf8",
    );
    vi.mocked(fs.mkdirSync).mockClear();
    expect(renderReport(cwd, workspace.fixture.report.report_id)).toBe(golden);
    expect(validateReport(cwd, workspace.fixture.report.report_id)).toEqual({
      ok: true,
      checks: CHECK_SHAPE.map((entry) => ({ ...entry, pass: true, details: [] })),
    });
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(workspace.snapshot()).toEqual(before);
    for (const { path, bytes, mtimeNs } of decoys) {
      expect(nativeFs.readFileSync(path)).toEqual(bytes);
      expect(nativeFs.statSync(path, { bigint: true }).mtimeNs).toBe(mtimeNs);
    }
  },
);

test.each(["stacks", "provenance", "runs"] as const)(
  "missing physical %s never falls back to complete lexical report references",
  (directory) => {
    const physical = nativeFs.realpathSync.native(workspace.cwd);
    nativeFs.mkdirSync(join(physical, "child"));
    const alias = join(workspace.root, "cwd-alias");
    nativeFs.symlinkSync(join(physical, "child"), alias);
    const cwd = `${alias}/..`;
    expect(nativeFs.realpathSync.native(cwd)).toBe(physical);
    const decoys = renderingInputs(workspace.fixture).map((input) => {
      const path = join(workspace.root, input.path);
      nativeFs.mkdirSync(dirname(path), { recursive: true });
      nativeFs.writeFileSync(path, JSON.stringify(input.value));
      return {
        path,
        bytes: nativeFs.readFileSync(path),
        mtimeNs: nativeFs.statSync(path, { bigint: true }).mtimeNs,
      };
    });
    nativeFs.rmSync(join(physical, directory), { recursive: true });
    const before = workspace.snapshot();
    const entries = nativeFs.readdirSync(physical, { recursive: true }).sort();
    vi.mocked(fs.mkdirSync).mockClear();
    expect(() => renderReport(cwd, workspace.fixture.report.report_id)).toThrow(
      directory === "runs" ? /directory/u : /missing/u,
    );
    const result = validateReport(cwd, workspace.fixture.report.report_id);
    expect(result.ok).toBe(false);
    expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(CHECK_SHAPE);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(nativeFs.readdirSync(physical, { recursive: true }).sort()).toEqual(entries);
    expect(workspace.snapshot()).toEqual(before);
    for (const { path, bytes, mtimeNs } of decoys) {
      expect(nativeFs.readFileSync(path)).toEqual(bytes);
      expect(nativeFs.statSync(path, { bigint: true }).mtimeNs).toBe(mtimeNs);
    }
  },
);

test("render and validate leave a missing cwd absent", () => {
  const missing = join(workspace.root, "missing", "workspace");
  const before = workspace.snapshot();
  expect(() => renderReport(missing, workspace.fixture.report.report_id)).toThrow(/missing/u);
  expect(() => validateReport(missing, workspace.fixture.report.report_id)).toThrow(/missing/u);
  expect(nativeFs.existsSync(join(workspace.root, "missing"))).toBe(false);
  expect(workspace.snapshot()).toEqual(before);
});

for (const root of ["stacks", "provenance"] as const) {
  test(`public validateReport returns canonical missing ${root} checks without creating unprotected reference roots`, () => {
    const missing = join(workspace.cwd, root);
    nativeFs.rmSync(missing, { recursive: true });
    const entries = nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort();
    const before = workspace.snapshot();
    vi.mocked(fs.mkdirSync).mockClear();

    const result = validateReport(workspace.cwd, workspace.fixture.report.report_id);
    const referenceCheck = root === "stacks" ? 1 : 2;
    const unavailable =
      root === "stacks"
        ? workspace.fixture.stacks.map((stack) => ({
            code: "reference_unavailable",
            kind: "stack",
            id: stack.stack_id,
            stage: "missing",
          }))
        : workspace.fixture.data.map((data) => ({
            code: "reference_unavailable",
            kind: "data",
            id: data.data_id,
            stage: "missing",
          }));
    expect(result).toEqual({
      ok: false,
      checks: CHECK_SHAPE.map((check) => ({
        ...check,
        pass: check.id !== referenceCheck && ![8, 9, 12, 13].includes(check.id),
        details:
          check.id === referenceCheck
            ? unavailable
            : [8, 9, 12, 13].includes(check.id)
              ? [{ code: "render_unavailable", stage: "missing" }]
              : [],
      })),
    });
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(nativeFs.existsSync(missing)).toBe(false);
    expect(nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort()).toEqual(entries);
    expect(workspace.snapshot()).toEqual(before);
  });

  test(`public renderReport preserves its missing ${root} error without creating the reference root`, () => {
    const missing = join(workspace.cwd, root);
    nativeFs.rmSync(missing, { recursive: true });
    const entries = nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort();
    const before = workspace.snapshot();
    vi.mocked(fs.mkdirSync).mockClear();

    let failure: unknown;
    try {
      renderReport(workspace.cwd, workspace.fixture.report.report_id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ stage: "missing" });
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(nativeFs.existsSync(missing)).toBe(false);
    expect(nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort()).toEqual(entries);
    expect(workspace.snapshot()).toEqual(before);
  });
}

test.each(["render", "validate"] as const)(
  "public %s rejects a missing report root without creating it",
  (operation) => {
    const missing = join(workspace.cwd, "reports");
    nativeFs.rmSync(missing, { recursive: true });
    const entries = nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort();
    const before = workspace.snapshot();
    vi.mocked(fs.mkdirSync).mockClear();

    let failure: unknown;
    try {
      if (operation === "render") renderReport(workspace.cwd, workspace.fixture.report.report_id);
      else validateReport(workspace.cwd, workspace.fixture.report.report_id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ stage: "missing" });
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(nativeFs.existsSync(missing)).toBe(false);
    expect(nativeFs.readdirSync(workspace.cwd, { recursive: true }).sort()).toEqual(entries);
    expect(workspace.snapshot()).toEqual(before);
  },
);
