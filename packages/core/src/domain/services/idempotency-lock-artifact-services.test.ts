import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LockRecordSchema } from "../schemas/lock";
import {
  TaskServiceError,
  createArtifactRegistryService,
  createIdempotencyRecordService,
  createTaskCardService,
  createLockRecordService,
  idempotencyRecordEvidenceRef,
  idempotencyRecordFileName,
  lockRecordDirectorySegments,
  lockRecordEvidenceRef,
  lockRecordFileName,
  sha256Hex,
  assertPathInsideWorkspace,
  resolveWorkspacePath,
  type Artifact,
  type IdempotencyRecord,
  type IdempotencyRecordService,
  type LockRecord,
  WorkspacePathSafetyError
} from "./index";
import {
  MAX_SERVICE_RECORD_BYTES,
  conditionalDeleteJsonRecord,
  conditionalDeleteJsonRecordWithCleanupPermit,
  createJsonRecordIfAbsent,
  createJsonRecordIfAbsentWithCleanupPermit,
  readJsonRecord,
  runWithWorkspaceRecordPublicationHooks,
  WorkspaceRecordConditionalDeleteError,
  workspaceRecordPath,
  writeJsonRecord,
  type WorkspaceRecordPublicationHookInput,
  type WorkspaceRecordPublicationHooks,
  type WorkspaceRecordCleanupPermit
} from "./workspace-record-store";

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

    await writeFile(join(idempotencyDirectory, `${"0".repeat(64)}.json`), "{", {
      flag: "wx"
    });
    expect(await service.getRecord("task", rawKey)).toEqual(record);
  });

  test("IdempotencyRecord follower converges across the owned hardlink publication window", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:publication-window";
    const requestDigest = "digest-publication-window";
    const ownerService = createIdempotencyRecordService({ workspaceRoot });
    const followerService = createIdempotencyRecordService({ workspaceRoot });
    const hold = createRecordPublicationHold(1);
    const owner = runWithWorkspaceRecordPublicationHooks(hold.hooks, () =>
      ownerService.beginRecord({ scope: "task", key, requestDigest })
    );
    const publication = await hold.waitUntilLinked();

    expect((await stat(publication.canonicalPath)).nlink).toBe(2);
    expect((await stat(publication.temporaryPath)).nlink).toBe(2);

    let resolveReaderContended!: () => void;
    const readerContended = new Promise<void>((resolvePromise) => {
      resolveReaderContended = resolvePromise;
    });
    let readerLeaseNlink: number | undefined;
    const replay = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("read");
          readerLeaseNlink = (await stat(publication.canonicalPath)).nlink;
        },
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("read");
          resolveReaderContended();
        }
      },
      () => followerService.lookupReplay({ scope: "task", key, requestDigest })
    );
    await readerContended;
    let replaySettled = false;
    void replay.finally(() => {
      replaySettled = true;
    });
    await Promise.resolve();
    expect(replaySettled).toBe(false);
    const follower = followerService.beginRecord({
      scope: "task",
      key,
      requestDigest
    });
    hold.release();
    const [ownerResult, replayResult, followerResult] = await Promise.all([
      owner,
      replay,
      follower
    ]);
    const recordPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      idempotencyRecordFileName(key)
    );

    expect(ownerResult.status).toBe("acquired");
    expect(replayResult).toEqual({
      status: "incomplete",
      record: ownerResult.record
    });
    expect(followerResult).toEqual({
      status: "incomplete",
      record: ownerResult.record
    });
    expect(readerLeaseNlink).toBe(1);
    expect((await stat(recordPath)).nlink).toBe(1);
    await expectPathMissing(publication.temporaryPath);
  });

  test("same-path reader lease returns stable pre-write authority before rename writer publishes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const readerService = createLockRecordService({ workspaceRoot });
    const writerService = createLockRecordService({ workspaceRoot });
    const before = validLockRecord();
    const after = { ...before, holder: "coordinator-renamed" };
    await readerService.storeLock(before);
    const readerHold = createAsyncGate();
    let resolveReaderAcquired!: () => void;
    const readerAcquired = new Promise<void>((resolvePromise) => {
      resolveReaderAcquired = resolvePromise;
    });
    const reader = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("read");
          resolveReaderAcquired();
          await readerHold.wait;
        }
      },
      () => readerService.getLock(before.scope, before.lock_id)
    );
    await readerAcquired;
    let resolveWriterContended!: () => void;
    const writerContended = new Promise<void>((resolvePromise) => {
      resolveWriterContended = resolvePromise;
    });
    const writer = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("rename");
          resolveWriterContended();
        }
      },
      () => writerService.storeLock(after)
    );
    await writerContended;
    readerHold.open();

    expect(await reader).toEqual(before);
    expect(await writer).toEqual(after);
    expect(await readerService.getLock(before.scope, before.lock_id)).toEqual(after);
  });

  test("rename writer excludes same-path reader until atomic publication completes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const before = validLockRecord();
    const after = { ...before, holder: "worker-after-rename" };
    await service.storeLock(before);
    const writerHold = createAsyncGate();
    let resolveWriterAcquired!: () => void;
    const writerAcquired = new Promise<void>((resolvePromise) => {
      resolveWriterAcquired = resolvePromise;
    });
    const writer = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("rename");
          resolveWriterAcquired();
          await writerHold.wait;
        }
      },
      () => service.storeLock(after)
    );
    await writerAcquired;
    let resolveReaderContended!: () => void;
    const readerContended = new Promise<void>((resolvePromise) => {
      resolveReaderContended = resolvePromise;
    });
    const reader = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("read");
          resolveReaderContended();
        }
      },
      () => service.getLock(after.scope, after.lock_id)
    );
    await readerContended;
    writerHold.open();

    expect(await writer).toEqual(after);
    expect(await reader).toEqual(after);
  });

  test("rename writer rejects schema-valid and malformed temp generation replacement without clobbering canonical", async () => {
    for (const replacementKind of ["schema-valid", "malformed"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const before = {
        ...validLockRecord(),
        lock_id: `LOCK-rename-generation-${replacementKind}`
      };
      const intended = { ...before, holder: "intended-open-handle-generation" };
      const replacementBytes =
        replacementKind === "schema-valid"
          ? Buffer.from(`${JSON.stringify({ ...before, holder: "replacement-generation" }, null, 2)}\n`)
          : Buffer.from("{ malformed replacement\n");
      await service.storeLock(before);
      let temporaryPath = "";

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: async (publication) => {
              temporaryPath = publication.temporaryPath;
              const replacementPath = `${temporaryPath}.replacement`;
              await writeFile(replacementPath, replacementBytes, { flag: "wx" });
              await rename(replacementPath, temporaryPath);
            }
          },
          () => service.storeLock(intended)
        )
      );

      expect(error.code).toBe("workspace_path_not_safe");
      expect(await service.getLock(before.scope, before.lock_id)).toEqual(before);
      expect(await readFile(temporaryPath)).toEqual(replacementBytes);
    }
  });

  test("mutable publication ordinary failures preserve one exact canonical generation without owned residue", async () => {
    for (const boundary of ["lease", "temporary", "publication"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const before = { ...validLockRecord(), lock_id: `LOCK-mutable-${boundary}` };
      const after = { ...before, holder: `after-${boundary}` };
      await service.storeLock(before);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(before.scope), lockRecordFileName(before.lock_id)],
        lockRecordEvidenceRef(before.scope, before.lock_id)
      );
      const beforeBytes = await readFile(recordPath);

      await expect(
        runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: ({ operation }) => {
              if (boundary === "lease" && operation === "rename") throw new Error("lease fault");
            },
            afterTemporaryFileWritten: () => {
              if (boundary === "temporary") throw new Error("temporary fault");
            },
            beforeGenerationIsolation: ({ operation }) => {
              if (boundary === "publication" && operation === "rename_publication") {
                throw new Error("publication fault");
              }
            }
          },
          () => service.storeLock(after)
        )
      ).rejects.toBeDefined();

      expect(await readFile(recordPath)).toEqual(beforeBytes);
      expect((await stat(recordPath)).nlink).toBe(1);
      expect((await readdir(join(workspaceRoot, "locks", "task"))).some(isOwnedRecordPath)).toBe(
        false
      );
    }
  });

  test("mutable publication uses one final atomic rename and leaves no private namespace", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const before = { ...validLockRecord(), lock_id: "LOCK-mutable-atomic" };
    const after = { ...before, holder: "atomic-after" };
    await service.storeLock(before);
    let namespaceObserved = false;
    await runWithWorkspaceRecordPublicationHooks(
      {
        beforeGenerationIsolation: async ({ path, operation }) => {
          if (operation !== "rename_publication") return;
          namespaceObserved = (await readdir(join(path, ".."))).some((name) =>
            name.endsWith(".authority")
          );
        }
      },
      () => service.storeLock(after)
    );
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
      lockRecordEvidenceRef(after.scope, after.lock_id)
    );
    expect(namespaceObserved).toBe(false);
    expect(await service.getLock(after.scope, after.lock_id)).toEqual(after);
    expect((await stat(recordPath)).nlink).toBe(1);
  });

  test("Artifact duplicate registration converges across the owned publication window", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const artifact = validArtifact();
    const ownerService = createArtifactRegistryService({ workspaceRoot });
    const followerService = createArtifactRegistryService({ workspaceRoot });
    const hold = createRecordPublicationHold(1);
    const owner = runWithWorkspaceRecordPublicationHooks(hold.hooks, () =>
      ownerService.registerArtifact(artifact)
    );
    const publication = await hold.waitUntilLinked();

    expect((await stat(publication.canonicalPath)).nlink).toBe(2);
    const follower = followerService.registerArtifact({ ...artifact });
    hold.release();
    const [ownerArtifact, followerArtifact] = await Promise.all([owner, follower]);
    const replayedArtifact = await ownerService.registerArtifact({
      ...artifact
    });

    expect(ownerArtifact).toEqual(artifact);
    expect(followerArtifact).toEqual(artifact);
    expect(replayedArtifact).toEqual(artifact);
    expect((await stat(publication.canonicalPath)).nlink).toBe(1);
    await expectPathMissing(publication.temporaryPath);
  });

  test("physical authority identity converges across filesystem case aliases and isolates workspaces", async () => {
    const aliasWorkspace = await createCaseAliasWorkspacePath();
    if (!aliasWorkspace) {
      return;
    }
    const { tempRoot, workspaceRoot, aliasRoot } = aliasWorkspace;
    tempRoots.push(tempRoot);

    const key = "task:create:case-alias-authority";
    const requestDigest = "digest-case-alias-authority";
    const writerService = createIdempotencyRecordService({ workspaceRoot });
    const aliasReaderService = createIdempotencyRecordService({
      workspaceRoot: aliasRoot
    });
    const hardlinkHold = createRecordPublicationHold(1);
    const writer = runWithWorkspaceRecordPublicationHooks(hardlinkHold.hooks, () =>
      writerService.beginRecord({ scope: "task", key, requestDigest })
    );
    await hardlinkHold.waitUntilLinked();
    const readerContention = createSignal();
    const aliasReader = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("read");
          readerContention.resolve();
        }
      },
      () => aliasReaderService.lookupReplay({ scope: "task", key, requestDigest })
    );
    await readerContention.promise;
    hardlinkHold.release();
    const [ownerResult, replayResult] = await Promise.all([writer, aliasReader]);
    expect(ownerResult.status).toBe("acquired");
    expect(replayResult.status).toBe("incomplete");

    const artifact = validArtifact();
    const artifactHold = createRecordPublicationHold(1);
    const artifactOwner = runWithWorkspaceRecordPublicationHooks(artifactHold.hooks, () =>
      createArtifactRegistryService({ workspaceRoot }).registerArtifact(artifact)
    );
    await artifactHold.waitUntilLinked();
    const artifactContention = createSignal();
    const artifactAlias = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("hardlink");
          artifactContention.resolve();
        }
      },
      () =>
        createArtifactRegistryService({
          workspaceRoot: aliasRoot
        }).registerArtifact(artifact)
    );
    await artifactContention.promise;
    artifactHold.release();
    expect(await Promise.all([artifactOwner, artifactAlias])).toEqual([artifact, artifact]);

    const lock = validLockRecord();
    const physicalLockService = createLockRecordService({ workspaceRoot });
    const aliasLockService = createLockRecordService({
      workspaceRoot: aliasRoot
    });
    await physicalLockService.storeLock(lock);
    const renameHold = createAsyncGate();
    const renameAcquired = createSignal();
    const renamed = { ...lock, holder: "case-alias-renamed" };
    const renameWriter = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("rename");
          renameAcquired.resolve();
          await renameHold.wait;
        }
      },
      () => physicalLockService.storeLock(renamed)
    );
    await renameAcquired.promise;
    const renameReaderContention = createSignal();
    const renameReader = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("read");
          renameReaderContention.resolve();
        }
      },
      () => aliasLockService.getLock(lock.scope, lock.lock_id)
    );
    await renameReaderContention.promise;
    renameHold.open();
    expect(await Promise.all([renameWriter, renameReader])).toEqual([renamed, renamed]);

    const otherWorkspaceRoot = join(tempRoot, "PhysicallyDistinctWorkspace");
    await mkdir(otherWorkspaceRoot);
    const isolationHold = createAsyncGate();
    const isolatedHolderAcquired = createSignal();
    const isolatedHolder = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async () => {
          isolatedHolderAcquired.resolve();
          await isolationHold.wait;
        }
      },
      () => physicalLockService.getLock("task", "LOCK-distinct-isolation")
    );
    await isolatedHolderAcquired.promise;
    const distinctAcquired = createSignal();
    const distinctRead = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: ({ operation }) => {
          expect(operation).toBe("read");
          distinctAcquired.resolve();
        },
        onAuthorityContention: () => {
          throw new Error("distinct physical workspaces must not contend");
        }
      },
      () =>
        createLockRecordService({ workspaceRoot: otherWorkspaceRoot }).getLock(
          "task",
          "LOCK-distinct-isolation"
        )
    );
    await Promise.race([
      distinctAcquired.promise,
      timeoutAfter(500, "distinct physical workspace authority was not isolated")
    ]);
    isolationHold.open();
    expect(await Promise.all([isolatedHolder, distinctRead])).toEqual([undefined, undefined]);
  });

  test("missing ASCII record leaf case aliases share authority before creation", async () => {
    const aliasWorkspace = await createCaseAliasWorkspacePath();
    if (!aliasWorkspace) return;
    const { tempRoot, workspaceRoot, aliasRoot } = aliasWorkspace;
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "case-missing-leaf" };
    const ownerHold = createAsyncGate();
    const ownerAcquired = createSignal();
    const aliasContended = createSignal();
    const owner = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("hardlink");
          ownerAcquired.resolve();
          await ownerHold.wait;
        }
      },
      () =>
        createJsonRecordIfAbsent(
          workspaceRoot,
          ["CaseRecords"],
          "MissingLeaf.JSON",
          record,
          "case-leaf.owner",
          schema
        )
    );
    await ownerAcquired.promise;
    const alias = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("hardlink");
          aliasContended.resolve();
        }
      },
      () =>
        createJsonRecordIfAbsent(
          aliasRoot,
          ["caserecords"],
          "missingleaf.json",
          record,
          "case-leaf.alias",
          schema
        )
    );
    try {
      await Promise.race([
        aliasContended.promise,
        timeoutAfter(500, "missing case-alias leaf did not share authority")
      ]);
    } finally {
      ownerHold.open();
    }
    const [ownerResult, aliasResult] = await Promise.all([owner, alias]);
    expect(ownerResult.status).toBe("created");
    expect(aliasResult.status).toBe("exists");
  });

  test("same-path authority admission is bounded before temp creation and hands off FIFO", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const record = { ...validLockRecord(), lock_id: "LOCK-same-path-capacity" };
    await service.storeLock(record);
    const directoryPath = join(workspaceRoot, "locks", "task");
    const beforeFiles = await readdir(directoryPath);
    const holder = createAuthorityReadHold(service, record.lock_id);
    const heldRead = holder.start();
    await holder.acquired;

    await expect(
      runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: () => {
            throw new Error("injected authority contention hook failure");
          }
        },
        () => service.getLock(record.scope, record.lock_id)
      )
    ).rejects.toThrow("injected authority contention hook failure");

    const acquisitionOrder: number[] = [];
    const queueOrder: number[] = [];
    let contentionCount = 0;
    let resolveCapMinusOne!: () => void;
    let resolveCap!: () => void;
    const capMinusOne = new Promise<void>((resolvePromise) => {
      resolveCapMinusOne = resolvePromise;
    });
    const cap = new Promise<void>((resolvePromise) => {
      resolveCap = resolvePromise;
    });
    const queued = Array.from({ length: 63 }, (_, index) =>
      runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: () => {
            queueOrder.push(index);
            contentionCount += 1;
            if (contentionCount === 62) resolveCapMinusOne();
            if (contentionCount === 63) resolveCap();
          },
          afterAuthorityLeaseAcquired: ({ operation }) => {
            expect(operation).toBe(["read", "rename", "hardlink"][index % 3]);
            acquisitionOrder.push(index);
          }
        },
        () => runMixedLockAuthorityOperation(workspaceRoot, record, index)
      )
    );
    await capMinusOne;
    expect(contentionCount).toBe(62);
    await cap;
    expect(contentionCount).toBe(63);

    const overflowActions = [
      () => service.getLock(record.scope, record.lock_id),
      () => service.storeLock({ ...record, holder: "over-cap-rename" }),
      () =>
        createJsonRecordIfAbsent(
          workspaceRoot,
          lockRecordDirectorySegments(record.scope),
          lockRecordFileName(record.lock_id),
          record,
          lockRecordEvidenceRef(record.scope, record.lock_id),
          LockRecordSchema
        )
    ];
    for (const action of overflowActions) {
      const overflow = await captureTaskServiceError(action);
      expect(overflow.status).toBe(409);
      expect(overflow.retryable).toBe(true);
      expect(overflow.message).toBe("Workspace record authority coordination is at capacity.");
    }
    expect(await readdir(directoryPath)).toEqual(beforeFiles);

    holder.release();
    await Promise.race([
      Promise.all([heldRead, ...queued]),
      timeoutAfter(2_000, "same-path FIFO authority handoff deadlocked")
    ]);
    expect(acquisitionOrder).toEqual(queueOrder);
    expect(await service.getLock(record.scope, record.lock_id)).toBeDefined();
  });

  test("oversized rename and hardlink records fail before authority admission or workspace mutation", async () => {
    const { tempRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const oversizedSchema = z.object({ payload: z.string() });
    const oversizedRecord = { payload: "x".repeat(MAX_SERVICE_RECORD_BYTES) };
    let authorityAdmissions = 0;

    for (const writer of ["rename", "hardlink"] as const) {
      const workspaceRoot = join(tempRoot, writer);
      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: () => {
              authorityAdmissions += 1;
            }
          },
          () =>
            writer === "rename"
              ? writeJsonRecord(
                  workspaceRoot,
                  ["records"],
                  "oversized.json",
                  oversizedRecord,
                  `oversized.${writer}`,
                  oversizedSchema
                )
              : createJsonRecordIfAbsent(
                  workspaceRoot,
                  ["records"],
                  "oversized.json",
                  oversizedRecord,
                  `oversized.${writer}`,
                  oversizedSchema
                )
        )
      );

      expect(error.code).toBe("record_schema_error");
      expect(error.message).toBe("Workspace record would exceed the M1 bounded size.");
      await expectPathMissing(workspaceRoot);
    }

    expect(authorityAdmissions).toBe(0);
  });

  test("conditional delete serializes readers and immediate recreation without transient read errors", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const record = { ...validLockRecord(), lock_id: "LOCK-conditional-delete" };
    await service.storeLock(record);
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...lockRecordDirectorySegments(record.scope), lockRecordFileName(record.lock_id)],
      lockRecordEvidenceRef(record.scope, record.lock_id)
    );
    const deleteHold = createAsyncGate();
    const deleteReady = createSignal();
    const deletion = runWithWorkspaceRecordPublicationHooks(
      {
        beforeConditionalDelete: async ({ path, conditionStatus }) => {
          expect(path).toBe(recordPath);
          expect(conditionStatus).toBe("matched");
          deleteReady.resolve();
          await deleteHold.wait;
        }
      },
      () =>
        conditionalDeleteJsonRecord(recordPath, "lock.conditional-delete", LockRecordSchema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.lock_id === expected.lock_id
        })
    );
    await deleteReady.promise;
    const order: string[] = [];
    const readerQueued = createSignal();
    const reader = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: () => {
          order.push("reader-queued");
          readerQueued.resolve();
        },
        afterAuthorityLeaseAcquired: () => order.push("reader-acquired")
      },
      () => service.getLock(record.scope, record.lock_id)
    );
    const recreateQueued = createSignal();
    const recreation = runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: () => {
          order.push("recreate-queued");
          recreateQueued.resolve();
        },
        afterAuthorityLeaseAcquired: () => order.push("recreate-acquired")
      },
      () =>
        createJsonRecordIfAbsent(
          workspaceRoot,
          lockRecordDirectorySegments(record.scope),
          lockRecordFileName(record.lock_id),
          record,
          lockRecordEvidenceRef(record.scope, record.lock_id),
          LockRecordSchema
        )
    );
    await Promise.all([readerQueued.promise, recreateQueued.promise]);
    deleteHold.open();
    const [deleted, readAfterDelete, recreated] = await Promise.race([
      Promise.all([deletion, reader, recreation]),
      timeoutAfter(1_500, "conditional delete/recreate authority deadlocked")
    ]);
    expect(deleted.status).toBe("deleted");
    expect(readAfterDelete).toBeUndefined();
    expect(recreated.status).toBe("created");
    expect(order).toEqual([
      "reader-queued",
      "recreate-queued",
      "reader-acquired",
      "recreate-acquired"
    ]);
    expect(await service.getLock(record.scope, record.lock_id)).toEqual(record);
  });

  test("conditional delete and restore cleanup preserve exact replacement generations at final mutation hooks", async () => {
    for (const phase of ["isolation", "restore_cleanup"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const original = {
        ...validLockRecord(),
        lock_id: `LOCK-delete-generation-${phase}`
      };
      const replacement = { ...original, holder: "replacement-before-isolation" };
      const finalReplacement = { ...original, holder: "replacement-during-restore-cleanup" };
      await service.storeLock(original);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(original.scope), lockRecordFileName(original.lock_id)],
        lockRecordEvidenceRef(original.scope, original.lock_id)
      );
      let replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            beforeGenerationIsolation: async ({ path, operation }) => {
              if (operation !== "conditional_delete") return;
              const candidate = `${path}.replacement`;
              await writeFile(candidate, replacementBytes, { flag: "wx" });
              await rename(candidate, path);
            },
            beforeAuthorityOwnedUnlink: async ({ path, operation }) => {
              if (phase !== "restore_cleanup" || operation !== "restore_cleanup") return;
              const candidate = `${path}.final-replacement`;
              await writeFile(candidate, `${JSON.stringify(finalReplacement, null, 2)}\n`, {
                flag: "wx"
              });
              await rename(candidate, path);
            }
          },
          () =>
            conditionalDeleteJsonRecord(recordPath, "lock.delete-generation", LockRecordSchema, {
              kind: "record",
              expected: original,
              matches: (current, expected) => current.lock_id === expected.lock_id
            })
        )
      );

      expect(error.code).toBe("record_malformed");
      if (phase === "isolation") {
        expect(await readFile(recordPath)).toEqual(replacementBytes);
      } else {
        expect(await service.getLock(original.scope, original.lock_id)).toEqual(finalReplacement);
        const directoryPath = join(workspaceRoot, "locks", original.scope);
        const authorityDirectory = (await readdir(directoryPath)).find((name) =>
          name.endsWith(".authority")
        );
        expect(authorityDirectory).toBeDefined();
        expect(await readFile(join(directoryPath, authorityDirectory!, "generation"))).toEqual(
          replacementBytes
        );
      }
    }
  });

  test("conditional delete preserves same-inode byte mutations for valid and malformed records", async () => {
    for (const kind of ["valid", "malformed"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const directoryPath = join(workspaceRoot, "same-inode-delete");
      await mkdir(directoryPath, { recursive: true });
      const path = join(directoryPath, `${kind}.json`);
      const original = { id: kind };
      const originalBytes =
        kind === "valid" ? Buffer.from(`${JSON.stringify(original)}\n`) : Buffer.from("{\n");
      const modifiedBytes = Buffer.from(`modified-${kind}\n`);
      await writeFile(path, originalBytes, { flag: "wx" });
      let inspectedNamespace = false;

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            beforeGenerationIsolation: async ({ operation }) => {
              if (operation !== "conditional_delete") return;
              const namespace = await findOnlyAuthorityNamespace(directoryPath);
              await expectPrivateAuthorityDirectory(namespace);
              inspectedNamespace = true;
            },
            beforeAuthorityOwnedUnlink: async ({ operation }) => {
              if (operation !== "conditional_delete") return;
              const namespace = await findOnlyAuthorityNamespace(directoryPath);
              await writeFile(join(namespace, "generation"), modifiedBytes);
            }
          },
          () =>
            conditionalDeleteJsonRecord(path, `same-inode.${kind}`, z.object({ id: z.string() }),
              kind === "valid"
                ? {
                    kind: "record",
                    expected: original,
                    matches: (current, expected) => current.id === expected.id
                  }
                : { kind: "malformed" }
            )
        )
      );

      expect(error.code).toBe("record_malformed");
      expect(inspectedNamespace).toBe(true);
      expect(await readFile(path)).toEqual(modifiedBytes);
      expect((await stat(path)).nlink).toBe(1);
      expect((await readdir(directoryPath)).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("hardlink temp cleanup preserves replacements introduced at the final unlink hook", async () => {
    for (const writer of ["hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = {
        ...validLockRecord(),
        lock_id: `LOCK-final-temp-cleanup-${writer}`
      };
      const intended = { ...record, holder: `intended-${writer}` };
      const replacementBytes = Buffer.from(`replacement-${writer}\n`);
      let temporaryPath = "";

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: ({ temporaryPath: observed }) => {
              temporaryPath = observed;
            },
            beforeAuthorityOwnedUnlink: async ({ path, operation }) => {
              const expectedOperation = "hardlink_temp_cleanup";
              if (operation !== expectedOperation) return;
              await writeFile(path, replacementBytes, { flag: "wx" });
            }
          },
          () =>
            createJsonRecordIfAbsent(
                  workspaceRoot,
                  lockRecordDirectorySegments(record.scope),
                  lockRecordFileName(record.lock_id),
                  intended,
                  lockRecordEvidenceRef(record.scope, record.lock_id),
                  LockRecordSchema
                )
        )
      );

      expect(error.code).toBe("record_malformed");
      expect(await readFile(temporaryPath)).toEqual(replacementBytes);
    }
  });

  test("recreated transition guard and cleanup-lock generations serialize queued strict readers", async () => {
    for (const targetPublication of [1, 2] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const key = `task:create:guard-generation-${targetPublication}`;
      const requestDigest = `digest-guard-generation-${targetPublication}`;
      const seedService = createIdempotencyRecordService({ workspaceRoot });
      await seedService.beginRecord({ scope: "task", key, requestDigest });
      const generationA = await seedService.failRecord({
        scope: "task",
        key,
        requestDigest
      });
      const transitionPath = idempotencyTransitionGuardPath(workspaceRoot, key);
      const cleanupPath = idempotencyTransitionCleanupLockPath(workspaceRoot, key);
      await expectPathMissing(transitionPath);
      await expectPathMissing(cleanupPath);

      const writerService = createIdempotencyRecordService({ workspaceRoot });
      const hold = createRecordPublicationHold(targetPublication);
      const writerB = runWithWorkspaceRecordPublicationHooks(hold.hooks, () =>
        writerService.beginRecord({ scope: "task", key, requestDigest })
      );
      const publication = await hold.waitUntilLinked();
      expect(publication.canonicalPath).toBe(
        targetPublication === 1 ? cleanupPath : transitionPath
      );
      expect((await stat(publication.canonicalPath)).nlink).toBe(2);
      let resolveReaderContended!: () => void;
      const readerContended = new Promise<void>((resolvePromise) => {
        resolveReaderContended = resolvePromise;
      });
      const queuedReader = runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("read");
            resolveReaderContended();
          }
        },
        () =>
          readJsonRecord(
            publication.canonicalPath,
            idempotencyRecordEvidenceRef("task", key),
            z.unknown()
          )
      );
      await readerContended;
      hold.release();
      const [writerResult, observedTransientRecord] = await Promise.race([
        Promise.all([writerB, queuedReader]),
        timeoutAfter(1_500, "recreated transition authority operations deadlocked")
      ]);

      expect(generationA.status).toBe("failed");
      expect(writerResult.status).toBe("acquired");
      expect(writerResult.record.status).toBe("started");
      expect(observedTransientRecord).toBeDefined();
      await expectPathMissing(publication.temporaryPath);
      await expectPathMissing(transitionPath);
      await expectPathMissing(cleanupPath);
      expect(await seedService.getRecord("task", key)).toEqual(writerResult.record);
    }
  });

  test("transition guard and cleanup-lock release serialize queued readers through deletion", async () => {
    for (const targetKind of ["cleanup", "guard"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const key = `task:create:delete-reader-${targetKind}`;
      const evidenceRef = idempotencyRecordEvidenceRef("task", key);
      const requestDigest = `digest-delete-reader-${targetKind}`;
      const seedService = createIdempotencyRecordService({ workspaceRoot });
      await seedService.beginRecord({ scope: "task", key, requestDigest });
      await seedService.failRecord({ scope: "task", key, requestDigest });
      const targetPath =
        targetKind === "cleanup"
          ? idempotencyTransitionCleanupLockPath(workspaceRoot, key)
          : idempotencyTransitionGuardPath(workspaceRoot, key);
      const deleteHold = createAsyncGate();
      const deleteReady = createSignal();
      let deleteAuthorityCount = 0;
      const begin = runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: async ({ operation }) => {
            if (operation !== "delete") return;
            deleteAuthorityCount += 1;
            const targetDelete = targetKind === "cleanup" ? 1 : 2;
            if (deleteAuthorityCount !== targetDelete) return;
            deleteReady.resolve();
            await deleteHold.wait;
          }
        },
        () =>
          createIdempotencyRecordService({ workspaceRoot }).beginRecord({
            scope: "task",
            key,
            requestDigest
          })
      );
      await Promise.race([
        deleteReady.promise,
        timeoutAfter(1_000, `${targetKind} conditional release was not reached`)
      ]);
      const readerContended = createSignal();
      const reader = runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("read");
            readerContended.resolve();
          }
        },
        () => readJsonRecord(targetPath, evidenceRef, z.unknown())
      );
      await readerContended.promise;
      deleteHold.open();
      const [beginResult, readResult] = await Promise.race([
        Promise.all([begin, reader]),
        timeoutAfter(1_500, `${targetKind} release and queued read deadlocked`)
      ]);
      expect(beginResult.status).toBe("acquired");
      expect(readResult).toBeUndefined();
      await expectPathMissing(targetPath);
    }
  });

  test("transition guard and cleanup-lock releases retain reserved authority at one holder plus 63 waiters", async () => {
    for (const targetKind of ["guard", "cleanup"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const key = `task:create:reserved-release-${targetKind}`;
      const requestDigest = `digest-reserved-release-${targetKind}`;
      const seedService = createIdempotencyRecordService({ workspaceRoot });
      await seedService.beginRecord({ scope: "task", key, requestDigest });
      if (targetKind === "cleanup") {
        await seedService.failRecord({ scope: "task", key, requestDigest });
      }
      const targetPath =
        targetKind === "guard"
          ? idempotencyTransitionGuardPath(workspaceRoot, key)
          : idempotencyTransitionCleanupLockPath(workspaceRoot, key);
      const transitionPause = createAsyncGate();
      const transitionReached = createSignal();
      const cleanupQueued = createSignal();
      let hardlinkAdmissions = 0;
      const transitionService = createIdempotencyRecordService({
        workspaceRoot
      });
      const transition = runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: async ({ operation }) => {
            if (targetKind === "guard" && operation === "rename") {
              transitionReached.resolve();
              await transitionPause.wait;
            }
            if (targetKind === "cleanup" && operation === "hardlink") {
              hardlinkAdmissions += 1;
              if (hardlinkAdmissions === 3) {
                transitionReached.resolve();
                await transitionPause.wait;
              }
            }
          },
          onAuthorityContention: ({ operation }) => {
            if (operation === "delete") cleanupQueued.resolve();
          }
        },
        () =>
          targetKind === "guard"
            ? transitionService.completeRecord({
                scope: "task",
                key,
                requestDigest,
                resultRef: `TASK-reserved-release-${targetKind}`
              })
            : transitionService.beginRecord({
                scope: "task",
                key,
                requestDigest
              })
      );
      await transitionReached.promise;

      const saturation = await saturateRecordAuthorityPath(
        targetPath,
        idempotencyRecordEvidenceRef("task", key)
      );
      try {
        const overflow = await captureTaskServiceError(() =>
          readJsonRecord(targetPath, idempotencyRecordEvidenceRef("task", key), z.unknown())
        );
        expect(overflow.message).toBe("Workspace record authority coordination is at capacity.");

        transitionPause.open();
        await Promise.race([
          cleanupQueued.promise,
          timeoutAfter(1_000, `${targetKind} reserved cleanup did not queue`)
        ]);
        saturation.release();
        const [transitionResult, queuedResults] = await Promise.race([
          Promise.all([transition, saturation.completed]),
          timeoutAfter(2_000, `${targetKind} reserved cleanup did not complete`)
        ]);

        expect(transitionResult.status).toBe(targetKind === "guard" ? "completed" : "acquired");
        expect(queuedResults).toEqual(Array.from({ length: 63 }, () => undefined));
        expect(saturation.acquisitionOrder).toEqual(saturation.queueOrder);
      } finally {
        transitionPause.open();
        saturation.release();
        await Promise.allSettled([transition, saturation.completed]);
      }
      await expectPathMissing(targetPath);
      await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
      await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
    }
  });

  test("cleanup permits cancel atomically on identity and contention hook failures", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });

    for (const failure of ["identity", "contention"] as const) {
      const record = { id: `permit-${failure}` };
      const fileName = `${record.id}.json`;
      const evidenceRef = `permit.${failure}`;
      const path = workspaceRecordPath(workspaceRoot, ["permit-tests", fileName], evidenceRef);
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-tests"],
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected a cleanup permit fixture.");

      let releaseHolder: (() => void) | undefined;
      let holder: Promise<unknown> | undefined;
      if (failure === "contention") {
        const gate = createAsyncGate();
        const acquired = createSignal();
        releaseHolder = gate.open;
        holder = runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: async () => {
              acquired.resolve();
              await gate.wait;
            }
          },
          () => readJsonRecord(path, evidenceRef, schema)
        );
        await acquired.promise;
      }

      const permitDirectory = join(workspaceRoot, "permit-tests");
      const originalDirectory = join(workspaceRoot, "permit-tests-original");
      const failedDelete = runWithWorkspaceRecordPublicationHooks(
        failure === "identity"
          ? {
              beforeCleanupPermitIdentityResolution: async () => {
                await rename(permitDirectory, originalDirectory);
                await symlink(originalDirectory, permitDirectory);
              }
            }
          : {
              onAuthorityContention: () => {
                throw new Error("injected cleanup permit contention failure");
              }
            },
        () =>
          conditionalDeleteJsonRecordWithCleanupPermit(
            created.cleanupPermit,
            path,
            evidenceRef,
            schema,
            {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            }
          )
      );
      if (failure === "identity") {
        const identityError = await captureConditionalDeleteError(() => failedDelete);
        expect(identityError.mutationPhase).toBe("pre_mutation");
        expect(identityError.failureStage).toBe("permit_admission");
        expect(identityError.cause).toBeInstanceOf(TaskServiceError);
        await rm(permitDirectory);
        await rename(originalDirectory, permitDirectory);
      } else {
        const contentionError = await captureConditionalDeleteError(() => failedDelete);
        expect(contentionError.mutationPhase).toBe("pre_mutation");
        expect(contentionError.failureStage).toBe("permit_admission");
        expect((contentionError.cause as Error).message).toBe(
          "injected cleanup permit contention failure"
        );
      }

      releaseHolder?.();
      await holder;
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("semantic release retries after a cleanup permit identity hook failure", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:permit-identity-retry";
    let identityFailures = 0;

    const seedService = createIdempotencyRecordService({ workspaceRoot });
    await seedService.beginRecord({
      scope: "task",
      key,
      requestDigest: "digest-permit-identity-retry"
    });
    const result = await runWithWorkspaceRecordPublicationHooks(
      {
        beforeCleanupPermitIdentityResolution: () => {
          identityFailures += 1;
          if (identityFailures === 1) {
            throw new Error("injected one-shot semantic identity failure");
          }
        }
      },
      () =>
        createIdempotencyRecordService({ workspaceRoot }).completeRecord({
          scope: "task",
          key,
          requestDigest: "digest-permit-identity-retry",
          resultRef: "TASK-permit-identity-retry"
        })
    );

    expect(result.status).toBe("completed");
    expect(identityFailures).toBeGreaterThanOrEqual(2);
    await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
    await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
  });

  test("parent cleanup-lock release failure compensates the child guard before ownership transfer", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:parent-release-compensation";
    const cleanupPath = idempotencyTransitionCleanupLockPath(workspaceRoot, key);
    let cleanupReleaseFailures = 0;
    await createIdempotencyRecordService({ workspaceRoot }).beginRecord({
      scope: "task",
      key,
      requestDigest: "digest-parent-release-compensation"
    });

    const error = await captureConditionalDeleteError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeConditionalDelete: ({ path }) => {
            if (path === cleanupPath && cleanupReleaseFailures < 2) {
              cleanupReleaseFailures += 1;
              throw new TaskServiceError({
                code: "record_malformed",
                status: 500,
                category: "workspace_error",
                message: "Injected parent cleanup-lock release failure.",
                userMessage: "Injected parent cleanup-lock release failure.",
                evidenceRefs: [idempotencyRecordEvidenceRef("task", key)],
                retryable: true,
                recommendedNextActions: ["Retry."]
              });
            }
          }
        },
        () =>
          createIdempotencyRecordService({ workspaceRoot }).completeRecord({
            scope: "task",
            key,
            requestDigest: "digest-parent-release-compensation",
            resultRef: "TASK-parent-release-compensation"
          })
      )
    );

    expect(error.mutationPhase).toBe("pre_mutation");
    expect(error.failureStage).toBe("operation");
    expect((error.cause as Error).message).toBe("Injected parent cleanup-lock release failure.");
    expect(cleanupReleaseFailures).toBe(1);
    await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
    expect(await readJsonRecord(cleanupPath, idempotencyRecordEvidenceRef("task", key), z.unknown()))
      .toBeDefined();
  });

  test("authority path capacity is bounded, retryable, and released after holders finish", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const releaseHolders = createAsyncGate();
    let acquiredCount = 0;
    let resolveCapMinusOne!: () => void;
    let resolveAllAcquired!: () => void;
    const capMinusOne = new Promise<void>((resolvePromise) => {
      resolveCapMinusOne = resolvePromise;
    });
    const allAcquired = new Promise<void>((resolvePromise) => {
      resolveAllAcquired = resolvePromise;
    });
    const startHolder = (index: number) =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: async ({ operation }) => {
            expect(operation).toBe("read");
            acquiredCount += 1;
            if (acquiredCount === 1023) {
              resolveCapMinusOne();
            }
            if (acquiredCount === 1024) {
              resolveAllAcquired();
            }
            await releaseHolders.wait;
          }
        },
        () => service.getLock("task", `LOCK-capacity-${index}`)
      );
    const holders = Array.from({ length: 1023 }, (_, index) => startHolder(index));

    await Promise.race([
      capMinusOne,
      timeoutAfter(2_000, "authority cap-1 holders did not acquire")
    ]);
    expect(acquiredCount).toBe(1023);
    holders.push(startHolder(1023));

    await Promise.race([
      allAcquired,
      timeoutAfter(2_000, "authority capacity holders did not acquire")
    ]);
    try {
      const capacityError = await captureTaskServiceError(() =>
        service.getLock("task", "LOCK-capacity-overflow")
      );
      expect(capacityError.code).toBe("record_malformed");
      expect(capacityError.status).toBe(409);
      expect(capacityError.retryable).toBe(true);
      expect(capacityError.message).toBe("Workspace record authority coordination is at capacity.");
      expectErrorNotToLeakRecordContent(capacityError, tempRoot);
    } finally {
      releaseHolders.open();
    }

    expect(await Promise.all(holders)).toEqual(Array.from({ length: 1024 }, () => undefined));
    expect(await service.getLock("task", "LOCK-capacity-overflow")).toBeUndefined();
  });

  test("cleanup permit global capacity reports the structured retryable authority error", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const created: Array<{
      path: string;
      evidenceRef: string;
      record: { id: string };
      permit: WorkspaceRecordCleanupPermit;
    }> = [];

    try {
      for (let index = 0; index < 1024; index += 1) {
        const record = { id: `permit-capacity-${index}` };
        const fileName = `${record.id}.json`;
        const evidenceRef = `permit.capacity.${index}`;
        const result = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["permit-capacity"],
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (result.status !== "created") throw new Error("Expected cleanup permit capacity fixture.");
        created.push({
          path: workspaceRecordPath(workspaceRoot, ["permit-capacity", fileName], evidenceRef),
          evidenceRef,
          record,
          permit: result.cleanupPermit
        });
      }

      const overflowEvidenceRef = "permit.capacity.overflow";
      const overflow = await captureTaskServiceError(() =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["permit-capacity"],
          "permit-capacity-overflow.json",
          { id: "permit-capacity-overflow" },
          overflowEvidenceRef,
          schema
        )
      );
      expect(overflow.code).toBe("record_malformed");
      expect(overflow.status).toBe(409);
      expect(overflow.retryable).toBe(true);
      expect(overflow.evidenceRefs).toEqual([overflowEvidenceRef]);
      expect(overflow.message).toBe("Workspace record authority coordination is at capacity.");
    } finally {
      await Promise.all(
        created.map(({ path, evidenceRef, record, permit }) =>
          conditionalDeleteJsonRecordWithCleanupPermit(
            permit,
            path,
            evidenceRef,
            schema,
            {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            }
          )
        )
      );
    }
  }, 20_000);

  test("guard and cleanup-lock semantic releases bypass global ordinary capacity", async () => {
    for (const targetKind of ["guard", "cleanup"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const key = `task:create:global-semantic-release-${targetKind}`;
      const requestDigest = `digest-global-semantic-release-${targetKind}`;
      const seedService = createIdempotencyRecordService({ workspaceRoot });
      await seedService.beginRecord({ scope: "task", key, requestDigest });
      if (targetKind === "cleanup") {
        await seedService.failRecord({ scope: "task", key, requestDigest });
      }
      const targetPath =
        targetKind === "guard"
          ? idempotencyTransitionGuardPath(workspaceRoot, key)
          : idempotencyTransitionCleanupLockPath(workspaceRoot, key);
      const allowSemanticRelease = createAsyncGate();
      const allowTransitionContinuation = createAsyncGate();
      const transitionReached = createSignal();
      const semanticReleased = createSignal();
      const transitionService = createIdempotencyRecordService({
        workspaceRoot,
        transitionGuardHooks:
          targetKind === "guard"
            ? {
                beforeTransitionGuardRelease: async () => {
                  transitionReached.resolve();
                  await allowSemanticRelease.wait;
                },
                afterTransitionGuardRelease: async () => {
                  semanticReleased.resolve();
                  await allowTransitionContinuation.wait;
                }
              }
            : {
                beforeCleanupLockRelease: async () => {
                  transitionReached.resolve();
                  await allowSemanticRelease.wait;
                },
                afterCleanupLockRelease: async () => {
                  semanticReleased.resolve();
                  await allowTransitionContinuation.wait;
                }
              }
      });
      const transition =
        targetKind === "guard"
          ? transitionService.completeRecord({
              scope: "task",
              key,
              requestDigest,
              resultRef: `TASK-global-semantic-release-${targetKind}`
            })
          : transitionService.beginRecord({ scope: "task", key, requestDigest });
      await transitionReached.promise;
      const saturation = await saturateGlobalRecordAuthority(
        workspaceRoot,
        `LOCK-global-semantic-${targetKind}`
      );
      try {
      const overflow = await captureTaskServiceError(() =>
        createLockRecordService({ workspaceRoot }).getLock(
          "task",
          `LOCK-global-semantic-${targetKind}-overflow`
        )
      );
      expect(overflow.message).toBe("Workspace record authority coordination is at capacity.");

      allowSemanticRelease.open();
      await Promise.race([
        semanticReleased.promise,
        timeoutAfter(2_000, `${targetKind} semantic release was blocked by global capacity`)
      ]);
      await expectPathMissing(targetPath);
      saturation.release();
      allowTransitionContinuation.open();
      const transitionResult = await transition;
      await saturation.completed;
      expect(transitionResult.status).toBe(targetKind === "guard" ? "completed" : "acquired");
      } finally {
        allowSemanticRelease.open();
        allowTransitionContinuation.open();
        saturation.release();
        await Promise.allSettled([transition, saturation.completed]);
      }
      await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
      await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
    }
  }, 15_000);

  test("authority acquisition keeps one total five-second deadline across queued holder churn", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const lockId = "LOCK-total-authority-deadline";
    const first = createAuthorityReadHold(service, lockId);
    const second = createAuthorityReadHold(service, lockId);
    const third = createAuthorityReadHold(service, lockId);

    const firstRead = first.start();
    await first.acquired;
    const secondRead = second.start();
    await second.contended;
    const thirdRead = third.start();
    await third.contended;

    let resolveTargetContended!: () => void;
    const targetContended = new Promise<void>((resolvePromise) => {
      resolveTargetContended = resolvePromise;
    });
    const startedAt = Date.now();
    const target = captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("read");
            resolveTargetContended();
          }
        },
        () => service.getLock("task", lockId)
      )
    );
    await targetContended;

    await delay(1_800);
    first.release();
    await second.acquired;
    await delay(1_800);
    second.release();
    await third.acquired;
    const deadlineError = await target;
    const elapsedMs = Date.now() - startedAt;
    third.release();
    await Promise.all([firstRead, secondRead, thirdRead]);

    expect(deadlineError.code).toBe("record_malformed");
    expect(deadlineError.status).toBe(409);
    expect(deadlineError.retryable).toBe(true);
    expect(deadlineError.message).toBe(
      "Workspace record authority lease was not acquired before the bounded deadline."
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(4_800);
    expect(elapsedMs).toBeLessThan(6_500);
    expectErrorNotToLeakRecordContent(deadlineError, tempRoot);
    expect(await service.getLock("task", lockId)).toBeUndefined();
  }, 10_000);

  test("transition guard authority admission shares one absolute 250ms deadline without late publication", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:guard-total-deadline";
    const requestDigest = "digest-guard-total-deadline";
    const service = createIdempotencyRecordService({ workspaceRoot });
    await service.beginRecord({ scope: "task", key, requestDigest });
    const guardPath = idempotencyTransitionGuardPath(workspaceRoot, key);
    const evidenceRef = idempotencyRecordEvidenceRef("task", key);
    const hold = createAsyncGate();
    const acquired = createSignal();
    const holder = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("read");
          acquired.resolve();
          await hold.wait;
        }
      },
      () => readJsonRecord(guardPath, evidenceRef, z.unknown())
    );
    await acquired.promise;

    const startedAt = Date.now();
    try {
      const error = await captureTaskServiceError(() =>
        service.completeRecord({
          scope: "task",
          key,
          requestDigest,
          resultRef: "TASK-guard-total-deadline"
        })
      );
      const elapsedMs = Date.now() - startedAt;
      expect(error.status).toBe(409);
      expect(error.retryable).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(200);
      expect(elapsedMs).toBeLessThan(1_000);
      await expectPathMissing(guardPath);
      await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
    } finally {
      hold.open();
      await holder;
    }

    await delay(300);
    await expectPathMissing(guardPath);
    const completed = await service.completeRecord({
      scope: "task",
      key,
      requestDigest,
      resultRef: "TASK-guard-total-deadline"
    });
    expect(completed.status).toBe("completed");
  });

  test("transition mutation errors remain primary when semantic release also fails", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:primary-transition-error";
    const requestDigest = "digest-primary-transition-error";
    const service = createIdempotencyRecordService({
      workspaceRoot,
      transitionGuardHooks: {
        beforeTransitionGuardRelease: () => {
          throw new Error("injected release compensation failure");
        }
      }
    });
    await service.beginRecord({ scope: "task", key, requestDigest });
    const originalLookup = service.lookupReplay;
    let lookupCount = 0;
    service.lookupReplay = async (input) => {
      const result = await originalLookup(input);
      lookupCount += 1;
      if (lookupCount === 2 && result.status === "incomplete") {
        return { status: "incomplete", record: { ...result.record, status: "failed" } };
      }
      return result;
    };

    const error = await captureTaskServiceError(() =>
      service.completeRecord({
        scope: "task",
        key,
        requestDigest,
        resultRef: "TASK-primary-transition-error"
      })
    );
    expect(error.code).toBe("record_schema_error");
    expect(error.message).toBe("Only a started idempotency record can be completed.");
    expect(error.cause).toBeInstanceOf(AggregateError);
    await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
    await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
  });

  test("transient publication temp unlink failure retries to a single-link canonical record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const key = "task:create:transient-temp-cleanup";
    const attempts: number[] = [];
    let publication: WorkspaceRecordPublicationHookInput | undefined;

    const result = await runWithWorkspaceRecordPublicationHooks(
      {
        afterCanonicalLink: (input) => {
          publication = input;
        },
        beforeTemporaryUnlink: ({ attempt }) => {
          attempts.push(attempt);
          if (attempt === 1) {
            throw new Error("injected transient cleanup failure");
          }
        }
      },
      () =>
        service.beginRecord({
          scope: "task",
          key,
          requestDigest: "digest-transient-temp-cleanup"
        })
    );

    expect(result.status).toBe("acquired");
    expect(attempts).toEqual([1, 2]);
    expect(publication).toBeDefined();
    expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
    await expectPathMissing(publication!.temporaryPath);
  });

  test("post-link failures roll back the exact claim and permit an immediate clean retry", async () => {
    for (const failure of ["after-link", "temp-cleanup"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = {
        ...validLockRecord(),
        lock_id: `LOCK-post-link-${failure}`
      };
      let publication: WorkspaceRecordPublicationHookInput | undefined;
      const attempts: number[] = [];
      await expect(
        runWithWorkspaceRecordPublicationHooks(
          {
            afterCanonicalLink: (input) => {
              publication = input;
              if (failure === "after-link") throw new Error("after-link fault");
            },
            beforeTemporaryUnlink: ({ attempt }) => {
              attempts.push(attempt);
              if (failure === "temp-cleanup") throw new Error("temp cleanup fault");
            }
          },
          () =>
            createJsonRecordIfAbsent(
              workspaceRoot,
              lockRecordDirectorySegments(record.scope),
              lockRecordFileName(record.lock_id),
              record,
              lockRecordEvidenceRef(record.scope, record.lock_id),
              LockRecordSchema
            )
        )
      ).rejects.toBeDefined();

      expect(publication).toBeDefined();
      await expectPathMissing(publication!.canonicalPath);
      await expectPathMissing(publication!.temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
      ).toBe(false);
      if (failure === "temp-cleanup") expect(attempts).toEqual([1, 2, 3]);

      const retried = await createJsonRecordIfAbsent(
        workspaceRoot,
        lockRecordDirectorySegments(record.scope),
        lockRecordFileName(record.lock_id),
        record,
        lockRecordEvidenceRef(record.scope, record.lock_id),
        LockRecordSchema
      );
      expect(retried.status).toBe("created");
      expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
    }
  });

  test("guard and cleanup-lock post-link failures roll back before ownership transfer", async () => {
    for (const target of ["cleanup", "guard"] as const) {
      for (const failure of ["after-link", "temp-cleanup"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const key = `task:create:${target}-${failure}-rollback`;
        const requestDigest = `digest-${target}-${failure}-rollback`;
        const service = createIdempotencyRecordService({ workspaceRoot });
        await service.beginRecord({ scope: "task", key, requestDigest });
        const targetPath =
          target === "cleanup"
            ? idempotencyTransitionCleanupLockPath(workspaceRoot, key)
            : idempotencyTransitionGuardPath(workspaceRoot, key);
        const hooks: WorkspaceRecordPublicationHooks = {
          afterCanonicalLink: ({ canonicalPath }) => {
            if (failure === "after-link" && canonicalPath === targetPath) {
              throw new Error(`${target} after-link fault`);
            }
          },
          beforeTemporaryUnlink: ({ canonicalPath }) => {
            if (failure === "temp-cleanup" && canonicalPath === targetPath) {
              throw new Error(`${target} temp-cleanup fault`);
            }
          }
        };

        await expect(
          runWithWorkspaceRecordPublicationHooks(hooks, () =>
            service.completeRecord({
              scope: "task",
              key,
              requestDigest,
              resultRef: `TASK-${target}-${failure}-rollback`
            })
          )
        ).rejects.toBeDefined();
        await expectPathMissing(idempotencyTransitionGuardPath(workspaceRoot, key));
        await expectPathMissing(idempotencyTransitionCleanupLockPath(workspaceRoot, key));
        expect((await service.getRecord("task", key))?.status).toBe("started");
        expect(
          (
            await readdir(join(workspaceRoot, "tasks", "_idempotency", "task"))
          ).some(isOwnedRecordPath)
        ).toBe(false);

        const completed = await service.completeRecord({
          scope: "task",
          key,
          requestDigest,
          resultRef: `TASK-${target}-${failure}-rollback`
        });
        expect(completed.status).toBe("completed");
      }
    }
  });

  test("temp cleanup preserves a same-inode byte mutation and removes private namespaces", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-temp-same-inode" };
    const modifiedBytes = Buffer.from("same-inode-temp-modification\n");
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: (input) => {
            publication = input;
          },
          beforeGenerationIsolation: async ({ operation, path }) => {
            if (operation !== "hardlink_temp_cleanup") return;
            const namespace = await findOnlyAuthorityNamespace(join(path, ".."));
            await expectPrivateAuthorityDirectory(namespace);
          },
          beforeAuthorityOwnedUnlink: async ({ operation, path }) => {
            if (operation !== "hardlink_temp_cleanup") return;
            const namespace = await findOnlyAuthorityNamespace(join(path, ".."));
            await writeFile(join(namespace, "generation"), modifiedBytes);
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            lockRecordEvidenceRef(record.scope, record.lock_id),
            LockRecordSchema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(publication).toBeDefined();
    expect(await readFile(publication!.canonicalPath)).toEqual(modifiedBytes);
    expect(await readFile(publication!.temporaryPath)).toEqual(modifiedBytes);
    expect(
      (await readdir(join(workspaceRoot, "locks", "task"))).some((name) =>
        name.endsWith(".authority")
      )
    ).toBe(false);
  });

  test("project-owned temp cleanup uses the open-file identity and preserves an outside hardlink", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const outsideAlias = join(tempRoot, "outside-temp-alias.json");
    const record = { ...validLockRecord(), lock_id: "LOCK-temp-open-identity" };
    let publication: WorkspaceRecordPublicationHookInput | undefined;

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: async (input) => {
            publication = input;
            await link(input.temporaryPath, outsideAlias);
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            lockRecordEvidenceRef(record.scope, record.lock_id),
            LockRecordSchema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(publication).toBeDefined();
    await expectPathMissing(publication!.temporaryPath);
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    expect(await readFile(outsideAlias)).toEqual(expectedBytes);
    await expectPathMissing(publication!.canonicalPath);
    expect((await stat(outsideAlias)).nlink).toBe(1);
  });

  test("persistent publication temp unlink failure fails closed without deleting aliases", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createIdempotencyRecordService({ workspaceRoot });
    const key = "task:create:persistent-temp-cleanup";
    const requestDigest = "digest-persistent-temp-cleanup";
    const outsideAlias = join(tempRoot, "outside-persistent-publication.json");
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    const attempts: number[] = [];

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: async (input) => {
            publication = input;
            await link(input.canonicalPath, outsideAlias);
          },
          beforeTemporaryUnlink: ({ attempt }) => {
            attempts.push(attempt);
            throw new Error("injected persistent cleanup failure");
          }
        },
        () => service.beginRecord({ scope: "task", key, requestDigest })
      )
    );

    expect(publication).toBeDefined();
    expect(error.code).toBe("workspace_path_not_safe");
    expect(error.message).toBe("Workspace record publication temporary cleanup did not complete.");
    expect(error.evidenceRefs).toEqual([idempotencyRecordEvidenceRef("task", key)]);
    expectErrorNotToLeakRecordContent(error, tempRoot);
    expect(attempts).toEqual([1, 2, 3]);
    await expectPathMissing(publication!.canonicalPath);
    await expectPathMissing(publication!.temporaryPath);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    expect(await service.getRecord("task", key)).toBeUndefined();

    const repaired = await service.beginRecord({
      scope: "task",
      key,
      requestDigest
    });

    expect(repaired.status).toBe("acquired");
    expect(repaired.record.status).toBe("started");
    expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
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

    expect(secondBegin).toEqual({
      status: "incomplete",
      record: startedRecord
    });
    expect(mismatchBegin).toEqual({
      status: "mismatch",
      record: startedRecord
    });
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
    expect(completedBegin).toEqual({
      status: "completed",
      record: completedRecord
    });
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
    const reacquired = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

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
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), {
      recursive: true
    });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, {
      flag: "wx"
    });
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:31.000Z")
    });

    const observed = await service.lookupReplay({
      scope: "task",
      key: rawKey,
      requestDigest
    });
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
    const reacquired = await service.beginRecord({
      scope: "task",
      key: rawKey,
      requestDigest
    });

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
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), {
      recursive: true
    });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, {
      flag: "wx"
    });
    const service = createIdempotencyRecordService({
      workspaceRoot,
      now: () => new Date("2026-07-07T13:30:41.000Z")
    });

    const observed = await service.lookupReplay({
      scope: "task",
      key: rawKey,
      requestDigest
    });
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
    await mkdir(join(workspaceRoot, "tasks", "_idempotency", "task"), {
      recursive: true
    });
    await writeFile(recordPath, `${JSON.stringify(poisonedRecord)}\n`, {
      flag: "wx"
    });
    const service = createIdempotencyRecordService({ workspaceRoot });
    const observed = await service.lookupReplay({
      scope: "task",
      key: rawKey,
      requestDigest
    });
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
    const freshService = createIdempotencyRecordService({
      workspaceRoot: fresh.workspaceRoot
    });
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
    await writeFile(guardPath, `${JSON.stringify(staleGuard)}\n`, {
      flag: "wx"
    });
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
          await writeFile(observedPath, `${JSON.stringify(freshGuard)}\n`, {
            flag: "wx"
          });
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

  test("conditional stale guard cleanup never deletes a replacement published after comparison", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:conditional-delete-replacement";
    const requestDigest = "digest-conditional-delete-replacement";
    const seedService = createIdempotencyRecordService({ workspaceRoot });
    await seedService.beginRecord({ scope: "task", key, requestDigest });
    await seedService.failRecord({ scope: "task", key, requestDigest });
    const guardPath = idempotencyTransitionGuardPath(workspaceRoot, key);
    const staleGuard = {
      guard_id: "stale-before-conditional-delete",
      owner_pid: 9_999_999,
      acquired_at_ms: Date.now() - 31_000,
      acquired_at: "2026-07-07T13:34:00.000Z"
    };
    const replacementGuard = {
      guard_id: "replacement-after-conditional-compare",
      owner_pid: process.pid,
      acquired_at_ms: Date.now(),
      acquired_at: new Date().toISOString()
    };
    await writeFile(guardPath, `${JSON.stringify(staleGuard)}\n`, {
      flag: "wx"
    });
    const replacementPath = `${guardPath}.replacement`;
    let replacementCount = 0;
    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeConditionalDelete: async ({ path, conditionStatus }) => {
            if (path !== guardPath) return;
            expect(conditionStatus).toBe("matched");
            replacementCount += 1;
            await writeFile(replacementPath, `${JSON.stringify(replacementGuard)}\n`, {
              flag: "wx"
            });
            await rename(replacementPath, guardPath);
          }
        },
        () =>
          createIdempotencyRecordService({ workspaceRoot }).beginRecord({
            scope: "task",
            key,
            requestDigest
          })
      )
    );

    expect(replacementCount).toBe(1);
    expect(error.code).toBe("record_malformed");
    expect(error.message).toBe("Workspace record changed before conditional removal.");
    expect(JSON.parse(await readFile(guardPath, "utf8"))).toEqual(replacementGuard);
    expect((await stat(guardPath)).nlink).toBe(1);
    expect(
      (await readdir(join(workspaceRoot, "tasks", "_idempotency", "task"))).filter((entry) =>
        entry.endsWith(".delete-quarantine")
      )
    ).toEqual([]);
  });

  test("rollback recovery conditionally removes malformed guards and releases authority", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const key = "task:create:malformed-rollback-recovery";
    const requestDigest = "digest-malformed-rollback-recovery";
    const service = createIdempotencyRecordService({ workspaceRoot });
    const begin = await service.beginRecord({
      scope: "task",
      key,
      requestDigest
    });
    const guardPath = idempotencyTransitionGuardPath(workspaceRoot, key);
    await writeFile(guardPath, "{", { flag: "wx" });

    const recovered = await Promise.race([
      service.recoverFailedRecordAfterRollback({
        scope: "task",
        key,
        requestDigest
      }),
      timeoutAfter(1_000, "malformed guard rollback recovery deadlocked")
    ]);

    expect(begin.status).toBe("acquired");
    expect(recovered.status).toBe("failed");
    await expectPathMissing(guardPath);
    expect(await service.getRecord("task", key)).toEqual(recovered);
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
    await writeFile(cleanupLockPath, `${JSON.stringify(staleCleanupLock)}\n`, {
      flag: "wx"
    });

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
    await writeFile(cleanupLockPath, `${JSON.stringify(liveCleanupLock)}\n`, {
      flag: "wx"
    });

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

    await rm(join(workspaceRoot, "tasks", task.task_id), {
      recursive: true,
      force: true
    });
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
    await writeFile(outsideSentinel, "external bytes must survive", {
      flag: "wx"
    });
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

  test("shared durable record reads reject hardlinked records and preserve regular siblings", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);

    const idempotencyService = createIdempotencyRecordService({
      workspaceRoot
    });
    const targetKey = "task:create:hardlinked-record";
    const siblingKey = "task:create:single-link-sibling";
    const targetBegin = await idempotencyService.beginRecord({
      scope: "task",
      key: targetKey,
      requestDigest: "digest-hardlinked-record"
    });
    const siblingBegin = await idempotencyService.beginRecord({
      scope: "task",
      key: siblingKey,
      requestDigest: "digest-single-link-sibling"
    });
    const idempotencyPath = join(
      workspaceRoot,
      "tasks",
      "_idempotency",
      "task",
      idempotencyRecordFileName(targetKey)
    );
    const idempotencyAlias = join(tempRoot, "outside-idempotency-hardlink.json");
    const idempotencyBytes = await readFile(idempotencyPath);
    await link(idempotencyPath, idempotencyAlias);

    const idempotencyError = await captureTaskServiceError(() =>
      idempotencyService.getRecord("task", targetKey)
    );

    expect(idempotencyError.code).toBe("record_malformed");
    expect(idempotencyError.evidenceRefs).toEqual([
      idempotencyRecordEvidenceRef("task", targetKey)
    ]);
    expect(await idempotencyService.getRecord("task", siblingKey)).toEqual(siblingBegin.record);
    expect(targetBegin.status).toBe("acquired");
    expect(await readFile(idempotencyAlias)).toEqual(idempotencyBytes);
    expect((await stat(idempotencyAlias)).nlink).toBe(2);

    const lockService = createLockRecordService({ workspaceRoot });
    const targetLock = validLockRecord();
    const siblingLock = {
      ...validLockRecord(),
      lock_id: "LOCK-single-link-sibling"
    };
    await lockService.storeLock(targetLock);
    await lockService.storeLock(siblingLock);
    const lockPath = join(workspaceRoot, "locks", targetLock.scope, `${targetLock.lock_id}.json`);
    const lockAlias = join(tempRoot, "outside-lock-hardlink.json");
    const lockBytes = await readFile(lockPath);
    await link(lockPath, lockAlias);

    const lockError = await captureTaskServiceError(() =>
      lockService.getLock(targetLock.scope, targetLock.lock_id)
    );

    expect(lockError.code).toBe("record_malformed");
    expect(await lockService.getLock(siblingLock.scope, siblingLock.lock_id)).toEqual(siblingLock);
    expect(await readFile(lockAlias)).toEqual(lockBytes);
    expect((await stat(lockAlias)).nlink).toBe(2);

    const artifactService = createArtifactRegistryService({ workspaceRoot });
    const targetArtifact = validArtifact();
    const siblingArtifact = {
      ...validArtifact(),
      artifact_id: "ART-single-link-sibling"
    };
    await artifactService.registerArtifact(targetArtifact);
    await artifactService.registerArtifact(siblingArtifact);
    const artifactPath = join(
      workspaceRoot,
      "artifacts",
      "manifests",
      `${targetArtifact.artifact_id}.json`
    );
    const artifactAlias = join(tempRoot, "outside-artifact-hardlink.json");
    const artifactBytes = await readFile(artifactPath);
    await link(artifactPath, artifactAlias);

    const artifactError = await captureTaskServiceError(() =>
      artifactService.getArtifact(targetArtifact.artifact_id)
    );

    expect(artifactError.code).toBe("record_malformed");
    expect(await artifactService.getArtifact(siblingArtifact.artifact_id)).toEqual(siblingArtifact);
    expect(await readFile(artifactAlias)).toEqual(artifactBytes);
    expect((await stat(artifactAlias)).nlink).toBe(2);
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
    expect(
      (await stat(join(workspaceRoot, "locks", "task", `${lock.lock_id}.json`))).isFile()
    ).toBe(true);

    await writeFile(join(workspaceRoot, "locks", "task", "LOCK-bad-sibling.json"), "{", {
      flag: "wx"
    });
    expect(await service.getLock("task", lock.lock_id)).toEqual(lock);
  });

  test("LockRecord invalid schema or id is rejected without lock files", async () => {
    const invalidSchema = await createTempWorkspacePath();
    tempRoots.push(invalidSchema.tempRoot);
    const schemaService = createLockRecordService({
      workspaceRoot: invalidSchema.workspaceRoot
    });

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
    const idService = createLockRecordService({
      workspaceRoot: invalidId.workspaceRoot
    });
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
    const symlinkService = createLockRecordService({
      workspaceRoot: symlinkCase.workspaceRoot
    });
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
    await writeFile(join(workspaceRoot, "artifacts"), "not a directory", {
      flag: "wx"
    });

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

    expect(observedTaskDirectories).toEqual([join(workspaceRoot, "tasks", "TASK-path-normalized")]);
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
    expect(
      (await stat(join(workspaceRoot, "tasks", retryTask.task_id, "snapshot.json"))).isFile()
    ).toBe(true);
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

      const reorderedSnapshot = Object.fromEntries(Object.entries(canonicalSnapshot).reverse());
      await writeFile(snapshotPath, `${JSON.stringify(reorderedSnapshot, null, 2)}\n`);

      expect(await reader.listTasks()).toEqual([task]);
      expect(await reader.getTaskFromSnapshot(taskId)).toEqual(task);
    }
  });

  test("TaskCard startup hydration rejects hardlinked snapshots without quarantining them", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const taskId = "TASK-startup-hardlinked-snapshot";
    await createTaskCardService({
      workspaceRoot,
      taskIdFactory: () => taskId
    }).createTask({
      type: "engineering",
      title: "Reject hardlinked startup snapshot",
      question_or_goal: "Do not accept or mutate a multiply linked durable snapshot.",
      inference_budget: { mode: "normal" },
      created_by: "pi"
    });
    const snapshotPath = join(workspaceRoot, "tasks", taskId, "snapshot.json");
    const outsideAlias = join(tempRoot, "outside-task-snapshot.json");
    const snapshotBytes = await readFile(snapshotPath);
    await link(snapshotPath, outsideAlias);
    const reader = createTaskCardService({ workspaceRoot });

    const hydrationError = await captureTaskServiceError(() => reader.listTasks());

    expect(hydrationError.code).toBe("task_snapshot_malformed");
    expect(hydrationError.evidenceRefs).toEqual([`workspace/tasks/${taskId}/snapshot.json`]);
    expect(await readFile(snapshotPath)).toEqual(snapshotBytes);
    expect(await readFile(outsideAlias)).toEqual(snapshotBytes);
    expect((await stat(snapshotPath)).nlink).toBe(2);
    expect((await stat(outsideAlias)).nlink).toBe(2);
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
    await mkdir(join(workspaceRoot, "artifacts", "manifests"), {
      recursive: true
    });
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
      (
        await stat(join(workspaceRoot, "artifacts", "manifests", `${artifact.artifact_id}.json`))
      ).isFile()
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
    const typeService = createArtifactRegistryService({
      workspaceRoot: invalidType.workspaceRoot
    });
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
    const idService = createArtifactRegistryService({
      workspaceRoot: invalidId.workspaceRoot
    });
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
    const pathService = createArtifactRegistryService({
      workspaceRoot: invalidPath.workspaceRoot
    });
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
    const lockService = createLockRecordService({
      workspaceRoot: lockCase.workspaceRoot
    });
    const lookupLock = validLockRecord();
    const storedLock = {
      ...lookupLock,
      lock_id: "LOCK-secret-foreign",
      scope: "job"
    } satisfies LockRecord;
    const lockPath = join(lockCase.workspaceRoot, "locks", "task", `${lookupLock.lock_id}.json`);
    await mkdir(join(lockCase.workspaceRoot, "locks", "task"), {
      recursive: true
    });
    await writeFile(lockPath, `${JSON.stringify(storedLock)}\n`, {
      flag: "wx"
    });

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
    await writeFile(artifactPath, `${JSON.stringify(storedArtifact)}\n`, {
      flag: "wx"
    });

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

function createRecordPublicationHold(targetPublication: number): {
  hooks: WorkspaceRecordPublicationHooks;
  waitUntilLinked: () => Promise<WorkspaceRecordPublicationHookInput>;
  release: () => void;
} {
  let publicationCount = 0;
  let resolveLinked!: (input: WorkspaceRecordPublicationHookInput) => void;
  let resolveRelease!: () => void;
  const linked = new Promise<WorkspaceRecordPublicationHookInput>((resolvePromise) => {
    resolveLinked = resolvePromise;
  });
  const released = new Promise<void>((resolvePromise) => {
    resolveRelease = resolvePromise;
  });

  return {
    hooks: {
      afterCanonicalLink: async (input) => {
        publicationCount += 1;
        if (publicationCount !== targetPublication) {
          return;
        }
        resolveLinked(input);
        await released;
      }
    },
    waitUntilLinked: async () => await linked,
    release: () => resolveRelease()
  };
}

function createAsyncGate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolvePromise) => {
    open = resolvePromise;
  });
  return { wait, open };
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function runMixedLockAuthorityOperation(
  workspaceRoot: string,
  record: LockRecord,
  index: number
): Promise<unknown> {
  if (index % 3 === 0) {
    return await createLockRecordService({ workspaceRoot }).getLock(record.scope, record.lock_id);
  }
  if (index % 3 === 1) {
    return await writeJsonRecord(
      workspaceRoot,
      lockRecordDirectorySegments(record.scope),
      lockRecordFileName(record.lock_id),
      { ...record, holder: `fifo-holder-${index}` },
      lockRecordEvidenceRef(record.scope, record.lock_id),
      LockRecordSchema
    );
  }
  return await createJsonRecordIfAbsent(
    workspaceRoot,
    lockRecordDirectorySegments(record.scope),
    lockRecordFileName(record.lock_id),
    record,
    lockRecordEvidenceRef(record.scope, record.lock_id),
    LockRecordSchema
  );
}

