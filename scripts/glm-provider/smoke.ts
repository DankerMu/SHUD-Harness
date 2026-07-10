import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_READINESS_NOTE_NAME, FIXTURE_READINESS_NOTE_NAME, invalidatePassingReadinessNote, writeCanonicalReadinessNote, writeFixtureReadinessNote } from "./readiness-note";

export { DEFAULT_READINESS_NOTE_NAME, FIXTURE_READINESS_NOTE_NAME } from "./readiness-note";

export const GLM_API_KEY_ENV = "GLM_API_KEY";
export const GLM_API_KEY_REF = "env:GLM_API_KEY";
export const API_TYPE = "openai_chat_completions";
export const DEFAULT_CONFIG_RELATIVE_PATH = "config/providers/glm.dmxapi.json";
export const DEFAULT_TIMEOUT_MS = 15000;
export const MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_RETRIES = 1;
const SMOKE_MAX_TOKENS = 512;
export const CANONICAL_PROVIDER_NAME = "glm-dmxapi";
export const CANONICAL_BASE_URL = "https://www.dmxapi.cn/v1";
export const CANONICAL_SMOKE_MODEL = "deepseek-v4-pro-guan";
export const CANONICAL_TARGET_MODEL = "glm-5.2";
export const CANONICAL_TARGET_MODEL_REF = "glm-dmxapi/target";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDirectory, "..", "..");
export const DEFAULT_PROVIDER_CONFIG_PATH = join(DEFAULT_REPO_ROOT, DEFAULT_CONFIG_RELATIVE_PATH);

