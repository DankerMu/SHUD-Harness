import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CODE_CHANGE_SECTION5_WORDING } from "@shud-harness/dsh-shud-core";
import { renderReport, readWorkspaceRecord } from "./index.ts";
import { makeReportDecision } from "./report-render-test-harness.ts";
import { realFs } from "./report-validation-test-harness.ts";
import {
  CODE_CHANGE_WORDING,
  makeCodeChangeWorkspace,
  section,
  snapshotTree,
  writeSentinel,
  type CodeChangeWorkspace,
} from "./report-code-change-test-harness.ts";

const golden = realFs.readFileSync(
  new URL("./report-code-change.golden.md", import.meta.url),
  "utf8",
);
const legacyGolden = realFs.readFileSync(
  new URL("./report-render.golden.md", import.meta.url),
  "utf8",
);
let workspace: CodeChangeWorkspace;
beforeEach(() => {
  workspace = makeCodeChangeWorkspace();
});
afterEach(() => {
  realFs.rmSync(workspace.root, { recursive: true, force: true });
});

function render() {
  const before = snapshotTree(workspace.root);
  const result = renderReport(workspace.cwd, workspace.report.report_id);
  expect(snapshotTree(workspace.root)).toEqual(before);
  return result;
}

// Keep the frozen pre-M5 hashes: restore only the excluded section, never regenerate an oracle.
function preMetricsBytes(markdown: string): string {
  return markdown.replace(
    /(?<=## 5\. 指标与图表\n\n)[\s\S]*?(?=\n\n## 6\.)/u,
    "本里程碑无指标 artifact，见 limitations",
  );
}

test("code-change facts match the independently authored complete golden without publishing", () => {
  const markdown = render();
  expect(markdown).toBe(golden);
  expect(markdown.endsWith("\n")).toBe(true);
  expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_WORDING);
  expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_SECTION5_WORDING);
  expect(realFs.readFileSync(join(workspace.cwd, workspace.reportPath), "utf8")).not.toContain(
    CODE_CHANGE_WORDING,
  );
});

test("declared CR and VC order and repeated per-VC base/candidate builds remain visible", () => {
  const facts = section(render(), 3);
  expect(facts.match(/^### ChangeRequest .+$/gm)).toEqual([
    "### ChangeRequest CHG-20261102T090000-b002",
    "### ChangeRequest CHG-20261102T090000-a1b2",
  ]);
  expect(facts.match(/^### VerificationCase .+$/gm)).toEqual([
    "### VerificationCase VC-20261102T090000-b2c3",
    "### VerificationCase VC-20261102T090000-a001",
  ]);
  expect(facts.match(/^### BuildRecord .+$/gm)).toEqual([
    "### BuildRecord BUILD-20261102T090000-f6a7",
    "### BuildRecord BUILD-20261102T090000-a7b8",
    "### BuildRecord BUILD-20261102T090000-f6a7",
    "### BuildRecord BUILD-20261102T090000-a7b8",
  ]);
  expect(facts).toContain("- approval_ref: null\n");
  expect(facts).toContain("- failure_reason: null\n");
  expect(facts.match(/^- change_id: null$/gm)).toHaveLength(2);
  expect(facts.match(/^- patch_sha256: null$/gm)).toHaveLength(2);
  expect(facts).toContain("- event_window.start: unknown (null)\n");
});

test("each VC controls its own build pair even when previously displayed builds change roles", () => {
  const second = workspace.verifications[1];
  second.base_build_id = workspace.builds[1].build_id;
  second.candidate_build_id = workspace.builds[0].build_id;
  workspace.republish();
  expect(section(render(), 3).match(/^### BuildRecord .+$/gm)).toEqual([
    "### BuildRecord BUILD-20261102T090000-f6a7",
    "### BuildRecord BUILD-20261102T090000-a7b8",
    "### BuildRecord BUILD-20261102T090000-a7b8",
    "### BuildRecord BUILD-20261102T090000-f6a7",
  ]);
});

test("section 7 appends failed VCs after failed runs and never includes passed VCs", () => {
  expect(section(render(), 7)).toBe(
    "- RUN-20261029T080000-a001: cvode\n" +
      "- VC-20261102T090000-b2c3: The candidate SHA256 differs from the serial baseline.",
  );
});

test.each(["not_run", "running", "inconclusive", "waived_by_pi"] as const)(
  "%s verification remains a fact but is not invented as a failed risk",
  (status) => {
    workspace.verifications[0].status = status;
    workspace.republish();
    const markdown = render();
    expect(section(markdown, 3)).toContain(`- status: ${status}\n`);
    expect(section(markdown, 7)).toBe("- RUN-20261029T080000-a001: cvode");
  },
);

