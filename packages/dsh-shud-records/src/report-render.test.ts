import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EvidenceReportSchema,
  RunRecordSchema,
  ReportIdSchema,
  type PiGateDecision,
} from "@shud-harness/dsh-shud-core";
import { renderReport, ReportRenderError } from "./index.ts";
import { makeReportDecision } from "./report-render-test-harness.ts";
import {
  makeRenderingFixture,
  renderingInputs,
  runRelativePath,
  type RenderingFixture,
} from "./report-workspace-test-harness.ts";
import { installUnsafe } from "./test-harness.ts";

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
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const golden = realFs.readFileSync(new URL("./report-render.golden.md", import.meta.url), "utf8");
const privatePayload = "private-untrusted-source-payload-440";
let root: string;
let cwd: string;
let fixture: RenderingFixture;

function publish(relative: string, value: unknown): void {
  const path = join(cwd, relative);
  realFs.mkdirSync(dirname(path), { recursive: true });
  realFs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function reportPath(): string {
  return `reports/${fixture.report.report_id}.json`;
}

function preserveInputs() {
  return renderingInputs(fixture).flatMap(({ path }) => {
    const absolute = join(cwd, path);
    if (!realFs.existsSync(absolute) || !realFs.lstatSync(absolute).isFile()) return [];
    return [
      { path, bytes: realFs.readFileSync(absolute), mtime: realFs.statSync(absolute).mtimeMs },
    ];
  });
}

function expectFailure(stage: string, path?: string): void {
  const before = preserveInputs();
  let caught: unknown;
  try {
    renderReport(cwd, fixture.report.report_id);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportRenderError);
  expect(caught).toMatchObject({ stage, ...(path === undefined ? {} : { path }) });
  expect(caught).not.toHaveProperty("cause");
  expect(caught).not.toHaveProperty("issues");
  expect(inspect(caught, { depth: null })).not.toContain(privatePayload);
  expect(inspect(caught, { depth: null })).not.toContain("private-approval-reference-440");
  expect(inspect(caught, { depth: null })).not.toContain("private-decision-comment-440");
  expect(preserveInputs()).toStrictEqual(before);
}

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(realFs.readFileSync);
  root = realFs.mkdtempSync(join(tmpdir(), "report-render-"));
  cwd = join(root, "workspace");
  fixture = makeRenderingFixture();
  for (const input of renderingInputs(fixture)) publish(input.path, input.value);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  realFs.rmSync(root, { recursive: true, force: true });
});

test("renderReport matches the independently authored two-run golden without publishing", () => {
  const before = preserveInputs();
  const result = renderReport(cwd, fixture.report.report_id);
  expect(result).toBe(golden);
  expect(result.endsWith("\n")).toBe(true);
  expect(result).not.toContain("\r");
  expect(preserveInputs()).toStrictEqual(before);
  expect(realFs.existsSync(join(cwd, "reports", `${fixture.report.report_id}.md`))).toBe(false);
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.renameSync).not.toHaveBeenCalled();
});

test("renderReport retains authored whitespace and token-like text in all four fields", () => {
  const result = renderReport(cwd, fixture.report.report_id);
  for (const value of [
    fixture.report.summary,
    ...fixture.report.observations,
    ...fixture.report.limitations,
    ...fixture.report.pi_questions,
  ]) {
    expect(result).toContain(value);
  }
  expect(result).toContain("- argv[3]: {{summary}}&#124;&#96;x&#96;&#13;&#10;next&#92;end");
  expect(result).toContain("topic&#124;&#96;edge&#96;&#10;## injected");
  expect(result).not.toContain("\n## injected");
});

