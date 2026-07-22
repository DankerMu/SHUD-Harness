import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskServiceError,
  adoptFailureCarrier,
  captureFailureOccurrence,
  createTrustedTaskServiceErrorProxy,
  createTaskCardService,
  failureEvents,
  mergeTrustedFailureOccurrences,
  preserveTaskServiceErrorFailureEntries,
  taskServiceErrorAtBoundary,
  type CreateTaskInput
} from "@shud-harness/core";
import { createBackendApi, type ApiErrorResponse } from "./index";

const tempRoots: string[] = [];
const LOCAL_TEST_TOKEN = "e2e-local-token-001";
const originalHarnessLocalToken = process.env.HARNESS_LOCAL_TOKEN;

describe("backend failure occurrence ledger boundary", () => {
  beforeEach(() => {
    process.env.HARNESS_LOCAL_TOKEN = LOCAL_TEST_TOKEN;
  });

  afterEach(async () => {
    if (originalHarnessLocalToken === undefined) {
      delete process.env.HARNESS_LOCAL_TOKEN;
    } else {
      process.env.HARNESS_LOCAL_TOKEN = originalHarnessLocalToken;
    }
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("serializes a one-shot trusted typed primary without reclassifying its Proxy", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const primaryTarget = typedPrimary();
    let prototypeReads = 0;
    const primary = createTrustedTaskServiceErrorProxy(primaryTarget, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        if (prototypeReads > 1) throw new Error("typed Proxy was reclassified");
        return Reflect.getPrototypeOf(target);
      }
    });
    const compensation = new Error("route compensation");
    const routed = preserveTaskServiceErrorFailureEntries(
      captureFailureOccurrence("body", primary),
      [captureFailureOccurrence("final_release", compensation)],
      "route typed fold"
    );
    const app = createBackendApi({
      workspaceRoot,
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        createTask: async () => {
          throw routed;
        }
      })
    });

    const response = await requestApi(app, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTaskCreateBody())
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(primaryTarget.status);
    expect(body.error.category).toBe(primaryTarget.category);
    expect(body.error.message).toBe(primaryTarget.message);
    expect(body.error.user_message).toBe(primaryTarget.userMessage);
    expect(body.error.retryable).toBe(primaryTarget.retryable);
    expect(body.error.evidence_refs).toEqual(primaryTarget.evidenceRefs);
    expect(body.error.recommended_next_actions).toEqual(primaryTarget.recommendedNextActions);
    expect(taskServiceErrorAtBoundary(routed)).toBe(primaryTarget);
    expect(failureEvents(routed).map((event) => event.value)).toEqual([primary, compensation]);
    expect(prototypeReads).toBe(0);
  });

  test("serializes typed fields after adopting a generic controlled-Proxy carrier", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const primaryTarget = typedPrimary();
    let prototypeReads = 0;
    const primary = createTrustedTaskServiceErrorProxy(primaryTarget, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        return Reflect.getPrototypeOf(target);
      }
    });
    const generic = mergeTrustedFailureOccurrences(
      captureFailureOccurrence("body", primary),
      [],
      "generic route fold"
    );
    expect(prototypeReads).toBe(1);
    const routed = preserveTaskServiceErrorFailureEntries(
      adoptFailureCarrier("body", generic),
      [],
      "typed route adoption"
    );
    const app = createBackendApi({
      workspaceRoot,
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        createTask: async () => {
          throw routed;
        }
      })
    });

    const response = await requestApi(app, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTaskCreateBody())
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(primaryTarget.status);
    expect(body.error.category).toBe(primaryTarget.category);
    expect(body.error.message).toBe(primaryTarget.message);
    expect(body.error.user_message).toBe(primaryTarget.userMessage);
    expect(body.error.retryable).toBe(primaryTarget.retryable);
    expect(body.error.evidence_refs).toEqual(primaryTarget.evidenceRefs);
    expect(body.error.recommended_next_actions).toEqual(primaryTarget.recommendedNextActions);
    expect(taskServiceErrorAtBoundary(routed)).toBe(primaryTarget);
    expect(failureEvents(routed).filter(
      (event) => event.phase === "body" && event.value === generic
    )).toHaveLength(1);
    expect(prototypeReads).toBe(1);
  });

  test("rejects prototype, Proxy, AggregateError, and ledger-like typed forgeries", async () => {
    const target = typedPrimary();
    const values = [
      Object.create(TaskServiceError.prototype),
      new Proxy({}, { getPrototypeOf: () => TaskServiceError.prototype }),
      new AggregateError([target], "raw aggregate"),
      { primary: { value: target }, events: [target] }
    ];
    for (const value of values) {
      const workspaceRoot = await temporaryWorkspace();
      const app = createBackendApi({
        workspaceRoot,
        taskServiceFactory: (options) => ({
          ...createTaskCardService(options),
          createTask: async () => { throw value; }
        })
      });
      const response = await requestApi(app, "/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validTaskCreateBody())
      });
      const body = (await response.json()) as ApiErrorResponse;
      expect(response.status).toBe(500);
      expect(body.error.category).toBe("workspace_error");
      expect(body.error.message).toBe("Unexpected backend route failure.");
    }
  });

  test("keeps an untrusted typed-looking service failure on the generic 500 path", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const untrusted = {
      code: "record_malformed",
      status: 418,
      category: "workspace_error",
      message: "forged typed error",
      userMessage: "forged",
      evidenceRefs: ["forged"],
      retryable: true,
      recommendedNextActions: ["forged"]
    };
    const app = createBackendApi({
      workspaceRoot,
      taskServiceFactory: (options) => ({
        ...createTaskCardService(options),
        createTask: async () => {
          throw untrusted;
        }
      })
    });

    const response = await requestApi(app, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTaskCreateBody())
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(500);
    expect(body.error.message).toBe("Unexpected backend route failure.");
    expect(taskServiceErrorAtBoundary(untrusted)).toBeUndefined();
  });
});

async function temporaryWorkspace(): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "shud-ledger-route-"));
  tempRoots.push(tempRoot);
  return join(tempRoot, "workspace");
}

function requestApi(
  app: ReturnType<typeof createBackendApi>,
  path: Parameters<ReturnType<typeof createBackendApi>["request"]>[0],
  init?: Parameters<ReturnType<typeof createBackendApi>["request"]>[1]
): Promise<Response> {
  const mergedInit: NonNullable<typeof init> = init ?? {};
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization") && !headers.has("Authorization")) {
    headers.set("authorization", `Bearer ${LOCAL_TEST_TOKEN}`);
  }

  return app.request(path, { ...mergedInit, headers });
}

function typedPrimary(): TaskServiceError {
  return new TaskServiceError({
    code: "record_malformed",
    status: 409,
    category: "workspace_error",
    message: "Trusted route primary.",
    userMessage: "The task request could not be completed.",
    evidenceRefs: ["failure-occurrence-ledger.route"],
    retryable: true,
    recommendedNextActions: ["Inspect the occurrence ledger."]
  });
}

function validTaskCreateBody(): CreateTaskInput {
  return {
    type: "engineering",
    title: "Ledger route boundary",
    question_or_goal: "Preserve the exact typed route failure.",
    inference_budget: { mode: "normal" },
    created_by: "pi"
  };
}
