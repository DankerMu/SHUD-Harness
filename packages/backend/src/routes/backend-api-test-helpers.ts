import { expect } from "bun:test";
import { createBackendApi, type BackendApiOptions } from "./index";
import type { ApiErrorResponse } from "./index";

export const BACKEND_TEST_LOCAL_TOKEN = "backend-m1-test-local-token" as const;

type BackendApi = ReturnType<typeof createBackendApi>;
export type AuthenticatedBackendApi = Omit<BackendApi, "request"> & {
  request(
    input: Parameters<BackendApi["request"]>[0],
    requestInit?: Parameters<BackendApi["request"]>[1]
  ): Promise<Response>;
};

export function createAuthenticatedBackendApi(
  options: BackendApiOptions = {}
): AuthenticatedBackendApi {
  const previousToken = process.env.HARNESS_LOCAL_TOKEN;
  process.env.HARNESS_LOCAL_TOKEN = BACKEND_TEST_LOCAL_TOKEN;
  let app: ReturnType<typeof createBackendApi>;
  try {
    app = createBackendApi(options);
  } finally {
    if (previousToken === undefined) {
      delete process.env.HARNESS_LOCAL_TOKEN;
    } else {
      process.env.HARNESS_LOCAL_TOKEN = previousToken;
    }
  }

  const request = app.request.bind(app);
  const authenticatedApp = app as unknown as AuthenticatedBackendApi;
  authenticatedApp.request = async (input, requestInit) => {
    const headers = new Headers(requestInit?.headers);
    headers.set("Authorization", `Bearer ${BACKEND_TEST_LOCAL_TOKEN}`);
    return await request(input, { ...requestInit, headers });
  };
  return authenticatedApp;
}

export function expectCanonicalApiError(
  body: ApiErrorResponse,
  expected: Readonly<{
    category: string;
    severity?: ApiErrorResponse["error"]["severity"];
    message?: string;
    userMessage?: string;
    evidenceRefs?: readonly string[];
    retryable?: boolean;
    recommendedNextActions?: readonly string[];
  }>
): void {
  expect(Object.keys(body.error).sort()).toEqual(
    [
      "category",
      "error_id",
      "evidence_refs",
      "message",
      "recommended_next_actions",
      "retryable",
      "severity",
      "user_message"
    ].sort()
  );
  expect(body.error.error_id).toMatch(
    /^api_error_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  expect(body.error.category).toBe(expected.category);
  expect(body.error.severity).toBe(expected.severity ?? "error");
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body.error.user_message.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.evidence_refs)).toBe(true);
  expect(typeof body.error.retryable).toBe("boolean");
  expect(Array.isArray(body.error.recommended_next_actions)).toBe(true);
  expect(body.error.recommended_next_actions.length).toBeGreaterThan(0);
  if (expected.message !== undefined) expect(body.error.message).toBe(expected.message);
  if (expected.userMessage !== undefined) {
    expect(body.error.user_message).toBe(expected.userMessage);
  }
  if (expected.evidenceRefs !== undefined) {
    expect(body.error.evidence_refs).toEqual([...expected.evidenceRefs]);
  }
  if (expected.retryable !== undefined) expect(body.error.retryable).toBe(expected.retryable);
  if (expected.recommendedNextActions !== undefined) {
    expect(body.error.recommended_next_actions).toEqual([...expected.recommendedNextActions]);
  }
}
