import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import { validateReport, ReportValidationError, type ReportValidationResult } from "./index.ts";
import { makeReportDecision } from "./report-render-test-harness.ts";
import { renderingInputs } from "./report-workspace-test-harness.ts";
import { installUnsafe } from "./test-harness.ts";
import {
  CHECK_SHAPE,
  DIRTY_SOURCES,
  INVARIANTS,
  PRIVATE_PAYLOAD,
  SECRET,
  makeDirtyStacks,
  makeValidationWorkspace,
  realFs,
  selectInput,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";

// Proposed public contract: synchronous { ok, checks }, exactly thirteen ordered
// { id, pass, vacuous, details } entries. Details are controlled discriminated facts;
// source prose/paths/Markdown/exceptions are never diagnostic payloads. Root errors
// expose only a controlled stage, while reference failures remain check results.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

let workspace: ValidationWorkspace;

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  workspace = makeValidationWorkspace();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  realFs.rmSync(workspace.root, { recursive: true, force: true });
});

function expectPrivateAbsent(value: unknown, ...additional: string[]): void {
  const serialized = `${JSON.stringify(value)}\n${inspect(value, { depth: null })}`;
  for (const forbidden of [PRIVATE_PAYLOAD, SECRET, workspace.cwd, ...additional]) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(value).not.toHaveProperty("cause");
  expect(value).not.toHaveProperty("issues");
  expect(value).not.toHaveProperty("path");
}

function validate(): ReportValidationResult {
  const before = workspace.snapshot();
  const writes = vi.mocked(fs.writeFileSync).mock.calls.length;
  const renames = vi.mocked(fs.renameSync).mock.calls.length;
  const result = validateReport(workspace.cwd, workspace.fixture.report.report_id);
  expect(workspace.snapshot()).toStrictEqual(before);
  expect(fs.writeFileSync).toHaveBeenCalledTimes(writes);
  expect(fs.renameSync).toHaveBeenCalledTimes(renames);
  expect(
    vi
      .mocked(fs.readFileSync)
      .mock.calls.some(([path]) => String(path) === join(workspace.cwd, workspace.markdownPath)),
  ).toBe(false);
  expect(result.checks.map(({ id, vacuous }) => ({ id, vacuous }))).toEqual(CHECK_SHAPE);
  expect(result.ok).toBe(result.checks.every(({ pass }) => pass));
  for (const id of [4, 10, 11]) {
    expect(check(result, id)).toEqual({ id, pass: true, vacuous: true, details: [] });
  }
  expectPrivateAbsent(result);
  return result;
}

function check(result: ReportValidationResult, id: number) {
  const found = result.checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error("Missing required validation check");
  return found;
}

function expectFailed(result: ReportValidationResult, ids: readonly number[]): void {
  expect(result.checks.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual(ids);
  expect(result.ok).toBe(ids.length === 0);
}

function expectRenderUnavailable(result: ReportValidationResult): void {
  for (const id of [8, 9, 12, 13]) {
    expect(check(result, id)).toMatchObject({ pass: false, vacuous: false });
    const details = check(result, id).details;
    expect(details).toHaveLength(1);
    const detail = details[0];
    expect(detail?.code).toBe("render_unavailable");
    if (detail?.code !== "render_unavailable") {
      throw new Error("Expected a render-unavailable diagnostic");
    }
    expect(typeof detail.stage).toBe("string");
  }
}

function templateControl(transform: (template: string) => string): void {
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    const path = String(args[0]);
    if (path.endsWith("/templates/evidence_report.md")) {
      return transform(realFs.readFileSync(args[0], "utf8"));
    }
    return realFs.readFileSync(...args);
  });
}

function replaceTemplate(token: string, replacement: string): void {
  templateControl((template) => {
    expect(template).toContain(token);
    return template.replace(token, replacement);
  });
}

function expectRootError(stage: string, id: unknown): void {
  const before = workspace.snapshot();
  let caught: unknown;
  try {
    validateReport(workspace.cwd, id);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportValidationError);
  expect(caught).toMatchObject({ stage });
  expectPrivateAbsent(caught);
  expect(workspace.snapshot()).toStrictEqual(before);
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
}

