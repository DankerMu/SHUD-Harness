import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GLM_API_KEY_ENV = "GLM_API_KEY";
export const GLM_API_KEY_REF = "env:GLM_API_KEY";
export const API_TYPE = "openai_chat_completions";
export const DEFAULT_CONFIG_RELATIVE_PATH = "config/providers/glm.dmxapi.json";
export const DEFAULT_READINESS_NOTE_NAME = "glm_provider_smoke.json";
export const DEFAULT_TIMEOUT_MS = 15000;
export const MAX_RETRIES = 1;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(scriptDirectory, "..", "..");
export const DEFAULT_PROVIDER_CONFIG_PATH = join(
  DEFAULT_REPO_ROOT,
  DEFAULT_CONFIG_RELATIVE_PATH
);

export type SmokeFetch = (
  input: string,
  init: RequestInit & { signal: AbortSignal }
) => Promise<Response>;

export interface GlmProviderConfig {
  providerName: string;
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
    models: Record<string, { modelId: string }>;
  };
}

export type SmokeStatus = "passed" | "failed";

export type SmokeFailureCategory =
  | "missing_key"
  | "base_url_mismatch"
  | "http_error"
  | "invalid_response"
  | "empty_completion"
  | "timeout"
  | "network_error";

export interface SmokeFailure {
  category: SmokeFailureCategory;
  message: string;
}

export interface ReadinessNote {
  schema_version: "m1.glm-provider-smoke.v1";
  kind: "glm_provider_smoke";
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
  response_model?: string;
  failure?: SmokeFailure;
}

export type SmokeRunResult =
  | {
      ok: true;
      status: "passed";
      config: GlmProviderConfig;
      endpoint: string;
      attempts: number;
      completion: string;
      readinessNotePath?: string;
      note: ReadinessNote;
    }
  | {
      ok: false;
      status: "failed";
      config: GlmProviderConfig;
      endpoint: string;
      attempts: number;
      error: SmokeFailure;
      readinessNotePath?: string;
      note: ReadinessNote;
    };

export interface RunSmokeOptions {
  repoRoot?: string;
  configPath?: string;
  readinessNoteName?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: SmokeFetch;
  timeoutMs?: number;
  now?: () => Date;
  writeReadinessNote?: boolean;
}

interface AttemptSuccess {
  ok: true;
  completion: string;
  responseModel?: string;
}

interface AttemptFailure {
  ok: false;
  failure: SmokeFailure;
}

type AttemptResult = AttemptSuccess | AttemptFailure;

export async function loadProviderConfig(configPath = DEFAULT_PROVIDER_CONFIG_PATH) {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseProviderConfig(parsed);
}

