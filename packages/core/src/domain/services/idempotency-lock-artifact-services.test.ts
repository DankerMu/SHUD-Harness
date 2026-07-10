import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskServiceError,
  createArtifactRegistryService,
  createIdempotencyRecordService,
  createTaskCardService,
  createLockRecordService,
  idempotencyRecordEvidenceRef,
  idempotencyRecordFileName,
  sha256Hex,
  assertPathInsideWorkspace,
  resolveWorkspacePath,
  type Artifact,
  type IdempotencyRecord,
  type IdempotencyRecordService,
  type LockRecord,
  WorkspacePathSafetyError
} from "./index";
import { MAX_SERVICE_RECORD_BYTES, workspaceRecordPath } from "./workspace-record-store";

const tempRoots: string[] = [];

describe("idempotency, lock, and artifact services", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("IdempotencyRecord store/get/replay uses safe deterministic direct paths", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:00:00.000Z")
    });
    const rawKey = "raw/secret:idempotency key";
    const requestDigest = "digest-same-body";

    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const record = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-idempotent"
    });
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const files = await readdir(idempotencyDirectory);

    expect(record).toEqual({
      key: rawKey,
      scope: "task",
      request_digest: requestDigest,
      status: "completed",
      result_ref: "TASK-idempotent",
      created_at: "2026-07-07T13:00:00.000Z",
      updated_at: "2026-07-07T13:00:00.000Z"
    });
    expect(begin.status).toBe("acquired");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain("raw");
    expect(files[0]).not.toContain("secret");
    expect(await service.getRecord("task", rawKey)).toEqual(record);

    const replay = await service.lookupReplay({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    expect(replay.status).toBe("completed");
    if (replay.status === "completed") {
      expect(replay.record.result_ref).toBe("TASK-idempotent");
    }

    const mismatch = await service.lookupReplay({
      scope: "task",
      key: rawKey,
      requestDigest: "digest-different-body"
    });
    expect(mismatch.status).toBe("mismatch");

    await writeFile(join(idempotencyDirectory, `${"0".repeat(64)}.json`), "{", { flag: "wx" });
    expect(await service.getRecord("task", rawKey)).toEqual(record);
  });

  test("IdempotencyRecord completeRecord rejects a missing record without writing files", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:05:00.000Z")
    });
    const rawKey = "task:create:missing-complete";

    const error = await captureTaskServiceError(() =>
      service.completeRecord({
        scope: "task",
        key: rawKey,
        requestDigest: "digest-missing-complete",
        resultRef: "TASK-missing-complete"
      })
    );

    expect(error.code).toBe("record_malformed");
    expect(error.category).toBe("workspace_error");
    await expectPathMissing(join(workspaceRoot, "tasks"));
    expect(await service.getRecord("task", rawKey)).toBeUndefined();
  });

  test("IdempotencyRecord beginRecord preserves started, mismatch, and completed states", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let currentTime = "2026-07-07T13:10:00.000Z";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date(currentTime)
    });
    const rawKey = "raw/secret:started idempotency key";
    const requestDigest = "digest-started-body";
    const startedRecord = {
      key: rawKey,
      scope: "task",
      request_digest: requestDigest,
      status: "started",
      created_at: "2026-07-07T13:10:00.000Z",
      updated_at: "2026-07-07T13:10:00.000Z"
    };

    const firstBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const files = await readdir(idempotencyDirectory);

    expect(firstBegin).toEqual({ status: "acquired", record: startedRecord });
    expect(await service.getRecord("task", rawKey)).toEqual(startedRecord);
    expect(files).toEqual([idempotencyRecordFileName(rawKey)]);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain("raw");
    expect(files[0]).not.toContain("secret");

    currentTime = "2026-07-07T13:11:00.000Z";
    const secondBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const mismatchBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest: "digest-different-body"
    });

    expect(secondBegin).toEqual({ status: "incomplete", record: startedRecord });
    expect(mismatchBegin).toEqual({ status: "mismatch", record: startedRecord });
    expect(await service.getRecord("task", rawKey)).toEqual(startedRecord);

    currentTime = "2026-07-07T13:12:00.000Z";
    const completedRecord = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-begin-record-completed"
    });
    const completedBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

    expect(completedRecord).toEqual({
      ...startedRecord,
      status: "completed",
      result_ref: "TASK-begin-record-completed",
      updated_at: "2026-07-07T13:12:00.000Z"
    });
    expect(completedBegin).toEqual({ status: "completed", record: completedRecord });
  });

  test("IdempotencyRecord failed same-digest beginRecord reacquires while different digest mismatches", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let currentTime = "2026-07-07T13:20:00.000Z";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date(currentTime)
    });
    const rawKey = "task:create:failed-retry";
    const requestDigest = "digest-retry-body";
    const firstBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

    currentTime = "2026-07-07T13:21:00.000Z";
    const failedRecord = await service.failRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const mismatchBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest: "digest-different-body"
    });

    currentTime = "2026-07-07T13:22:00.000Z";
    const retryBegin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

    expect(firstBegin.status).toBe("acquired");
    expect(failedRecord).toEqual({
      ...firstBegin.record,
      status: "failed",
      updated_at: "2026-07-07T13:21:00.000Z"
    });
    expect(failedRecord.result_ref).toBeUndefined();
    expect(mismatchBegin).toEqual({ status: "mismatch", record: failedRecord });
    expect(retryBegin).toEqual({
      status: "acquired",
      record: {
        key: rawKey,
        scope: "task",
        request_digest: requestDigest,
        status: "started",
        created_at: "2026-07-07T13:22:00.000Z",
        updated_at: "2026-07-07T13:22:00.000Z"
      }
    });
    expect(await service.getRecord("task", rawKey)).toEqual(retryBegin.record);
  });

  test("IdempotencyRecord failed retry acquisition is atomic across service instances", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:failed-concurrent-retry";
    const requestDigest = "digest-concurrent-retry-body";
    const seedService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:25:00.000Z")
    });
    const firstBegin = await seedService.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const failedRecord = await createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:26:00.000Z")
    }).failRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const firstRetryService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:27:00.000Z")
    });
    const secondRetryService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:27:01.000Z")
    });
    let failedObservationCount = 0;
    let releaseFailedObservations = () => undefined;
    const bothRetryServicesObservedFailed = new Promise<void>((resolve) => {
      releaseFailedObservations = resolve;
    });
    for (const service of [firstRetryService, secondRetryService]) {
      holdFailedLookupUntilBothRetryServicesObserveIt(
        service,
        () => {
          failedObservationCount += 1;
          if (failedObservationCount === 2) {
            releaseFailedObservations();
          }
        },
        bothRetryServicesObservedFailed
      );
    }

    const results = await Promise.all([
      firstRetryService.beginRecord({
        scope: "task",
        key: rawKey,
        requestDigest
      }),
      secondRetryService.beginRecord({
        scope: "task",
        key: rawKey,
        requestDigest
      })
    ]);
    const acquiredResults = results.filter((result) => result.status === "acquired");
    const incompleteResults = results.filter((result) => result.status === "incomplete");
    const finalRecord = await seedService.getRecord("task", rawKey);
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const files = (await readdir(idempotencyDirectory)).sort();

    expect(firstBegin.status).toBe("acquired");
    expect(failedRecord.status).toBe("failed");
    expect(failedObservationCount).toBe(2);
    expect(acquiredResults).toHaveLength(1);
    expect(incompleteResults).toHaveLength(1);
    expect(incompleteResults[0]?.record).toEqual(acquiredResults[0]?.record);
    expect(incompleteResults[0]?.record.status).toBe("started");
    expect(finalRecord).toEqual(acquiredResults[0]?.record);
    expect(finalRecord?.status).toBe("started");
    expect(finalRecord?.request_digest).toBe(requestDigest);
    expect(files).toEqual([idempotencyRecordFileName(rawKey)]);
  });

  test("IdempotencyRecord concurrent divergent completions converge without overwrite", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:divergent-complete";
    const requestDigest = "digest-divergent-complete";
    const seedService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:28:00.000Z")
    });
    const started = await seedService.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const firstCompleteService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:28:01.000Z")
    });
    const secondCompleteService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:28:02.000Z")
    });
    let startedObservationCount = 0;
    let releaseStartedObservations = () => undefined;
    const bothCompleteServicesObservedStarted = new Promise<void>((resolve) => {
      releaseStartedObservations = resolve;
    });
    for (const service of [firstCompleteService, secondCompleteService]) {
      holdStartedLookupUntilBothCompleteServicesObserveIt(
        service,
        () => {
          startedObservationCount += 1;
          if (startedObservationCount === 2) {
            releaseStartedObservations();
          }
        },
        bothCompleteServicesObservedStarted
      );
    }

    const results = await Promise.all([
      firstCompleteService.completeRecord({
        scope: "task",
        key: rawKey,
        requestDigest,
        resultRef: "TASK-divergent-a"
      }),
      secondCompleteService.completeRecord({
        scope: "task",
        key: rawKey,
        requestDigest,
        resultRef: "TASK-divergent-b"
      })
    ]);
    const finalRecord = await seedService.getRecord("task", rawKey);
    const resultRefs = results.map((result) => result.result_ref);

    expect(started.status).toBe("acquired");
    expect(startedObservationCount).toBe(2);
    expect(new Set(resultRefs).size).toBe(1);
    expect(finalRecord?.status).toBe("completed");
    expect(finalRecord?.result_ref).toBe(resultRefs[0]);
    expect(["TASK-divergent-a", "TASK-divergent-b"]).toContain(finalRecord?.result_ref);
  });

  test("IdempotencyRecord storeRecord cannot overwrite completed result_ref", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:00.000Z")
    });
    const rawKey = "task:create:completed-immutable";
    const requestDigest = "digest-completed-body";
    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const completedRecord = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-original-result"
    });
    const recordPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      idempotencyRecordFileName(rawKey)
    );

    const sameRecordError = await captureTaskServiceError(() =>
      service.storeRecord({
        ...completedRecord,
        updated_at: "2026-07-07T13:31:00.000Z"
      })
    );
    const overwriteError = await captureTaskServiceError(() =>
      service.storeRecord({
        ...completedRecord,
        result_ref: "TASK-overwritten-result",
        updated_at: "2026-07-07T13:32:00.000Z"
      })
    );
    const completedAgain = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-overwritten-result"
    });

    expect(begin.status).toBe("acquired");
    expect(sameRecordError.code).toBe("record_schema_error");
    expect(sameRecordError.category).toBe("schema_error");
    expect(overwriteError.code).toBe("record_schema_error");
    expect(overwriteError.category).toBe("schema_error");
    expect(completedAgain).toEqual(completedRecord);
    expect(await service.getRecord("task", rawKey)).toEqual(completedRecord);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(completedRecord);
  });

  test("IdempotencyRecord exact completed invalidation removes result_ref and permits reacquisition", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let currentTime = "2026-07-07T13:30:10.000Z";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date(currentTime)
    });
    const rawKey = "task:create:invalidate-exact-completed";
    const requestDigest = "digest-invalidate-exact";
    await service.beginRecord({ scope: "task", key: rawKey, requestDigest });
    const completed = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-invalidate-exact"
    });

    currentTime = "2026-07-07T13:30:11.000Z";
    const invalidated = await service.invalidateCompletedRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-invalidate-exact"
    });
    currentTime = "2026-07-07T13:30:12.000Z";
    const reacquired = await service.beginRecord({ scope: "task", key: rawKey, requestDigest });

    expect(completed.status).toBe("completed");
    expect(completed.result_ref).toBe("TASK-invalidate-exact");
    expect(invalidated.status).toBe("failed");
    expect(invalidated.result_ref).toBeUndefined();
    expect(reacquired.status).toBe("acquired");
    expect(reacquired.record.status).toBe("started");
    expect(reacquired.record.result_ref).toBeUndefined();
  });

  test("IdempotencyRecord completed invalidation requires exact digest and result_ref", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:20.000Z")
    });
    const rawKey = "task:create:invalidate-exact-guard";
    const requestDigest = "digest-invalidate-guard";
    await service.beginRecord({ scope: "task", key: rawKey, requestDigest });
    const completed = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-invalidate-guard"
    });

    const resultMismatch = await captureTaskServiceError(() =>
      service.invalidateCompletedRecord({
        scope: "task",
        key: rawKey,
        requestDigest,
        resultRef: "TASK-invalidate-other"
      })
    );
    const digestMismatch = await captureTaskServiceError(() =>
      service.invalidateCompletedRecord({
        scope: "task",
        key: rawKey,
        requestDigest: "digest-invalidate-other",
        resultRef: "TASK-invalidate-guard"
      })
    );

    expect(resultMismatch.code).toBe("record_malformed");
    expect(resultMismatch.status).toBe(409);
    expect(resultMismatch.retryable).toBe(true);
    expect(digestMismatch.code).toBe("idempotency_mismatch");
    expect(JSON.stringify(resultMismatch)).not.toContain(rawKey);
    expect(JSON.stringify(digestMismatch)).not.toContain(rawKey);
    expect(await service.getRecord("task", rawKey)).toEqual(completed);
  });

  test("IdempotencyRecord invalidates a completed record missing result_ref", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:invalidate-missing-result";
    const requestDigest = "digest-invalidate-missing-result";
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      ["tasks", "_idempotency", "task", idempotencyRecordFileName(rawKey)],
      idempotencyRecordEvidenceRef("task", rawKey)
    );
    const poisonedRecord: IdempotencyRecord = {
      key: rawKey,
      scope: "task",
      request_digest: requestDigest,
      status: "completed",
      created_at: "2026-07-07T13:30:30.000Z",
      updated_at: "2026-07-07T13:30:30.000Z"
    };
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, { flag: "wx" });
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:31.000Z")
    });

    const observed = await service.lookupReplay({ scope: "task", key: rawKey, requestDigest });
    expect(observed.status).toBe("invalid_completed");
    if (observed.status !== "invalid_completed") {
      throw new Error("Expected invalid completed authority.");
    }
    expect(observed.reason).toBe("missing_result_ref");
    expect(observed.observedResultRef).toBeUndefined();

    const failed = await service.invalidateCompletedRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: observed.observedResultRef
    });
    const reacquired = await service.beginRecord({ scope: "task", key: rawKey, requestDigest });

    expect(failed.status).toBe("failed");
    expect(failed.result_ref).toBeUndefined();
    expect(reacquired.status).toBe("acquired");
  });

  test("IdempotencyRecord invalidates an unsafe completed task result_ref without using it as a path", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:invalidate-unsafe-result";
    const requestDigest = "digest-invalidate-unsafe-result";
    const unsafeResultRef = "../outside/TASK-private-result";
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      ["tasks", "_idempotency", "task", idempotencyRecordFileName(rawKey)],
      idempotencyRecordEvidenceRef("task", rawKey)
    );
    const poisonedRecord: IdempotencyRecord = {
      key: rawKey,
      scope: "task",
      request_digest: requestDigest,
      status: "completed",
      result_ref: unsafeResultRef,
      created_at: "2026-07-07T13:30:40.000Z",
      updated_at: "2026-07-07T13:30:40.000Z"
    };
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, { flag: "wx" });
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:41.000Z")
    });

    const observed = await service.lookupReplay({ scope: "task", key: rawKey, requestDigest });
    expect(observed.status).toBe("invalid_completed");
    if (observed.status !== "invalid_completed") {
      throw new Error("Expected invalid completed authority.");
    }
    expect(observed.reason).toBe("unsafe_result_ref");

    const failed = await service.invalidateCompletedRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: observed.observedResultRef
    });

    expect(failed.status).toBe("failed");
    expect(failed.result_ref).toBeUndefined();
    await expectPathMissing(join(tempRoot, "outside"));
  });

  test("IdempotencyRecord invalidation preserves a completed authority changed after observation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:invalidate-observed-race";
    const requestDigest = "digest-invalidate-observed-race";
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      ["tasks", "_idempotency", "task", idempotencyRecordFileName(rawKey)],
      idempotencyRecordEvidenceRef("task", rawKey)
    );
    const poisonedRecord: IdempotencyRecord = {
      key: rawKey,
      scope: "task",
      request_digest: requestDigest,
      status: "completed",
      result_ref: "../outside/TASK-stale-observation",
      created_at: "2026-07-07T13:30:50.000Z",
      updated_at: "2026-07-07T13:30:50.000Z"
    };
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, { flag: "wx" });
    const service = createIdempotencyRecordService({ workspaceRoot });
    const observed = await service.lookupReplay({ scope: "task", key: rawKey, requestDigest });
    if (observed.status !== "invalid_completed") {
      throw new Error("Expected invalid completed authority.");
    }
    const repairedRecord: IdempotencyRecord = {
      ...poisonedRecord,
      result_ref: "TASK-valid-concurrent-authority",
      updated_at: "2026-07-07T13:30:51.000Z"
    };
    await writeFile(recordPath, `${JSON.stringify(repairedRecord)}\n`);

    const error = await captureTaskServiceError(() =>
      service.invalidateCompletedRecord({
        scope: "task",
        key: rawKey,
        requestDigest,
        resultRef: observed.observedResultRef
      })
    );

    expect(error.code).toBe("record_malformed");
    expect(error.status).toBe(409);
    expect(await service.getRecord("task", rawKey)).toEqual(repairedRecord);
    expect(JSON.stringify(error)).not.toContain(rawKey);
    expect(JSON.stringify(error)).not.toContain(poisonedRecord.result_ref);
  });

  test("IdempotencyRecord storeRecord rejects public completed bypasses", async () => {
    const fresh = await createTempWorkspacePath();
    tempRoots.push(fresh.tempRoot);
    const freshService = createIdempotencyRecordService({ workspaceRoot: fresh.workspaceRoot });
    const freshError = await captureTaskServiceError(() =>
      freshService.storeRecord(validIdempotencyRecord())
    );

    expect(freshError.code).toBe("record_schema_error");
    expect(freshError.category).toBe("schema_error");
    await expectPathMissing(join(fresh.workspaceRoot, "tasks"));

    const started = await createTempWorkspacePath();
    tempRoots.push(started.tempRoot);
    const startedService = createIdempotencyRecordService({
      workspaceRoot: started.workspaceRoot,
      now: () => new Date("2026-07-07T13:31:10.000Z")
    });
    const startedBegin = await startedService.beginRecord({
      scope: "task",
      key: "task:create:started-bypass",
      requestDigest: "digest-started-bypass"
    });
    const startedError = await captureTaskServiceError(() =>
      startedService.storeRecord({
        ...startedBegin.record,
        status: "completed",
        result_ref: "TASK-started-bypass"
      })
    );

    expect(startedBegin.status).toBe("acquired");
    expect(startedError.code).toBe("record_schema_error");
    expect(await startedService.getRecord("task", "task:create:started-bypass")).toEqual(
      startedBegin.record
    );

    const failed = await createTempWorkspacePath();
    tempRoots.push(failed.tempRoot);
    const failedService = createIdempotencyRecordService({
      workspaceRoot: failed.workspaceRoot,
      now: () => new Date("2026-07-07T13:31:20.000Z")
    });
    const failedBegin = await failedService.beginRecord({
      scope: "task",
      key: "task:create:failed-bypass",
      requestDigest: "digest-failed-bypass"
    });
    const failedRecord = await failedService.failRecord({
      scope: "task",
      key: "task:create:failed-bypass",
      requestDigest: "digest-failed-bypass"
    });
    const failedError = await captureTaskServiceError(() =>
      failedService.storeRecord({
        ...failedRecord,
        status: "completed",
        result_ref: "TASK-failed-bypass"
      })
    );

    expect(failedBegin.status).toBe("acquired");
    expect(failedError.code).toBe("record_schema_error");
    expect(await failedService.getRecord("task", "task:create:failed-bypass")).toEqual(
      failedRecord
    );

    const guarded = await createTempWorkspacePath();
    tempRoots.push(guarded.tempRoot);
    const guardedService = createIdempotencyRecordService({
      workspaceRoot: guarded.workspaceRoot,
      now: () => new Date("2026-07-07T13:31:30.000Z")
    });
    await guardedService.beginRecord({
      scope: "task",
      key: "task:create:guarded-complete",
      requestDigest: "digest-guarded-complete"
    });
    const completed = await guardedService.completeRecord({
      scope: "task",
      key: "task:create:guarded-complete",
      requestDigest: "digest-guarded-complete",
      resultRef: "TASK-guarded-complete"
    });

    expect(completed.status).toBe("completed");
    expect(completed.result_ref).toBe("TASK-guarded-complete");
  });

  test("IdempotencyRecord storeRecord rejects direct nonterminal transitions and preserves records", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let currentTime = "2026-07-07T13:32:00.000Z";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date(currentTime)
    });
    const rawKey = "task:create:store-digest-immutable";
    const requestDigest = "digest-original-body";
    const started = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

    const sameDigestStartedOverwrite = await captureTaskServiceError(() =>
      service.storeRecord({
        ...started.record,
        updated_at: "2026-07-07T13:32:01.000Z"
      })
    );
    const startedMismatch = await captureTaskServiceError(() =>
      service.storeRecord({
        ...started.record,
        request_digest: "digest-different-body",
        updated_at: "2026-07-07T13:32:01.000Z"
      })
    );
    const startedToFailed = await captureTaskServiceError(() =>
      service.storeRecord({
        ...started.record,
        status: "failed",
        updated_at: "2026-07-07T13:32:02.000Z"
      })
    );
    expect(await service.getRecord("task", rawKey)).toEqual(started.record);

    currentTime = "2026-07-07T13:33:00.000Z";
    const failed = await service.failRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const failedMismatch = await captureTaskServiceError(() =>
      service.storeRecord({
        ...failed,
        request_digest: "digest-other-after-failure",
        updated_at: "2026-07-07T13:33:01.000Z"
      })
    );
    const failedToStarted = await captureTaskServiceError(() =>
      service.storeRecord({
        ...failed,
        status: "started",
        created_at: "2026-07-07T13:34:00.000Z",
        updated_at: "2026-07-07T13:34:00.000Z"
      })
    );

    const seedService = createIdempotencyRecordService({ workspaceRoot });
    const seeded = await seedService.storeRecord({
      key: "task:create:seed-started",
      scope: "task",
      request_digest: "digest-seeded",
      status: "started",
      created_at: "2026-07-07T13:35:00.000Z",
      updated_at: "2026-07-07T13:35:00.000Z"
    });

    expect(started.status).toBe("acquired");
    expect(sameDigestStartedOverwrite.code).toBe("record_schema_error");
    expect(sameDigestStartedOverwrite.status).toBe(400);
    expect(startedMismatch.code).toBe("idempotency_mismatch");
    expect(startedMismatch.status).toBe(422);
    expect(startedToFailed.code).toBe("record_schema_error");
    expect(failed.status).toBe("failed");
    expect(failedMismatch.code).toBe("idempotency_mismatch");
    expect(failedMismatch.status).toBe(422);
    expect(failedToStarted.code).toBe("record_schema_error");
    expect(await service.getRecord("task", rawKey)).toEqual(failed);
    expect(seeded.status).toBe("started");
    expect(await seedService.getRecord("task", "task:create:seed-started")).toEqual(seeded);
  });

  test("IdempotencyRecord unsafe rollback quarantine fails the claim and preserves completed authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:34:30.000Z")
    });
    const retryableKey = "task:create:unsafe-rollback-retryable";
    const retryableDigest = "digest-unsafe-rollback-retryable";
    const completedKey = "task:create:unsafe-rollback-completed";
    const completedDigest = "digest-unsafe-rollback-completed";

    const started = await service.beginRecord({
      scope: "task",
      key: retryableKey,
      requestDigest: retryableDigest
    });
    const failed = await service.quarantineRecordAfterUnsafeRollback({
      scope: "task",
      key: retryableKey,
      requestDigest: retryableDigest
    });
    const reacquired = await service.beginRecord({
      scope: "task",
      key: retryableKey,
      requestDigest: retryableDigest
    });

    await service.beginRecord({
      scope: "task",
      key: completedKey,
      requestDigest: completedDigest
    });
    const completed = await service.completeRecord({
      scope: "task",
      key: completedKey,
      requestDigest: completedDigest,
      resultRef: "TASK-unsafe-rollback-authority"
    });
    const preserved = await service.quarantineRecordAfterUnsafeRollback({
      scope: "task",
      key: completedKey,
      requestDigest: completedDigest
    });
    const mismatch = await captureTaskServiceError(() =>
      service.quarantineRecordAfterUnsafeRollback({
        scope: "task",
        key: completedKey,
        requestDigest: "digest-unsafe-rollback-foreign"
      })
    );

    expect(started.status).toBe("acquired");
    expect(failed.status).toBe("failed");
    expect(failed.result_ref).toBeUndefined();
    expect(reacquired.status).toBe("acquired");
    expect(reacquired.record.status).toBe("started");
    expect(preserved).toEqual(completed);
    expect(await service.getRecord("task", completedKey)).toEqual(completed);
    expect(mismatch.code).toBe("idempotency_mismatch");
    expect(mismatch.status).toBe(422);
  });

  test("IdempotencyRecord malformed transition guard fails bounded without completing", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:00.000Z")
    });
    const rawKey = "task:create:malformed-transition-guard";
    const requestDigest = "digest-guard-body";
    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${rawKey}`)}.guard.json`
    );
    await writeFile(guardPath, "{", { flag: "wx" });

    const error = await captureTaskServiceError(() =>
      Promise.race([
        service.completeRecord({
          scope: "task",
          key: rawKey,
          requestDigest,
          resultRef: "TASK-guard-should-not-complete"
        }),
        timeoutAfter(1_000, "completeRecord hung on malformed transition guard")
      ])
    );

    expect(begin.status).toBe("acquired");
    expect(error.code).toBe("record_malformed");
    expect(error.category).toBe("workspace_error");
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", rawKey)]);
    expect(await service.getRecord("task", rawKey)).toEqual(begin.record);
  });

  test("IdempotencyRecord rollback recovery preserves a valid busy transition guard", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:30.000Z")
    });
    const rawKey = "task:create:busy-guard-rollback-recovery";
    const requestDigest = "digest-busy-guard-rollback";
    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${rawKey}`)}.guard.json`
    );
    const guard = {
      guard_id: "rollback-recovery-busy-guard",
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    await writeFile(guardPath, `${JSON.stringify(guard)}\n`, { flag: "wx" });

    const error = await captureTaskServiceError(() =>
      Promise.race([
        service.recoverFailedRecordAfterRollback({
          scope: "task",
          key: rawKey,
          requestDigest
        }),
        timeoutAfter(1_000, "recoverFailedRecordAfterRollback hung on valid busy guard")
      ])
    );

    expect(begin.status).toBe("acquired");
    expect(error.code).toBe("record_malformed");
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(true);
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", rawKey)]);
    expect(JSON.parse(await readFile(guardPath, "utf8"))).toEqual(guard);
    expect(await service.getRecord("task", rawKey)).toEqual(begin.record);
  });

  test("IdempotencyRecord stale transition guard cleanup preserves a fresh replacement guard", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:stale-guard-fresh-replacement";
    const requestDigest = "digest-stale-guard-fresh";
    const seedService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:40.000Z")
    });
    const begin = await seedService.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const failed = await seedService.failRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const guardPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      `${sha256Hex(`transition:${rawKey}`)}.guard.json`
    );
    const staleGuard = {
      guard_id: "stale-observed-guard",
      owner_pid: 9_999_999,
      acquired_at_ms: Date.now() - 31_000,
      acquired_at: "2026-07-07T13:34:00.000Z"
    };
    const freshGuard = {
      guard_id: "fresh-replacement-guard",
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    await writeFile(guardPath, `${JSON.stringify(staleGuard)}\n`, { flag: "wx" });
    let cleanupHookCalls = 0;
    const retryService = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:41.000Z"),
      transitionGuardHooks: {
        beforeStaleGuardCleanup: async ({ guardPath: observedPath, observedGuard }) => {
          cleanupHookCalls += 1;
          expect(observedPath).toBe(guardPath);
          expect(observedGuard).toEqual(staleGuard);
          await rm(observedPath, { force: true });
          await writeFile(observedPath, `${JSON.stringify(freshGuard)}\n`, { flag: "wx" });
        }
      }
    });

    const retry = await Promise.race([
      retryService.beginRecord({
        scope: "task",
        key: rawKey,
        requestDigest
      }),
      timeoutAfter(1_000, "beginRecord hung while preserving a fresh replacement guard")
    ]);

    expect(begin.status).toBe("acquired");
    expect(failed.status).toBe("failed");
    expect(cleanupHookCalls).toBe(1);
    expect(retry).toEqual({ status: "incomplete", record: failed });
    expect(JSON.parse(await readFile(guardPath, "utf8"))).toEqual(freshGuard);
    expect(await seedService.getRecord("task", rawKey)).toEqual(failed);
  });

  test("IdempotencyRecord stale transition cleanup lock is recoverable before completion", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:stale-cleanup-lock-complete";
    const requestDigest = "digest-stale-cleanup-lock";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:50.000Z")
    });
    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const cleanupLockPath = idempotencyTransitionCleanupLockPath(workspaceRoot, rawKey);
    const staleCleanupLock = {
      guard_id: "stale-cleanup-lock",
      owner_pid: 9_999_999,
      acquired_at_ms: Date.now() - 31_000,
      acquired_at: "2026-07-07T13:34:30.000Z"
    };
    await writeFile(cleanupLockPath, `${JSON.stringify(staleCleanupLock)}\n`, { flag: "wx" });

    const completed = await Promise.race([
      service.completeRecord({
        scope: "task",
        key: rawKey,
        requestDigest,
        resultRef: "TASK-cleanup-lock-recovered"
      }),
      timeoutAfter(1_000, "completeRecord hung on stale transition cleanup lock")
    ]);

    expect(begin.status).toBe("acquired");
    expect(completed.status).toBe("completed");
    expect(completed.result_ref).toBe("TASK-cleanup-lock-recovered");
    await expectPathMissing(cleanupLockPath);
    expect(await service.getRecord("task", rawKey)).toEqual(completed);
  });

  test("IdempotencyRecord live transition cleanup lock stays busy and is not deleted", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const rawKey = "task:create:live-cleanup-lock-complete";
    const requestDigest = "digest-live-cleanup-lock";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:55.000Z")
    });
    const begin = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const cleanupLockPath = idempotencyTransitionCleanupLockPath(workspaceRoot, rawKey);
    const liveCleanupLock = {
      guard_id: "live-cleanup-lock",
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    await writeFile(cleanupLockPath, `${JSON.stringify(liveCleanupLock)}\n`, { flag: "wx" });

    const error = await captureTaskServiceError(() =>
      Promise.race([
        service.completeRecord({
          scope: "task",
          key: rawKey,
          requestDigest,
          resultRef: "TASK-cleanup-lock-live"
        }),
        timeoutAfter(1_000, "completeRecord hung on live transition cleanup lock")
      ])
    );

    expect(begin.status).toBe("acquired");
    expect(error.code).toBe("record_malformed");
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(true);
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", rawKey)]);
    expect(JSON.parse(await readFile(cleanupLockPath, "utf8"))).toEqual(liveCleanupLock);
    expect(await service.getRecord("task", rawKey)).toEqual(begin.record);
  });

  test("TaskCard rollback evicts cached task when the durable lane is missing", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:58.000Z"),
      taskIdFactory: () => "TASK-missing-lane-rollback"
    });
    const task = await service.createTask({
      type: "engineering",
      title: "Rollback missing lane",
      question_or_goal: "Ensure rollback removes stale in-memory task state.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });

    await rm(join(workspaceRoot, "tasks", task.task_id), { recursive: true, force: true });
    await service.rollbackTaskForIdempotency(task.task_id);
    const detailError = await captureTaskServiceError(() => service.getTask(task.task_id));

    expect(await service.listTasks()).toEqual([]);
    expect(detailError.code).toBe("task_not_found");
    expect(detailError.status).toBe(404);
    await expectPathMissing(join(workspaceRoot, "tasks", task.task_id));
  });

  test("TaskCard unsafe rollback evicts cache without following a replaced lane", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:35:59.000Z"),
      taskIdFactory: () => "TASK-unsafe-lane-rollback"
    });
    const task = await service.createTask({
      type: "engineering",
      title: "Rollback unsafe lane",
      question_or_goal: "Evict cache without following a replacement task lane.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });
    const taskLane = join(workspaceRoot, "tasks", task.task_id);
    const outsideLane = join(tempRoot, "outside-task-lane");
    const outsideSentinel = join(outsideLane, "snapshot.json");
    await mkdir(outsideLane, { recursive: true });
    await writeFile(outsideSentinel, "external bytes must survive", { flag: "wx" });
    await rm(taskLane, { recursive: true, force: true });
    await symlink(outsideLane, taskLane, "dir");

    const rollbackError = await captureTaskServiceError(() =>
      service.rollbackTaskForIdempotency(task.task_id)
    );
    const detailError = await captureTaskServiceError(() => service.getTask(task.task_id));

    expect(rollbackError.code).toBe("task_lane_not_directory");
    expect(await service.listTasks()).toEqual([]);
    expect(detailError.code).toBe("task_not_found");
    expect(await readFile(outsideSentinel, "utf8")).toBe("external bytes must survive");
  });

  test("IdempotencyRecord invalid schema is rejected without workspace files", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });

    const error = await captureTaskServiceError(() =>
      service.storeRecord({
        ...validIdempotencyRecord(),
        status: "running"
      } as unknown as IdempotencyRecord)
    );

    expect(error.code).toBe("record_schema_error");
    await expectPathMissing(join(workspaceRoot, "tasks"));
  });

  test("IdempotencyRecord completed status without result_ref is rejected without workspace files", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const record = validIdempotencyRecord();
    delete record.result_ref;

    const error = await captureTaskServiceError(() => service.storeRecord(record));

    expect(error.code).toBe("record_schema_error");
    expect(error.category).toBe("schema_error");
    await expectPathMissing(join(workspaceRoot, "tasks"));
  });

  test("oversized existing IdempotencyRecord fails closed without leaking record content", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const rawKey = "oversized existing idempotency key";
    const secret = "oversized-record-secret";
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(rawKey));
    const oversizedRecordText = JSON.stringify({
      ...validIdempotencyRecord(),
      key: rawKey,
      result_ref: `TASK-${secret}`,
      payload: "x".repeat(MAX_SERVICE_RECORD_BYTES)
    });
    expect(Buffer.byteLength(oversizedRecordText, "utf8")).toBeGreaterThan(
      MAX_SERVICE_RECORD_BYTES
    );

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(recordPath, oversizedRecordText, { flag: "wx" });

    const error = await captureTaskServiceError(() => service.getRecord("task", rawKey));

    expect(error.code).toBe("record_malformed");
    expect(error.category).toBe("workspace_error");
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", rawKey)]);
    expectErrorNotToLeakRecordContent(error, secret);
  });

  test("small IdempotencyRecord reads allocate by record size instead of the full service cap", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:36:00.000Z")
    });
    const rawKey = "task:create:small-record-allocation";
    const requestDigest = "digest-small-record";
    await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });
    const completed = await service.completeRecord({
      scope: "task",
      key: rawKey,
      requestDigest,
      resultRef: "TASK-small-record"
    });
    const allocations: number[] = [];
    const mutableBuffer = Buffer as typeof Buffer & {
      allocUnsafe: typeof Buffer.allocUnsafe;
    };
    const originalAllocUnsafe = mutableBuffer.allocUnsafe;
    mutableBuffer.allocUnsafe = ((size: number) => {
      allocations.push(size);
      return originalAllocUnsafe(size);
    }) as typeof Buffer.allocUnsafe;

    try {
      expect(await service.getRecord("task", rawKey)).toEqual(completed);
    } finally {
      mutableBuffer.allocUnsafe = originalAllocUnsafe;
    }

    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations).not.toContain(MAX_SERVICE_RECORD_BYTES + 1);
    expect(Math.max(...allocations)).toBeLessThan(4096);
  });

  test("symlinked IdempotencyRecord leaf fails closed without hydrating outside record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const rawKey = "symlinked idempotency key";
    const secret = "outside-record-secret";
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(rawKey));
    const outsideRecordPath = join(tempRoot, "outside-idempotency-record.json");

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      outsideRecordPath,
      `${JSON.stringify({
        ...validIdempotencyRecord(),
        key: rawKey,
        request_digest: "outside-digest",
        result_ref: `TASK-${secret}`
      })}\n`,
      { flag: "wx" }
    );
    await symlink(outsideRecordPath, recordPath);

    const error = await captureTaskServiceError(() => service.getRecord("task", rawKey));

    expect(error.code).toBe("record_malformed");
    expect(error.category).toBe("workspace_error");
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", rawKey)]);
    expectErrorNotToLeakRecordContent(error, secret);
  });

  test("IdempotencyRecord lookup fails closed when stored key does not match the lookup path", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const lookupKey = "task:create:path-key-a";
    const storedKey = "task:create:path-key-b-secret";
    const requestDigest = "digest-record-key-mismatch";
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(lookupKey));

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: storedKey,
        scope: "task",
        request_digest: requestDigest,
        status: "completed",
        result_ref: "TASK-wrong-key-replay",
        created_at: "2026-07-07T13:37:00.000Z",
        updated_at: "2026-07-07T13:37:00.000Z"
      })}\n`,
      { flag: "wx" }
    );

    const error = await captureTaskServiceError(() =>
      service.lookupReplay({
        scope: "task",
        key: lookupKey,
        requestDigest
      })
    );

    expect(error.code).toBe("record_malformed");
    expect(error.status).toBe(500);
    expect(error.category).toBe("workspace_error");
    expect(error.evidenceRefs).toEqual([
      idempotencyRecordEvidenceRef("task", lookupKey),
      "idempotency.key",
      "idempotency.scope"
    ]);
    expectErrorNotToLeakRecordContent(error, lookupKey);
    expectErrorNotToLeakRecordContent(error, storedKey);
    expectErrorNotToLeakRecordContent(error, "TASK-wrong-key-replay");
  });

  test("IdempotencyRecord lookup fails closed when stored scope does not match the lookup path", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const lookupKey = "task:create:path-scope-a";
    const requestDigest = "digest-record-scope-mismatch";
    const idempotencyDirectory = join(workspaceRoot, "tasks", "_idempotency", "task");
    const recordPath = join(idempotencyDirectory, idempotencyRecordFileName(lookupKey));

    await mkdir(idempotencyDirectory, { recursive: true });
    await writeFile(
      recordPath,
      `${JSON.stringify({
        key: lookupKey,
        scope: "job",
        request_digest: requestDigest,
        status: "completed",
        result_ref: "TASK-wrong-scope-replay",
        created_at: "2026-07-07T13:38:00.000Z",
        updated_at: "2026-07-07T13:38:00.000Z"
      })}\n`,
      { flag: "wx" }
    );

    const error = await captureTaskServiceError(() =>
      service.lookupReplay({
        scope: "task",
        key: lookupKey,
        requestDigest
      })
    );

    expect(error.code).toBe("record_malformed");
    expect(error.status).toBe(500);
    expect(error.category).toBe("workspace_error");
    expect(error.evidenceRefs).toEqual([
      idempotencyRecordEvidenceRef("task", lookupKey),
      "idempotency.key",
      "idempotency.scope"
    ]);
    expectErrorNotToLeakRecordContent(error, lookupKey);
    expectErrorNotToLeakRecordContent(error, "TASK-wrong-scope-replay");
  });

  test("LockRecord store/get validates schema and uses direct lookup paths", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const lock = validLockRecord();

    await expect(service.storeLock(lock)).resolves.toEqual(lock);
    expect(await service.getLock("task", lock.lock_id)).toEqual(lock);
    expect((await stat(join(workspaceRoot, "locks", "task", `${lock.lock_id}.json`))).isFile()).toBe(
      true
    );

    await writeFile(join(workspaceRoot, "locks", "task", "LOCK-bad-sibling.json"), "{", {
      flag: "wx"
    });
    expect(await service.getLock("task", lock.lock_id)).toEqual(lock);
  });

  test("LockRecord invalid schema or id is rejected without lock files", async () => {
    const invalidSchema = await createTempWorkspacePath();
    tempRoots.push(invalidSchema.tempRoot);
    const schemaService = createLockRecordService({ workspaceRoot: invalidSchema.workspaceRoot });

    const schemaError = await captureTaskServiceError(() =>
      schemaService.storeLock({
        ...validLockRecord(),
        status: "open"
      } as unknown as LockRecord)
    );

    expect(schemaError.code).toBe("record_schema_error");
    await expectPathMissing(join(invalidSchema.workspaceRoot, "locks"));

    const invalidId = await createTempWorkspacePath();
    tempRoots.push(invalidId.tempRoot);
    const idService = createLockRecordService({ workspaceRoot: invalidId.workspaceRoot });
    const idError = await captureTaskServiceError(() =>
      idService.storeLock({
        ...validLockRecord(),
        lock_id: "../LOCK-unsafe"
      })
    );

    expect(idError.code).toBe("record_id_not_safe");
    await expectPathMissing(join(invalidId.workspaceRoot, "locks"));
  });

  test("LockRecord write preparation rejects unsafe record directories before partial writes", async () => {
    const nonDirectoryCase = await createTempWorkspacePath();
    tempRoots.push(nonDirectoryCase.tempRoot);
    const nonDirectoryService = createLockRecordService({
      workspaceRoot: nonDirectoryCase.workspaceRoot
    });
    await mkdir(nonDirectoryCase.workspaceRoot, { recursive: true });
    await writeFile(join(nonDirectoryCase.workspaceRoot, "locks"), "not a directory", {
      flag: "wx"
    });

    const nonDirectoryError = await captureTaskServiceError(() =>
      nonDirectoryService.storeLock(validLockRecord())
    );

    expect(nonDirectoryError.code).toBe("workspace_path_not_safe");
    expect(nonDirectoryError.category).toBe("workspace_error");
    await expectPathMissing(
      join(nonDirectoryCase.workspaceRoot, "locks", "task", "LOCK-0001.json")
    );

    const symlinkCase = await createTempWorkspacePath();
    tempRoots.push(symlinkCase.tempRoot);
    const symlinkService = createLockRecordService({ workspaceRoot: symlinkCase.workspaceRoot });
    const outsideLocksRoot = join(symlinkCase.tempRoot, "outside-locks");
    await mkdir(symlinkCase.workspaceRoot, { recursive: true });
    await mkdir(outsideLocksRoot, { recursive: true });
    await symlink(outsideLocksRoot, join(symlinkCase.workspaceRoot, "locks"), "dir");

    const symlinkError = await captureTaskServiceError(() =>
      symlinkService.storeLock(validLockRecord())
    );

    expect(symlinkError.code).toBe("workspace_path_not_safe");
    expect(symlinkError.category).toBe("workspace_error");
    expect(await readdir(outsideLocksRoot)).toEqual([]);
    await expectPathMissing(join(outsideLocksRoot, "task", "LOCK-0001.json"));
  });

  test("workspace path helper rejects traversal and symlink escape while normalizing legal paths", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);

    const traversalError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: "../outside/report.md",
        evidenceRef: "artifact.path"
      })
    );

    expect(traversalError.evidenceRef).toBe("artifact.path");
    await expectPathMissing(join(tempRoot, "outside", "report.md"));

    await mkdir(join(workspaceRoot, "artifacts"), { recursive: true });
    const outsideRoot = join(tempRoot, "outside-artifacts");
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, join(workspaceRoot, "artifacts", "reports"), "dir");

    const symlinkError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: "artifacts/reports/report.md",
        evidenceRef: "artifact.path"
      })
    );

    expect(symlinkError.evidenceRef).toBe("artifact.path");
    await expectPathMissing(join(outsideRoot, "report.md"));

    await rm(join(workspaceRoot, "artifacts", "reports"), { force: true });
    const resolved = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "artifacts/reports/./TASK-0001/report.md",
      evidenceRef: "artifact.path"
    });

    expect(resolved.absolutePath).toBe(
      join(workspaceRoot, "artifacts", "reports", "TASK-0001", "report.md")
    );
    expect(resolved.normalizedPath).toBe("artifacts/reports/TASK-0001/report.md");

    const readonlyRoot = join(tempRoot, "readonly-source");
    await mkdir(readonlyRoot, { recursive: true });
    const readonlyResolution = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: join(readonlyRoot, "input.dat"),
      evidenceRef: "readonly.path",
      access: "read",
      allowedReadonlyRoots: [readonlyRoot]
    });
    expect(readonlyResolution.boundary).toBe("allowed_readonly");
    expect(readonlyResolution.normalizedPath).toBe(join(readonlyRoot, "input.dat"));

    const readonlyWriteError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: join(readonlyRoot, "input.dat"),
        evidenceRef: "readonly.path",
        access: "write",
        allowedReadonlyRoots: [readonlyRoot]
      })
    );
    expect(readonlyWriteError.evidenceRef).toBe("readonly.path");

    const nestedReadonlyRoot = join(workspaceRoot, "data", "raw");
    await mkdir(nestedReadonlyRoot, { recursive: true });
    const nestedReadonlyResolution = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "data/raw/out.csv",
      evidenceRef: "nested-readonly.path",
      access: "read",
      allowedReadonlyRoots: [nestedReadonlyRoot]
    });
    expect(nestedReadonlyResolution.boundary).toBe("allowed_readonly");
    expect(nestedReadonlyResolution.boundaryRoot).toBe(nestedReadonlyRoot);
    expect(nestedReadonlyResolution.normalizedPath).toBe(join(nestedReadonlyRoot, "out.csv"));

    const nestedReadonlyWriteError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: "data/raw/out.csv",
        evidenceRef: "nested-readonly.path",
        access: "write",
        allowedReadonlyRoots: [nestedReadonlyRoot]
      })
    );
    expect(nestedReadonlyWriteError.evidenceRef).toBe("nested-readonly.path");

    const otherCwd = join(tempRoot, "other-cwd");
    await mkdir(otherCwd, { recursive: true });
    const originalCwd = process.cwd();
    try {
      process.chdir(otherCwd);

      const relativeWorkspaceRootError = await captureWorkspacePathSafetyError(() =>
        resolveWorkspacePath({
          workspaceRoot: "workspace",
          inputPath: "data/raw/out.csv",
          evidenceRef: "workspace.root"
        })
      );
      expect(relativeWorkspaceRootError.message).toBe("workspaceRoot must be absolute.");
      expect(relativeWorkspaceRootError.evidenceRef).toBe("workspace.root");

      const relativeReadonlyRootError = await captureWorkspacePathSafetyError(() =>
        resolveWorkspacePath({
          workspaceRoot,
          inputPath: "data/raw/out.csv",
          evidenceRef: "readonly.root",
          access: "read",
          allowedReadonlyRoots: ["data/raw"]
        })
      );
      expect(relativeReadonlyRootError.message).toBe("allowedReadonlyRoots must be absolute.");
      expect(relativeReadonlyRootError.evidenceRef).toBe("readonly.root");

      expect(() =>
        assertPathInsideWorkspace("workspace", join(workspaceRoot, "data", "raw"), "workspace.root")
      ).toThrow(WorkspacePathSafetyError);
      expect(() =>
        assertPathInsideWorkspace(workspaceRoot, "data/raw/out.csv", "workspace.target")
      ).toThrow(WorkspacePathSafetyError);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("workspace path helper accepts dot-prefixed names and rejects unsafe boundaries", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);

    const dotPrefixedResolution = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "..draft/report.md",
      evidenceRef: "artifact.path"
    });

    expect(dotPrefixedResolution.absolutePath).toBe(join(workspaceRoot, "..draft", "report.md"));
    expect(dotPrefixedResolution.normalizedPath).toBe("..draft/report.md");
    expect(
      workspaceRecordPath(
        workspaceRoot,
        ["..draft", "record.json"],
        "workspace/..draft/record.json"
      )
    ).toBe(join(workspaceRoot, "..draft", "record.json"));

    const outsidePath = join(tempRoot, "outside", "report.md");
    const absoluteOutsideError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: outsidePath,
        evidenceRef: "artifact.path"
      })
    );

    expect(absoluteOutsideError.evidenceRef).toBe("artifact.path");
    await expectPathMissing(outsidePath);

    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "artifacts"), "not a directory", { flag: "wx" });

    const nonDirectoryAncestorError = await captureWorkspacePathSafetyError(() =>
      resolveWorkspacePath({
        workspaceRoot,
        inputPath: "artifacts/reports/report.md",
        evidenceRef: "artifact.path"
      })
    );

    expect(nonDirectoryAncestorError.evidenceRef).toBe("artifact.path");
    await expectPathMissing(join(workspaceRoot, "artifacts", "reports", "report.md"));
  });

  test("TaskCard snapshot writes expose normalized task directories and reject symlink escape", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const observedTaskDirectories: string[] = [];
    const service = createTaskCardService({
      workspaceRoot: join(workspaceRoot, "."),
      now: () => new Date("2026-07-07T13:40:00.000Z"),
      taskIdFactory: () => "TASK-path-normalized",
      snapshotWriteHooks: {
        beforeSnapshotWrite: ({ taskDirectory }) => {
          observedTaskDirectories.push(taskDirectory);
        }
      }
    });

    const task = await service.createTask({
      type: "engineering",
      title: "Normalize task path",
      question_or_goal: "Write a task snapshot through normalized workspace paths.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });

    expect(observedTaskDirectories).toEqual([
      join(workspaceRoot, "tasks", "TASK-path-normalized")
    ]);
    expect((await stat(join(workspaceRoot, "tasks", task.task_id, "snapshot.json"))).isFile()).toBe(
      true
    );

    const escapeCase = await createTempWorkspacePath();
    tempRoots.push(escapeCase.tempRoot);
    const outsideTasksRoot = join(escapeCase.tempRoot, "outside-tasks");
    await mkdir(escapeCase.workspaceRoot, { recursive: true });
    await mkdir(outsideTasksRoot, { recursive: true });
    await symlink(outsideTasksRoot, join(escapeCase.workspaceRoot, "tasks"), "dir");
    const escapeService = createTaskCardService({
      workspaceRoot: escapeCase.workspaceRoot,
      taskIdFactory: () => "TASK-symlink-escape"
    });

    const escapeError = await captureTaskServiceError(() =>
      escapeService.createTask({
        type: "engineering",
        title: "Reject task symlink",
        question_or_goal: "Do not write a task snapshot outside the workspace.",
        inference_budget: { mode: "normal" },
        created_by: "pi"
      })
    );

    expect(escapeError.code).toBe("workspace_path_not_safe");
    await expectPathMissing(join(outsideTasksRoot, "TASK-symlink-escape", "snapshot.json"));
  });

  test("TaskCard snapshot writes revalidate after post-write hook before caching no-key creates", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskIds = ["TASK-post-hook-delete", "TASK-post-hook-retry"];
    let shouldDeleteSnapshot = true;
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:40:05.000Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-post-hook-extra",
      snapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldDeleteSnapshot) {
            return;
          }
          shouldDeleteSnapshot = false;
          await rm(join(taskDirectory, "snapshot.json"));
        }
      }
    });

    const error = await captureTaskServiceError(() =>
      service.createTask({
        type: "engineering",
        title: "Reject deleted post-hook snapshot",
        question_or_goal: "Do not cache a task whose durable snapshot was deleted by a hook.",
        inference_budget: { mode: "normal" },
        created_by: "pi"
      })
    );
    const listAfterFailure = await service.listTasks();
    const retryTask = await service.createTask({
      type: "engineering",
      title: "Retry after post-hook repair",
      question_or_goal: "Retry succeeds after the snapshot hook stops deleting the file.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });

    expect(error.code).toBe("workspace_path_not_safe");
    expect(listAfterFailure).toEqual([]);
    expect(retryTask.task_id).toBe("TASK-post-hook-retry");
    expect(await service.listTasks()).toEqual([retryTask]);
    await expectPathMissing(join(workspaceRoot, "tasks", "TASK-post-hook-delete", "snapshot.json"));
    expect((await stat(join(workspaceRoot, "tasks", retryTask.task_id, "snapshot.json"))).isFile()).toBe(
      true
    );
  });

  test("TaskCard snapshot writes reject schema-valid outer snapshot drift before caching", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskIds = ["TASK-post-hook-outer-drift", "TASK-post-hook-outer-retry"];
    let shouldDriftSnapshot = true;
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:40:06.000Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-post-hook-outer-extra",
      snapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldDriftSnapshot) {
            return;
          }
          shouldDriftSnapshot = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
            string,
            unknown
          >;
          snapshot.pending_pi_gates = ["GATE-hook-outer-drift"];
          await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
        }
      }
    });
    const input = {
      type: "engineering" as const,
      title: "Reject outer snapshot drift",
      question_or_goal: "Do not cache a task whose canonical outer snapshot fields changed.",
      inference_budget: { mode: "normal" as const },
      created_by: "pi"
    };

    const error = await captureTaskServiceError(() => service.createTask(input));
    const listAfterFailure = await service.listTasks();
    const retryTask = await service.createTask(input);

    expect(error.code).toBe("workspace_path_not_safe");
    expect(listAfterFailure).toEqual([]);
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-post-hook-outer-drift", "snapshot.json")
    );
    expect(retryTask.task_id).toBe("TASK-post-hook-outer-retry");
    expect(await service.listTasks()).toEqual([retryTask]);
  });

  test("TaskCard snapshot writes reject unknown nested task_card fields in producer bytes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskIds = ["TASK-post-hook-unknown-nested", "TASK-post-hook-unknown-retry"];
    let shouldAddUnknownField = true;
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:40:06.500Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-post-hook-unknown-extra",
      snapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldAddUnknownField) {
            return;
          }
          shouldAddUnknownField = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
            string,
            unknown
          >;
          const taskCard = snapshot.task_card as Record<string, unknown>;
          taskCard.unknown_nested_field = "must not be stripped before verification";
          await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
        }
      }
    });
    const input = {
      type: "engineering" as const,
      title: "Reject unknown nested producer bytes",
      question_or_goal: "Require the exact canonical TaskSnapshot bytes after producer hooks.",
      inference_budget: { mode: "normal" as const },
      created_by: "pi"
    };

    const error = await captureTaskServiceError(() => service.createTask(input));
    const listAfterFailure = await service.listTasks();
    const retryTask = await service.createTask(input);

    expect(error.code).toBe("workspace_path_not_safe");
    expect(listAfterFailure).toEqual([]);
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-post-hook-unknown-nested", "snapshot.json")
    );
    expect(retryTask.task_id).toBe("TASK-post-hook-unknown-retry");
    expect(await service.listTasks()).toEqual([retryTask]);
  });

  test("TaskCard durable reads reject unknown fields and accept canonical data with reordered JSON", async () => {
    for (const location of ["top_level", "task_card"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const taskId = `TASK-durable-unknown-${location.replace("_", "-")}`;
      const task = await createTaskCardService({
        workspaceRoot,
        now: () => new Date("2026-07-07T13:40:06.750Z"),
        taskIdFactory: () => taskId
      }).createTask({
        type: "engineering",
        title: "Reject unknown durable snapshot fields",
        question_or_goal: "Treat the complete raw snapshot shape as durable authority.",
        inference_budget: { mode: "normal" },
        created_by: "pi"
      });
      const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
      const canonicalSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<
        string,
        unknown
      >;
      const unknownContent = `private-unknown-${location}`;
      const poisonedSnapshot = structuredClone(canonicalSnapshot);
      if (location === "top_level") {
        poisonedSnapshot.unknown_top_level = unknownContent;
      } else {
        (poisonedSnapshot.task_card as Record<string, unknown>).unknown_nested = unknownContent;
      }
      await writeFile(snapshotPath, `${JSON.stringify(poisonedSnapshot)}\n`);
      const reader = createTaskCardService({ workspaceRoot });

      const listError = await captureTaskServiceError(() => reader.listTasks());
      const detailError = await captureTaskServiceError(() => reader.getTaskFromSnapshot(taskId));

      expect(listError.code).toBe("task_snapshot_malformed");
      expect(detailError.code).toBe("task_snapshot_malformed");
      expectErrorNotToLeakRecordContent(listError, unknownContent);
      expectErrorNotToLeakRecordContent(detailError, unknownContent);

      const reorderedSnapshot = Object.fromEntries(
        Object.entries(canonicalSnapshot).reverse()
      );
      await writeFile(snapshotPath, `${JSON.stringify(reorderedSnapshot, null, 2)}\n`);

      expect(await reader.listTasks()).toEqual([task]);
      expect(await reader.getTaskFromSnapshot(taskId)).toEqual(task);
    }
  });

  test("TaskCard failed durable reads evict only the requested cached task", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskIds = ["TASK-cache-evict-target", "TASK-cache-evict-sibling"];
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:40:06.875Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-cache-evict-unexpected"
    });
    const targetTask = await service.createTask({
      type: "engineering",
      title: "Evict invalid durable target",
      question_or_goal: "Remove only the cache entry whose durable authority failed.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });
    const siblingTask = await service.createTask({
      type: "engineering",
      title: "Preserve valid cached sibling",
      question_or_goal: "Keep unrelated valid TaskCards available after a durable read failure.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });
    const snapshotPath = join(workspaceRoot, "tasks", targetTask.task_id, "snapshot.json");
    const canonicalSnapshotText = await readFile(snapshotPath, "utf8");
    const poisonedSnapshot = JSON.parse(canonicalSnapshotText) as Record<string, unknown>;
    poisonedSnapshot.unknown_cached_authority = "must remain on disk until external repair";
    const poisonedSnapshotText = `${JSON.stringify(poisonedSnapshot)}\n`;
    await writeFile(snapshotPath, poisonedSnapshotText);

    const durableError = await captureTaskServiceError(() =>
      service.getTaskFromSnapshot(targetTask.task_id)
    );
    const targetDetailError = await captureTaskServiceError(() =>
      service.getTask(targetTask.task_id)
    );

    expect(durableError.code).toBe("task_snapshot_malformed");
    expect(targetDetailError.code).toBe("task_not_found");
    expect(await service.listTasks()).toEqual([siblingTask]);
    expect(await service.getTask(siblingTask.task_id)).toEqual(siblingTask);
    expect(await readFile(snapshotPath, "utf8")).toBe(poisonedSnapshotText);

    await writeFile(snapshotPath, canonicalSnapshotText);
    expect(await service.getTaskFromSnapshot(targetTask.task_id)).toEqual(targetTask);
    expect(await service.listTasks()).toEqual([siblingTask, targetTask]);
  });

  test("TaskCard snapshot writes quarantine directory leaf replacements before hydration", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskIds = ["TASK-post-hook-directory", "TASK-post-hook-directory-retry"];
    let shouldReplaceSnapshot = true;
    const service = createTaskCardService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:40:07.000Z"),
      taskIdFactory: () => taskIds.shift() ?? "TASK-unexpected-post-hook-directory-extra",
      snapshotWriteHooks: {
        afterSnapshotWrite: async ({ taskDirectory }) => {
          if (!shouldReplaceSnapshot) {
            return;
          }
          shouldReplaceSnapshot = false;
          const snapshotPath = join(taskDirectory, "snapshot.json");
          await rm(snapshotPath);
          await mkdir(snapshotPath);
          await writeFile(join(snapshotPath, "nested.txt"), "untrusted replacement");
        }
      }
    });
    const input = {
      type: "engineering" as const,
      title: "Reject directory snapshot replacement",
      question_or_goal: "Keep hydration usable after a hook replaces the snapshot leaf.",
      inference_budget: { mode: "normal" as const },
      created_by: "pi"
    };

    const error = await captureTaskServiceError(() => service.createTask(input));
    const listAfterFailure = await service.listTasks();
    const freshService = createTaskCardService({ workspaceRoot });
    const freshListAfterFailure = await freshService.listTasks();
    const retryTask = await service.createTask(input);

    expect(error.code).toBe("workspace_path_not_safe");
    expect(listAfterFailure).toEqual([]);
    expect(freshListAfterFailure).toEqual([]);
    await expectPathMissing(
      join(workspaceRoot, "tasks", "TASK-post-hook-directory", "snapshot.json")
    );
    expect(retryTask.task_id).toBe("TASK-post-hook-directory-retry");
    expect(await service.listTasks()).toEqual([retryTask]);
  });

  test("Artifact registry normalizes artifact paths in stored manifests", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const artifact = {
      ...validArtifact(),
      path: "artifacts/reports/./TASK-0001/report.md"
    };
    const expectedArtifact = {
      ...artifact,
      path: "artifacts/reports/TASK-0001/report.md"
    };
    const manifestPath = join(
      workspaceRoot,
      "artifacts",
      "manifests",
      `${artifact.artifact_id}.json`
    );

    await expect(service.registerArtifact(artifact)).resolves.toEqual(expectedArtifact);
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(expectedArtifact);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(expectedArtifact);
  });

  test("Artifact registry preserves trailing-space artifact path identity", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const artifact = {
      ...validArtifact(),
      path: "artifacts/reports/TASK-0001/report.md "
    };
    const manifestPath = join(
      workspaceRoot,
      "artifacts",
      "manifests",
      `${artifact.artifact_id}.json`
    );

    await expect(service.registerArtifact(artifact)).resolves.toEqual(artifact);
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(artifact);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(artifact);
  });

  test("Artifact registry treats legacy dot-segment manifests as equivalent duplicates", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const artifact = validArtifact();
    const legacyArtifact = {
      ...artifact,
      path: "artifacts/reports/./TASK-0001/report.md"
    };
    const manifestPath = join(
      workspaceRoot,
      "artifacts",
      "manifests",
      `${artifact.artifact_id}.json`
    );
    const legacyManifestText = `${JSON.stringify(legacyArtifact)}\n`;
    await mkdir(join(workspaceRoot, "artifacts", "manifests"), { recursive: true });
    await writeFile(manifestPath, legacyManifestText, { flag: "wx" });

    await expect(service.registerArtifact(artifact)).resolves.toEqual(legacyArtifact);
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(legacyArtifact);
    expect(await readFile(manifestPath, "utf8")).toBe(legacyManifestText);
  });

  test("Artifact registry rejects symlink escapes before writing manifests", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const outsideRoot = join(tempRoot, "outside-artifacts");
    await mkdir(join(workspaceRoot, "artifacts"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, join(workspaceRoot, "artifacts", "reports"), "dir");

    const error = await captureTaskServiceError(() =>
      service.registerArtifact({
        ...validArtifact(),
        path: "artifacts/reports/TASK-0001/report.md"
      })
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(error.evidenceRefs).toEqual(["artifact.path"]);
    await expectPathMissing(join(workspaceRoot, "artifacts", "manifests"));
    await expectPathMissing(join(outsideRoot, "TASK-0001", "report.md"));
  });

  test("Artifact registry register/get persists metadata under manifests only", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const artifact = validArtifact();

    await expect(service.registerArtifact(artifact)).resolves.toEqual(artifact);
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(artifact);
    expect(
      (await stat(join(workspaceRoot, "artifacts", "manifests", `${artifact.artifact_id}.json`))).isFile()
    ).toBe(true);
    await expectPathMissing(join(workspaceRoot, artifact.path));

    await writeFile(join(workspaceRoot, "artifacts", "manifests", "ART-bad-sibling.json"), "{", {
      flag: "wx"
    });
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(artifact);
  });

  test("Artifact registry rejects invalid type, id, and path without manifest files", async () => {
    const invalidType = await createTempWorkspacePath();
    tempRoots.push(invalidType.tempRoot);
    const typeService = createArtifactRegistryService({ workspaceRoot: invalidType.workspaceRoot });
    const typeError = await captureTaskServiceError(() =>
      typeService.registerArtifact({
        ...validArtifact(),
        type: "unsupported"
      } as unknown as Artifact)
    );

    expect(typeError.code).toBe("record_schema_error");
    await expectPathMissing(join(invalidType.workspaceRoot, "artifacts"));

    const invalidId = await createTempWorkspacePath();
    tempRoots.push(invalidId.tempRoot);
    const idService = createArtifactRegistryService({ workspaceRoot: invalidId.workspaceRoot });
    const idError = await captureTaskServiceError(() =>
      idService.registerArtifact({
        ...validArtifact(),
        artifact_id: "../ART-unsafe"
      })
    );

    expect(idError.code).toBe("record_id_not_safe");
    await expectPathMissing(join(invalidId.workspaceRoot, "artifacts"));

    const invalidPath = await createTempWorkspacePath();
    tempRoots.push(invalidPath.tempRoot);
    const pathService = createArtifactRegistryService({ workspaceRoot: invalidPath.workspaceRoot });
    const pathError = await captureTaskServiceError(() =>
      pathService.registerArtifact({
        ...validArtifact(),
        path: "../outside/report.md"
      })
    );

    expect(pathError.code).toBe("record_id_not_safe");
    await expectPathMissing(join(invalidPath.workspaceRoot, "artifacts"));

    const interiorTraversal = await createTempWorkspacePath();
    tempRoots.push(interiorTraversal.tempRoot);
    const interiorPathService = createArtifactRegistryService({
      workspaceRoot: interiorTraversal.workspaceRoot
    });
    const interiorPathError = await captureTaskServiceError(() =>
      interiorPathService.registerArtifact({
        ...validArtifact(),
        path: "artifacts/reports/TASK-0001/../report.md"
      })
    );

    expect(interiorPathError.code).toBe("record_id_not_safe");
    await expectPathMissing(join(interiorTraversal.workspaceRoot, "artifacts"));
  });

  test("LockRecord and Artifact lookups fail closed on stored identity mismatch", async () => {
    const lockCase = await createTempWorkspacePath();
    tempRoots.push(lockCase.tempRoot);
    const lockService = createLockRecordService({ workspaceRoot: lockCase.workspaceRoot });
    const lookupLock = validLockRecord();
    const storedLock = {
      ...lookupLock,
      lock_id: "LOCK-secret-foreign",
      scope: "job"
    } satisfies LockRecord;
    const lockPath = join(
      lockCase.workspaceRoot,
      "locks",
      "task",
      `${lookupLock.lock_id}.json`
    );
    await mkdir(join(lockCase.workspaceRoot, "locks", "task"), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify(storedLock)}\n`, { flag: "wx" });

    const lockError = await captureTaskServiceError(() =>
      lockService.getLock("task", lookupLock.lock_id)
    );

    expect(lockError.code).toBe("record_malformed");
    expect(lockError.category).toBe("workspace_error");
    expect(lockError.evidenceRefs).toEqual([
      "workspace/locks/task/LOCK-0001.json",
      "lock.scope",
      "lock.lock_id"
    ]);
    expectErrorNotToLeakRecordContent(lockError, storedLock.lock_id);
    expect(await readFile(lockPath, "utf8")).toBe(`${JSON.stringify(storedLock)}\n`);

    const artifactCase = await createTempWorkspacePath();
    tempRoots.push(artifactCase.tempRoot);
    const artifactService = createArtifactRegistryService({
      workspaceRoot: artifactCase.workspaceRoot
    });
    const lookupArtifact = validArtifact();
    const storedArtifact = {
      ...lookupArtifact,
      artifact_id: "ART-secret-foreign"
    } satisfies Artifact;
    const artifactPath = join(
      artifactCase.workspaceRoot,
      "artifacts",
      "manifests",
      `${lookupArtifact.artifact_id}.json`
    );
    await mkdir(join(artifactCase.workspaceRoot, "artifacts", "manifests"), {
      recursive: true
    });
    await writeFile(artifactPath, `${JSON.stringify(storedArtifact)}\n`, { flag: "wx" });

    const artifactError = await captureTaskServiceError(() =>
      artifactService.getArtifact(lookupArtifact.artifact_id)
    );

    expect(artifactError.code).toBe("record_malformed");
    expect(artifactError.category).toBe("workspace_error");
    expect(artifactError.evidenceRefs).toEqual([
      "workspace/artifacts/manifests/ART-0001.json",
      "artifact.artifact_id"
    ]);
    expectErrorNotToLeakRecordContent(artifactError, storedArtifact.artifact_id);
    expect(await readFile(artifactPath, "utf8")).toBe(`${JSON.stringify(storedArtifact)}\n`);
  });

  test("Artifact registry rejects divergent duplicate manifests and preserves the first", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createArtifactRegistryService({ workspaceRoot });
    const artifact = validArtifact();
    const manifestPath = join(
      workspaceRoot,
      "artifacts",
      "manifests",
      `${artifact.artifact_id}.json`
    );

    await expect(service.registerArtifact(artifact)).resolves.toEqual(artifact);
    await expect(service.registerArtifact({ ...artifact })).resolves.toEqual(artifact);
    const divergentError = await captureTaskServiceError(() =>
      service.registerArtifact({
        ...artifact,
        media_type: "application/json"
      })
    );

    expect(divergentError.code).toBe("record_schema_error");
    expect(divergentError.category).toBe("schema_error");
    expect(await service.getArtifact(artifact.artifact_id)).toEqual(artifact);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(artifact);
  });
});