export type SmokeFetch = (input: string, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;

export interface GlmProviderConfig {
  providerName: string;
  defaultModel: typeof CANONICAL_TARGET_MODEL_REF;
  apiType: typeof API_TYPE;
  baseUrl: string;
  apiKeyRef: typeof GLM_API_KEY_REF;
  fallbackChain: string[];
  smokeModel: string;
  targetModelId: string;
  modelPlaceholders: Record<string, string>;
  zeroAdapter: {
    apiType: typeof API_TYPE;
    baseUrl: string;
    auth: {
      type: "api_key";
      apiKeyRef: typeof GLM_API_KEY_REF;
    };
    models: {
      target: { modelId: string };
    };
  };
}

export type SmokeStatus = "passed" | "failed";

export type SmokeFailureCategory =
  | "missing_key"
  | "base_url_mismatch"
  | "http_error"
  | "invalid_response"
  | "empty_completion"
  | "oversized_response"
  | "timeout"
  | "network_error";

export interface SmokeFailure {
  category: SmokeFailureCategory;
  message: string;
  http_status?: number;
}

interface BaseReadinessNote {
  checked_at: string;
  provider_name: string;
  api_type: typeof API_TYPE;
  base_url: string;
  endpoint: string;
  smoke_model: string;
  target_model_id: string;
  status: SmokeStatus;
  model_admission: false;
  secret_ref: typeof GLM_API_KEY_REF;
  attempts: number;
  configured_base_url_hit: boolean;
  completion_nonempty: boolean;
  response_url?: string;
  failure?: SmokeFailure;
}

export interface CanonicalReadinessNote extends BaseReadinessNote {
  schema_version: "m1.glm-provider-smoke.v1";
  kind: "glm_provider_smoke";
  evidence_scope: "canonical";
}

export interface FixtureReadinessNote extends BaseReadinessNote {
  schema_version: "m1.glm-provider-smoke.fixture.v1";
  kind: "glm_provider_smoke_fixture";
  evidence_scope: "fixture";
}

export type ReadinessNote = CanonicalReadinessNote;
type ReadinessNoteNameFor<Scope extends "canonical" | "fixture"> = Scope extends "canonical"
  ? typeof DEFAULT_READINESS_NOTE_NAME
  : typeof FIXTURE_READINESS_NOTE_NAME;

type SmokeRunResultFor<
  Note extends CanonicalReadinessNote | FixtureReadinessNote,
  Scope extends "canonical" | "fixture"
> =
  | {
      ok: true;
      evidenceScope: Scope;
      readinessNoteName: ReadinessNoteNameFor<Scope>;
      status: "passed";
      config: GlmProviderConfig;
      endpoint: string;
      attempts: number;
      responseUrl: string;
      completionNonempty: true;
      readinessNotePath: string;
      note: Note;
    }
  | {
      ok: false;
      evidenceScope: Scope;
      readinessNoteName: ReadinessNoteNameFor<Scope>;
      status: "failed";
      config: GlmProviderConfig;
      endpoint: string;
      attempts: number;
      error: SmokeFailure;
      readinessNotePath: string;
      note: Note;
    };

export type CanonicalSmokeRunResult = SmokeRunResultFor<CanonicalReadinessNote, "canonical">;
export type FixtureSmokeRunResult = SmokeRunResultFor<FixtureReadinessNote, "fixture">;
export type SmokeRunResult = CanonicalSmokeRunResult;
type EngineSmokeRunResult = SmokeRunResultFor<CanonicalReadinessNote | FixtureReadinessNote, "canonical" | "fixture">;

export interface RunSmokeFixtureOptions {
  repoRoot: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: SmokeFetch;
  timeoutMs?: number;
  now?: () => Date;
}

interface AttemptSuccess {
  ok: true;
  responseUrl: string;
  completionNonempty: true;
}

interface AttemptFailure {
  ok: false;
  failure: SmokeFailure;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

class LocalSmokeError extends Error {
  constructor(message: string) { super(message); this.name = "LocalSmokeError"; }
}

export async function loadProviderConfig(providerPath = DEFAULT_PROVIDER_CONFIG_PATH) {
  let raw: string;
  try {
    raw = await readFile(providerPath, "utf8");
  } catch {
    throw new LocalSmokeError("Provider config could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new LocalSmokeError("Provider config was not valid JSON.");
  }
  return parseProviderConfig(parsed);
}

export function parseProviderConfig(raw: unknown): GlmProviderConfig {
  const document = readRecord(raw, "provider config");
  const defaultProvider = readString(document, "default_provider", "provider config");
  const defaultModel = readString(document, "default_model", "provider config");
  if (defaultProvider !== CANONICAL_PROVIDER_NAME) {
    throw new LocalSmokeError(`Invalid provider default_provider: expected ${CANONICAL_PROVIDER_NAME}.`);
  }
  const providers = readRecord(document.providers, "provider config.providers");
  const providerNames = Object.keys(providers);
  if (providerNames.length !== 1 || providerNames[0] !== CANONICAL_PROVIDER_NAME) {
    throw new LocalSmokeError("Provider config.providers must contain only the canonical GLM provider.");
  }
  if (document.model_pools !== undefined) {
    throw new LocalSmokeError("Provider config must not define Zero model pools.");
  }
  const provider = readRecord(providers[CANONICAL_PROVIDER_NAME], `provider ${defaultProvider}`);

  const apiType = readString(provider, "api_type", defaultProvider);
  const baseUrl = normalizeBaseUrl(readString(provider, "base_url", defaultProvider));
  const auth = readRecord(provider.auth, `${defaultProvider}.auth`);
  const apiKeyRef = readString(auth, "api_key_ref", `${defaultProvider}.auth`);
  const fallbackChain = readStringArray(document.fallback_chain, "provider config.fallback_chain");
  const smokeModel = readString(document, "smoke_model", "provider config");
  const targetModelId = readString(document, "target_model_id", "provider config");
  const taskClosureModel = readString(document, "task_closure_model", "provider config");
  const contextCompactionModel = readString(document, "context_compaction_model", "provider config");
  const fallbackSmokeModel = readString(document, "fallback_smoke_model", "provider config");
  const modelPlaceholders = {
    task_closure_model: taskClosureModel,
    context_compaction_model: contextCompactionModel,
    fallback_smoke_model: fallbackSmokeModel
  };
  const models = readRecord(provider.models, `${defaultProvider}.models`);
  const modelNames = Object.keys(models);
  if (modelNames.length !== 1 || modelNames[0] !== "target") {
    throw new LocalSmokeError("Provider models must contain only the canonical GLM target model.");
  }
  const target = readRecord(models.target, `${defaultProvider}.models.target`);

  if (defaultModel !== CANONICAL_TARGET_MODEL_REF) {
    throw new LocalSmokeError("Provider default_model must target the canonical GLM target ref.");
  }
  if (apiType !== API_TYPE) {
    throw new LocalSmokeError(`Invalid provider api_type: expected ${API_TYPE}.`);
  }
  if (baseUrl !== CANONICAL_BASE_URL) {
    throw new LocalSmokeError(`Invalid provider base_url: expected ${CANONICAL_BASE_URL}.`);
  }
  if (readString(auth, "type", `${defaultProvider}.auth`) !== "api_key") {
    throw new LocalSmokeError("Provider auth.type must be api_key.");
  }
  if (apiKeyRef !== GLM_API_KEY_REF) {
    throw new LocalSmokeError(`Invalid provider auth.api_key_ref: expected ${GLM_API_KEY_REF}.`);
  }
  if (
    fallbackChain.length !== 1 ||
    fallbackChain[0] !== CANONICAL_TARGET_MODEL_REF
  ) {
    throw new LocalSmokeError("Provider fallback_chain must contain only the canonical GLM target ref.");
  }
  if (taskClosureModel !== CANONICAL_TARGET_MODEL_REF) {
    throw new LocalSmokeError("Provider task_closure_model must target the canonical GLM target ref.");
  }
  if (contextCompactionModel !== CANONICAL_TARGET_MODEL_REF) {
    throw new LocalSmokeError("Provider context_compaction_model must target the canonical GLM target ref.");
  }
  if (fallbackSmokeModel !== CANONICAL_SMOKE_MODEL) {
    throw new LocalSmokeError("Provider fallback_smoke_model must be the raw smoke carrier model id.");
  }
  if (smokeModel !== CANONICAL_SMOKE_MODEL) {
    throw new LocalSmokeError(`Invalid provider smoke_model: expected ${CANONICAL_SMOKE_MODEL}.`);
  }
  if (targetModelId !== CANONICAL_TARGET_MODEL) {
    throw new LocalSmokeError(`Invalid provider target_model_id: expected ${CANONICAL_TARGET_MODEL}.`);
  }
  if (readString(target, "model_id", `${defaultProvider}.models.target`) !== targetModelId) {
    throw new LocalSmokeError("Provider target model fields do not agree.");
  }
  readExactlyFalse(target, "admission", `${defaultProvider}.models.target`);

  return {
    providerName: defaultProvider,
    defaultModel,
    apiType,
    baseUrl,
    apiKeyRef,
    fallbackChain,
    smokeModel,
    targetModelId,
    modelPlaceholders,
    zeroAdapter: {
      apiType,
      baseUrl,
      auth: {
        type: "api_key",
        apiKeyRef
      },
      models: {
        target: { modelId: targetModelId }
      }
    }
  };
}

export async function runGlmProviderSmoke(): Promise<CanonicalSmokeRunResult> {
  const result = await runSmokeEngine({
    evidenceScope: "canonical",
    repoRoot: DEFAULT_REPO_ROOT,
    configPath: DEFAULT_PROVIDER_CONFIG_PATH,
    env: process.env,
    fetchImpl: globalThis.fetch.bind(globalThis),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    now: () => new Date()
  });
  return result as CanonicalSmokeRunResult;
}

export async function runGlmProviderSmokeFixture(
  options: RunSmokeFixtureOptions
): Promise<FixtureSmokeRunResult> {
  const repoRoot = resolveFixtureRepoRoot(options);
  await assertFixtureRepoRoot(repoRoot);
  const timeoutMs = readFixtureTimeoutMs(options.timeoutMs);
  const result = await runSmokeEngine({
    evidenceScope: "fixture",
    repoRoot,
    configPath: join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH),
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
    timeoutMs,
    now: options.now ?? (() => new Date())
  });
  return result as FixtureSmokeRunResult;
}

interface SmokeEngineInput {
  evidenceScope: "canonical" | "fixture";
  repoRoot: string;
  configPath: string;
  env: Record<string, string | undefined>;
  fetchImpl: SmokeFetch;
  timeoutMs: number;
  now: () => Date;
}

async function runSmokeEngine(
  options: SmokeEngineInput
): Promise<EngineSmokeRunResult> {
  if (options.evidenceScope === "canonical") {
    await invalidatePassingReadinessNote(options.repoRoot);
  }

  const config = await loadProviderConfig(options.configPath);
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  const configuredBaseUrlHit = endpointHitsConfiguredBaseUrl(endpoint, config.baseUrl);
  const apiKey = options.env[GLM_API_KEY_ENV];

  if (!configuredBaseUrlHit) {
    const error = {
      category: "base_url_mismatch",
      message: "Computed chat completions endpoint does not use the configured base URL."
    } satisfies SmokeFailure;
    const note = createSmokeReadinessNote({
      config,
      endpoint,
      status: "failed",
      attempts: 0,
      configuredBaseUrlHit,
      completionNonempty: false,
      evidenceScope: options.evidenceScope,
      now: options.now,
      failure: error
    });
    const readinessNotePath = await writeSmokeReadinessNote(options, note);
    return {
      ok: false,
      evidenceScope: options.evidenceScope,
      readinessNoteName: readinessNoteNameForScope(options.evidenceScope),
      status: "failed",
      config,
      endpoint,
      attempts: 0,
      error,
      note,
      readinessNotePath
    };
  }

  if (!apiKey) {
    const error = {
      category: "missing_key",
      message: `Missing required environment variable ${GLM_API_KEY_ENV}.`
    } satisfies SmokeFailure;
    const note = createSmokeReadinessNote({
      config,
      endpoint,
      status: "failed",
      attempts: 0,
      configuredBaseUrlHit,
      completionNonempty: false,
      evidenceScope: options.evidenceScope,
      now: options.now,
      failure: error
    });
    const readinessNotePath = await writeSmokeReadinessNote(options, note);
    return {
      ok: false,
      evidenceScope: options.evidenceScope,
      readinessNoteName: readinessNoteNameForScope(options.evidenceScope),
      status: "failed",
      config,
      endpoint,
      attempts: 0,
      error,
      note,
      readinessNotePath
    };
  }

  const totalAttempts = MAX_RETRIES + 1;
  let lastFailure: SmokeFailure = {
    category: "network_error",
    message: "No provider smoke attempt ran."
  };

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const result = await sendChatCompletion({
      config,
      endpoint,
      apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    });

    if (result.ok) {
      const note = createSmokeReadinessNote({
        config,
        endpoint,
        status: "passed",
        attempts: attempt,
        configuredBaseUrlHit,
        completionNonempty: true,
        responseUrl: result.responseUrl,
        evidenceScope: options.evidenceScope,
        now: options.now
      });
      const readinessNotePath = await writeSmokeReadinessNote(options, note);
      return {
        ok: true,
        evidenceScope: options.evidenceScope,
        readinessNoteName: readinessNoteNameForScope(options.evidenceScope),
        status: "passed",
        config,
        endpoint,
        attempts: attempt,
        responseUrl: result.responseUrl,
        completionNonempty: true,
        note,
        readinessNotePath
      };
    }

    lastFailure = result.failure;
  }

  const note = createSmokeReadinessNote({
    config,
    endpoint,
    status: "failed",
    attempts: totalAttempts,
    configuredBaseUrlHit,
    completionNonempty: false,
    evidenceScope: options.evidenceScope,
    now: options.now,
    failure: lastFailure
  });
  const readinessNotePath = await writeSmokeReadinessNote(options, note);
  return {
    ok: false,
    evidenceScope: options.evidenceScope,
    readinessNoteName: readinessNoteNameForScope(options.evidenceScope),
    status: "failed",
    config,
    endpoint,
    attempts: totalAttempts,
    error: lastFailure,
    note,
    readinessNotePath
  };
}

function resolveFixtureRepoRoot(options: RunSmokeFixtureOptions): string {
  if (!options || typeof options.repoRoot !== "string" || options.repoRoot.trim().length === 0) {
    throw new LocalSmokeError("Fixture smoke requires a noncanonical repo root.");
  }
  return resolve(options.repoRoot);
}

async function assertFixtureRepoRoot(repoRoot: string): Promise<void> {
  const [fixtureRoot, canonicalRoot] = await Promise.all([
    realpath(repoRoot),
    realpath(DEFAULT_REPO_ROOT)
  ]);
  if (fixtureRoot === canonicalRoot) {
    throw new LocalSmokeError("Fixture smoke repo root must not resolve to the canonical repository root.");
  }
}

function readFixtureTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    throw new LocalSmokeError(
      `Fixture smoke timeout must be a safe integer from 1 to ${DEFAULT_TIMEOUT_MS} ms.`
    );
  }
  return timeoutMs;
}

