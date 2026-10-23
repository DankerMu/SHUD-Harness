import { join } from "node:path";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import {
  RunJobSchema,
  type JobRecordId,
  type RunId,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import type { ShudLifecycle } from "./detached-shud.ts";
import { processExecutionState } from "./process-identity.ts";
import type { IndexEntry, StateIndexStore } from "./state-indexes.ts";
import { collectRun } from "./shud-collect.ts";
import { readExit } from "./shud-exit.ts";
import type { ShudCancellation } from "./shud-cancellation.ts";
import {
  CollectFailure,
  collectFailure,
  isTerminal,
  notificationFinished,
  readRunFile,
  regularFile,
  validationFailure,
  updateRunJob,
  type RoutedRun,
} from "./shud-run-file.ts";

export interface CompletionReceipt {
  lifecycle: ShudLifecycle;
  /** Retain the precise diagnostic across completion retries, without rewriting durable evidence. */
  outcome?: JobOutcome;
}

function terminalOutcome(record: Pick<RunJob, "status" | "exit_code">): JobOutcome {
  if (record.status === "succeeded")
    return { status: "completed", detail: `SHUD exited with code ${record.exit_code}` };
  if (record.status === "cancelled")
    return { status: "killed", detail: "SHUD cancelled without an exit code" };
  return {
    status: "failed",
    detail:
      record.exit_code === null
        ? "SHUD failed without a recorded exit code"
        : `SHUD exited with code ${record.exit_code}`,
  };
}

function receiptOutcome(routed: RoutedRun, receipt: CompletionReceipt): JobOutcome {
  if (receipt.outcome) return receipt.outcome;
  const code = RunJobSchema.shape.exit_code.safeParse(routed.raw.exit_code);
  if (!code.success) throw validationFailure("RunJob completion", [{ path: ["exit_code"] }]);
  return terminalOutcome({ status: routed.status, exit_code: code.data });
}

/** One cadence and one per-run exclusion map serve timer ticks and public manual ticks alike. */
export class ShudPoll {
  private readonly steps = new Map<RunId, Promise<void>>();
  private accepting = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly indexes: StateIndexStore;
  private readonly receipts: Map<RunId, CompletionReceipt>;
  private readonly cancellations: ShudCancellation;
  private readonly inSubmission: (id: RunId) => boolean;
  private readonly pumpPollMs: number;
  private readonly report: (error: Error) => void;

  constructor(
    indexes: StateIndexStore,
    receipts: Map<RunId, CompletionReceipt>,
    cancellations: ShudCancellation,
    inSubmission: (id: RunId) => boolean,
    pumpPollMs: number,
    report: (error: Error) => void,
  ) {
    this.indexes = indexes;
    this.receipts = receipts;
    this.cancellations = cancellations;
    this.inSubmission = inSubmission;
    this.pumpPollMs = pumpPollMs;
    this.report = report;
  }

  start(): void {
    if (!this.accepting || this.timer) return;
    this.timer = setInterval(() => this.dispatch(), this.pumpPollMs);
    this.timer.unref();
  }

  pollOnce(): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("SHUD poll admission is closed"));
    const operations: Promise<void>[] = [];
    this.dispatch(operations);
    return Promise.all(operations).then(() => undefined);
  }

  collectShud(id: RunId | JobRecordId): Promise<RunRecord> {
    try {
      if (!this.accepting) throw new CollectFailure("admission", "CLOSED");
      const entry = this.indexes.lookup(id);
      if (!entry) throw new CollectFailure("request", "UNKNOWN_ID");
      if (this.inSubmission(entry.run_id))
        throw new CollectFailure("request", "SUBMISSION_IN_FLIGHT");
      return this.enqueue(entry.run_id, async () => {
        const routed = await readRunFile(entry);
        if (!isTerminal(routed.status)) throw new CollectFailure("request", "NOT_TERMINAL");
        const receipt = this.receipts.get(entry.run_id);
        if (receipt) await this.complete(entry.run_id, receipt, receiptOutcome(routed, receipt));
        return collectRun(entry, routed, false);
      }).catch((error: unknown) => {
        const failure = error instanceof Error ? error : collectFailure("request", error);
        this.report(failure);
        throw failure;
      });
    } catch (error) {
      const failure = collectFailure("request", error);
      this.report(failure);
      return Promise.reject(failure);
    }
  }

  /** Non-rejecting tails include queued work; an old completion cannot erase a queued successor. */
  private enqueue<T>(id: RunId, work: () => Promise<T>): Promise<T> {
    const previous = this.steps.get(id) ?? Promise.resolve();
    const operation = previous.then(work);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.steps.set(id, tail);
    void tail.then(() => {
      if (this.steps.get(id) === tail) this.steps.delete(id);
    });
    return operation;
  }

  /** Timers do not accumulate waiters behind slow entries; manual ticks join accepted work. */
  private dispatch(joined?: Promise<void>[]): void {
    if (!this.accepting) return;
    for (const entry of this.indexes.read().active) {
      if (this.inSubmission(entry.run_id)) continue;
      let operation = this.steps.get(entry.run_id);
      if (!operation) {
        operation = this.enqueue(entry.run_id, () => this.runStep(entry));
      }
      joined?.push(operation);
    }
  }

  private async runStep(entry: IndexEntry): Promise<void> {
    try {
      await this.step(entry);
    } catch (error) {
      this.report(
        new Error(`Cannot poll SHUD run ${entry.run_id} at ${entry.run_dir}`, { cause: error }),
      );
    }
  }

  private async step(entry: IndexEntry): Promise<void> {
    const routed = await readRunFile(entry);
    if (
      notificationFinished(routed.raw) ||
      routed.status === "collected" ||
      routed.status === "created" ||
      routed.status === "submitted"
    )
      return;
    const receipt = this.receipts.get(entry.run_id);
    if (routed.status !== "running") {
      if (receipt) await this.complete(entry.run_id, receipt, receiptOutcome(routed, receipt));
      else await collectRun(entry, routed, true);
      return;
    }
    // Running settlement still requires the complete schema before any mutation.
    const record = RunJobSchema.parse(routed.raw);
    const path = join(entry.run_dir, "run-job.json");
    if (!this.cancellations.advance(entry.run_id)) return;

    let evidence = await readExit(record.run_dir);
    if (!evidence) {
      if (record.pid === null || record.pid_started_at === null) {
        throw new Error(`Running record lacks process identity: ${record.run_id}`);
      }
      const observed = processExecutionState(record.pid);
      if (
        observed &&
        !observed.state.startsWith("Z") &&
        Date.parse(`${observed.stamp} UTC`) === Date.parse(record.pid_started_at)
      )
        return;
      // Publication can race the death/identity observation. Exit evidence still wins over cancellation.
      evidence = await readExit(record.run_dir);
    }

    await regularFile(path, "run metadata");
    let outcome: JobOutcome | undefined;
    const terminal = updateRunJob(
      entry,
      (current) => {
        if (current.status !== "running") return current;
        // A synchronous kill may have arrived during any awaited read above.
        // Both quiescence and cancelled-versus-lost use the current cancellation state.
        if (!this.cancellations.advance(entry.run_id)) return current;
        let status: "succeeded" | "failed" | "cancelled";
        let code: number | null = null;
        if (evidence && evidence.code !== undefined) {
          code = evidence.code;
          status = code === 0 ? "succeeded" : "failed";
          outcome = {
            status: code === 0 ? "completed" : "failed",
            detail: `SHUD exited with code ${code}`,
          };
        } else if (evidence?.error) {
          status = "failed";
          outcome = { status: "failed", detail: evidence.error.message };
        } else if (current.cancel_requested_at !== null) {
          status = "cancelled";
          outcome = { status: "killed", detail: "SHUD cancelled without an exit code" };
        } else {
          status = "failed";
          outcome = {
            status: "failed",
            detail: "SHUD lost: wrapper no longer executing and exit_code is absent",
          };
        }
        return { ...current, status, exit_code: code, finished_at: new Date().toISOString() };
      },
      routed,
    );
    if (terminal.status === "running") return;
    if (outcome && evidence?.error) this.report(evidence.error);
    if (receipt) {
      receipt.outcome = outcome ?? receipt.outcome ?? terminalOutcome(terminal);
      await this.complete(record.run_id, receipt, receipt.outcome);
    }
  }

  private async complete(
    runId: RunId,
    receipt: CompletionReceipt,
    outcome: JobOutcome,
  ): Promise<void> {
    if (!this.cancellations.advance(runId)) {
      throw new Error("SHUD cancellation is waiting for owned group quiescence");
    }
    await this.cancellations.waitForExit(runId);
    await receipt.lifecycle.settle(outcome);
    await receipt.lifecycle.done;
    this.receipts.delete(runId);
    this.cancellations.release(runId);
  }

  stopAdmission(): void {
    this.accepting = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  drain(): Promise<void> {
    return Promise.allSettled(this.steps.values()).then(() => undefined);
  }
}
