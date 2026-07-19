import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskServiceError,
  createTaskCardService,
  failureEvents,
  preserveTaskServiceErrorCompensationCompatibility,
  taskServiceErrorAtBoundary,
  type CreateTaskInput
} from "@shud-harness/core";
import { createBackendApi, type ApiErrorResponse } from "./index";

const tempRoots: string[] = [];

describe("backend failure occurrence ledger boundary", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("serializes a one-shot trusted typed primary without reclassifying its Proxy", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const primaryTarget = typedPrimary();
    let prototypeReads = 0;
    const primary = new Proxy(primaryTarget, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        if (prototypeReads > 1) throw new Error("typed Proxy was reclassified");
        return Reflect.getPrototypeOf(target);
      }
    });
    const compensation = new Error("route compensation");
    const routed = preserveTaskServiceErrorCompensationCompatibility(
      primary,
      [compensation],
      "route typed fold",
      "body",
      ["final_release"]
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

    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTaskCreateBody())
    });
    const body = (await response.json()) as ApiErrorResponse;

    expect(response.status).toBe(primaryTarget.status);
    expect(body.error.category).toBe(primaryTarget.category);
    expect(body.error.message).toBe(primaryTarget.message);
    expect(body.error.evidence_refs).toEqual(primaryTarget.evidenceRefs);
    expect(taskServiceErrorAtBoundary(routed)).toBe(primary);
    expect(failureEvents(routed).map((event) => event.value)).toEqual([primary, compensation]);
    expect(prototypeReads).toBe(1);
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

    const response = await app.request("/api/tasks", {
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
