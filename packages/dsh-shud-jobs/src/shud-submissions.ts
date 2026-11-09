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
import { indexedRuns, type StateIndexStore } from "./state-indexes.ts";
import { captureStackLock, generateProvenance, writeJson } from "@shud-harness/dsh-shud-records";
import { stdoutSource } from "./file-output.ts";
import {
  applyCalibMultiplier,
  ensureOutputInterval,
  SUBMISSION_OUTPUT_INTERVAL,
  updateEnd,
} from "./shud-cfg-rewrite.ts";
import { BuildOwnershipError, prepareBuild, type PreparedBuild } from "./shud-build.ts";
import {
  copyInput,
  existingPath,
  prepareInput,
  realDirectory,
  verifyInputDigests,
  verifyRun,
  type PlanBinding,
  type PreparedInput,
  type SubmitShudRequest,
} from "./shud-input.ts";
import { readRunJobSync, runFailure } from "./shud-run-file.ts";
import { readRunEvidenceSync } from "./shud-collect.ts";
import {
  registerUnowned,
  registrationLabel,
  removeSettledRegistration,
} from "./shud-registration.ts";
import type { ShudExecution, ShudProcessIdentity } from "./detached-shud.ts";
import type { CompletionReceipt } from "./shud-poll.ts";
import type { ShudCancellation } from "./shud-cancellation.ts";

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

interface OwnedProvenance {
  directory: string;
  path: string;
  parent?: Stats;
  file?: Stats;
}

/**
 * Whether this registry's indexes hold a non-failed job of (plan, pset), read synchronously. Failed:
 * RunJob failed/cancelled, a collect-exhausted ledger, or a collected RunRecord with status failed;
 * every indexed RunJob is validated and corrupt evidence fails loudly, never counting as failed.
 */
function indexedNonFailed(
  indexes: StateIndexStore,
  plan: RunJob["analysis_plan_id"],
  set: RunJob["parameter_set_id"],
): boolean {
  const label = "SHUD parameter set check";
  for (const entry of indexedRuns(indexes.read(), label)) {
    let failed: boolean;
    try {
      const { job } = readRunJobSync(entry);
      if (job.analysis_plan_id !== plan || job.parameter_set_id !== set) continue;
      const { exhausted, record } = readRunEvidenceSync(entry, job.status === "collected");
      failed =
        job.status === "failed" ||
        job.status === "cancelled" ||
        exhausted ||
        record?.status === "failed";
    } catch (error) {
      throw runFailure(label, entry, "run metadata", error);
    }
    if (!failed) return true;
  }
  return false;
}

async function removeProvenance(owned: OwnedProvenance): Promise<void> {
  const parent = realDirectory(owned.directory);
  const file = existingPath(owned.path);
  if (
    !owned.parent ||
    !owned.file ||
    !file?.isFile() ||
    parent.dev !== owned.parent.dev ||
    parent.ino !== owned.parent.ino ||
    file.dev !== owned.file.dev ||
    file.ino !== owned.file.ino
  ) {
    throw new Error(`Provenance ownership changed: ${owned.path}`);
  }
  await io.rm(owned.path);
}

export class ShudSubmissions {
  private readonly registry: LocalJobRegistry;
  private readonly indexes: StateIndexStore;
  private readonly config: Config;
  private readonly waitMs: number;
  private readonly receipts: Map<RunId, CompletionReceipt>;
  private readonly cancellations: ShudCancellation;
  private readonly reservedRuns = new Set<RunId>();
  private readonly reservedJobs = new Set<JobRecordId>();
  private readonly inFlight = new Set<RunId>();
  /** In-flight (plan, pset) claims; with the indexes, at most one non-failed job per pair. */
  private readonly claimedSets = new Set<string>();
  private readonly pending = new Set<Promise<RunJob>>();
  private accepting = true;