async function writeSmokeReadinessNote(
  options: SmokeEngineInput,
  note: CanonicalReadinessNote | FixtureReadinessNote
): Promise<string> {
  if (options.evidenceScope === "canonical") {
    return await writeCanonicalReadinessNote(note as CanonicalReadinessNote);
  }
  return await writeFixtureReadinessNote(options.repoRoot, note as FixtureReadinessNote);
}

function readinessNoteNameForScope(
  evidenceScope: "canonical" | "fixture"
): typeof DEFAULT_READINESS_NOTE_NAME | typeof FIXTURE_READINESS_NOTE_NAME {
  return evidenceScope === "canonical"
    ? DEFAULT_READINESS_NOTE_NAME
    : FIXTURE_READINESS_NOTE_NAME;
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function buildChatCompletionPayload(config: GlmProviderConfig): Record<string, unknown> {
  return {
    model: config.smokeModel,
    messages: [
      {
        role: "system",
        content: "Return a short readiness acknowledgement."
      },
      {
        role: "user",
        content: "Reply with a nonempty readiness token."
      }
    ],
    max_tokens: SMOKE_MAX_TOKENS,
    temperature: 0,
    stream: false
  };
}

function createSmokeReadinessNote(input: {
  config: GlmProviderConfig;
  endpoint: string;
  status: SmokeStatus;
  attempts: number;
  configuredBaseUrlHit: boolean;
  completionNonempty: boolean;
  responseUrl?: string;
  now: () => Date;
  failure?: SmokeFailure;
  evidenceScope: "canonical" | "fixture";
}): CanonicalReadinessNote | FixtureReadinessNote {
  const base = {
    checked_at: input.now().toISOString(),
    provider_name: input.config.providerName,
    api_type: input.config.apiType,
    base_url: input.config.baseUrl,
    endpoint: input.endpoint,
    smoke_model: input.config.smokeModel,
    target_model_id: input.config.targetModelId,
    status: input.status,
    model_admission: false as false,
    secret_ref: input.config.apiKeyRef,
    attempts: input.attempts,
    configured_base_url_hit: input.configuredBaseUrlHit,
    completion_nonempty: input.completionNonempty,
    ...(input.responseUrl ? { response_url: input.responseUrl } : {}),
    ...(input.failure ? { failure: input.failure } : {})
  };
  if (input.evidenceScope === "canonical") {
    return {
      schema_version: "m1.glm-provider-smoke.v1",
      kind: "glm_provider_smoke",
      evidence_scope: "canonical",
      ...base
    };
  }
  return {
    schema_version: "m1.glm-provider-smoke.fixture.v1",
    kind: "glm_provider_smoke_fixture",
    evidence_scope: "fixture",
    ...base
  };
}

async function sendChatCompletion(input: {
  config: GlmProviderConfig;
  endpoint: string;
  apiKey: string;
  fetchImpl: SmokeFetch;
  timeoutMs: number;
}): Promise<AttemptResult> {
  const payload = buildChatCompletionPayload(input.config);
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify(payload),
    redirect: "error"
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await withAbort(
        input.fetchImpl(input.endpoint, {
          ...requestInit,
          signal: controller.signal
        }),
        controller.signal
      );
      const endpointValidation = validateResponseEndpoint(response, input.endpoint);
      if (!endpointValidation.ok) {
        return {
          ok: false,
          failure: endpointValidation.failure
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            category: "http_error",
            message: `Provider returned HTTP ${response.status} from configured endpoint.`,
            http_status: response.status
          }
        };
      }
      const responseText = await readResponseTextWithLimit(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal
      );

      let responseJson: unknown;
      try {
        responseJson = JSON.parse(responseText) as unknown;
      } catch {
        return {
          ok: false,
          failure: {
            category: "invalid_response",
            message: "Provider response was not valid JSON."
          }
        };
      }

      const completion = extractCompletionText(responseJson).trim();
      if (completion.length === 0) {
        return {
          ok: false,
          failure: {
            category: "empty_completion",
            message: "Provider response did not contain a nonempty completion."
          }
        };
      }

      return {
        ok: true,
        responseUrl: endpointValidation.responseUrl,
        completionNonempty: true
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return {
      ok: false,
      failure: failureFromError(error)
    };
  }
}

