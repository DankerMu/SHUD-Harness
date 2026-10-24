import type { JobHooks, JobId } from "@deepseek-ai/dsh-jobs";
import { KILL_GRACE_PERIOD_MS, type RunId } from "@shud-harness/dsh-shud-core";
import type { ShudExecution, ShudProcessIdentity } from "./detached-shud.ts";
import type { IndexEntry } from "./state-indexes.ts";
import { recoverProcessGroup, type ShudProcessGroup } from "./process-group.ts";
import {
  CollectFailure,
  collectFailure,
  isTerminal,
  updateRunJob,
  type RoutedRun,
} from "./shud-run-file.ts";

interface CancellationState {
  requestedAt?: number;
  termSent: boolean;
  killSent: boolean;
}

interface ManagedRun extends CancellationState {
  id: JobId;
  entry: IndexEntry;
  location: Pick<RoutedRun, "parent" | "directory">;
  execution?: ShudExecution;
  identity?: ShudProcessIdentity;
  markedAt?: string;
}

interface RecoveredRun extends CancellationState {
  group: ShudProcessGroup;
}

/** Local registrations and separately proven recovered groups share one cancellation deadline path. */
export class ShudCancellation {
  private readonly registrations = new Map<JobId, ManagedRun>();
  private readonly runs = new Map<RunId, ManagedRun>();
  private readonly recovered = new Map<RunId, RecoveredRun>();
  private accepting = true;

  register(id: JobId, entry: IndexEntry, location: ManagedRun["location"]): void {
    const managed: ManagedRun = { id, entry, location, termSent: false, killSent: false };
    this.registrations.set(id, managed);
    this.runs.set(entry.run_id, managed);
  }

  owns(id: JobId): boolean {
    return this.registrations.has(id);
  }

  runId(id: JobId): RunId {
    return this.requireRegistration(id).entry.run_id;
  }

  attach(id: JobId, execution: ShudExecution): JobHooks {
    const managed = this.requireRegistration(id);
    managed.execution = execution;
    return {
      done: execution.hooks.done,
      cancel: (reason) => {
        const markedAt = managed.markedAt;
        managed.markedAt = undefined;
        if (markedAt === undefined) {
          execution.hooks.cancel(reason);
          return;
        }
        managed.requestedAt ??= Date.parse(markedAt);
        if (!managed.termSent) {
          execution.signalGroup("SIGTERM");
          managed.termSent = true;
        }
      },
    };
  }

  activate(id: JobId, identity: ShudProcessIdentity): void {
    this.requireRegistration(id).identity = identity;
  }

  request<T>(id: JobId, inSubmission: boolean, parentKill: () => T): T | "already-finished" {
    if (!this.accepting) throw new Error("SHUD kill admission is closed");
    if (inSubmission) throw new Error("SHUD kill rejected: submission is in flight");
    const managed = this.requireRegistration(id);
    const identity = managed.identity;
    const execution = managed.execution;
    if (!identity || !execution) throw new Error("SHUD execution is not ready for kill");
    const intent = updateRunJob(
      managed.entry,
      (current) => {
        if (
          current.dsh_job_id !== id ||
          current.pid !== identity.pid ||
          current.pid_started_at === null ||
          Date.parse(current.pid_started_at) !== Date.parse(identity.pid_started_at)
        ) {
          throw new CollectFailure("kill identity", "MISMATCH");
        }
        if (current.status === "created" || current.status === "submitted") {
          throw new CollectFailure("kill request", "NOT_RUNNING");
        }
        if (isTerminal(current.status)) return current;
        try {
          execution.isGroupActive();
        } catch (error) {
          throw collectFailure("kill ownership", error);
        }
        return current.cancel_requested_at === null
          ? { ...current, cancel_requested_at: new Date().toISOString() }
          : current;
      },
      managed.location,
    );
    if (isTerminal(intent.status)) return "already-finished";
    if (intent.cancel_requested_at === null)
      throw new Error("Cancellation intent was not persisted");
    managed.markedAt = intent.cancel_requested_at;
    try {
      return parentKill();
    } finally {
      // Parent throw/already-finished revokes only the one-shot mark, never durable intent.
      managed.markedAt = undefined;
    }
  }

  recover(entry: IndexEntry, location: Pick<RoutedRun, "parent" | "directory">): void {
    if (this.recovered.has(entry.run_id)) return;
    if (this.runs.has(entry.run_id))
      throw new Error("Cannot recover a locally registered SHUD execution");
    updateRunJob(
      entry,
      (current) => {
        if (
          current.status !== "running" ||
          current.pid === null ||
          current.pid_started_at === null ||
          current.cancel_requested_at === null
        ) {
          throw new CollectFailure("recovered cancellation", "NOT_REQUESTED");
        }
        const group = recoverProcessGroup({
          pid: current.pid,
          pid_started_at: current.pid_started_at,
        });
        // Publish ownership before attempting any signal; inspection/TERM failures retain it.
        this.recovered.set(entry.run_id, {
          group,
          requestedAt: Date.parse(current.cancel_requested_at),
          termSent: false,
          killSent: false,
        });
        return current;
      },
      location,
    );
  }

  /** Called only by the existing dispatcher; no cancellation timer or background task. */
  advance(runId: RunId): boolean {
    const managed = this.runs.get(runId);
    const recovered = this.recovered.get(runId);
    const state = recovered ?? managed;
    if (!state || state.requestedAt === undefined) return true;
    const group = recovered ? recovered.group : managed?.execution;
    if (!group) throw new Error("Requested SHUD cancellation has no owned execution");
    if (!group.isGroupActive()) return true;
    if (!state.termSent) {
      group.signalGroup("SIGTERM");
      state.termSent = true;
    }
    if (!state.killSent && Date.now() - state.requestedAt >= KILL_GRACE_PERIOD_MS) {
      group.signalGroup("SIGKILL");
      state.killSent = true;
    }
    return !group.isGroupActive();
  }

  async waitForExit(runId: RunId): Promise<void> {
    const managed = this.runs.get(runId);
    if (managed?.requestedAt !== undefined) await managed.execution?.waitForExit();
  }

  release(runId: RunId): void {
    const managed = this.runs.get(runId);
    if (managed) this.registrations.delete(managed.id);
    this.runs.delete(runId);
    this.recovered.delete(runId);
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  private requireRegistration(id: JobId): ManagedRun {
    const managed = this.registrations.get(id);
    if (!managed) throw new Error("SHUD registration is not managed by this instance");
    return managed;
  }
}
