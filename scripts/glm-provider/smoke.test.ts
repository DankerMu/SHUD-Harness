import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig as loadZeroConfig } from "../../zero/packages/core/src/config/loader";
import { ModelRouter } from "../../zero/packages/model/src/router";
import {
  API_TYPE,
  DEFAULT_PROVIDER_CONFIG_PATH,
  FIXTURE_READINESS_NOTE_NAME,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  buildChatCompletionPayload,
  chatCompletionsEndpoint,
  loadProviderConfig,
  parseProviderConfig,
  runGlmProviderSmokeFixture,
  type SmokeFetch
} from "./smoke";
import {
  CANONICAL_ENDPOINT,
  bareJsonResponse,
  createTempRootTracker,
  expectNoExternalText,
  fixedNow,
  jsonResponse,
  makeFakeSecret,
  readReadinessNote,
  readReadinessStatus,
  readinessNotePath,
  responseWithFinalUrl,
  textResponse
} from "./test-helpers";

const tempRoots = createTempRootTracker();

function fixtureNotePath(repoRoot: string): string {
  return readinessNotePath(repoRoot, FIXTURE_READINESS_NOTE_NAME);
}

async function readFixtureNote(repoRoot: string): Promise<Record<string, unknown>> {
  return await readReadinessNote(repoRoot, FIXTURE_READINESS_NOTE_NAME);
}

async function readFixtureStatus(repoRoot: string): Promise<unknown> {
  return await readReadinessStatus(repoRoot, FIXTURE_READINESS_NOTE_NAME);
}

