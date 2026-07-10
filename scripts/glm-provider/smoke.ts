import { resolve } from "node:path";
import {
  invalidateCanonicalReadinessForCliPreflightFailure,
  runCanonicalGlmProviderSmoke
} from "./canonical-smoke";
import {
  DEFAULT_REPO_ROOT,
  DEFAULT_TIMEOUT_MS,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  LocalSmokeError
} from "./smoke-core";
import type { SmokeRunResult } from "./readiness-note";

export {
  API_TYPE,
  CANONICAL_BASE_URL,
  CANONICAL_ENDPOINT,
  CANONICAL_PROVIDER_NAME,
  CANONICAL_SMOKE_MODEL,
  CANONICAL_TARGET_MODEL,
  CANONICAL_TARGET_MODEL_REF,
  DEFAULT_CONFIG_RELATIVE_PATH,
  DEFAULT_PROVIDER_CONFIG_PATH,
  DEFAULT_REPO_ROOT,
  DEFAULT_TIMEOUT_MS,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  buildChatCompletionPayload,
  chatCompletionsEndpoint,
  loadProviderConfig,
  parseProviderConfig,
  type GlmProviderConfig,
  type SmokeFetch
} from "./smoke-core";
export {
  DEFAULT_READINESS_NOTE_NAME,
  FIXTURE_READINESS_NOTE_NAME,
  MAX_PRIOR_READINESS_NOTE_BYTES,
  type CanonicalReadinessNote,
  type CanonicalSmokeRunResult,
  type FixtureReadinessNote,
  type FixtureSmokeRunResult,
  type ReadinessNote,
  type SmokeFailure,
  type SmokeFailureCategory,
  type SmokeRunResult,
  type SmokeStatus
} from "./readiness-note";
export {
  runGlmProviderSmokeFixture,
  type RunSmokeFixtureOptions
} from "./fixture-smoke";
export { runCanonicalGlmProviderSmoke as runGlmProviderSmoke };

export const CLI_UNSUPPORTED_ARGUMENT_MESSAGE = "Unsupported or incomplete CLI argument.";

function isHelpInvocation(args: string[]): boolean {
  return args.length === 1 && args[0] === "--help";
}

function printHelp(): void {
  console.log([
    "Usage: bun scripts/glm-provider/smoke.ts [--help]",
    "",
    "Runs one non-stream OpenAI-compatible chat-completions smoke against the configured GLM provider.",
    `The canonical checkout is ${DEFAULT_REPO_ROOT}.`,
    `Each provider attempt uses a fixed ${DEFAULT_TIMEOUT_MS} ms timeout.`,
    `The API key must be provided through ${GLM_API_KEY_ENV}; only ${GLM_API_KEY_REF} is persisted.`
  ].join("\n"));
}

export function formatSmokeSuccessCliOutput(
  result: Extract<SmokeRunResult, { ok: true }>
): string {
  const notePath = result.readinessNotePath.replace(`${resolve(DEFAULT_REPO_ROOT)}/`, "");
  return [
    "GLM provider smoke passed",
    `provider=${result.config.providerName}`,
    `smoke_model=${result.config.smokeModel}`,
    `target_model_id=${result.config.targetModelId}`,
    `base_url=${result.config.baseUrl}`,
    `endpoint=${result.endpoint}`,
    `response_url=${result.responseUrl}`,
    `secret_ref=${result.config.apiKeyRef}`,
    "model_admission=false",
    `readiness_note=${notePath}`
  ].join(" ");
}

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (isHelpInvocation(args)) {
      printHelp();
      return;
    }
    if (args.length > 0) {
      await invalidateCanonicalReadinessForCliPreflightFailure();
      console.error(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}`);
      process.exitCode = 1;
      return;
    }

    const result = await runCanonicalGlmProviderSmoke();
    if (result.ok) {
      console.log(formatSmokeSuccessCliOutput(result));
      return;
    }

    console.error(`GLM provider smoke failed: ${result.error.message}`);
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof LocalSmokeError
      ? error.message
      : "Smoke command failed before provider readiness could be recorded.";
    console.error(`GLM provider smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
