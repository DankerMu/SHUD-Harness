import { afterEach, describe, expect, test } from "bun:test";
import { fstat } from "node:fs";
import {
  access,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
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
  runWithWorkspaceRecordAuthorityDeadline,
  runWithWorkspaceRecordPublicationHooks,
  WorkspaceRecordConditionalDeleteError,
  workspaceRecordPhysicalIdentityMatches,
  workspaceRecordPath,
  writeJsonRecord,
  type WorkspaceRecordPublicationHookInput,
  type WorkspaceRecordTemporaryHandleHookInput,
  type WorkspaceRecordPublicationHooks,
  type WorkspaceRecordCleanupPermit
} from "./workspace-record-store";
import {
  physicalAuthorityPathIdentity,
  physicalCanonicalPath,
  runWithWorkspacePathSafetyHooks
} from "./workspace-path-safety";
import { readDurableSingleLinkFile } from "./durable-single-link-reader";

const tempRoots: string[] = [];
const distinctCaseEntriesSupported = await detectDistinctCaseEntriesSupport();

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
      () => createLockRecordService({ workspaceRoot }).getLock("task", "LOCK-distinct-isolation")
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

  test.skipIf(!distinctCaseEntriesSupported)("coexisting case-sensitive leaves keep distinct authority and reject cross-path permits", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot);
    const schema = z.object({ id: z.string() });
    const upper = { id: "upper" };
    const lower = { id: "lower" };
    const directorySegments = ["case-sensitive-authority"] as const;
    const upperPath = workspaceRecordPath(workspaceRoot, [...directorySegments, "Foo.json"], "case-sensitive.upper");
    const lowerPath = workspaceRecordPath(workspaceRoot, [...directorySegments, "foo.json"], "case-sensitive.lower");
    const upperCreated = await createJsonRecordIfAbsentWithCleanupPermit(workspaceRoot, directorySegments, "Foo.json", upper, "case-sensitive.upper", schema);
    const lowerCreated = await createJsonRecordIfAbsentWithCleanupPermit(workspaceRoot, directorySegments, "foo.json", lower, "case-sensitive.lower", schema);
    if (upperCreated.status !== "created" || lowerCreated.status !== "created") throw new Error("Expected distinct case-sensitive records.");
    const upperHold = createAsyncGate();
    const upperAcquired = createSignal();
    const upperRead = runWithWorkspaceRecordPublicationHooks({ afterAuthorityLeaseAcquired: async () => { upperAcquired.resolve(); await upperHold.wait; } }, () => readJsonRecord(upperPath, "case-sensitive.upper", schema));
    await upperAcquired.promise;
    const lowerAcquired = createSignal();
    const lowerRead = runWithWorkspaceRecordPublicationHooks({ afterAuthorityLeaseAcquired: () => lowerAcquired.resolve(), onAuthorityContention: () => { throw new Error("Distinct case-sensitive leaves must not share authority."); } }, () => readJsonRecord(lowerPath, "case-sensitive.lower", schema));
    await Promise.race([lowerAcquired.promise, timeoutAfter(500, "distinct case-sensitive leaf was incorrectly serialized")]);
    upperHold.open();
    expect(await Promise.all([upperRead, lowerRead])).toEqual([upper, lower]);
    const upperBefore = await readFileWithIdentity(upperPath);
    const lowerBefore = await readFileWithIdentity(lowerPath);
    const crossUse = await captureConditionalDeleteError(() => conditionalDeleteJsonRecordWithCleanupPermit(upperCreated.cleanupPermit, lowerPath, "case-sensitive.cross-use", schema, { kind: "record", expected: lower, matches: (current, expected) => current.id === expected.id }));
    expect(crossUse.mutationPhase).toBe("pre_mutation");
    expect(crossUse.failureStage).toBe("permit_admission");
    expect(await readFileWithIdentity(upperPath)).toEqual(upperBefore);
    expect(await readFileWithIdentity(lowerPath)).toEqual(lowerBefore);
    expect(await conditionalDeleteJsonRecordWithCleanupPermit(lowerCreated.cleanupPermit, lowerPath, "case-sensitive.lower", schema, { kind: "record", expected: lower, matches: (current, expected) => current.id === expected.id })).toEqual({ status: "deleted" });
    expect(await conditionalDeleteJsonRecord(upperPath, "case-sensitive.upper", schema, { kind: "record", expected: upper, matches: (current, expected) => current.id === expected.id })).toEqual({ status: "deleted" });
  });

  test("numeric-only filesystem boundaries fail closed when case semantics are unavailable", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const numericRoot = join(workspaceRoot, "100", "200");
    await mkdir(numericRoot, { recursive: true });
    const upperMissing = join(numericRoot, "Foo.json");
    const lowerMissing = join(numericRoot, "foo.json");

    const [upperUnknown, lowerUnknown] = await runWithWorkspacePathSafetyHooks(
      { filesystemCaseSemantics: () => "unknown" },
      () =>
        Promise.all([
          physicalAuthorityPathIdentity(upperMissing, "case-semantics.unknown.upper"),
          physicalAuthorityPathIdentity(lowerMissing, "case-semantics.unknown.lower")
        ])
    );
    expect(upperUnknown).toBe(lowerUnknown);

    const [upperSensitive, lowerSensitive] = await runWithWorkspacePathSafetyHooks(
      { filesystemCaseSemantics: () => "case_sensitive" },
      () =>
        Promise.all([
          physicalAuthorityPathIdentity(upperMissing, "case-semantics.sensitive.upper"),
          physicalAuthorityPathIdentity(lowerMissing, "case-semantics.sensitive.lower")
        ])
    );
    expect(upperSensitive).not.toBe(lowerSensitive);
  });

  test("cleanup-permit deletion keeps namespace and pre-rename failures pre-mutation", async () => {
    for (const failure of ["namespace", "pre_isolation", "rename"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: failure };
      const evidenceRef = `conditional-delete.pre-mutation.${failure}`;
      const directorySegments = ["conditional-delete-pre-mutation"] as const;
      const fileName = `${failure}.json`;
      const path = workspaceRecordPath(workspaceRoot, [...directorySegments, fileName], evidenceRef);
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected a cleanup-permit fixture.");
      const before = await readFileWithIdentity(path);
      let blockingNamespacePath: string | undefined;

      const error = await captureConditionalDeleteError(() =>
        runWithWorkspaceRecordPublicationHooks(
          failure === "namespace"
            ? {
                beforeAuthorityNamespaceCreation: async ({ path: namespacePath }) => {
                  blockingNamespacePath = namespacePath;
                  await writeFile(namespacePath, "namespace creation blocker", { flag: "wx" });
                }
              }
            : {
                beforeGenerationIsolation: async () => {
                  if (failure === "pre_isolation") {
                    throw new Error("injected pre-isolation failure");
                  }
                  blockingNamespacePath = await findOnlyAuthorityNamespace(join(path, ".."));
                  await rmdir(blockingNamespacePath);
                  await writeFile(blockingNamespacePath, "rename blocker", { flag: "wx" });
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
        )
      );

      expect(error.mutationPhase).toBe("pre_mutation");
      expect(error.failureStage).toBe("operation");
      expect(await readFileWithIdentity(path)).toEqual(before);
      if (blockingNamespacePath) await rm(blockingNamespacePath, { force: true });
      expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);

      const reusedPermit = await captureConditionalDeleteError(() =>
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
      expect(reusedPermit.mutationPhase).toBe("pre_mutation");
      expect(reusedPermit.failureStage).toBe("permit_admission");
      expect(await readFileWithIdentity(path)).toEqual(before);
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("cleanup-permit deletion marks failures after canonical isolation post-mutation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "post-rename" };
    const evidenceRef = "conditional-delete.post-mutation";
    const directorySegments = ["conditional-delete-post-mutation"] as const;
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, "record.json"],
      evidenceRef
    );
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      "record.json",
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected a cleanup-permit fixture.");
    const before = await readFileWithIdentity(path);

    const error = await captureConditionalDeleteError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityOwnedUnlink: ({ operation }) => {
            if (operation === "conditional_delete") {
              throw new Error("injected post-rename failure");
            }
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
      )
    );

    expect(error.mutationPhase).toBe("post_mutation");
    expect(error.failureStage).toBe("operation");
    expect(await readFileWithIdentity(path)).toEqual(before);
    expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);
    const reusedPermit = await captureConditionalDeleteError(() =>
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
    expect(reusedPermit.mutationPhase).toBe("pre_mutation");
    expect(reusedPermit.failureStage).toBe("permit_admission");
    expect(
      await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
  });

  test("physical canonical paths preserve existing spelling across follower restart windows", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot);
    const leafPath = join(workspaceRoot, "AuthorityLeaf.JSON");
    const leafBytes = Buffer.from("authority-window\n");
    await writeFile(leafPath, leafBytes, { flag: "wx" });
    const existingIdentity = await physicalCanonicalPath(leafPath, "authority.window.existing");
    expect(existingIdentity).toBe(leafPath);
    await rm(leafPath);
    const missingIdentity = await physicalCanonicalPath(leafPath, "authority.window.missing");

    for (let window = 0; window < 12; window += 1) {
      await writeFile(leafPath, leafBytes, { flag: "wx" });
      const observedStates: boolean[] = [];
      const followerIdentity = await runWithWorkspacePathSafetyHooks(
        {
          afterPhysicalCandidateLstat: async ({ candidatePath, exists }) => {
            if (candidatePath !== leafPath || observedStates.length >= 2) return;
            observedStates.push(exists);
            if (observedStates.length === 1) {
              expect(exists).toBe(true);
              await rm(leafPath);
            } else {
              expect(exists).toBe(false);
              await writeFile(leafPath, leafBytes, { flag: "wx" });
            }
          }
        },
        () => physicalCanonicalPath(leafPath, `authority.window.follower.${window}`)
      );

      expect(observedStates).toEqual([true, false]);
      expect(await readFile(leafPath)).toEqual(leafBytes);
      expect([existingIdentity, missingIdentity]).toContain(followerIdentity);
      await rm(leafPath);
    }
  });

  test("same-path authority admission is bounded before temp creation and hands off FIFO", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const record = { ...validLockRecord(), lock_id: "LOCK-same-path-capacity" };
    await service.storeLock(record);
    const directoryPath = join(workspaceRoot, "locks", "task");
    const beforeFiles = await readdir(directoryPath);
    let holder: ReturnType<typeof createAuthorityReadHold> | undefined;
    const pending: Promise<unknown>[] = [];
    try {
      holder = createAuthorityReadHold(service, record.lock_id);
      const heldRead = holder.start();
      pending.push(heldRead);
      await Promise.race([
        holder.acquired,
        timeoutAfter(2_000, "same-path authority holder did not acquire")
      ]);

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
              expect(operation).toBe(["read", "hardlink"][index % 2]);
              acquisitionOrder.push(index);
            }
          },
          () => runMixedLockAuthorityOperation(workspaceRoot, record, index)
        )
      );
      pending.push(...queued);
      await Promise.race([
        capMinusOne,
        timeoutAfter(2_000, "same-path authority cap-1 waiters did not queue")
      ]);
      expect(contentionCount).toBe(62);
      await Promise.race([
        cap,
        timeoutAfter(2_000, "same-path authority capacity waiters did not queue")
      ]);
      expect(contentionCount).toBe(63);

      const overflowActions = [
        () => service.getLock(record.scope, record.lock_id),
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
    } finally {
      holder?.release();
      await Promise.allSettled(pending);
    }
  });

  test("oversized hardlink records fail before authority admission or workspace mutation", async () => {
    const { tempRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const oversizedSchema = z.object({ payload: z.string() });
    const oversizedRecord = { payload: "x".repeat(MAX_SERVICE_RECORD_BYTES) };
    let authorityAdmissions = 0;

    const workspaceRoot = join(tempRoot, "hardlink");
    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: () => {
            authorityAdmissions += 1;
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            ["records"],
            "oversized.json",
            oversizedRecord,
            "oversized.hardlink",
            oversizedSchema
          )
      )
    );

    expect(error.code).toBe("record_schema_error");
    expect(error.message).toBe("Workspace record would exceed the M1 bounded size.");
    await expectPathMissing(workspaceRoot);

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

  test("hardlink producer generation exists only inside its fresh private namespace", async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { ...validLockRecord(), lock_id: "LOCK-private-producer-generation" };
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      let publication: WorkspaceRecordPublicationHookInput | undefined;
      let producerIdentity: { dev: number; ino: number } | undefined;

      const result = await
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: async (input) => {
              publication = input;
              const namespacePath = join(input.temporaryPath, "..");
              await expectPrivateAuthorityDirectory(namespacePath);
              expect(input.temporaryPath).toBe(join(namespacePath, "generation"));
              producerIdentity = await stat(input.temporaryPath);
              const publicEntries = await readdir(join(namespacePath, ".."));
              expect(publicEntries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
              expect(publicEntries.filter((name) => name.endsWith(".authority"))).toHaveLength(1);
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
        );

      expect(result.status).toBe("created");
      expect(publication).toBeDefined();
      expect(await readFile(publication!.canonicalPath)).toEqual(expectedBytes);
      expect(await stat(publication!.canonicalPath)).toMatchObject({ ino: producerIdentity!.ino, nlink: 1 });
      await expectPathMissing(publication!.temporaryPath);
      expect((await readdir(join(publication!.canonicalPath, ".."))).some(isOwnedRecordPath)).toBe(false);
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

  test("one cleanup permit admits exactly one concurrent consumer in free and contended lanes", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });

    for (const lane of ["free", "contended"] as const) {
      const record = { id: `single-consumer-${lane}` };
      const fileName = `${record.id}.json`;
      const evidenceRef = `permit.single-consumer.${lane}`;
      const path = workspaceRecordPath(workspaceRoot, ["permit-races", fileName], evidenceRef);
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-races"],
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected a permit race fixture.");

      const identityEntered = createSignal();
      const identityGate = createAsyncGate();
      const contentionEntered = createSignal();
      let identityAdmissions = 0;
      let mutationAdmissions = 0;
      let releaseHolder: (() => void) | undefined;
      let holder: Promise<unknown> | undefined;
      if (lane === "contended") {
        const holderGate = createAsyncGate();
        const holderAcquired = createSignal();
        releaseHolder = holderGate.open;
        holder = runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: async () => {
              holderAcquired.resolve();
              await holderGate.wait;
            }
          },
          () => readJsonRecord(path, evidenceRef, schema)
        );
        await holderAcquired.promise;
      }

      const winner = runWithWorkspaceRecordPublicationHooks(
        {
          beforeCleanupPermitIdentityResolution: async () => {
            identityAdmissions += 1;
            identityEntered.resolve();
            if (lane === "free") await identityGate.wait;
          },
          onAuthorityContention: () => contentionEntered.resolve(),
          beforeConditionalDelete: () => {
            mutationAdmissions += 1;
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
      await identityEntered.promise;
      if (lane === "contended") await contentionEntered.promise;

      const loser = await captureConditionalDeleteError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            beforeCleanupPermitIdentityResolution: () => {
              identityAdmissions += 1;
            },
            beforeConditionalDelete: () => {
              mutationAdmissions += 1;
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
        )
      );
      expect(loser.mutationPhase).toBe("pre_mutation");
      expect(loser.failureStage).toBe("permit_admission");
      expect(identityAdmissions).toBe(1);
      expect(mutationAdmissions).toBe(0);

      identityGate.open();
      releaseHolder?.();
      await holder;
      expect(await winner).toEqual({ status: "deleted" });
      expect(mutationAdmissions).toBe(1);

      const reused = await captureConditionalDeleteError(() =>
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
      expect(reused.failureStage).toBe("permit_admission");

      const replacement = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-races"],
        fileName,
        record,
        `${evidenceRef}.replacement`,
        schema
      );
      if (replacement.status !== "created") throw new Error("Expected a replacement permit.");
      expect(
        await conditionalDeleteJsonRecordWithCleanupPermit(
          replacement.cleanupPermit,
          path,
          `${evidenceRef}.replacement`,
          schema,
          {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          }
        )
      ).toEqual({ status: "deleted" });
    }
  });

  test("ordinary deletion terminally settles transferred permits without leaking capacity", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      ["permit-ordinary-cycles", fileName],
      "permit.ordinary-cycles"
    );

    for (let index = 0; index < 1025; index += 1) {
      const record = { id: `ordinary-cycle-${index}` };
      const evidenceRef = `permit.ordinary-cycle.${index}`;
      const first = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-ordinary-cycles"],
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (first.status !== "created") throw new Error("Expected an ordinary cleanup fixture.");
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });

      const replacement = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-ordinary-cycles"],
        fileName,
        record,
        `${evidenceRef}.replacement`,
        schema
      );
      if (replacement.status !== "created") throw new Error("Expected a replacement fixture.");
      const stalePermit = await captureConditionalDeleteError(() =>
        conditionalDeleteJsonRecordWithCleanupPermit(
          first.cleanupPermit,
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
      expect(stalePermit.failureStage).toBe("permit_admission");
      expect(
        await conditionalDeleteJsonRecordWithCleanupPermit(
          replacement.cleanupPermit,
          path,
          `${evidenceRef}.replacement`,
          schema,
          {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          }
        )
      ).toEqual({ status: "deleted" });
    }
  }, 20_000);

  test("cleanup permit rejects an uncontended identity delay after its inherited deadline before mutation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "permit-inherited-deadline" };
    const evidenceRef = "permit.inherited-deadline";
    const path = workspaceRecordPath(
      workspaceRoot,
      ["permit-tests", "permit-inherited-deadline.json"],
      evidenceRef
    );
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      ["permit-tests"],
      "permit-inherited-deadline.json",
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected an inherited deadline fixture.");
    const deadline = Date.now() + 250;
    const error = await captureConditionalDeleteError(() =>
      runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
        runWithWorkspaceRecordPublicationHooks(
          {
            beforeCleanupPermitIdentityResolution: async () => {
              await delay(275);
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
        )
      )
    );

    expect(error.mutationPhase).toBe("pre_mutation");
    expect(error.failureStage).toBe("permit_admission");
    expect(error.cause).toBeInstanceOf(TaskServiceError);
    expect((error.cause as TaskServiceError).status).toBe(409);
    expect((error.cause as TaskServiceError).retryable).toBe(true);
    expect(await readJsonRecord(path, evidenceRef, schema)).toEqual(record);
    expect((await readdir(join(workspaceRoot, "permit-tests"))).some(isOwnedRecordPath)).toBe(false);
    expect(
      await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
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
    const holders: Promise<LockRecord | undefined>[] = [];
    try {
      holders.push(...Array.from({ length: 1023 }, (_, index) => startHolder(index)));
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
      const capacityError = await captureTaskServiceError(() =>
        service.getLock("task", "LOCK-capacity-overflow")
      );
      expect(capacityError.code).toBe("record_malformed");
      expect(capacityError.status).toBe(409);
      expect(capacityError.retryable).toBe(true);
      expect(capacityError.message).toBe("Workspace record authority coordination is at capacity.");
      expectErrorNotToLeakRecordContent(capacityError, tempRoot);
      releaseHolders.open();
      expect(await Promise.all(holders)).toEqual(Array.from({ length: 1024 }, () => undefined));
      expect(await service.getLock("task", "LOCK-capacity-overflow")).toBeUndefined();
    } finally {
      releaseHolders.open();
      await Promise.allSettled(holders);
    }
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

  test("expired ordinary waiter is rejected at handoff before its operation and the queue converges", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "expired-ordinary-handoff" };
    const evidenceRef = "waiter.handoff.ordinary";
    const path = workspaceRecordPath(
      workspaceRoot,
      ["waiter-handoff", "ordinary.json"],
      evidenceRef
    );
    await writeJsonRecord(
      workspaceRoot,
      ["waiter-handoff"],
      "ordinary.json",
      record,
      evidenceRef,
      schema
    );
    const holderGate = createAsyncGate();
    const holderAcquired = createSignal();
    const contended = createSignal();
    const holder = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async () => {
          holderAcquired.resolve();
          await holderGate.wait;
          throw new Error("ordinary holder released");
        }
      },
      () => readJsonRecord(path, evidenceRef, schema)
    ).catch(() => undefined);
    await holderAcquired.promise;
    let operationAdmissions = 0;
    const deadline = Date.now() + 30;
    const waiter = captureTaskServiceError(() =>
      runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
        runWithWorkspaceRecordPublicationHooks(
          {
            onAuthorityContention: () => contended.resolve(),
            afterAuthorityLeaseAcquired: () => {
              operationAdmissions += 1;
            }
          },
          () => readJsonRecord(path, evidenceRef, schema)
        )
      )
    );
    await contended.promise;
    while (Date.now() <= deadline) {}
    holderGate.open();
    await holder;

    const error = await waiter;
    expect(error.status).toBe(409);
    expect(error.retryable).toBe(true);
    expect(operationAdmissions).toBe(0);
    expect(await readJsonRecord(path, evidenceRef, schema)).toEqual(record);
  });

  test("expired cleanup waiter is rejected at handoff before mutation and the queue converges", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "expired-cleanup-handoff" };
    const evidenceRef = "waiter.handoff.cleanup";
    const path = workspaceRecordPath(
      workspaceRoot,
      ["waiter-handoff", "cleanup.json"],
      evidenceRef
    );
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      ["waiter-handoff"],
      "cleanup.json",
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected cleanup waiter fixture.");
    const holderGate = createAsyncGate();
    const holderAcquired = createSignal();
    const contended = createSignal();
    const holder = runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: async () => {
          holderAcquired.resolve();
          await holderGate.wait;
          throw new Error("cleanup holder released");
        }
      },
      () => readJsonRecord(path, evidenceRef, schema)
    ).catch(() => undefined);
    await holderAcquired.promise;
    let mutationAdmissions = 0;
    const deadline = Date.now() + 30;
    const waiter = captureConditionalDeleteError(() =>
      runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
        runWithWorkspaceRecordPublicationHooks(
          {
            onAuthorityContention: () => contended.resolve(),
            beforeConditionalDelete: () => {
              mutationAdmissions += 1;
            }
          },
          () => conditionalDeleteJsonRecordWithCleanupPermit(
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
        )
      )
    );
    await contended.promise;
    while (Date.now() <= deadline) {}
    holderGate.open();
    await holder;

    const error = await waiter;
    expect(error.mutationPhase).toBe("pre_mutation");
    expect(error.failureStage).toBe("permit_admission");
    expect(error.cause).toBeInstanceOf(TaskServiceError);
    expect((error.cause as TaskServiceError).status).toBe(409);
    expect(mutationAdmissions).toBe(0);
    expect(await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
      kind: "record",
      expected: record,
      matches: (current, expected) => current.id === expected.id
    })).toEqual({ status: "deleted" });
  });

  test("ordinary then cleanup waiters acquire in one cross-class FIFO order", async () => {
    const fixture = await createCleanupPermitQueueFixture("ordinary-cleanup");
    tempRoots.push(fixture.tempRoot);
    const holder = fixture.holdAuthority();
    await holder.acquired;
    const order: string[] = [];
    const ordinaryGate = createAsyncGate();
    const ordinaryContended = createSignal();
    const ordinaryAcquired = createSignal();
    const ordinary = runWithWorkspaceRecordPublicationHooks({
      onAuthorityContention: () => ordinaryContended.resolve(),
      afterAuthorityLeaseAcquired: async () => {
        order.push("ordinary"); ordinaryAcquired.resolve(); await ordinaryGate.wait;
      }
    }, () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema));
    await ordinaryContended.promise;
    const cleanupContended = createSignal();
    const cleanup = runWithWorkspaceRecordPublicationHooks({
      onAuthorityContention: () => cleanupContended.resolve(),
      beforeConditionalDelete: () => order.push("cleanup")
    }, () => fixture.cleanup());
    await cleanupContended.promise;
    holder.release();
    await ordinaryAcquired.promise;
    expect(order).toEqual(["ordinary"]);
    ordinaryGate.open();
    expect(await ordinary).toEqual(fixture.record);
    expect(await cleanup).toEqual({ status: "deleted" });
    expect(order).toEqual(["ordinary", "cleanup"]);
    await holder.completed;
  });

  test("cleanup then ordinary waiters acquire in one cross-class FIFO order", async () => {
    const fixture = await createCleanupPermitQueueFixture("cleanup-ordinary");
    tempRoots.push(fixture.tempRoot);
    const holder = fixture.holdAuthority();
    await holder.acquired;
    const order: string[] = [];
    const cleanupContended = createSignal();
    const cleanup = runWithWorkspaceRecordPublicationHooks({
      onAuthorityContention: () => cleanupContended.resolve(),
      beforeConditionalDelete: () => order.push("cleanup")
    }, () => fixture.cleanup());
    await cleanupContended.promise;
    const ordinaryContended = createSignal();
    const ordinary = runWithWorkspaceRecordPublicationHooks({
      onAuthorityContention: () => ordinaryContended.resolve(),
      afterAuthorityLeaseAcquired: () => order.push("ordinary")
    }, () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema));
    await ordinaryContended.promise;
    holder.release();
    expect(await cleanup).toEqual({ status: "deleted" });
    expect(await ordinary).toBeUndefined();
    expect(order).toEqual(["cleanup", "ordinary"]);
    await holder.completed;
  });

  test("expired ordinary ahead of cleanup is cancelled and cross-class handoff converges", async () => {
    const fixture = await createCleanupPermitQueueFixture("expired-ordinary-cleanup");
    tempRoots.push(fixture.tempRoot);
    const holder = fixture.holdAuthority();
    await holder.acquired;
    const ordinaryContended = createSignal();
    const deadline = Date.now() + 30;
    const ordinary = captureTaskServiceError(() =>
      runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
        runWithWorkspaceRecordPublicationHooks(
          { onAuthorityContention: () => ordinaryContended.resolve() },
          () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)
        )
      )
    );
    await ordinaryContended.promise;
    const cleanupContended = createSignal();
    const cleanup = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => cleanupContended.resolve() },
      () => fixture.cleanup()
    );
    await cleanupContended.promise;
    while (Date.now() <= deadline) {}
    holder.release();
    expect((await ordinary).retryable).toBe(true);
    expect(await cleanup).toEqual({ status: "deleted" });
    expect(await readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)).toBeUndefined();
    await holder.completed;
  });

  test("transient publication temp unlink failure retries to a single-link canonical record", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-transient-temp-cleanup" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
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
        createJsonRecordIfAbsent(
          workspaceRoot,
          lockRecordDirectorySegments(record.scope),
          lockRecordFileName(record.lock_id),
          record,
          evidenceRef,
          LockRecordSchema
        )
    );

    expect(result.status).toBe("created");
    expect(attempts).toEqual([1, 2]);
    expect(publication).toBeDefined();
    expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
    await expectPathMissing(publication!.temporaryPath);
  });

  test("successful hardlink publication closes its producer descriptor and transfers one cleanup permit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-successful-descriptor-close" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...lockRecordDirectorySegments(record.scope), lockRecordFileName(record.lock_id)],
      evidenceRef
    );
    let descriptor: WorkspaceRecordTemporaryHandleHookInput["descriptor"] | undefined;

    const created = await runWithWorkspaceRecordPublicationHooks(
      {
        beforeTemporaryFileClose: (input) => {
          descriptor = input.descriptor;
        }
      },
      () =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          lockRecordDirectorySegments(record.scope),
          lockRecordFileName(record.lock_id),
          record,
          evidenceRef,
          LockRecordSchema
        )
    );
    if (created.status !== "created") throw new Error("Expected a created hardlink record.");
    if (!descriptor) throw new Error("Expected the producer descriptor to be captured.");

    await expectFileDescriptorClosed(descriptor.fd);
    expect(await readFile(recordPath)).toEqual(Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
    const published = await stat(recordPath, { bigint: true });
    expect(published.ino).toBe(descriptor.ino);
    expect(published.nlink).toBe(1n);
    expect(
      await conditionalDeleteJsonRecordWithCleanupPermit(
        created.cleanupPermit,
        recordPath,
        evidenceRef,
        LockRecordSchema,
        {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.lock_id === expected.lock_id
        }
      )
    ).toEqual({ status: "deleted" });
    const reusedPermit = await captureConditionalDeleteError(() =>
      conditionalDeleteJsonRecordWithCleanupPermit(
        created.cleanupPermit,
        recordPath,
        evidenceRef,
        LockRecordSchema,
        {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.lock_id === expected.lock_id
        }
      )
    );
    expect(reusedPermit.mutationPhase).toBe("pre_mutation");
    expect(reusedPermit.failureStage).toBe("permit_admission");
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

  test("repeated pre-close failures still close every descriptor and remove owned residue", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    let closeObservations = 0;
    const observedTemporaryPaths: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const record = { ...validLockRecord(), lock_id: `LOCK-pre-close-${index}` };
      await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: ({ temporaryPath }) => {
              observedTemporaryPaths.push(temporaryPath);
              throw new TaskServiceError({
                code: "workspace_path_not_safe",
                status: 500,
                category: "workspace_error",
                message: `pre-close failure ${index}`,
                userMessage: "Injected pre-close failure.",
                evidenceRefs: [lockRecordEvidenceRef(record.scope, record.lock_id)],
                recommendedNextActions: ["Inspect the fixture."]
              });
            },
            beforeTemporaryFileClose: () => {
              throw new Error(`injected close failure ${index}`);
            },
            afterTemporaryFileClosed: async ({ descriptor }) => {
              await expectFileDescriptorClosed(descriptor.fd);
              closeObservations += 1;
            }
          },
          () => createJsonRecordIfAbsent(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            lockRecordEvidenceRef(record.scope, record.lock_id),
            LockRecordSchema
          )
        )
      );
    }

    expect(closeObservations).toBe(12);
    for (const temporaryPath of observedTemporaryPaths) await expectPathMissing(temporaryPath);
    expect((await readdir(join(workspaceRoot, "locks", "task"))).some(isOwnedRecordPath)).toBe(false);
  });

  test("final hardlink acceptance rejects same-length inode mutation through a pre-opened descriptor", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-final-bound-observation" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
    let canonicalHandle: Awaited<ReturnType<typeof open>> | undefined;
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    let retryPublication: WorkspaceRecordPublicationHookInput | undefined;
    let mutationRan = false;
    try {
      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterCanonicalLink: async (input) => {
              publication = input;
              canonicalHandle = await open(input.canonicalPath, "r+");
            },
            beforePublishedRecordFinalValidation: async () => {
              if (!canonicalHandle || mutationRan) return;
              mutationRan = true;
              const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
              const mutatedBytes = Buffer.from(expectedBytes);
              mutatedBytes[0] = mutatedBytes[0] === 0x7b ? 0x5b : 0x7b;
              await canonicalHandle.write(mutatedBytes, 0, mutatedBytes.length, 0);
              await canonicalHandle.sync();
            }
          },
          () => createJsonRecordIfAbsentWithCleanupPermit(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            evidenceRef,
            LockRecordSchema
          )
        )
      );
      expect(error.code).toBe("workspace_path_not_safe");
      expect(mutationRan).toBe(true);
      expect(publication).toBeDefined();
      await expectPathMissing(publication!.canonicalPath);
      await expectPathMissing(publication!.temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
      ).toBe(false);

      const retried = await runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: (input) => {
            retryPublication = input;
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            evidenceRef,
            LockRecordSchema
          )
      );
      expect(retried.status).toBe("created");
      expect(retryPublication?.canonicalPath).toBe(publication!.canonicalPath);
      expect(await readFile(publication!.canonicalPath)).toEqual(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
      );
      expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
      await expectPathMissing(retryPublication!.temporaryPath);
    } finally {
      await canonicalHandle?.close();
    }
  });

  test("durable single-link observation binds bytes, identity, links, size, and mutation metadata", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot);
    const path = join(workspaceRoot, "durable-observation.json");
    const bytes = Buffer.from("durable-observation\n");
    await writeFile(path, bytes, { flag: "wx" });
    const expected = await lstat(path, { bigint: true });

    const observed = await readDurableSingleLinkFile({ path, maxBytes: 1024 });

    expect(observed.status).toBe("read");
    if (observed.status !== "read") throw new Error("Expected durable observation.");
    expect(observed.bytes).toEqual(bytes);
    expect(observed.identity).toEqual({ dev: expected.dev, ino: expected.ino });
    expect(observed.linkCount).toBe(1n);
    expect(observed.size).toBe(BigInt(bytes.length));
    expect(observed.mutation).toEqual({
      ctimeNs: expected.ctimeNs,
      mtimeNs: expected.mtimeNs
    });
  });

  test("owned physical identities compare exactly above Number.MAX_SAFE_INTEGER", () => {
    const dev = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const owner = { dev, ino: dev };
    const adjacentReplacement = { dev, ino: dev + 1n };

    expect(workspaceRecordPhysicalIdentityMatches(owner, { ...owner })).toBe(true);
    expect(workspaceRecordPhysicalIdentityMatches(adjacentReplacement, owner)).toBe(false);
    expect(Number(owner.ino)).toBe(Number(adjacentReplacement.ino));
  });

  test("hardlink temp cleanup rejects an identical-byte canonical replacement without transferring its permit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-temp-identical-replacement" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const displacedPath = join(tempRoot, "displaced-temp-owned-generation.json");
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    let ownedIdentity: { dev: number; ino: number } | undefined;
    let replacementIdentity: { dev: number; ino: number } | undefined;

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: (input) => {
            publication = input;
          },
          beforeAuthorityOwnedUnlink: async ({ operation }) => {
            if (operation !== "hardlink_temp_cleanup" || !publication || replacementIdentity) {
              return;
            }
            const owned = await stat(publication.canonicalPath);
            ownedIdentity = { dev: owned.dev, ino: owned.ino };
            await rename(publication.canonicalPath, displacedPath);
            await writeFile(publication.canonicalPath, expectedBytes, { flag: "wx" });
            const replacement = await stat(publication.canonicalPath);
            replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
          }
        },
        () =>
          createJsonRecordIfAbsentWithCleanupPermit(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            evidenceRef,
            LockRecordSchema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(error.message).toBe("Workspace record publication authority could not be verified.");
    expect(publication).toBeDefined();
    expect(replacementIdentity).not.toEqual(ownedIdentity);
    expect(await readFile(publication!.canonicalPath)).toEqual(expectedBytes);
    expect(await stat(publication!.canonicalPath)).toMatchObject(replacementIdentity!);
    await expectPathMissing(publication!.temporaryPath);
    expect(
      (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
    ).toBe(false);

    expect(
      await conditionalDeleteJsonRecord(
        publication!.canonicalPath,
        evidenceRef,
        LockRecordSchema,
        {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.lock_id === expected.lock_id
        }
      )
    ).toEqual({ status: "deleted" });
  });

  test("temp cleanup removes a mutated owned inode, rolls back canonical, and permits retry", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-temp-same-inode" };
    const modifiedBytes = Buffer.from("same-inode-temp-modification\n");
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    let retryPublication: WorkspaceRecordPublicationHookInput | undefined;
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
    await expectPathMissing(publication!.canonicalPath);
    await expectPathMissing(publication!.temporaryPath);
    expect(
      (await readdir(join(workspaceRoot, "locks", "task"))).some(isOwnedRecordPath)
    ).toBe(false);

    const retried = await runWithWorkspaceRecordPublicationHooks(
      {
        afterCanonicalLink: (input) => {
          retryPublication = input;
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
    );
    expect(retried.status).toBe("created");
    expect(retryPublication?.canonicalPath).toBe(publication!.canonicalPath);
    expect(await readFile(publication!.canonicalPath)).toEqual(
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
    );
    expect((await stat(publication!.canonicalPath)).nlink).toBe(1);
    await expectPathMissing(retryPublication!.temporaryPath);
  });

  test("generation unlink retries known-empty namespace cleanup and preserves bounded cleanup failures", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const directorySegments = ["namespace-cleanup"] as const;
    const directoryPath = join(workspaceRoot, ...directorySegments);

    const transient = { id: "transient" };
    await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      "transient.json",
      transient,
      "namespace.cleanup.transient",
      schema
    );
    const transientPath = join(directoryPath, "transient.json");
    const transientAttempts: number[] = [];
    const transientResult = await runWithWorkspaceRecordPublicationHooks(
      {
        beforeAuthorityNamespaceRemoval: ({ attempt }) => {
          transientAttempts.push(attempt);
          if (attempt === 1) throw new Error("transient namespace cleanup failure");
        }
      },
      () =>
        conditionalDeleteJsonRecord(
          transientPath,
          "namespace.cleanup.transient",
          schema,
          {
            kind: "record",
            expected: transient,
            matches: (current, expected) => current.id === expected.id
          }
        )
    );
    expect(transientResult).toEqual({ status: "deleted" });
    expect(transientAttempts).toEqual([1, 2]);
    expect((await readdir(directoryPath)).some(isOwnedRecordPath)).toBe(false);
    expect(
      await conditionalDeleteJsonRecord(
        transientPath,
        "namespace.cleanup.transient",
        schema,
        {
          kind: "record",
          expected: transient,
          matches: (current, expected) => current.id === expected.id
        }
      )
    ).toEqual({ status: "missing" });

    const persistent = { id: "persistent" };
    await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      "persistent.json",
      persistent,
      "namespace.cleanup.persistent",
      schema
    );
    const persistentPath = join(directoryPath, "persistent.json");
    const persistentAttempts: number[] = [];
    const persistentError = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityNamespaceRemoval: ({ attempt }) => {
            persistentAttempts.push(attempt);
            throw new Error(`persistent namespace cleanup failure ${attempt}`);
          }
        },
        () =>
          conditionalDeleteJsonRecord(
            persistentPath,
            "namespace.cleanup.persistent",
            schema,
            {
              kind: "record",
              expected: persistent,
              matches: (current, expected) => current.id === expected.id
            }
          )
      )
    );
    expect(persistentAttempts).toEqual([1, 2, 3]);
    expect(aggregateErrorMessages(persistentError)).toEqual([
      "Workspace mutation namespace cleanup did not complete.",
      "persistent namespace cleanup failure 1",
      "Workspace record publication compensation failed.",
      "persistent namespace cleanup failure 2",
      "persistent namespace cleanup failure 3"
    ]);
    await expectPathMissing(persistentPath);
    const residualNamespace = await findOnlyAuthorityNamespace(directoryPath);
    await rm(residualNamespace, { recursive: true });
    expect((await readdir(directoryPath)).some(isOwnedRecordPath)).toBe(false);
    expect(
      await conditionalDeleteJsonRecord(
        persistentPath,
        "namespace.cleanup.persistent",
        schema,
        {
          kind: "record",
          expected: persistent,
          matches: (current, expected) => current.id === expected.id
        }
      )
    ).toEqual({ status: "missing" });

    const repeated = { id: "repeated" };
    await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      "repeated.json",
      repeated,
      "namespace.cleanup.repeated",
      schema
    );
    const repeatedPath = join(directoryPath, "repeated.json");
    const repeatedFailure = new Error("same namespace cleanup failure");
    const repeatedError = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityNamespaceRemoval: () => {
            throw repeatedFailure;
          }
        },
        () =>
          conditionalDeleteJsonRecord(
            repeatedPath,
            "namespace.cleanup.repeated",
            schema,
            {
              kind: "record",
              expected: repeated,
              matches: (current, expected) => current.id === expected.id
            }
          )
      )
    );
    expect(repeatedError.cause).toBeInstanceOf(Error);
    expect((repeatedError.cause as Error).cause).toBeInstanceOf(AggregateError);
    const repeatedAggregate = (repeatedError.cause as Error).cause as AggregateError;
    expect(repeatedAggregate.errors).toHaveLength(2);
    expect(repeatedAggregate.errors).toEqual([repeatedFailure, repeatedFailure]);
    expect(aggregateErrorMessages(repeatedError)).toEqual([
      "Workspace mutation namespace cleanup did not complete.",
      "same namespace cleanup failure",
      "Workspace record publication compensation failed.",
      "same namespace cleanup failure",
      "same namespace cleanup failure"
    ]);
    await expectPathMissing(repeatedPath);
    await rm(await findOnlyAuthorityNamespace(directoryPath), { recursive: true });

    const cyclic = new AggregateError([], "cyclic compensation");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(aggregateErrorMessages(cyclic)).toEqual(["cyclic compensation"]);
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
    const record = { ...validLockRecord(), lock_id: "LOCK-persistent-temp-cleanup" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
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
            throw new Error(`injected persistent cleanup failure ${attempt}`);
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            evidenceRef,
            LockRecordSchema
          )
      )
    );

    expect(publication).toBeDefined();
    expect(error.code).toBe("workspace_path_not_safe");
    expect(error.message).toBe("Workspace record publication temporary cleanup did not complete.");
    expect(error.evidenceRefs).toEqual([evidenceRef]);
    expectErrorNotToLeakRecordContent(error, tempRoot);
    expect(attempts).toEqual([1, 2, 3]);
    expect(aggregateErrorMessages(error)).toEqual([
      "Workspace record publication temporary cleanup did not complete.",
      "Workspace record publication compensation failed.",
      "injected persistent cleanup failure 1",
      "injected persistent cleanup failure 2",
      "injected persistent cleanup failure 3"
    ]);
    await expectPathMissing(publication!.canonicalPath);
    await expectPathMissing(publication!.temporaryPath);
    expect((await stat(outsideAlias)).nlink).toBe(1);
    const repaired = await createJsonRecordIfAbsent(
      workspaceRoot,
      lockRecordDirectorySegments(record.scope),
      lockRecordFileName(record.lock_id),
      record,
      evidenceRef,
      LockRecordSchema
    );

    expect(repaired.status).toBe("created");
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
  if (index % 2 === 0) {
    return await createLockRecordService({ workspaceRoot }).getLock(record.scope, record.lock_id);
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

async function createCleanupPermitQueueFixture(label: string) {
  const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
  const schema = z.object({ id: z.string() });
  const record = { id: label };
  const evidenceRef = `cross-class-fifo.${label}`;
  const fileName = `${label}.json`;
  const path = workspaceRecordPath(workspaceRoot, ["cross-class-fifo", fileName], evidenceRef);
  const created = await createJsonRecordIfAbsentWithCleanupPermit(
    workspaceRoot, ["cross-class-fifo"], fileName, record, evidenceRef, schema
  );
  if (created.status !== "created") throw new Error("Expected cleanup permit queue fixture.");
  return {
    tempRoot, path, evidenceRef, schema, record,
    holdAuthority: () => {
      const gate = createAsyncGate();
      const acquired = createSignal();
      const completed = runWithWorkspaceRecordPublicationHooks({
        afterAuthorityLeaseAcquired: async () => { acquired.resolve(); await gate.wait; }
      }, () => readJsonRecord(path, evidenceRef, schema));
      return { acquired: acquired.promise, completed, release: () => gate.open() };
    },
    cleanup: () => conditionalDeleteJsonRecordWithCleanupPermit(
      created.cleanupPermit, path, evidenceRef, schema,
      { kind: "record", expected: record, matches: (current, expected) => current.id === expected.id }
    )
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

async function supportsDistinctCaseEntries(directoryPath: string): Promise<boolean> {
  const upperPath = join(directoryPath, "CaseSensitivityProbe");
  const lowerPath = join(directoryPath, "casesensitivityprobe");
  await writeFile(upperPath, "upper", { flag: "wx" });
  try {
    await writeFile(lowerPath, "lower", { flag: "wx" });
    const [upperIdentity, lowerIdentity] = await Promise.all([stat(upperPath), stat(lowerPath)]);
    return upperIdentity.ino !== lowerIdentity.ino;
  } catch (error) {
    if (hasTestErrorCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    await Promise.all([rm(upperPath, { force: true }), rm(lowerPath, { force: true })]);
  }
}

async function detectDistinctCaseEntriesSupport(): Promise<boolean> {
  const probeRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-case-capability-")));
  try {
    return await supportsDistinctCaseEntries(probeRoot);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function readFileWithIdentity(path: string): Promise<{ bytes: Buffer; dev: number; ino: number }> {
  const [bytes, identity] = await Promise.all([readFile(path), stat(path)]);
  return { bytes, dev: identity.dev, ino: identity.ino };
}

function hasTestErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

class StructuredServiceError extends Error {
  readonly code: string;
  readonly details: Readonly<{ surface: string; immutability: string }>;

  constructor(
    message: string,
    code: string,
    details: Readonly<{ surface: string; immutability: string }>,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "StructuredServiceError";
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code
    });
    Object.defineProperty(this, "details", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: details
    });
  }
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  throw new Error("Expected an error.");
}

function expectPreservedOwnDescriptors(
  error: Error,
  expected: Record<PropertyKey, PropertyDescriptor>
): void {
  const actual = Object.getOwnPropertyDescriptors(error);
  expect(Reflect.ownKeys(actual)).toEqual(Reflect.ownKeys(expected));
  for (const key of Reflect.ownKeys(expected)) {
    const expectedDescriptor = expected[key]!;
    const actualDescriptor = actual[key]!;
    if (key === "cause") {
      expect({ ...actualDescriptor, value: undefined }).toEqual({
        ...expectedDescriptor,
        value: undefined
      });
    } else {
      expect(actualDescriptor).toEqual(expectedDescriptor);
    }
  }
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

async function expectFileDescriptorClosed(fd: number): Promise<void> {
  const error = await captureError(
    () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        fstat(fd, (statError) => {
          if (statError) rejectPromise(statError);
          else resolvePromise();
        });
      })
  );
  expect(error).toMatchObject({ code: "EBADF" });
}

function aggregateErrorMessages(value: unknown, ancestors = new Set<unknown>()): string[] {
  if (!(value instanceof Error) || ancestors.has(value)) return [];
  ancestors.add(value);
  const messages = [value.message];
  if (value instanceof AggregateError) {
    for (const error of value.errors) {
      messages.push(...aggregateErrorMessages(error, ancestors));
    }
  }
  messages.push(...aggregateErrorMessages(value.cause, ancestors));
  ancestors.delete(value);
  return messages;
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