function validateResponseEndpoint(
  response: Response,
  endpoint: string
): { ok: true; responseUrl: string } | { ok: false; failure: SmokeFailure } {
  if (response.redirected) {
    return {
      ok: false,
      failure: {
        category: "base_url_mismatch",
        message: "Provider response was redirected away from the configured endpoint."
      }
    };
  }

  if (!response.url) {
    return {
      ok: false,
      failure: {
        category: "base_url_mismatch",
        message: "Provider response did not expose a final URL for configured endpoint validation."
      }
    };
  }

  try {
    const responseUrl = new URL(response.url).toString();
    if (responseUrl === new URL(endpoint).toString()) {
      return {
        ok: true,
        responseUrl
      };
    }
  } catch {
    return {
      ok: false,
      failure: {
        category: "base_url_mismatch",
        message: "Provider response URL could not be validated against the configured endpoint."
      }
    };
  }

  return {
    ok: false,
    failure: {
      category: "base_url_mismatch",
      message: "Provider response URL did not match the configured endpoint."
    }
  };
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (!response.body) {
    const text = await withAbort(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new OversizedResponseError(maxBytes);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await readChunkWithAbort(reader, signal);
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OversizedResponseError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after an abort/cancel path.
    }
  }
}

async function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolvePromise, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reader.cancel().catch(() => undefined);
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolvePromise, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function failureFromError(error: unknown): SmokeFailure {
  if (error instanceof OversizedResponseError) {
    return {
      category: "oversized_response",
      message: `Provider response exceeded ${error.maxBytes} bytes.`
    };
  }

  if (isAbortError(error)) {
    return {
      category: "timeout",
      message: "Provider request timed out."
    };
  }

  return {
    category: "network_error",
    message: "Provider request failed before a valid response was received."
  };
}

