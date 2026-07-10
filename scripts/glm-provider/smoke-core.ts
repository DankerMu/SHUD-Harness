import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SmokeFailure } from "./readiness-note";

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
export const CANONICAL_ENDPOINT = "https://www.dmxapi.cn/v1/chat/completions";
export const CANONICAL_SMOKE_MODEL = "deepseek-v4-pro-guan";
export const CANONICAL_TARGET_MODEL = "glm-5.2";
export const CANONICAL_TARGET_MODEL_REF = "glm-dmxapi/target";
const CONFIG_SCHEMA_VERSION = "m1.glm-provider.v1";
const CANONICAL_TARGET_MAX_CONTEXT = 128000;
const CANONICAL_TARGET_MAX_OUTPUT = 4096;
const CANONICAL_TARGET_CAPABILITIES = ["chat"] as const;
const CANONICAL_TARGET_TAGS = ["target", "placeholder"] as const;
const CANONICAL_TARGET_PURPOSE = "runtime_target_placeholder";
const CONFIG_DOCUMENT_KEYS = [
  "schema_version",
  "default_provider",
  "default_model",
  "fallback_chain",
  "task_closure_model",
  "context_compaction_model",
  "fallback_smoke_model",
  "smoke_model",
  "target_model_id",
  "providers"
] as const;
const PROVIDER_KEYS = ["api_type", "base_url", "auth", "models"] as const;
const AUTH_KEYS = ["type", "api_key_ref"] as const;
const TARGET_KEYS = [
  "model_id",
  "max_context",
  "max_output",
  "capabilities",
  "tags",
  "purpose",
  "admission"
] as const;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDirectory, "..", "..");
export const DEFAULT_PROVIDER_CONFIG_PATH = join(DEFAULT_REPO_ROOT, DEFAULT_CONFIG_RELATIVE_PATH);
export type ReachableHttpErrorStatus = number;

export function isReachableHttpErrorStatus(status: unknown): status is ReachableHttpErrorStatus {
  return Number.isInteger(status) && Number(status) >= 300 && Number(status) <= 599;
}

export type SmokeFetch = (input: string, init: RequestInit & { signal: AbortSignal }) => Promise<Response>;

export interface GlmProviderConfig {
  providerName: typeof CANONICAL_PROVIDER_NAME;
  defaultModel: typeof CANONICAL_TARGET_MODEL_REF;
  apiType: typeof API_TYPE;
  baseUrl: typeof CANONICAL_BASE_URL;
  apiKeyRef: typeof GLM_API_KEY_REF;
  fallbackChain: string[];
  smokeModel: typeof CANONICAL_SMOKE_MODEL;
  targetModelId: typeof CANONICAL_TARGET_MODEL;
  modelPlaceholders: Record<string, string>;
  zeroAdapter: {
    apiType: typeof API_TYPE;
    baseUrl: typeof CANONICAL_BASE_URL;
    auth: {
      type: "api_key";
      apiKeyRef: typeof GLM_API_KEY_REF;
    };
    models: {
      target: { modelId: typeof CANONICAL_TARGET_MODEL };
    };
  };
}

export type SmokeCoreResult =
  | {
      ok: true;
      status: "passed";
      checkedAt: string;
      config: GlmProviderConfig;
      endpoint: typeof CANONICAL_ENDPOINT;
      attempts: number;
      configuredBaseUrlHit: true;
      responseUrl: typeof CANONICAL_ENDPOINT;
      completionNonempty: true;
    }
  | {
      ok: false;
      status: "failed";
      checkedAt: string;
      config: GlmProviderConfig;
      endpoint: typeof CANONICAL_ENDPOINT;
      attempts: number;
      configuredBaseUrlHit: boolean;
      completionNonempty: false;
      error: SmokeFailure;
    };

export interface SmokeCoreInput {
  configPath: string;
  env: Record<string, string | undefined>;
  fetchImpl: SmokeFetch;
  timeoutMs: number;
  now: () => Date;
}

interface AttemptSuccess {
  ok: true;
  responseUrl: typeof CANONICAL_ENDPOINT;
  completionNonempty: true;
}

