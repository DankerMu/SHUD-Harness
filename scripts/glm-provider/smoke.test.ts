import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_TYPE,
  DEFAULT_PROVIDER_CONFIG_PATH,
  DEFAULT_READINESS_NOTE_NAME,
  GLM_API_KEY_ENV,
  GLM_API_KEY_REF,
  buildChatCompletionPayload,
  chatCompletionsEndpoint,
  loadProviderConfig,
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

    expect(config.providerName).toBe("glm-dmxapi");
    expect(config.apiType).toBe(API_TYPE);
    expect(config.baseUrl).toBe("https://www.dmxapi.cn/v1");
    expect(config.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(config.fallbackChain).toContain("glm-dmxapi.target");
    expect(config.modelPlaceholders.task_closure_model).toBe("glm-dmxapi.target");
    expect(config.smokeModel).toBe("deepseek-v4-pro-guan");
    expect(config.targetModelId).toBe("glm-5.2");
    expect(config.zeroAdapter.auth.apiKeyRef).toBe(GLM_API_KEY_REF);
    expect(config.zeroAdapter.models.smoke.modelId).toBe("deepseek-v4-pro-guan");
    expect(config.zeroAdapter.models.target.modelId).toBe("glm-5.2");
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
        model: "deepseek-v4-pro-guan",
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
      completion_nonempty: true,
      response_model: "deepseek-v4-pro-guan"
    });
    expect(noteText).not.toContain(fakeSecret);
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
      new Promise<Response>((_resolve, reject) => {
        attempts += 1;
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("deadline reached");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
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
