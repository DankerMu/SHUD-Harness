import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  CODE_CHANGE_SECTION5_WORDING,
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
  type VerificationCase,
  type VerificationId,
} from "@shud-harness/dsh-shud-core";
import {
  readReportCodeChangeFacts,
  readReportInput,
  readReportRun,
  readReportMetricFacts,
} from "./report-inputs.ts";
import { ReportRenderError, type ReportRenderStage } from "./report-render-error.ts";
import {
  metadata,
  renderReportDocument,
  REPOSITORIES,
  type ReportDocument,
  type ReportSectionId,
} from "./report-render.ts";
import { hashDescriptor } from "./hash-descriptor.ts";
import { regularTarget } from "./workspace-paths.ts";
import { readReferencedSensitivitySummary } from "./sensitivity-summary-file.ts";
import { deriveSensitivityLimitations } from "./sensitivity-limitations.ts";
import type { SensitivitySummary } from "./sensitivity-summary-types.ts";

export type ReportValidationStage = ReportRenderStage;
export type ReportValidationCheckId =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;

type ReferenceFailure = {
  readonly code: "reference_unavailable";
  readonly stage: ReportValidationStage;
} & (
  | { readonly kind: "stack"; readonly id: StackId }
  | { readonly kind: "data"; readonly id: DataId }
  | { readonly kind: "run"; readonly id: RunId }
  | { readonly kind: "verification"; readonly id: VerificationId }
);

type ArtifactStage =
  "directory" | "target" | "open" | "fstat" | "identity" | "read" | "close" | "hash";
interface ArtifactFailure {
  readonly stage: ArtifactStage;
  readonly cleanup_failed?: true;
}

/** Controlled facts only; artifact paths are relative and redact every canonical secret match. */
export type ReportValidationDetail =
  | ReferenceFailure
  | { readonly code: "empty_field"; readonly field: "limitations" | "pi_questions" }
  | ({ readonly code: "forbidden_phrase" } & ForbiddenPhraseHit)
  | { readonly code: "failed_run_missing"; readonly run_id: RunId }
  | { readonly code: "failed_verification_missing"; readonly vc_id: VerificationId }
  | { readonly code: "code_change_wording_missing" }
  | ({
      readonly code: "verification_artifact_invalid";
      readonly vc_id: VerificationId;
      readonly artifact_index: 0 | 1;
      readonly path: string;
    } & ArtifactFailure)
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
  | {
      readonly code: "sensitivity_statement_missing";
      readonly statement: "coverage" | "parameter_range";
    }
  | {
      readonly code: "sensitivity_summary_invalid";
      readonly path: string;
      readonly stage: ReportValidationStage;
    }
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
    ReportValidationCheck<14>,
    ReportValidationCheck<15>,
    ReportValidationCheck<16>,
    ReportValidationCheck<17>,
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

function failedVerificationDetails(
  document: ReportDocument,
  verifications: readonly VerificationCase[],
): ReportValidationDetail[] {
  const risks = sectionText(document, 7);
  return verifications
    .filter((record) => record.status === "failed" && !risks.includes(record.vc_id))
    .map((record) => ({ code: "failed_verification_missing", vc_id: record.vc_id }));
}

/** Coverage (from the companion only, never analyses/) and agent-range sentences, verbatim. */
function statementDetails(
  document: ReportDocument,
  summary: SensitivitySummary,
): ReportValidationDetail[] {
  const [coverage, parameterRange] = deriveSensitivityLimitations(summary).leading;
  return (
    [
      ["coverage", coverage],
      ["parameter_range", parameterRange],
    ] as const
  )
    .filter(([, sentence]) => !document.markdown.includes(sentence))
    .map(([statement]) => ({ code: "sensitivity_statement_missing", statement }));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Preserve physical cwd traversal and every POSIX artifact component, including empty/dot
 * components. In particular, file/. and file/ require a directory and cannot become file.
 * Inspect all ancestors without following links, then bind the nonblocking/no-follow open
 * to its inspected inode. Recheck the chain and file before/after the bounded descriptor read.
 * These observations detect replacement, not an atomic snapshot of concurrent external writes.
 */
function inspectArtifact(
  cwd: string,
  relative: string,
  expected: string,
): ArtifactFailure | undefined {
  let stage: ArtifactStage = "directory";
  let fd: number | undefined;
  let failure: ArtifactFailure | undefined;
  try {
    let path = realpathSync.native(cwd);
    const directories: Array<{ path: string; stat: Stats }> = [];
    const components = relative.split("/");
    for (let index = 0; index < components.length; index += 1) {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) throw new Error("Unsafe artifact ancestor");
      directories.push({ path, stat });
      path += `/${components[index]}`;
    }
    stage = "target";
    const inspected = regularTarget(path, "Verification artifact");
    if (inspected === undefined) throw new Error("Missing artifact");
    stage = "open";
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    stage = "fstat";
    const descriptor = fstatSync(fd);
    stage = "identity";
    if (!descriptor.isFile() || !sameIdentity(descriptor, inspected)) {
      throw new Error("Artifact identity changed");
    }
    const recheck = () => {
      for (const directory of directories) {
        const current = lstatSync(directory.path);
        if (!current.isDirectory() || !sameIdentity(current, directory.stat)) {
          throw new Error("Artifact ancestor changed");
        }
      }
      const current = regularTarget(path, "Verification artifact");
      if (
        current === undefined ||
        !sameIdentity(current, descriptor) ||
        current.size !== descriptor.size ||
        current.mtimeMs !== descriptor.mtimeMs ||
        current.ctimeMs !== descriptor.ctimeMs
      ) {
        throw new Error("Artifact changed");
      }
    };
    recheck();
    stage = "read";
    const digest = hashDescriptor(fd);
    stage = "identity";
    recheck();
    if (digest !== expected) failure = { stage: "hash" };
  } catch {
    failure = { stage };
  } finally {
    if (fd !== undefined) {
      // Exactly one close attempt: a failed close leaves descriptor ownership unknown.
      try {
        closeSync(fd);
      } catch {
        failure = failure === undefined ? { stage: "close" } : { ...failure, cleanup_failed: true };
      }
    }
  }
  return failure;
}