interface AttemptFailure {
  ok: false;
  failure: SmokeFailure;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

export class LocalSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSmokeError";
  }
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
  if (document.model_pools !== undefined) {
    throw new LocalSmokeError("Provider config must not define Zero model pools.");
  }
  assertExactKeys(document, CONFIG_DOCUMENT_KEYS, "Provider config document");
  readExactString(document, "schema_version", CONFIG_SCHEMA_VERSION, "provider config");
  const defaultProvider = readExactString(
    document,
    "default_provider",
    CANONICAL_PROVIDER_NAME,
    "provider config"
  );
  const defaultModel = readExactString(
    document,
    "default_model",
    CANONICAL_TARGET_MODEL_REF,
    "provider config"
  );
  const providers = readRecord(document.providers, "provider config.providers");
  assertExactSingleKey(
    providers,
    CANONICAL_PROVIDER_NAME,
    "Provider config.providers must contain only the canonical GLM provider."
  );
  const provider = readRecord(providers[CANONICAL_PROVIDER_NAME], `provider ${defaultProvider}`);
  assertExactKeys(provider, PROVIDER_KEYS, "Provider config provider");

  const apiType = readExactString(provider, "api_type", API_TYPE, defaultProvider);
  const baseUrl = readExactString(provider, "base_url", CANONICAL_BASE_URL, defaultProvider);
  const auth = readRecord(provider.auth, `${defaultProvider}.auth`);
  assertExactKeys(auth, AUTH_KEYS, "Provider config auth");
  readExactString(auth, "type", "api_key", `${defaultProvider}.auth`);
  const apiKeyRef = readExactString(auth, "api_key_ref", GLM_API_KEY_REF, `${defaultProvider}.auth`);
  const fallbackChain = readExactStringArray(
    document,
    "fallback_chain",
    [CANONICAL_TARGET_MODEL_REF],
    "provider config"
  );
  const smokeModel = readExactString(document, "smoke_model", CANONICAL_SMOKE_MODEL, "provider config");
  const targetModelId = readExactString(document, "target_model_id", CANONICAL_TARGET_MODEL, "provider config");
  const taskClosureModel = readExactString(
    document,
    "task_closure_model",
    CANONICAL_TARGET_MODEL_REF,
    "provider config"
  );
  const contextCompactionModel = readExactString(
    document,
    "context_compaction_model",
    CANONICAL_TARGET_MODEL_REF,
    "provider config"
  );
  const fallbackSmokeModel = readExactString(
    document,
    "fallback_smoke_model",
    CANONICAL_SMOKE_MODEL,
    "provider config"
  );
  const modelPlaceholders = {
    task_closure_model: taskClosureModel,
    context_compaction_model: contextCompactionModel,
    fallback_smoke_model: fallbackSmokeModel
  };
  const models = readRecord(provider.models, `${defaultProvider}.models`);
  assertExactSingleKey(
    models,
    "target",
    "Provider models must contain only the canonical GLM target model."
  );
  const target = readRecord(models.target, `${defaultProvider}.models.target`);
  assertExactKeys(target, TARGET_KEYS, "Provider config target model");
  readExactString(target, "model_id", CANONICAL_TARGET_MODEL, `${defaultProvider}.models.target`);
  readExactNumber(
    target,
    "max_context",
    CANONICAL_TARGET_MAX_CONTEXT,
    `${defaultProvider}.models.target`
  );
  readExactNumber(
    target,
    "max_output",
    CANONICAL_TARGET_MAX_OUTPUT,
    `${defaultProvider}.models.target`
  );
  readExactStringArray(
    target,
    "capabilities",
    CANONICAL_TARGET_CAPABILITIES,
    `${defaultProvider}.models.target`
  );
  readExactStringArray(
    target,
    "tags",
    CANONICAL_TARGET_TAGS,
    `${defaultProvider}.models.target`
  );
  readExactString(
    target,
    "purpose",
    CANONICAL_TARGET_PURPOSE,
    `${defaultProvider}.models.target`
  );
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

export async function runSmokeCore(options: SmokeCoreInput): Promise<SmokeCoreResult> {
  const checkedAt = options.now().toISOString();
  const config = await loadProviderConfig(options.configPath);
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  const configuredBaseUrlHit = endpointHitsConfiguredBaseUrl(endpoint, config.baseUrl);
  const apiKey = options.env[GLM_API_KEY_ENV];

  if (!configuredBaseUrlHit) {
    return failedCoreResult({
      checkedAt,
      config,
      endpoint,
      attempts: 0,
      configuredBaseUrlHit,
      error: {
        category: "base_url_mismatch",
        message: "Computed chat completions endpoint does not use the configured base URL."
      }
    });
  }

  if (!apiKey) {
    return failedCoreResult({
      checkedAt,
      config,
      endpoint,
      attempts: 0,
      configuredBaseUrlHit,
      error: {
        category: "missing_key",
        message: `Missing required environment variable ${GLM_API_KEY_ENV}.`
      }
    });
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
      return {
        ok: true,
        status: "passed",
        checkedAt,
        config,
        endpoint,
        attempts: attempt,
        configuredBaseUrlHit: true,
        responseUrl: result.responseUrl,
        completionNonempty: true
      };
    }

    lastFailure = result.failure;
  }

  return failedCoreResult({
    checkedAt,
    config,
    endpoint,
    attempts: totalAttempts,
    configuredBaseUrlHit,
    error: lastFailure
  });
}

