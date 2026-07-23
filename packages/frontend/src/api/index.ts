export const FRONTEND_API_NAMESPACE = "frontend/api" as const;
export const HARNESS_BOOTSTRAP_GLOBAL = "__HARNESS_BOOTSTRAP__" as const;
export const HARNESS_API_FETCH_GLOBAL = "__HARNESS_API_FETCH__" as const;
export const HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE = "data-harness-bootstrap" as const;
export const HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE = "data-harness-api-client" as const;

export type FrontendApiNamespace = typeof FRONTEND_API_NAMESPACE;

export interface HarnessBootstrap {
  readonly token: string;
}

export type HarnessApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type HarnessApiClientErrorCode =
  | "bootstrap_missing"
  | "bootstrap_invalid"
  | "fetch_unavailable"
  | "request_not_api"
  | "request_cross_origin";

export class HarnessApiClientError extends Error {
  readonly code: HarnessApiClientErrorCode;

  constructor(code: HarnessApiClientErrorCode, message: string) {
    super(message);
    this.name = "HarnessApiClientError";
    this.code = code;
  }
}

export interface HarnessApiFetchOptions {
  readonly token: string;
  readonly fetchClient?: HarnessApiFetch;
  readonly origin?: string;
}

export function readHarnessBootstrap(source: unknown = globalThis): HarnessBootstrap {
  if (!isRecord(source) || !(HARNESS_BOOTSTRAP_GLOBAL in source)) {
    throw new HarnessApiClientError(
      "bootstrap_missing",
      "Harness browser bootstrap is unavailable."
    );
  }

  const candidate = source[HARNESS_BOOTSTRAP_GLOBAL];
  if (!isRecord(candidate) || !isTransportSafeLocalToken(candidate.token)) {
    throw new HarnessApiClientError(
      "bootstrap_invalid",
      "Harness browser bootstrap is invalid."
    );
  }

  return Object.freeze({ token: candidate.token });
}

export function createHarnessApiFetch(options: HarnessApiFetchOptions): HarnessApiFetch {
  assertTransportSafeLocalToken(options.token);
  const fetchClient = options.fetchClient ?? resolveGlobalFetch();
  const origin = normalizeOrigin(options.origin ?? resolveRuntimeOrigin());

  return async (input, init) => {
    assertApiRequestTarget(input, origin);
    const headers = mergeRequestHeaders(input, init?.headers);
    headers.set("Authorization", `Bearer ${options.token}`);
    return await fetchClient(input, { ...init, headers });
  };
}

export const harnessApiFetch: HarnessApiFetch = async (input, init) => {
  const bootstrap = readHarnessBootstrap();
  const apiFetch = createHarnessApiFetch({ token: bootstrap.token });
  return await apiFetch(input, init);
};

export function renderHarnessBootstrapScript(bootstrap: HarnessBootstrap): string {
  assertTransportSafeLocalToken(bootstrap.token);
  const serialized = serializeInlineScriptValue({ token: bootstrap.token });

  return [
    `<script ${HARNESS_BOOTSTRAP_SCRIPT_ATTRIBUTE}>`,
    "(() => {",
    `const bootstrap = Object.freeze(${serialized});`,
    `Object.defineProperty(window, ${JSON.stringify(HARNESS_BOOTSTRAP_GLOBAL)}, {`,
    "value: bootstrap,",
    "writable: false,",
    "configurable: false,",
    "enumerable: false",
    "});",
    "})();",
    "</script>"
  ].join("");
}

export const HARNESS_API_CLIENT_SCRIPT = `
(() => {
  if (Object.prototype.hasOwnProperty.call(window, "__HARNESS_API_FETCH__")) {
    return;
  }

  const bootstrap = window.__HARNESS_BOOTSTRAP__;
  const nativeFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : undefined;
  const runtimeOrigin =
    window.location && typeof window.location.origin === "string"
      ? window.location.origin
      : undefined;

  const isSafeToken = (value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 0x21 || code > 0x7e || code === 0x2c) return false;
    }
    return true;
  };

  if (!nativeFetch) {
    return;
  }

  if (
    !runtimeOrigin ||
    !bootstrap ||
    typeof bootstrap !== "object" ||
    !isSafeToken(bootstrap.token)
  ) {
    return;
  }

  const origin = new URL(runtimeOrigin).origin;
  const apiFetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (typeof rawUrl !== "string") {
      throw new Error("Harness API requests require a URL.");
    }

    const target = new URL(rawUrl, origin);
    if (target.origin !== origin) {
      throw new Error("Harness API credentials cannot be sent cross-origin.");
    }
    if (target.pathname !== "/api" && !target.pathname.startsWith("/api/")) {
      throw new Error("Harness API credentials are limited to /api/** requests.");
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init && init.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set("Authorization", "Bearer " + bootstrap.token);

    return await nativeFetch(input, { ...(init || {}), headers });
  };

  Object.defineProperty(window, "__HARNESS_API_FETCH__", {
    value: Object.freeze(apiFetch),
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
`;

export function renderHarnessApiClientScript(): string {
  return `<script ${HARNESS_API_CLIENT_SCRIPT_ATTRIBUTE}>${HARNESS_API_CLIENT_SCRIPT}</script>`;
}

function resolveGlobalFetch(): HarnessApiFetch {
  if (typeof globalThis.fetch !== "function") {
    throw new HarnessApiClientError("fetch_unavailable", "Fetch is unavailable in this runtime.");
  }
  return globalThis.fetch.bind(globalThis);
}

function resolveRuntimeOrigin(): string | undefined {
  return typeof globalThis.location?.origin === "string"
    ? globalThis.location.origin
    : undefined;
}

function normalizeOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    throw new HarnessApiClientError(
      "bootstrap_invalid",
      "Harness API origin configuration is invalid."
    );
  }
}

function assertApiRequestTarget(input: RequestInfo | URL, origin: string | undefined): void {
  const rawUrl =
    input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  const isRootRelative = rawUrl.startsWith("/") && !rawUrl.startsWith("//");

  if (!origin && !isRootRelative) {
    throw new HarnessApiClientError(
      "request_cross_origin",
      "Harness API requests require a known same-origin base."
    );
  }

  const target = new URL(rawUrl, origin ?? "http://harness.invalid");
  if (origin && target.origin !== origin) {
    throw new HarnessApiClientError(
      "request_cross_origin",
      "Harness API credentials cannot be sent cross-origin."
    );
  }
  if (target.pathname !== "/api" && !target.pathname.startsWith("/api/")) {
    throw new HarnessApiClientError(
      "request_not_api",
      "Harness API credentials are limited to /api/** requests."
    );
  }
}

function mergeRequestHeaders(
  input: RequestInfo | URL,
  initHeaders: HeadersInit | undefined
): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (initHeaders !== undefined) {
    new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

function assertTransportSafeLocalToken(token: unknown): asserts token is string {
  if (!isTransportSafeLocalToken(token)) {
    throw new HarnessApiClientError(
      "bootstrap_invalid",
      "Harness local credential is not transport-safe."
    );
  }
}

function isTransportSafeLocalToken(token: unknown): token is string {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return false;
  }

  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x2c) return false;
  }
  return true;
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