class OversizedResponseError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Provider response exceeded ${maxBytes} bytes.`);
    this.name = "OversizedResponseError";
  }
}

function createAbortError(): Error {
  const error = new Error("Provider request timed out.");
  error.name = "AbortError";
  return error;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LocalSmokeError("Provider base_url must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new LocalSmokeError("Provider base_url must use https.");
  }
  return url.toString().replace(/\/+$/, "");
}

function endpointHitsConfiguredBaseUrl(endpoint: string, baseUrl: string): boolean {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedEndpoint = new URL(endpoint).toString();
  return normalizedEndpoint === `${normalizedBaseUrl}/chat/completions`;
}

function extractCompletionText(raw: unknown): string {
  const response = readRecord(raw, "provider response");
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const firstChoice = readOptionalRecord(choices[0]);
  const message = readOptionalRecord(firstChoice?.message);
  const content = message?.content;
  if (typeof content === "string") {
    const trimmedContent = content.trim();
    if (trimmedContent.length > 0) {
      return content;
    }
  }
  return "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSmokeError(`Expected object at ${context}.`);
  }
  return value as Record<string, unknown>;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalSmokeError(`Expected nonempty string at ${context}.${key}.`);
  }
  return value;
}

function readExactlyFalse(record: Record<string, unknown>, key: string, context: string): false {
  if (record[key] !== false) {
    throw new LocalSmokeError(`Expected false at ${context}.${key}.`);
  }
  return false;
}

function readStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LocalSmokeError(`Expected nonempty string array at ${context}.`);
  }
  const strings = value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new LocalSmokeError(`Expected nonempty string at ${context}[${index}].`);
    }
    return item;
  });
  return strings;
}

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
  result: Extract<SmokeRunResult, { ok: true }>,
  repoRoot = DEFAULT_REPO_ROOT
): string {
  const notePath = result.readinessNotePath.replace(`${resolve(repoRoot)}/`, "");
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
      await invalidatePassingReadinessNote(DEFAULT_REPO_ROOT);
      console.error(`GLM provider smoke failed: ${CLI_UNSUPPORTED_ARGUMENT_MESSAGE}`);
      process.exitCode = 1;
      return;
    }

    const result = await runGlmProviderSmoke();
    if (result.ok) {
      console.log(formatSmokeSuccessCliOutput(result));
      return;
    }

    console.error(`GLM provider smoke failed: ${result.error.message}`);
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof LocalSmokeError ? error.message : "Smoke command failed before provider readiness could be recorded.";
    console.error(`GLM provider smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
