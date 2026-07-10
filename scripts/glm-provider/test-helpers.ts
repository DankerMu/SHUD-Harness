import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_RELATIVE_PATH,
  DEFAULT_PROVIDER_CONFIG_PATH,
  DEFAULT_READINESS_NOTE_NAME,
  DEFAULT_REPO_ROOT
} from "./smoke";

export const fixedNow = () => new Date("2026-07-08T10:00:00.000Z");
export const CANONICAL_ENDPOINT = "https://www.dmxapi.cn/v1/chat/completions";

export function createTempRootTracker(): {
  createTempRepo: () => Promise<{ repoRoot: string }>;
  createTempRepoWithProviderConfig: () => Promise<{ repoRoot: string }>;
  track: (path: string) => void;
  cleanup: () => Promise<void>;
} {
  const tempRoots: string[] = [];
  const track = (path: string) => {
    tempRoots.push(path);
  };

  const createTempRepo = async (): Promise<{ repoRoot: string }> => {
    const repoRoot = await mkdtemp(join(tmpdir(), "shud-glm-provider-"));
    track(repoRoot);
    return { repoRoot };
  };

  const createTempRepoWithProviderConfig = async (): Promise<{ repoRoot: string }> => {
    const repo = await createTempRepo();
    const configDir = join(repo.repoRoot, "config", "providers");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "glm.dmxapi.json"),
      await readFile(DEFAULT_PROVIDER_CONFIG_PATH, "utf8"),
      "utf8"
    );
    return repo;
  };

  const cleanup = async (): Promise<void> => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  };

  return {
    createTempRepo,
    createTempRepoWithProviderConfig,
    track,
    cleanup
  };
}

export function jsonResponse(
  value: unknown,
  options: { status?: number; url?: string } = {}
): Response {
  return responseWithFinalUrl(
    new Response(JSON.stringify(value), {
      status: options.status ?? 200,
      headers: {
        "content-type": "application/json"
      }
    }),
    options.url
  );
}

export function bareJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

export function textResponse(
  text: string,
  options: { status?: number; statusText?: string; headers?: HeadersInit; url?: string } = {}
): Response {
  const response = new Response(text, {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: options.headers
  });
  return responseWithFinalUrl(response, options.url);
}

export function responseWithFinalUrl(response: Response, url = CANONICAL_ENDPOINT): Response {
  Object.defineProperty(response, "url", {
    value: url,
    configurable: true
  });
  return response;
}

export async function readReadinessNote(
  repoRoot: string,
  noteName = DEFAULT_READINESS_NOTE_NAME
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(readinessNotePath(repoRoot, noteName), "utf8")) as Record<
    string,
    unknown
  >;
}

export async function readReadinessStatus(
  repoRoot: string,
  noteName = DEFAULT_READINESS_NOTE_NAME
): Promise<unknown> {
  try {
    return (await readReadinessNote(repoRoot, noteName)).status;
  } catch {
    return undefined;
  }
}

export function readinessNotePath(
  repoRoot: string,
  noteName = DEFAULT_READINESS_NOTE_NAME
): string {
  return join(repoRoot, "workspace", "readiness", noteName);
}

export function makeFakeSecret(): string {
  return ["unit", "redaction", "secret"].join("-");
}

export function expectNoExternalText(text: string, forbidden: string[]): void {
  for (const value of forbidden) {
    if (text.includes(value)) {
      throw new Error(`Expected output to omit external text: ${value}`);
    }
  }
}

export function cliFetchPreload(providerSentinel: string, fakeSecret: string): string {
  const body = `provider body ${providerSentinel} ${fakeSecret} -----BEGIN PRIVATE KEY-----`;
  return `globalThis.fetch = async () => {
  const response = new Response(${JSON.stringify(body)}, {
    status: 503,
    statusText: ${JSON.stringify(`${providerSentinel} status text`)},
    headers: { "x-provider-debug": ${JSON.stringify(providerSentinel)} }
  });
  Object.defineProperty(response, "url", { value: ${JSON.stringify(CANONICAL_ENDPOINT)}, configurable: true });
  return response;
};`;
}

export function canonicalConfigPathFor(repoRoot: string): string {
  return join(repoRoot, DEFAULT_CONFIG_RELATIVE_PATH);
}

function isNodeErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