// Structured metadata uses a single character-encoding pass:
// & < > | ` \ CR LF become &amp; &lt; &gt; &#124; &#96; &#92; &#13; &#10;.
// Generated entities are never encoded again; authored prose is not passed through it.
test.each(["branch", "base_url", "basin", "model", "argv", "stdout"] as const)(
  "renderReport structurally escapes %s metadata without recursive token substitution",
  (field) => {
    const value = "meta&<>|`\\\r\n## injected {{summary}}";
    if (field === "branch") fixture.stacks[0].repos.SHUD.branch = value;
    if (field === "base_url") fixture.stacks[0].llm.base_url = value;
    if (field === "basin") fixture.data[0].basin = value;
    if (field === "model") fixture.runs[0].llm.response_model = value;
    if (field === "argv") fixture.runs[0].command = [value];
    if (field === "stdout") fixture.runs[0].artifacts.stdout = value;
    for (const input of renderingInputs(fixture)) publish(input.path, input.value);
    const result = renderReport(cwd, fixture.report.report_id);
    expect(result).toContain("meta&amp;&lt;&gt;&#124;&#96;&#92;&#13;&#10;## injected {{summary}}");
    expect(result).not.toContain("\n## injected");
    expect(result).not.toContain("&amp;#124;");
  },
);

test("renderReport does not implement the separate authored-phrase validator", () => {
  publish(reportPath(), {
    ...fixture.report,
    summary: "Authored statement: 普遍改进\n{{facts}} must remain authored.",
  });
  expect(renderReport(cwd, fixture.report.report_id)).toContain(
    "Authored statement: 普遍改进\n{{facts}} must remain authored.",
  );
});

test("renderReport has the ten canonical headings and four literal governance statements", () => {
  const result = renderReport(cwd, fixture.report.report_id);
  expect(result.split("\n").filter((line) => line.startsWith("## "))).toEqual([
    "## 1. 摘要",
    "## 2. 任务与问题",
    "## 3. StackLock 与数据来源",
    "## 4. 运行记录",
    "## 5. 指标与图表",
    "## 6. 观测与解释限制",
    "## 7. 风险和失败项",
    "## 8. 需要 PI 判断的问题",
    "## 9. 建议下一步",
    "## 10. 附录：命令、日志、artifact manifest",
  ]);
  expect(result).toContain("\n本里程碑无指标 artifact，见 limitations\n");
  const governance = [
    "单流域/单事件指标提升不等于模型改进",
    "校准结果不等于结构验证",
    "不得宣称模型机制已验证",
    "不得宣称普遍改进",
  ];
  for (const sentence of governance) {
    expect(result).toContain(`\n${sentence}\n`);
    expect(fixture.report.limitations).not.toContain(sentence);
  }
  expect(result.indexOf(governance[0] ?? "")).toBeGreaterThan(
    result.indexOf("Do not infer model improvement."),
  );
  expect(result).toContain("Task: TASK-20261027T080005-1234");
  expect(result).toContain("下一步等待 PI 判断。");
});

test("renderReport preserves reference and artifact order and exact beyond-safe-number totals", () => {
  const result = renderReport(cwd, fixture.report.report_id);
  expect(result).toContain("| response | 2 | 9007199254740993 | stdout.log | stderr.log |");
  expect(result).toContain("| configured | 1 | 7 | stdout.log | stderr.log |");
  expect(result).not.toContain("9007199254740992");
  expect(result.indexOf("### StackLock STACK-20261029T080000-b002")).toBeLessThan(
    result.indexOf("### StackLock STACK-20261029T080000-a001"),
  );
  expect(result.indexOf("### DataProvenance DATA-20261029T080000-b002")).toBeLessThan(
    result.indexOf("### DataProvenance DATA-20261029T080000-a001"),
  );
  expect(result.indexOf("| output/z.dat | 9007199254740991 |")).toBeLessThan(
    result.indexOf("| output/a.dat | 2 |"),
  );
});