test("returns all thirteen passing clauses, with only 4/10/11 M3-vacuous", () => {
  const result = validate();
  expect(result.checks).toEqual(
    CHECK_SHAPE.map((entry) => ({ ...entry, pass: true, details: [] })),
  );
  expect(result.ok).toBe(true);
  // A failed run is valid evidence when properly listed, not a closure veto.
  expect(workspace.fixture.runs[1].status).toBe("failed");
});

test("accepts an absolute TMPDIR log path and empty observations without reading evidence contents", () => {
  workspace.fixture.report.observations = [];
  // This path is intentionally outside the secret-shaped cwd used by other controls.
  const stdout = join(workspace.root, "stdout.log");
  workspace.fixture.runs[0].artifacts.stdout = stdout;
  realFs.writeFileSync(stdout, `${PRIVATE_PAYLOAD} ${SECRET}`);
  workspace.publishFixture();
  const allowed = new Set(
    renderingInputs(workspace.fixture).map(({ path }) => join(workspace.cwd, path)),
  );
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    const path = String(args[0]);
    if (!allowed.has(path) && !path.endsWith("/templates/evidence_report.md")) {
      throw new Error(PRIVATE_PAYLOAD);
    }
    return realFs.readFileSync(...args);
  });
  expectFailed(validate(), []);
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
});

test.each([
  "draft",
  "reviewed",
  "awaiting_pi",
  "accepted",
  "rejected",
  "revision_requested",
  "archived",
] as const)("validates %s without a status precondition or state transition", (status) => {
  workspace.fixture.report.status = status;
  if (
    status === "accepted" ||
    status === "rejected" ||
    status === "revision_requested" ||
    status === "archived"
  ) {
    workspace.fixture.report.decision_history = [
      makeReportDecision(status === "archived" ? "accepted" : status),
    ];
  }
  workspace.publishFixture();
  expectFailed(validate(), []);
});

test("does not impose additional relationships or require task/closure evidence", () => {
  workspace.fixture.runs[0].task_id = null;
  workspace.fixture.runs[0].stack_id = null;
  workspace.fixture.runs[0].data_id = null;
  workspace.publishFixture();
  expectFailed(validate(), []);
  expect(realFs.existsSync(join(workspace.cwd, "tasks"))).toBe(false);
});

describe.each([
  { kind: "stack", id: 1, field: "stack_id", prefix: "STACK" },
  { kind: "data", id: 2, field: "data_id", prefix: "DATA" },
  { kind: "run", id: 3, field: "run_id", prefix: "RUN" },
] as const)("$kind reference failures", ({ kind, id, field, prefix }) => {
  test.each(["missing", "parse", "schema", "identity", "read"] as const)(
    "reports %s without aborting any of the thirteen clauses",
    (stage) => {
      const input = selectInput(workspace, kind);
      const target = join(workspace.cwd, input.path);
      if (stage === "missing") realFs.unlinkSync(target);
      if (stage === "parse") realFs.writeFileSync(target, `{${PRIVATE_PAYLOAD} ${SECRET}`);
      if (stage === "schema")
        workspace.publish(input.path, { payload: `${PRIVATE_PAYLOAD} ${SECRET}` });
      if (stage === "identity")
        workspace.publish(input.path, {
          ...input.value,
          [field]: `${prefix}-20261029T090000-f003`,
        });
      if (stage === "read")
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (String(args[0]) === target) throw new Error(`${PRIVATE_PAYLOAD} ${SECRET}`);
          return realFs.readFileSync(...args);
        });
      const result = validate();
      expectFailed(result, [id, 8, 9, 12, 13]);
      expect(check(result, id).details).toEqual([
        {
          code: "reference_unavailable",
          kind,
          id:
            kind === "stack"
              ? workspace.fixture.stacks[0].stack_id
              : kind === "data"
                ? workspace.fixture.data[0].data_id
                : workspace.fixture.runs[0].run_id,
          stage,
        },
      ]);
      expectRenderUnavailable(result);
      if (stage === "missing") expect(realFs.existsSync(target)).toBe(false);
    },
  );

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s target before reading and preserves outside evidence",
    (unsafe) => {
      const input = selectInput(workspace, kind);
      const target = join(workspace.cwd, input.path);
      const outside = join(workspace.root, "outside.json");
      realFs.writeFileSync(outside, `${PRIVATE_PAYLOAD} ${SECRET}`);
      const before = {
        bytes: realFs.readFileSync(outside),
        mtime: realFs.statSync(outside).mtimeMs,
      };
      realFs.unlinkSync(target);
      installUnsafe(target, unsafe, outside);
      vi.clearAllMocks();
      const result = validate();
      expectFailed(result, [id, 8, 9, 12, 13]);
      expect(check(result, id).details).toEqual([
        expect.objectContaining({ code: "reference_unavailable", kind, stage: "target" }),
      ]);
      expectRenderUnavailable(result);
      expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => String(path) === target)).toBe(
        false,
      );
      expect(realFs.readFileSync(outside)).toEqual(before.bytes);
      expect(realFs.statSync(outside).mtimeMs).toBe(before.mtime);
    },
  );
});

