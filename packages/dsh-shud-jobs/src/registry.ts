import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry, type Config as ParentConfig } from "@deepseek-ai/dsh-jobs-local";
import {
  RunJobSchema,
  TaskIdSchema,
  type JobRecordId,
  type RunId,
  type RunJob,
  type RunRecord,
  type TaskId,
} from "@shud-harness/dsh-shud-core";
import type { StackCaptureConfig } from "@shud-harness/dsh-shud-records";
import type { SubmitShudRequest } from "./shud-input.ts";
import { ShudSubmissions, type ShudProducer } from "./shud-submissions.ts";
import { StateIndexStore, type IndexEntry } from "./state-indexes.ts";
import { ShudPoll, type CompletionReceipt } from "./shud-poll.ts";
import { ShudCancellation } from "./shud-cancellation.ts";
import { createRecoveryReporter } from "./shud-recovery-log.ts";
import { collectFailure, readRunFile, validationFailure, verifyRunFile } from "./shud-run-file.ts";

export interface Config extends ParentConfig, Omit<StackCaptureConfig, "cwd"> {
  /** Absolute writable directory for registry state; created when absent. */
  stateDir: string;
  /** Absolute path to an executable regular SHUD binary. */
  shudBin: string;
}

type StandardProps = (typeof LocalJobRegistry.Config)["~standard"];
type ConfigIssue = { message: string; path: string[] };
const ownConfigKeys = ["stateDir", "shudBin", "stackRepos", "hostVersion", "llm", "sundialsRoot"];

function validateConfigText(
  value: unknown,
  path: string[],
  absolute: boolean,
  issues: ConfigIssue[],
): void {
  if (typeof value !== "string" || value.length === 0 || (absolute && !isAbsolute(value))) {
    issues.push({
      message: `${path.join(".")} must be a nonempty ${absolute ? "absolute path" : "string"}`,
      path,
    });
  }
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareStateDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
    if (!statSync(path).isDirectory()) throw new TypeError("Expected a directory");
    accessSync(path, constants.W_OK);
  } catch (error) {
    throw new Error(`Invalid stateDir ${path}: expected a writable directory`, { cause: error });
  }
}

function assertExecutableFile(path: string): void {
  try {
    if (!statSync(path).isFile()) throw new TypeError("Expected a regular file");
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw new Error(`Invalid shudBin ${path}: expected an executable regular file`, {
      cause: error,
    });
  }
}

/** Query one owned index snapshot without entering the mutation/collection queues. */
async function queryRunJobs(store: StateIndexStore, taskId: TaskId): Promise<RunJob[]> {
  const snapshot = store.read();
  const runs = new Map<RunId, IndexEntry>();
  const jobs = new Map<JobRecordId, IndexEntry>();
  const matches: RunJob[] = [];
  for (const entries of [snapshot.active, snapshot.completed]) {
    for (const entry of entries) {
      const priorRun = runs.get(entry.run_id);
      const priorJob = jobs.get(entry.job_id);
      if (priorRun || priorJob) {
        // completeActive publishes completed before removing active. Only the exact identity
        // may be deduplicated, with active precedence; conflicting identities remain errors.
        if (
          priorRun &&
          priorJob?.run_id === entry.run_id &&
          priorRun.job_id === entry.job_id &&
          priorRun.run_dir === entry.run_dir
        )
          continue;
        throw new Error(`SHUD task query ${entry.run_id}: conflicting index identity`);
      }
      runs.set(entry.run_id, entry);
      jobs.set(entry.job_id, entry);
      try {
        const routed = await readRunFile(entry);
        verifyRunFile(entry, routed);
        const parsed = RunJobSchema.safeParse(routed.raw);
        if (!parsed.success) throw validationFailure("RunJob", parsed.error.issues);
        // Every indexed record is validated, including null/other-task records. A later
        // failure rejects the whole request rather than exposing these accumulated matches.
        if (parsed.data.task_id === taskId) matches.push(parsed.data);
      } catch (error) {
        const failure = collectFailure("run metadata", error);
        failure.message = `SHUD task query ${entry.run_id}: ${failure.stage}: ${failure.code}`;
        throw failure;
      }
    }
  }
  return matches.sort((left, right) =>
    left.job_id < right.job_id ? -1 : left.job_id > right.job_id ? 1 : 0,
  );
}