// Independent canonical watermark literals, including each archived terminal inheritance.
const WATERMARKS = [
  {
    status: "draft",
    outcome: null,
    header: "DRAFT — not accepted by PI",
    footer: "DRAFT — not accepted by PI",
  },
  {
    status: "reviewed",
    outcome: null,
    header: "DRAFT — not accepted by PI",
    footer: "DRAFT — not accepted by PI",
  },
  {
    status: "awaiting_pi",
    outcome: null,
    header: "DRAFT — not accepted by PI",
    footer: "DRAFT — not accepted by PI",
  },
  {
    status: "revision_requested",
    outcome: "revision_requested",
    header: "REVISION REQUESTED — not accepted by PI",
    footer: "REVISION REQUESTED — not accepted by PI",
  },
  {
    status: "rejected",
    outcome: "rejected",
    header: "REJECTED — not accepted by PI",
    footer: "REJECTED — not accepted by PI",
  },
  {
    status: "accepted",
    outcome: "accepted",
    header: "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001",
    footer: null,
  },
  {
    status: "archived",
    outcome: "accepted",
    header: "Accepted by PI · 2026-10-29T10:00:00Z · DEC-20261029T100000-a001 · ARCHIVED",
    footer: "ARCHIVED",
  },
  {
    status: "archived",
    outcome: "rejected",
    header: "REJECTED — not accepted by PI · ARCHIVED",
    footer: "REJECTED — not accepted by PI · ARCHIVED",
  },
  {
    status: "archived",
    outcome: "revision_requested",
    header: "REVISION REQUESTED — not accepted by PI · ARCHIVED",
    footer: "REVISION REQUESTED — not accepted by PI · ARCHIVED",
  },
] as const;

test.each(WATERMARKS)("renderReport uses canonical $status / $outcome header and footer", (row) => {
  publish(
    reportPath(),
    EvidenceReportSchema.parse({
      ...fixture.report,
      status: row.status,
      decision_history: row.outcome === null ? [] : [makeReportDecision(row.outcome)],
    }),
  );
  const before = preserveInputs();
  const result = renderReport(cwd, fixture.report.report_id);
  const lines = result.trimEnd().split("\n");
  expect(lines[0]).toBe("# EvidenceReport: REPORT-20261027T080005-3f9c");
  expect(lines[1]).toBe(row.header);
  if (row.footer === null) {
    expect(lines.at(-1)).toBe("| output/failure.dat | 7 |");
    expect(result).not.toContain("not accepted by PI");
  } else {
    expect(lines.at(-1)).toBe(row.footer);
  }
  if (row.outcome === "accepted") expect(result).not.toContain("not accepted by PI");
  expect(result).not.toContain("2026-10-30T12:34:56Z");
  expect(preserveInputs()).toStrictEqual(before);
});

test.each(["accepted", "rejected", "revision_requested", "archived"] as const)(
  "renderReport fails closed on invalid %s history without publication",
  (status) => {
    const outcome = status === "archived" ? "accepted" : status;
    const matching = makeReportDecision(outcome);
    const histories: PiGateDecision[][] = [
      [],
      [
        makeReportDecision(outcome, {
          report_id: ReportIdSchema.parse("REPORT-20261029T100000-f002"),
        }),
      ],
      [matching, matching],
      [matching, makeReportDecision(outcome === "accepted" ? "rejected" : "accepted")],
    ];
    for (const decision_history of histories) {
      publish(
        reportPath(),
        EvidenceReportSchema.parse({ ...fixture.report, status, decision_history }),
      );
      expectFailure("decision_history");
      expect(realFs.existsSync(join(cwd, "reports", `${fixture.report.report_id}.md`))).toBe(false);
    }
  },
);

test("renderReport lists every failed run, including unknown exits, and no successful runs in risks", () => {
  const first = RunRecordSchema.parse({
    ...fixture.runs[0],
    status: "failed",
    exit_code: null,
    exit_class: "lost",
  });
  publish(runRelativePath(first), first);
  const result = renderReport(cwd, fixture.report.report_id);
  const risk = result.split("## 7. 风险和失败项\n")[1]?.split("## 8.")[0];
  expect(risk).toBe("\n- RUN-20261029T080000-b002: lost\n- RUN-20261029T080000-a001: cvode\n\n");
  expect(result).toContain("| failed | unknown (null) | lost | 12.5 |");
  publish(runRelativePath(fixture.runs[0]), fixture.runs[0]);
  publish(
    reportPath(),
    EvidenceReportSchema.parse({ ...fixture.report, linked_runs: [fixture.runs[0].run_id] }),
  );
  const success = renderReport(cwd, fixture.report.report_id);
  expect(success.split("## 7. 风险和失败项\n")[1]?.split("## 8.")[0]).toBe("\nNone.\n\n");
});