  constructor(
    registry: LocalJobRegistry,
    indexes: StateIndexStore,
    config: Config,
    waitMs: number,
    receipts: Map<RunId, CompletionReceipt>,
    cancellations: ShudCancellation,
  ) {
    this.registry = registry;
    this.indexes = indexes;
    this.config = config;
    this.waitMs = waitMs;
    this.receipts = receipts;
    this.cancellations = cancellations;
  }

  isInFlight(id: RunId): boolean {
    return this.inFlight.has(id);
  }

  submit(request: SubmitShudRequest, producer: ShudProducer): Promise<RunJob> {
    if (!this.accepting) return Promise.reject(new Error("SHUD submission admission is closed"));
    // Until execute owns it, a claim made in this synchronous segment is released on any throw.
    const claim: { set?: string } = {};
    try {
      if (typeof producer !== "function")
        throw new Error("submitShud requires an execution producer");
      const input = prepareInput(request, this.config.stateDir, (plan) => {
        claim.set = this.claimSet(plan);
      });
      // The id pair is claimed before execute reaches its first filesystem await.
      const reservation = this.reserve(input);
      const operation = this.execute(input, reservation, producer, claim.set);
      claim.set = undefined;
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
      if (claim.set !== undefined) this.claimedSets.delete(claim.set);
      return Promise.reject(
        error instanceof Error ? error : new Error("Submission preflight failed", { cause: error }),
      );
    }
  }

