import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API_TYPE,
  CANONICAL_BASE_URL,
  CANONICAL_PROVIDER_NAME,
  CANONICAL_SMOKE_MODEL,
  CANONICAL_TARGET_MODEL,
  CANONICAL_TARGET_MODEL_REF,
  DEFAULT_CONFIG_RELATIVE_PATH,
  DEFAULT_PROVIDER_CONFIG_PATH,
  FIXTURE_READINESS_NOTE_NAME,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  loadProviderConfig,
  parseProviderConfig,
  runGlmProviderSmokeFixture,
  type SmokeFetch
} from "./smoke";
import {
  createTempRootTracker,
  fixedNow,
  makeFakeSecret,
  readReadinessStatus
} from "./test-helpers";

type JsonRecord = Record<string, unknown>;
type MutationCase = {
  name: string;
  mutate: (config: JsonRecord) => void;
  forbidden?: string[];
};

const tempRoots = createTempRootTracker();
const SECRET_SENTINEL = "CONFIG_SCHEMA_SECRET_SENTINEL";
const DOCUMENT_KEYS = [
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
];
const PROVIDER_KEYS = ["api_type", "base_url", "auth", "models"];
const AUTH_KEYS = ["type", "api_key_ref"];
const TARGET_KEYS = [
  "model_id",
  "max_context",
  "max_output",
  "capabilities",
  "tags",
  "purpose",
  "admission"
];

