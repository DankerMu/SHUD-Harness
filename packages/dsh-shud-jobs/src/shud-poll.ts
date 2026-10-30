import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JobId, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";
import type { SessionController } from "@deepseek-ai/dsh-api-session-controller";
import type { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import {
  MAX_COLLECT_ATTEMPTS,
  MAX_NOTIFY_ATTEMPTS,
  NOTIFY_RETRY_INTERVAL_MS,
  RunJobSchema,
  type JobRecordId,
  type RunId,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import type { ShudCompletion, ShudControl, ShudProcessIdentity } from "./detached-shud.ts";
import { stdoutSource } from "./file-output.ts";
import { recoverProcessGroup } from "./process-group.ts";
import {
  createShudCompletion,
  registerUnowned,
  registrationLabel,
  removeSettledRegistration,
} from "./shud-registration.ts";
import { processExecutionState } from "./process-identity.ts";
import { processBirthObservation, type ProcessBirthObservation } from "./process-birth.ts";
import type { IndexEntry, StateIndexStore } from "./state-indexes.ts";
import {
  collectRun,
  matchesRunStart,
  readCollectCheckpoint,
  readCollectedRecord,
  type CollectShudOptions,
  type CollectCheckpoint,
  type RunStartObservation,
  type RunTerminalObservation,
} from "./shud-collect.ts";
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
  normalizeCollectFailureReason,
  readRunFile,
  regularFile,
  validationFailure,
  updateRunJob,
  type RoutedRun,
} from "./shud-run-file.ts";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "shud-jobs": { kind: "shud-jobs" } & ContextFormed;
  }
}

interface DeliveryServices {
  controller: Pick<SessionController, "resolveAgent">;
  sessions: Pick<SessionStore, "flush">;
}

interface ConfirmedAppend extends IndexEntry {
  flushed: boolean;
}

// Ordinary registry reload retains live Sessions; a process crash discards these receipts.
// The directory lookup is qualified by both persisted identifiers before any receipt is reused.
const confirmedAppends = new WeakMap<Session, Map<string, ConfirmedAppend>>();
const NOTIFY_FLUSH_FAILURE_DETAIL = "SHUD notification flush was not acknowledged";
const NOTIFY_RESTORE_FAILURE_DETAIL = "SHUD notification session restoration failed";
const NOTIFY_WAITING_DETAIL = "Waiting for session services";

interface PendingNotificationFailure extends IndexEntry {
  owner_session: RunJob["owner_session"];
  previousAttempts: number;
  previousAt: string | null;
  notify: RunJob["notify"];
  clearConfirmedAppend: (() => void) | undefined;
}

// Failed publication is not another transport attempt. Keep its original accounting until
// durable publication, including across registry reloads where no Session was ever resolved.
const pendingNotificationFailures = new Map<string, PendingNotificationFailure>();

function sameRun(first: IndexEntry, second: IndexEntry): boolean {
  return (
    first.run_id === second.run_id &&
    first.job_id === second.job_id &&
    first.run_dir === second.run_dir
  );
}

export interface CompletionReceipt {
  lifecycle: ShudCompletion;
  originalStart: RunStartObservation | null;
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

function verifyTakeoverIdentity(record: RunJob, identity: ShudProcessIdentity): void {
  if (
    record.status !== "running" ||
    record.notify.status !== "pending" ||
    record.cancel_requested_at !== null ||
    record.pid !== identity.pid ||
    record.pid_started_at === null ||
    Date.parse(record.pid_started_at) !== Date.parse(identity.pid_started_at)
  ) {
    throw new CollectFailure("takeover identity", "MISMATCH");
  }
}

/** One cadence and one per-run exclusion map serve timer ticks and public manual ticks alike. */
export class ShudPoll {
  private readonly steps = new Map<RunId, Promise<void>>();
  private readonly startupPending = new Set<RunId>();
  private readonly observations = new Map<RunId, RunTerminalObservation>();
  private accepting = true;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly registry: LocalJobRegistry;
  private readonly indexes: StateIndexStore;
  private readonly receipts: Map<RunId, CompletionReceipt>;
  private readonly cancellations: ShudCancellation;
  private readonly inSubmission: (id: RunId) => boolean;
  private readonly pumpPollMs: number;
  private readonly report: (error: Error) => void;
  private readonly warn: (message: string) => void;
  private delivery: DeliveryServices | undefined;

