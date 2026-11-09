import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CODE_CHANGE_SECTION5_WORDING,
  GOVERNANCE_INVARIANTS,
  ReportIdSchema,
  type BuildRecord,
  type ChangeRequest,
  type EvidenceReport,
  type DataProvenance,
  type RunRecord,
  type StackLock,
  type VerificationCase,
} from "@shud-harness/dsh-shud-core";
import {
  readReportCodeChangeFacts,
  readReportInput,
  readReportRun,
  readReportMetricFacts,
  type ReportCodeChangeFacts,
  type ReportMetricFacts,
} from "./report-inputs.ts";
import { ReportRenderError } from "./report-render-error.ts";
import { reportWatermark } from "./report-watermark.ts";
import { regularTarget } from "./workspace-paths.ts";
import { readReferencedSensitivitySummary } from "./sensitivity-summary-file.ts";
import { FLOW_FIELDS, HEALTH_FIELDS, VERDICT_FIELDS } from "./run-metrics-wire.ts";

type Metadata = string | number | bigint | boolean | null;
const TEMPLATE_PATH = fileURLToPath(new URL("../templates/evidence_report.md", import.meta.url));
export const REPOSITORIES = ["SHUD", "rSHUD", "AutoSHUD"] as const;
const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "|": "&#124;",
  "`": "&#96;",
  "\\": "&#92;",
  "\r": "&#13;",
  "\n": "&#10;",
};