export function parseProviderConfig(raw: unknown): GlmProviderConfig {
  const document = readRecord(raw, "provider config");
  const defaultProvider = readString(document, "default_provider", "provider config");
  const providers = readRecord(document.providers, "provider config.providers");
  const provider = readRecord(providers[defaultProvider], `provider ${defaultProvider}`);

  const apiType = readString(provider, "api_type", defaultProvider);
  const baseUrl = normalizeBaseUrl(readString(provider, "base_url", defaultProvider));
  const apiKeyRef = readString(provider, "api_key_ref", defaultProvider);
  const fallbackChain = readStringArray(provider.fallback_chain, `${defaultProvider}.fallback_chain`);
  const smokeModel = readString(provider, "smoke_model", defaultProvider);
  const targetModelId = readString(provider, "target_model_id", defaultProvider);
  const modelPlaceholders = readStringRecord(
    provider.model_placeholders,
    `${defaultProvider}.model_placeholders`
  );
  const models = readRecord(provider.models, `${defaultProvider}.models`);
  const smoke = readRecord(models.smoke, `${defaultProvider}.models.smoke`);
  const target = readRecord(models.target, `${defaultProvider}.models.target`);
  const zeroAdapter = readRecord(provider.zero_adapter, `${defaultProvider}.zero_adapter`);
  const zeroAuth = readRecord(zeroAdapter.auth, `${defaultProvider}.zero_adapter.auth`);
  const zeroModels = readRecord(zeroAdapter.models, `${defaultProvider}.zero_adapter.models`);
  const zeroSmoke = readRecord(zeroModels.smoke, `${defaultProvider}.zero_adapter.models.smoke`);
  const zeroTarget = readRecord(zeroModels.target, `${defaultProvider}.zero_adapter.models.target`);

  if (apiType !== API_TYPE) {
    throw new Error(`Invalid provider api_type: expected ${API_TYPE}.`);
  }
  if (apiKeyRef !== GLM_API_KEY_REF) {
    throw new Error(`Invalid provider api_key_ref: expected ${GLM_API_KEY_REF}.`);
  }
  if (fallbackChain.length === 0) {
    throw new Error("Provider fallback_chain must not be empty.");
  }
  if (readString(smoke, "model_id", `${defaultProvider}.models.smoke`) !== smokeModel) {
    throw new Error("Provider smoke model fields do not agree.");
  }
  if (readString(target, "model_id", `${defaultProvider}.models.target`) !== targetModelId) {
    throw new Error("Provider target model fields do not agree.");
  }
  if (readString(zeroAdapter, "apiType", `${defaultProvider}.zero_adapter`) !== API_TYPE) {
    throw new Error("Zero adapter apiType does not match provider api_type.");
  }
  if (normalizeBaseUrl(readString(zeroAdapter, "baseUrl", `${defaultProvider}.zero_adapter`)) !== baseUrl) {
    throw new Error("Zero adapter baseUrl does not match provider base_url.");
  }
  if (readString(zeroAuth, "type", `${defaultProvider}.zero_adapter.auth`) !== "api_key") {
    throw new Error("Zero adapter auth.type must be api_key.");
  }
  if (readString(zeroAuth, "apiKeyRef", `${defaultProvider}.zero_adapter.auth`) !== GLM_API_KEY_REF) {
    throw new Error("Zero adapter apiKeyRef does not match provider api_key_ref.");
  }
  if (readString(zeroSmoke, "modelId", `${defaultProvider}.zero_adapter.models.smoke`) !== smokeModel) {
    throw new Error("Zero adapter smoke model does not match provider smoke_model.");
  }
  if (readString(zeroTarget, "modelId", `${defaultProvider}.zero_adapter.models.target`) !== targetModelId) {
    throw new Error("Zero adapter target model does not match provider target_model_id.");
  }

  return {
    providerName: defaultProvider,
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
        smoke: { modelId: smokeModel },
        target: { modelId: targetModelId }
      }
    }
  };
}

export async function runGlmProviderSmoke(options: RunSmokeOptions = {}): Promise<SmokeRunResult> {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const configPath = resolveConfigPath(repoRoot, options.configPath);
  const config = await loadProviderConfig(configPath);
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  const configuredBaseUrlHit = endpointHitsConfiguredBaseUrl(endpoint, config.baseUrl);
  const env = options.env ?? process.env;
  const apiKey = env[GLM_API_KEY_ENV];
  const now = options.now ?? (() => new Date());
  const writeReadiness = options.writeReadinessNote ?? true;

  if (!configuredBaseUrlHit) {
    const error = {
      category: "base_url_mismatch",
      message: "Computed chat completions endpoint does not use the configured base URL."
    } satisfies SmokeFailure;
    const note = createReadinessNote({
      config,
      endpoint,
      status: "failed",
      attempts: 0,
      configuredBaseUrlHit,
      completionNonempty: false,
      now,
      failure: error
    });
    const readinessNotePath = writeReadiness
      ? await writeReadinessNote(repoRoot, note, options.readinessNoteName)
      : undefined;
    return {
      ok: false,
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
    const note = createReadinessNote({
      config,
      endpoint,
      status: "failed",
      attempts: 0,
      configuredBaseUrlHit,
      completionNonempty: false,
      now,
      failure: error
    });
    const readinessNotePath = writeReadiness
      ? await writeReadinessNote(repoRoot, note, options.readinessNoteName)
      : undefined;
    return {
      ok: false,
      status: "failed",
      config,
      endpoint,
      attempts: 0,
      error,
      note,
      readinessNotePath
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      fetchImpl,
      timeoutMs
    });

    if (result.ok) {
      const note = createReadinessNote({
        config,
        endpoint,
        status: "passed",
        attempts: attempt,
        configuredBaseUrlHit,
        completionNonempty: true,
        responseModel: result.responseModel,
        now
      });
      const readinessNotePath = writeReadiness
        ? await writeReadinessNote(repoRoot, note, options.readinessNoteName)
        : undefined;
      return {
        ok: true,
        status: "passed",
        config,
        endpoint,
        attempts: attempt,
        completion: result.completion,
        note,
        readinessNotePath
      };
    }

    lastFailure = redactFailure(result.failure, apiKey);
  }

  const note = createReadinessNote({
    config,
    endpoint,
    status: "failed",
    attempts: totalAttempts,
    configuredBaseUrlHit,
    completionNonempty: false,
    now,
    failure: lastFailure
  });
  const readinessNotePath = writeReadiness
    ? await writeReadinessNote(repoRoot, note, options.readinessNoteName)
    : undefined;
  return {
    ok: false,
    status: "failed",
    config,
    endpoint,
    attempts: totalAttempts,
    error: lastFailure,
    note,
    readinessNotePath
  };
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
    max_tokens: 64,
    temperature: 0,
    stream: false
  };
}