// Keep the exact parent constructor and instance API without inheriting its static schema type.
const ParentRegistry: new (
  ...args: ConstructorParameters<typeof LocalJobRegistry>
) => LocalJobRegistry = LocalJobRegistry;

/** LocalJobRegistry with fail-loud SHUD configuration; non-shud behavior remains inherited. */
export class ShudJobRegistry extends ParentRegistry {
  readonly indexes: StateIndexStore;
  readonly submitShud: (request: SubmitShudRequest, producer: ShudProducer) => Promise<RunJob>;
  readonly isSubmissionInFlight: (id: RunId) => boolean;
  readonly pollOnce: () => Promise<void>;
  readonly collectShud: (id: RunId | JobRecordId) => Promise<RunRecord>;
  readonly listRunJobsByTask: (task_id: TaskId) => Promise<RunJob[]>;
  override readonly kill: LocalJobRegistry["kill"];
  private readonly initialize: () => Promise<void>;

  static Config: { "~standard": StandardProps } = {
    "~standard": {
      version: 1,
      vendor: "shud-harness",
      validate(value: unknown) {
        const input = isConfigObject(value) ? value : {};
        const parentDict = LocalJobRegistry.Config.dict;
        if (parentDict === undefined) {
          throw new TypeError("LocalJobRegistry.Config must expose its configuration dictionary");
        }
        const issues: ConfigIssue[] = [];
        for (const key of Object.keys(input)) {
          if (!ownConfigKeys.includes(key) && !Object.hasOwn(parentDict, key)) {
            issues.push({ message: `Unknown configuration key ${key}`, path: [key] });
          }
        }
        for (const key of ["stateDir", "shudBin"] as const) {
          validateConfigText(input[key], [key], true, issues);
        }
        validateConfigText(input.hostVersion, ["hostVersion"], false, issues);
        if (input.sundialsRoot !== undefined) {
          validateConfigText(input.sundialsRoot, ["sundialsRoot"], true, issues);
        }
        for (const [key, fields, absolute] of [
          ["stackRepos", ["SHUD", "rSHUD", "AutoSHUD"], true],
          ["llm", ["base_url", "request_alias"], false],
        ] as const) {
          const nested = input[key];
          if (!isConfigObject(nested)) {
            issues.push({ message: `${key} must be a configuration object`, path: [key] });
            continue;
          }
          for (const field of Object.keys(nested)) {
            if (!(fields as readonly string[]).includes(field)) {
              issues.push({
                message: `Unknown configuration key ${key}.${field}`,
                path: [key, field],
              });
            }
          }
          for (const field of fields) {
            validateConfigText(nested[field], [key, field], absolute, issues);
          }
        }
        if (issues.length > 0) return { issues };
        const { stateDir, shudBin, stackRepos, hostVersion, llm, sundialsRoot, ...parentInput } =
          input;
        const result = LocalJobRegistry.Config["~standard"].validate(parentInput);
        // Preserve parent failures and let Cordis reject an unsupported async parent validator.
        if (!("value" in result)) return result;
        if (!isConfigObject(result.value)) {
          throw new TypeError("LocalJobRegistry.Config validation must return an object");
        }
        return {
          value: {
            ...result.value,
            stateDir,
            shudBin,
            stackRepos,
            hostVersion,
            llm,
            ...(sundialsRoot === undefined ? {} : { sundialsRoot }),
          },
        };
      },
    },
  };