/** Encode only structured metadata, once; authored prose never passes through here. */
export function metadata(value: Metadata): string {
  if (value === null) return "unknown (null)";
  return String(value).replace(/[&<>|`\\\r\n]/gu, (character) => ENTITIES[character] ?? character);
}

function table(headers: readonly string[], rows: readonly (readonly Metadata[])[]): string {
  const row = (cells: readonly Metadata[]) => `| ${cells.map(metadata).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
}

function renderMetrics(facts: readonly ReportMetricFacts[]): string {
  const cell = (value: number | null, reason: string | null): string =>
    value === null ? `null (${reason})` : JSON.stringify(value);
  return table(
    [
      "Run",
      "Metrics status",
      ...FLOW_FIELDS,
      ...HEALTH_FIELDS,
      ...VERDICT_FIELDS.map((field) => `${field} verdict`),
      "Metrics path",
      "SHA256",
    ],
    facts.map(({ run_id, source_ref, metrics }) => [
      run_id,
      metrics?.status ?? "not_available",
      ...FLOW_FIELDS.map((field) =>
        metrics === null ? "not_available" : cell(metrics.flow[field], metrics.flow.reasons[field]),
      ),
      ...HEALTH_FIELDS.map((field) =>
        metrics === null
          ? "not_available"
          : cell(metrics.numerical_health[field], metrics.numerical_health.reasons[field]),
      ),
      ...VERDICT_FIELDS.map((field) => metrics?.verdicts[field] ?? "not_available"),
      source_ref?.path ?? "not_available",
      source_ref?.sha256 ?? "not_available",
    ]),
  );
}

function renderStack(stack: StackLock): string {
  const revisions = table(
    ["Repository", "Commit", "Branch", "Dirty", "Dirty paths truncated"],
    REPOSITORIES.map((name) => {
      const revision = stack.repos[name];
      return [
        name,
        revision.commit,
        revision.branch,
        revision.dirty,
        revision.dirty_paths_truncated,
      ];
    }),
  );
  const details: string[] = [];
  for (const name of REPOSITORIES) {
    for (const path of stack.repos[name].dirty_paths) {
      details.push(`- ${name} dirty_path: ${metadata(path)}`);
    }
  }
  details.push(
    `- base_url: ${metadata(stack.llm.base_url)}`,
    `- request_alias: ${metadata(stack.llm.request_alias)}`,
    `- response_model: ${metadata(stack.llm.response_model)}`,
  );
  if (stack.build_id !== null) details.push(`- build_id: ${metadata(stack.build_id)}`);
  return `### StackLock ${metadata(stack.stack_id)}\n\n${revisions}\n\n${details.join("\n")}`;
}

function renderData(data: DataProvenance): string {
  const details = [
    `- basin: ${metadata(data.basin)}`,
    `- event_window.start: ${metadata(data.event_window.start)}`,
    `- event_window.end: ${metadata(data.event_window.end)}`,
    `- input_root: ${metadata(data.sources.input_root)}`,
  ].join("\n");
  const files = table(
    ["Source path", "SHA-256", "Bytes"],
    data.sources.files.map((file) => [file.path, file.sha256, file.size_bytes]),
  );
  return `### DataProvenance ${metadata(data.data_id)}\n\n${details}\n\n${files}`;
}

function renderChange(change: ChangeRequest): string {
  const details = [
    `- change_id: ${metadata(change.change_id)}`,
    `- base_commit: ${metadata(change.base_commit)}`,
    `- semantic_level: ${metadata(change.semantic_level)}`,
    `- semantic_floor: ${metadata(change.semantic_floor)}`,
    `- risk: ${metadata(change.risk)}`,
    ...change.files_changed.map((path, index) => `- files_changed[${index}]: ${metadata(path)}`),
    ...change.floor_categories.map(
      (category, index) => `- floor_categories[${index}]: ${metadata(category)}`,
    ),
    `- patch_path: ${metadata(change.patch_path)}`,
    `- patch_sha256: ${metadata(change.patch_sha256)}`,
    `- status: ${metadata(change.status)}`,
    `- approval_ref: ${metadata(change.approval_ref ?? "null")}`,
  ];
  return `### ChangeRequest ${metadata(change.change_id)}\n\n${details.join("\n")}`;
}

function renderVerification(verification: VerificationCase): string {
  const details = [
    `- vc_id: ${metadata(verification.vc_id)}`,
    `- case_type: ${metadata(verification.case_type)}`,
    `- expected_result_source: ${metadata(verification.expected_result_source)}`,
    `- pass_criteria: ${metadata(verification.pass_criteria)}`,
    `- base_run_id: ${metadata(verification.base_run_id)}`,
    `- candidate_run_id: ${metadata(verification.candidate_run_id)}`,
    `- base_build_id: ${metadata(verification.base_build_id)}`,
    `- candidate_build_id: ${metadata(verification.candidate_build_id)}`,
    `- observed.base_sha256: ${metadata(verification.observed.base_sha256)}`,
    `- observed.candidate_sha256: ${metadata(verification.observed.candidate_sha256)}`,
    `- status: ${metadata(verification.status)}`,
    `- failure_reason: ${metadata(verification.failure_reason ?? "null")}`,
    `- reviewed_by: ${metadata(verification.reviewed_by)}`,
    `- compatibility_verdict: ${metadata(verification.compatibility_verdict)}`,
    ...verification.reviewer_notes.map(
      (note, index) => `- reviewer_notes[${index}]: ${metadata(note)}`,
    ),
  ];
  return `### VerificationCase ${metadata(verification.vc_id)}\n\n${details.join("\n")}`;
}

function renderBuild(build: BuildRecord): string {
  const details = [
    `- build_id: ${metadata(build.build_id)}`,
    `- change_id: ${metadata(build.change_id ?? "null")}`,
    `- source_commit: ${metadata(build.source_commit)}`,
    `- rhs_openmp: ${metadata(build.rhs_openmp)}`,
    ...build.make_argv.map((argument, index) => `- make_argv[${index}]: ${metadata(argument)}`),
    `- compiler: ${metadata(build.compiler)}`,
    `- patch_sha256: ${metadata(build.patch_sha256 ?? "null")}`,
    `- binary_sha256: ${metadata(build.binary_sha256)}`,
  ];
  return `### BuildRecord ${metadata(build.build_id)}\n\n${details.join("\n")}`;
}

function artifactBytes(run: RunRecord): bigint {
  let total = 0n;
  for (const file of run.artifacts.files) total += BigInt(file.size_bytes);
  return total;
}

function renderRuns(runs: readonly RunRecord[]): string {
  const facts = table(
    [
      "Run",
      "Stack",
      "Data",
      "Status",
      "Exit code",
      "Exit class",
      "Wall seconds",
      "Response model",
      "Model source",
      "Artifact count",
      "Artifact bytes",
      "Stdout",
      "Stderr",
    ],
    runs.map((run) => [
      run.run_id,
      run.stack_id,
      run.data_id,
      run.status,
      run.exit_code,
      run.exit_class,
      run.resources.wall_seconds,
      run.llm.response_model,
      run.llm.response_model_source,
      run.artifacts.files.length,
      artifactBytes(run),
      run.artifacts.stdout,
      run.artifacts.stderr,
    ]),
  );
  const health = table(
    [
      "Run",
      "Water balance residual",
      "CVODE failures",
      "Negative state count",
      "Max solver dt",
      "Peak memory MB",
    ],
    runs.map((run) => [
      run.run_id,
      run.numerical_health.water_balance_residual,
      run.numerical_health.cvode_failures,
      run.numerical_health.negative_state_count,
      run.numerical_health.max_solver_dt,
      run.resources.peak_memory_mb,
    ]),
  );
  return `${facts}\n\n${health}`;
}

function renderDecisionHistory(report: EvidenceReport): string {
  if (report.decision_history.length === 0) return "No PI decision recorded.";
  return table(
    ["decision_id", "report_id", "outcome", "decided_at", "approval_ref", "comment"],
    report.decision_history.map((decision) => [
      decision.decision_id,
      decision.report_id,
      decision.outcome,
      decision.decided_at,
      decision.approval_ref,
      JSON.stringify(decision.comment),
    ]),
  );
}

function renderAppendix(run: RunRecord): string {
  const details = run.command.map((argument, index) => `- argv[${index}]: ${metadata(argument)}`);
  details.push(
    `- stdout: ${metadata(run.artifacts.stdout)}`,
    `- stderr: ${metadata(run.artifacts.stderr)}`,
    `- shud_output: ${metadata(run.artifacts.shud_output)}`,
  );
  const files = table(
    ["Artifact path", "Bytes"],
    run.artifacts.files.map((file) => [file.path, file.size_bytes]),
  );
  return `### Run ${metadata(run.run_id)}\n\n${details.join("\n")}\n\n${files}`;
}

function readTemplate(): string {
  try {
    if (regularTarget(TEMPLATE_PATH, "Report template") !== undefined) {
      return readFileSync(TEMPLATE_PATH, "utf8");
    }
  } catch {
    // Package asset failures never expose filesystem exceptions or raw template content.
  }
  throw new ReportRenderError("template", TEMPLATE_PATH);
}

export type ReportSectionId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Package-internal origins; offsets refer to the complete, unchanged public Markdown. */
export interface ReportDocument {
  readonly markdown: string;
  readonly sections: readonly {
    readonly id: ReportSectionId;
    readonly start: number;
    readonly end: number;
  }[];
}

function projectTemplate(fields: Readonly<Record<string, string>>): ReportDocument {
  const template = readTemplate();
  // Capture trusted heading offsets before substitution. Authored headings never
  // become section boundaries, including when they contain secret-shaped labels.
  const sections = [{ id: 0 as ReportSectionId, start: 0, end: 0 }];
  for (const match of template.matchAll(/^## (10|[1-9])\. /gmu)) {
    sections.push({ id: Number(match[1]) as ReportSectionId, start: match.index, end: 0 });
  }
  let nextSection = 0;
  let displacement = 0;
  const advance = (offset: number): void => {
    while (nextSection < sections.length) {
      const section = sections[nextSection];
      if (section === undefined || section.start > offset) break;
      section.start += displacement;
      nextSection += 1;
    }
  };
  // Replace original asset tokens once, never token-like text inside inserted prose.
  const markdown = template.replace(
    /\{\{([a-z_]+)\}\}/gu,
    (token: string, name: string, offset: number) => {
      const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (value === undefined) throw new ReportRenderError("template", TEMPLATE_PATH);
      advance(offset);
      displacement += value.length - token.length;
      return value;
    },
  );
  advance(template.length);
  for (const [index, section] of sections.entries()) {
    section.end = sections[index + 1]?.start ?? markdown.length;
  }
  return { markdown, sections };
}

/**
 * Synchronously project fresh, schema-validated same-workspace evidence into Markdown.
 * Routing and embedded identities are checked; arrays keep their declared order. Only
 * cited report/stack/provenance/run/change/verification/build JSON, bound metrics,
 * its immutable sensitivity companion when referenced, and the module-relative template
 * are read. No TaskCard, patches, logs, binaries, other output artifacts,
 * raw inputs, clock, model calls or Markdown reads occur. Build pairs stay in VC order;
 * StackLock build ids are displayed without discovering additional build records.
 * Source records/status/timestamps are unchanged; missing managed directories are never
 * created or discovered. This function returns text only: tools own the JSON/TaskCard
 * commit sequence and subsequent safe Markdown publication. It is not the wording validator.
 */
export function renderReport(cwd: string, reportId: unknown): string {
  const id = ReportIdSchema.safeParse(reportId);
  if (!id.success) throw new ReportRenderError("id");
  const report = readReportInput(cwd, "report", id.data);
  const watermark = reportWatermark(report);
  const stacks = report.stack_ids.map((stackId) => readReportInput(cwd, "stack", stackId));
  const data = report.data_ids.map((dataId) => readReportInput(cwd, "data", dataId));
  const runs = report.linked_runs.map((runId) => readReportRun(cwd, runId));
  const codeChangeFacts = readReportCodeChangeFacts(cwd, report);
  readReferencedSensitivitySummary(cwd, report);
  const metricFacts = readReportMetricFacts(cwd, runs);
  return renderReportDocument(report, stacks, data, runs, codeChangeFacts, metricFacts, watermark)
    .markdown;
}

/** Canonical projection from already validated evidence; not a public injection API. */
export function renderReportDocument(
  report: EvidenceReport,
  stacks: readonly StackLock[],
  data: readonly DataProvenance[],
  runs: readonly RunRecord[],
  codeChangeFacts: ReportCodeChangeFacts,
  metricFacts: readonly ReportMetricFacts[],
  watermark = reportWatermark(report),
): ReportDocument {
  const risks = runs
    .filter((run) => run.status !== "succeeded")
    .map((run) => `- ${metadata(run.run_id)}: ${metadata(run.exit_class)}`);
  for (const { record } of codeChangeFacts.verifications) {
    if (record.status === "failed") {
      risks.push(`- ${metadata(record.vc_id)}: ${metadata(record.failure_reason ?? "null")}`);
    }
  }
  const fields: Readonly<Record<string, string>> = {
    report_id: metadata(report.report_id),
    header: watermark.header,
    summary: report.summary,
    task_id: metadata(report.task_id),
    sources: [
      ...stacks.map(renderStack),
      ...data.map(renderData),
      ...codeChangeFacts.changes.map(renderChange),
      ...codeChangeFacts.verifications.map(({ record }) => renderVerification(record)),
      ...codeChangeFacts.verifications.flatMap(({ baseBuild, candidateBuild }) => [
        renderBuild(baseBuild),
        renderBuild(candidateBuild),
      ]),
    ].join("\n\n"),
    runs: renderRuns(runs),
    metrics: [
      ...(report.change_ids.length === 0 ? [] : [CODE_CHANGE_SECTION5_WORDING]),
      renderMetrics(metricFacts),
    ].join("\n\n"),
    observations: report.observations.join("\n\n"),
    limitations: report.limitations.join("\n\n"),
    invariants: GOVERNANCE_INVARIANTS.join("\n"),
    risks: risks.length === 0 ? "None." : risks.join("\n"),
    pi_questions: report.pi_questions.join("\n\n"),
    decision_history: renderDecisionHistory(report),
    appendix: runs.map(renderAppendix).join("\n\n"),
    footer: watermark.footer === null ? "" : `\n\n${watermark.footer}`,
  };
  return projectTemplate(fields);
}