function createAuthorityReadHold(
  service: ReturnType<typeof createLockRecordService>,
  lockId: string
): {
  acquired: Promise<void>;
  contended: Promise<void>;
  start: () => Promise<LockRecord | undefined>;
  release: () => void;
} {
  const hold = createAsyncGate();
  let resolveAcquired!: () => void;
  let resolveContended!: () => void;
  const acquired = new Promise<void>((resolvePromise) => {
    resolveAcquired = resolvePromise;
  });
  const contended = new Promise<void>((resolvePromise) => {
    resolveContended = resolvePromise;
  });

  return {
    acquired,
    contended,
    start: () =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: async ({ operation }) => {
            expect(operation).toBe("read");
            resolveAcquired();
            await hold.wait;
          },
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("read");
            resolveContended();
          }
        },
        () => service.getLock("task", lockId)
      ),
    release: hold.open
  };
}

async function saturateRecordAuthorityPath(
  path: string,
  evidenceRef: string
): Promise<{
  acquisitionOrder: number[];
  queueOrder: number[];
  completed: Promise<Array<unknown>>;
  release: () => void;
}> {
  const holderGate = createAsyncGate();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    holderGate.open();
  };
  const holderAcquired = createSignal();
  const holder = runWithWorkspaceRecordPublicationHooks(
    {
      afterAuthorityLeaseAcquired: async ({ operation }) => {
        expect(operation).toBe("read");
        holderAcquired.resolve();
        await holderGate.wait;
      }
    },
    () => readJsonRecord(path, evidenceRef, z.unknown())
  );
  await holderAcquired.promise;

  const acquisitionOrder: number[] = [];
  const queueOrder: number[] = [];
  let contentionCount = 0;
  const allQueued = createSignal();
  const queued = Array.from({ length: 63 }, (_, index) =>
    runWithWorkspaceRecordPublicationHooks(
      {
        onAuthorityContention: ({ operation }) => {
          expect(operation).toBe("read");
          queueOrder.push(index);
          contentionCount += 1;
          if (contentionCount === 63) allQueued.resolve();
        },
        afterAuthorityLeaseAcquired: ({ operation }) => {
          expect(operation).toBe("read");
          acquisitionOrder.push(index);
        }
      },
      () => readJsonRecord(path, evidenceRef, z.unknown())
    )
  );
  try {
    await Promise.race([
      allQueued.promise,
      timeoutAfter(2_000, "per-path authority saturation did not queue")
    ]);
  } catch (error) {
    release();
    await Promise.allSettled([holder, ...queued]);
    throw error;
  }

  const completed = (async () => {
    const results = await Promise.all(queued);
    await holder;
    return results;
  })();

  return {
    acquisitionOrder,
    queueOrder,
    completed,
    release
  };
}