function holdFailedLookupUntilBothRetryServicesObserveIt(
  service: IdempotencyRecordService,
  onFailedObserved: () => void,
  bothRetryServicesObservedFailed: Promise<void>
): void {
  const originalLookupReplay = service.lookupReplay;
  let hasHeldFailedLookup = false;
  service.lookupReplay = async (input) => {
    const result = await originalLookupReplay(input);
    if (
      !hasHeldFailedLookup &&
      result.status === "incomplete" &&
      result.record.status === "failed"
    ) {
      hasHeldFailedLookup = true;
      onFailedObserved();
      await bothRetryServicesObservedFailed;
    }

    return result;
  };
}

function holdStartedLookupUntilBothCompleteServicesObserveIt(
  service: IdempotencyRecordService,
  onStartedObserved: () => void,
  bothCompleteServicesObservedStarted: Promise<void>
): void {
  const originalLookupReplay = service.lookupReplay;
  let hasHeldStartedLookup = false;
  service.lookupReplay = async (input) => {
    const result = await originalLookupReplay(input);
    if (
      !hasHeldStartedLookup &&
      result.status === "incomplete" &&
      result.record.status === "started"
    ) {
      hasHeldStartedLookup = true;
      onStartedObserved();
      await bothCompleteServicesObservedStarted;
    }

    return result;
  };
}