describe("glm provider config and smoke", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });

  test("parses source-controlled provider config contract", async () => {
    const config = await loadProviderConfig(DEFAULT_PROVIDER_CONFIG_PATH);
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as {
      default_model: unknown;
      fallback_smoke_model: unknown;
      smoke_model: unknown;
      providers: Record<string, { models: Record<string, { admission: unknown }> }>;
    };

    expect(config.providerName).toBe("glm-dmxapi");
    expect(config.defaultModel).toBe("glm-dmxapi/target");
    expect(config.apiType).toBe(API_TYPE);
    expect(config.baseUrl).toBe("https://www.dmxapi.cn/v1");
    expect(config.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(config.fallbackChain).toEqual(["glm-dmxapi/target"]);
    expect(config.modelPlaceholders.task_closure_model).toBe("glm-dmxapi/target");
    expect(config.modelPlaceholders.context_compaction_model).toBe("glm-dmxapi/target");
    expect(config.modelPlaceholders.fallback_smoke_model).toBe("deepseek-v4-pro-guan");
    expect(config.smokeModel).toBe("deepseek-v4-pro-guan");
    expect(config.targetModelId).toBe("glm-5.2");
    expect(config.zeroAdapter.auth.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(Object.keys(config.zeroAdapter.models)).toEqual(["target"]);
    expect(config.zeroAdapter.models.target.modelId).toBe("glm-5.2");
    expect(raw.default_model).toBe("glm-dmxapi/target");
    expect(raw.fallback_smoke_model).toBe("deepseek-v4-pro-guan");
    expect(raw.smoke_model).toBe("deepseek-v4-pro-guan");
    expect(Object.keys(raw.providers["glm-dmxapi"].models)).toEqual(["target"]);
    expect(raw.providers["glm-dmxapi"].models.target.admission).toBe(false);
  });

  test("source-controlled provider config normalizes through the Zero loader", () => {
    const zeroConfig = loadZeroConfig(DEFAULT_PROVIDER_CONFIG_PATH);

    expect(zeroConfig.providers["glm-dmxapi"].auth.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(zeroConfig.defaultModel).toBe("glm-dmxapi/target");
    expect(zeroConfig.fallbackChain).toEqual(["glm-dmxapi/target"]);
    expect(zeroConfig.taskClosureModel).toBe("glm-dmxapi/target");
    expect(zeroConfig.contextCompactionModel).toBe("glm-dmxapi/target");
    expect(Object.keys(zeroConfig.providers["glm-dmxapi"].models)).toEqual(["target"]);
    expect(zeroConfig.providers["glm-dmxapi"].models.target.modelId).toBe("glm-5.2");
  });

  test("Zero registry and router cannot expose or select the smoke carrier", async () => {
    const zeroConfig = loadZeroConfig(DEFAULT_PROVIDER_CONFIG_PATH);
    const router = new ModelRouter(
      zeroConfig,
      new Map([[GLM_API_KEY_REF, makeFakeSecret()]])
    );
    const listedModels = router.getRegistry().listModels();
    const target = router.resolveModel("glm-dmxapi/target");
    if (!target) {
      throw new Error("Expected Zero to resolve the configured GLM target adapter.");
    }

    let targetHealthChecks = 0;
    target.adapter.healthCheck = async () => {
      targetHealthChecks += 1;
      return false;
    };

    const carrierSwitch = router.switchModel("deepseek-v4-pro-guan");
    const fallbackResult = await router.fallback();

    expect(listedModels).toHaveLength(1);
    expect(listedModels[0]).toMatchObject({
      providerName: "glm-dmxapi",
      modelName: "target",
      modelId: "glm-5.2"
    });
    expect(router.resolveModel("deepseek-v4-pro-guan")).toBeUndefined();
    expect(router.resolveModel("glm-dmxapi/smoke")).toBeUndefined();
    expect(carrierSwitch.success).toBe(false);
    expect(fallbackResult.success).toBe(false);
    expect(fallbackResult.model).toBeUndefined();
    expect(targetHealthChecks).toBe(1);
  });

  test("provider config rejects target admission drift", async () => {
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as {
      providers: Record<string, { models: Record<string, { admission: boolean }> }>;
    };

    raw.providers["glm-dmxapi"].models.target.admission = true;
    expect(() => parseProviderConfig(raw)).toThrow(
      "Expected false at glm-dmxapi.models.target.admission."
    );
  });

  test("provider config rejects smoke and extra Zero provider models", async () => {
    for (const modelName of ["smoke", "extra"]) {
      const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as {
        providers: Record<string, { models: Record<string, unknown> }>;
      };
      raw.providers["glm-dmxapi"].models[modelName] = {
        model_id: modelName === "smoke" ? "deepseek-v4-pro-guan" : "other-runtime-model",
        admission: false
      };

      expect(() => parseProviderConfig(raw)).toThrow(
        "Provider models must contain only the canonical GLM target model."
      );
    }
  });

  test("provider config rejects extra provider and model-pool registry surfaces", async () => {
    const extraProvider = JSON.parse(
      await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")
    ) as Record<string, unknown> & { providers: Record<string, unknown> };
    extraProvider.providers.other = {};
    expect(() => parseProviderConfig(extraProvider)).toThrow(
      "Provider config.providers must contain only the canonical GLM provider."
    );

    const modelPool = JSON.parse(
      await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")
    ) as Record<string, unknown>;
    modelPool.model_pools = {
      "glm-dmxapi/smoke": { members: [{ model: "glm-dmxapi/target" }] }
    };
    expect(() => parseProviderConfig(modelPool)).toThrow(
      "Provider config must not define Zero model pools."
    );
  });

  test("provider config rejects default_model drift to the smoke carrier", async () => {
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as Record<
      string,
      unknown
    >;

    raw.default_model = "glm-dmxapi/smoke";
    expect(() => parseProviderConfig(raw)).toThrow(
      "Provider default_model must target the canonical GLM target ref."
    );
  });

  test("provider config rejects the smoke carrier in runtime fallback_chain", async () => {
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as Record<
      string,
      unknown
    >;

    raw.fallback_chain = ["glm-dmxapi/target", "glm-dmxapi/smoke"];
    expect(() => parseProviderConfig(raw)).toThrow(
      "Provider fallback_chain must contain only the canonical GLM target ref."
    );
  });

  test("missing key fails without fetch and writes a failed readiness note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let fetchCalls = 0;
    const fetchImpl: SmokeFetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [{ message: { content: "ready" } }] });
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: {},
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(0);
    expect(fetchCalls).toBe(0);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "missing_key",
        message: `Missing required environment variable ${GLM_API_KEY_ENV}.`
      });
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.failure).toEqual({
      category: "missing_key",
      message: `Missing required environment variable ${GLM_API_KEY_ENV}.`
    });
    expect(note.secret_ref).toBe(GLM_API_KEY_REF);
    expect(note.model_admission).toBe(false);
  });

  test("fake fetch success sends non-stream chat completion and writes redacted readiness note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const fakeSecret = makeFakeSecret();
    const seenRequests: Array<{
      url: string;
      body: Record<string, unknown>;
      authorization?: string;
    }> = [];
    const fetchImpl: SmokeFetch = async (url, init) => {
      seenRequests.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        authorization: (init.headers as Record<string, string>).authorization
      });
      return jsonResponse({
        id: "chatcmpl-unit",
        model: `deepseek-v4-pro-guan-${fakeSecret}`,
        choices: [{ message: { role: "assistant", content: fakeSecret }, finish_reason: "stop" }]
      });
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: fakeSecret },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    if (result.ok) {
      expect(result.responseUrl).toBe(CANONICAL_ENDPOINT);
      expect(result.completionNonempty).toBe(true);
      expect(result).not.toHaveProperty("completion");
    }
    expect(result.evidenceScope).toBe("fixture");
    expect(result.readinessNoteName).toBe(FIXTURE_READINESS_NOTE_NAME);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].url).toBe(CANONICAL_ENDPOINT);
    expect(seenRequests[0].authorization).toBe(`Bearer ${fakeSecret}`);
    expect(seenRequests[0].body).toMatchObject({
      model: "deepseek-v4-pro-guan",
      max_tokens: 512,
      temperature: 0,
      stream: false
    });

    const noteText = await readFile(fixtureNotePath(repo.repoRoot), "utf8");
    const note = JSON.parse(noteText) as Record<string, unknown>;
    expect(note).toMatchObject({
      schema_version: "m1.glm-provider-smoke.fixture.v1",
      kind: "glm_provider_smoke_fixture",
      evidence_scope: "fixture",
      checked_at: "2026-07-08T10:00:00.000Z",
      provider_name: "glm-dmxapi",
      api_type: API_TYPE,
      base_url: "https://www.dmxapi.cn/v1",
      endpoint: CANONICAL_ENDPOINT,
      response_url: CANONICAL_ENDPOINT,
      smoke_model: "deepseek-v4-pro-guan",
      target_model_id: "glm-5.2",
      status: "passed",
      model_admission: false,
      secret_ref: GLM_API_KEY_REF,
      attempts: 1,
      configured_base_url_hit: true,
      completion_nonempty: true
    });
    expect(note.response_model).toBeUndefined();
    expect(noteText).not.toContain(fakeSecret);
    expect(JSON.stringify(result)).not.toContain(fakeSecret);
    expect(await readdir(join(repo.repoRoot, "workspace"))).toEqual(["readiness"]);
    expect(await readdir(join(repo.repoRoot, "workspace", "readiness"))).toEqual([
      FIXTURE_READINESS_NOTE_NAME
    ]);
  });

  test("http failure retries once, omits provider text, and does not write a passing note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const fakeSecret = makeFakeSecret();
    const providerSentinel = "ROUND4_PROVIDER_SENTINEL";
    const forbiddenEvidence = [providerSentinel, fakeSecret, "BEGIN PRIVATE KEY"];
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return textResponse(
        `provider body ${providerSentinel} ${fakeSecret} -----BEGIN PRIVATE KEY-----`,
        {
          status: 502,
          statusText: `${providerSentinel} status text`,
          headers: { "x-provider-debug": providerSentinel }
        }
      );
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: fakeSecret },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(result.attempts).toBe(2);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "http_error",
        message: "Provider returned HTTP 502 from configured endpoint.",
        http_status: 502
      });
    }
    expectNoExternalText(JSON.stringify(result), forbiddenEvidence);
    const noteText = await readFile(fixtureNotePath(repo.repoRoot), "utf8");
    const note = JSON.parse(noteText) as Record<string, unknown>;
    expect(note.status).toBe("failed");
    expect(note).toMatchObject({
      endpoint: CANONICAL_ENDPOINT,
      attempts: MAX_RETRIES + 1,
      failure: {
        category: "http_error",
        message: "Provider returned HTTP 502 from configured endpoint.",
        http_status: 502
      }
    });
    expectNoExternalText(noteText, forbiddenEvidence);
  });

  test("hostile external fetch exceptions use stable local failure evidence", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const fakeSecret = makeFakeSecret();
    const providerSentinel = "ROUND4_EXCEPTION_SENTINEL";
    const fetchImpl: SmokeFetch = async () => {
      throw new Error(`external ${providerSentinel} Authorization: Bearer ${fakeSecret}`);
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: fakeSecret },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "network_error",
        message: "Provider request failed before a valid response was received."
      });
    }
    expectNoExternalText(JSON.stringify(result), [providerSentinel, fakeSecret]);
    expectNoExternalText(await readFile(fixtureNotePath(repo.repoRoot), "utf8"), [
      providerSentinel,
      fakeSecret
    ]);
  });

  test("redirected provider response cannot produce a passing readiness note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async (_url, init) => {
      attempts += 1;
      expect(init.redirect).toBe("error");
      return {
        redirected: true,
        url: "https://example.invalid/v1/chat/completions",
        ok: true,
        status: 200,
        body: null,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }]
          })
      } as Response;
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(MAX_RETRIES + 1);
    if (!result.ok) {
      expect(result.error.category).toBe("base_url_mismatch");
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.configured_base_url_hit).toBe(true);
  });

  test("missing provider response URL cannot produce a passing readiness note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return bareJsonResponse({
        choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }]
      });
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(MAX_RETRIES + 1);
    if (!result.ok) {
      expect(result.error.category).toBe("base_url_mismatch");
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.completion_nonempty).toBe(false);
  });

  test("mismatched provider response URL cannot produce a passing readiness note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return jsonResponse(
        {
          choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }]
        },
        { url: "https://example.invalid/v1/chat/completions" }
      );
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(MAX_RETRIES + 1);
    if (!result.ok) {
      expect(result.error.category).toBe("base_url_mismatch");
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.completion_nonempty).toBe(false);
  });

  test("empty completion assertion fails after one retry", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "   " }, finish_reason: "stop" }]
      });
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
    if (!result.ok) {
      expect(result.error.category).toBe("empty_completion");
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.completion_nonempty).toBe(false);
    expect(note.model_admission).toBe(false);
  });

  for (const fixture of [
    {
      name: "reasoning_content alone",
      body: {
        id: "chatcmpl-reasoning-only",
        model: "deepseek-v4-pro-guan",
        choices: [{
          message: { role: "assistant", content: "", reasoning_content: "ready via reasoning" },
          finish_reason: "stop"
        }]
      }
    },
    {
      name: "legacy choice.text alone",
      body: {
        id: "chatcmpl-legacy-text",
        model: "deepseek-v4-pro-guan",
        choices: [{ text: "ready via legacy text", finish_reason: "stop" }]
      }
    },
    {
      name: "content array response",
      body: {
        id: "chatcmpl-content-array",
        model: "deepseek-v4-pro-guan",
        choices: [{
          message: { role: "assistant", content: [{ type: "text", text: "ready" }] },
          finish_reason: "stop"
        }]
      }
    }
  ]) {
    test(`${fixture.name} is not a Zero-visible completion`, async () => {
      const repo = await tempRoots.createTempRepoWithProviderConfig();
      let attempts = 0;
      const result = await runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
        fetchImpl: async () => {
          attempts += 1;
          return jsonResponse(fixture.body);
        },
        now: fixedNow
      });

      expect(result.ok).toBe(false);
      expect(attempts).toBe(MAX_RETRIES + 1);
      if (!result.ok) {
        expect(result.error.category).toBe("empty_completion");
      }
      const note = await readFixtureNote(repo.repoRoot);
      expect(note.status).toBe("failed");
      expect(note.completion_nonempty).toBe(false);
    });
  }

  test("timeout aborts each bounded attempt and retries at most once", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async (_url, init) =>
      new Promise<Response>(() => {
        attempts += 1;
        expect(init.signal).toBeInstanceOf(AbortSignal);
      });
    const startedAt = Date.now();

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      timeoutMs: 5,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "timeout",
        message: "Provider request timed out."
      });
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.attempts).toBe(2);
  });

  test("stalled response body shares the attempt deadline and writes a failed note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return responseWithFinalUrl(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              // Leave the body open so the smoke must rely on the shared attempt deadline.
            }
          }),
          { status: 200 }
        )
      );
    };
    const startedAt = Date.now();

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      timeoutMs: 5,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBeLessThanOrEqual(MAX_RETRIES + 1);
    expect(result.attempts).toBe(MAX_RETRIES + 1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "timeout",
        message: "Provider request timed out."
      });
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.attempts).toBe(MAX_RETRIES + 1);
    expect(note.completion_nonempty).toBe(false);
  });

  test("oversized response body fails before parsing and writes no stale pass note", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
        padding: "x".repeat(MAX_RESPONSE_BYTES + 1)
      });
    };

    const result = await runGlmProviderSmokeFixture({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBeLessThanOrEqual(MAX_RETRIES + 1);
    expect(result.attempts).toBe(MAX_RETRIES + 1);
    if (!result.ok) {
      expect(result.error).toEqual({
        category: "oversized_response",
        message: `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`
      });
    }
    const note = await readFixtureNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.failure).toEqual({
      category: "oversized_response",
      message: `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`
    });
    expect(note.completion_nonempty).toBe(false);
  });

  test("fixture missing config rejects before fetch or note write", async () => {
    const repo = await tempRoots.createTempRepo();
    let fetchCalls = 0;

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("Fetch must not run without a fixture config.");
        },
        now: fixedNow
      })
    ).rejects.toThrow();

    expect(fetchCalls).toBe(0);
    expect(await readFixtureStatus(repo.repoRoot)).toBeUndefined();
  });

  test("fixture malformed config rejects before fetch or note write", async () => {
    const repo = await tempRoots.createTempRepo();
    let fetchCalls = 0;
    await mkdir(join(repo.repoRoot, "config", "providers"), { recursive: true });
    await writeFile(join(repo.repoRoot, "config", "providers", "glm.dmxapi.json"), "{", "utf8");

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("Fetch must not run with a malformed fixture config.");
        },
        now: fixedNow
      })
    ).rejects.toThrow();

    expect(fetchCalls).toBe(0);
    expect(await readFixtureStatus(repo.repoRoot)).toBeUndefined();
  });

  test("readiness note writer rejects a symlinked workspace before external writes", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const outsideWorkspace = (await tempRoots.createTempRepo()).repoRoot;
    await symlink(outsideWorkspace, join(repo.repoRoot, "workspace"));

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: {},
        now: fixedNow
      })
    ).rejects.toThrow("Readiness workspace path must be an owned directory.");

    expect(await readdir(outsideWorkspace)).toEqual([]);
  });

  test("fixture readiness storage rejects final note symlink without touching the target", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const outsideWorkspace = (await tempRoots.createTempRepo()).repoRoot;
    const externalNote = join(outsideWorkspace, "external-note.json");
    await writeFile(externalNote, "unchanged", "utf8");
    await mkdir(join(repo.repoRoot, "workspace", "readiness"), { recursive: true });
    await symlink(externalNote, fixtureNotePath(repo.repoRoot));

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: {},
        now: fixedNow
      })
    ).rejects.toThrow("Readiness note path must be an owned regular file.");

    expect(await readFile(externalNote, "utf8")).toBe("unchanged");
  });

  test("fixture readiness storage rejects final note hardlink without touching the target", async () => {
    const repo = await tempRoots.createTempRepoWithProviderConfig();
    const outsideWorkspace = (await tempRoots.createTempRepo()).repoRoot;
    const externalNote = join(outsideWorkspace, "external-note.json");
    await writeFile(externalNote, "unchanged", "utf8");
    await mkdir(join(repo.repoRoot, "workspace", "readiness"), { recursive: true });
    await link(externalNote, fixtureNotePath(repo.repoRoot));

    await expect(
      runGlmProviderSmokeFixture({
        repoRoot: repo.repoRoot,
        env: {},
        now: fixedNow
      })
    ).rejects.toThrow("Readiness note path must be an owned regular file.");

    expect(await readFile(externalNote, "utf8")).toBe("unchanged");
  });

  test("request helpers bind endpoint, payload model, and non-admission target fields", async () => {
    const config = await loadProviderConfig(DEFAULT_PROVIDER_CONFIG_PATH);
    const payload = buildChatCompletionPayload(config);

    expect(chatCompletionsEndpoint(config.baseUrl)).toBe(
      "https://www.dmxapi.cn/v1/chat/completions"
    );
    expect(payload).toMatchObject({
      model: "deepseek-v4-pro-guan",
      max_tokens: 512,
      stream: false
    });
    expect(config.targetModelId).toBe("glm-5.2");
  });
});
