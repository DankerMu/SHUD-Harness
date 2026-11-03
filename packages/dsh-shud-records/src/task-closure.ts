import type { RunRecord, TaskCard } from "@shud-harness/dsh-shud-core";
import { codeChangeClosure, type CodeChangeObjectLoaders } from "./code-change-closure.ts";
import {
  closureResult,
  sharedClosureFailures,
  type ClosureDraft,
  type ClosureFailure,
  type ClosureResult,
  type ClosureRunJob,
} from "./task-closure-shared.ts";

/**
 * Evaluate prevalidated domain evidence synchronously, without IO, logging or mutation.
 * The future caller owns ledger reads (absent ledger -> explicit 0), reconciliation,
 * report persistence and appending automatic_limitation. Invalid counts fail closed.
 * Current M3 policy retains attempts >= MAX_COLLECT_ATTEMPTS as a blocker even after
 * direct collection produced a successful record; this helper neither resets the ledger
 * nor gives record success precedence. Evidence must uniquely identify this task's job
 * and its matching job_id/run_id record. Unrelated evidence is ignored.
 * The three authored arrays are counted as supplied, without prose classification or
 * automatic augmentation. M3 has no metric artifacts, so metric_fact is explicitly true.
 * A successful result establishes closure only, not approval or a TaskCard transition.
 * code_change requires explicit object loaders in the fifth argument and fails closed
 * without them. Its task-job snapshot, records and draft are the existing arguments;
 * this facade never queries a backend. Other task types retain their M3 diagnostics.
 */
export function evaluateClosure(
  card: TaskCard,
  runJobs: readonly ClosureRunJob[],
  runRecords: readonly RunRecord[],
  draft: ClosureDraft,
  objectLoaders?: CodeChangeObjectLoaders,
): ClosureResult {
  if (card.type === "code_change") {
    if (objectLoaders === undefined) {
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
