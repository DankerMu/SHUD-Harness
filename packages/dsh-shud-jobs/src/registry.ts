import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry, type Config as ParentConfig } from "@deepseek-ai/dsh-jobs-local";
import type { JobRecordId, RunId, RunJob, RunRecord } from "@shud-harness/dsh-shud-core";
import type { SubmitShudRequest } from "./shud-input.ts";
import { ShudSubmissions, type ShudProducer } from "./shud-submissions.ts";
import { StateIndexStore } from "./state-indexes.ts";
import { ShudPoll, type CompletionReceipt } from "./shud-poll.ts";
import { ShudCancellation } from "./shud-cancellation.ts";
import { createRecoveryReporter } from "./shud-recovery-log.ts";

export interface Config extends ParentConfig {
  /** Absolute writable directory for registry state; created when absent. */
  stateDir: string;
  /** Absolute path to an executable regular SHUD binary. */
  shudBin: string;
}

type StandardProps = (typeof LocalJobRegistry.Config)["~standard"];

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
        const issues: Array<{ message: string; path: string[] }> = [];
        for (const key of Object.keys(input)) {
          if (key !== "stateDir" && key !== "shudBin" && !Object.hasOwn(parentDict, key)) {
            issues.push({ message: `Unknown configuration key ${key}`, path: [key] });
          }
        }
        for (const key of ["stateDir", "shudBin"] as const) {
          const path = input[key];
          if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
            issues.push({ message: `${key} must be a nonempty absolute path`, path: [key] });
          }
        }
        if (issues.length > 0) return { issues };
        const { stateDir, shudBin, ...parentInput } = input;
        const result = LocalJobRegistry.Config["~standard"].validate(parentInput);
        // Preserve parent failures and let Cordis reject an unsupported async parent validator.
        if (!("value" in result)) return result;
        if (!isConfigObject(result.value)) {
          throw new TypeError("LocalJobRegistry.Config validation must return an object");
        }
        return { value: { ...result.value, stateDir, shudBin } };
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
        cancellations.stopAdmission();
        dispatcher.stopAdmission();
        submissions.stopAdmission();
        return (closing ??= Promise.all([dispatcher.drain(), submissions.drain()]).then(() => {
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
