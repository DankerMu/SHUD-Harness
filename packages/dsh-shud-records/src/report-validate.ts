import {
  GOVERNANCE_INVARIANTS,
  REPORT_SECRET_PATTERN,
  ReportIdSchema,
  scanForbiddenPhrases,
  type DataId,
  type EvidenceReport,
  type ForbiddenPhraseHit,
  type RunId,
  type RunRecord,
  type StackId,
  type StackLock,
} from "@shud-harness/dsh-shud-core";
import { readReportInput, readReportRun } from "./report-inputs.ts";
import { ReportRenderError, type ReportRenderStage } from "./report-render-error.ts";
import {
  metadata,
  renderReportDocument,
  REPOSITORIES,
  type ReportDocument,
  type ReportSectionId,
} from "./report-render.ts";

export type ReportValidationStage = ReportRenderStage;
export type ReportValidationCheckId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

type ReferenceFailure = {
  readonly code: "reference_unavailable";
  readonly stage: ReportValidationStage;
} & (
  | { readonly kind: "stack"; readonly id: StackId }
  | { readonly kind: "data"; readonly id: DataId }
  | { readonly kind: "run"; readonly id: RunId }
);

/** Closed diagnostic vocabulary: never source prose, metadata, paths or exception payloads. */
export type ReportValidationDetail =
  | ReferenceFailure
  | { readonly code: "empty_field"; readonly field: "limitations" | "pi_questions" }
  | ({ readonly code: "forbidden_phrase" } & ForbiddenPhraseHit)
  | { readonly code: "failed_run_missing"; readonly run_id: RunId }
  | {
      readonly code: "dirty_annotation_missing";
      readonly stack_id: StackId;
      readonly repository: keyof StackLock["repos"];
    }
  | {
      readonly code: "invariant_missing";
      readonly invariant: (typeof GOVERNANCE_INVARIANTS)[number];
    }
  | { readonly code: "secret_detected"; readonly section: ReportSectionId }
  | { readonly code: "render_unavailable"; readonly stage: ReportValidationStage };

export interface ReportValidationCheck<
  Id extends ReportValidationCheckId = ReportValidationCheckId,
> {
  readonly id: Id;
  readonly pass: boolean;
  readonly vacuous: boolean;
  readonly details: readonly ReportValidationDetail[];
}

export interface ReportValidationResult {
  readonly ok: boolean;
  readonly checks: readonly [
    ReportValidationCheck<1>,
    ReportValidationCheck<2>,
    ReportValidationCheck<3>,
    ReportValidationCheck<4>,
    ReportValidationCheck<5>,
    ReportValidationCheck<6>,
    ReportValidationCheck<7>,
    ReportValidationCheck<8>,
    ReportValidationCheck<9>,
    ReportValidationCheck<10>,
    ReportValidationCheck<11>,
    ReportValidationCheck<12>,
    ReportValidationCheck<13>,
  ];
}

/** A route/root failure has no report to validate. Paths and underlying errors stay private. */
export class ReportValidationError extends Error {
  constructor(readonly stage: ReportValidationStage) {
    super(`Report validation ${stage} failed`);
    this.name = "ReportValidationError";
  }
}

function controlledStage(error: unknown): ReportValidationStage {
  return error instanceof ReportRenderError ? error.stage : "read";
}

function loadReferences<Id, Value>(
  ids: readonly Id[],
  read: (id: Id) => Value,
  failure: (id: Id, stage: ReportValidationStage) => ReferenceFailure,
): { values: Value[]; failures: ReferenceFailure[] } {
  const values: Value[] = [];
  const failures: ReferenceFailure[] = [];
  for (const id of ids) {
    try {
      values.push(read(id));
    } catch (error) {
      failures.push(failure(id, controlledStage(error)));
    }
  }
  return { values, failures };
}

function clause<Id extends ReportValidationCheckId>(
  id: Id,
  details: readonly ReportValidationDetail[] = [],
  vacuous = false,
): ReportValidationCheck<Id> {
  return { id, pass: details.length === 0, vacuous, details };
}

/** Only template-owned section spans are eligible; authored numbered headings are inert. */
function sectionText(document: ReportDocument, id: ReportSectionId): string {
  return document.sections
    .filter((section) => section.id === id)
    .map((section) => document.markdown.slice(section.start, section.end))
    .join("");
}

function failedRunDetails(
  document: ReportDocument,
  runs: readonly RunRecord[],
): ReportValidationDetail[] {
  const risks = sectionText(document, 7);
  return runs
    .filter((run) => run.status === "failed" && !risks.includes(run.run_id))
    .map((run) => ({ code: "failed_run_missing", run_id: run.run_id }));
}

