import { inspect } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { renderReport, validateReport } from "./index.ts";
import { CHECK_SHAPE, SECRET, realFs } from "./report-validation-test-harness.ts";
import {
  CODE_CHANGE_WORDING,
  makeCodeChangeWorkspace,
  section,
  snapshotTree,
  type CodeChangeWorkspace,
} from "./report-code-change-test-harness.ts";

let workspace: CodeChangeWorkspace;
beforeEach(() => {
  workspace = makeCodeChangeWorkspace();
});
afterEach(() => {
  realFs.rmSync(workspace.root, { recursive: true, force: true });
});

function validate() {
  const before = snapshotTree(workspace.root);
  const result = validateReport(workspace.cwd, workspace.report.report_id);
  expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(CHECK_SHAPE);
  expect(snapshotTree(workspace.root)).toEqual(before);
  const diagnostics = inspect(result, { depth: null });
  expect(diagnostics).not.toContain(SECRET);
  expect(diagnostics).not.toContain(workspace.cwd);
  expect(result).not.toHaveProperty("cause");
  expect(result).not.toHaveProperty("issues");
  return result;
}

test("new canonical facts retain exactly thirteen checks without adding closure or cross-object decisions", () => {
  // File fixtures intentionally have foreign task/run references, proposed CRs,
  // differing build dirty paths and no patches, binaries or VC output artifacts.
  expect(validate()).toEqual({
    ok: true,
    checks: CHECK_SHAPE.map((check) => ({ ...check, pass: true, details: [] })),
  });
});

test.each([
  ["approval_ref", [3]],
  ["files_changed", [3]],
  ["pass_criteria", [3]],
  ["reviewed_by", [3]],
  ["reviewer_notes", [3]],
  ["failure_reason", [3, 7]],
  ["compiler", [3]],
  ["make_argv", [3]],
] as const)(
  "existing check 13 scans new %s facts without echoing the credential",
  (field, sections) => {
    const value = `private-metadata-533 ${SECRET}`;
    const approved = workspace.changes[1];
    const failed = workspace.verifications[0];
    const candidate = workspace.builds[1];
    if (field === "approval_ref") approved.approval_ref = value;
    if (field === "files_changed") approved.files_changed = [value];
    if (field === "pass_criteria") failed.pass_criteria = value;
    if (field === "reviewed_by") failed.reviewed_by = value;
    if (field === "reviewer_notes") failed.reviewer_notes = [value];
    if (field === "failure_reason") failed.failure_reason = value;
    if (field === "compiler") candidate.compiler = value;
    if (field === "make_argv") candidate.make_argv = [value];
    workspace.republish();
    const result = validate();
    expect(result.ok).toBe(false);
    expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([13]);
    expect(result.checks[12]).toEqual({
      id: 13,
      pass: false,
      vacuous: false,
      details: sections.map((section) => ({ code: "secret_detected", section })),
    });
    expect(inspect(result, { depth: null })).not.toContain("private-metadata-533");
  },
);

test("fake headings and original-looking tokens cannot change trusted sections in code-change validation", () => {
  workspace.report.limitations = [`## 5. authored heading ${SECRET}\n{{facts}} {{summary}}`];
  workspace.verifications[0].reviewer_notes = [`## 7. metadata heading\n${SECRET}`];
  workspace.republish();
  const markdown = renderReport(workspace.cwd, workspace.report.report_id);
  expect(section(markdown, 5)).toBe(CODE_CHANGE_WORDING);
  expect(section(markdown, 6)).toContain(workspace.report.limitations[0]);
  const result = validate();
  expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([13]);
  expect(result.checks[12]?.details).toEqual([
    { code: "secret_detected", section: 3 },
    { code: "secret_detected", section: 6 },
  ]);
});