export function redactText(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

export function createReadinessNote(input: {
  config: GlmProviderConfig;
  endpoint: string;
  status: SmokeStatus;
  attempts: number;
  configuredBaseUrlHit: boolean;
  completionNonempty: boolean;
  responseModel?: string;
  now: () => Date;
  failure?: SmokeFailure;
}): ReadinessNote {
  return {
    schema_version: "m1.glm-provider-smoke.v1",
    kind: "glm_provider_smoke",
    checked_at: input.now().toISOString(),
    provider_name: input.config.providerName,
    api_type: input.config.apiType,
    base_url: input.config.baseUrl,
    endpoint: input.endpoint,
    smoke_model: input.config.smokeModel,
    target_model_id: input.config.targetModelId,
    status: input.status,
    model_admission: false,
    secret_ref: input.config.apiKeyRef,
    attempts: input.attempts,
    configured_base_url_hit: input.configuredBaseUrlHit,
    completion_nonempty: input.completionNonempty,
    ...(input.responseModel ? { response_model: input.responseModel } : {}),
    ...(input.failure ? { failure: input.failure } : {})
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
    body: JSON.stringify(payload)
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(input.fetchImpl, input.endpoint, requestInit, input.timeoutMs);
  } catch (error) {
    return {
      ok: false,
      failure: {
        category: isAbortError(error) ? "timeout" : "network_error",
        message: failureMessage(error)
      }
    };
  }

  const responseText = await response.text();
  if (!response.ok) {
    const snippet = responseText.trim().slice(0, 300);
    return {
      ok: false,
      failure: {
        category: "http_error",
        message: snippet
          ? `HTTP ${response.status} from configured endpoint: ${snippet}`
          : `HTTP ${response.status} from configured endpoint.`
      }
    };
  }

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
    completion,
    responseModel: extractResponseModel(responseJson)
  };
}

