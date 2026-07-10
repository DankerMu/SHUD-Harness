import { resolve } from "node:path";
import {
  runCanonicalGlmProviderSmoke,
  runCanonicalGlmProviderSmokeCommand
} from "./canonical-smoke";
import {
  DEFAULT_REPO_ROOT,
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
export {
  CLI_UNSUPPORTED_ARGUMENT_MESSAGE,
  runCanonicalGlmProviderSmokeCommand,
  type CanonicalSmokeCommandOutcome
} from "./canonical-smoke";
export { runCanonicalGlmProviderSmoke as runGlmProviderSmoke };

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
    const outcome = await runCanonicalGlmProviderSmokeCommand(process.argv.slice(2));
    if (outcome.kind === "help") {
      console.log(outcome.stdout);
      return;
    }

    if (outcome.kind === "unsupported") {
      console.error(outcome.stderr);
      process.exitCode = outcome.exitCode;
      return;
    }

    const { result } = outcome;
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