function failedCoreResult(input: {
  checkedAt: string;
  config: GlmProviderConfig;
  endpoint: typeof CANONICAL_ENDPOINT;
  attempts: number;
  configuredBaseUrlHit: boolean;
  error: SmokeFailure;
}): SmokeCoreResult {
  return {
    ok: false,
    status: "failed",
    checkedAt: input.checkedAt,
    config: input.config,
    endpoint: input.endpoint,
    attempts: input.attempts,
    configuredBaseUrlHit: input.configuredBaseUrlHit,
    completionNonempty: false,
    error: input.error
  };
}

export function chatCompletionsEndpoint(baseUrl: string): typeof CANONICAL_ENDPOINT {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  if (endpoint !== CANONICAL_ENDPOINT) {
    throw new LocalSmokeError("Computed chat completions endpoint does not match canonical DMXAPI endpoint.");
  }
  return endpoint;
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

async function sendChatCompletion(input: {
  config: GlmProviderConfig;
  endpoint: typeof CANONICAL_ENDPOINT;
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
        return await failWithoutReadingResponse({
          response,
          failure: endpointValidation.failure,
          controller,
          signal: controller.signal
        });
      }
      if (!response.ok) {
        if (!isReachableHttpErrorStatus(response.status)) {
          return await failWithoutReadingResponse({
            response,
            failure: {
              category: "network_error",
              message: "Provider request failed before a valid response was received."
            },
            controller,
            signal: controller.signal
          });
        }
        return await failWithoutReadingResponse({
          response,
          failure: {
            category: "http_error",
            message: `Provider returned HTTP ${response.status} from configured endpoint.`,
            http_status: response.status
          },
          controller,
          signal: controller.signal
        });
      }
      const responseText = await readResponseTextWithLimit(
        response,
        MAX_RESPONSE_BYTES,
        controller
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

async function failWithoutReadingResponse(input: {
  response: Response;
  failure: SmokeFailure;
  controller: AbortController;
  signal: AbortSignal;
}): Promise<AttemptFailure> {
  await cancelBodyWithinAttempt({
    cancel: () => input.response.body?.cancel(),
    controller: input.controller,
    signal: input.signal
  });

  return {
    ok: false,
    failure: input.failure
  };
}

function validateResponseEndpoint(
  response: Response,
  endpoint: typeof CANONICAL_ENDPOINT
): { ok: true; responseUrl: typeof CANONICAL_ENDPOINT } | { ok: false; failure: SmokeFailure } {
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
        responseUrl: endpoint
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
  controller: AbortController
): Promise<string> {
  const signal = controller.signal;
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
        await cancelBodyWithinAttempt({
          cancel: () => reader.cancel(),
          controller,
          signal
        });
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

async function cancelBodyWithinAttempt(input: {
  cancel: () => Promise<unknown> | undefined;
  controller: AbortController;
  signal: AbortSignal;
}): Promise<void> {
  let cancelPromise: Promise<unknown> | undefined;
  try {
    cancelPromise = input.cancel()?.catch(() => undefined);
  } catch {
    cancelPromise = undefined;
  }

  input.controller.abort();
  if (cancelPromise) {
    await withAbort(cancelPromise, input.signal).catch(() => undefined);
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

function readExactString<Expected extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: Expected,
  context: string
): Expected {
  if (record[key] !== expected) {
    throw new LocalSmokeError(`Invalid ${context}.${key}.`);
  }
  return expected;
}

function readExactNumber<Expected extends number>(
  record: Record<string, unknown>,
  key: string,
  expected: Expected,
  context: string
): Expected {
  if (record[key] !== expected) {
    throw new LocalSmokeError(`Invalid ${context}.${key}.`);
  }
  return expected;
}

function readExactlyFalse(record: Record<string, unknown>, key: string, context: string): false {
  if (record[key] !== false) {
    throw new LocalSmokeError(`Expected false at ${context}.${key}.`);
  }
  return false;
}

function readExactStringArray<Expected extends string>(
  record: Record<string, unknown>,
  key: string,
  expected: readonly Expected[],
  context: string
): Expected[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new LocalSmokeError(`Invalid ${context}.${key}.`);
  }
  for (const [index, expectedValue] of expected.entries()) {
    if (value[index] !== expectedValue) {
      throw new LocalSmokeError(`Invalid ${context}.${key}.`);
    }
  }
  return [...expected];
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

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LocalSmokeError(`${label} keys must match the canonical provider schema.`);
  }
}

function assertExactSingleKey(
  record: Record<string, unknown>,
  expectedKey: string,
  message: string
): void {
  const actual = Object.keys(record);
  if (actual.length !== 1 || actual[0] !== expectedKey) {
    throw new LocalSmokeError(message);
  }
}