test("collects every reference failure and authored failure in the same thirteen-result response", () => {
  for (const { path, kind } of renderingInputs(workspace.fixture)) {
    if (kind !== "report") realFs.unlinkSync(join(workspace.cwd, path));
  }
  workspace.fixture.report.summary = `${PRIVATE_PAYLOAD} 普遍改进 ${SECRET}`;
  workspace.fixture.report.limitations = [];
  workspace.fixture.report.pi_questions = [];
  workspace.publish(workspace.reportPath, workspace.fixture.report);
  const result = validate();
  expectFailed(result, [1, 2, 3, 5, 6, 7, 8, 9, 12, 13]);
  for (const id of [1, 2, 3]) expect(check(result, id).details).toHaveLength(2);
  expect(check(result, 7).details).toEqual([
    { code: "forbidden_phrase", field: "summary", phrase: "普遍改进" },
  ]);
  expectRenderUnavailable(result);
});

test.each([
  { directory: "stacks", id: 1 },
  { directory: "provenance", id: 2 },
  { directory: "runs", id: 3 },
  { directory: "runs/RUN-20261029T080000-b002", id: 3 },
])("rejects unsafe $directory without treating outside evidence as local", ({ directory, id }) => {
  const target = join(workspace.cwd, directory);
  const outside = join(workspace.root, "outside-directory");
  realFs.renameSync(target, outside);
  realFs.symlinkSync(outside, target);
  const result = validate();
  expectFailed(result, [id, 8, 9, 12, 13]);
  expect(check(result, id).details).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "reference_unavailable", stage: "directory" }),
    ]),
  );
});

test.each(["runs", "runs/RUN-20261029T080000-b002"])(
  "does not recreate missing %s or discover alternate run records",
  (directory) => {
    realFs.rmSync(join(workspace.cwd, directory), { recursive: true });
    workspace.publish("elsewhere/run-record.json", workspace.fixture.runs[0]);
    const result = validate();
    expectFailed(result, [3, 8, 9, 12, 13]);
    expectRenderUnavailable(result);
    expect(realFs.existsSync(join(workspace.cwd, directory))).toBe(false);
    expect(fs.readdirSync).not.toHaveBeenCalled();
  },
);

test.each([
  { field: "limitations", id: 5 },
  { field: "pi_questions", id: 6 },
] as const)("requires a nonempty $field array independently", ({ field, id }) => {
  workspace.fixture.report[field] = [];
  workspace.publishFixture();
  const result = validate();
  expectFailed(result, [id]);
  expect(check(result, id).details).toEqual([{ code: "empty_field", field }]);
});

test.each(["summary", "observations", "limitations", "pi_questions"] as const)(
  "reports overlapping forbidden phrases in %s without echoing authored prose",
  (field) => {
    const text = `${PRIVATE_PAYLOAD} 无需 PI 审查即可接受该物理变更 无需 PI 审查`;
    if (field === "summary") workspace.fixture.report.summary = text;
    else workspace.fixture.report[field] = ["Safe first entry.", text, text];
    workspace.publishFixture();
    const result = validate();
    expectFailed(result, [7]);
    expect(check(result, 7).details).toEqual([
      { code: "forbidden_phrase", field, phrase: "无需 PI 审查" },
      { code: "forbidden_phrase", field, phrase: "无需 PI 审查即可接受该物理变更" },
    ]);
    expectPrivateAbsent(result, text);
  },
);

