import { createBackendApi, type BackendApiOptions } from "./index";

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