  constructor(
    registry: LocalJobRegistry,
    indexes: StateIndexStore,
    receipts: Map<RunId, CompletionReceipt>,
    cancellations: ShudCancellation,
    inSubmission: (id: RunId) => boolean,
    pumpPollMs: number,
    report: (error: Error) => void,
    warn: (message: string) => void,
  ) {
    this.registry = registry;
    this.indexes = indexes;
    this.receipts = receipts;
    this.cancellations = cancellations;
    this.inSubmission = inSubmission;
    this.pumpPollMs = pumpPollMs;
    this.report = report;
    this.warn = warn;
  }

  enableDelivery(
    controller: DeliveryServices["controller"],
    sessions: DeliveryServices["sessions"],
  ): () => void {
    const epoch = { controller, sessions };
    this.delivery = epoch;
    return () => {
      if (this.delivery === epoch) this.delivery = undefined;
    };
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

  collectShud(id: RunId | JobRecordId, options: CollectShudOptions = {}): Promise<RunRecord> {
    try {
      if (!this.accepting) throw new CollectFailure("admission", "CLOSED");
      const entry = this.indexes.lookup(id);
      if (!entry) throw new CollectFailure("request", "UNKNOWN_ID");
      // D7 is an admission decision, even if submission completes while this read is queued.
      const submissionInFlight = this.inSubmission(entry.run_id);
      const readonly = options.readonly === true;
      return this.enqueue(entry.run_id, async () => {
        const routed = await readRunFile(entry);
        if (submissionInFlight || !isTerminal(routed.status)) {
          const currentId = RunJobSchema.shape.dsh_job_id.safeParse(routed.raw.dsh_job_id);
          if (!currentId.success)
            throw validationFailure("run metadata", [{ path: ["dsh_job_id"] }]);
          const failure = new CollectFailure(
            "request",
            submissionInFlight ? "SUBMISSION_IN_FLIGHT" : "NOT_TERMINAL",
          );
          failure.message += ` (status=${routed.status}, dsh_job_id=${currentId.data ?? "null"})`;
          throw failure;
        }
        if (readonly) return readCollectedRecord(entry, routed);
        const receipt = this.receipts.get(entry.run_id);
        if (receipt) await this.complete(entry.run_id, receipt, receiptOutcome(routed, receipt));
        return this.collect(entry, routed, false);
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
    if (decision.action === "monitor") {
      await this.takeoverRunning(entry, record, routed);
      return;
    }
    if (decision.action === "promote") {
      const identity = decision.identity;
      const promoted = updateRunJob(
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
      if (promoted.status === "running") await this.takeoverRunning(entry, promoted, routed);
      return;
    }
    let evidence = decision.action === "settle-exit" ? decision.evidence : undefined;
    if (decision.action === "cancel-group") {
      this.cancellations.recover(entry, routed);
      while (!this.cancellations.advance(entry.run_id)) await delay(this.pumpPollMs);
      // The leader may have published its exit while the retained group was becoming quiet.
      evidence = await readExit(record.run_dir);
    }
    // Settlement releases retained R8 control; a later R7 classification cannot erase it.
    const hadRecoveredControl = this.cancellations.hasRecoveredControl(entry.run_id);
    await this.settle(
      entry,
      routed,
      evidence,
      decision.row === "R1"
        ? "SHUD lost: host exited before starting SHUD"
        : "SHUD lost: wrapper no longer executing and exit_code is absent",
    );
    const terminal = await readRunFile(entry);
    if (isTerminal(terminal.status)) {
      if (decision.row === "R7" && !hadRecoveredControl) {
        this.warn(
          `R7 run_id=${record.run_id} recorded_pid=${record.pid} recorded_pid_started_at=${record.pid_started_at}: ` +
            "recorded wrapper identity is no longer live/matching; historical group quiescence is unverified; " +
            "no signal is sent to an unowned historical group; descendants may remain; " +
            "cancelled/lost is not proof that the historical group stopped.",
        );
      }
      await this.collect(entry, terminal, true);
    }
  }

  private async takeoverRunning(
    entry: IndexEntry,
    observed: RunJob,
    routed: RoutedRun,
  ): Promise<void> {
    if (this.cancellations.hasRegistration(entry.run_id)) return;
    if (observed.pid === null || observed.pid_started_at === null)
      throw new CollectFailure("takeover identity", "MISSING");
    const identity = { pid: observed.pid, pid_started_at: observed.pid_started_at };
    const record = updateRunJob(
      entry,
      (current) => {
        verifyTakeoverIdentity(current, identity);
        return current.dsh_job_id === null ? current : { ...current, dsh_job_id: null };
      },
      routed,
    );
    const group = recoverProcessGroup(identity);
    const lifecycle = createShudCompletion();
    const control: ShudControl = { ...group, hooks: lifecycle };
    let registered: JobId | undefined;
    try {
      const id = registerUnowned(this.registry, {
        kind: "shud",
        label: registrationLabel(record),
        output: [stdoutSource(join(record.run_dir, "stdout.log"))],
        run: (handle) => {
          registered = handle.id;
          this.cancellations.register(handle.id, entry, routed);
          const hooks = this.cancellations.attach(handle.id, control);
          this.cancellations.activate(handle.id, identity);
          return hooks;
        },
      });
      // Parent start exposed its bound hooks. Do not yield before current-id publication.
      updateRunJob(
        entry,
        (current) => {
          verifyTakeoverIdentity(current, identity);
          if (current.dsh_job_id !== null)
            throw new CollectFailure("takeover registration", "MISMATCH");
          return {
            ...current,
            dsh_job_id: id,
            dsh_job_ids: [...current.dsh_job_ids, id],
          };
        },
        routed,
      );
      this.receipts.set(entry.run_id, { lifecycle, originalStart: null });
    } catch (error) {
      this.report(
        new Error(`Cannot register SHUD takeover for run ${entry.run_id}`, {
          cause: collectFailure("takeover registration", error),
        }),
      );
      if (registered !== undefined) {
        try {
          lifecycle.detach("SHUD takeover registration rolled back");
          await removeSettledRegistration(this.registry, registered, this.pumpPollMs);
          this.cancellations.release(entry.run_id);
        } catch (cleanup) {
          // Keep classification until the parent's entry is actually drained and removed.
          this.report(
            new Error(`Cannot clean up SHUD takeover for run ${entry.run_id}`, {
              cause: collectFailure("takeover registration cleanup", cleanup),
            }),
          );
        }
      }
      // Normal startup completion switches to file-only monitoring without registration retries.
    }
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
      if (checkpoint.kind === "committed") this.observations.delete(entry.run_id);
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
        await this.completeNotified(entry, routed.raw.notify);
        return;
      case "collect":
        await this.collect(entry, routed, true, checkpoint);
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
    if (notificationFinished(routed.raw)) {
      await this.completeNotified(entry, routed.raw.notify);
      return;
    }
    if (routed.status === "collected") {
      await this.deliverNotification(entry, routed);
      return;
    }
    if (routed.status === "created" || routed.status === "submitted") return;
    const receipt = this.receipts.get(entry.run_id);
    if (routed.status !== "running") {
      if (receipt) await this.complete(entry.run_id, receipt, receiptOutcome(routed, receipt));
      else {
        if (!this.cancellations.advance(entry.run_id)) return;
        this.cancellations.release(entry.run_id);
        const checkpoint = await readCollectCheckpoint(entry);
        if (
          checkpoint.kind === "generation" &&
          checkpoint.ledger &&
          checkpoint.ledger.attempts >= MAX_COLLECT_ATTEMPTS
        )
          await this.deliverNotification(entry, routed, checkpoint);
        else await this.collect(entry, routed, true, checkpoint);
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

  private collect(
    entry: IndexEntry,
    routed: RoutedRun,
    automatic: false,
    preparedCheckpoint?: CollectCheckpoint,
  ): Promise<RunRecord>;
  private collect(
    entry: IndexEntry,
    routed: RoutedRun,
    automatic: boolean,
    preparedCheckpoint?: CollectCheckpoint,
  ): Promise<RunRecord | undefined>;
  private async collect(
    entry: IndexEntry,
    routed: RoutedRun,
    automatic: boolean,
    preparedCheckpoint?: CollectCheckpoint,
  ): Promise<RunRecord | undefined> {
    const checkpoint = preparedCheckpoint ?? (await readCollectCheckpoint(entry));
    if (checkpoint.kind === "committed") this.observations.delete(entry.run_id);
    const result = await collectRun(
      entry,
      routed,
      automatic,
      this.observations.get(entry.run_id),
      checkpoint,
    );
    if (result) this.observations.delete(entry.run_id);
    return result;
  }

  /** The dispatcher owns exclusion and drains this publication before releasing state ownership. */
  private async completeNotified(entry: IndexEntry, rawNotify: unknown): Promise<void> {
    const notify = RunJobSchema.shape.notify.safeParse(rawNotify);
    if (!notify.success) throw validationFailure("notification completion", notify.error.issues);
    if (notify.data.status === "pending")
      throw new CollectFailure("notification completion", "PENDING");
    const pending = pendingNotificationFailures.get(entry.run_dir);
    if (pending) {
      pendingNotificationFailures.delete(entry.run_dir);
      pending.clearConfirmedAppend?.();
    }
    await this.indexes.completeActive(entry.run_id);
    this.observations.delete(entry.run_id);
  }

  private async deliverNotification(
    entry: IndexEntry,
    routed: RoutedRun,
    preparedCheckpoint?: CollectCheckpoint,
  ): Promise<void> {
    const epoch = this.delivery;
    const record = RunJobSchema.parse(routed.raw);
    if (record.notify.status !== "pending") return;
    const checkpoint = preparedCheckpoint ?? (await readCollectCheckpoint(entry));
    let outcome: RunRecord | string;
    if (checkpoint.kind === "committed") {
      this.observations.delete(entry.run_id);
      if (record.status !== "collected")
        throw new CollectFailure("notification checkpoint", "NOT_COLLECTED");
      outcome = checkpoint.record;
    } else {
      if (checkpoint.existingFailure) throw checkpoint.existingFailure;
      if (record.status === "collected")
        throw new CollectFailure("notification checkpoint", "MISSING_RESULT");
      if (
        !isTerminal(record.status) ||
        !checkpoint.ledger ||
        checkpoint.ledger.attempts < MAX_COLLECT_ATTEMPTS
      )
        return;
      outcome = normalizeCollectFailureReason(checkpoint.ledger.last_error);
    }
    const verifyOwner = (current: RunJob): RunJob => {
      if (
        current.owner_session !== record.owner_session ||
        current.status !== record.status ||
        current.notify.status !== "pending"
      )
        throw new Error("SHUD notification checkpoint changed during delivery");
      return current;
    };
    if (!epoch) {
      updateRunJob(
        entry,
        (current) => {
          verifyOwner(current);
          if (current.notify.detail === NOTIFY_WAITING_DETAIL) return current;
          return { ...current, notify: { ...current.notify, detail: NOTIFY_WAITING_DETAIL } };
        },
        routed,
      );
      return;
    }
    let clearConfirmedAppend: (() => void) | undefined;
    const publishNotification = async (
      transition: (notify: RunJob["notify"]) => RunJob["notify"],
      accounting?: PendingNotificationFailure,
    ): Promise<void> => {
      const published = updateRunJob(
        entry,
        (current) => {
          verifyOwner(current);
          const notify = transition(current.notify);
          return notify === current.notify ? current : { ...current, notify };
        },
        routed,
      );
      if (accounting && pendingNotificationFailures.get(entry.run_dir) === accounting)
        pendingNotificationFailures.delete(entry.run_dir);
      if (published.notify.status === "pending") return;
      clearConfirmedAppend?.();
      await this.completeNotified(entry, published.notify);
    };
    const publishFailure = (failure: PendingNotificationFailure) => {
      clearConfirmedAppend = failure.clearConfirmedAppend;
      return publishNotification((notify) => {
        // A rename may have committed before reporting failure. Never count that attempt twice.
        // Service-readiness presentation can change without changing committed accounting.
        if (
          notify.attempts === failure.notify.attempts &&
          notify.at === failure.notify.at &&
          (notify.detail === failure.notify.detail || notify.detail === NOTIFY_WAITING_DETAIL) &&
          notify.status === failure.notify.status
        )
          return notify;
        if (notify.attempts !== failure.previousAttempts || notify.at !== failure.previousAt)
          throw new Error("SHUD notification accounting checkpoint changed");
        return failure.notify;
      }, failure);
    };
    const failAttempt = (detail: string) => {
      const attempts = record.notify.attempts + 1;
      const failure: PendingNotificationFailure = {
        ...entry,
        owner_session: record.owner_session,
        previousAttempts: record.notify.attempts,
        previousAt: record.notify.at,
        notify: {
          ...record.notify,
          status: attempts >= MAX_NOTIFY_ATTEMPTS ? "unreachable" : "pending",
          attempts,
          at: new Date().toISOString(),
          detail,
        },
        clearConfirmedAppend,
      };
      pendingNotificationFailures.set(entry.run_dir, failure);
      return publishFailure(failure);
    };
    if (this.delivery !== epoch || !this.accepting) return;
    const pending = pendingNotificationFailures.get(entry.run_dir);
    if (pending) {
      if (sameRun(pending, entry) && pending.owner_session === record.owner_session)
        return publishFailure(pending);
      // A replacement run or owner must not inherit another obligation's unpublished failure.
      pendingNotificationFailures.delete(entry.run_dir);
    }
    if (record.notify.attempts >= MAX_NOTIFY_ATTEMPTS)
      return publishNotification((notify) => ({
        ...notify,
        status: "unreachable",
        detail: "SHUD notification retry limit reached",
      }));
    if (record.notify.attempts > 0) {
      if (record.notify.at === null)
        throw new Error("SHUD notification retry timestamp is missing");
      if (Date.now() - Date.parse(record.notify.at) < NOTIFY_RETRY_INTERVAL_MS) return;
    }
    if (record.owner_session === null)
      return publishNotification((notify) => ({
        ...notify,
        status: "unreachable",
        at: new Date().toISOString(),
        detail: "SHUD run has no owner session",
      }));
    let agent: Agent;
    try {
      const resolved = await epoch.controller.resolveAgent(record.owner_session as SessionId);
      if (this.delivery !== epoch || !this.accepting) return;
      if ("error" in resolved) {
        if (resolved.error.code === "session/not-found")
          return publishNotification((notify) => ({
            ...notify,
            status: "unreachable",
            at: new Date().toISOString(),
            detail: "SHUD owner session not found",
          }));
        return failAttempt(NOTIFY_RESTORE_FAILURE_DETAIL);
      }
      agent = resolved.agent;
    } catch {
      // Revoked restoration work must neither publish a failure nor expose host exception text.
      if (this.delivery !== epoch || !this.accepting) return;
      return failAttempt(NOTIFY_RESTORE_FAILURE_DETAIL);
    }
    if (agent.session.id !== record.owner_session)
      throw new Error("SHUD notification resolved a different owner session");
    // Revalidate routing, directory ownership and the current owner immediately before append.
    updateRunJob(entry, verifyOwner, routed);
    const session = agent.session;
    const appends = confirmedAppends.get(session) ?? new Map<string, ConfirmedAppend>();
    let accepted = appends.get(entry.run_dir);
    if (accepted && !sameRun(accepted, entry)) accepted = undefined;
    if (!accepted) {
      const text =
        typeof outcome === "string"
          ? `SHUD run ${record.run_id}: collection failed; ${outcome}.`
          : `SHUD run ${outcome.run_id}: exit_class=${outcome.exit_class}; artifacts=${outcome.artifacts.files.length}.`;
      const message = createUserMessage({
        content: [
          {
            type: "text",
            text,
          },
        ],
        source: { kind: "shud-jobs" },
      });
      // A throw may occur after host append: only a confirmed return establishes this receipt.
      try {
        agent.followup(message);
      } catch {
        if (this.delivery !== epoch || !this.accepting) return;
        return failAttempt("SHUD notification followup failed");
      }
      accepted = { ...entry, flushed: false };
      appends.set(entry.run_dir, accepted);
      confirmedAppends.set(session, appends);
    }
    clearConfirmedAppend = () => {
      if (appends.get(entry.run_dir) === accepted) appends.delete(entry.run_dir);
      if (appends.size === 0) confirmedAppends.delete(session);
    };
    if (!accepted.flushed) {
      let flushed = false;
      try {
        flushed = await epoch.sessions.flush(session);
      } catch {
        // Host exception text is not a durable notification diagnostic.
      }
      if (!flushed) return failAttempt(NOTIFY_FLUSH_FAILURE_DETAIL);
      accepted.flushed = true;
    }
    await publishNotification((notify) => ({
      ...notify,
      status: "delivered",
      at: new Date().toISOString(),
      detail: null,
    }));
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
    const originalStart = receipt?.originalStart;
    // outcome exists only when this transition ran; updateRunJob must also have published it.
    // The existing advance() gate above proves quiescence for a locally requested cancellation.
    if (
      outcome &&
      originalStart &&
      terminal.finished_at !== null &&
      (evidence?.code !== undefined ||
        (terminal.status === "cancelled" && this.cancellations.hasLocalRequest(entry.run_id))) &&
      matchesRunStart(originalStart, terminal)
    ) {
      this.observations.set(entry.run_id, {
        ...originalStart,
        finished_at: terminal.finished_at,
      });
    }
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
    await this.cancellations.waitForLocalExit(runId);
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
    return Promise.allSettled(this.steps.values()).then(() => {
      this.observations.clear();
    });
  }
}