test.each([
  "模型机制已验证",
  "普遍改进",
  "校准证明结构正确",
  "该参数就是真实物理原因",
  "无需 PI 审查",
  "校准证明模型结构正确",
  "verification 通过说明物理机制真实",
  "该公式已经被模型结果证明",
  "参数搜索确认了理论假设",
])("uses the enumerated authored phrase %s", (phrase) => {
  workspace.fixture.report.summary = `${PRIVATE_PAYLOAD} ${phrase}`;
  workspace.publishFixture();
  expect(check(validate(), 7).details).toEqual([
    { code: "forbidden_phrase", field: "summary", phrase },
  ]);
});

test("scans only authored fields, not structured metadata or template-owned invariant sentences", () => {
  workspace.fixture.stacks[0].repos.SHUD.branch = "普遍改进";
  workspace.fixture.data[0].basin = "模型机制已验证";
  workspace.fixture.runs[0].llm.response_model = "无需 PI 审查";
  workspace.fixture.report.observations = ["普遍", "改进", "在该 basin/event/window 下该指标改善"];
  workspace.publishFixture();
  expectFailed(validate(), []);
});

test("does not exempt copied governance sentences in authored prose", () => {
  workspace.fixture.report.summary = "不得宣称模型机制已验证";
  workspace.publishFixture();
  const result = validate();
  expectFailed(result, [7]);
  expect(check(result, 7).details).toEqual([
    { code: "forbidden_phrase", field: "summary", phrase: "模型机制已验证" },
  ]);
});

test("requires every failed run in real section 7, not an authored fake heading", () => {
  workspace.fixture.runs[0].status = "failed";
  workspace.fixture.runs[0].exit_code = null;
  workspace.fixture.runs[0].exit_class = "lost";
  workspace.fixture.report.summary =
    "## 7. 风险和失败项\n- RUN-20261029T080000-b002: lost\n- RUN-20261029T080000-a001: cvode";
  workspace.publishFixture();
  expectFailed(validate(), []);
  replaceTemplate("{{risks}}", "None.");
  const result = validate();
  expectFailed(result, [8]);
  expect(check(result, 8).details).toEqual([
    { code: "failed_run_missing", run_id: "RUN-20261029T080000-b002" },
    { code: "failed_run_missing", run_id: "RUN-20261029T080000-a001" },
  ]);
  replaceTemplate("{{risks}}", "- RUN-20261029T080000-b002: lost");
  expect(check(validate(), 8).details).toEqual([
    { code: "failed_run_missing", run_id: "RUN-20261029T080000-a001" },
  ]);
});

test("does not invent failure evidence when all linked runs succeeded", () => {
  workspace.fixture.report.linked_runs = [workspace.fixture.runs[0].run_id];
  workspace.publishFixture();
  replaceTemplate("{{risks}}", "None.");
  expectFailed(validate(), []);
});