async function fetchWithTimeout(
  fetchImpl: SmokeFetch,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(endpoint, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function writeReadinessNote(
  repoRoot: string,
  note: ReadinessNote,
  noteName = DEFAULT_READINESS_NOTE_NAME
): Promise<string> {
  if (noteName !== DEFAULT_READINESS_NOTE_NAME || noteName.includes("/") || noteName.includes("\\")) {
    throw new Error(`Readiness note name must be ${DEFAULT_READINESS_NOTE_NAME}.`);
  }

  const realRepoRoot = await realpath(repoRoot);
  const workspaceDir = join(realRepoRoot, "workspace");
  const readinessDir = join(workspaceDir, "readiness");
  await ensureOwnedDirectory(workspaceDir, "workspace");
  await ensureOwnedDirectory(readinessDir, "workspace/readiness");
  const realReadinessDir = await realpath(readinessDir);
  const expectedReadinessDir = join(realRepoRoot, "workspace", "readiness");
  if (realReadinessDir !== expectedReadinessDir) {
    throw new Error("Readiness note directory must resolve under workspace/readiness.");
  }

  const notePath = join(readinessDir, noteName);
  await writeFile(notePath, `${JSON.stringify(note, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return notePath;
}

async function ensureOwnedDirectory(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Readiness ${label} path must be an owned directory.`);
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { mode: 0o700 });
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}

function resolveConfigPath(repoRoot: string, configPath?: string): string {
  if (!configPath) {
    return join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH);
  }
  return resolve(repoRoot, configPath);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "https:") {
    throw new Error("Provider base_url must use https.");
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
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        const record = readOptionalRecord(part);
        return typeof record?.text === "string" ? record.text : "";
      })
      .join("");
    if (textParts.trim().length > 0) {
      return textParts;
    }
  }
  const reasoningContent = message?.reasoning_content;
  if (typeof reasoningContent === "string" && reasoningContent.trim().length > 0) {
    return reasoningContent;
  }
  const text = firstChoice?.text;
  return typeof text === "string" ? text : "";
}

function extractResponseModel(raw: unknown): string | undefined {
  const response = readOptionalRecord(raw);
  return typeof response?.model === "string" ? response.model : undefined;
}

function redactFailure(failure: SmokeFailure, apiKey: string): SmokeFailure {
  return {
    category: failure.category,
    message: redactText(failure.message, [apiKey])
  };
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "Provider request timed out." : error.message;
  }
  return "Provider request failed.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object at ${context}.`);
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
    throw new Error(`Expected nonempty string at ${context}.${key}.`);
  }
  return value;
}

function readStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected nonempty string array at ${context}.`);
  }
  const strings = value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`Expected nonempty string at ${context}[${index}].`);
    }
    return item;
  });
  return strings;
}

function readStringRecord(value: unknown, context: string): Record<string, string> {
  const record = readRecord(value, context);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`Expected nonempty string at ${context}.${key}.`);
    }
    result[key] = item;
  }
  return result;
}

function parseCliArgs(args: string[]): {
  repoRoot?: string;
  configPath?: string;
  timeoutMs?: number;
} {
  const parsed: {
    repoRoot?: string;
    configPath?: string;
    timeoutMs?: number;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--repo-root" && next) {
      parsed.repoRoot = next;
      index += 1;
    } else if (arg === "--config" && next) {
      parsed.configPath = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      parsed.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (parsed.timeoutMs !== undefined && (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive integer.");
  }

  return parsed;
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun scripts/glm-provider/smoke.ts [--config <path>] [--repo-root <path>] [--timeout-ms <ms>]",
      "",
      "Runs one non-stream OpenAI-compatible chat-completions smoke against the configured GLM provider.",
      `The API key must be provided through ${GLM_API_KEY_ENV}; only ${GLM_API_KEY_REF} is persisted.`
    ].join("\n")
  );
}

async function main(): Promise<void> {
  try {
    const cliOptions = parseCliArgs(process.argv.slice(2));
    const result = await runGlmProviderSmoke(cliOptions);
    const notePath = result.readinessNotePath
      ? result.readinessNotePath.replace(`${resolve(cliOptions.repoRoot ?? DEFAULT_REPO_ROOT)}/`, "")
      : "not-written";
    if (result.ok) {
      console.log(
        [
          "GLM provider smoke passed",
          `provider=${result.config.providerName}`,
          `smoke_model=${result.config.smokeModel}`,
          `target_model_id=${result.config.targetModelId}`,
          `base_url=${result.config.baseUrl}`,
          `endpoint=${result.endpoint}`,
          `secret_ref=${result.config.apiKeyRef}`,
          "model_admission=false",
          `readiness_note=${notePath}`
        ].join(" ")
      );
      return;
    }

    console.error(`GLM provider smoke failed: ${result.error.message}`);
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown smoke failure.";
    console.error(`GLM provider smoke failed: ${redactText(message, [])}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