async function saturateGlobalRecordAuthority(
  workspaceRoot: string,
  lockIdPrefix: string
): Promise<{
  completed: Promise<Array<LockRecord | undefined>>;
  release: () => void;
}> {
  const hold = createAsyncGate();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hold.open();
  };
  const allAcquired = createSignal();
  let acquired = 0;
  const service = createLockRecordService({ workspaceRoot });
  const holders = Array.from({ length: 1024 }, (_, index) =>
    runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async ({ operation }) => {
          expect(operation).toBe("read");
          acquired += 1;
          if (acquired === 1024) allAcquired.resolve();
          await hold.wait;
        }
      },
      () => service.getLock("task", `${lockIdPrefix}-${index}`)
    )
  );
  try {
    await Promise.race([
      allAcquired.promise,
      timeoutAfter(2_000, "global authority holders did not acquire")
    ]);
  } catch (error) {
    release();
    await Promise.allSettled(holders);
    throw error;
  }
  return {
    completed: Promise.all(holders),
    release
  };
}

async function createTempWorkspacePath(): Promise<{
  tempRoot: string;
  workspaceRoot: string;
}> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-core-services-")));
  return {
    tempRoot,
    workspaceRoot: join(tempRoot, "workspace")
  };
}

async function createCaseAliasWorkspacePath(): Promise<
  { tempRoot: string; workspaceRoot: string; aliasRoot: string } | undefined
> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-case-alias-")));
  const workspaceRoot = join(tempRoot, "AuthorityWorkspace");
  const aliasRoot = join(tempRoot, "aUTHORITYwORKSPACE");
  await mkdir(workspaceRoot);
  try {
    if ((await realpath(aliasRoot)) !== (await realpath(workspaceRoot))) {
      throw new Error("Filesystem case alias resolved to a different physical workspace.");
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    if (hasTestErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return { tempRoot, workspaceRoot, aliasRoot };
}

function hasTestErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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

async function captureConditionalDeleteError(
  action: () => Promise<unknown>
): Promise<WorkspaceRecordConditionalDeleteError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRecordConditionalDeleteError);
    return error as WorkspaceRecordConditionalDeleteError;
  }
  throw new Error("Expected WorkspaceRecordConditionalDeleteError.");
}

function isOwnedRecordPath(name: string): boolean {
  return name.endsWith(".authority") || name.endsWith(".tmp");
}

async function findOnlyAuthorityNamespace(directoryPath: string): Promise<string> {
  const authorityNames = (await readdir(directoryPath)).filter((name) =>
    name.endsWith(".authority")
  );
  expect(authorityNames).toHaveLength(1);
  return join(directoryPath, authorityNames[0]!);
}

async function expectPrivateAuthorityDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  expect(entry.isDirectory()).toBe(true);
  expect(entry.isSymbolicLink()).toBe(false);
  expect(entry.mode & 0o777).toBe(0o700);
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

function idempotencyTransitionGuardPath(workspaceRoot: string, key: string): string {
  return join(
    workspaceRoot,
    "tasks",
    "_idempotency",
    "task",
    `${sha256Hex(`transition:${key}`)}.guard.json`
  );
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