describe("dirty annotations belong to the cited stack and repository", () => {
  test.each([
    { repository: "SHUD", annotation: "- SHUD dirty_path: src/a.cpp\n" },
    { repository: "SHUD", annotation: "- SHUD dirty_path: src/z.cpp\n" },
    { repository: "rSHUD", annotation: "- rSHUD dirty_path: R/a.R\n" },
    { repository: "AutoSHUD", annotation: "- AutoSHUD dirty_path: scripts/a.R\n" },
  ])("requires each $repository recorded path ($annotation)", ({ repository, annotation }) => {
    makeDirtyStacks(workspace);
    replaceTemplate("{{sources}}", DIRTY_SOURCES);
    expectFailed(validate(), []);
    replaceTemplate("{{sources}}", DIRTY_SOURCES.replace(annotation, ""));
    const result = validate();
    expectFailed(result, [9]);
    expect(check(result, 9).details).toEqual([
      { code: "dirty_annotation_missing", stack_id: "STACK-20261029T080000-b002", repository },
    ]);
  });

  test.each(["SHUD", "rSHUD", "AutoSHUD"] as const)(
    "requires the true dirty flag for %s",
    (repository) => {
      makeDirtyStacks(workspace);
      replaceTemplate("{{sources}}", DIRTY_SOURCES);
      expectFailed(validate(), []);
      const rows = DIRTY_SOURCES.split("\n");
      const row = rows.find((line) => line.startsWith(`| ${repository} |`));
      if (row === undefined) throw new Error("Missing independent dirty row");
      replaceTemplate(
        "{{sources}}",
        DIRTY_SOURCES.replace(row, row.replace("| true |", "| false |")),
      );
      const result = validate();
      expectFailed(result, [9]);
      expect(check(result, 9).details).toEqual([
        { code: "dirty_annotation_missing", stack_id: "STACK-20261029T080000-b002", repository },
      ]);
    },
  );

  test("another StackLock or authored block cannot supply a missing own-stack annotation", () => {
    makeDirtyStacks(workspace);
    workspace.fixture.report.summary = `## 3. StackLock 与数据来源\n${DIRTY_SOURCES}`;
    workspace.publishFixture();
    replaceTemplate(
      "{{sources}}",
      DIRTY_SOURCES.slice(DIRTY_SOURCES.indexOf("### StackLock STACK-20261029T080000-a001")),
    );
    const result = validate();
    expectFailed(result, [9]);
    expect(check(result, 9).details).toEqual([
      {
        code: "dirty_annotation_missing",
        stack_id: "STACK-20261029T080000-b002",
        repository: "SHUD",
      },
      {
        code: "dirty_annotation_missing",
        stack_id: "STACK-20261029T080000-b002",
        repository: "rSHUD",
      },
      {
        code: "dirty_annotation_missing",
        stack_id: "STACK-20261029T080000-b002",
        repository: "AutoSHUD",
      },
    ]);
  });

  test("accepts schema-valid dirty empty paths only when its own repository row is true", () => {
    workspace.fixture.stacks[0].repos.SHUD.dirty_paths = [];
    workspace.publishFixture();
    expectFailed(validate(), []);
    replaceTemplate(
      "{{sources}}",
      DIRTY_SOURCES.replace("| main | true | false |", "| main | false | false |"),
    );
    const result = validate();
    expectFailed(result, [9]);
    expect(check(result, 9).details).toEqual([
      {
        code: "dirty_annotation_missing",
        stack_id: "STACK-20261029T080000-b002",
        repository: "SHUD",
      },
    ]);
  });

  test("matches encoded recorded paths without leaking raw metadata in diagnostics", () => {
    workspace.fixture.stacks[0].repos.SHUD.dirty_paths = ["src/a&<>|`\\\r\n.cpp"];
    workspace.publishFixture();
    expectFailed(validate(), []);
    replaceTemplate("{{sources}}", "");
    const result = validate();
    expectFailed(result, [9]);
    expectPrivateAbsent(result, "src/a&<>|`\\\r\n.cpp");
  });
});

test.each(INVARIANTS)("detects the individual missing invariant %s", (missing) => {
  replaceTemplate(
    "{{invariants}}",
    INVARIANTS.filter((sentence) => sentence !== missing).join("\n"),
  );
  const result = validate();
  expectFailed(result, [12]);
  expect(check(result, 12).details).toEqual([{ code: "invariant_missing", invariant: missing }]);
});

test("invariant presence is literal whole-document presence, not template attestation", () => {
  workspace.fixture.report.summary = INVARIANTS[0];
  workspace.publishFixture();
  replaceTemplate("{{invariants}}", INVARIANTS.slice(1).join("\n"));
  expectFailed(validate(), []);
});

test.each([
  { field: "summary", section: 1 },
  { field: "observations", section: 6 },
  { field: "limitations", section: 6 },
  { field: "pi_questions", section: 8 },
] as const)(
  "reports only numeric section $section for a secret in $field",
  ({ field, section }) => {
    const text = `${PRIVATE_PAYLOAD} ${SECRET}`;
    if (field === "summary") workspace.fixture.report.summary = text;
    else workspace.fixture.report[field] = [text];
    workspace.publishFixture();
    const result = validate();
    expectFailed(result, [13]);
    expect(check(result, 13).details).toEqual([{ code: "secret_detected", section }]);
  },
);

