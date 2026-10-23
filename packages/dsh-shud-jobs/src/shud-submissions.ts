import type { Stats } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { JobHandle, JobId } from "@deepseek-ai/dsh-jobs";
import type { LocalJobRegistry } from "@deepseek-ai/dsh-jobs-local";
import {
  generateRunIdentifiers,
  RunJobSchema,
  type JobRecordId,
  type RunId,
  type RunJob,
} from "@shud-harness/dsh-shud-core";
import type { Config } from "./registry.ts";
import type { StateIndexStore } from "./state-indexes.ts";
import { writeJson } from "./state-files.ts";
import { stdoutSource } from "./file-output.ts";
import { updateEnd } from "./shud-end.ts";
import {
  copyInput,
  existingPath,
  prepareInput,
  realDirectory,
  verifyRun,
  type PreparedInput,
  type SubmitShudRequest,
} from "./shud-input.ts";
import { registerUnowned } from "./shud-registration.ts";
import type { ShudExecution, ShudProcessIdentity } from "./detached-shud.ts";
import type { CompletionReceipt } from "./shud-poll.ts";

export type ShudProducer = (
  prepared: RunJob,
  handle: JobHandle,
  pumpPollMs: number,
) => ShudExecution;

interface Reservation {
  run_id: RunId;
  job_id: JobRecordId;
  runDir: string;
}

export class ShudSubmissions {
  private readonly registry: LocalJobRegistry;
  private readonly indexes: StateIndexStore;
  private readonly config: Config;
  private readonly waitMs: number;
  private readonly receipts: Map<RunId, CompletionReceipt>;
  private readonly reservedRuns = new Set<RunId>();
  private readonly reservedJobs = new Set<JobRecordId>();
  private readonly inFlight = new Set<RunId>();
  private readonly pending = new Set<Promise<RunJob>>();
  private accepting = true;

  constructor(
    registry: LocalJobRegistry,
    indexes: StateIndexStore,
    config: Config,
    waitMs: number,
    receipts: Map<RunId, CompletionReceipt>,
  ) {
    this.registry = registry;
    this.indexes = indexes;
    this.config = config;
    this.waitMs = waitMs;
    this.receipts = receipts;
  }

  isInFlight(id: RunId): boolean {
    return this.inFlight.has(id);
  }