function dirtyDetails(
  document: ReportDocument,
  stacks: readonly StackLock[],
): ReportValidationDetail[] {
  // Generated metadata has encoded newlines and delimiters. Parse only the owned
  // sources section, never authored headings elsewhere or an expected renderStack copy.
  const lines = sectionText(document, 3).split("\n");
  const details: ReportValidationDetail[] = [];
  for (const stack of stacks) {
    const start = lines.indexOf(`### StackLock ${stack.stack_id}`);
    let end = start + 1;
    if (start !== -1) {
      while (end < lines.length && !lines[end]?.startsWith("##")) end += 1;
    }
    const block = start === -1 ? [] : lines.slice(start + 1, end);
    for (const repository of REPOSITORIES) {
      const revision = stack.repos[repository];
      if (!revision.dirty) continue;
      const trueRow = block.some((line) => {
        const cells = line.split("|");
        return cells.length === 7 && cells[1]?.trim() === repository && cells[4]?.trim() === "true";
      });
      const pathsPresent = revision.dirty_paths.every((path) =>
        block.includes(`- ${repository} dirty_path: ${metadata(path)}`),
      );
      if (!trueRow || !pathsPresent) {
        details.push({ code: "dirty_annotation_missing", stack_id: stack.stack_id, repository });
      }
    }
  }
  return details;
}

function invariantDetails(document: ReportDocument): ReportValidationDetail[] {
  return GOVERNANCE_INVARIANTS.filter((invariant) => !document.markdown.includes(invariant)).map(
    (invariant) => ({ code: "invariant_missing", invariant }),
  );
}

function secretDetails(document: ReportDocument): ReportValidationDetail[] {
  // Match the entire document with core semantics. A fresh global copy enumerates
  // every origin without mutating the canonical regex or retaining lastIndex state.
  const flags = REPORT_SECRET_PATTERN.flags;
  const pattern = new RegExp(
    REPORT_SECRET_PATTERN.source,
    flags.includes("g") ? flags : `${flags}g`,
  );
  const affected = new Set<ReportSectionId>();
  for (const match of document.markdown.matchAll(pattern)) {
    const origin = document.sections.find(
      (section) => match.index >= section.start && match.index < section.end,
    );
    affected.add(origin?.id ?? 0);
  }
  return [...affected]
    .sort((left, right) => left - right)
    .map((section) => ({ code: "secret_detected", section }));
}

/**
 * Validate fresh same-workspace report evidence without publishing or changing state.
 * Root/routing errors throw a stage-only error; every schema-valid root receives all
 * thirteen ordered checks even if references or the canonical projection fail. Only
 * 4/10/11 are M3-vacuous. Existing Markdown, logs, artifacts and credentials are not read.
 * This is enumerated evidence/wording lint, not closure or PI semantic approval.
 * All report/reference reads are non-creating; missing managed directories remain absent.
 */
export function validateReport(cwd: string, reportId: unknown): ReportValidationResult {
  const id = ReportIdSchema.safeParse(reportId);
  if (!id.success) throw new ReportValidationError("id");
  let report: EvidenceReport;
  try {
    report = readReportInput(cwd, "report", id.data);
  } catch (error) {
    throw new ReportValidationError(controlledStage(error));
  }
  const stacks = loadReferences(
    report.stack_ids,
    (stackId) => readReportInput(cwd, "stack", stackId),
    (stackId, stage) => ({ code: "reference_unavailable", kind: "stack", id: stackId, stage }),
  );
  const data = loadReferences(
    report.data_ids,
    (dataId) => readReportInput(cwd, "data", dataId),
    (dataId, stage) => ({ code: "reference_unavailable", kind: "data", id: dataId, stage }),
  );
  const runs = loadReferences(
    report.linked_runs,
    (runId) => readReportRun(cwd, runId),
    (runId, stage) => ({ code: "reference_unavailable", kind: "run", id: runId, stage }),
  );
  const firstFailure = stacks.failures[0] ?? data.failures[0] ?? runs.failures[0];
  let renderStage = firstFailure?.stage;
  let document: ReportDocument | undefined;
  if (firstFailure === undefined) {
    try {
      document = renderReportDocument(report, stacks.values, data.values, runs.values);
    } catch (error) {
      renderStage = controlledStage(error);
    }
  }
  const unavailable: readonly ReportValidationDetail[] =
    document === undefined ? [{ code: "render_unavailable", stage: renderStage ?? "read" }] : [];
  const checks: ReportValidationResult["checks"] = [
    clause(1, stacks.failures),
    clause(2, data.failures),
    clause(3, runs.failures),
    clause(4, [], true),
    clause(
      5,
      report.limitations.length === 0 ? [{ code: "empty_field", field: "limitations" }] : [],
    ),
    clause(
      6,
      report.pi_questions.length === 0 ? [{ code: "empty_field", field: "pi_questions" }] : [],
    ),
    clause(
      7,
      scanForbiddenPhrases(report).map((hit) => ({ code: "forbidden_phrase", ...hit })),
    ),
    clause(8, document === undefined ? unavailable : failedRunDetails(document, runs.values)),
    clause(9, document === undefined ? unavailable : dirtyDetails(document, stacks.values)),
    clause(10, [], true),
    clause(11, [], true),
    clause(12, document === undefined ? unavailable : invariantDetails(document)),
    clause(13, document === undefined ? unavailable : secretDetails(document)),
  ];
  return { ok: checks.every((check) => check.pass), checks };
}
