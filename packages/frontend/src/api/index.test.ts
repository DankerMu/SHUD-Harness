import { describe, expect, test } from "bun:test";

import {
  HARNESS_API_CLIENT_SCRIPT,
  HARNESS_API_FETCH_GLOBAL,
  HARNESS_BOOTSTRAP_GLOBAL,
  HarnessApiClientError,
  createHarnessApiFetch,
  readHarnessBootstrap,
  renderHarnessBootstrapScript
} from "./index";

const TEST_ORIGIN = "http://127.0.0.1:3000";
const TEST_TOKEN = "frontend-api-test-token";

describe("authenticated frontend API client", () => {
  test("adds the canonical Bearer credential and preserves caller headers", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const apiFetch = createHarnessApiFetch({
      token: TEST_TOKEN,
      origin: TEST_ORIGIN,
      fetchClient: async (input, init) => {
        requests.push({ input, init });
        return new Response("ok", { status: 200 });
      }
    });

    await apiFetch("/api/tasks", {
      method: "POST",
      redirect: "follow",
      headers: {
        accept: "application/json",
        authorization: "Bearer caller-must-not-override"
      }
    });

    expect(requests).toHaveLength(1);
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(requests[0]?.init?.redirect).toBe("error");
  });

  test("preserves Request headers before applying init headers and the credential", async () => {
    let capturedHeaders = new Headers();
    const apiFetch = createHarnessApiFetch({
      token: TEST_TOKEN,
      origin: TEST_ORIGIN,
      fetchClient: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response("ok");
      }
    });
    const request = new Request(`${TEST_ORIGIN}/api/tasks`, {
      headers: { "x-request-source": "request", authorization: "Bearer stale" }
    });

    await apiFetch(request, { headers: { "x-init-source": "init" } });

    expect(capturedHeaders.get("x-request-source")).toBe("request");
    expect(capturedHeaders.get("x-init-source")).toBe("init");
    expect(capturedHeaders.get("authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });

  test("accepts same-origin API string, URL, and Request inputs", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const apiFetch = createHarnessApiFetch({
      token: TEST_TOKEN,
      origin: TEST_ORIGIN,
      fetchClient: async (input, init) => {
        const rawUrl = input instanceof Request ? input.url : String(input);
        requests.push({
          url: new URL(rawUrl, TEST_ORIGIN).href,
          authorization: new Headers(init?.headers).get("authorization")
        });
        return new Response("ok");
      }
    });

    await apiFetch(`${TEST_ORIGIN}/api/tasks?input=string`);
    await apiFetch(new URL(`${TEST_ORIGIN}/api/tasks?input=url`));
    await apiFetch(new Request(`${TEST_ORIGIN}/api/tasks?input=request`));

    expect(requests).toEqual([
      {
        url: `${TEST_ORIGIN}/api/tasks?input=string`,
        authorization: `Bearer ${TEST_TOKEN}`
      },
      {
        url: `${TEST_ORIGIN}/api/tasks?input=url`,
        authorization: `Bearer ${TEST_TOKEN}`
      },
      {
        url: `${TEST_ORIGIN}/api/tasks?input=request`,
        authorization: `Bearer ${TEST_TOKEN}`
      }
    ]);
  });

  test("rejects non-api and cross-origin targets before invoking fetch", async () => {
    let calls = 0;
    const apiFetch = createHarnessApiFetch({
      token: TEST_TOKEN,
      origin: TEST_ORIGIN,
      fetchClient: async () => {
        calls += 1;
        return new Response("unexpected");
      }
    });

    await expect(apiFetch("/dashboard")).rejects.toMatchObject({ code: "request_not_api" });
    await expect(apiFetch("https://example.com/api/tasks")).rejects.toMatchObject({
      code: "request_cross_origin"
    });
    await expect(apiFetch("//127.0.0.1:3000/api/tasks")).rejects.toMatchObject({
      code: "request_cross_origin"
    });
    expect(calls).toBe(0);

    const noOriginFetch = createHarnessApiFetch({
      token: TEST_TOKEN,
      fetchClient: async () => {
        calls += 1;
        return new Response("unexpected");
      }
    });
    await expect(noOriginFetch("//example.com/api/tasks")).rejects.toMatchObject({
      code: "request_cross_origin"
    });
    expect(calls).toBe(0);
  });

  test("reads only a valid in-memory bootstrap object", () => {
    expect(
      readHarnessBootstrap({ [HARNESS_BOOTSTRAP_GLOBAL]: { token: TEST_TOKEN } })
    ).toEqual({ token: TEST_TOKEN });
    expect(() => readHarnessBootstrap({})).toThrow(HarnessApiClientError);
    expect(() =>
      readHarnessBootstrap({ [HARNESS_BOOTSTRAP_GLOBAL]: { token: "contains,comma" } })
    ).toThrow(HarnessApiClientError);
  });

  test("serializes script-sensitive token bytes without creating a second script tag", () => {
    const token = String.raw`safe</script><script>not-run</script>'"\\&`;
    const markup = renderHarnessBootstrapScript({ token });

    expect(markup.match(/<script\b/g)).toHaveLength(1);
    expect(markup.match(/<\/script>/g)).toHaveLength(1);
    expect(markup).not.toContain(token);
    expect(markup).not.toContain("</script><script>");

    const body = scriptBody(markup, "data-harness-bootstrap");
    const windowLike: Record<string, unknown> = {};
    new Function("window", body)(windowLike);

    expect(windowLike[HARNESS_BOOTSTRAP_GLOBAL]).toEqual({ token });
    const descriptor = Object.getOwnPropertyDescriptor(windowLike, HARNESS_BOOTSTRAP_GLOBAL);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
  });

  test("browser runtime installs a readonly same-origin /api wrapper", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const windowLike: Record<string, unknown> = {
      [HARNESS_BOOTSTRAP_GLOBAL]: Object.freeze({ token: TEST_TOKEN }),
      location: { origin: TEST_ORIGIN },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl = input instanceof Request ? input.url : String(input);
        requests.push({
          url: new URL(rawUrl, TEST_ORIGIN).href,
          authorization: new Headers(init?.headers).get("authorization")
        });
        return new Response("ok");
      }
    };
    Object.defineProperty(windowLike, "localStorage", {
      get() {
        throw new Error("localStorage must not be read");
      }
    });

    new Function("window", HARNESS_API_CLIENT_SCRIPT)(windowLike);
    const apiFetch = windowLike[HARNESS_API_FETCH_GLOBAL] as
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;

    expect(typeof apiFetch).toBe("function");
    if (!apiFetch) throw new Error("Harness API client was not installed.");
    await apiFetch("/api/tasks", { headers: { accept: "application/json" } });
    await apiFetch(`${TEST_ORIGIN}/api/tasks?input=string`);
    await apiFetch(new URL(`${TEST_ORIGIN}/api/tasks?input=url`));
    await apiFetch(new Request(`${TEST_ORIGIN}/api/tasks?input=request`));
    await expect(apiFetch("/dashboard")).rejects.toThrow("limited to /api/**");
    await expect(apiFetch("https://example.com/api/tasks")).rejects.toThrow("cross-origin");
    await expect(apiFetch("//127.0.0.1:3000/api/tasks")).rejects.toThrow("cross-origin");

    expect(requests).toEqual([
      {
        url: `${TEST_ORIGIN}/api/tasks`,
        authorization: `Bearer ${TEST_TOKEN}`
      },
      {
        url: `${TEST_ORIGIN}/api/tasks?input=string`,
        authorization: `Bearer ${TEST_TOKEN}`
      },
      {
        url: `${TEST_ORIGIN}/api/tasks?input=url`,
        authorization: `Bearer ${TEST_TOKEN}`
      },
      {
        url: `${TEST_ORIGIN}/api/tasks?input=request`,
        authorization: `Bearer ${TEST_TOKEN}`
      }
    ]);
    const descriptor = Object.getOwnPropertyDescriptor(windowLike, HARNESS_API_FETCH_GLOBAL);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(HARNESS_API_CLIENT_SCRIPT).not.toContain("localStorage");
  });

  test("both wrappers stop native redirects before credentials can reach a non-API page", async () => {
    const observed: Array<{ pathname: string; authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        observed.push({
          pathname: url.pathname,
          authorization: request.headers.get("authorization")
        });
        if (url.pathname === "/api/start") {
          return Response.redirect(new URL("/dashboard", server.url), 302);
        }
        return new Response("unexpected redirect destination");
      }
    });

    try {
      const origin = server.url.origin;
      const typedApiFetch = createHarnessApiFetch({ token: TEST_TOKEN, origin });
      const windowLike: Record<string, unknown> = {
        [HARNESS_BOOTSTRAP_GLOBAL]: Object.freeze({ token: TEST_TOKEN }),
        location: { origin },
        fetch: globalThis.fetch
      };
      new Function("window", HARNESS_API_CLIENT_SCRIPT)(windowLike);
      const inlineApiFetch = windowLike[HARNESS_API_FETCH_GLOBAL] as
        | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
        | undefined;
      if (!inlineApiFetch) throw new Error("Harness inline API client was not installed.");

      for (const [label, apiFetch] of [
        ["typed", typedApiFetch],
        ["inline", inlineApiFetch]
      ] as const) {
        for (const callerInit of [undefined, { redirect: "follow" as const }]) {
          observed.length = 0;
          await expect(apiFetch(`${origin}/api/start`, callerInit)).rejects.toThrow();
          expect(observed, `${label}/${callerInit?.redirect ?? "default"}`).toEqual([
            {
              pathname: "/api/start",
              authorization: `Bearer ${TEST_TOKEN}`
            }
          ]);
        }
      }
    } finally {
      await server.stop(true);
    }
  });
});

function scriptBody(markup: string, attribute: string): string {
  const match = new RegExp(`<script ${attribute}>([\\s\\S]*)<\\/script>`).exec(markup);
  if (!match?.[1]) throw new Error(`Missing script body for ${attribute}.`);
  return match[1];
}