async function createTempWorkspacePath(): Promise<{ tempRoot: string; workspaceRoot: string }> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-core-services-")));
  return {
    tempRoot,
    workspaceRoot: join(tempRoot, "workspace")
  };
}

async function captureTaskServiceError(action: () => Promise<unknown>): Promise<TaskServiceError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(TaskServiceError);
    return error as TaskServiceError;
  }

  throw new Error("Expected TaskServiceError.");
}

async function captureWorkspacePathSafetyError(
  action: () => Promise<unknown>
): Promise<WorkspacePathSafetyError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspacePathSafetyError);
    return error as WorkspacePathSafetyError;
  }

  throw new Error("Expected WorkspacePathSafetyError.");
}

function expectErrorNotToLeakRecordContent(error: TaskServiceError, content: string): void {
  const cause = (error as Error & { cause?: unknown }).cause;
  const exposedError = JSON.stringify({
    message: error.message,
    userMessage: error.userMessage,
    evidenceRefs: error.evidenceRefs,
    recommendedNextActions: error.recommendedNextActions,
    causeMessage: cause instanceof Error ? cause.message : cause
  });
  expect(exposedError).not.toContain(content);
}

async function expectPathMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }

  throw new Error(`Expected path to be missing: ${path}`);
}

function idempotencyTransitionCleanupLockPath(workspaceRoot: string, key: string): string {
  return join(
    workspaceRoot,
    "tasks",
    "_idempotency",
    "task",
    `${sha256Hex(`transition-cleanup:${key}`)}.guard-cleanup`
  );
}

async function timeoutAfter(milliseconds: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  throw new Error(message);
}

function validIdempotencyRecord(): IdempotencyRecord {
  return {
    key: "task:create:1",
    scope: "task",
    request_digest: "digest",
    status: "completed",
    result_ref: "TASK-0001",
    created_at: "2026-07-07T13:00:00.000Z",
    updated_at: "2026-07-07T13:00:00.000Z"
  };
}

function validLockRecord(): LockRecord {
  return {
    lock_id: "LOCK-0001",
    scope: "task",
    target_id: "TASK-0001",
    holder: "worker-1",
    acquired_at: "2026-07-07T13:00:00.000Z",
    expires_at: "2026-07-07T13:01:00.000Z",
    status: "held",
    reason: "task snapshot write"
  };
}

function validArtifact(): Artifact {
  return {
    artifact_id: "ART-0001",
    task_id: "TASK-0001",
    type: "report_markdown",
    path: "artifacts/reports/TASK-0001/report.md",
    media_type: "text/markdown",
    created_at: "2026-07-07T13:00:00.000Z",
    created_by: "agent",
    evidence_usable: false,
    retention_class: "debug",
    source_refs: [],
    redaction_status: "not_needed"
  };
}