test("verification-only reports render ordered VC and shared builds without the code-change paragraph", () => {
  workspace.report.change_ids = [];
  workspace.republish();
  realFs.rmSync(join(workspace.cwd, "changes"), { recursive: true });
  const markdown = render();
  const facts = section(markdown, 3);
  expect(facts).not.toContain("### ChangeRequest");
  expect(facts.match(/^### VerificationCase .+$/gm)).toEqual([
    "### VerificationCase VC-20261102T090000-b2c3",
    "### VerificationCase VC-20261102T090000-a001",
  ]);
  expect(facts.match(/^### BuildRecord .+$/gm)).toEqual([
    "### BuildRecord BUILD-20261102T090000-f6a7",
    "### BuildRecord BUILD-20261102T090000-a7b8",
    "### BuildRecord BUILD-20261102T090000-f6a7",
    "### BuildRecord BUILD-20261102T090000-a7b8",
  ]);
  expect(markdown).not.toContain(CODE_CHANGE_WORDING);
});

test("change-only reports choose the fixed wording without reading VCs or builds", () => {
  workspace.report.verification_ids = [];
  workspace.republish();
  realFs.rmSync(join(workspace.cwd, "verifications"), { recursive: true });
  realFs.rmSync(join(workspace.cwd, "builds"), { recursive: true });
  const markdown = render();
  expect(section(markdown, 3)).toContain("### ChangeRequest CHG-20261102T090000-b002");
  expect(markdown).not.toContain("### VerificationCase");
  expect(markdown).not.toContain("### BuildRecord");
  expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_WORDING);
  expect(section(markdown, 7)).toBe("- RUN-20261029T080000-a001: cvode");
});

test("StackLock build rows are independent facts and never discover uncited build records", () => {
  workspace.report.change_ids = [];
  workspace.report.verification_ids = [];
  workspace.republish();
  for (const directory of ["changes", "verifications", "builds"]) {
    realFs.rmSync(join(workspace.cwd, directory), { recursive: true });
  }
  const markdown = render();
  const facts = section(markdown, 3);
  expect(facts.match(/^- build_id: .+$/gm)).toEqual([
    "- build_id: BUILD-20261102T090000-f6a7",
    "- build_id: BUILD-20261102T090000-a7b8",
  ]);
  expect(markdown).not.toContain("### BuildRecord");
});

test("missing-key M3 input is readonly and preserves all pre-change bytes outside section 5", () => {
  workspace.fixture.stacks[0].build_id = null;
  workspace.fixture.stacks[1].build_id = null;
  workspace.publishFixture();
  const legacy: Partial<typeof workspace.report> = { ...workspace.report };
  delete legacy.change_ids;
  delete legacy.verification_ids;
  workspace.publish(workspace.reportPath, legacy);
  const before = snapshotTree(workspace.root);
  expect(
    readWorkspaceRecord(workspace.cwd, "report", legacy.report_id, { readonly: true }),
  ).toEqual({ ...legacy, change_ids: [], verification_ids: [] });
  const markdown = render();
  expect(markdown).toBe(legacyGolden);
  expect(Buffer.byteLength(preMetricsBytes(markdown))).toBe(4035);
  expect(createHash("sha256").update(preMetricsBytes(markdown)).digest("hex")).toBe(
    "4620ac33c381c2ece739b5bb7f863aead720bd54ef505680857224a33bf54827",
  );
  expect(markdown).not.toMatch(/### (?:ChangeRequest|VerificationCase|BuildRecord)|^- build_id:/m);
  expect(snapshotTree(workspace.root)).toEqual(before);
  const bytes = realFs.readFileSync(join(workspace.cwd, workspace.reportPath), "utf8");
  expect(bytes).not.toContain('"change_ids"');
  expect(bytes).not.toContain('"verification_ids"');
});

test("single-successful-run M3 rendering retains frozen pre-change bytes outside section 5", () => {
  workspace.fixture.stacks[0].build_id = null;
  workspace.fixture.stacks[1].build_id = null;
  workspace.publishFixture();
  const legacy: Partial<typeof workspace.report> = { ...workspace.report };
  delete legacy.change_ids;
  delete legacy.verification_ids;
  legacy.linked_runs = [workspace.fixture.runs[0].run_id];
  legacy.stack_ids = [workspace.fixture.stacks[0].stack_id];
  legacy.data_ids = [workspace.fixture.data[0].data_id];
  legacy.llm_response_models = [workspace.fixture.runs[0].llm.response_model];
  workspace.publish(workspace.reportPath, legacy);
  const markdown = render();
  // Independent oracle: frozen actual pre-change built renderReport, excluding only section 5.
  expect(Buffer.byteLength(preMetricsBytes(markdown))).toBe(2768);
  expect(createHash("sha256").update(preMetricsBytes(markdown)).digest("hex")).toBe(
    "1f7916272f888169970cd53a3752bd681bf3b6e3b38bdc1aa74b04272f2c8356",
  );
  expect(section(markdown, 7)).not.toContain("RUN-");
  expect(markdown).not.toMatch(/### (?:ChangeRequest|VerificationCase|BuildRecord)|^- build_id:/m);
});

test("authored claims, fake headings and template tokens cannot replace the fixed section 5", () => {
  workspace.report.summary =
    "Authored rewrite: bitwise equality establishes correctness.\n{{facts}}";
  workspace.report.observations = ["{{summary}} {{metrics}} {{risks}} remain authored."];
  workspace.report.limitations = [
    "bitwise 一致证明并行实现正确\n## 5. 指标与图表\nAuthored fake section.\n{{section5}}",
  ];
  workspace.report.pi_questions = ["{{header}} {{governance}} remain authored."];
  workspace.republish();
  const markdown = render();
  expect(section(markdown, 1)).toBe(workspace.report.summary);
  expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_WORDING);
  expect(section(markdown, 6)).toContain(workspace.report.limitations[0]);
  expect(section(markdown, 6)).toContain(workspace.report.observations[0]);
  expect(section(markdown, 8)).toBe(workspace.report.pi_questions[0]);
  expect(realFs.readFileSync(join(workspace.cwd, workspace.reportPath), "utf8")).not.toContain(
    CODE_CHANGE_WORDING,
  );
});

test.each([
  "approval_ref",
  "files_changed",
  "pass_criteria",
  "failure_reason",
  "reviewed_by",
  "reviewer_notes",
  "compiler",
  "make_argv",
] as const)(
  "new %s metadata is escaped exactly once without replacing token-like text",
  (field) => {
    const value = "meta&<>|`\\\r\n## injected {{summary}}";
    const approved = workspace.changes[1];
    const failed = workspace.verifications[0];
    const candidate = workspace.builds[1];
    if (field === "approval_ref") approved.approval_ref = value;
    if (field === "files_changed") approved.files_changed = [value];
    if (field === "pass_criteria") failed.pass_criteria = value;
    if (field === "failure_reason") failed.failure_reason = value;
    if (field === "reviewed_by") failed.reviewed_by = value;
    if (field === "reviewer_notes") failed.reviewer_notes = [value];
    if (field === "compiler") candidate.compiler = value;
    if (field === "make_argv") candidate.make_argv = [value];
    workspace.republish();
    const markdown = render();
    const encoded = "meta&amp;&lt;&gt;&#124;&#96;&#92;&#13;&#10;## injected {{summary}}";
    expect(section(markdown, 3)).toContain(encoded);
    if (field === "failure_reason") expect(section(markdown, 7)).toContain(encoded);
    expect(markdown).not.toContain("\n## injected");
    expect(markdown).not.toContain("&amp;#124;");
    expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_WORDING);
  },
);