test("renderReport distinguishes measured zero and nonzero health/resources from null", () => {
  publish(
    runRelativePath(fixture.runs[0]),
    RunRecordSchema.parse({
      ...fixture.runs[0],
      numerical_health: {
        water_balance_residual: -0.25,
        cvode_failures: 0,
        negative_state_count: 2,
        max_solver_dt: 3.5,
      },
      resources: { wall_seconds: 0, peak_memory_mb: 64 },
      artifacts: { ...fixture.runs[0].artifacts, files: [] },
    }),
  );
  const result = renderReport(cwd, fixture.report.report_id);
  expect(result).toContain("| RUN-20261029T080000-b002 | -0.25 | 0 | 2 | 3.5 | 64 |");
  expect(result).toContain("| succeeded | 0 | ok | 0 | run-model-b | response | 0 | 0 |");
});

test.each(["report", "stack", "data", "run"] as const)(
  "renderReport freshly rereads %s on every call without changing the source",
  (kind) => {
    expect(renderReport(cwd, fixture.report.report_id)).toBe(golden);
    if (kind === "report")
      publish(reportPath(), { ...fixture.report, summary: "Fresh authored summary." });
    if (kind === "stack")
      publish(`stacks/${fixture.stacks[0].stack_id}.json`, {
        ...fixture.stacks[0],
        llm: { ...fixture.stacks[0].llm, response_model: "fresh-stack-model" },
      });
    if (kind === "data")
      publish(`provenance/${fixture.data[0].data_id}.json`, {
        ...fixture.data[0],
        basin: "fresh-basin",
      });
    if (kind === "run")
      publish(runRelativePath(fixture.runs[0]), {
        ...fixture.runs[0],
        resources: { wall_seconds: 99, peak_memory_mb: null },
      });
    const before = preserveInputs();
    const result = renderReport(cwd, fixture.report.report_id);
    const expected = {
      report: "Fresh authored summary.",
      stack: "fresh-stack-model",
      data: "fresh-basin",
      run: "| ok | 99 |",
    };
    expect(result).toContain(expected[kind]);
    expect(result).not.toBe(golden);
    expect(preserveInputs()).toStrictEqual(before);
  },
);

test("renderReport ignores cwd, time and existing Markdown, and never reads TaskCard or evidence contents", () => {
  // Directory sentinels are deliberately not readable as ordinary log/artifact files.
  for (const run of fixture.runs) {
    for (const relative of [
      run.artifacts.stdout,
      run.artifacts.stderr,
      ...run.artifacts.files.map((file) => file.path),
    ]) {
      const target = join(cwd, "runs", run.run_id, relative);
      realFs.mkdirSync(target, { recursive: true });
      realFs.writeFileSync(join(target, "private-sentinel"), privatePayload);
    }
  }
  const markdownPath = join(cwd, "reports", `${fixture.report.report_id}.md`);
  realFs.writeFileSync(markdownPath, "existing Markdown must remain unchanged\n");
  const beforeMarkdown = {
    bytes: realFs.readFileSync(markdownPath),
    mtime: realFs.statSync(markdownPath).mtimeMs,
  };
  const inputs = new Set(renderingInputs(fixture).map(({ path }) => join(cwd, path)));
  vi.mocked(fs.readFileSync).mockImplementation((...args) => {
    const target = args[0] instanceof URL ? args[0].pathname : String(args[0]);
    if (!inputs.has(target) && !target.endsWith("/templates/evidence_report.md")) {
      throw new Error(privatePayload);
    }
    return realFs.readFileSync(...args);
  });
  const previous = process.cwd();
  vi.useFakeTimers();
  try {
    process.chdir(root);
    vi.setSystemTime(new Date("2099-12-31T23:59:59Z"));
    expect(renderReport(cwd, fixture.report.report_id)).toBe(golden);
  } finally {
    process.chdir(previous);
  }
  expect(realFs.readFileSync(markdownPath)).toEqual(beforeMarkdown.bytes);
  expect(realFs.statSync(markdownPath).mtimeMs).toBe(beforeMarkdown.mtime);
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.openSync).not.toHaveBeenCalled();
});