function artifactDetails(
  cwd: string,
  verifications: readonly VerificationCase[],
): ReportValidationDetail[] {
  const details: ReportValidationDetail[] = [];
  const flags = REPORT_SECRET_PATTERN.flags;
  const secrets = new RegExp(
    REPORT_SECRET_PATTERN.source,
    flags.includes("g") ? flags : `${flags}g`,
  );
  for (const record of verifications) {
    for (const index of [0, 1] as const) {
      const path = record.artifact_refs[index];
      const expected = index === 0 ? record.observed.base_sha256 : record.observed.candidate_sha256;
      const failure = inspectArtifact(cwd, path, expected);
      if (failure !== undefined) {
        details.push({
          code: "verification_artifact_invalid",
          vc_id: record.vc_id,
          artifact_index: index,
          path: path.replace(secrets, "[REDACTED]"),
          ...failure,
        });
      }
    }
  }
  return details;
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
 * seventeen ordered checks even if references or the canonical projection fail. Checks
 * 4/10 are vacuous because metrics are guaranteed by construction (digest-bound facts with
 * source refs), 11 is always true (no figures); 14-17 are inapplicable without their
 * references. The sensitivity companion is read once, independently of other references:
 * that single outcome decides 17 (file/digest/identity) and feeds the projection for 16.
 * Existing Markdown and logs are not read; VC artifacts are hashed without writes.
 * This is enumerated evidence/wording lint, not closure or PI semantic approval.
 * All report/reference reads are non-creating; missing managed directories remain absent.
 * Cited change/verification/build facts participate in the canonical document; artifact
 * validation reads every VC independently if another reference prevents that projection.
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
  let summary: SensitivitySummary | null = null;
  let summaryStage: ReportValidationStage | undefined;
  try {
    summary = readReferencedSensitivitySummary(cwd, report);
  } catch (error) {
    summaryStage = controlledStage(error);
  }
  const firstFailure = stacks.failures[0] ?? data.failures[0] ?? runs.failures[0];
  let renderStage = firstFailure?.stage;
  let document: ReportDocument | undefined;
  let verifications: readonly VerificationCase[] | undefined;
  if (firstFailure === undefined) {
    try {
      const codeChangeFacts = readReportCodeChangeFacts(cwd, report);
      verifications = codeChangeFacts.verifications.map(({ record }) => record);
      if (summaryStage === undefined) {
        document = renderReportDocument(
          report,
          stacks.values,
          data.values,
          runs.values,
          codeChangeFacts,
          readReportMetricFacts(cwd, runs.values),
          undefined,
          summary,
        );
      } else renderStage = summaryStage;
    } catch (error) {
      renderStage = controlledStage(error);
    }
  }
  // Reuse already-read VCs when projection facts succeeded. Otherwise load them independently:
  // missing stacks/data/runs/changes/builds must not suppress any VC's artifact diagnostics.
  const verificationEvidence =
    verifications === undefined
      ? loadReferences(
          report.verification_ids,
          (vcId) => readReportInput(cwd, "verification", vcId),
          (vcId, stage) => ({
            code: "reference_unavailable",
            kind: "verification",
            id: vcId,
            stage,
          }),
        )
      : { values: verifications, failures: [] };
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
    clause(
      8,
      document === undefined
        ? unavailable
        : [
            ...failedRunDetails(document, runs.values),
            ...failedVerificationDetails(document, verificationEvidence.values),
          ],
    ),
    clause(9, document === undefined ? unavailable : dirtyDetails(document, stacks.values)),
    clause(10, [], true),
    clause(11, [], true),
    clause(12, document === undefined ? unavailable : invariantDetails(document)),
    clause(13, document === undefined ? unavailable : secretDetails(document)),
    clause(
      14,
      report.change_ids.length === 0
        ? []
        : document === undefined
          ? unavailable
          : sectionText(document, 5).includes(CODE_CHANGE_SECTION5_WORDING)
            ? []
            : [{ code: "code_change_wording_missing" }],
      report.change_ids.length === 0,
    ),
    clause(
      15,
      [...verificationEvidence.failures, ...artifactDetails(cwd, verificationEvidence.values)],
      report.verification_ids.length === 0,
    ),
    clause(
      16,
      report.sensitivity_summary === null
        ? []
        : document === undefined || summary === null
          ? unavailable
          : statementDetails(document, summary),
      report.sensitivity_summary === null,
    ),
    clause(
      17,
      // Digest-matching parse/schema failures are readable intact files; they fail 16 only.
      report.sensitivity_summary === null ||
        summaryStage === undefined ||
        summaryStage === "parse" ||
        summaryStage === "schema"
        ? []
        : [
            {
              code: "sensitivity_summary_invalid",
              path: report.sensitivity_summary.path,
              stage: summaryStage,
            },
          ],
      report.sensitivity_summary === null,
    ),
  ];
  return { ok: checks.every((check) => check.pass), checks };
}