  constructor(ctx: Context, config: Config) {
    assertExecutableFile(config.shudBin);
    prepareStateDir(config.stateDir);
    // Cordis resolves parent defaults before construction; direct construction is unsupported.
    const pumpPollMs = config.pumpPollMs;
    if (typeof pumpPollMs !== "number" || !Number.isSafeInteger(pumpPollMs) || pumpPollMs < 1) {
      throw new Error(
        "Invalid pumpPollMs: expected a positive safe integer from parsed ShudJobRegistry.Config (Cordis-resolved configuration)",
      );
    }
    const store = new StateIndexStore(config.stateDir);
    let poll: ShudPoll | undefined;
    try {
      super(ctx, config);
      this.indexes = store;
      // Capture the actual instance here; scoped Cordis proxies must not choose registration scope.
      const receipts = new Map<RunId, CompletionReceipt>();
      const cancellations = new ShudCancellation((error) => ctx.logger.error(error));
      const submissions = new ShudSubmissions(
        this,
        store,
        config,
        pumpPollMs,
        receipts,
        cancellations,
      );
      const dispatcher = new ShudPoll(
        this,
        store,
        receipts,
        cancellations,
        (id) => submissions.isInFlight(id),
        pumpPollMs,
        (error) => ctx.logger.error(error),
        createRecoveryReporter(ctx),
      );
      poll = dispatcher;
      ctx.inject(["sessionController", "sessions"], (services) =>
        dispatcher.enableDelivery(services.sessionController, services.sessions),
      );
      let ready = false;
      let acceptingQueries = true;
      const pendingQueries = new Set<Promise<void>>();
      const requireReady = () => {
        if (!ready) throw new Error("SHUD startup reconciliation is not ready");
      };
      this.submitShud = async (request, producer) => {
        requireReady();
        return submissions.submit(request, producer);
      };
      this.isSubmissionInFlight = (id) => submissions.isInFlight(id);
      this.pollOnce = async () => {
        requireReady();
        return dispatcher.pollOnce();
      };
      this.collectShud = async (id) => {
        requireReady();
        return dispatcher.collectShud(id);
      };
      this.listRunJobsByTask = async (taskId) => {
        requireReady();
        if (!acceptingQueries) throw new Error("SHUD task query admission is CLOSED");
        const parsed = TaskIdSchema.safeParse(taskId);
        if (!parsed.success) throw new Error("Invalid task_id: expected a core TaskId");
        const result = queryRunJobs(store, parsed.data);
        const finish = () => {
          pendingQueries.delete(completion);
        };
        const completion = result.then(finish, finish);
        pendingQueries.add(completion);
        return result;
      };
      this.kill = (id, caller, reason) => {
        if (!cancellations.owns(id)) return super.kill(id, caller, reason);
        // Public parent preflight preserves access and already-finished behavior before any write.
        const view = this.get(id, caller);
        if (view.status !== "running" && view.status !== "stopping") {
          return super.kill(id, caller, reason);
        }
        return cancellations.request(id, submissions.isInFlight(cancellations.runId(id)), () =>
          super.kill(id, caller, reason),
        );
      };
      let closing: Promise<void> | undefined;
      // Cordis disposes sibling effects concurrently; all SHUD ownership ordering lives here.
      ctx.effect(() => () => {
        acceptingQueries = false;
        cancellations.stopAdmission();
        dispatcher.stopAdmission();
        submissions.stopAdmission();
        return (closing ??= Promise.all([
          dispatcher.drain(),
          submissions.drain(),
          ...pendingQueries,
        ]).then(() => {
          receipts.clear();
          // Retain managed classification while the concurrent parent disposer may still call cancel.
          // Normally completed/rolled-back runs release their entries; closed leftovers die with this instance.
          return store.close();
        }));
      });
      this.initialize = async () => {
        await dispatcher.reconcileAtStartup();
        if (closing) return;
        dispatcher.start();
        ready = true;
      };
    } catch (error) {
      poll?.stopAdmission();
      void Promise.resolve(poll?.drain())
        .then(() => store.close())
        .catch((cleanup: unknown) => ctx.logger.error(cleanup));
      throw error;
    }
  }

  [Service.init](): Promise<void> {
    return this.initialize();
  }
}
