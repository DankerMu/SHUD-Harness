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
  createLockRecordService,
  idempotencyRecordEvidenceRef,
  idempotencyRecordFileName,
  type Artifact,
  type IdempotencyRecord,
  type IdempotencyRecordService,
  type LockRecord
} from "./index";
import { MAX_SERVICE_RECORD_BYTES } from "./workspace-record-store";

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

    const sameRecord = await service.storeRecord({
      ...completedRecord,
      updated_at: "2026-07-07T13:31:00.000Z"
    });
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
    expect(sameRecord).toEqual(completedRecord);
    expect(overwriteError.code).toBe("record_schema_error");
    expect(overwriteError.category).toBe("schema_error");
    expect(completedAgain).toEqual(completedRecord);
    expect(await service.getRecord("task", rawKey)).toEqual(completedRecord);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(completedRecord);
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
