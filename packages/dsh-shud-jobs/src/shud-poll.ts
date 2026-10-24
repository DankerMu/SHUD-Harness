import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { processBirthObservation, type ProcessBirthObservation } from "./process-birth.ts";
import type { IndexEntry, StateIndexStore } from "./state-indexes.ts";
import { collectRun, readCollectCheckpoint, type CollectCheckpoint } from "./shud-collect.ts";
import { readExit, type ExitEvidence } from "./shud-exit.ts";
import type { ShudCancellation } from "./shud-cancellation.ts";
import {
  reconcileEntry,
  type ReconcileDecision,
  type ReconcileProcess,
  type ReconcileSnapshot,
} from "./shud-reconcile.ts";
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
  private readonly startupPending = new Set<RunId>();
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

  reconcileAtStartup(): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("SHUD startup admission is closed"));
    const operations = this.indexes.read().active.map((entry) => {
      this.startupPending.add(entry.run_id);
      return this.enqueue(entry.run_id, () => this.runStep(entry, true));
    });
    return Promise.all(operations).then(() => undefined);
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

  private async runStep(entry: IndexEntry, startup = false): Promise<void> {
    const reconciling = startup || this.startupPending.has(entry.run_id);
    try {
      if (reconciling) {
        await this.reconcile(entry);
        this.startupPending.delete(entry.run_id);
      } else await this.step(entry);
    } catch (error) {
      this.report(
        new Error(
          `Cannot ${reconciling ? "reconcile" : "poll"} SHUD run ${entry.run_id} at ${entry.run_dir}`,
          { cause: error },
        ),
      );
    }
  }

  private async reconcile(entry: IndexEntry): Promise<void> {
    const routed = await readRunFile(entry);
    const notify = RunJobSchema.shape.notify.safeParse(routed.raw.notify);
    if (!notify.success) throw validationFailure("startup notification", notify.error.issues);
    if (notify.data.status !== "pending" || isTerminal(routed.status)) {
      await this.reconcileCompletion(entry, routed, notify.data.status);
      return;
    }
    const record = RunJobSchema.parse(routed.raw);
    let decision: ReconcileDecision;
    if (routed.status === "created") {
      decision = reconcileEntry({ status: "created", notify: "pending" });
    } else if (routed.status === "submitted") {
      const evidence = await readExit(record.run_dir);
      const snapshot = {
        status: "submitted",
        notify: "pending",
        submitted_at: record.submitted_at,
        exit: evidence,
        wrapper: evidence
          ? null
          : await this.readWrapperProcess(record.run_dir, record.submitted_at),
      } satisfies ReconcileSnapshot;
      decision = reconcileEntry(snapshot);
      if (decision.row === "R4") {
        // Missing, dead or too-old wrapper evidence cannot outrank a concurrently published exit.
        snapshot.exit = await readExit(record.run_dir);
        decision = reconcileEntry(snapshot);
      }
    } else {
      if (record.pid === null || record.pid_started_at === null)
        throw new CollectFailure("running recovery identity", "MISSING");
      const evidence = await readExit(record.run_dir);
      const snapshot = {
        status: "running",
        notify: "pending",
        identity: { pid: record.pid, pid_started_at: record.pid_started_at },
        cancel_requested_at: record.cancel_requested_at,
        exit: evidence,
        process: evidence ? null : this.observeProcess(record.pid),
      } satisfies ReconcileSnapshot;
      decision = reconcileEntry(snapshot);
      if (decision.row === "R7") {
        snapshot.exit = await readExit(record.run_dir);
        decision = reconcileEntry(snapshot);
      }
    }
    if (decision.action === "monitor") return;
    if (decision.action === "promote") {
      const identity = decision.identity;
      updateRunJob(
        entry,
        (current) => {
          if (current.status !== "submitted") return current;
          if (current.submitted_at !== record.submitted_at)
            throw new CollectFailure("startup promotion", "MISMATCH");
          return {
            ...current,
            ...identity,
            status: "running",
            started_at: identity.pid_started_at,
          };
        },
        routed,
      );
      return;
    }
    let evidence = decision.action === "settle-exit" ? decision.evidence : undefined;
    if (decision.action === "cancel-group") {
      this.cancellations.recover(entry, routed);
      while (!this.cancellations.advance(entry.run_id)) await delay(this.pumpPollMs);
      // The leader may have published its exit while the retained group was becoming quiet.
      evidence = await readExit(record.run_dir);
    }
    await this.settle(
      entry,
      routed,
      evidence,
      decision.row === "R1"
        ? "SHUD lost: host exited before starting SHUD"
        : "SHUD lost: wrapper no longer executing and exit_code is absent",
    );
    const terminal = await readRunFile(entry);
    if (isTerminal(terminal.status)) await collectRun(entry, terminal, true);
  }

  private async reconcileCompletion(
    entry: IndexEntry,
    routed: RoutedRun,
    notify: RunJob["notify"]["status"],
  ): Promise<void> {
    let checkpoint: CollectCheckpoint | undefined;
    let snapshot: ReconcileSnapshot;
    if (notify !== "pending") {
      snapshot = { status: routed.status, notify };
    } else if (routed.status === "collected") {
      snapshot = { status: "collected", notify };
    } else if (
      routed.status === "succeeded" ||
      routed.status === "failed" ||
      routed.status === "cancelled"
    ) {
      checkpoint = await readCollectCheckpoint(entry);
      snapshot = {
        status: routed.status,
        notify,
        collection: {
          committed: checkpoint.kind === "committed",
          attempts: checkpoint.kind === "generation" ? (checkpoint.ledger?.attempts ?? 0) : 0,
        },
      };
    } else throw new CollectFailure("startup completion", "NOT_TERMINAL");
    const decision = reconcileEntry(snapshot);
    switch (decision.action) {
      case "complete-index":
        await this.indexes.completeActive(entry.run_id);
        return;
      case "collect":
        await collectRun(entry, routed, true, checkpoint);
        return;
      case "retain-terminal":
      case "retain-collected":
        return;
      default:
        throw new CollectFailure("startup completion", "INVALID_ACTION");
    }
  }

  private async readWrapperProcess(
    runDir: string,
    submittedAt: string | null,
  ): Promise<ProcessBirthObservation | null> {
    if (submittedAt === null || !Number.isFinite(Date.parse(submittedAt)))
      throw new CollectFailure("wrapper birth", "INVALID_SUBMITTED_AT");
    const submissionSecondMs = Math.floor(Date.parse(submittedAt) / 1000) * 1000;
    const path = join(runDir, "wrapper.pid");
    let pid: number;
    try {
      if (!(await regularFile(path, "wrapper pid", true))) return null;
      const token = (await readFile(path, "utf8")).trim();
      pid = Number(token);
      if (!/^\d+$/u.test(token) || !Number.isSafeInteger(pid) || pid <= 0)
        throw new CollectFailure("wrapper pid", "INVALID_PID");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw collectFailure("wrapper pid", error);
    }
    return processBirthObservation(pid, submissionSecondMs);
  }

  private observeProcess(pid: number): ReconcileProcess | null {
    const observed = processExecutionState(pid);
    if (!observed) return null;
    return {
      pid,
      pid_started_at: new Date(`${observed.stamp} UTC`).toISOString(),
      state: observed.state,
    };
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
      else {
        if (!this.cancellations.advance(entry.run_id)) return;
        this.cancellations.release(entry.run_id);
        await collectRun(entry, routed, true);
      }
      return;
    }
    // Running settlement still requires the complete schema before any mutation.
    const record = RunJobSchema.parse(routed.raw);
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

    await this.settle(
      entry,
      routed,
      evidence,
      "SHUD lost: wrapper no longer executing and exit_code is absent",
    );
  }

  private async settle(
    entry: IndexEntry,
    routed: RoutedRun,
    evidence: ExitEvidence | undefined,
    lostDetail: string,
  ): Promise<void> {
    const receipt = this.receipts.get(entry.run_id);
    const path = join(entry.run_dir, "run-job.json");

    await regularFile(path, "run metadata");
    let outcome: JobOutcome | undefined;
    const terminal = updateRunJob(
      entry,
      (current) => {
        if (current.status !== routed.status) return current;
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
            detail: lostDetail,
          };
        }
        return { ...current, status, exit_code: code, finished_at: new Date().toISOString() };
      },
      routed,
    );
    if (!isTerminal(terminal.status)) return;
    if (outcome && evidence?.error) this.report(evidence.error);
    if (receipt) {
      receipt.outcome = outcome ?? receipt.outcome ?? terminalOutcome(terminal);
      await this.complete(entry.run_id, receipt, receipt.outcome);
    } else {
      if (!this.cancellations.advance(entry.run_id))
        throw new Error("Recovered SHUD cancellation is waiting for owned group quiescence");
      this.cancellations.release(entry.run_id);
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
