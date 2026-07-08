import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export const BACKEND_MIDDLEWARE_NAMESPACE = "backend/middleware" as const;

export type BackendMiddlewareNamespace = typeof BACKEND_MIDDLEWARE_NAMESPACE;

export const API_REQUEST_ID_HEADER = "x-request-id" as const;
export const API_REQUEST_LOG_EVENT = "api.request.completed" as const;
export const API_REQUEST_LOG_SERVICE = "shud-harness-backend" as const;
const LOG_SECRET_REF_PATTERN = /^(?:env|secret|vault|keychain):[A-Za-z0-9_./:-]+$/;
const LOG_SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|authorization|password|secret|token)[^,\s]*)/i;

export interface ApiRequestLogLine {
  ts: string;
  level: "info" | "warn" | "error";
  service: typeof API_REQUEST_LOG_SERVICE;
  event: typeof API_REQUEST_LOG_EVENT;
  request_id: string;
  route: string;
  status: number;
  duration_ms: number;
}

export type ApiRequestLogSink = (line: string) => Promise<void> | void;

export interface ApiRequestLoggerOptions {
  now?: () => Date;
  requestIdFactory?: () => string;
  sink?: ApiRequestLogSink;
}

export function createApiRequestLoggerMiddleware(
  options: ApiRequestLoggerOptions = {}
): MiddlewareHandler {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? (() => `req_${randomUUID()}`);
  const sink = options.sink ?? ((line: string) => console.log(line.trimEnd()));

  return async (c, next) => {
    const path = c.req.path;
    const isApiRequest = path === "/api" || path.startsWith("/api/");
    if (!isApiRequest) {
      await next();
      return;
    }

    const startedAtMs = Date.now();
    const requestId = requestIdFactory();
    c.header(API_REQUEST_ID_HEADER, requestId);

    try {
      await next();
    } finally {
      c.header(API_REQUEST_ID_HEADER, requestId);
      const status = c.res.status;
      const logLine: ApiRequestLogLine = {
        ts: now().toISOString(),
        level: logLevelForStatus(status),
        service: API_REQUEST_LOG_SERVICE,
        event: API_REQUEST_LOG_EVENT,
        request_id: requestId,
        route: redactApiLogValue(apiRoutePatternFor(c.req.raw.method, path)),
        status,
        duration_ms: Math.max(0, Date.now() - startedAtMs)
      };
      emitApiRequestLogLine(sink, `${JSON.stringify(logLine)}\n`);
    }
  };
}

function emitApiRequestLogLine(sink: ApiRequestLogSink, line: string): void {
  setTimeout(() => {
    try {
      void Promise.resolve(sink(line)).catch(() => undefined);
    } catch {
      // Request logging is best-effort; sink failures must not change API responses.
    }
  }, 0);
}

export function apiRoutePatternFor(method: string, path: string): string {
  const normalizedMethod = method.toUpperCase();
  const routeMethod = normalizedMethod === "HEAD" ? "GET" : normalizedMethod;
  if (routeMethod === "POST" && path === "/api/workspace/init") {
    return "/api/workspace/init";
  }
  if (routeMethod === "GET" && path === "/api/health/live") {
    return "/api/health/live";
  }
  if (routeMethod === "GET" && path === "/api/health/ready") {
    return "/api/health/ready";
  }
  if (routeMethod === "POST" && path === "/api/tasks") {
    return "/api/tasks";
  }
  if (routeMethod === "GET" && path === "/api/tasks") {
    return "/api/tasks";
  }
  if (routeMethod === "GET" && /^\/api\/tasks\/[^/]+$/.test(path)) {
    return "/api/tasks/:id";
  }
  if (path === "/api" || path.startsWith("/api/")) {
    return "/api/*";
  }

  return "non-api";
}

export function redactApiLogValue(value: string): string {
  const trimmed = value.trim();
  if (LOG_SECRET_REF_PATTERN.test(trimmed)) {
    return value;
  }
  if (LOG_SECRET_VALUE_PATTERN.test(trimmed)) {
    return "[REDACTED]";
  }

  return value;
}

function logLevelForStatus(status: number): ApiRequestLogLine["level"] {
  if (status >= 500) {
    return "error";
  }
  if (status >= 400) {
    return "warn";
  }
  return "info";
}