  /** Check and claim a bound pair in one synchronous step; unbound submissions are unchecked. */
  private claimSet(plan: PlanBinding): string | undefined {
    if (plan.analysisPlanId === null || plan.parameterSetId === null) return undefined;
    const key = `${plan.analysisPlanId}/${plan.parameterSetId}`;
    if (
      this.claimedSets.has(key) ||
      indexedNonFailed(this.indexes, plan.analysisPlanId, plan.parameterSetId)
    )
      throw new Error(
        `Parameter set ${plan.parameterSetId} of analysis plan ${plan.analysisPlanId} already has a non-failed run`,
      );
    this.claimedSets.add(key);
    return key;
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
    claimedSet: string | undefined,
  ): Promise<RunJob> {
    let reservation = initial;
    let parent: Stats | undefined;
    let owned: Stats | undefined;
    let created = false;
    let indexed = false;
    let provenance: OwnedProvenance | undefined;
    let preparedBuild: PreparedBuild | undefined;
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
      const location = { parent, directory: owned };
      const inputBytes = await copyInput(input, reservation.runDir);
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      const copy = join(reservation.runDir, "input", input.project);
      const { plan } = input;
      // A plan-bound copy must be the digest-checked baseline input before any rewrite.
      if (plan.inputDigests !== null) verifyInputDigests(copy, plan.inputDigests);
      const parameters = join(copy, `${input.project}.cfg.para`);
      if (input.endDays !== null) await updateEnd(parameters, input.endDays);
      // Every rewrite precedes StackLock/provenance, so provenance hashes exactly the bytes SHUD
      // reads; a failure takes the single rollback below.
      await ensureOutputInterval(
        parameters,
        SUBMISSION_OUTPUT_INTERVAL.key,
        SUBMISSION_OUTPUT_INTERVAL.minutes,
      );
      // Pinned SHUD calls omp_set_num_threads(NUM_OPENMP) over OMP_NUM_THREADS
      // (SHUD/src/classes/Model_Control.cpp:130, SHUD/src/Model/shud.cpp:56).
      if (plan.analysisPlanId !== null && input.threads !== null)
        await ensureOutputInterval(parameters, "NUM_OPENMP", input.threads);
      if (plan.calibOverride !== null)
        await applyCalibMultiplier(
          join(copy, `${input.project}.cfg.calib`),
          plan.calibOverride.key,
          plan.calibOverride.multiplier,
        );
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      await io.mkdir(join(reservation.runDir, "output"));
      await io.writeFile(join(reservation.runDir, "stdout.log"), "", { flag: "wx" });
      await io.writeFile(join(reservation.runDir, "stderr.log"), "", { flag: "wx" });
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      preparedBuild =
        input.buildId === null
          ? undefined
          : await prepareBuild(input.cwd, input.buildId, input.taskId, reservation.runDir, () =>
              verifyRun(input.runsDir, location.parent, reservation.runDir, location.directory),
            );
      const build = preparedBuild?.record;
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      const stack = captureStackLock({ ...this.config, cwd: input.cwd }, input.llm, build);
      const data = await generateProvenance(reservation.runDir, input.project, input.inputDir);
      // Record the returned path before ownership checks: inability to prove ownership
      // must fail closed during rollback, never authorize deletion of a replacement.
      provenance = {
        directory: join(input.cwd, "provenance"),
        path: join(input.cwd, "provenance", `${data.data_id}.json`),
      };
      provenance.parent = realDirectory(provenance.directory);
      provenance.file = existingPath(provenance.path);
      if (!provenance.file?.isFile()) {
        throw new Error(`Expected a regular provenance file: ${provenance.path}`);
      }
      verifyRun(input.runsDir, parent, reservation.runDir, owned);
      let record = RunJobSchema.parse({
        run_id: reservation.run_id,
        job_id: reservation.job_id,
        task_id: input.taskId,
        analysis_plan_id: plan.analysisPlanId,
        parameter_set_id: plan.parameterSetId,
        stack_id: stack.stack_id,
        data_id: data.data_id,
        build_id: input.buildId,
        binary_sha256: build?.binary_sha256 ?? null,
        threads: input.threads,
        backend: "local_job",
        status: "created",
        project: input.project,
        label: input.label,
        input_dir: input.inputDir,
        run_dir: reservation.runDir,
        command: [
          build ? join(reservation.runDir, "bin", "shud") : this.config.shudBin,
          "-o",
          `output/${input.project}.out`,
          input.project,
        ],
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
        label: registrationLabel(record),
        output: [stdoutSource(join(record.run_dir, "stdout.log"))],
        run: (handle) => {
          this.cancellations.register(
            handle.id,
            {
              // Captured creation ownership is checked again before synchronous cancellation writes.
              run_id: record.run_id,
              job_id: record.job_id,
              run_dir: record.run_dir,
            },
            location,
          );
          execution.value = producer(record, handle, this.waitMs);
          // Observe rejection before the identified-record write yields; keep its error for rollback.
          execution.startup = execution.value.started.then(
            (identity) => ({ identity }),
            (error: unknown) => ({ error }),
          );
          return this.cancellations.attach(handle.id, execution.value, execution.value);
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
      const originalStart = {
        run_id: record.run_id,
        job_id: record.job_id,
        run_dir: record.run_dir,
        pid: startup.identity.pid,
        pid_started_at: startup.identity.pid_started_at,
        started_at: startup.identity.pid_started_at,
      };
      record = RunJobSchema.parse({
        ...record,
        status: "running",
        pid: originalStart.pid,
        pid_started_at: originalStart.pid_started_at,
        started_at: originalStart.started_at,
      });
      await writeJson(recordPath, record);
      this.cancellations.activate(registered, startup.identity);
      this.receipts.set(record.run_id, { lifecycle, originalStart });
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
        if (registered) await removeSettledRegistration(this.registry, registered, this.waitMs);
        if (indexed) await this.indexes.removeActive(reservation.run_id);
        if (error instanceof BuildOwnershipError)
          throw new Error("Cannot remove run with an unowned binary destination", { cause: error });
        if (created && existingPath(reservation.runDir)) {
          if (!parent || !owned)
            throw new Error("Cannot verify ownership of newly claimed run directory", {
              cause: error,
            });
          verifyRun(input.runsDir, parent, reservation.runDir, owned);
          preparedBuild?.assertRollbackSafe();
          await io.rm(reservation.runDir, { recursive: true });
        }
        if (provenance) await removeProvenance(provenance);
        this.cancellations.release(reservation.run_id);
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
      // Success (indexed running RunJob) and clean rollback release; failed cleanup keeps both.
      if (releaseReservation) {
        this.releaseReservation(reservation);
        if (claimedSet !== undefined) this.claimedSets.delete(claimedSet);
      }
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
