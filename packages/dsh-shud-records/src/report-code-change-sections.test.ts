import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { validateReport } from "./index.ts";
import {
  CODE_CHANGE_WORDING,
  snapshotTree,
  type CodeChangeWorkspace,
} from "./report-code-change-test-harness.ts";
import { CODE_CHANGE_CHECK_SHAPE, realFs } from "./report-validation-test-harness.ts";
import { makeCodeChangeValidationWorkspace } from "./report-validation/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
let workspace: CodeChangeWorkspace;
beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  workspace = makeCodeChangeValidationWorkspace();
});
afterEach(() => realFs.rmSync(workspace.root, { recursive: true, force: true }));

function template(token: string, value: string) {
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    if (String(args[0]).endsWith("/templates/evidence_report.md")) {
      const original = realFs.readFileSync(args[0], "utf8");
      expect(original).toContain(token);
      return original.replace(token, value);
    }
    return realFs.readFileSync(...args);
  });
}
function validate() {
  const before = snapshotTree(workspace.root);
  const result = validateReport(workspace.cwd, workspace.report.report_id);
  expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(
    CODE_CHANGE_CHECK_SHAPE,
  );
  expect(snapshotTree(workspace.root)).toEqual(before);
  return result;
}

test.each(["", "A different engineering sentence."])(
  "check 14 rejects missing or changed canonical section-5 wording (%s)",
  (replacement) => {
    workspace.report.summary = `## 5. 指标与图表\n${CODE_CHANGE_WORDING}`;
    workspace.report.pi_questions = [`## 5. 指标与图表\n${CODE_CHANGE_WORDING}`];
    workspace.republish();
    // Stale on-disk Markdown is not the validation input, even if it contains the fixed wording.
    realFs.writeFileSync(join(workspace.cwd, workspace.markdownPath), CODE_CHANGE_WORDING);
    expect(validate().checks[13].pass).toBe(true);
    template("{{metrics}}", replacement);
    const result = validate();
    expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([14]);
    expect(result.checks[13].details).toEqual([{ code: "code_change_wording_missing" }]);
  },
);

test("check 8 requires every failed VC in the owned risk section, independently of failed runs", () => {
  const failed = workspace.verifications[0];
  workspace.report.summary = `## 7. 风险和失败项\n${failed.vc_id}`;
  workspace.republish();
  expect(validate().checks[7].pass).toBe(true);
  const runRisks = workspace.fixture.runs
    .filter((run) => run.status === "failed")
    .map((run) => `${run.run_id}: ${run.exit_class}`)
    .join("\n");
  template("{{risks}}", runRisks);
  const result = validate();
  expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual([8]);
  expect(result.checks[7].details).toEqual([
    { code: "failed_verification_missing", vc_id: failed.vc_id },
  ]);
});

test("check 8 does not require a passed VC in section 7", () => {
  const passed = workspace.verifications[1];
  workspace.report.verification_ids = [passed.vc_id];
  workspace.republish();
  expect(validate().checks[7]).toEqual({ id: 8, pass: true, vacuous: false, details: [] });
});

test("code-change metadata is outside the unchanged authored forbidden-phrase scan", () => {
  workspace.changes[0].description = "普遍改进";
  workspace.verifications[0].reviewer_notes = ["模型机制已验证"];
  workspace.verifications[0].failure_reason = "无需 PI 审查";
  workspace.builds[0].compiler = "校准证明结构正确";
  workspace.republish();
  expect(validate().checks[6]).toEqual({ id: 7, pass: true, vacuous: false, details: [] });
  workspace.report.observations = ["普遍改进"];
  workspace.republish();
  expect(validate().checks[6].details).toEqual([
    { code: "forbidden_phrase", field: "observations", phrase: "普遍改进" },
  ]);
});