  submit(request: SubmitShudRequest, producer: ShudProducer): Promise<RunJob> {
    if (!this.accepting) return Promise.reject(new Error("SHUD submission admission is closed"));
    try {
      if (typeof producer !== "function")
        throw new Error("submitShud requires an execution producer");
      const input = prepareInput(request, this.config.stateDir);
      // The id pair is claimed before execute reaches its first filesystem await.
      const reservation = this.reserve(input);
      const operation = this.execute(input, reservation, producer);
      this.pending.add(operation);
      void operation.then(
        () => {
          this.pending.delete(operation);
        },
        () => {
          this.pending.delete(operation);
        },
      );
      return operation;
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error("Submission preflight failed", { cause: error }),
      );
    }
  }

  private reserve(input: PreparedInput): Reservation {
    for (;;) {
      const ids = generateRunIdentifiers();
      const runDir = join(input.runsDir, ids.run_id);
      if (
        this.reservedRuns.has(ids.run_id) ||
        this.reservedJobs.has(ids.job_id) ||
        this.indexes.lookup(ids.run_id) ||
        this.indexes.lookup(ids.job_id) ||
        existingPath(runDir)
      )
        continue;
      this.reservedRuns.add(ids.run_id);
      this.reservedJobs.add(ids.job_id);
      return { ...ids, runDir };
    }
  }

  private releaseReservation(reservation: Reservation): void {
    this.reservedRuns.delete(reservation.run_id);
    this.reservedJobs.delete(reservation.job_id);
  }

  private async execute(
    input: PreparedInput,
    initial: Reservation,
    producer: ShudProducer,
  ): Promise<RunJob> {
    let reservation = initial;
    let parent: Stats | undefined;
    let owned: Stats | undefined;
    let created = false;
    let indexed = false;
    const execution: {
      value?: ShudExecution;
      startup?: Promise<{ identity: ShudProcessIdentity } | { error: unknown }>;
    } = {};
    let registered: JobId | undefined;
    let releaseReservation = true;
    try {
      try {
        await io.mkdir(input.runsDir);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      parent = realDirectory(input.runsDir);
      for (;;) {
        realDirectory(input.runsDir);
        try {
          await io.mkdir(reservation.runDir);
          created = true;
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          this.releaseReservation(reservation);
          reservation = this.reserve(input);
        }
      }
      owned = await io.lstat(reservation.runDir);
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      const inputBytes = await copyInput(input, reservation.runDir);
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      if (input.endDays !== null)
        await updateEnd(
          join(reservation.runDir, "input", input.project, `${input.project}.cfg.para`),
          input.endDays,
        );
      await io.mkdir(join(reservation.runDir, "output"));
      await io.writeFile(join(reservation.runDir, "stdout.log"), "", { flag: "wx" });
      await io.writeFile(join(reservation.runDir, "stderr.log"), "", { flag: "wx" });
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      let record = RunJobSchema.parse({
        run_id: reservation.run_id,
        job_id: reservation.job_id,
        task_id: null,
        stack_id: null,
        data_id: null,
        backend: "local_job",
        status: "created",
        project: input.project,
        label: input.label,
        input_dir: input.inputDir,
        run_dir: reservation.runDir,
        command: [this.config.shudBin, "-o", `output/${input.project}.out`, input.project],
        end_days: input.endDays,
        owner_session: input.ownerSession,
        dsh_job_id: null,
        dsh_job_ids: [],
        pid: null,
        pid_started_at: null,
        input_bytes: inputBytes,
        submitted_at: null,
        started_at: null,
        finished_at: null,
        cancel_requested_at: null,
        exit_code: null,
        llm: input.llm,
        notify: { status: "pending", attempts: 0, at: null, detail: null },
      });
      const recordPath = join(reservation.runDir, "run-job.json");
      this.inFlight.add(record.run_id);
      await writeJson(recordPath, record);
      await this.indexes.addActive({
        run_id: record.run_id,
        job_id: record.job_id,
        run_dir: record.run_dir,
      });
      indexed = true;
      record = RunJobSchema.parse({
        ...record,
        status: "submitted",
        submitted_at: new Date().toISOString(),
      });
      await writeJson(recordPath, record);
      registered = registerUnowned(this.registry, {
        kind: "shud",
        label: record.label === null ? record.run_id : `${record.run_id} ${record.label}`,
        output: [stdoutSource(join(record.run_dir, "stdout.log"))],
        run: (handle) => {
          execution.value = producer(record, handle, this.waitMs);
          // Observe rejection before the identified-record write yields; keep its error for rollback.
          execution.startup = execution.value.started.then(
            (identity) => ({ identity }),
            (error: unknown) => ({ error }),
          );
          return execution.value.hooks;
        },
      });
      record = RunJobSchema.parse({
        ...record,
        dsh_job_id: registered,
        dsh_job_ids: [...record.dsh_job_ids, registered],
      });
      await writeJson(recordPath, record);
      if (!execution.startup || !execution.value)
        throw new Error("SHUD producer did not provide startup identity");
      const lifecycle = execution.value.hooks;
      const startup = await execution.startup;
      if ("error" in startup) throw startup.error;
      record = RunJobSchema.parse({
        ...record,
        status: "running",
        pid: startup.identity.pid,
        pid_started_at: startup.identity.pid_started_at,
        started_at: startup.identity.pid_started_at,
      });
      await writeJson(recordPath, record);
      this.receipts.set(record.run_id, { lifecycle });
      this.inFlight.delete(record.run_id);
      return record;
    } catch (error) {
      this.receipts.delete(reservation.run_id);
      try {
        if (execution.value) {
          await execution.value.abort();
          execution.value.hooks.cancel("SHUD submission rolled back");
          await execution.value.hooks.done;
        }
        if (registered) {
          // Teardown may already have removed the entry; otherwise wait for the parent's final drain.
          while (this.registry.list().some((job) => job.id === registered)) {
            const view = await this.registry.wait(registered, this.waitMs);
            if (view.status !== "running" && view.status !== "stopping") {
              if (this.registry.list().some((job) => job.id === registered))
                this.registry.remove(registered);
              break;
            }
          }
        }
        if (indexed) await this.indexes.removeActive(reservation.run_id);
        if (created && existingPath(reservation.runDir)) {
          if (!parent || !owned)
            throw new Error("Cannot verify ownership of newly claimed run directory", {
              cause: error,
            });
          verifyRun(input.runsDir, parent, reservation.runDir, owned);
          await io.rm(reservation.runDir, { recursive: true });
        }
        this.inFlight.delete(reservation.run_id);
      } catch (cleanup) {
        releaseReservation = false;
        throw new AggregateError(
          [error, cleanup],
          `SHUD submission failed; cleanup incomplete, retained run path: ${reservation.runDir}`,
          { cause: cleanup },
        );
      }
      throw error;
    } finally {
      if (releaseReservation) this.releaseReservation(reservation);
    }
  }

  stopAdmission(): void {
    this.accepting = false;
  }

  /** The common lifecycle owner closes indexes only after both submissions and polling drain. */
  drain(): Promise<void> {
    return Promise.allSettled(this.pending).then(() => undefined);
  }
}
