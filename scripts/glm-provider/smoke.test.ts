import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig as loadZeroConfig } from "../../zero/packages/core/src/config/loader";
import {
  API_TYPE,
  DEFAULT_PROVIDER_CONFIG_PATH,
  DEFAULT_READINESS_NOTE_NAME,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  buildChatCompletionPayload,
  chatCompletionsEndpoint,
  loadProviderConfig,
  parseProviderConfig,
  runGlmProviderSmoke,
  type SmokeFetch
} from "./smoke";

const tempRoots: string[] = [];
const fixedNow = () => new Date("2026-07-08T10:00:00.000Z");

describe("glm provider config and smoke", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("parses source-controlled provider config contract", async () => {
    const config = await loadProviderConfig(DEFAULT_PROVIDER_CONFIG_PATH);
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as {
      providers: Record<string, { models: Record<string, { admission: unknown }> }>;
    };

    expect(config.providerName).toBe("glm-dmxapi");
    expect(config.apiType).toBe(API_TYPE);
    expect(config.baseUrl).toBe("https://www.dmxapi.cn/v1");
    expect(config.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(config.fallbackChain).toEqual(["glm-dmxapi/target", "glm-dmxapi/smoke"]);
    expect(config.modelPlaceholders.task_closure_model).toBe("glm-dmxapi/target");
    expect(config.modelPlaceholders.context_compaction_model).toBe("glm-dmxapi/target");
    expect(config.modelPlaceholders.fallback_smoke_model).toBe("glm-dmxapi/smoke");
    expect(config.smokeModel).toBe("deepseek-v4-pro-guan");
    expect(config.targetModelId).toBe("glm-5.2");
    expect(config.zeroAdapter.auth.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(config.zeroAdapter.models.smoke.modelId).toBe("deepseek-v4-pro-guan");
    expect(config.zeroAdapter.models.target.modelId).toBe("glm-5.2");
    expect(raw.providers["glm-dmxapi"].models.smoke.admission).toBe(false);
    expect(raw.providers["glm-dmxapi"].models.target.admission).toBe(false);
  });

  test("source-controlled provider config normalizes through the Zero loader", () => {
    const zeroConfig = loadZeroConfig(DEFAULT_PROVIDER_CONFIG_PATH);

    expect(zeroConfig.providers["glm-dmxapi"].auth.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(zeroConfig.fallbackChain).toEqual(["glm-dmxapi/target", "glm-dmxapi/smoke"]);
    expect(zeroConfig.taskClosureModel).toBe("glm-dmxapi/target");
    expect(zeroConfig.contextCompactionModel).toBe("glm-dmxapi/target");
    expect(zeroConfig.providers["glm-dmxapi"].models.smoke.modelId).toBe(
      "deepseek-v4-pro-guan"
    );
    expect(zeroConfig.providers["glm-dmxapi"].models.target.modelId).toBe("glm-5.2");
  });

  test("provider config rejects model admission drift", async () => {
    const raw = JSON.parse(await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8")) as {
      providers: Record<string, { models: Record<string, { admission: boolean }> }>;
    };

    raw.providers["glm-dmxapi"].models.smoke.admission = true;
    expect(() => parseProviderConfig(raw)).toThrow(
      "Expected false at glm-dmxapi.models.smoke.admission."
    );
  });

  test("missing key fails without fetch and writes a failed readiness note", async () => {
    const repo = await createTempRepoWithProviderConfig();
    let fetchCalls = 0;
    const fetchImpl: SmokeFetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ choices: [{ message: { content: "ready" } }] });
    };

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.failure).toEqual({
      category: "missing_key",
      message: `Missing required environment variable ${GLM_API_KEY_ENV}.`
    });
    expect(note.secret_ref).toBe(GLM_API_KEY_REF);
    expect(note.model_admission).toBe(false);
  });

  test("fake fetch success sends non-stream chat completion and writes redacted readiness note", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const fakeSecret = makeFakeSecret();
    const seenRequests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const fetchImpl: SmokeFetch = async (url, init) => {
      seenRequests.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        authorization: (init.headers as Record<string, string>).authorization
      });
      return jsonResponse({
        id: "chatcmpl-unit",
        model: `deepseek-v4-pro-guan-${fakeSecret}`,
        choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }]
      });
    };

    const result = await runGlmProviderSmoke({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: fakeSecret },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].url).toBe("https://www.dmxapi.cn/v1/chat/completions");
    expect(seenRequests[0].authorization).toBe(`Bearer ${fakeSecret}`);
    expect(seenRequests[0].body).toMatchObject({
      model: "deepseek-v4-pro-guan",
      max_tokens: 64,
      temperature: 0,
      stream: false
    });

    const noteText = await readFile(readinessNotePath(repo.repoRoot), "utf8");
    const note = JSON.parse(noteText) as Record<string, unknown>;
    expect(note).toMatchObject({
      schema_version: "m1.glm-provider-smoke.v1",
      kind: "glm_provider_smoke",
      checked_at: "2026-07-08T10:00:00.000Z",
      provider_name: "glm-dmxapi",
      api_type: API_TYPE,
      base_url: "https://www.dmxapi.cn/v1",
      endpoint: "https://www.dmxapi.cn/v1/chat/completions",
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
      DEFAULT_READINESS_NOTE_NAME
    ]);
  });

  test("http failure retries once, redacts provider text, and does not write a passing note", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const fakeSecret = makeFakeSecret();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return new Response(`provider echoed ${fakeSecret}`, { status: 502 });
    };

    const result = await runGlmProviderSmoke({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: fakeSecret },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(2);
    expect(result.attempts).toBe(2);
    if (!result.ok) {
      expect(result.error.category).toBe("http_error");
      expect(result.error.message).toContain("HTTP 502");
      expect(result.error.message).not.toContain(fakeSecret);
      expect(result.error.message).toContain("[REDACTED]");
    }
    const noteText = await readFile(readinessNotePath(repo.repoRoot), "utf8");
    const note = JSON.parse(noteText) as Record<string, unknown>;
    expect(note.status).toBe("failed");
    expect(noteText).not.toContain(fakeSecret);
  });

  test("redirected provider response cannot produce a passing readiness note", async () => {
    const repo = await createTempRepoWithProviderConfig();
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

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.configured_base_url_hit).toBe(true);
  });

  test("empty completion assertion fails after one retry", async () => {
    const repo = await createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "   " }, finish_reason: "stop" }]
      });
    };

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.completion_nonempty).toBe(false);
    expect(note.model_admission).toBe(false);
  });

  test("reasoning_content is accepted when provider content is empty", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const fetchImpl: SmokeFetch = async () =>
      jsonResponse({
        id: "chatcmpl-reasoning-only",
        model: "deepseek-v4-pro-guan",
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "ready via reasoning field"
            },
            finish_reason: "stop"
          }
        ]
      });

    const result = await runGlmProviderSmoke({
      repoRoot: repo.repoRoot,
      env: { [GLM_API_KEY_ENV]: makeFakeSecret() },
      fetchImpl,
      now: fixedNow
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    if (result.ok) {
      expect(result.completion).toBe("ready via reasoning field");
    }
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("passed");
    expect(note.completion_nonempty).toBe(true);
  });

  test("timeout aborts each bounded attempt and retries at most once", async () => {
    const repo = await createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async (_url, init) =>
      new Promise<Response>(() => {
        attempts += 1;
        expect(init.signal).toBeInstanceOf(AbortSignal);
      });
    const startedAt = Date.now();

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.attempts).toBe(2);
  });

  test("stalled response body shares the attempt deadline and writes a failed note", async () => {
    const repo = await createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Leave the body open so the smoke must rely on the shared attempt deadline.
          }
        }),
        { status: 200 }
      );
    };
    const startedAt = Date.now();

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.attempts).toBe(MAX_RETRIES + 1);
    expect(note.completion_nonempty).toBe(false);
  });

  test("oversized response body fails before parsing and writes no stale pass note", async () => {
    const repo = await createTempRepoWithProviderConfig();
    let attempts = 0;
    const fetchImpl: SmokeFetch = async () => {
      attempts += 1;
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
        padding: "x".repeat(MAX_RESPONSE_BYTES + 1)
      });
    };

    const result = await runGlmProviderSmoke({
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
    const note = await readReadinessNote(repo.repoRoot);
    expect(note.status).toBe("failed");
    expect(note.failure).toEqual({
      category: "oversized_response",
      message: `Provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`
    });
    expect(note.completion_nonempty).toBe(false);
  });

  test("readiness note writer rejects a symlinked workspace before external writes", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const outsideWorkspace = await mkdtemp(join(tmpdir(), "shud-glm-provider-outside-"));
    tempRoots.push(outsideWorkspace);
    await symlink(outsideWorkspace, join(repo.repoRoot, "workspace"));

    await expect(
      runGlmProviderSmoke({
        repoRoot: repo.repoRoot,
        env: {},
        now: fixedNow
      })
    ).rejects.toThrow("Readiness workspace path must be an owned directory.");

    expect(await readdir(outsideWorkspace)).toEqual([]);
  });

  test("readiness note writer rejects final note symlink without touching the target", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const outsideWorkspace = await mkdtemp(join(tmpdir(), "shud-glm-provider-outside-"));
    tempRoots.push(outsideWorkspace);
    const externalNote = join(outsideWorkspace, "external-note.json");
    await writeFile(externalNote, "unchanged", "utf8");
    await mkdir(join(repo.repoRoot, "workspace", "readiness"), { recursive: true });
    await symlink(externalNote, readinessNotePath(repo.repoRoot));

    await expect(
      runGlmProviderSmoke({
        repoRoot: repo.repoRoot,
        env: {},
        now: fixedNow
      })
    ).rejects.toThrow("Readiness note path must be an owned regular file.");

    expect(await readFile(externalNote, "utf8")).toBe("unchanged");
  });

  test("readiness note writer rejects final note hardlink without truncating the target", async () => {
    const repo = await createTempRepoWithProviderConfig();
    const outsideWorkspace = await mkdtemp(join(tmpdir(), "shud-glm-provider-outside-"));
    tempRoots.push(outsideWorkspace);
    const externalNote = join(outsideWorkspace, "external-note.json");
    await writeFile(externalNote, "unchanged", "utf8");
    await mkdir(join(repo.repoRoot, "workspace", "readiness"), { recursive: true });
    await link(externalNote, readinessNotePath(repo.repoRoot));

    await expect(
      runGlmProviderSmoke({
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
      stream: false
    });
    expect(config.targetModelId).toBe("glm-5.2");
  });
});

async function createTempRepoWithProviderConfig(): Promise<{ repoRoot: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "shud-glm-provider-"));
  tempRoots.push(repoRoot);
  const configDir = join(repoRoot, "config", "providers");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "glm.dmxapi.json"),
    await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8"),
    "utf8"
  );
  return { repoRoot };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

async function readReadinessNote(repoRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(readinessNotePath(repoRoot), "utf8")) as Record<string, unknown>;
}

function readinessNotePath(repoRoot: string): string {
  return join(repoRoot, "workspace", "readiness", DEFAULT_READINESS_NOTE_NAME);
}

function makeFakeSecret(): string {
  return ["unit", "redaction", "secret"].join("-");
}
