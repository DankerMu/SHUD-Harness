import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GOVERNANCE_INVARIANTS,
  ReportIdSchema,
  type EvidenceReport,
  type DataProvenance,
  type RunRecord,
  type StackLock,
} from "@shud-harness/dsh-shud-core";
import { readReportInput, readReportRun } from "./report-inputs.ts";
import { ReportRenderError } from "./report-render-error.ts";
import { reportWatermark } from "./report-watermark.ts";
import { regularTarget } from "./workspace-paths.ts";

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
 * report/stack/provenance/run JSON and the module-relative packaged template are read.
 * No TaskCard, logs, artifacts, raw inputs, clock, model calls or Markdown reads occur.
 * Source records/status/timestamps are unchanged. Existing workspace readers may create
 * standard managed directories; missing run directories are never created or discovered.
 * This function returns text only: future tools own the JSON/TaskCard commit sequence
 * and subsequent atomic writeBytes publication. It is not the report wording validator.
 */
export function renderReport(cwd: string, reportId: unknown): string {
  const id = ReportIdSchema.safeParse(reportId);
  if (!id.success) throw new ReportRenderError("id");
  const report = readReportInput(cwd, "report", id.data);
  const watermark = reportWatermark(report);
  const stacks = report.stack_ids.map((stackId) => readReportInput(cwd, "stack", stackId));
  const data = report.data_ids.map((dataId) => readReportInput(cwd, "data", dataId));
  const runs = report.linked_runs.map((runId) => readReportRun(cwd, runId));
  return renderReportDocument(report, stacks, data, runs, watermark).markdown;
}

/** Canonical projection from already validated evidence; not a public injection API. */
export function renderReportDocument(
  report: EvidenceReport,
  stacks: readonly StackLock[],
  data: readonly DataProvenance[],
  runs: readonly RunRecord[],
  watermark = reportWatermark(report),
): ReportDocument {
  const risks = runs
    .filter((run) => run.status !== "succeeded")
    .map((run) => `- ${metadata(run.run_id)}: ${metadata(run.exit_class)}`);
  const fields: Readonly<Record<string, string>> = {
    report_id: metadata(report.report_id),
    header: watermark.header,
    summary: report.summary,
    task_id: metadata(report.task_id),
    sources: [...stacks.map(renderStack), ...data.map(renderData)].join("\n\n"),
    runs: renderRuns(runs),
    observations: report.observations.join("\n\n"),
    limitations: report.limitations.join("\n\n"),
    invariants: GOVERNANCE_INVARIANTS.join("\n"),
    risks: risks.length === 0 ? "None." : risks.join("\n"),
    pi_questions: report.pi_questions.join("\n\n"),
    appendix: runs.map(renderAppendix).join("\n\n"),
    footer: watermark.footer === null ? "" : `\n\n${watermark.footer}`,
  };
  return projectTemplate(fields);
}