describe("glm provider exact source config schema", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  test("source config exposes only the canonical keys and values", async () => {
    const raw = await readSourceConfig();
    const providers = providerMapOf(raw);
    const provider = providerOf(raw);
    const auth = authOf(raw);
    const models = modelsOf(raw);
    const target = targetOf(raw);
    const parsed = await loadProviderConfig(DEFAULT_PROVIDER_CONFIG_PATH);

    expect(Object.keys(raw)).toEqual(DOCUMENT_KEYS);
    expect(raw.schema_version).toBe("m1.glm-provider.v1");
    expect(raw.default_provider).toBe(CANONICAL_PROVIDER_NAME);
    expect(raw.default_model).toBe(CANONICAL_TARGET_MODEL_REF);
    expect(raw.fallback_chain).toEqual([CANONICAL_TARGET_MODEL_REF]);
    expect(raw.task_closure_model).toBe(CANONICAL_TARGET_MODEL_REF);
    expect(raw.context_compaction_model).toBe(CANONICAL_TARGET_MODEL_REF);
    expect(raw.fallback_smoke_model).toBe(CANONICAL_SMOKE_MODEL);
    expect(raw.smoke_model).toBe(CANONICAL_SMOKE_MODEL);
    expect(raw.target_model_id).toBe(CANONICAL_TARGET_MODEL);
    expect(Object.keys(providers)).toEqual([CANONICAL_PROVIDER_NAME]);
    expect(Object.keys(provider)).toEqual(PROVIDER_KEYS);
    expect(provider.api_type).toBe(API_TYPE);
    expect(provider.base_url).toBe(CANONICAL_BASE_URL);
    expect(Object.keys(auth)).toEqual(AUTH_KEYS);
    expect(auth.type).toBe("api_key");
    expect(auth.api_key_ref).toBe(GLM_API_KEY_REF);
    expect(Object.keys(models)).toEqual(["target"]);
    expect(Object.keys(target)).toEqual(TARGET_KEYS);
    expect(target).toMatchObject({
      model_id: CANONICAL_TARGET_MODEL,
      max_context: 128000,
      max_output: 4096,
      capabilities: ["chat"],
      tags: ["target", "placeholder"],
      purpose: "runtime_target_placeholder",
      admission: false
    });
    expect(parsed).toMatchObject({
      providerName: CANONICAL_PROVIDER_NAME,
      defaultModel: CANONICAL_TARGET_MODEL_REF,
      apiType: API_TYPE,
      baseUrl: CANONICAL_BASE_URL,
      apiKeyRef: GLM_API_KEY_REF,
      fallbackChain: [CANONICAL_TARGET_MODEL_REF],
      smokeModel: CANONICAL_SMOKE_MODEL,
      targetModelId: CANONICAL_TARGET_MODEL
    });
    expect(Object.keys(parsed.zeroAdapter.models)).toEqual(["target"]);
  });

  test("unknown keys reject at every source config level without echoing external text", async () => {
    const cases: MutationCase[] = [
      {
        name: "document record",
        mutate: (config) => {
          config.runtime_override = SECRET_SENTINEL;
        },
        forbidden: ["runtime_override", SECRET_SENTINEL]
      },
      {
        name: "providers map",
        mutate: (config) => {
          providerMapOf(config).other = { secret: SECRET_SENTINEL };
        },
        forbidden: ["other", SECRET_SENTINEL]
      },
      {
        name: "provider record",
        mutate: (config) => {
          providerOf(config).extra = SECRET_SENTINEL;
        },
        forbidden: ["extra", SECRET_SENTINEL]
      },
      {
        name: "provider headers",
        mutate: (config) => {
          providerOf(config).headers = { authorization: SECRET_SENTINEL };
        },
        forbidden: ["headers", "authorization", SECRET_SENTINEL]
      },
      {
        name: "auth record",
        mutate: (config) => {
          authOf(config).extra = SECRET_SENTINEL;
        },
        forbidden: ["extra", SECRET_SENTINEL]
      },
      {
        name: "auth api_key",
        mutate: (config) => {
          authOf(config).api_key = SECRET_SENTINEL;
        },
        forbidden: ["api_key", SECRET_SENTINEL]
      },
      {
        name: "auth authorization",
        mutate: (config) => {
          authOf(config).authorization = `Bearer ${SECRET_SENTINEL}`;
        },
        forbidden: ["authorization", SECRET_SENTINEL]
      },
      {
        name: "models map",
        mutate: (config) => {
          modelsOf(config).smoke = { model_id: CANONICAL_SMOKE_MODEL };
        },
        forbidden: ["smoke", CANONICAL_SMOKE_MODEL]
      },
      {
        name: "target record",
        mutate: (config) => {
          targetOf(config).extra = SECRET_SENTINEL;
        },
        forbidden: ["extra", SECRET_SENTINEL]
      },
      {
        name: "top-level Zero model pool",
        mutate: (config) => {
          config.model_pools = { secret: SECRET_SENTINEL };
        },
        forbidden: ["model_pools", SECRET_SENTINEL]
      }
    ];

    for (const fixture of cases) {
      const raw = await readSourceConfig();
      fixture.mutate(raw);
      const message = captureConfigError(raw, fixture.name);
      for (const forbidden of fixture.forbidden ?? []) {
        expect(message).not.toContain(forbidden);
      }
    }
  });

  test("canonical value drift rejects every provider selector and target field", async () => {
    const cases: MutationCase[] = [
      { name: "schema version", mutate: (config) => { config.schema_version = "m1.glm-provider.v2"; } },
      { name: "default provider", mutate: (config) => { config.default_provider = "other"; } },
      { name: "default model", mutate: (config) => { config.default_model = "glm-dmxapi/smoke"; } },
      { name: "fallback chain", mutate: (config) => { config.fallback_chain = ["glm-dmxapi/smoke"]; } },
      { name: "task closure model", mutate: (config) => { config.task_closure_model = "glm-dmxapi/smoke"; } },
      { name: "context compaction model", mutate: (config) => { config.context_compaction_model = "glm-dmxapi/smoke"; } },
      { name: "fallback smoke model", mutate: (config) => { config.fallback_smoke_model = "glm-5.2"; } },
      { name: "smoke model", mutate: (config) => { config.smoke_model = "glm-5.2"; } },
      { name: "target model id", mutate: (config) => { config.target_model_id = "glm-5.1"; } },
      { name: "provider api type", mutate: (config) => { providerOf(config).api_type = "other"; } },
      { name: "provider base url", mutate: (config) => { providerOf(config).base_url = "https://example.invalid/v1"; } },
      { name: "auth type", mutate: (config) => { authOf(config).type = "bearer"; } },
      { name: "auth ref", mutate: (config) => { authOf(config).api_key_ref = `env:${SECRET_SENTINEL}`; } },
      { name: "target model_id", mutate: (config) => { targetOf(config).model_id = "glm-5.1"; } },
      { name: "target max_context", mutate: (config) => { targetOf(config).max_context = 64000; } },
      { name: "target max_output", mutate: (config) => { targetOf(config).max_output = 8192; } },
      { name: "target capabilities", mutate: (config) => { targetOf(config).capabilities = ["chat", "tools"]; } },
      { name: "target tags", mutate: (config) => { targetOf(config).tags = ["placeholder", "target"]; } },
      { name: "target purpose", mutate: (config) => { targetOf(config).purpose = "runtime_target"; } },
      { name: "target admission", mutate: (config) => { targetOf(config).admission = true; } }
    ];

    for (const fixture of cases) {
      const raw = await readSourceConfig();
      fixture.mutate(raw);
      const message = captureConfigError(raw, fixture.name);
      expect(message).not.toContain(SECRET_SENTINEL);
    }
  });

  test("secret-bearing config drift rejects before fetch or fixture readiness write", async () => {
    const cases: MutationCase[] = [
      { name: "auth.api_key", mutate: (config) => { authOf(config).api_key = SECRET_SENTINEL; } },
      { name: "auth.authorization", mutate: (config) => { authOf(config).authorization = SECRET_SENTINEL; } },
      { name: "provider.headers", mutate: (config) => { providerOf(config).headers = { authorization: SECRET_SENTINEL }; } },
      { name: "top-level runtime", mutate: (config) => { config.runtime_override = SECRET_SENTINEL; } },
      { name: "auth ref value", mutate: (config) => { authOf(config).api_key_ref = `env:${SECRET_SENTINEL}`; } }
    ];

    for (const fixture of cases) {
      const repo = await tempRoots.createTempRepo();
      const raw = await readSourceConfig();
      let fetchCalls = 0;
      fixture.mutate(raw);
      await writeProviderConfig(repo.repoRoot, raw);

      const fetchImpl: SmokeFetch = async () => {
        fetchCalls += 1;
        throw new Error("Config schema should reject before fetch.");
      };
      const message = await captureFixtureError(repo.repoRoot, fetchImpl);

      expect(fetchCalls).toBe(0);
      expect(message).not.toContain(SECRET_SENTINEL);
      expect(await readReadinessStatus(repo.repoRoot, FIXTURE_READINESS_NOTE_NAME)).toBeUndefined();
    }
  });
});