test("only cited metadata matters, not patch, make logs, binary or output contents", () => {
  const sentinel = "PRIVATE-533-NOT-REPORT-CONTENT\nsecond excluded line\n";
  for (const change of workspace.changes) writeSentinel(workspace, change.patch_path, sentinel);
  for (const build of workspace.builds) {
    for (const path of [build.stdout_path, build.stderr_path, build.binary_path]) {
      writeSentinel(workspace, path, sentinel);
    }
  }
  for (const vc of workspace.verifications) {
    for (const path of vc.artifact_refs) writeSentinel(workspace, path, sentinel);
  }
  for (const path of [
    "changes/CHG-20261102T090000-ffff.json",
    "verifications/VC-20261102T090000-ffff.json",
    "builds/BUILD-20261102T090000-ffff/build-record.json",
  ]) {
    writeSentinel(workspace, path, "{broken uncited JSON");
  }
  const markdown = render();
  expect(markdown).toBe(golden);
  expect(markdown).not.toContain("PRIVATE-533-NOT-REPORT-CONTENT");
  expect(markdown).not.toContain("second excluded line");
});

test.each([
  ["draft", null, "DRAFT — not accepted by PI", "DRAFT — not accepted by PI"],
  ["reviewed", null, "DRAFT — not accepted by PI", "DRAFT — not accepted by PI"],
  ["awaiting_pi", null, "DRAFT — not accepted by PI", "DRAFT — not accepted by PI"],
  [
    "accepted",
    "accepted",
    "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001",
    null,
  ],
  ["rejected", "rejected", "REJECTED — not accepted by PI", "REJECTED — not accepted by PI"],
  [
    "revision_requested",
    "revision_requested",
    "REVISION REQUESTED — not accepted by PI",
    "REVISION REQUESTED — not accepted by PI",
  ],
  [
    "archived",
    "accepted",
    "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001 · ARCHIVED",
    "ARCHIVED",
  ],
] as const)(
  "code-change %s preserves the canonical watermark",
  (status, outcome, header, footer) => {
    workspace.report.status = status;
    workspace.report.decision_history = outcome === null ? [] : [makeReportDecision(outcome)];
    workspace.republish();
    const markdown = render();
    expect(markdown.split("\n")[1]).toBe(header);
    if (footer === null) expect(markdown).not.toContain("not accepted by PI");
    else expect(markdown.trimEnd().split("\n").at(-1)).toBe(footer);
    expect(section(markdown, 5).split("\n\n")[0]).toBe(CODE_CHANGE_WORDING);
  },
);