test.each([
  { field: "branch", sections: [3] },
  { field: "base_url", sections: [3] },
  { field: "basin", sections: [3] },
  { field: "model", sections: [4] },
  { field: "stdout", sections: [4, 10] },
  { field: "argv", sections: [10] },
  { field: "artifact", sections: [10] },
] as const)("scans rendered $field metadata without echoing it", ({ field, sections }) => {
  const value = `${PRIVATE_PAYLOAD} ${SECRET}`;
  if (field === "branch") workspace.fixture.stacks[0].repos.SHUD.branch = value;
  if (field === "base_url") workspace.fixture.stacks[0].llm.base_url = value;
  if (field === "basin") workspace.fixture.data[0].basin = value;
  if (field === "model") workspace.fixture.runs[0].llm.response_model = value;
  if (field === "stdout") workspace.fixture.runs[0].artifacts.stdout = value;
  if (field === "argv") workspace.fixture.runs[0].command = [value];
  if (field === "artifact") {
    const artifact = workspace.fixture.runs[0].artifacts.files[0];
    if (artifact === undefined) throw new Error("Missing artifact test input");
    artifact.path = value;
  }
  workspace.publishFixture();
  const result = validate();
  expectFailed(result, [13]);
  expect(check(result, 13).details).toEqual(
    sections.map((section) => ({ code: "secret_detected", section })),
  );
});

test.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
  "scans template literal content in section %i, including header and appendix",
  (section) => {
    templateControl((template) =>
      section === 0
        ? `${SECRET}\n${template}`
        : template.replace(new RegExp(`(## ${section}\\. [^\\n]*\\n)`), `$1\n${SECRET}\n`),
    );
    const result = validate();
    expectFailed(result, [13]);
    expect(check(result, 13).details).toEqual([{ code: "secret_detected", section }]);
  },
);