async function readSourceConfig(): Promise<JsonRecord> {
  return JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as JsonRecord;
}

async function writeProviderConfig(repoRoot: string, config: JsonRecord): Promise<void> {
  const configPath = join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH);
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function captureFixtureError(repoRoot: string, fetchImpl: SmokeFetch): Promise<string> {
  try {
    await runGlmProviderSmokeFixture({
      repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow,
      timeoutMs: 5
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Fixture smoke accepted invalid provider config.");
}

function captureConfigError(config: JsonRecord, name: string): string {
  try {
    parseProviderConfig(config);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Provider config drift was accepted: ${name}`);
}

function providerMapOf(config: JsonRecord): JsonRecord {
  return recordAt(config.providers, "providers");
}

function providerOf(config: JsonRecord): JsonRecord {
  return recordAt(providerMapOf(config)[CANONICAL_PROVIDER_NAME], "provider");
}

function authOf(config: JsonRecord): JsonRecord {
  return recordAt(providerOf(config).auth, "auth");
}

function modelsOf(config: JsonRecord): JsonRecord {
  return recordAt(providerOf(config).models, "models");
}

function targetOf(config: JsonRecord): JsonRecord {
  return recordAt(modelsOf(config).target, "target");
}

function recordAt(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected config record: ${label}`);
  }
  return value as JsonRecord;
}
