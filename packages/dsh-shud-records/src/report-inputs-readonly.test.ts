import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderReport, validateReport } from "./index.ts";
import {
  CHECK_SHAPE,
  makeValidationWorkspace,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";

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
