import type { RunRecord, TaskCard } from "@shud-harness/dsh-shud-core";
import { codeChangeClosure, type CodeChangeObjectLoaders } from "./code-change-closure.ts";
import { deriveSensitivityClosure, hasSensitivityLoaders } from "./sensitivity-closure.ts";
import type {
  SensitivityClosureResult,
  SensitivityObjectLoaders,
} from "./sensitivity-closure-types.ts";
import {
  closureResult,
  sharedClosureFailures,
  type ClosureDraft,
  type ClosureFailure,
  type ClosureResult,
  type ClosureRunJob,
} from "./task-closure-shared.ts";

/**
 * Evaluate prevalidated evidence synchronously, without implicit IO, logging or mutation.
 * The caller owns ledger reads (absent ledger -> explicit 0), reconciliation,
 * report persistence and deterministic limitations. Invalid counts fail closed.
 * Current M3 policy retains attempts >= MAX_COLLECT_ATTEMPTS as a blocker even after
 * direct collection produced a successful record; this helper neither resets the ledger
 * nor gives record success precedence. Evidence must uniquely identify this task's job
 * and its matching job_id/run_id record. Unrelated evidence is ignored.
 * The three authored arrays are counted as supplied, without prose classification or
 * automatic augmentation. Metric availability and verdicts do not alter these run clauses.
 * A successful result establishes closure only, not approval or a TaskCard transition.
 * code_change requires explicit object loaders in the fifth argument and fails closed
 * without them. Its task-job snapshot, records and draft are the existing arguments;
 * this facade never queries a backend. Sensitivity requires its own explicit readers.
 * Its loaded result carries selections. The original signature remains ClosureResult:
 * a sensitivity card without those readers returns only a clause-0 failure.
 * Generic cards with new/union readers return the result union;
 * loader shape alone cannot promise sensitivity output for a science/code-change card.
 * Families exclude opposing capabilities statically and at runtime. "Missing" includes a
 * conflicting family: dual sensitivity/code-change inputs fail before invoking readers.
 * Ambient or asserted intersections conservatively return the union, never a legacy-only
 * promise. This overload does not authorize constructing a dual-capability object.
 */
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders: CodeChangeObjectLoaders & SensitivityObjectLoaders,
): ClosureResult | SensitivityClosureResult;
export function evaluateClosure(
  card: TaskCard & { type: "sensitivity" },
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders: SensitivityObjectLoaders,
): SensitivityClosureResult;
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders?: CodeChangeObjectLoaders,
): ClosureResult;
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders: CodeChangeObjectLoaders | SensitivityObjectLoaders | undefined,
): ClosureResult | SensitivityClosureResult;
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders?: CodeChangeObjectLoaders | SensitivityObjectLoaders,
): ClosureResult | SensitivityClosureResult {
  if (card.type === "sensitivity") {
    if (!hasSensitivityLoaders(objectLoaders)) {
      return closureResult([{ clause: 0, reason: "missing_sensitivity_loaders" }]);
    }
    return deriveSensitivityClosure(card, runJobs, runRecords, draft, objectLoaders);
  }
  if (card.type === "code_change") {
    if (
      typeof objectLoaders !== "object" ||
      objectLoaders === null ||
      !("readChange" in objectLoaders) ||
      typeof objectLoaders.readChange !== "function" ||
      !("readPatch" in objectLoaders) ||
      typeof objectLoaders.readPatch !== "function" ||
      !("readVerification" in objectLoaders) ||
      typeof objectLoaders.readVerification !== "function" ||
      objectLoaders.readAnalysisPlan !== undefined ||
      objectLoaders.readRunMetrics !== undefined
    ) {
      return closureResult([{ reason: "missing_code_change_loaders" }]);
    }
    return codeChangeClosure(card, {
      readChange: (id) => objectLoaders.readChange(id),
      readPatch: (id) => objectLoaders.readPatch(id),
      readVerification: (id) => objectLoaders.readVerification(id),
      listRunJobsByTask: () => runJobs,
      runRecords,
      draft,
    });
  }
  const failures: ClosureFailure[] = sharedClosureFailures(card, runJobs, runRecords, draft);
  if (card.type !== "science_assist") failures.unshift({ reason: "unsupported_task_type" });
  return closureResult(failures);
}