test("attributes every hit to trusted origins, never an authored secret-bearing fake heading", () => {
  workspace.fixture.report.summary = `## 7. ${PRIVATE_PAYLOAD} ${SECRET}\n${SECRET}`;
  workspace.fixture.report.observations = [`## 10. ${PRIVATE_PAYLOAD}\n${SECRET}`];
  workspace.fixture.report.pi_questions = [SECRET];
  workspace.fixture.runs[0].artifacts.stdout = SECRET;
  workspace.publishFixture();
  templateControl((template) => `${SECRET}\n${template.replace("下一步等待 PI 判断。", SECRET)}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = validate();
    expectFailed(result, [13]);
    expect(check(result, 13).details).toEqual([
      { code: "secret_detected", section: 0 },
      { code: "secret_detected", section: 1 },
      { code: "secret_detected", section: 4 },
      { code: "secret_detected", section: 6 },
      { code: "secret_detected", section: 8 },
      { code: "secret_detected", section: 9 },
      { code: "secret_detected", section: 10 },
    ]);
  }
});

test.each([
  ["sk", "1234567"].join("-"),
  ["SK", "abcdefgh12345678"].join("-"),
  `x${SECRET}`,
  `_${SECRET}`,
  ["sk", "1234.5678"].join("-"),
])("retains exact core regex negative semantics for %s", (candidate) => {
  workspace.fixture.report.summary = candidate;
  workspace.publishFixture();
  expectFailed(validate(), []);
});

test("freshly rereads each evidence class and has no retained regex state", () => {
  for (const kind of ["report", "stack", "data", "run"] as const) {
    expectFailed(validate(), []);
    const input = selectInput(workspace, kind);
    const original = structuredClone(input.value);
    if (kind === "report") workspace.fixture.report.summary = SECRET;
    if (kind === "stack") workspace.fixture.stacks[0].llm.request_alias = SECRET;
    if (kind === "data") workspace.fixture.data[0].basin = SECRET;
    if (kind === "run") workspace.fixture.runs[0].command = [SECRET];
    workspace.publishFixture();
    expectFailed(validate(), [13]);
    expectFailed(validate(), [13]);
    Object.assign(input.value, original);
    workspace.publishFixture();
    expectFailed(validate(), []);
  }
});

test.each(["read", "unknown-token", "decision_history"] as const)(
  "fails all rendered-content checks closed for %s without stale Markdown fallback",
  (fault) => {
    if (fault === "read")
      templateControl(() => {
        throw new Error(`${PRIVATE_PAYLOAD} ${SECRET}`);
      });
    if (fault === "unknown-token") replaceTemplate("{{risks}}", "{{not_a_template_field}}");
    if (fault === "decision_history") {
      workspace.fixture.report.status = "accepted";
      workspace.fixture.report.decision_history = [];
      workspace.publishFixture();
    }
    const result = validate();
    expectFailed(result, [8, 9, 12, 13]);
    expectRenderUnavailable(result);
  },
);

test.each([
  undefined,
  null,
  441,
  "../reports/escape",
  "REPORT-not-an-id",
  SECRET,
  { toString: () => "REPORT-20261027T080005-3f9c" },
])("rejects malformed routing %j before filesystem access without echoing it", (id) => {
  expectRootError("id", id);
  for (const operation of [
    fs.readFileSync,
    fs.lstatSync,
    fs.readdirSync,
    fs.mkdirSync,
    fs.openSync,
  ]) {
    expect(operation).not.toHaveBeenCalled();
  }
});

test.each(["missing", "parse", "schema", "identity", "read"] as const)(
  "throws a controlled %s root-request error without source paths, prose, causes or issues",
  (stage) => {
    const target = join(workspace.cwd, workspace.reportPath);
    if (stage === "missing") realFs.unlinkSync(target);
    if (stage === "parse") realFs.writeFileSync(target, `{${PRIVATE_PAYLOAD} ${SECRET}`);
    if (stage === "schema")
      workspace.publish(workspace.reportPath, { summary: `${PRIVATE_PAYLOAD} ${SECRET}` });
    if (stage === "identity")
      workspace.publish(workspace.reportPath, {
        ...workspace.fixture.report,
        report_id: ReportIdSchema.parse("REPORT-20261029T090000-f003"),
      });
    if (stage === "read")
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        if (String(args[0]) === target)
          throw Object.assign(new Error(`${PRIVATE_PAYLOAD} ${SECRET}`), {
            cause: { path: workspace.cwd },
          });
        return realFs.readFileSync(...args);
      });
    expectRootError(stage, workspace.fixture.report.report_id);
    if (stage === "missing") expect(realFs.existsSync(target)).toBe(false);
  },
);

test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
  "rejects a root %s before reading its bytes",
  (unsafe) => {
    const target = join(workspace.cwd, workspace.reportPath);
    const outside = join(workspace.root, "outside.json");
    realFs.writeFileSync(outside, `${PRIVATE_PAYLOAD} ${SECRET}`);
    realFs.unlinkSync(target);
    installUnsafe(target, unsafe, outside);
    vi.clearAllMocks();
    expectRootError("target", workspace.fixture.report.report_id);
    expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => String(path) === target)).toBe(
      false,
    );
  },
);

test("does not create Markdown when none exists", () => {
  realFs.unlinkSync(join(workspace.cwd, workspace.markdownPath));
  expectFailed(validate(), []);
  expect(realFs.existsSync(join(workspace.cwd, workspace.markdownPath))).toBe(false);
});

test.each(["symlink", "dangling-link", "file", "fifo"] as const)(
  "rejects a %s reports directory with a stage-only root error",
  (unsafe) => {
    const target = join(workspace.cwd, "reports");
    const outside = join(workspace.root, "outside-reports");
    realFs.renameSync(target, outside);
    const original = [
      `${workspace.fixture.report.report_id}.json`,
      `${workspace.fixture.report.report_id}.md`,
    ].map((name) => {
      const path = join(outside, name);
      return { path, bytes: realFs.readFileSync(path), mtime: realFs.statSync(path).mtimeMs };
    });
    installUnsafe(target, unsafe, outside);
    vi.clearAllMocks();
    expectRootError("directory", workspace.fixture.report.report_id);
    for (const file of original) {
      expect(realFs.readFileSync(file.path)).toEqual(file.bytes);
      expect(realFs.statSync(file.path).mtimeMs).toBe(file.mtime);
    }
  },
);

test.each([
  ["sk", "12345678"].join("-"),
  ["sk", "ABcd_9-z"].join("-"),
  `(${SECRET})`,
  `中${SECRET}`,
])("uses exact core regex positive boundaries for %s", (candidate) => {
  workspace.fixture.report.summary = candidate;
  workspace.publishFixture();
  const result = validate();
  expectFailed(result, [13]);
  expect(check(result, 13).details).toEqual([{ code: "secret_detected", section: 1 }]);
  expectPrivateAbsent(result, candidate);
});
