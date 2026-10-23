import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { LocalJobRegistry, type Config as ParentConfig } from "@deepseek-ai/dsh-jobs-local";
import type { RunId, RunJob } from "@shud-harness/dsh-shud-core";
import type { SubmitShudRequest } from "./shud-input.ts";
import { ShudSubmissions, type ShudProducer } from "./shud-submissions.ts";
import { StateIndexStore } from "./state-indexes.ts";

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
    const store = new StateIndexStore(config.stateDir);
    try {
      super(ctx, config);
      this.indexes = store;
      // Capture the actual instance here; scoped Cordis proxies must not choose registration scope.
      const submissions = new ShudSubmissions(this, store, config);
      this.submitShud = (request, producer) => submissions.submit(request, producer);
      this.isSubmissionInFlight = (id) => submissions.isInFlight(id);
      // One effect retains ownership through accepted submissions and all their rollback work.
      ctx.effect(() => () => submissions.close());
    } catch (error) {
      void store.close().catch((cleanup: unknown) => ctx.logger.error(cleanup));
      throw error;
    }
  }
}

export default ShudJobRegistry;