const FILE_KINDS = ["report", "stack", "data", "run"] as const;
describe.each(FILE_KINDS)("renderReport %s input failures", (kind) => {
  function selected() {
    const input = renderingInputs(fixture).find((entry) => entry.kind === kind);
    if (input === undefined) throw new Error("Expected a renderer input fixture");
    return input;
  }

  test.each(["missing", "parse", "schema", "identity", "read"])(
    "rejects %s evidence without input repair",
    (stage) => {
      const input = selected();
      const target = join(cwd, input.path);
      if (stage === "missing") realFs.unlinkSync(target);
      if (stage === "parse") realFs.writeFileSync(target, `{${privatePayload}`);
      if (stage === "schema")
        realFs.writeFileSync(target, JSON.stringify({ payload: privatePayload }));
      if (stage === "identity") {
        const field = { report: "report_id", stack: "stack_id", data: "data_id", run: "run_id" }[
          kind
        ];
        const prefix = { report: "REPORT", stack: "STACK", data: "DATA", run: "RUN" }[kind];
        publish(input.path, { ...input.value, [field]: `${prefix}-20261029T090000-f003` });
      }
      if (stage === "read") {
        vi.mocked(fs.readFileSync).mockImplementation((...args) => {
          if (String(args[0]) === target) throw new Error(privatePayload);
          return realFs.readFileSync(...args);
        });
      }
      expectFailure(stage, target);
      if (stage === "missing") expect(realFs.existsSync(target)).toBe(false);
    },
  );

  test.each(["symlink", "dangling-link", "directory", "fifo"] as const)(
    "rejects a %s record target before reading",
    (unsafe) => {
      const input = selected();
      const target = join(cwd, input.path);
      const outside = join(root, "outside.json");
      realFs.writeFileSync(outside, privatePayload);
      const beforeOutside = realFs.statSync(outside).mtimeMs;
      realFs.unlinkSync(target);
      installUnsafe(target, unsafe, outside);
      vi.clearAllMocks();
      expectFailure("target", target);
      expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => String(path) === target)).toBe(
        false,
      );
      expect(realFs.readFileSync(outside, "utf8")).toBe(privatePayload);
      expect(realFs.statSync(outside).mtimeMs).toBe(beforeOutside);
    },
  );
});

describe.each(["reports", "stacks", "provenance", "runs", "runs/RUN-20261029T080000-b002"])(
  "renderReport directory boundary %s",
  (directory) => {
    test.each(["symlink", "dangling-link", "file", "fifo"] as const)(
      "rejects a %s without modifying the original evidence",
      (unsafe) => {
        const path = join(cwd, directory);
        const outside = join(root, "outside-directory");
        realFs.renameSync(path, outside);
        installUnsafe(path, unsafe, outside);
        const outsideEntries = realFs.readdirSync(outside);
        expectFailure("directory", path);
        expect(realFs.readdirSync(outside)).toEqual(outsideEntries);
      },
    );
  },
);

test.each(["runs", "runs/RUN-20261029T080000-b002"])(
  "renderReport does not create missing %s directories or search alternative records",
  (directory) => {
    realFs.rmSync(join(cwd, directory), { recursive: true });
    publish("elsewhere/run-record.json", fixture.runs[0]);
    expectFailure("directory", join(cwd, directory));
    expect(realFs.existsSync(join(cwd, directory))).toBe(false);
    expect(fs.readdirSync).not.toHaveBeenCalled();
  },
);

test.each([
  undefined,
  null,
  440,
  "../reports/escape",
  "REPORT-not-an-id",
  { toString: () => "REPORT-20261027T080005-3f9c" },
])("renderReport rejects malformed routing ID %j before filesystem access", (id) => {
  let caught: unknown;
  try {
    renderReport(cwd, id);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportRenderError);
  expect(caught).toMatchObject({ stage: "id" });
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
