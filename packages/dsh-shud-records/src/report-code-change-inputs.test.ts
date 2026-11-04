import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderReport, ReportRenderError, validateReport } from "./index.ts";
import { workspaceFileCases } from "./workspace-files-test-harness.ts";
import { CHECK_SHAPE, realFs, SECRET } from "./report-validation-test-harness.ts";
import {
  makeCodeChangeWorkspace,
  snapshotTree,
  type CodeChangeWorkspace,
} from "./report-code-change-test-harness.ts";

let workspace: CodeChangeWorkspace;
let physicalCwd: string;
beforeEach(() => {
  workspace = makeCodeChangeWorkspace();
  physicalCwd = realFs.realpathSync.native(workspace.cwd);
});
afterEach(() => {
  realFs.rmSync(workspace.root, { recursive: true, force: true });
});

function expectReadonlyFailure(stage: string, path?: string) {
  const before = snapshotTree(workspace.root);
  let markdown: string | undefined;
  let caught: unknown;
  try {
    markdown = renderReport(workspace.cwd, workspace.report.report_id);
  } catch (error) {
    caught = error;
  }
  expect(markdown).toBeUndefined();
  expect(caught).toBeInstanceOf(ReportRenderError);
  expect(caught).toMatchObject({ stage, ...(path === undefined ? {} : { path }) });
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("issues");
  // The trusted cwd may contain SECRET; diagnostics must not contain file payloads.
  expect(inspect(caught, { depth: null })).not.toContain("private-invalid-fact-533");
  expect(snapshotTree(workspace.root)).toEqual(before);

  const result = validateReport(workspace.cwd, workspace.report.report_id);
  expect(result.ok).toBe(false);
  expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(CHECK_SHAPE);
  expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([8, 9, 12, 13]);
  for (const id of [8, 9, 12, 13]) {
    expect(result.checks.find((check) => check.id === id)).toEqual({
      id,
      pass: false,
      vacuous: false,
      details: [{ code: "render_unavailable", stage }],
    });
  }
  expect(inspect(result, { depth: null })).not.toContain(SECRET);
  expect(inspect(result, { depth: null })).not.toContain("private-invalid-fact-533");
  expect(snapshotTree(workspace.root)).toEqual(before);
}

describe.each(workspaceFileCases)("cited $kind facts", (fixture) => {
  test.each([
    ["missing", "missing"],
    ["malformed", "parse"],
    ["schema-invalid", "schema"],
    ["foreign-id", "identity"],
    ["directory", "target"],
    ["symlink", "target"],
    ["dangling-link", "target"],
  ] as const)(
    "%s rejects both canonical consumers without writes or partial Markdown",
    (fault, stage) => {
      const fact = workspace.facts.find((entry) => entry.kind === fixture.kind);
      if (fact === undefined) throw new Error("Missing fact fixture");
      const target = join(physicalCwd, fact.path);
      if (fault === "missing") realFs.unlinkSync(target);
      if (fault === "malformed")
        realFs.writeFileSync(target, `{private-invalid-fact-533 ${SECRET}`);
      if (fault === "schema-invalid") {
        workspace.publish(fact.path, {
          ...fact.value,
          created_at: `private-invalid-fact-533 ${SECRET}`,
        });
      }
      if (fault === "foreign-id") {
        expect(fixture.schema.safeParse(fixture.foreignValue).success).toBe(true);
        workspace.publish(fact.path, fixture.foreignValue);
      }
      if (fault === "directory") {
        realFs.unlinkSync(target);
        realFs.mkdirSync(target);
      }
      if (fault === "symlink" || fault === "dangling-link") {
        const outside = join(workspace.root, "outside.json");
        realFs.writeFileSync(outside, JSON.stringify(fact.value));
        realFs.unlinkSync(target);
        realFs.symlinkSync(fault === "symlink" ? outside : `${outside}-missing`, target);
      }
      expectReadonlyFailure(stage, target);
    },
  );

  test("a missing managed root is never recreated", () => {
    const target = join(workspace.cwd, fixture.directory);
    realFs.rmSync(target, { recursive: true });
    expectReadonlyFailure("missing");
    expect(realFs.existsSync(target)).toBe(false);
  });

  test.each(["file", "symlink"] as const)(
    "a %s managed root does not expose outside facts",
    (fault) => {
      const target = join(workspace.cwd, fixture.directory);
      const outside = join(workspace.root, "outside-facts");
      realFs.renameSync(target, outside);
      if (fault === "file") realFs.writeFileSync(target, "private-invalid-fact-533");
      else realFs.symlinkSync(outside, target);
      expectReadonlyFailure("directory", target);
    },
  );
});

test.each(["missing", "file", "symlink"] as const)(
  "a %s cited build directory fails without repair",
  (fault) => {
    const target = join(workspace.cwd, "builds", workspace.builds[0].build_id);
    const outside = join(workspace.root, "outside-build");
    realFs.renameSync(target, outside);
    if (fault === "file") realFs.writeFileSync(target, "private-invalid-fact-533");
    if (fault === "symlink") realFs.symlinkSync(outside, target);
    expectReadonlyFailure(fault === "missing" ? "missing" : "directory");
    if (fault === "missing") expect(realFs.existsSync(target)).toBe(false);
  },
);
