import { resolve } from "node:path";

import {
  createHarnessApiFetch,
  renderDashboardFromServer,
  type HarnessApiFetch
} from "../../frontend/src/index";
import { resolveLocalTokenAuthority } from "./local-auth/local-auth-authority";
import {
  createBackendProductionListenOptions,
  type BackendApiOptions,
  type BackendProductionListenOptions
} from "./routes/index";

export const BACKEND_PRODUCTION_DEFAULT_PORT = 3000 as const;

export interface BackendProductionServerOptions extends BackendApiOptions {
  readonly port?: number;
}

export interface BackendProductionServerListenOptions
  extends BackendProductionListenOptions {
  readonly port: number;
}

export function createBackendProductionServerOptions(
  options: BackendProductionServerOptions = {}
): BackendProductionServerListenOptions {
  const { port = BACKEND_PRODUCTION_DEFAULT_PORT, ...apiOptions } = options;
  const workspaceRoot = resolveProductionWorkspaceRoot(apiOptions);
  const normalizedApiOptions = { ...apiOptions, workspaceRoot };
  const backend = createBackendProductionListenOptions(normalizedApiOptions);
  const frontendAuthority = resolveLocalTokenAuthority({ workspaceRoot });

  const fetch: BackendProductionListenOptions["fetch"] = async (request, ...context) => {
    const requestUrl = new URL(request.url);
    if (request.method !== "GET" || !isFrontendEntryPath(requestUrl.pathname)) {
      return await backend.fetch(request, ...context);
    }
    if (!isAllowedLoopbackPageHost(requestUrl.hostname)) {
      return frontendPageNotFoundResponse();
    }

    try {
      frontendAuthority.assertCurrent();
      const bootstrap = Object.freeze({ token: frontendAuthority.token });
      const apiFetch = createBackendPageApiFetch(backend.fetch, requestUrl.origin, bootstrap.token);
      const document = await renderDashboardFromServer(apiFetch, bootstrap);
      frontendAuthority.assertCurrent();
      return frontendHtmlResponse(document);
    } catch {
      return frontendUnavailableResponse();
    }
  };

  return Object.freeze({
    hostname: backend.hostname,
    port,
    fetch
  });
}

export function startBackendProductionServer(
  options: BackendProductionServerOptions = {}
): ReturnType<typeof Bun.serve> {
  return Bun.serve(createBackendProductionServerOptions(options));
}

if (import.meta.main) {
  startBackendProductionServer();
}

function createBackendPageApiFetch(
  backendFetch: BackendProductionListenOptions["fetch"],
  origin: string,
  token: string
): HarnessApiFetch {
  const passThroughFetch: HarnessApiFetch = async (input, init) => {
    return await backendFetch(toBackendRequest(input, init, origin));
  };

  return createHarnessApiFetch({ token, origin, fetchClient: passThroughFetch });
}

function toBackendRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  origin: string
): Request {
  if (input instanceof Request) {
    return new Request(input, init);
  }
  const rawUrl = input instanceof URL ? input.href : String(input);
  return new Request(new URL(rawUrl, origin), init);
}

function resolveProductionWorkspaceRoot(options: BackendApiOptions): string {
  return resolve(
    firstNonBlankString(
      options.workspaceRoot,
      process.env.HARNESS_WORKSPACE_DIR,
      process.env.SHUD_HARNESS_WORKSPACE_ROOT,
      "workspace"
    )
  );
}

function firstNonBlankString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "workspace";
}

function isFrontendEntryPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/dashboard";
}

function isAllowedLoopbackPageHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function frontendHtmlResponse(document: string): Response {
  return new Response(document, {
    status: 200,
    headers: frontendPageHeaders("text/html; charset=utf-8")
  });
}

function frontendPageNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: frontendPageHeaders("text/plain; charset=utf-8")
  });
}

function frontendUnavailableResponse(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: frontendPageHeaders("text/plain; charset=utf-8")
  });
}

function frontendPageHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
}
