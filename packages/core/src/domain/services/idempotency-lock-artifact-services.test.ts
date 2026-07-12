import { afterEach, describe, expect, test } from "bun:test";
import {
  fstat,
  fstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import {
  access,
  chmod,
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
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { ArtifactSchema } from "../schemas/artifact";
import { IdempotencyRecordSchema } from "../schemas/idempotency";
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
  runWithWorkspaceRecordCompensationTestHooks,
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
  composeDeviceBoundedCaseAlias,
  filesystemDeviceIdentityMatches,
  physicalAuthorityPathIdentity,
  physicalCanonicalPath,
  runWithWorkspacePathSafetyHooks
} from "./workspace-path-safety";
import { readDurableSingleLinkFile } from "./durable-single-link-reader";
import {
  PreservedErrorCompensationEnvelope,
  PreservedNonErrorThrownValue,
  preservePrimaryAndCompensationErrors,
  semanticPrimaryError
} from "./compensation-error-preservation";

const tempRoots: string[] = [];
const distinctCaseEntriesSupported = await detectDistinctCaseEntriesSupport();
const caseAliasWorkspaceSupported = await detectCaseAliasWorkspaceSupport();
const unicodeAuthorityPairs = Object.freeze({
  normalization: Object.freeze(["\u00c9vidence.json", "e\u0301VIDENCE.json"] as const),
  sigma: Object.freeze(["\u03a3igma.json", "\u03c2IGMA.json"] as const),
  sharpS: Object.freeze(["Stra\u00dfe.json", "STRASSE.json"] as const)
});
const unicodeCaseAliasCapabilities = await detectUnicodeCaseAliasCapabilities();
const unicodeDistinctEntryCapabilities = await detectUnicodeDistinctEntryCapabilities();

describe("idempotency, lock, and artifact services", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
    );
  });

  test("package root exposes production path-safety APIs without local test hooks", async () => {
    const coreExports = await import("@shud-harness/core");
    const packageRootEntry = join(import.meta.dir, "../../index.ts");
    const program = ts.createProgram({
      rootNames: [packageRootEntry],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022
      }
    });
    const packageRootSource = program.getSourceFile(packageRootEntry);
    expect(packageRootSource).toBeDefined();
    const packageRootSymbol = packageRootSource
      ? program.getTypeChecker().getSymbolAtLocation(packageRootSource)
      : undefined;
    expect(packageRootSymbol).toBeDefined();
    const packageRootTypeExports = new Set(
      packageRootSymbol
        ? program
            .getTypeChecker()
            .getExportsOfModule(packageRootSymbol)
            .map((symbol) => symbol.getName())
        : []
    );
    const requiredTypeExports = [
      "WorkspacePathBoundary",
      "WorkspacePathAccess",
      "WorkspacePathResolution",
      "ResolveWorkspacePathInput",
      "FilesystemCaseSemantics",
      "PhysicalAuthorityPathIdentityCandidates",
      "WorkspacePathSafetyError",
      "resolveWorkspacePath",
      "assertPathInsideWorkspace",
      "isPathInsideBoundary",
      "isSafeExistingDirectoryPath",
      "physicalCanonicalPath",
      "physicalAuthorityPathIdentity",
      "physicalAuthorityPathIdentityCandidates",
      "filesystemDeviceIdentityMatches"
    ];
    const forbiddenTypeExports = [
      "WorkspacePathSafetyHooks",
      "runWithWorkspacePathSafetyHooks",
      "WorkspaceRecordPublicationHooks",
      "runWithWorkspaceRecordPublicationHooks",
      "WorkspaceRecordCompensationTestHooks",
      "runWithWorkspaceRecordCompensationTestHooks",
      "preservePrimaryAndCompensationErrors"
    ];
    const runtimeExports = new Set(Object.keys(coreExports));
    const requiredRuntimeExports = [
      "WorkspacePathSafetyError",
      "resolveWorkspacePath",
      "assertPathInsideWorkspace",
      "isPathInsideBoundary",
      "isSafeExistingDirectoryPath",
      "physicalCanonicalPath",
      "physicalAuthorityPathIdentity",
      "physicalAuthorityPathIdentityCandidates",
      "filesystemDeviceIdentityMatches"
    ];

    expect(requiredTypeExports.filter((name) => !packageRootTypeExports.has(name))).toEqual([]);
    expect(forbiddenTypeExports.filter((name) => packageRootTypeExports.has(name))).toEqual([]);
    expect(requiredRuntimeExports.filter((name) => !runtimeExports.has(name))).toEqual([]);
    expect(runtimeExports.has("runWithWorkspacePathSafetyHooks")).toBe(false);
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

  test("mutable create and update hold shared authority against reads and conditional deletes", async () => {
    for (const mode of ["create", "update"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const before = { ...validLockRecord(), lock_id: `LOCK-mutable-authority-${mode}` };
      const after = { ...before, holder: `mutable-authority-${mode}-after` };
      if (mode === "update") await service.storeLock(before);
      const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
        evidenceRef
      );
      const writerGate = createAsyncGate();
      const writerReady = createSignal();
      const readerContended = createSignal();
      const deleteContended = createSignal();

      const writer = runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: async () => {
            writerReady.resolve();
            await writerGate.wait;
          }
        },
        () => service.storeLock(after)
      );
      await writerReady.promise;
      const reader = runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("read");
            readerContended.resolve();
          }
        },
        () => service.getLock(after.scope, after.lock_id)
      );
      const conditionalDelete = runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: ({ operation }) => {
            expect(operation).toBe("delete");
            deleteContended.resolve();
          }
        },
        () =>
          conditionalDeleteJsonRecord(recordPath, evidenceRef, LockRecordSchema, {
            kind: "record",
            expected: before,
            matches: (current, expected) => current.holder === expected.holder
          })
      );
      await Promise.all([readerContended.promise, deleteContended.promise]);
      writerGate.open();

      const [written, observed, deletion] = await Promise.all([
        writer,
        reader,
        conditionalDelete
      ]);
      expect(written).toEqual(after);
      expect(observed).toEqual(after);
      expect(deletion).toEqual({ status: "condition_not_met" });
      expect(await service.getLock(after.scope, after.lock_id)).toEqual(after);
      expect((await stat(recordPath)).nlink).toBe(1);
    }
  });

  test("mutable generation is private from creation and exact immediately before commit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const record = { ...validLockRecord(), lock_id: "LOCK-mutable-private-generation" };
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    let temporaryPath = "";
    let namespacePath = "";
    let temporaryIdentity: { dev: number; ino: number } | undefined;
    let authorityAcquired = false;
    let closedObserved = false;

    await runWithWorkspaceRecordPublicationHooks(
      {
        afterAuthorityLeaseAcquired: ({ operation }) => {
          expect(operation).toBe("rename");
          authorityAcquired = true;
        },
        afterTemporaryFileWritten: async (input) => {
          expect(authorityAcquired).toBe(true);
          temporaryPath = input.temporaryPath;
          namespacePath = dirname(temporaryPath);
          const [namespace, generation, directoryNames] = await Promise.all([
            stat(namespacePath),
            stat(temporaryPath),
            readdir(dirname(namespacePath))
          ]);
          expect(namespace.mode & 0o7777).toBe(0o700);
          expect(generation.mode & 0o7777).toBe(0o600);
          expect(generation.uid).toBe(namespace.uid);
          expect(generation.gid).toBe(namespace.gid);
          expect(generation.nlink).toBe(1);
          expect(temporaryPath.endsWith("/generation")).toBe(true);
          expect(directoryNames.some((name) => name.endsWith(".tmp"))).toBe(false);
          expect(await readFile(temporaryPath)).toEqual(expectedBytes);
          temporaryIdentity = { dev: generation.dev, ino: generation.ino };
        },
        beforeGenerationIsolation: async ({ path, operation }) => {
          if (operation !== "rename_publication") return;
          expect(path).toBe(temporaryPath);
          const rebound = await stat(path);
          expect(rebound).toMatchObject({ ...temporaryIdentity!, nlink: 1 });
          expect(await readFile(path)).toEqual(expectedBytes);
        },
        afterTemporaryFileClosed: async ({ descriptor }) => {
          await expectFileDescriptorClosed(descriptor.fd);
          closedObserved = true;
        }
      },
      () => service.storeLock(record)
    );

    expect(closedObserved).toBe(true);
    await expectPathMissing(namespacePath);
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...lockRecordDirectorySegments(record.scope), lockRecordFileName(record.lock_id)],
      lockRecordEvidenceRef(record.scope, record.lock_id)
    );
    expect(await readFile(recordPath)).toEqual(expectedBytes);
    expect(await stat(recordPath)).toMatchObject({ ...temporaryIdentity!, nlink: 1 });
  });

  test("mutable close failures prove fallback close and reject before create or update commit", async () => {
    for (const mode of ["create", "update"] as const) {
      for (const failureSite of ["pre-close", "close-observer"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const service = createLockRecordService({ workspaceRoot });
        const before = {
          ...validLockRecord(),
          lock_id: `LOCK-mutable-close-${mode}-${failureSite}`
        };
        const after = { ...before, holder: `after-${failureSite}` };
        if (mode === "update") await service.storeLock(before);
        const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
          evidenceRef
        );
        const beforeBytes = mode === "update" ? await readFile(recordPath) : undefined;
        let temporaryPath = "";
        let descriptorClosed = false;

        const error = await captureError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterTemporaryFileWritten: (input) => {
                temporaryPath = input.temporaryPath;
              },
              beforeTemporaryFileClose: () => {
                if (failureSite === "pre-close") throw new Error(`pre-close ${mode}`);
              },
              afterTemporaryFileClosed: async ({ descriptor }) => {
                await expectFileDescriptorClosed(descriptor.fd);
                descriptorClosed = true;
                if (failureSite === "close-observer") {
                  throw new Error(`close observer ${mode}`);
                }
              }
            },
            () => service.storeLock(after)
          )
        );

        expect(error.message).toBe(
          failureSite === "pre-close" ? `pre-close ${mode}` : `close observer ${mode}`
        );
        expect(descriptorClosed).toBe(true);
        if (beforeBytes) expect(await readFile(recordPath)).toEqual(beforeBytes);
        else await expectPathMissing(recordPath);
        await expectPathMissing(temporaryPath);
        expect(
          (await readdir(join(workspaceRoot, "locks", after.scope))).some(isOwnedRecordPath)
        ).toBe(false);
      }
    }
  });

  test("mutable create and update retain an undefined primary and clean exactly once", async () => {
    for (const mode of ["create", "update"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string(), value: z.string() });
      const before = { id: `mutable-undefined-${mode}`, value: "before" };
      const after = { ...before, value: "after" };
      const directorySegments = ["mutable-undefined-primary"] as const;
      const fileName = `${mode}.json`;
      const evidenceRef = `mutable.undefined.${mode}`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      if (mode === "update") {
        await writeJsonRecord(
          workspaceRoot,
          directorySegments,
          fileName,
          before,
          evidenceRef,
          schema
        );
      }
      const baseline = mode === "update" ? await readFileWithIdentity(path) : undefined;
      let temporaryPath = "";
      let cleanupCalls = 0;

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: (input) => {
              temporaryPath = input.temporaryPath;
              throw undefined;
            },
            beforeAuthorityOwnedUnlink: ({ operation }) => {
              expect(operation).toBe("rename_temp_cleanup");
              cleanupCalls += 1;
            }
          },
          () =>
            writeJsonRecord(
              workspaceRoot,
              directorySegments,
              fileName,
              after,
              evidenceRef,
              schema
            )
        )
      );

      expect(failure).toBeInstanceOf(PreservedNonErrorThrownValue);
      expect((failure as PreservedNonErrorThrownValue).thrownValue).toBeUndefined();
      expect(cleanupCalls).toBe(1);
      await expectPathMissing(temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, ...directorySegments))).some(isOwnedRecordPath)
      ).toBe(false);
      if (baseline) expect(await readFileWithIdentity(path)).toEqual(baseline);
      else await expectPathMissing(path);
    }
  });

  test("undefined mutable primary precedes later close compensation without false success", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "undefined-primary-close-compensation" };
    const directorySegments = ["undefined-primary-close-compensation"] as const;
    const fileName = "record.json";
    const evidenceRef = "undefined.primary.close.compensation";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const closeCompensation = new Error("close compensation after undefined primary");
    let temporaryPath = "";
    let cleanupCalls = 0;

    const failure = await captureError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: (input) => {
            temporaryPath = input.temporaryPath;
            throw undefined;
          },
          beforeTemporaryFileClose: () => {
            throw closeCompensation;
          },
          beforeAuthorityOwnedUnlink: () => {
            cleanupCalls += 1;
          }
        },
        () =>
          writeJsonRecord(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
      )
    );

    expect(failure).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(semanticPrimaryError(failure)).toBeInstanceOf(PreservedNonErrorThrownValue);
    expect((semanticPrimaryError(failure) as PreservedNonErrorThrownValue).thrownValue)
      .toBeUndefined();
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([undefined, closeCompensation]);
    expect(cleanupCalls).toBe(1);
    await expectPathMissing(path);
    await expectPathMissing(temporaryPath);
  });

  test("hardlink, close, and namespace slots retain undefined failures", async () => {
    const schema = z.object({ id: z.string() });

    for (const surface of ["hardlink-primary", "close-primary"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { id: surface };
      const directorySegments = ["undefined-sibling-slots"] as const;
      const fileName = `${surface}.json`;
      const evidenceRef = `undefined.sibling.${surface}`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      let temporaryPath = "";
      let cleanupCalls = 0;
      let closeObserverCalls = 0;

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: (input) => {
              temporaryPath = input.temporaryPath;
              if (surface === "hardlink-primary") throw undefined;
            },
            beforeTemporaryFileClose: () => {
              if (surface === "close-primary") throw undefined;
            },
            afterTemporaryFileClosed: async ({ descriptor }) => {
              closeObserverCalls += 1;
              await expectFileDescriptorClosed(descriptor.fd);
            },
            beforeAuthorityOwnedUnlink: ({ operation }) => {
              expect(operation).toBe("hardlink_temp_cleanup");
              cleanupCalls += 1;
            }
          },
          () =>
            createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
        )
      );

      expect(semanticPrimaryError(failure)).toBeInstanceOf(PreservedNonErrorThrownValue);
      expect((semanticPrimaryError(failure) as PreservedNonErrorThrownValue).thrownValue)
        .toBeUndefined();
      expect(closeObserverCalls).toBe(1);
      expect(cleanupCalls).toBe(1);
      await expectPathMissing(path);
      await expectPathMissing(temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, ...directorySegments))).some(isOwnedRecordPath)
      ).toBe(false);
    }

    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { id: "namespace-primary" };
    const directorySegments = ["undefined-namespace-slot"] as const;
    const fileName = "record.json";
    const evidenceRef = "undefined.sibling.namespace";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      fileName,
      record,
      evidenceRef,
      schema
    );
    const laterFailures = [
      new Error("namespace cleanup attempt two"),
      new Error("namespace cleanup attempt three")
    ];
    const attempts: number[] = [];
    const namespaceFailure = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityNamespaceRemoval: ({ attempt }) => {
            attempts.push(attempt);
            if (attempt === 1) throw undefined;
            throw laterFailures[attempt - 2];
          }
        },
        () =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(attempts).toEqual([1, 2, 3]);
    const representedPrimary = findErrorNode(
      namespaceFailure,
      (error) => error instanceof PreservedNonErrorThrownValue
    ) as PreservedNonErrorThrownValue | undefined;
    expect(representedPrimary).toBeDefined();
    expect(representedPrimary!.thrownValue).toBeUndefined();
    const compensationEnvelope = findErrorNode(
      namespaceFailure,
      (error) => error instanceof PreservedErrorCompensationEnvelope
    ) as PreservedErrorCompensationEnvelope | undefined;
    expect(compensationEnvelope).toBeDefined();
    expect(compensationEnvelope!.semanticPrimary).toBe(representedPrimary!);
    expect((compensationEnvelope!.cause as AggregateError).errors).toEqual([
      undefined,
      ...laterFailures
    ]);
    await expectPathMissing(path);
    expect(await readdir(join(workspaceRoot, ...directorySegments))).toHaveLength(1);
  });

  test("mutable replacement and same-length drift preserve the old generation and cleanly retry", async () => {
    for (const failure of ["replacement", "same-length-drift"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const before = { ...validLockRecord(), lock_id: `LOCK-mutable-rebind-${failure}` };
      const after = { ...before, holder: `after-${failure}` };
      await service.storeLock(before);
      const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
        evidenceRef
      );
      const beforeGeneration = await readFileWithIdentity(recordPath);
      let temporaryPath = "";
      let ownedTemporaryIdentity: { dev: number; ino: number } | undefined;
      let replacementGeneration: { bytes: Buffer; dev: number; ino: number } | undefined;

      await expect(
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: async (input) => {
              temporaryPath = input.temporaryPath;
              const owned = await stat(temporaryPath);
              ownedTemporaryIdentity = { dev: owned.dev, ino: owned.ino };
            },
            beforeGenerationIsolation: async ({ path, operation }) => {
              if (operation !== "rename_publication") return;
              if (failure === "replacement") {
                const replacementPath = join(dirname(path), "replacement");
                const replacementBytes = Buffer.from("unowned mutable replacement\n");
                await writeFile(replacementPath, replacementBytes, { flag: "wx", mode: 0o600 });
                await rename(replacementPath, path);
                replacementGeneration = await readFileWithIdentity(path);
                expect(replacementGeneration.bytes).toEqual(replacementBytes);
                expect(
                  replacementGeneration.dev === ownedTemporaryIdentity!.dev &&
                    replacementGeneration.ino === ownedTemporaryIdentity!.ino
                ).toBe(false);
                return;
              }
              const bytes = await readFile(path);
              bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
              const handle = await open(path, "r+");
              try {
                await handle.write(bytes, 0, bytes.length, 0);
                await handle.sync();
              } finally {
                await handle.close();
              }
            }
          },
          () => service.storeLock(after)
        )
      ).rejects.toBeInstanceOf(TaskServiceError);

      expect(await readFileWithIdentity(recordPath)).toEqual(beforeGeneration);
      if (failure === "replacement") {
        expect(await readFileWithIdentity(temporaryPath)).toEqual(replacementGeneration!);
        await expectPrivateAuthorityDirectory(dirname(temporaryPath));
        expect(
          (await readdir(join(workspaceRoot, "locks", after.scope))).filter(isOwnedRecordPath)
        ).toHaveLength(1);
      } else {
        expect((await readFile(temporaryPath)).equals(Buffer.from(`${JSON.stringify(after, null, 2)}\n`))).toBe(false);
        await expectPrivateAuthorityDirectory(dirname(temporaryPath));
        expect(
          (await readdir(join(workspaceRoot, "locks", after.scope))).filter(isOwnedRecordPath)
        ).toHaveLength(1);
      }

      expect(await service.storeLock(after)).toEqual(after);
      const expectedBytes = Buffer.from(`${JSON.stringify(after, null, 2)}\n`);
      expect(await readFile(recordPath)).toEqual(expectedBytes);
      expect((await stat(recordPath)).nlink).toBe(1);
      if (failure === "replacement") {
        expect(await readFileWithIdentity(temporaryPath)).toEqual(replacementGeneration!);
        await expectPrivateAuthorityDirectory(dirname(temporaryPath));
      } else {
        expect(await readFile(temporaryPath)).toBeDefined();
      }
    }
  });

  test("mutable compensation preserves a frozen custom error contract and aggregates once", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-mutable-custom-primary" };
    const priorCause = new Error("mutable custom prior cause");
    const primary = new StructuredServiceError(
      "mutable custom primary",
      "E_MUTABLE_CUSTOM",
      Object.freeze({ surface: "workspace", immutability: "frozen" }),
      priorCause
    );
    Object.freeze(primary);
    const descriptors = Object.getOwnPropertyDescriptors(primary);
    const compensation = new Error("mutable close compensation");
    let temporaryPath = "";

    const error = await captureError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: (input) => {
            temporaryPath = input.temporaryPath;
            throw primary;
          },
          beforeTemporaryFileClose: () => {
            throw compensation;
          },
          afterTemporaryFileClosed: async ({ descriptor }) => {
            await expectFileDescriptorClosed(descriptor.fd);
          }
        },
        () =>
          writeJsonRecord(
            workspaceRoot,
            lockRecordDirectorySegments(record.scope),
            lockRecordFileName(record.lock_id),
            record,
            lockRecordEvidenceRef(record.scope, record.lock_id),
            LockRecordSchema
          )
      )
    );

    expect(error).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(error).not.toBeInstanceOf(StructuredServiceError);
    expect(semanticPrimaryError(error)).toBe(primary);
    expect(Object.getPrototypeOf(primary)).toBe(StructuredServiceError.prototype);
    expectPreservedOwnDescriptors(primary, descriptors);
    expect(Object.isFrozen(primary)).toBe(true);
    expect(Object.isSealed(primary)).toBe(true);
    expect(Object.isExtensible(primary)).toBe(false);
    expect(Reflect.defineProperty(primary, "unexpected", { value: true })).toBe(false);
    expect(Object.hasOwn(primary, "unexpected")).toBe(false);
    const messages = aggregateErrorMessages(error.cause);
    expect(messages.filter((message) => message === priorCause.message)).toHaveLength(1);
    expect(messages.filter((message) => message === compensation.message)).toHaveLength(1);
    await expectPathMissing(temporaryPath);
    expect(
      (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
    ).toBe(false);
  });

  test("mutable and hardlink close compensation remains flat through later cleanup failure", async () => {
    for (const surface of ["mutable-create", "mutable-update", "hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string(), value: z.string() });
      const before = { id: `flat-close-${surface}`, value: "before" };
      const after = { ...before, value: "after" };
      const directorySegments = ["flat-close-compensation"] as const;
      const fileName = `${surface}.json`;
      const evidenceRef = `flat.close.${surface}`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      if (surface === "mutable-update") {
        await writeJsonRecord(
          workspaceRoot,
          directorySegments,
          fileName,
          before,
          evidenceRef,
          schema
        );
      }
      const baseline = surface === "mutable-update" ? await readFileWithIdentity(path) : undefined;
      const primary = new StructuredServiceError(
        `flat close primary ${surface}`,
        `E_FLAT_CLOSE_${surface.toUpperCase().replace("-", "_")}`,
        Object.freeze({ surface, immutability: "frozen" }),
        undefined
      );
      Object.freeze(primary);
      const descriptors = Object.getOwnPropertyDescriptors(primary);
      const closeObserverFailure = new Error(`flat close observer ${surface}`);
      const cleanupFailure = new Error(`flat later cleanup ${surface}`);
      let temporaryPath = "";
      let closeObserverCalls = 0;
      let cleanupCalls = 0;

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: (input) => {
              temporaryPath = input.temporaryPath;
            },
            beforeTemporaryFileClose: () => {
              throw primary;
            },
            afterTemporaryFileClosed: async ({ descriptor }) => {
              closeObserverCalls += 1;
              await expectFileDescriptorClosed(descriptor.fd);
              throw closeObserverFailure;
            },
            beforeAuthorityOwnedUnlink: () => {
              cleanupCalls += 1;
              throw cleanupFailure;
            }
          },
          () =>
            surface === "hardlink"
              ? createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  after,
                  evidenceRef,
                  schema
                )
              : writeJsonRecord(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  after,
                  evidenceRef,
                  schema
                )
        )
      );

      expect(failure).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      expect(failure).not.toBeInstanceOf(StructuredServiceError);
      expect(semanticPrimaryError(failure)).toBe(primary);
      expect(Object.getPrototypeOf(primary)).toBe(StructuredServiceError.prototype);
      expectPreservedOwnDescriptors(primary, descriptors);
      expect(Object.isFrozen(primary)).toBe(true);
      expect(Object.isSealed(primary)).toBe(true);
      expect(Object.isExtensible(primary)).toBe(false);
      expect(failure.cause).toBeInstanceOf(AggregateError);
      const rawSlots = (failure.cause as AggregateError).errors;
      expect(rawSlots).toHaveLength(surface === "hardlink" ? 5 : 6);
      expect(rawSlots[0]).toBe(closeObserverFailure);
      expect(rawSlots[1]).toBeInstanceOf(TaskServiceError);
      expect(rawSlots[1]).toMatchObject({
        code: "workspace_path_not_safe",
        message: "Workspace record publication temporary cleanup did not complete."
      });
      expect(rawSlots.slice(2, 5)).toEqual([cleanupFailure, cleanupFailure, cleanupFailure]);
      if (surface !== "hardlink") {
        expect(rawSlots[5]).toMatchObject({
          code: "workspace_path_not_safe",
          message: "Workspace record publication authority could not be verified."
        });
      }
      expect(countErrorNodes(failure, (error) => error instanceof AggregateError)).toBe(1);
      expect(closeObserverCalls).toBe(1);
      expect(cleanupCalls).toBe(3);
      await expectPathMissing(temporaryPath);
      expect((await readdir(join(workspaceRoot, ...directorySegments))).some(isOwnedRecordPath)).toBe(
        false
      );
      if (baseline) expect(await readFileWithIdentity(path)).toEqual(baseline);
      else await expectPathMissing(path);

      const retried =
        surface === "hardlink"
          ? await createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              after,
              evidenceRef,
              schema
            )
          : await writeJsonRecord(
              workspaceRoot,
              directorySegments,
              fileName,
              after,
              evidenceRef,
              schema
            );
      expect(retried).toEqual(
        surface === "hardlink" ? { status: "created", record: after } : after
      );
      expect(await readFile(path)).toEqual(Buffer.from(`${JSON.stringify(after, null, 2)}\n`));
      expect((await stat(path, { bigint: true })).nlink).toBe(1n);
    }
  });

  test("publication compensation retains an undefined cleanup failure on a frozen primary", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-mutable-custom-primary" };
    const priorCause = new Error("mutable custom prior cause");
    const primary = new StructuredServiceError(
      "mutable custom primary",
      "E_MUTABLE_CUSTOM",
      Object.freeze({ surface: "workspace", immutability: "frozen" }),
      priorCause
    );
    Object.freeze(primary);
    const descriptors = Object.getOwnPropertyDescriptors(primary);
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...lockRecordDirectorySegments(record.scope), lockRecordFileName(record.lock_id)],
      evidenceRef
    );
    let temporaryPath = "";

    const error = await captureError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: (input) => {
            temporaryPath = input.temporaryPath;
            throw primary;
          },
          afterTemporaryFileClosed: async ({ descriptor }) => {
            await expectFileDescriptorClosed(descriptor.fd);
          },
          beforePublicationCompensationStateInspection: ({ site }) => {
            expect(site).toBe("unpublished_cleanup");
            throw undefined;
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

    expect(error).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(error).not.toBeInstanceOf(StructuredServiceError);
    expect(semanticPrimaryError(error)).toBe(primary);
    expect(Object.getPrototypeOf(primary)).toBe(StructuredServiceError.prototype);
    expectPreservedOwnDescriptors(primary, descriptors);
    expect(Object.isFrozen(primary)).toBe(true);
    expect(Object.isSealed(primary)).toBe(true);
    expect(Object.isExtensible(primary)).toBe(false);
    expect(Reflect.defineProperty(primary, "unexpected", { value: true })).toBe(false);
    expect(Object.hasOwn(primary, "unexpected")).toBe(false);
    expect(error.cause).toBeInstanceOf(AggregateError);
    const aggregateErrors = (error.cause as AggregateError).errors;
    expect(aggregateErrors).toHaveLength(2);
    expect(aggregateErrors[0]).toBe(priorCause);
    expect(aggregateErrors[1]).toBeUndefined();
    expect(aggregateErrors.filter((entry) => entry instanceof AggregateError)).toHaveLength(0);
    await expectPathMissing(temporaryPath);
    await expectPathMissing(recordPath);
    expect(
      (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
    ).toBe(false);
  });

  test("mutable final precommit rejects private mode drift and cleanly retries", async () => {
    for (const mode of ["create", "update"] as const) {
      for (const drift of ["generation", "namespace"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const service = createLockRecordService({ workspaceRoot });
        const before = {
          ...validLockRecord(),
          lock_id: `LOCK-mutable-mode-${mode}-${drift}`
        };
        const after = { ...before, holder: `after-${drift}` };
        if (mode === "update") await service.storeLock(before);
        const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
          evidenceRef
        );
        const beforeBytes = mode === "update" ? await readFile(recordPath) : undefined;
        let temporaryPath = "";
        let closedDescriptor: number | undefined;

        const error = await captureTaskServiceError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterTemporaryFileWritten: ({ temporaryPath: observedPath }) => {
                temporaryPath = observedPath;
              },
              afterTemporaryFileClosed: async ({ descriptor }) => {
                closedDescriptor = descriptor.fd;
                await expectFileDescriptorClosed(descriptor.fd);
                await chmod(
                  drift === "generation" ? temporaryPath : dirname(temporaryPath),
                  drift === "generation" ? 0o644 : 0o755
                );
              }
            },
            () => service.storeLock(after)
          )
        );

        expect(error.code).toBe("workspace_path_not_safe");
        expect(closedDescriptor).toBeDefined();
        if (beforeBytes) expect(await readFile(recordPath)).toEqual(beforeBytes);
        else await expectPathMissing(recordPath);
        if (drift === "generation") {
          expect((await stat(temporaryPath)).mode & 0o777).toBe(0o644);
          expect(
            (await readdir(join(workspaceRoot, "locks", after.scope))).filter(isOwnedRecordPath)
          ).toHaveLength(1);
        } else {
          await expectPathMissing(temporaryPath);
          expect(
            (await readdir(join(workspaceRoot, "locks", after.scope))).some(isOwnedRecordPath)
          ).toBe(false);
        }

        expect(await service.storeLock(after)).toEqual(after);
        expect(await readFile(recordPath)).toEqual(
          Buffer.from(`${JSON.stringify(after, null, 2)}\n`)
        );
      }
    }
  });

  test("mutable private generations and namespaces reject every special bit at written and closed boundaries", async () => {
    for (const mode of ["create", "update"] as const) {
      for (const boundary of ["written", "closed"] as const) {
        for (const target of ["generation", "namespace"] as const) {
          for (const specialBit of [0o4000, 0o2000, 0o1000] as const) {
            const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
            tempRoots.push(tempRoot);
            const service = createLockRecordService({ workspaceRoot });
            const before = {
              ...validLockRecord(),
              lock_id: `LOCK-special-${mode}-${boundary}-${target}-${specialBit.toString(8)}`
            };
            const after = { ...before, holder: `after-${target}-${specialBit.toString(8)}` };
            if (mode === "update") await service.storeLock(before);
            const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
            const recordPath = workspaceRecordPath(
              workspaceRoot,
              [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
              evidenceRef
            );
            const oldCanonical =
              mode === "update" ? await readFileWithIdentity(recordPath) : undefined;
            let temporaryPath = "";
            let mutatedPath = "";
            const expectedMode = specialBit | (target === "generation" ? 0o600 : 0o700);
            const mutate = async (): Promise<void> => {
              mutatedPath = target === "generation" ? temporaryPath : dirname(temporaryPath);
              await chmodIncludingSpecialBits(mutatedPath, expectedMode);
              expect((await stat(mutatedPath)).mode & 0o7777).toBe(expectedMode);
            };

            const error = await captureTaskServiceError(() =>
              runWithWorkspaceRecordPublicationHooks(
                {
                  afterTemporaryFileWritten: async ({ temporaryPath: observedPath }) => {
                    temporaryPath = observedPath;
                    if (boundary === "written") await mutate();
                  },
                  afterTemporaryFileClosed: async ({ descriptor }) => {
                    await expectFileDescriptorClosed(descriptor.fd);
                    if (boundary === "closed") await mutate();
                  }
                },
                () => service.storeLock(after)
              )
            );

            expect(error.code).toBe("workspace_path_not_safe");
            expect(aggregateErrorMessages(error)).toContain(
              "Workspace record publication authority could not be verified."
            );
            if (oldCanonical) expect(await readFileWithIdentity(recordPath)).toEqual(oldCanonical);
            else await expectPathMissing(recordPath);
            if (target === "generation") {
              expect((await stat(mutatedPath)).mode & 0o7777).toBe(expectedMode);
              await expectPrivateAuthorityDirectory(dirname(mutatedPath));
            } else {
              await expectPathMissing(mutatedPath);
            }

            expect(await service.storeLock(after)).toEqual(after);
            expect(await service.getLock(after.scope, after.lock_id)).toEqual(after);
          }
        }
      }
    }
  });

  test("mutable final precommit rejects namespace and parent rebind without touching external physical state", async () => {
    for (const mode of ["create", "update"] as const) {
      for (const rebind of ["namespace", "parent"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const service = createLockRecordService({ workspaceRoot });
        const before = {
          ...validLockRecord(),
          lock_id: `LOCK-mutable-rebind-${mode}-${rebind}`
        };
        const after = { ...before, holder: `after-${rebind}` };
        if (mode === "update") await service.storeLock(before);
        const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
          evidenceRef
        );
        const recordDirectory = dirname(recordPath);
        const beforeBytes = mode === "update" ? await readFile(recordPath) : undefined;
        const externalPhysicalPath = join(tempRoot, `external-${mode}-${rebind}`);
        let temporaryPath = "";
        let producerNamespaceName = "";
        let reboundPath = "";
        let externalGenerationBytes: Buffer | undefined;
        let closedDescriptor: number | undefined;

        const error = await captureTaskServiceError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterTemporaryFileWritten: ({ temporaryPath: observedPath }) => {
                temporaryPath = observedPath;
                producerNamespaceName = basename(dirname(observedPath));
              },
              afterTemporaryFileClosed: async ({ descriptor }) => {
                closedDescriptor = descriptor.fd;
                await expectFileDescriptorClosed(descriptor.fd);
                reboundPath = rebind === "namespace" ? dirname(temporaryPath) : recordDirectory;
                await rename(reboundPath, externalPhysicalPath);
                externalGenerationBytes = await readFile(
                  rebind === "namespace"
                    ? join(externalPhysicalPath, "generation")
                    : join(externalPhysicalPath, producerNamespaceName, "generation")
                );
                await symlink(externalPhysicalPath, reboundPath, "dir");
              }
            },
            () => service.storeLock(after)
          )
        );

        expect(error.code).toBe("workspace_path_not_safe");
        expect(closedDescriptor).toBeDefined();
        const externalGenerationPath =
          rebind === "namespace"
            ? join(externalPhysicalPath, "generation")
            : join(externalPhysicalPath, producerNamespaceName, "generation");
        expect(await readFile(externalGenerationPath)).toEqual(externalGenerationBytes!);
        const externalCanonicalPath = join(externalPhysicalPath, lockRecordFileName(after.lock_id));
        if (rebind === "parent" && beforeBytes) {
          expect(await readFile(externalCanonicalPath)).toEqual(beforeBytes);
        } else {
          await expectPathMissing(externalCanonicalPath);
        }
        if (rebind === "namespace" && beforeBytes) {
          expect(await readFile(recordPath)).toEqual(beforeBytes);
        }

        await rm(reboundPath);
        await rename(externalPhysicalPath, reboundPath);
        await rm(dirname(temporaryPath), { recursive: true });
        if (beforeBytes) expect(await readFile(recordPath)).toEqual(beforeBytes);
        else await expectPathMissing(recordPath);

        expect(await service.storeLock(after)).toEqual(after);
        expect(await readFile(recordPath)).toEqual(
          Buffer.from(`${JSON.stringify(after, null, 2)}\n`)
        );
      }
    }
  });

  test("mutable authority binds create and update to the pre-hook physical record directory", async () => {
    for (const mode of ["create", "update"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const before = { ...validLockRecord(), lock_id: `LOCK-pre-hook-parent-${mode}` };
      const after = { ...before, holder: `after-${mode}` };
      if (mode === "update") await service.storeLock(before);
      const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
        evidenceRef
      );
      const recordDirectory = dirname(recordPath);
      const displacedDirectory = join(tempRoot, `displaced-record-directory-${mode}`);
      const replacementSentinel = join(recordDirectory, "replacement-sentinel");
      const oldSentinel = join(recordDirectory, "old-sentinel");
      await mkdir(recordDirectory, { recursive: true });
      await writeFile(oldSentinel, "old physical directory");

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: async ({ operation }) => {
              if (operation !== "rename") return;
              await rename(recordDirectory, displacedDirectory);
              await mkdir(recordDirectory);
              await writeFile(replacementSentinel, "replacement physical directory");
            }
          },
          () => service.storeLock(after)
        )
      );

      expect(error.code).toBe("workspace_path_not_safe");
      expect(await readFile(join(displacedDirectory, "old-sentinel"), "utf8")).toBe(
        "old physical directory"
      );
      expect(await readFile(replacementSentinel, "utf8")).toBe(
        "replacement physical directory"
      );
      if (mode === "update") {
        expect(
          JSON.parse(await readFile(join(displacedDirectory, basename(recordPath)), "utf8"))
        ).toEqual(before);
      }
      await expectPathMissing(recordPath);

      await rm(recordDirectory, { recursive: true });
      await rename(displacedDirectory, recordDirectory);
      expect(await service.storeLock(after)).toEqual(after);
      expect(await service.getLock(after.scope, after.lock_id)).toEqual(after);
    }
  });

  test("hardlink afterAuthorityLeaseAcquired rejects direct parent replacement before namespace creation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "hardlink-lease-parent-replacement" };
    const evidenceRef = "hardlink.lease.parent-replacement";
    const directorySegments = ["hardlink-lease-parent-replacement"] as const;
    const fileName = "record.json";
    const canonicalPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const parentPath = dirname(canonicalPath);
    const displacedParent = join(tempRoot, "hardlink-lease-displaced-parent");
    const displacedSentinel = join(displacedParent, "displaced-sentinel");
    const replacementSentinel = join(parentPath, "replacement-sentinel");
    await mkdir(parentPath, { recursive: true });
    await writeFile(join(parentPath, "displaced-sentinel"), "displaced tree");

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterAuthorityLeaseAcquired: async ({ operation }) => {
            if (operation !== "hardlink") return;
            await rename(parentPath, displacedParent);
            await mkdir(parentPath);
            await writeFile(replacementSentinel, "replacement tree");
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(await readFile(displacedSentinel, "utf8")).toBe("displaced tree");
    expect(await readFile(replacementSentinel, "utf8")).toBe("replacement tree");
    await expectPathMissing(canonicalPath);
    await expectPathMissing(join(displacedParent, fileName));
    expect((await readdir(parentPath)).some(isOwnedRecordPath)).toBe(false);
    expect((await readdir(displacedParent)).some(isOwnedRecordPath)).toBe(false);

    await rm(parentPath, { recursive: true });
    await rename(displacedParent, parentPath);
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
  });

  test("beforeAuthorityNamespaceCreation rejects direct parent replacement without a transient canonical", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "namespace-creation-parent-replacement" };
    const evidenceRef = "namespace.creation.parent-replacement";
    const directorySegments = ["namespace-creation-parent-replacement"] as const;
    const fileName = "record.json";
    const canonicalPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
    const parentPath = dirname(canonicalPath);
    const displacedParent = join(tempRoot, "namespace-creation-displaced-parent");
    const canonicalBefore = await readFileWithIdentity(canonicalPath);
    const replacementSentinel = join(parentPath, "replacement-sentinel");
    let proposedNamespace = "";

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeAuthorityNamespaceCreation: async ({ path }) => {
            proposedNamespace = path;
            await rename(parentPath, displacedParent);
            await mkdir(parentPath);
            await writeFile(replacementSentinel, "replacement tree");
          }
        },
        () =>
          conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(await readFileWithIdentity(join(displacedParent, fileName))).toEqual(canonicalBefore);
    expect(await readFile(replacementSentinel, "utf8")).toBe("replacement tree");
    await expectPathMissing(canonicalPath);
    await expectPathMissing(proposedNamespace);
    expect((await readdir(displacedParent)).some(isOwnedRecordPath)).toBe(false);
    expect((await readdir(parentPath)).some(isOwnedRecordPath)).toBe(false);

    await rm(parentPath, { recursive: true });
    await rename(displacedParent, parentPath);
    expect(
      await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
  });

  test("cleanup-permit delete afterAuthorityLeaseAcquired rejects direct parent and canonical rebinds", async () => {
    for (const rebind of ["parent", "canonical"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `cleanup-permit-lease-${rebind}` };
      const replacement = { id: `cleanup-permit-replacement-${rebind}` };
      const evidenceRef = `cleanup-permit.lease.${rebind}`;
      const directorySegments = [`cleanup-permit-lease-${rebind}`] as const;
      const fileName = "record.json";
      const canonicalPath = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected cleanup permit fixture.");
      const parentPath = dirname(canonicalPath);
      const displacedPath =
        rebind === "parent"
          ? join(tempRoot, "cleanup-permit-displaced-parent")
          : join(tempRoot, "cleanup-permit-displaced-canonical.json");
      const canonicalBefore = await readFileWithIdentity(canonicalPath);
      const canonicalPhysicalBefore = await readOwnedFileState(canonicalPath);
      const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);

      const failure = await captureConditionalDeleteError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterAuthorityLeaseAcquired: async ({ operation }) => {
              if (operation !== "delete") return;
              if (rebind === "parent") {
                await rename(parentPath, displacedPath);
                await mkdir(parentPath);
                await rename(join(displacedPath, fileName), canonicalPath);
              } else {
                await rename(canonicalPath, displacedPath);
                await writeFile(canonicalPath, replacementBytes, { flag: "wx", mode: 0o600 });
              }
            }
          },
          () =>
            conditionalDeleteJsonRecordWithCleanupPermit(
              created.cleanupPermit,
              canonicalPath,
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

      expect(failure.mutationPhase).toBe("pre_mutation");
      expect(failure.failureStage).toBe("operation");
      if (rebind === "parent") {
        expect(await readOwnedFileState(canonicalPath)).toEqual(canonicalPhysicalBefore);
        await expectPathMissing(join(displacedPath, fileName));
      } else {
        expect(await readFile(canonicalPath)).toEqual(replacementBytes);
        expect(await readFile(displacedPath)).toEqual(canonicalBefore.bytes);
      }
      expect((await readdir(parentPath)).some(isOwnedRecordPath)).toBe(false);
      expect((await readdir(rebind === "parent" ? displacedPath : parentPath)).some(isOwnedRecordPath))
        .toBe(false);

      if (rebind === "parent") {
        await rename(canonicalPath, join(displacedPath, fileName));
        await rmdir(parentPath);
        await rename(displacedPath, parentPath);
      } else {
        await rm(canonicalPath);
        await rename(displacedPath, canonicalPath);
      }
      expect(
        await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("read and ordinary delete retain pre-hook parent and canonical authority", async () => {
    for (const operation of ["read", "delete"] as const) {
      for (const rebound of ["parent", "canonical"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const original = { id: `${operation}-${rebound}-original` };
        const replacement = { id: `${operation}-${rebound}-replacement` };
        const evidenceRef = `authority.${operation}.${rebound}`;
        const directorySegments = ["lease-hook-authority", operation, rebound] as const;
        const fileName = "record.json";
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            original,
            evidenceRef,
            schema
          )
        ).toEqual({ status: "created", record: original });
        const parentPath = dirname(recordPath);
        const displacedPath =
          rebound === "parent" ? `${parentPath}.displaced` : `${recordPath}.displaced`;
        const originalBytes = await readFile(recordPath);
        const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
        let hookRan = false;

        const failure = await captureTaskServiceError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterAuthorityLeaseAcquired: async ({ operation: observedOperation }) => {
                if (observedOperation !== operation || hookRan) return;
                hookRan = true;
                if (rebound === "parent") {
                  await rename(parentPath, displacedPath);
                  await mkdir(parentPath);
                } else {
                  await rename(recordPath, displacedPath);
                }
                await writeFile(recordPath, replacementBytes, { flag: "wx", mode: 0o600 });
              }
            },
            () =>
              operation === "read"
                ? readJsonRecord(recordPath, evidenceRef, schema)
                : conditionalDeleteJsonRecord(recordPath, evidenceRef, schema, {
                    kind: "record",
                    expected: original,
                    matches: (current, expected) => current.id === expected.id
                  })
          )
        );

        expect(failure.code).toBe("workspace_path_not_safe");
        expect(hookRan).toBe(true);
        expect(await readFile(recordPath)).toEqual(replacementBytes);
        expect(
          await readFile(
            rebound === "parent" ? join(displacedPath, fileName) : displacedPath
          )
        ).toEqual(originalBytes);

        await rm(recordPath);
        if (rebound === "parent") {
          await rmdir(parentPath);
          await rename(displacedPath, parentPath);
        } else {
          await rename(displacedPath, recordPath);
        }

        if (operation === "read") {
          expect(await readJsonRecord(recordPath, evidenceRef, schema)).toEqual(original);
        } else {
          expect(
            await conditionalDeleteJsonRecord(recordPath, evidenceRef, schema, {
              kind: "record",
              expected: original,
              matches: (current, expected) => current.id === expected.id
            })
          ).toEqual({ status: "deleted" });
          await expectPathMissing(recordPath);
        }
      }
    }
  });

  test("read final authority proof covers synchronous schema evaluation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { id: "schema-evaluation-original" };
    const replacement = { id: "schema-evaluation-replacement" };
    const evidenceRef = "authority.read.schema-evaluation";
    const directorySegments = ["read-schema-evaluation"] as const;
    const fileName = "record.json";
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const displacedPath = `${recordPath}.displaced`;
    const schema = z.object({ id: z.string() });
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
    const originalBytes = await readFile(recordPath);
    const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
    let schemaEvaluated = false;
    const mutatingSchema = schema.superRefine(() => {
      if (schemaEvaluated) return;
      schemaEvaluated = true;
      renameSync(recordPath, displacedPath);
      writeFileSync(recordPath, replacementBytes, { flag: "wx", mode: 0o600 });
    });

    const error = await captureTaskServiceError(() =>
      readJsonRecord(recordPath, evidenceRef, mutatingSchema)
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(schemaEvaluated).toBe(true);
    expect(await readFile(recordPath)).toEqual(replacementBytes);
    expect(await readFile(displacedPath)).toEqual(originalBytes);
  });

  test("read schema exits reject parent authority drift with a preserved canonical generation", async () => {
    for (const parentDrift of ["symlink", "rebound"] as const) {
      for (const schemaExit of ["success", "invalid", "throw"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const record = { id: `schema-parent-${parentDrift}-${schemaExit}` };
        const evidenceRef = `authority.read.schema-parent.${parentDrift}.${schemaExit}`;
        const directorySegments = ["read-schema-parent", parentDrift, schemaExit] as const;
        const fileName = "record.json";
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const baseSchema = z.object({ id: z.string() });
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            baseSchema
          )
        ).toEqual({ status: "created", record });
        const parentPath = dirname(recordPath);
        const displacedParent = `${parentPath}.displaced`;
        const canonicalBefore = await readFileWithIdentity(recordPath);
        const schemaMarker = new Error(`schema marker ${parentDrift} ${schemaExit}`);
        let schemaEvaluated = false;
        const mutatingSchema = baseSchema.superRefine((_value, context) => {
          if (!schemaEvaluated) {
            schemaEvaluated = true;
            renameSync(parentPath, displacedParent);
            if (parentDrift === "symlink") {
              symlinkSync(displacedParent, parentPath, "dir");
            } else {
              mkdirSync(parentPath);
              renameSync(join(displacedParent, fileName), recordPath);
            }
          }
          if (schemaExit === "invalid") {
            context.addIssue({ code: "custom", message: "injected schema issue" });
          } else if (schemaExit === "throw") {
            throw schemaMarker;
          }
        });

        const failure = await captureTaskServiceError(() =>
          readJsonRecord(recordPath, evidenceRef, mutatingSchema)
        );

        expect(failure.code).toBe("workspace_path_not_safe");
        expect(schemaEvaluated).toBe(true);
        expect(await readFileWithIdentity(recordPath)).toEqual(canonicalBefore);
        if (schemaExit === "invalid") {
          expect(
            findErrorNode(
              failure,
              (error) => error instanceof TaskServiceError && error.code === "record_schema_error"
            )
          ).toBeInstanceOf(TaskServiceError);
        } else if (schemaExit === "throw") {
          expect(errorTreeContains(failure, schemaMarker)).toBe(true);
        }
      }
    }
  });

  test("read failed schema exits reject a replaced canonical leaf", async () => {
    for (const schemaExit of ["invalid", "throw"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { id: `schema-leaf-${schemaExit}-original` };
      const replacement = { id: `schema-leaf-${schemaExit}-replacement` };
      const evidenceRef = `authority.read.schema-leaf.${schemaExit}`;
      const directorySegments = ["read-schema-leaf", schemaExit] as const;
      const fileName = "record.json";
      const recordPath = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const displacedPath = `${recordPath}.displaced`;
      const baseSchema = z.object({ id: z.string() });
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          baseSchema
        )
      ).toEqual({ status: "created", record });
      const originalBytes = await readFile(recordPath);
      const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
      const schemaMarker = new Error(`schema leaf marker ${schemaExit}`);
      const mutatingSchema = baseSchema.superRefine((_value, context) => {
        renameSync(recordPath, displacedPath);
        writeFileSync(recordPath, replacementBytes, { flag: "wx", mode: 0o600 });
        if (schemaExit === "invalid") {
          context.addIssue({ code: "custom", message: "injected leaf schema issue" });
        } else {
          throw schemaMarker;
        }
      });

      const failure = await captureTaskServiceError(() =>
        readJsonRecord(recordPath, evidenceRef, mutatingSchema)
      );

      expect(failure.code).toBe("workspace_path_not_safe");
      expect(await readFile(recordPath)).toEqual(replacementBytes);
      expect(await readFile(displacedPath)).toEqual(originalBytes);
      if (schemaExit === "invalid") {
        expect(
          findErrorNode(
            failure,
            (error) => error instanceof TaskServiceError && error.code === "record_schema_error"
          )
        ).toBeInstanceOf(TaskServiceError);
      } else {
        expect(errorTreeContains(failure, schemaMarker)).toBe(true);
      }
    }
  });

  test("read schema exits preserve validation and exact thrown-error semantics without drift", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { id: "schema-exit-compatible" };
    const evidenceRef = "authority.read.schema-compatible";
    const directorySegments = ["read-schema-compatible"] as const;
    const fileName = "record.json";
    const recordPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const schema = z.object({ id: z.string() });
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });

    expect(await readJsonRecord(recordPath, evidenceRef, schema)).toEqual(record);
    const validationFailure = await captureTaskServiceError(() =>
      readJsonRecord(
        recordPath,
        evidenceRef,
        schema.superRefine((_value, context) => {
          context.addIssue({ code: "custom", message: "compatible schema issue" });
        })
      )
    );
    expect(validationFailure.code).toBe("record_schema_error");

    const exactMarker = new Error("exact schema callback marker");
    let thrownValue: unknown;
    try {
      await readJsonRecord(
        recordPath,
        evidenceRef,
        schema.superRefine(() => {
          throw exactMarker;
        })
      );
    } catch (error) {
      thrownValue = error;
    }
    expect(thrownValue).toBe(exactMarker);
  });

  test("durable observations reject direct filesystem replacement before semantic callbacks", async () => {
    for (const surface of [
      "direct-read",
      "ordinary-delete",
      "permit-delete",
      "direct-missing-to-present",
      "ordinary-missing-to-present"
    ] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schemaBase = z.object({ id: z.string() });
      const record = { id: `durable-before-callback-${surface}` };
      const evidenceRef = `durable.before-callback.${surface}`;
      const directorySegments = ["durable-before-callback", surface] as const;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, "record.json"],
        evidenceRef
      );
      const startsMissing = surface.endsWith("missing-to-present");
      let permit: WorkspaceRecordCleanupPermit | undefined;
      if (!startsMissing) {
        const created = surface === "permit-delete"
          ? await createJsonRecordIfAbsentWithCleanupPermit(
              workspaceRoot,
              directorySegments,
              "record.json",
              record,
              evidenceRef,
              schemaBase
            )
          : await createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              "record.json",
              record,
              evidenceRef,
              schemaBase
            );
        if (created.status !== "created") throw new Error("Expected durable fixture.");
        if ("cleanupPermit" in created) permit = created.cleanupPermit;
      } else {
        await mkdir(dirname(path), { recursive: true });
      }

      const displacedPath = `${path}.admitted`;
      const foreign = { id: `${record.id}-foreign` };
      const foreignBytes = Buffer.from(`${JSON.stringify(foreign, null, 2)}\n`);
      let schemaCalls = 0;
      let conditionCalls = 0;
      const schema = schemaBase.superRefine(() => {
        schemaCalls += 1;
      });
      let failure: Error | undefined;
      try {
        await runWithWorkspaceRecordPublicationHooks(
          {
            afterDurableRecordObservation: async ({ status }) => {
              expect(status).toBe(startsMissing ? "missing" : "read");
              if (startsMissing) {
                await writeFile(path, foreignBytes, { flag: "wx", mode: 0o600 });
              } else {
                await rename(path, displacedPath);
                await writeFile(path, foreignBytes, { flag: "wx", mode: 0o600 });
              }
            }
          },
          async () => {
            if (surface === "direct-read" || surface === "direct-missing-to-present") {
              return await readJsonRecord(path, evidenceRef, schema);
            }
            const condition = {
              kind: "record" as const,
              expected: record,
              matches: () => {
                conditionCalls += 1;
                return true;
              }
            };
            return surface === "permit-delete"
              ? await conditionalDeleteJsonRecordWithCleanupPermit(
                  permit!, path, evidenceRef, schema, condition
                )
              : await conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);
          }
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        failure = error as Error;
      }
      if (!failure) throw new Error(`Expected pre-callback rejection for ${surface}.`);

      expect(schemaCalls).toBe(0);
      expect(conditionCalls).toBe(0);
      expect(
        findErrorNode(
          failure,
          (error) => error instanceof TaskServiceError && error.code === "workspace_path_not_safe"
        )
      ).toBeInstanceOf(TaskServiceError);
      expect(await readFile(path)).toEqual(foreignBytes);
      if (!startsMissing) {
        expect((await stat(path)).ino).not.toBe((await stat(displacedPath)).ino);
      }
      expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("filesystem-shaped callback errors remain semantic and never become syscall status", async () => {
    const schema = z.object({ id: z.string() });

    {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { id: "callback-eexist-hardlink" };
      const evidenceRef = "callback.error.eexist.hardlink";
      const marker = Object.assign(new Error("semantic hardlink callback"), { code: "EEXIST" });
      let path = "";
      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterCanonicalLink: (input) => {
              path = input.canonicalPath;
              throw marker;
            }
          },
          () => createJsonRecordIfAbsent(
            workspaceRoot, ["callback-errors"], "eexist.json", record, evidenceRef, schema
          )
        )
      );
      expect(errorTreeContains(failure, marker)).toBe(true);
      await expectPathMissing(path);
      expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    }

    {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { id: "callback-enoent-delete" };
      const evidenceRef = "callback.error.enoent.delete";
      const marker = Object.assign(new Error("semantic delete callback"), { code: "ENOENT" });
      const path = workspaceRecordPath(
        workspaceRoot,
        ["callback-errors", "enoent.json"],
        evidenceRef
      );
      await createJsonRecordIfAbsent(
        workspaceRoot, ["callback-errors"], "enoent.json", record, evidenceRef, schema
      );
      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedPathIsolation: () => {
              throw marker;
            }
          },
          () => conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        )
      );
      expect(errorTreeContains(failure, marker)).toBe(true);
      expect(await readJsonRecord(path, evidenceRef, schema)).toEqual(record);
      expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("legacy ordinary 0644 records normalize through their descriptor before deletion", async () => {
    const fixtures = [
      {
        consumer: "idempotency",
        record: validIdempotencyRecord(),
        schema: IdempotencyRecordSchema
      },
      { consumer: "lock", record: validLockRecord(), schema: LockRecordSchema },
      { consumer: "artifact", record: validArtifact(), schema: ArtifactSchema }
    ] as const;
    for (const fixture of fixtures) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const evidenceRef = `legacy.0644.${fixture.consumer}`;
      const path = workspaceRecordPath(
        workspaceRoot,
        ["legacy-0644", `${fixture.consumer}.json`],
        evidenceRef
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(fixture.record, null, 2)}\n`, {
        flag: "wx",
        mode: 0o644
      });
      await chmod(path, 0o644);

      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, fixture.schema, {
          kind: "record",
          expected: fixture.record,
          matches: (current, expected) => JSON.stringify(current) === JSON.stringify(expected)
        })
      ).toEqual({ status: "deleted" });
      await expectPathMissing(path);
      expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("conditional-delete schema and condition callbacks share one admitted authority epoch", async () => {
    const cases = [
      { exit: "schema_success", drift: "parent_symlink" },
      { exit: "schema_invalid", drift: "parent_rebind" },
      { exit: "schema_throw", drift: "leaf_replacement" },
      { exit: "condition_true", drift: "same_inode" },
      { exit: "condition_false", drift: "leaf_replacement" },
      { exit: "condition_throw", drift: "parent_rebind" },
      { exit: "callback_missing", drift: "missing" }
    ] as const;

    for (const authority of ["ordinary", "cleanup-permit"] as const) {
      for (const callbackCase of cases) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const record = { id: `${authority}-${callbackCase.exit}` };
        const replacement = { id: `${authority}-${callbackCase.exit}-replacement` };
        const evidenceRef = `conditional.callback.${authority}.${callbackCase.exit}`;
        const directorySegments = ["conditional-callback", authority, callbackCase.exit] as const;
        const fileName = "record.json";
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const baseSchema = z.object({ id: z.string() });
        const created =
          authority === "cleanup-permit"
            ? await createJsonRecordIfAbsentWithCleanupPermit(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                baseSchema
              )
            : await createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                baseSchema
              );
        if (created.status !== "created") throw new Error("Expected callback fixture.");
        const original = await readFileWithIdentity(path);
        const parentPath = dirname(path);
        const displacedParent = `${parentPath}.displaced`;
        const displacedLeaf = `${path}.displaced`;
        const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
        const callbackMarker = new Error(
          `callback marker ${authority} ${callbackCase.exit}`
        );
        let mutated = false;
        const mutate = () => {
          if (mutated) return;
          mutated = true;
          switch (callbackCase.drift) {
            case "parent_symlink":
              renameSync(parentPath, displacedParent);
              symlinkSync(displacedParent, parentPath, "dir");
              break;
            case "parent_rebind":
              renameSync(parentPath, displacedParent);
              mkdirSync(parentPath);
              renameSync(join(displacedParent, fileName), path);
              break;
            case "leaf_replacement":
              renameSync(path, displacedLeaf);
              writeFileSync(path, replacementBytes, { flag: "wx", mode: 0o600 });
              break;
            case "same_inode":
              writeFileSync(path, replacementBytes);
              break;
            case "missing":
              unlinkSync(path);
              break;
          }
        };
        const schema = baseSchema.superRefine((_value, context) => {
          if (!callbackCase.exit.startsWith("schema_")) return;
          mutate();
          if (callbackCase.exit === "schema_invalid") {
            context.addIssue({ code: "custom", message: "injected schema issue" });
          } else if (callbackCase.exit === "schema_throw") {
            throw callbackMarker;
          }
        });
        const condition =
          callbackCase.exit === "schema_invalid"
            ? ({ kind: "malformed" } as const)
            : {
                kind: "record" as const,
                expected: record,
                matches: (current: { id: string }, expected: { id: string }) => {
                  if (callbackCase.exit.startsWith("condition_") ||
                      callbackCase.exit === "callback_missing") {
                    mutate();
                  }
                  if (callbackCase.exit === "condition_throw") throw callbackMarker;
                  if (callbackCase.exit === "condition_false") return false;
                  return current.id === expected.id;
                }
              };
        const action = () =>
          authority === "cleanup-permit"
            ? conditionalDeleteJsonRecordWithCleanupPermit(
                created.cleanupPermit,
                path,
                evidenceRef,
                schema,
                condition
              )
            : conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);

        const failure = await captureError(action);

        expect(mutated).toBe(true);
        expect(
          findErrorNode(
            failure,
            (error) =>
              error instanceof TaskServiceError && error.code === "workspace_path_not_safe"
          )
        ).toBeInstanceOf(TaskServiceError);
        if (callbackCase.exit === "schema_invalid") {
          expect(
            findErrorNode(
              failure,
              (error) => error instanceof TaskServiceError && error.code === "record_schema_error"
            )
          ).toBeInstanceOf(TaskServiceError);
        }
        if (callbackCase.exit === "schema_throw" || callbackCase.exit === "condition_throw") {
          expect(errorTreeContains(failure, callbackMarker)).toBe(true);
        }
        if (callbackCase.drift === "leaf_replacement" || callbackCase.drift === "same_inode") {
          expect(await readFile(path)).toEqual(replacementBytes);
        } else if (callbackCase.drift !== "missing") {
          expect(await readFileWithIdentity(path)).toEqual(original);
        } else {
          await expectPathMissing(path);
        }
        if (callbackCase.drift === "leaf_replacement") {
          expect(await readFileWithIdentity(displacedLeaf)).toEqual(original);
        }
        if (callbackCase.drift === "same_inode") {
          expect((await stat(path)).ino).toBe(original.ino);
        }
        expect((await readdir(parentPath)).some(isOwnedRecordPath)).toBe(false);

        if (authority === "cleanup-permit") {
          const reusedPermit = await captureConditionalDeleteError(() =>
            conditionalDeleteJsonRecordWithCleanupPermit(
              created.cleanupPermit,
              path,
              `${evidenceRef}.reused`,
              baseSchema,
              { kind: "malformed" }
            )
          );
          expect(reusedPermit.failureStage).toBe("permit_admission");
        }
      }
    }
  });

  test("conditional-delete callbacks preserve no-drift results and thrown identities", async () => {
    for (const authority of ["ordinary", "cleanup-permit"] as const) {
      for (const exit of [
        "schema_success",
        "schema_invalid",
        "schema_throw",
        "condition_true",
        "condition_false",
        "condition_throw"
      ] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const record = { id: `compatible-${authority}-${exit}` };
        const evidenceRef = `conditional.compatible.${authority}.${exit}`;
        const directorySegments = ["conditional-compatible", authority, exit] as const;
        const fileName = "record.json";
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const baseSchema = z.object({ id: z.string() });
        const created =
          authority === "cleanup-permit"
            ? await createJsonRecordIfAbsentWithCleanupPermit(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                baseSchema
              )
            : await createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                baseSchema
              );
        if (created.status !== "created") throw new Error("Expected compatible fixture.");
        const marker = new Error(`exact callback marker ${authority} ${exit}`);
        const schema = baseSchema.superRefine((_value, context) => {
          if (exit === "schema_invalid") {
            context.addIssue({ code: "custom", message: "compatible schema issue" });
          } else if (exit === "schema_throw") {
            throw marker;
          }
        });
        const condition =
          exit === "schema_invalid"
            ? ({ kind: "malformed" } as const)
            : {
                kind: "record" as const,
                expected: record,
                matches: (current: { id: string }, expected: { id: string }) => {
                  if (exit === "condition_throw") throw marker;
                  if (exit === "condition_false") return false;
                  return current.id === expected.id;
                }
              };
        const action = () =>
          authority === "cleanup-permit"
            ? conditionalDeleteJsonRecordWithCleanupPermit(
                created.cleanupPermit,
                path,
                evidenceRef,
                schema,
                condition
              )
            : conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);

        if (exit === "schema_throw" || exit === "condition_throw") {
          let thrown: unknown;
          try {
            await action();
          } catch (error) {
            thrown = error;
          }
          if (authority === "ordinary") {
            expect(thrown).toBe(marker);
          } else {
            expect(thrown).toBeInstanceOf(WorkspaceRecordConditionalDeleteError);
            expect((thrown as WorkspaceRecordConditionalDeleteError).cause).toBe(marker);
          }
          expect(await readFile(path)).toEqual(
            Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
          );
        } else {
          expect(await action()).toEqual(
            exit === "condition_false"
              ? { status: "condition_not_met" }
              : { status: "deleted" }
          );
        }

        if (authority === "cleanup-permit" &&
            (exit === "schema_throw" || exit === "condition_throw" ||
             exit === "condition_false")) {
          const reusedPermit = await captureConditionalDeleteError(() =>
            conditionalDeleteJsonRecordWithCleanupPermit(
              created.cleanupPermit,
              path,
              `${evidenceRef}.reused`,
              baseSchema,
              { kind: "malformed" }
            )
          );
          expect(reusedPermit.failureStage).toBe("permit_admission");
        }
      }

      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const missingPath = workspaceRecordPath(
        workspaceRoot,
        ["conditional-compatible", authority, "missing.json"],
        `conditional.compatible.${authority}.missing`
      );
      await mkdir(dirname(missingPath), { recursive: true });
      if (authority === "ordinary") {
        expect(
          await conditionalDeleteJsonRecord(
            missingPath,
            `conditional.compatible.${authority}.missing`,
            z.object({ id: z.string() }),
            { kind: "malformed" }
          )
        ).toEqual({ status: "missing" });
      } else {
        const record = { id: "cleanup-permit-missing" };
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["conditional-compatible", authority],
          "missing.json",
          record,
          `conditional.compatible.${authority}.missing`,
          z.object({ id: z.string() })
        );
        if (created.status !== "created") throw new Error("Expected missing permit fixture.");
        unlinkSync(missingPath);
        const missingFailure = await captureConditionalDeleteError(() =>
          conditionalDeleteJsonRecordWithCleanupPermit(
            created.cleanupPermit,
            missingPath,
            `conditional.compatible.${authority}.missing`,
            z.object({ id: z.string() }),
            { kind: "malformed" }
          )
        );
        expect(missingFailure.failureStage).toBe("permit_admission");
        await expectPathMissing(missingPath);
      }
    }
  });

  test("ordinary conditional delete treats ENOENT and ENOTDIR parents as missing without callbacks or namespaces", async () => {
    for (const parentState of ["ENOENT", "ENOTDIR"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      await mkdir(workspaceRoot);
      const evidenceRef = `conditional.missing-parent.${parentState.toLowerCase()}`;
      const blockerPath = join(workspaceRoot, `missing-parent-${parentState.toLowerCase()}`);
      if (parentState === "ENOTDIR") {
        await writeFile(blockerPath, "not a directory\n", { flag: "wx", mode: 0o600 });
      }
      const path = workspaceRecordPath(
        workspaceRoot,
        [basename(blockerPath), "child", "record.json"],
        evidenceRef
      );
      let schemaCalls = 0;
      let conditionCalls = 0;
      const schema = z.object({ id: z.string() }).superRefine(() => {
        schemaCalls += 1;
      });

      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: { id: "missing" },
          matches: () => {
            conditionCalls += 1;
            return true;
          }
        })
      ).toEqual({ status: "missing" });
      expect(schemaCalls).toBe(0);
      expect(conditionCalls).toBe(0);
      expect((await readdir(workspaceRoot)).some(isOwnedRecordPath)).toBe(false);
      await expectPathMissing(dirname(path));
    }
  });

  test("mutable canonical baseline rejects lease-hook and final-precommit destination drift", async () => {
    for (const phase of ["lease-hook", "final-precommit"] as const) {
      for (const mutation of ["absent-to-present", "replacement", "same-inode-drift"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const service = createLockRecordService({ workspaceRoot });
        const before = { ...validLockRecord(), lock_id: `LOCK-canonical-${phase}-${mutation}` };
        const after = { ...before, holder: `after-${mutation}` };
        if (mutation !== "absent-to-present") await service.storeLock(before);
        const evidenceRef = lockRecordEvidenceRef(after.scope, after.lock_id);
        const recordPath = workspaceRecordPath(
          workspaceRoot,
          [...lockRecordDirectorySegments(after.scope), lockRecordFileName(after.lock_id)],
          evidenceRef
        );
        const beforeBytes =
          mutation === "absent-to-present" ? undefined : await readFile(recordPath);
        const displacedPath = join(dirname(recordPath), `displaced-${phase}-${mutation}`);
        let intervening: Awaited<ReturnType<typeof readFileWithIdentity>>;
        let mutated = false;
        const mutateCanonical = async () => {
          if (mutated) return;
          mutated = true;
          if (mutation === "absent-to-present") {
            await writeFile(recordPath, "foreign create generation\n", {
              flag: "wx",
              mode: 0o600
            });
          } else if (mutation === "replacement") {
            await rename(recordPath, displacedPath);
            await writeFile(recordPath, "foreign update replacement\n", {
              flag: "wx",
              mode: 0o600
            });
          } else {
            const drift = Buffer.from(beforeBytes!);
            drift[0] = drift[0] === 0x7b ? 0x5b : 0x7b;
            const handle = await open(recordPath, "r+");
            try {
              await handle.write(drift, 0, drift.length, 0);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          intervening = await readFileWithIdentity(recordPath);
        };

        const error = await captureTaskServiceError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterAuthorityLeaseAcquired: async ({ operation }) => {
                if (operation === "rename" && phase === "lease-hook") await mutateCanonical();
              },
              afterTemporaryFileClosed: async () => {
                if (phase === "final-precommit") await mutateCanonical();
              }
            },
            () => service.storeLock(after)
          )
        );

        expect(error.code).toBe("workspace_path_not_safe");
        expect(await readFileWithIdentity(recordPath)).toEqual(intervening!);
        if (mutation === "replacement") {
          expect(await readFile(displacedPath)).toEqual(beforeBytes!);
        }

        if (mutation === "absent-to-present") {
          await rm(recordPath);
        } else if (mutation === "replacement") {
          await rm(recordPath);
          await rename(displacedPath, recordPath);
        } else {
          await writeFile(recordPath, beforeBytes!);
        }
        expect(await service.storeLock(after)).toEqual(after);
        expect(await service.getLock(after.scope, after.lock_id)).toEqual(after);
      }
    }
  });

  test("mutable and shared temporary cleanup reject move-plus-symlink namespace rebound", async () => {
    for (const publication of ["mutable", "hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { ...validLockRecord(), lock_id: `LOCK-cleanup-rebound-${publication}` };
      const directorySegments = lockRecordDirectorySegments(record.scope);
      const fileName = lockRecordFileName(record.lock_id);
      const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
      let namespacePath = "";
      let movedNamespace = "";
      let generationBytes: Buffer | undefined;
      const primary = new Error(`${publication} cleanup primary`);

      const error = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: ({ temporaryPath }) => {
              namespacePath = dirname(temporaryPath);
              if (publication === "mutable") throw primary;
            },
            afterCanonicalLink: () => {
              if (publication === "hardlink") throw primary;
            },
            beforeGenerationIsolation: async ({ path, operation }) => {
              const expectedOperation =
                publication === "mutable" ? "rename_temp_cleanup" : "hardlink_temp_cleanup";
              if (operation !== expectedOperation || movedNamespace) return;
              namespacePath = dirname(path);
              movedNamespace = join(tempRoot, `moved-${publication}-namespace`);
              generationBytes = await readFile(path);
              await rename(namespacePath, movedNamespace);
              await symlink(movedNamespace, namespacePath, "dir");
            }
          },
          () =>
            publication === "mutable"
              ? writeJsonRecord(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  LockRecordSchema
                )
              : createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  LockRecordSchema
                )
        )
      );

      expect(aggregateErrorMessages(error)).toContain(primary.message);
      expect(await readFile(join(movedNamespace, "generation"))).toEqual(generationBytes!);
      expect((await lstat(namespacePath)).isSymbolicLink()).toBe(true);
    }
  });

  test("shared temporary cleanup preserves mode and additional-hardlink drift", async () => {
    for (const drift of ["mode", "hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `shared-cleanup-${drift}-drift` };
      const evidenceRef = `shared.cleanup.${drift}.drift`;
      const directorySegments = ["shared-cleanup-drift"] as const;
      const fileName = `${drift}.json`;
      const externalAlias = join(tempRoot, `${drift}-shared-cleanup-alias.json`);
      let publication: WorkspaceRecordPublicationHookInput | undefined;
      let driftApplied = false;

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterCanonicalLink: (input) => {
              publication = input;
            },
            beforeAuthorityOwnedUnlink: async ({ path, operation }) => {
              if (operation !== "hardlink_temp_cleanup" || driftApplied) return;
              driftApplied = true;
              if (drift === "mode") await chmod(path, 0o400);
              else await link(path, externalAlias);
            }
          },
          () =>
            createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
        )
      );

      expect(aggregateErrorMessages(failure)).toContain(
        "Workspace record publication authority could not be verified."
      );
      expect(driftApplied).toBe(true);
      expect(publication).toBeDefined();
      if (drift === "mode") {
        expect(await readFile(publication!.canonicalPath)).toEqual(
          await readFile(publication!.temporaryPath)
        );
        expect((await stat(publication!.canonicalPath)).mode & 0o777).toBe(0o400);
      } else {
        expect(await readFile(externalAlias)).toEqual(
          Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
        );
      }
    }
  });

  test("early write and namespace-removal failures preserve foreign namespace replacements", async () => {
    for (const site of ["early-write", "mutable-removal", "shared-removal"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = { ...validLockRecord(), lock_id: `LOCK-namespace-owner-${site}` };
      const primary = new Error(`${site} primary`);
      let namespacePath = "";
      let movedNamespace = "";
      let replacementIdentity: { dev: number; ino: number } | undefined;
      let replaced = false;

      const action = () =>
        site === "shared-removal"
          ? createJsonRecordIfAbsent(
              workspaceRoot,
              lockRecordDirectorySegments(record.scope),
              lockRecordFileName(record.lock_id),
              record,
              lockRecordEvidenceRef(record.scope, record.lock_id),
              LockRecordSchema
            )
          : writeJsonRecord(
              workspaceRoot,
              lockRecordDirectorySegments(record.scope),
              lockRecordFileName(record.lock_id),
              record,
              lockRecordEvidenceRef(record.scope, record.lock_id),
              LockRecordSchema
            );

      const error = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async ({ path }) => {
              if (site !== "early-write") return;
              namespacePath = dirname(path);
              movedNamespace = join(tempRoot, "moved-early-write-namespace");
              await rename(namespacePath, movedNamespace);
              await mkdir(namespacePath, { mode: 0o700 });
              replacementIdentity = await readPathIdentity(namespacePath);
              throw primary;
            }
          },
          () =>
            runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: ({ temporaryPath }) => {
                  namespacePath = dirname(temporaryPath);
                  if (site === "mutable-removal") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "shared-removal") throw primary;
                },
                beforeAuthorityNamespaceRemoval: async ({ path }) => {
                  if (site === "early-write" || replaced || path !== namespacePath) return;
                  replaced = true;
                  movedNamespace = join(tempRoot, `moved-${site}-namespace`);
                  await rename(path, movedNamespace);
                  await mkdir(path, { mode: 0o700 });
                  replacementIdentity = await readPathIdentity(path);
                }
              },
              action
            )
        )
      );

      expect(aggregateErrorMessages(error)).toContain(primary.message);
      expect(await readPathIdentity(namespacePath)).toEqual(replacementIdentity!);
      expect((await stat(namespacePath)).mode & 0o777).toBe(0o700);
      expect((await stat(movedNamespace)).isDirectory()).toBe(true);
    }
  });

  test("postcommit namespace ownership mismatch is non-rejecting and preserves replacement state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const record = { ...validLockRecord(), lock_id: "LOCK-postcommit-namespace-owner" };
    let namespacePath = "";
    let movedNamespace = "";
    let replacementIdentity: { dev: number; ino: number } | undefined;
    let replaced = false;

    expect(
      await runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: ({ temporaryPath }) => {
            namespacePath = dirname(temporaryPath);
          },
          beforeAuthorityNamespaceRemoval: async ({ path }) => {
            if (replaced || path !== namespacePath) return;
            replaced = true;
            movedNamespace = join(tempRoot, "moved-postcommit-namespace");
            await rename(path, movedNamespace);
            await mkdir(path, { mode: 0o700 });
            replacementIdentity = await readPathIdentity(path);
          }
        },
        () => service.storeLock(record)
      )
    ).toEqual(record);

    expect(await service.getLock(record.scope, record.lock_id)).toEqual(record);
    expect(await readPathIdentity(namespacePath)).toEqual(replacementIdentity!);
    expect((await stat(movedNamespace)).isDirectory()).toBe(true);
  });

  test("compensation preservation safely exposes aggregate cause for every cause descriptor kind", () => {
    const compensation = new Error("descriptor compensation");

    const getterPrior = new Error("getter-only prior");
    let getterReads = 0;
    const getterOnly = new Error("getter-only primary");
    Object.defineProperty(getterOnly, "cause", {
      configurable: false,
      enumerable: true,
      get: () => {
        getterReads += 1;
        return getterPrior;
      }
    });
    const getterOnlyResult = preservePrimaryAndCompensationErrors(
      getterOnly,
      [compensation],
      "getter-only aggregate"
    ) as Error;
    const getterOnlyDescriptor = Object.getOwnPropertyDescriptor(getterOnly, "cause")!;
    expect(getterReads).toBe(1);
    expect(getterOnlyResult).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(semanticPrimaryError(getterOnlyResult)).toBe(getterOnly);
    expect("get" in getterOnlyDescriptor).toBe(true);
    expect(getterOnlyDescriptor).toMatchObject({ configurable: false, enumerable: true, set: undefined });
    expect((getterOnlyResult.cause as AggregateError).errors).toEqual([getterPrior, compensation]);

    let setterReceiver: unknown;
    let setterValue: unknown;
    const getterSetter = new Error("getter-setter primary");
    const setter = function (this: unknown, value: unknown): void {
      setterReceiver = this;
      setterValue = value;
    };
    Object.defineProperty(getterSetter, "cause", {
      configurable: true,
      enumerable: false,
      get: () => undefined,
      set: setter
    });
    const getterSetterResult = preservePrimaryAndCompensationErrors(
      getterSetter,
      [compensation],
      "getter-setter aggregate"
    ) as Error;
    const getterSetterDescriptor = Object.getOwnPropertyDescriptor(getterSetter, "cause")!;
    expect(semanticPrimaryError(getterSetterResult)).toBe(getterSetter);
    expect(getterSetterDescriptor.set).toBe(setter);
    getterSetterDescriptor.set!.call(getterSetter, "assigned through preserved setter");
    expect(setterReceiver).toBe(getterSetter);
    expect(setterValue).toBe("assigned through preserved setter");
    expect((getterSetterResult.cause as AggregateError).errors).toEqual([compensation]);

    const getterFailure = new Error("throwing getter read failure");
    let throwingGetterReads = 0;
    const throwingGetter = new Error("throwing-getter primary");
    Object.defineProperty(throwingGetter, "cause", {
      configurable: true,
      enumerable: false,
      get: () => {
        throwingGetterReads += 1;
        throw getterFailure;
      }
    });
    const throwingResult = preservePrimaryAndCompensationErrors(
      throwingGetter,
      [compensation],
      "throwing-getter aggregate"
    ) as Error;
    expect(throwingGetterReads).toBe(1);
    expect(semanticPrimaryError(throwingResult)).toBe(throwingGetter);
    expect((throwingResult.cause as AggregateError).errors).toEqual([
      getterFailure,
      compensation
    ]);

    const noOwnCause = new Error("no-own-cause primary");
    const noOwnResult = preservePrimaryAndCompensationErrors(
      noOwnCause,
      [compensation],
      "no-own-cause aggregate"
    ) as Error;
    expect(Object.hasOwn(noOwnCause, "cause")).toBe(false);
    expect(semanticPrimaryError(noOwnResult)).toBe(noOwnCause);
    expect(Object.hasOwn(noOwnCause, "cause")).toBe(false);
    expect((noOwnResult.cause as AggregateError).errors).toEqual([compensation]);

    const integrityCases = [
      {
        name: "frozen",
        apply: (error: Error) => Object.freeze(error),
        frozen: true,
        sealed: true,
        extensible: false
      },
      {
        name: "sealed",
        apply: (error: Error) => Object.seal(error),
        frozen: false,
        sealed: true,
        extensible: false
      },
      {
        name: "non-extensible",
        apply: (error: Error) => Object.preventExtensions(error),
        frozen: false,
        sealed: false,
        extensible: false
      },
      {
        name: "extensible",
        apply: (error: Error) => error,
        frozen: false,
        sealed: false,
        extensible: true
      }
    ] as const;

    for (const integrityCase of integrityCases) {
      const prior = new Error(`${integrityCase.name} data prior`);
      const primary = new StructuredServiceError(
        `${integrityCase.name} data primary`,
        `E_${integrityCase.name.toUpperCase().replace("-", "_")}`,
        Object.freeze({ surface: "helper", immutability: integrityCase.name }),
        prior
      );
      integrityCase.apply(primary);
      const descriptors = Object.getOwnPropertyDescriptors(primary);
      const result = preservePrimaryAndCompensationErrors(
        primary,
        [compensation],
        `${integrityCase.name} data aggregate`
      ) as Error;

      expect(result).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      expect(result).not.toBeInstanceOf(StructuredServiceError);
      expect(semanticPrimaryError(result)).toBe(primary);
      expect(Object.getPrototypeOf(primary)).toBe(StructuredServiceError.prototype);
      expectPreservedOwnDescriptors(primary, descriptors);
      expect((result.cause as AggregateError).errors).toEqual([prior, compensation]);
      expect(primary.cause).toBe(prior);
      expect(Object.isFrozen(primary)).toBe(integrityCase.frozen);
      expect(Object.isSealed(primary)).toBe(integrityCase.sealed);
      expect(Object.isExtensible(primary)).toBe(integrityCase.extensible);

      const propertyDefined = Reflect.defineProperty(primary, "integrityProbe", {
        configurable: true,
        value: integrityCase.name
      });
      expect(propertyDefined).toBe(integrityCase.extensible);
      expect(Object.hasOwn(primary, "integrityProbe")).toBe(integrityCase.extensible);
      if (integrityCase.extensible) {
        expect(Reflect.get(primary, "integrityProbe")).toBe(integrityCase.name);
      }
    }
  });

  test("compensation preservation keeps private and WeakMap Error brands on the original object", () => {
    class PrivateFieldError extends Error {
      #token: string;

      constructor(token: string) {
        super(`private ${token}`);
        this.#token = token;
      }

      get token(): string {
        return this.#token;
      }

      reveal(): string {
        return this.#token;
      }
    }

    const weakTokens = new WeakMap<object, string>();
    class WeakMapError extends Error {
      constructor(token: string) {
        super(`weak ${token}`);
        weakTokens.set(this, token);
      }

      get token(): string {
        return weakTokens.get(this) ?? "missing";
      }

      reveal(): string {
        return weakTokens.get(this) ?? "missing";
      }
    }

    const integrityCases = [
      { name: "frozen", apply: (error: Error) => Object.freeze(error) },
      { name: "sealed", apply: (error: Error) => Object.seal(error) },
      { name: "extensible", apply: (error: Error) => error }
    ] as const;

    for (const integrityCase of integrityCases) {
      for (const primary of [
        new PrivateFieldError(integrityCase.name),
        new WeakMapError(integrityCase.name)
      ]) {
        const originalPrototype = Object.getPrototypeOf(primary);
        integrityCase.apply(primary);
        const originalDescriptors = Object.getOwnPropertyDescriptors(primary);
        const compensation = new Error(`${integrityCase.name} compensation`);
        const result = preservePrimaryAndCompensationErrors(
          primary,
          [compensation],
          `${integrityCase.name} branded aggregate`
        ) as Error;

        expect(result).toBeInstanceOf(PreservedErrorCompensationEnvelope);
        expect(result).not.toBeInstanceOf(primary.constructor);
        expect(semanticPrimaryError(result)).toBe(primary);
        expect(Object.getPrototypeOf(primary)).toBe(originalPrototype);
        expectPreservedOwnDescriptors(primary, originalDescriptors);
        expect(primary.token).toBe(integrityCase.name);
        expect(primary.reveal()).toBe(integrityCase.name);
        expect(Object.isFrozen(primary)).toBe(integrityCase.name === "frozen");
        expect(Object.isSealed(primary)).toBe(integrityCase.name !== "extensible");
        expect(Object.isExtensible(primary)).toBe(integrityCase.name === "extensible");
        expect((result.cause as AggregateError).errors).toEqual([compensation]);
      }
    }
  });

  test("mutable and hardlink compensation preserve branded Error identity and behavior", async () => {
    class PrivateFieldError extends Error {
      #token: string;

      constructor(token: string) {
        super(`private ${token}`);
        this.#token = token;
      }

      reveal(): string {
        return this.#token;
      }
    }

    const weakTokens = new WeakMap<object, string>();
    class WeakMapError extends Error {
      constructor(token: string) {
        super(`weak ${token}`);
        weakTokens.set(this, token);
      }

      get token(): string {
        return weakTokens.get(this) ?? "missing";
      }
    }

    for (const surface of ["mutable", "hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `branded-${surface}` };
      const directorySegments = ["branded-compensation"] as const;
      const fileName = `${surface}.json`;
      const evidenceRef = `branded.compensation.${surface}`;
      const primary = surface === "mutable"
        ? Object.freeze(new PrivateFieldError(surface))
        : Object.seal(new WeakMapError(surface));
      const compensation = new Error(`${surface} branded compensation`);

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: () => {
              throw primary;
            },
            beforeTemporaryFileClose: () => {
              throw compensation;
            }
          },
          () => surface === "mutable"
            ? writeJsonRecord(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
            : createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
        )
      );

      expect(failure).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      expect(failure).not.toBeInstanceOf(primary.constructor);
      expect(semanticPrimaryError(failure)).toBe(primary);
      if (primary instanceof PrivateFieldError) {
        expect(primary.reveal()).toBe(surface);
      } else {
        expect(primary.token).toBe(surface);
      }
      expect((failure.cause as AggregateError).errors).toEqual([compensation]);
      expect(Object.isFrozen(primary)).toBe(surface === "mutable");
      expect(Object.isSealed(primary)).toBe(true);
    }
  });

  test("compensation preservation retains every undefined and falsy slot in order", () => {
    const ordinaryCompensation = new Error("ordinary compensation");
    const cases = [
      { name: "undefined-only", compensations: [undefined] },
      { name: "mixed", compensations: [undefined, ordinaryCompensation] },
      { name: "falsy", compensations: [null, false, 0, ""] }
    ] as const;

    for (const matrixCase of cases) {
      const priorCause = new Error(`${matrixCase.name} prior cause`);
      const primary = new StructuredServiceError(
        `${matrixCase.name} primary`,
        `E_${matrixCase.name.toUpperCase().replace("-", "_")}`,
        Object.freeze({ surface: "helper", immutability: "frozen" }),
        priorCause
      );
      Object.freeze(primary);
      const descriptors = Object.getOwnPropertyDescriptors(primary);

      const result = preservePrimaryAndCompensationErrors(
        primary,
        matrixCase.compensations,
        `${matrixCase.name} aggregate`
      ) as Error;

      expect(result).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      expect(result).not.toBeInstanceOf(StructuredServiceError);
      expect(semanticPrimaryError(result)).toBe(primary);
      expect(Object.getPrototypeOf(primary)).toBe(StructuredServiceError.prototype);
      expectPreservedOwnDescriptors(primary, descriptors);
      expect(Object.isFrozen(primary)).toBe(true);
      expect(Object.isSealed(primary)).toBe(true);
      expect(Object.isExtensible(primary)).toBe(false);
      expect(result.cause).toBeInstanceOf(AggregateError);
      const aggregateErrors = (result.cause as AggregateError).errors;
      expect(aggregateErrors).toHaveLength(matrixCase.compensations.length + 1);
      expect(aggregateErrors[0]).toBe(priorCause);
      matrixCase.compensations.forEach((compensation, index) => {
        expect(aggregateErrors[index + 1]).toBe(compensation);
      });
      expect(primary.cause).toBe(priorCause);
    }

    const nonErrorPrimary = Object.freeze({ kind: "non-error" });
    expect(
      preservePrimaryAndCompensationErrors(nonErrorPrimary, [undefined], "non-error aggregate")
    ).toBe(nonErrorPrimary);
    const emptyPrimary = Object.freeze(new Error("empty primary"));
    expect(preservePrimaryAndCompensationErrors(emptyPrimary, [], "empty aggregate")).toBe(
      emptyPrimary
    );
  });

  test("compensation preservation flattens only helper-owned envelopes by provenance", () => {
    const semanticPriorCause = new Error("provenance semantic prior cause");
    const semanticPrimary = new StructuredServiceError(
      "provenance semantic primary",
      "E_PROVENANCE_PRIMARY",
      Object.freeze({ surface: "helper", immutability: "frozen" }),
      semanticPriorCause
    );
    Object.freeze(semanticPrimary);
    const semanticDescriptors = Object.getOwnPropertyDescriptors(semanticPrimary);
    const firstFailure = new Error("provenance first compensation");
    const laterFailure = new Error("provenance later compensation");
    const firstClone = preservePrimaryAndCompensationErrors(
      semanticPrimary,
      [firstFailure],
      "first provenance aggregate"
    ) as Error;
    const laterClone = preservePrimaryAndCompensationErrors(
      firstClone,
      [laterFailure],
      "later provenance aggregate"
    ) as Error;

    expect(laterClone).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(laterClone).not.toBeInstanceOf(StructuredServiceError);
    expect(semanticPrimaryError(laterClone)).toBe(semanticPrimary);
    expect(Object.getPrototypeOf(semanticPrimary)).toBe(StructuredServiceError.prototype);
    expectPreservedOwnDescriptors(semanticPrimary, semanticDescriptors);
    expect(Object.isFrozen(semanticPrimary)).toBe(true);
    expect(Object.isSealed(semanticPrimary)).toBe(true);
    expect(Object.isExtensible(semanticPrimary)).toBe(false);
    expect(laterClone.cause).toBeInstanceOf(AggregateError);
    expect((laterClone.cause as AggregateError).message).toBe("later provenance aggregate");
    expect((laterClone.cause as AggregateError).errors).toEqual([
      semanticPriorCause,
      firstFailure,
      laterFailure
    ]);
    expect(countErrorNodes(laterClone, (error) => error instanceof AggregateError)).toBe(1);

    const differentPrimary = new Error("different semantic primary");
    const trailingFailure = new Error("different trailing compensation");
    const compensationClone = preservePrimaryAndCompensationErrors(
      differentPrimary,
      [firstClone, trailingFailure],
      "compensation provenance aggregate"
    ) as Error;
    expect((compensationClone.cause as AggregateError).errors).toEqual([
      semanticPrimary,
      firstFailure,
      trailingFailure
    ]);
    expect((compensationClone.cause as AggregateError).errors).not.toContain(semanticPriorCause);
    expect(semanticPrimary.cause).toBe(semanticPriorCause);
    expect(countErrorNodes(compensationClone, (error) => error === semanticPriorCause)).toBe(1);
    expect(countErrorNodes(compensationClone, (error) => error instanceof AggregateError)).toBe(1);

    const accessorPriorCause = new Error("accessor provenance prior cause");
    const accessorPrimary = new Error("accessor provenance semantic primary");
    let accessorCauseReads = 0;
    Object.defineProperty(accessorPrimary, "cause", {
      configurable: true,
      enumerable: false,
      get: () => {
        accessorCauseReads += 1;
        return accessorPriorCause;
      }
    });
    const accessorRawCompensation = new Error("accessor provenance raw compensation");
    const accessorSecondCompensation = new Error("accessor provenance second compensation");
    const accessorThirdCompensation = new Error("accessor provenance third compensation");
    const accessorFirstClone = preservePrimaryAndCompensationErrors(
      accessorPrimary,
      [accessorRawCompensation],
      "accessor first aggregate"
    ) as Error;
    expect(accessorCauseReads).toBe(1);
    const accessorSecondClone = preservePrimaryAndCompensationErrors(
      accessorFirstClone,
      [accessorSecondCompensation],
      "accessor second aggregate"
    ) as Error;
    const accessorFinalClone = preservePrimaryAndCompensationErrors(
      accessorSecondClone,
      [accessorThirdCompensation],
      "accessor final aggregate"
    ) as Error;
    expect(accessorCauseReads).toBe(1);
    expect((accessorFinalClone.cause as AggregateError).errors).toEqual([
      accessorPriorCause,
      accessorRawCompensation,
      accessorSecondCompensation,
      accessorThirdCompensation
    ]);

    const accessorTrailingCompensation = new Error("accessor provenance trailing compensation");
    const accessorOuterPrimary = new Error("accessor provenance outer primary");
    const accessorOuterClone = preservePrimaryAndCompensationErrors(
      accessorOuterPrimary,
      [accessorFirstClone, accessorTrailingCompensation],
      "accessor outer aggregate"
    ) as Error;
    expect(accessorCauseReads).toBe(1);
    expect((accessorOuterClone.cause as AggregateError).errors).toEqual([
      accessorPrimary,
      accessorRawCompensation,
      accessorTrailingCompensation
    ]);
    expect((accessorOuterClone.cause as AggregateError).errors).not.toContain(
      accessorPriorCause
    );
    expect(Object.getOwnPropertyDescriptor(accessorPrimary, "cause")?.get).toBeFunction();

    const userPriorLeaf = new Error("user prior leaf");
    const userPriorAggregate = new AggregateError([userPriorLeaf], "user prior aggregate");
    const userCompensationLeaf = new Error("user compensation leaf");
    const userCompensationAggregate = new AggregateError(
      [userCompensationLeaf],
      "user compensation aggregate"
    );
    const userPrimary = new Error("user aggregate primary", { cause: userPriorAggregate });
    const userResult = preservePrimaryAndCompensationErrors(
      userPrimary,
      [userCompensationAggregate],
      "user aggregate preservation"
    ) as Error;
    expect((userResult.cause as AggregateError).errors).toEqual([
      userPriorAggregate,
      userCompensationAggregate
    ]);
    expect((userResult.cause as AggregateError).errors[0]).toBe(userPriorAggregate);
    expect((userResult.cause as AggregateError).errors[1]).toBe(userCompensationAggregate);
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

  test.skipIf(!caseAliasWorkspaceSupported)("physical authority identity converges across filesystem case aliases and isolates workspaces", async () => {
    const aliasWorkspace = await createCaseAliasWorkspacePath();
    if (!aliasWorkspace) {
      throw new Error("Expected case-insensitive workspace aliases to be supported.");
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

  test.skipIf(!caseAliasWorkspaceSupported)("missing ASCII record leaf case aliases share authority before creation", async () => {
    const aliasWorkspace = await createCaseAliasWorkspacePath();
    if (!aliasWorkspace) {
      throw new Error("Expected case-insensitive workspace aliases to be supported.");
    }
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

  test.skipIf(!caseAliasWorkspaceSupported)("retained cleanup permits bound cumulative case aliases and recover after terminal admission", async () => {
    const aliasWorkspace = await createCaseAliasWorkspacePath();
    if (!aliasWorkspace) {
      throw new Error("Expected case-insensitive workspace aliases to be supported.");
    }
    const { tempRoot, workspaceRoot } = aliasWorkspace;
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "bounded-case-aliases" };
    const directorySegments = ["alias-capacity"] as const;
    const lowerCaseFileName = "aliascapacity.json";
    const originalEvidenceRef = "authority.alias-capacity.original";
    const originalPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, lowerCaseFileName],
      originalEvidenceRef
    );
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      lowerCaseFileName,
      record,
      originalEvidenceRef,
      schema
    );
    if (created.status !== "created") {
      throw new Error("Expected a retained cleanup permit fixture.");
    }
    await rm(originalPath);

    for (let variant = 1; variant < 64; variant += 1) {
      const fileName = asciiCaseVariant(lowerCaseFileName, variant);
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        `authority.alias-capacity.admitted.${variant}`
      );
      expect(
        await readJsonRecord(
          path,
          `authority.alias-capacity.admitted.${variant}`,
          schema
        )
      ).toBeUndefined();
    }

    const overflowFileName = asciiCaseVariant(lowerCaseFileName, 64);
    const overflowEvidenceRef = "authority.alias-capacity.overflow";
    const overflowPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, overflowFileName],
      overflowEvidenceRef
    );
    const overflow = await captureTaskServiceError(() =>
      readJsonRecord(overflowPath, overflowEvidenceRef, schema)
    );
    expect(overflow.code).toBe("record_malformed");
    expect(overflow.status).toBe(409);
    expect(overflow.retryable).toBe(true);
    expect(overflow.evidenceRefs).toEqual([overflowEvidenceRef]);
    expect(overflow.message).toBe("Workspace record authority coordination is at capacity.");
    expectErrorNotToLeakRecordContent(overflow, overflowFileName);
    expectErrorNotToLeakRecordContent(overflow, tempRoot);

    const retryEvidenceRef = "authority.alias-capacity.overflow-retry";
    const retry = await captureTaskServiceError(() =>
      readJsonRecord(overflowPath, retryEvidenceRef, schema)
    );
    expect(retry.retryable).toBe(true);
    expect(retry.evidenceRefs).toEqual([retryEvidenceRef]);
    expect(retry.message).toBe("Workspace record authority coordination is at capacity.");

    expect(
      await readJsonRecord(
        workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, asciiCaseVariant(lowerCaseFileName, 63)],
          "authority.alias-capacity.still-admitted"
        ),
        "authority.alias-capacity.still-admitted",
        schema
      )
    ).toBeUndefined();

    const terminalPermitError = await captureConditionalDeleteError(() =>
      conditionalDeleteJsonRecordWithCleanupPermit(
        created.cleanupPermit,
        originalPath,
        originalEvidenceRef,
        schema,
        {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        }
      )
    );
    expect(terminalPermitError.mutationPhase).toBe("pre_mutation");
    expect(terminalPermitError.failureStage).toBe("permit_admission");

    expect(await readJsonRecord(overflowPath, overflowEvidenceRef, schema)).toBeUndefined();
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

  test("missing Unicode case and normalization aliases converge conservatively", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot, { recursive: true });
    for (const [label, [firstName, secondName]] of Object.entries(unicodeAuthorityPairs)) {
      const first = join(workspaceRoot, firstName);
      const second = join(workspaceRoot, secondName);
      const [firstUnknown, secondUnknown] = await runWithWorkspacePathSafetyHooks(
        { filesystemCaseSemantics: () => "unknown" },
        () => Promise.all([
          physicalAuthorityPathIdentity(first, `unicode.unknown.${label}.first`),
          physicalAuthorityPathIdentity(second, `unicode.unknown.${label}.second`)
        ])
      );
      expect(firstUnknown).toBe(secondUnknown);

      const [firstSensitive, secondSensitive] = await runWithWorkspacePathSafetyHooks(
        { filesystemCaseSemantics: () => "case_sensitive" },
        () => Promise.all([
          physicalAuthorityPathIdentity(first, `unicode.sensitive.${label}.first`),
          physicalAuthorityPathIdentity(second, `unicode.sensitive.${label}.second`)
        ])
      );
      expect(firstSensitive).not.toBe(secondSensitive);
    }
  });

  test.skipIf(!caseAliasWorkspaceSupported || !unicodeCaseAliasCapabilities.normalization)(
    "normalization aliases converge on a visible case-insensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseInsensitiveWorkspace("normalization");
    }
  );

  test.skipIf(!caseAliasWorkspaceSupported || !unicodeCaseAliasCapabilities.sigma)(
    "sigma and final-sigma aliases converge on a visible case-insensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseInsensitiveWorkspace("sigma");
    }
  );

  test.skipIf(!caseAliasWorkspaceSupported || !unicodeCaseAliasCapabilities.sharpS)(
    "sharp-s and SS aliases converge on a visible case-insensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseInsensitiveWorkspace("sharpS");
    }
  );

  test.skipIf(!unicodeDistinctEntryCapabilities.normalization)(
    "normalization aliases stay distinct on a supporting case-sensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseSensitiveWorkspace("normalization");
    }
  );

  test.skipIf(!unicodeDistinctEntryCapabilities.sigma)(
    "sigma and final-sigma aliases stay distinct on a supporting case-sensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseSensitiveWorkspace("sigma");
    }
  );

  test.skipIf(!unicodeDistinctEntryCapabilities.sharpS)(
    "sharp-s and SS aliases stay distinct on a supporting case-sensitive workspace",
    async () => {
      await expectUnicodeAuthorityPairOnCaseSensitiveWorkspace("sharpS");
    }
  );

  test("bigint device boundary comparison preserves adjacent unsafe integer identities", () => {
    const device = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(filesystemDeviceIdentityMatches(device, device)).toBe(true);
    expect(filesystemDeviceIdentityMatches(device, device + 1n)).toBe(false);
  });

  test("device-bounded case aliases preserve exact mount prefixes and fold only within each device", () => {
    const upperMount = join("/case-sensitive-parent", "Foo");
    const lowerMount = join("/case-sensitive-parent", "foo");
    const upperAlias = composeDeviceBoundedCaseAlias(
      upperMount,
      join(upperMount, "Records", "ENTRY.json")
    );
    const upperCaseVariant = composeDeviceBoundedCaseAlias(
      upperMount,
      join(upperMount, "records", "entry.JSON")
    );
    const lowerAlias = composeDeviceBoundedCaseAlias(
      lowerMount,
      join(lowerMount, "records", "entry.json")
    );

    expect(upperAlias).toBe(upperCaseVariant);
    expect(upperAlias).not.toBe(lowerAlias);
    expect(upperAlias.startsWith(`${upperMount}/`)).toBe(true);
    expect(lowerAlias.startsWith(`${lowerMount}/`)).toBe(true);
  });

  test("same-path followers retain missing-to-existing authority through publication", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "missing-existing-transition" };
    const evidenceRef = "authority.missing-existing";
    const directorySegments = ["authority-transitions"] as const;
    const fileName = "Transition.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const linked = createSignal();
    const linkGate = createAsyncGate();
    const owner = runWithWorkspaceRecordPublicationHooks(
      {
        afterCanonicalLink: async () => {
          linked.resolve();
          await linkGate.wait;
        }
      },
      () => createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    );
    await linked.promise;
    const contentions = [createSignal(), createSignal(), createSignal()];
    const reader = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => contentions[0]!.resolve() },
      () => readJsonRecord(path, evidenceRef, schema)
    );
    await contentions[0]!.promise;
    const creator = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => contentions[1]!.resolve() },
      () => createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    );
    await contentions[1]!.promise;
    const deleter = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => contentions[2]!.resolve() },
      () => conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    );
    await contentions[2]!.promise;
    linkGate.open();
    expect(await owner).toEqual({ status: "created", record });
    expect(await reader).toEqual(record);
    expect(await creator).toEqual({ status: "exists" });
    expect(await deleter).toEqual({ status: "deleted" });
  });

  test("same-path reader retains authority while conditional delete isolates the generation", async () => {
    const fixture = await createCleanupPermitQueueFixture("delete-isolation-transition");
    tempRoots.push(fixture.tempRoot);
    const isolated = createSignal();
    const isolationGate = createAsyncGate();
    const deletion = runWithWorkspaceRecordPublicationHooks(
      {
        beforeAuthorityOwnedUnlink: async ({ operation }) => {
          if (operation !== "conditional_delete") return;
          isolated.resolve();
          await isolationGate.wait;
        }
      },
      () => fixture.cleanup()
    );
    await isolated.promise;
    const contended = createSignal();
    const reader = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => contended.resolve() },
      () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)
    );
    await contended.promise;
    isolationGate.open();
    expect(await deletion).toEqual({ status: "deleted" });
    expect(await reader).toBeUndefined();
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

  test("conditional delete preserves non-owner public replacements before isolation", async () => {
    for (const kind of ["directory", "symlink", "file"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `conditional-public-${kind}` };
      const evidenceRef = `conditional.public.${kind}`;
      const fileName = `${kind}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        ["conditional-public-replacements", fileName],
        evidenceRef
      );
      await writeJsonRecord(
        workspaceRoot,
        ["conditional-public-replacements"],
        fileName,
        record,
        evidenceRef,
        schema
      );
      const ownerPath = join(tempRoot, `${kind}-conditional-owner.json`);
      const targetPath = join(tempRoot, `${kind}-conditional-target.json`);
      const replacementBytes = Buffer.from(`replacement-${kind}\n`);

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            beforeGenerationIsolation: async ({ operation }) => {
              if (operation !== "conditional_delete") return;
              await rename(path, ownerPath);
              if (kind === "directory") await mkdir(path);
              else if (kind === "symlink") {
                await writeFile(targetPath, replacementBytes, { flag: "wx" });
                await symlink(targetPath, path);
              } else {
                await writeFile(path, replacementBytes, { flag: "wx" });
              }
            }
          },
          () => conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        )
      );

      expect(error.code).toBe("record_malformed");
      expect(await readFile(ownerPath)).toEqual(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
      );
      const replacement = await lstat(path);
      if (kind === "directory") expect(replacement.isDirectory()).toBe(true);
      else if (kind === "symlink") {
        expect(replacement.isSymbolicLink()).toBe(true);
        expect(await readFile(targetPath)).toEqual(replacementBytes);
      } else {
        expect(await readFile(path)).toEqual(replacementBytes);
      }
      expect(
        (await readdir(join(workspaceRoot, "conditional-public-replacements"))).some(
          isOwnedRecordPath
        )
      ).toBe(false);
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

  test("filesystem case-semantics hook failures preserve identity without race retries", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot);
    const existingPath = join(workspaceRoot, "existing");
    const missingPath = join(workspaceRoot, "missing");
    await mkdir(existingPath);

    const failures = [
      new Error("case-semantics plain failure"),
      Object.assign(new Error("case-semantics ENOENT failure"), { code: "ENOENT" }),
      Object.assign(new Error("case-semantics ENOTDIR failure"), { code: "ENOTDIR" })
    ];
    const operations = [
      {
        name: "authority-existing",
        path: existingPath,
        action: (path: string) => physicalAuthorityPathIdentity(path, "hook.authority.existing")
      },
      {
        name: "authority-missing",
        path: missingPath,
        action: (path: string) => physicalAuthorityPathIdentity(path, "hook.authority.missing")
      },
      {
        name: "canonical-existing",
        path: existingPath,
        action: (path: string) => physicalCanonicalPath(path, "hook.canonical.existing")
      },
      {
        name: "canonical-missing",
        path: missingPath,
        action: (path: string) => physicalCanonicalPath(path, "hook.canonical.missing")
      }
    ];

    for (const operation of operations) {
      for (const failure of failures) {
        let invocations = 0;
        const observed = await captureError(() =>
          runWithWorkspacePathSafetyHooks(
            {
              filesystemCaseSemantics: () => {
                invocations += 1;
                throw failure;
              }
            },
            () => operation.action(operation.path)
          )
        );
        expect(observed, operation.name).toBe(failure);
        expect(invocations, operation.name).toBe(1);
      }
    }
  });

  test("ordinary record admission restarts authority observation when an existing leaf disappears", async () => {
    for (const semantics of ["case_sensitive", "case_insensitive", "unknown"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `ordinary-authority-race-${semantics}` };
      const evidenceRef = `authority.race.ordinary.${semantics}`;
      const fileName = `${semantics}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        ["authority-race-ordinary", fileName],
        evidenceRef
      );
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          ["authority-race-ordinary"],
          fileName,
          record,
          evidenceRef,
          schema
        )
      ).toEqual({ status: "created", record });
      const observedCandidates: Array<{
        candidatePath: string;
        exists: boolean;
        missingSegmentCount: number;
      }> = [];
      const semanticsPaths: string[] = [];

      const result = await runWithWorkspacePathSafetyHooks(
        {
          afterPhysicalCandidateLstat: async (input) => {
            observedCandidates.push({
              candidatePath: input.candidatePath,
              exists: input.exists,
              missingSegmentCount: input.missingSegmentCount
            });
            if (observedCandidates.length === 1) {
              expect(input.candidatePath).toBe(path);
              expect(input.exists).toBe(true);
              await rm(path);
            }
          },
          filesystemCaseSemantics: ({ existingPath }) => {
            semanticsPaths.push(existingPath);
            return semantics;
          }
        },
        () => readJsonRecord(path, evidenceRef, schema)
      );

      expect(result).toBeUndefined();
      expect(observedCandidates).toEqual([
        { candidatePath: path, exists: true, missingSegmentCount: 0 },
        { candidatePath: join(path, ".."), exists: true, missingSegmentCount: 1 }
      ]);
      expect(semanticsPaths).toEqual([join(path, "..")]);
      await expectPathMissing(path);
      expect(await readdir(join(path, ".."))).toEqual([]);
    }
  });

  test("ordinary record admission restarts authority observation when a missing leaf appears", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "ordinary-authority-race-created" };
    const evidenceRef = "authority.race.ordinary.created";
    const path = workspaceRecordPath(
      workspaceRoot,
      ["authority-race-ordinary", "created.json"],
      evidenceRef
    );
    await mkdir(join(path, ".."), { recursive: true });
    const observedCandidates: Array<{
      candidatePath: string;
      exists: boolean;
      missingSegmentCount: number;
    }> = [];
    const semanticsPaths: string[] = [];

    const result = await runWithWorkspacePathSafetyHooks(
      {
        afterPhysicalCandidateLstat: async (input) => {
          observedCandidates.push({
            candidatePath: input.candidatePath,
            exists: input.exists,
            missingSegmentCount: input.missingSegmentCount
          });
          if (observedCandidates.length === 1) {
            expect(input.candidatePath).toBe(join(path, ".."));
            expect(input.missingSegmentCount).toBe(1);
            await writeFile(path, `${JSON.stringify(record)}\n`, { flag: "wx" });
          }
        },
        filesystemCaseSemantics: ({ existingPath }) => {
          semanticsPaths.push(existingPath);
          return "case_sensitive";
        }
      },
      () => readJsonRecord(path, evidenceRef, schema)
    );

    expect(result).toEqual(record);
    expect(observedCandidates).toEqual([
      { candidatePath: join(path, ".."), exists: true, missingSegmentCount: 1 },
      { candidatePath: path, exists: true, missingSegmentCount: 0 }
    ]);
    expect(semanticsPaths).toEqual([path]);
    await rm(path);
    expect(await readdir(join(path, ".."))).toEqual([]);
  });

  test("cleanup permit authority races fail structurally and release terminal admission state", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "cleanup-authority-race-private-content" };
    const evidenceRef = "authority.race.cleanup";
    const directorySegments = ["authority-race-cleanup", "level-one", "level-two"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const created = await createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      fileName,
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected a cleanup permit race fixture.");
    const observedCandidates: Array<{
      candidatePath: string;
      exists: boolean;
      missingSegmentCount: number;
    }> = [];

    const failure = await captureConditionalDeleteError(() =>
      runWithWorkspacePathSafetyHooks(
        {
          afterPhysicalCandidateLstat: async (input) => {
            observedCandidates.push({
              candidatePath: input.candidatePath,
              exists: input.exists,
              missingSegmentCount: input.missingSegmentCount
            });
            await rm(input.candidatePath, { recursive: true });
          },
          filesystemCaseSemantics: () => "unknown"
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

    expect(observedCandidates).toEqual([
      { candidatePath: path, exists: true, missingSegmentCount: 0 },
      { candidatePath: join(path, ".."), exists: true, missingSegmentCount: 1 },
      { candidatePath: join(path, "..", ".."), exists: true, missingSegmentCount: 2 }
    ]);
    expect(failure.mutationPhase).toBe("pre_mutation");
    expect(failure.failureStage).toBe("permit_admission");
    expect(failure.cause).toBeInstanceOf(TaskServiceError);
    const serviceCause = failure.cause as TaskServiceError;
    expect(serviceCause.code).toBe("workspace_path_not_safe");
    expect(serviceCause.evidenceRefs).toEqual([evidenceRef]);
    expect(serviceCause.cause).toBeInstanceOf(WorkspacePathSafetyError);
    expect((serviceCause.cause as WorkspacePathSafetyError).evidenceRef).toBe(evidenceRef);
    expect((serviceCause.cause as { code?: unknown }).code).toBeUndefined();
    expectErrorNotToLeakRecordContent(serviceCause, tempRoot);
    expectErrorNotToLeakRecordContent(serviceCause, path);
    expectErrorNotToLeakRecordContent(serviceCause, record.id);

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

    await mkdir(join(path, ".."), { recursive: true });
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        `${evidenceRef}.retry`,
        schema
      )
    ).toEqual({ status: "created", record });
    expect(
      await conditionalDeleteJsonRecord(path, `${evidenceRef}.retry`, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
    expect(await readdir(join(path, ".."))).toEqual([]);
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

  test("conditional delete preserves pre-isolation replacement generations", async () => {
    for (const phase of ["replacement_inode", "same_inode_bytes"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const service = createLockRecordService({ workspaceRoot });
      const original = {
        ...validLockRecord(),
        lock_id: `LOCK-delete-generation-${phase}`
      };
      const replacement = { ...original, holder: "replacement-before-isolation" };
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
              if (phase === "replacement_inode") {
                const candidate = `${path}.replacement`;
                await writeFile(candidate, replacementBytes, { flag: "wx" });
                await rename(candidate, path);
              } else {
                await writeFile(path, replacementBytes);
              }
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
      if (phase === "replacement_inode") {
        expect(await readFile(recordPath)).toEqual(replacementBytes);
      } else {
        expect(await readFile(recordPath)).toEqual(replacementBytes);
        expect(
          (await readdir(join(workspaceRoot, "locks", original.scope))).some(isOwnedRecordPath)
        ).toBe(false);
      }
    }
  });

  test("conditional delete quarantines unproven same-inode byte mutations for valid and malformed records", async () => {
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
      await writeFile(path, originalBytes, { flag: "wx", mode: 0o600 });
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
      await expectPathMissing(path);
      const namespacePath = await findOnlyAuthorityNamespace(directoryPath);
      expect(await readFile(join(namespacePath, "generation"))).toEqual(modifiedBytes);
      await rm(namespacePath, { recursive: true });
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

  test.skipIf(!distinctCaseEntriesSupported)("ordinary deletion settles only the permit bound to the deleted generation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const directorySegments = ["permit-generation-settlement"] as const;
    const upperRecord = { id: "upper-generation" };
    const lowerRecord = { id: "lower-generation" };
    const upperPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, "Foo.json"],
      "permit.generation.upper"
    );
    const lowerPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, "foo.json"],
      "permit.generation.lower"
    );

    const upperCreated = await runWithWorkspacePathSafetyHooks(
      { filesystemCaseSemantics: () => "unknown" },
      () =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          "Foo.json",
          upperRecord,
          "permit.generation.upper",
          schema
        )
    );
    if (upperCreated.status !== "created") {
      throw new Error("Expected the upper-case cleanup permit fixture to be created.");
    }

    expect(
      await runWithWorkspacePathSafetyHooks(
        { filesystemCaseSemantics: () => "unknown" },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            "foo.json",
            lowerRecord,
            "permit.generation.lower",
            schema
        )
      )
    ).toEqual({ status: "created", record: lowerRecord });
    const upperBefore = await readFileWithIdentity(upperPath);
    const lowerBefore = await readFileWithIdentity(lowerPath);
    expect(upperBefore.ino).not.toBe(lowerBefore.ino);

    expect(
      await runWithWorkspacePathSafetyHooks(
        { filesystemCaseSemantics: () => "unknown" },
        () =>
          conditionalDeleteJsonRecord(
            lowerPath,
            "permit.generation.lower",
            schema,
            {
              kind: "record",
              expected: lowerRecord,
              matches: (current, expected) => current.id === expected.id
            }
          )
      )
    ).toEqual({ status: "deleted" });
    expect(await readFileWithIdentity(upperPath)).toEqual(upperBefore);

    expect(
      await conditionalDeleteJsonRecordWithCleanupPermit(
        upperCreated.cleanupPermit,
        upperPath,
        "permit.generation.upper",
        schema,
        {
          kind: "record",
          expected: upperRecord,
          matches: (current, expected) => current.id === expected.id
        }
      )
    ).toEqual({ status: "deleted" });
    await expectPathMissing(upperPath);
    await expectPathMissing(lowerPath);
  });

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

  test("ordinary pre-identity admission is globally bounded and retains timed-out slots until identity settles", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const service = createLockRecordService({ workspaceRoot });
    const identityGate = createAsyncGate();
    const allIdentityCallsEntered = createSignal();
    const allIdentityCallsCompleted = createSignal();
    const blockedTargets = new Set<string>();
    let identityAdmissions = 0;
    let identitySupplierInvocations = 0;
    let identityCompletions = 0;
    let saturation: Awaited<ReturnType<typeof saturateGlobalRecordAuthority>> | undefined;

    try {
      await runWithWorkspaceRecordPublicationHooks(
        {
          beforeRecordAuthorityIdentitySupplier: () => {
            identitySupplierInvocations += 1;
          }
        },
        () => runWithWorkspacePathSafetyHooks(
          {
            afterPhysicalCandidateLstat: async ({ targetPath }) => {
              if (blockedTargets.has(targetPath)) return;
              blockedTargets.add(targetPath);
              identityAdmissions += 1;
              if (identityAdmissions === 1024) allIdentityCallsEntered.resolve();
              await identityGate.wait;
            },
            filesystemCaseSemantics: () => {
              identityCompletions += 1;
              if (identityCompletions === 1024) allIdentityCallsCompleted.resolve();
              return "case_sensitive";
            }
          },
          async () => {
          const deadline = Date.now() + 1_000;
          const blockedCalls = Array.from({ length: 1024 }, (_, index) =>
            runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
              service.getLock("task", `LOCK-pre-identity-${index}`)
            ).then(
              () => {
                throw new Error("Expected blocked identity acquisition to time out.");
              },
              (error: unknown) => error
            )
          );

          await Promise.race([
            allIdentityCallsEntered.promise,
            timeoutAfter(2_000, "ordinary pre-identity calls did not all enter")
          ]);
          expect(identityAdmissions).toBe(1024);
          expect(identitySupplierInvocations).toBe(1024);

          const overflow = await captureTaskServiceError(() =>
            service.getLock("task", "LOCK-pre-identity-overflow")
          );
          expect(overflow.message).toBe(
            "Workspace record authority coordination is at capacity."
          );
          expect(overflow.retryable).toBe(true);
          expect(identityAdmissions).toBe(1024);
          expect(identitySupplierInvocations).toBe(1024);

          const timedOut = await Promise.race([
            Promise.all(blockedCalls),
            timeoutAfter(2_000, "ordinary pre-identity callers did not settle by deadline")
          ]);
          expect(timedOut).toHaveLength(1024);
          for (const error of timedOut) {
            expect(error).toBeInstanceOf(TaskServiceError);
            expect((error as TaskServiceError).retryable).toBe(true);
            expect((error as TaskServiceError).message).toBe(
              "Workspace record authority lease was not acquired before the bounded deadline."
            );
          }

          const retainedCapacity = await captureTaskServiceError(() =>
            service.getLock("task", "LOCK-pre-identity-retained")
          );
          expect(retainedCapacity.message).toBe(
            "Workspace record authority coordination is at capacity."
          );
          expect(identityAdmissions).toBe(1024);
          expect(identitySupplierInvocations).toBe(1024);

          identityGate.open();
          await Promise.race([
            allIdentityCallsCompleted.promise,
            timeoutAfter(2_000, "ordinary background identity work did not complete")
          ]);
          await delay(0);

          saturation = await saturateGlobalRecordAuthority(
            workspaceRoot,
            "LOCK-pre-identity-released"
          );
          saturation.release();
          expect(await saturation.completed).toEqual(
            Array.from({ length: 1024 }, () => undefined)
          );
          expect(
            await service.getLock("task", "LOCK-pre-identity-fresh")
          ).toBeUndefined();
          }
        )
      );
    } finally {
      identityGate.open();
      saturation?.release();
      await saturation?.completed.catch(() => undefined);
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
    const closedPinnedFileDescriptors = new Set<number>();
    const pinnedHandleClosedByPath = new Map<string, ReturnType<typeof createSignal>>();
    let pinnedHandleClosures = 0;

    try {
      for (let index = 0; index < 1024; index += 1) {
        const record = { id: `permit-capacity-${index}` };
        const fileName = `${record.id}.json`;
        const evidenceRef = `permit.capacity.${index}`;
        const result = await runWithWorkspaceRecordPublicationHooks(
          {
            afterCleanupPermitPinnedHandleClosed: (input) => {
              let descriptorError: unknown;
              try {
                fstatSync(input.fd);
              } catch (error) {
                descriptorError = error;
              }
              expect(descriptorError).toMatchObject({ code: "EBADF" });
              expect(closedPinnedFileDescriptors.has(input.fd)).toBe(false);
              const pinnedHandleClosed = pinnedHandleClosedByPath.get(input.path);
              if (!pinnedHandleClosed) {
                throw new Error(`Unexpected cleanup permit pinned handle path: ${input.path}`);
              }
              closedPinnedFileDescriptors.add(input.fd);
              pinnedHandleClosures += 1;
              pinnedHandleClosed.resolve();
            }
          },
          () =>
            createJsonRecordIfAbsentWithCleanupPermit(
              workspaceRoot,
              ["permit-capacity"],
              fileName,
              record,
              evidenceRef,
              schema
            )
        );
        if (result.status !== "created") throw new Error("Expected cleanup permit capacity fixture.");
        const path = workspaceRecordPath(
          workspaceRoot,
          ["permit-capacity", fileName],
          evidenceRef
        );
        pinnedHandleClosedByPath.set(path, createSignal());
        created.push({
          path,
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
      await Promise.race([
        (async () => {
          for (const { path, evidenceRef, record, permit } of created) {
            await conditionalDeleteJsonRecordWithCleanupPermit(
              permit,
              path,
              evidenceRef,
              schema,
              {
                kind: "record",
                expected: record,
                matches: (current, expected) => current.id === expected.id
              }
            );
            const pinnedHandleClosed = pinnedHandleClosedByPath.get(path);
            if (!pinnedHandleClosed) throw new Error(`Missing pinned handle signal: ${path}`);
            await pinnedHandleClosed.promise;
          }
        })(),
        timeoutAfter(10_000, "cleanup permit pinned handles did not all close")
      ]);
      expect(pinnedHandleClosures).toBe(1024);
      expect(closedPinnedFileDescriptors.size).toBe(1024);
      expect(closedPinnedFileDescriptors.size).toBe(created.length);

      const recoveryEvidenceRef = "permit.capacity.recovered";
      const recoveryPath = workspaceRecordPath(
        workspaceRoot,
        ["permit-capacity", "permit-capacity-recovered.json"],
        recoveryEvidenceRef
      );
      const recoveryRecord = { id: "permit-capacity-recovered" };
      const recovery = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["permit-capacity"],
        "permit-capacity-recovered.json",
        recoveryRecord,
        recoveryEvidenceRef,
        schema
      );
      expect(recovery.status).toBe("created");
      if (recovery.status === "created") {
        expect(
          await conditionalDeleteJsonRecordWithCleanupPermit(
            recovery.cleanupPermit,
            recoveryPath,
            recoveryEvidenceRef,
            schema,
            {
              kind: "record",
              expected: recoveryRecord,
              matches: (current, expected) => current.id === expected.id
            }
          )
        ).toEqual({ status: "deleted" });
      }
    }
  }, 20_000);

  test("cleanup permit pins its accepted generation and rejects an external unlink replacement", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "permit-pinned-generation" };
    const evidenceRef = "permit.pinned-generation";
    const directorySegments = ["permit-pinned-generation"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const pinnedClosed = createSignal();
    let pinnedCloseCount = 0;
    const created = await runWithWorkspaceRecordPublicationHooks(
      {
        afterCleanupPermitPinnedHandleClosed: ({ path: closedPath }) => {
          expect(closedPath).toBe(path);
          pinnedCloseCount += 1;
          pinnedClosed.resolve();
        }
      },
      () =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        )
    );
    if (created.status !== "created") throw new Error("Expected a pinned permit fixture.");
    const originalIdentity = await stat(path, { bigint: true });
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

    await rm(path);
    await writeFile(path, expectedBytes, { flag: "wx", mode: 0o600 });
    const replacementIdentity = await stat(path, { bigint: true });
    expect(workspaceRecordPhysicalIdentityMatches(replacementIdentity, originalIdentity)).toBe(
      false
    );

    const failure = await captureConditionalDeleteError(() =>
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
    expect(failure.mutationPhase).toBe("pre_mutation");
    expect(failure.failureStage).toBe("permit_admission");
    expect(await readFile(path)).toEqual(expectedBytes);
    expect(await stat(path, { bigint: true })).toMatchObject({
      dev: replacementIdentity.dev,
      ino: replacementIdentity.ino,
      nlink: 1n
    });
    await Promise.race([
      pinnedClosed.promise,
      timeoutAfter(2_000, "cleanup permit pinned handle did not close")
    ]);
    expect(pinnedCloseCount).toBe(1);
    expect(
      await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
  });

  test("claimed cleanup identity placeholders retain bounded capacity until terminal timeout", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const fixtures: Array<{
      path: string;
      evidenceRef: string;
      record: { id: string };
      permit: WorkspaceRecordCleanupPermit;
    }> = [];
    const identityGate = createAsyncGate();
    const allIdentityPlaceholdersEntered = createSignal();
    const allIdentityPlaceholdersCompleted = createSignal();
    const cleanupAttempts: Promise<WorkspaceRecordConditionalDeleteError>[] = [];
    let identityPlaceholderCount = 0;
    let identityCompletionCount = 0;
    const blockedIdentityTargets = new Set<string>();

    try {
      for (let index = 0; index < 1024; index += 1) {
        const record = { id: `claimed-capacity-${index}` };
        const fileName = `${record.id}.json`;
        const evidenceRef = `permit.claimed-capacity.${index}`;
        const result = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["claimed-permit-capacity"],
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (result.status !== "created") {
          throw new Error("Expected claimed cleanup capacity fixture.");
        }
        fixtures.push({
          path: workspaceRecordPath(
            workspaceRoot,
            ["claimed-permit-capacity", fileName],
            evidenceRef
          ),
          evidenceRef,
          record,
          permit: result.cleanupPermit
        });
      }

      const deadline = Date.now() + 1_500;
      for (const fixture of fixtures) {
        cleanupAttempts.push(
          captureConditionalDeleteError(() =>
            runWithWorkspaceRecordAuthorityDeadline(deadline, () =>
              runWithWorkspaceRecordPublicationHooks(
                {
                  beforeCleanupPermitIdentityResolution: () => {
                    identityPlaceholderCount += 1;
                    if (identityPlaceholderCount === 1024) {
                      allIdentityPlaceholdersEntered.resolve();
                    }
                  }
                },
                () => runWithWorkspacePathSafetyHooks(
                  {
                    afterPhysicalCandidateLstat: async ({ targetPath }) => {
                      if (blockedIdentityTargets.has(targetPath)) return;
                      blockedIdentityTargets.add(targetPath);
                      await identityGate.wait;
                    },
                    filesystemCaseSemantics: () => {
                      identityCompletionCount += 1;
                      if (identityCompletionCount === 1024) {
                        allIdentityPlaceholdersCompleted.resolve();
                      }
                      return "case_sensitive";
                    }
                  },
                  () =>
                    conditionalDeleteJsonRecordWithCleanupPermit(
                      fixture.permit,
                      fixture.path,
                      fixture.evidenceRef,
                      schema,
                      {
                        kind: "record",
                        expected: fixture.record,
                        matches: (current, expected) => current.id === expected.id
                      }
                    )
                )
              )
            )
          )
        );
      }

      await Promise.race([
        allIdentityPlaceholdersEntered.promise,
        timeoutAfter(2_000, "claimed cleanup identity placeholders did not all enter")
      ]);

      const overflowEvidenceRef = "permit.claimed-capacity.overflow";
      const overflowRecord = { id: "claimed-capacity-overflow" };
      const overflowFileName = `${overflowRecord.id}.json`;
      const overflowPath = workspaceRecordPath(
        workspaceRoot,
        ["claimed-permit-capacity", overflowFileName],
        overflowEvidenceRef
      );
      const capacityError = await captureTaskServiceError(() =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["claimed-permit-capacity"],
          overflowFileName,
          overflowRecord,
          overflowEvidenceRef,
          schema
        )
      );
      expect(capacityError.code).toBe("record_malformed");
      expect(capacityError.status).toBe(409);
      expect(capacityError.retryable).toBe(true);
      expect(capacityError.evidenceRefs).toEqual([overflowEvidenceRef]);
      expect(capacityError.message).toBe(
        "Workspace record authority coordination is at capacity."
      );

      const timeoutErrors = await Promise.race([
        Promise.all(cleanupAttempts),
        timeoutAfter(3_000, "claimed cleanup callers did not settle by deadline")
      ]);
      expect(timeoutErrors).toHaveLength(1024);
      for (const error of timeoutErrors) {
        expect(error.mutationPhase).toBe("pre_mutation");
        expect(error.failureStage).toBe("permit_admission");
        expect(error.cause).toBeInstanceOf(TaskServiceError);
        expect((error.cause as TaskServiceError).retryable).toBe(true);
      }

      const retainedCapacityError = await captureTaskServiceError(() =>
        createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          ["claimed-permit-capacity"],
          overflowFileName,
          overflowRecord,
          overflowEvidenceRef,
          schema
        )
      );
      expect(retainedCapacityError.message).toBe(
        "Workspace record authority coordination is at capacity."
      );

      identityGate.open();
      await Promise.race([
        allIdentityPlaceholdersCompleted.promise,
        timeoutAfter(3_000, "claimed cleanup background identity work did not complete")
      ]);
      await delay(0);

      const recovered = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["claimed-permit-capacity"],
        overflowFileName,
        overflowRecord,
        overflowEvidenceRef,
        schema
      );
      expect(recovered.status).toBe("created");
      if (recovered.status !== "created") {
        throw new Error("Expected cleanup capacity to recover after claimed admission timeout.");
      }

      await Promise.all(
        fixtures.map(({ path, evidenceRef, record }) =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        )
      );
      expect(
        await conditionalDeleteJsonRecordWithCleanupPermit(
          recovered.cleanupPermit,
          overflowPath,
          overflowEvidenceRef,
          schema,
          {
            kind: "record",
            expected: overflowRecord,
            matches: (current, expected) => current.id === expected.id
          }
        )
      ).toEqual({ status: "deleted" });

      const aliasRecovery = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        ["claimed-permit-capacity"],
        "claimed-capacity-0.json",
        fixtures[0]!.record,
        "permit.claimed-capacity.alias-recovery",
        schema
      );
      expect(aliasRecovery.status).toBe("created");
      if (aliasRecovery.status === "created") {
        expect(
          await conditionalDeleteJsonRecordWithCleanupPermit(
            aliasRecovery.cleanupPermit,
            fixtures[0]!.path,
            "permit.claimed-capacity.alias-recovery",
            schema,
            {
              kind: "record",
              expected: fixtures[0]!.record,
              matches: (current, expected) => current.id === expected.id
            }
          )
        ).toEqual({ status: "deleted" });
      }
    } finally {
      identityGate.open();
      await Promise.allSettled(cleanupAttempts);
    }
  }, 30_000);

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

  test("queued cleanup rejects a same-content replacement generation before mutation and releases its lane", async () => {
    const fixture = await createCleanupPermitQueueFixture("queued-generation-replacement");
    tempRoots.push(fixture.tempRoot);
    const holder = fixture.holdAuthority();
    await holder.acquired;
    const holderFailure = captureTaskServiceError(() => holder.completed);
    const generationOne = await readFileWithIdentity(fixture.path);
    const cleanupContended = createSignal();
    let mutationAdmissions = 0;
    const cleanup = captureConditionalDeleteError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: () => cleanupContended.resolve(),
          beforeConditionalDelete: () => {
            mutationAdmissions += 1;
          }
        },
        () => fixture.cleanup()
      )
    );
    await cleanupContended.promise;

    const displacedPath = join(fixture.tempRoot, "queued-generation-one.json");
    await rename(fixture.path, displacedPath);
    await writeFile(fixture.path, generationOne.bytes, { flag: "wx", mode: 0o600 });
    const generationTwo = await readFileWithIdentity(fixture.path);
    expect(
      generationTwo.dev === generationOne.dev && generationTwo.ino === generationOne.ino
    ).toBe(false);

    const ordinaryContended = createSignal();
    const followingOrdinary = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => ordinaryContended.resolve() },
      () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)
    );
    await ordinaryContended.promise;
    holder.release();

    const error = await cleanup;
    expect(error.mutationPhase).toBe("pre_mutation");
    expect(error.failureStage).toBe("operation");
    expect(mutationAdmissions).toBe(0);
    expect(await followingOrdinary).toEqual(fixture.record);
    expect((await holderFailure).code).toBe("workspace_path_not_safe");
    expect(await readFileWithIdentity(fixture.path)).toEqual(generationTwo);
    expect((await readdir(join(fixture.path, ".."))).some(isOwnedRecordPath)).toBe(false);

    const reusedPermit = await captureConditionalDeleteError(() => fixture.cleanup());
    expect(reusedPermit.mutationPhase).toBe("pre_mutation");
    expect(reusedPermit.failureStage).toBe("permit_admission");
    expect(await readFileWithIdentity(fixture.path)).toEqual(generationTwo);
    expect(
      await conditionalDeleteJsonRecord(
        fixture.path,
        fixture.evidenceRef,
        fixture.schema,
        {
          kind: "record",
          expected: fixture.record,
          matches: (current, expected) => current.id === expected.id
        }
      )
    ).toEqual({ status: "deleted" });
  });

  test("cleanup identity placeholders retain their exact FIFO position on free and contended lanes", async () => {
    for (const lane of ["free", "contended"] as const) {
      const fixture = await createCleanupPermitQueueFixture(`identity-placeholder-${lane}`);
      tempRoots.push(fixture.tempRoot);
      const holder = lane === "contended" ? fixture.holdAuthority() : undefined;
      if (holder) await holder.acquired;
      const identityEntered = createSignal();
      const identityGate = createAsyncGate();
      const ordinaryContended = createSignal();
      const order: string[] = [];
      const cleanup = runWithWorkspaceRecordPublicationHooks(
        {
          beforeCleanupPermitIdentityResolution: async () => {
            identityEntered.resolve();
            await identityGate.wait;
          },
          beforeConditionalDelete: () => order.push("cleanup")
        },
        () => fixture.cleanup()
      );
      await identityEntered.promise;
      const ordinary = runWithWorkspaceRecordPublicationHooks(
        {
          onAuthorityContention: () => ordinaryContended.resolve(),
          afterAuthorityLeaseAcquired: () => order.push("ordinary")
        },
        () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)
      );
      await ordinaryContended.promise;
      holder?.release();
      await Promise.resolve();
      expect(order).toEqual([]);
      identityGate.open();
      expect(await cleanup).toEqual({ status: "deleted" });
      expect(await ordinary).toBeUndefined();
      expect(order).toEqual(["cleanup", "ordinary"]);
      if (holder) await holder.completed;
    }
  });

  test("failed cleanup identity placeholder hands the retained lane to its next waiter", async () => {
    const fixture = await createCleanupPermitQueueFixture("identity-placeholder-failure");
    tempRoots.push(fixture.tempRoot);
    const identityEntered = createSignal();
    const identityGate = createAsyncGate();
    const cleanup = captureConditionalDeleteError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforeCleanupPermitIdentityResolution: async () => {
            identityEntered.resolve();
            await identityGate.wait;
            throw new Error("injected delayed identity failure");
          }
        },
        () => fixture.cleanup()
      )
    );
    await identityEntered.promise;
    const ordinaryContended = createSignal();
    const ordinary = runWithWorkspaceRecordPublicationHooks(
      { onAuthorityContention: () => ordinaryContended.resolve() },
      () => readJsonRecord(fixture.path, fixture.evidenceRef, fixture.schema)
    );
    await ordinaryContended.promise;
    identityGate.open();

    const error = await cleanup;
    expect(error.mutationPhase).toBe("pre_mutation");
    expect(error.failureStage).toBe("permit_admission");
    expect((error.cause as Error).message).toBe("injected delayed identity failure");
    expect(await ordinary).toEqual(fixture.record);
    expect(await conditionalDeleteJsonRecord(
      fixture.path,
      fixture.evidenceRef,
      fixture.schema,
      {
        kind: "record",
        expected: fixture.record,
        matches: (current, expected) => current.id === expected.id
      }
    )).toEqual({ status: "deleted" });
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

  test("first-attempt pre-unlink namespace replacement preserves foreign and owned generations", async () => {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: "unlink-retry-namespace-reproof" };
      const evidenceRef = "cleanup.retry.namespace-reproof";
      const directorySegments = ["cleanup-retry-reproof"] as const;
      const fileName = "record.json";
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      let displacedNamespace = "";
      let replacementNamespace = "";
      const foreignBytes = Buffer.from("foreign replacement generation\n");
      let hookCalls = 0;

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforePublicationTemporaryUnlinkSyscall: async ({ path: temporaryPath, attempt }) => {
              hookCalls += 1;
              const namespacePath = dirname(temporaryPath);
              if (attempt === 1) {
                displacedNamespace = `${namespacePath}.displaced`;
                replacementNamespace = namespacePath;
                await rename(namespacePath, displacedNamespace);
                await mkdir(replacementNamespace, { mode: 0o700 });
                await writeFile(join(replacementNamespace, "generation"), foreignBytes, {
                  flag: "wx",
                  mode: 0o600
                });
              }
            }
          },
          () => createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
        )
      );

      expect(hookCalls).toBe(1);
      expect(aggregateErrorMessages(failure)).toContain(
        "Workspace record publication authority could not be verified."
      );
      expect(await readFile(join(replacementNamespace, "generation"))).toEqual(foreignBytes);
      expect(await readFile(join(displacedNamespace, "generation"))).toEqual(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
      );
      await expectPathMissing(path);

      await rm(replacementNamespace, { recursive: true });
      await rename(displacedNamespace, replacementNamespace);
      expect(await readFile(join(replacementNamespace, "generation"))).toEqual(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
      );
      await rm(replacementNamespace, { recursive: true });
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          `${evidenceRef}.retry`,
          schema
        )
      ).toEqual({ status: "created", record });
    });

  test("namespace-removal hook ENOENT remains semantic and cannot produce false create", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "namespace-removal-semantic-enoent" };
    const evidenceRef = "namespace.removal.semantic-enoent";
    const directorySegments = ["namespace-removal-semantic"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const marker = Object.assign(new Error("semantic namespace-removal ENOENT"), {
      code: "ENOENT"
    });
    const attempts: number[] = [];
    let producerNamespace = "";

    const failure = await captureError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: ({ temporaryPath }) => {
            producerNamespace = dirname(temporaryPath);
          },
          beforeAuthorityNamespaceRemoval: ({ path: namespacePath, attempt }) => {
            if (namespacePath !== producerNamespace) return;
            attempts.push(attempt);
            throw marker;
          }
        },
        () => createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        )
      )
    );

    expect(attempts).toEqual([1, 2, 3]);
    expect(errorTreeContains(failure, marker)).toBe(true);
    expect(findErrorNode(failure, (error) => error === marker)).toBe(marker);
    await expectPathMissing(path);
    await expectPathMissing(producerNamespace);
    expect((await readdir(dirname(path))).filter(isOwnedRecordPath)).toEqual([]);

    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        `${evidenceRef}.retry`,
        schema
      )
    ).toEqual({ status: "created", record });
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
    let producerDescriptorClosed = false;

    const created = await runWithWorkspaceRecordPublicationHooks(
      {
        beforeTemporaryFileClose: (input) => {
          descriptor = input.descriptor;
        },
        afterTemporaryFileClosed: async (input) => {
          await expectFileDescriptorClosed(input.descriptor.fd);
          producerDescriptorClosed = true;
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

    expect(producerDescriptorClosed).toBe(true);
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

  test("cleanup permit ownership survives both compensation-state inspection failures", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });

    for (const site of ["published_rollback", "unpublished_cleanup"] as const) {
      const record = { id: `inspection-${site}` };
      const fileName = `${record.id}.json`;
      const evidenceRef = `permit.inspection.${site}`;
      const directorySegments = ["permit-inspection"] as const;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const primaryError = new Error(`primary ${site} failure`);
      const inspectionError = Object.assign(new Error(`inspection ${site} failure`), {
        code: "EIO"
      });
      const trailingInspectionError =
        site === "published_rollback"
          ? Object.assign(new Error("inspection unpublished cleanup failure"), { code: "EIO" })
          : undefined;
      const inspectionSites: string[] = [];

      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: () => {
              if (site === "unpublished_cleanup") throw primaryError;
            },
            afterCanonicalLink: () => {
              if (site === "published_rollback") throw primaryError;
            },
            beforePublicationCompensationStateInspection: (input) => {
              inspectionSites.push(input.site);
              expect(input.activeCleanupPermitCount).toBe(1);
              if (input.site === site) throw inspectionError;
              if (input.site === "unpublished_cleanup" && trailingInspectionError) {
                throw trailingInspectionError;
              }
            }
          },
          () =>
            createJsonRecordIfAbsentWithCleanupPermit(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
        )
      );

      expect(semanticPrimaryError(failure)?.message).toBe(
        site === "published_rollback"
          ? "Failed to publish workspace record claim."
          : primaryError.message
      );
      const compensationAggregate = findPreservedCompensationAggregate(failure);
      expect(compensationAggregate).toBeDefined();
      const aggregatedErrors = compensationAggregate!.errors;
      expect(aggregatedErrors).toContain(inspectionError);
      if (trailingInspectionError) expect(aggregatedErrors).toContain(trailingInspectionError);
      if (site === "published_rollback") expect(aggregatedErrors).toContain(primaryError);
      expect(inspectionSites).toEqual(
        site === "published_rollback"
          ? ["published_rollback", "unpublished_cleanup"]
          : ["unpublished_cleanup"]
      );
      await expectPathMissing(path);
      expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);

      const retried = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (retried.status !== "created") throw new Error("Expected inspection failure retry.");
      expect(
        await conditionalDeleteJsonRecordWithCleanupPermit(
          retried.cleanupPermit,
          path,
          evidenceRef,
          schema,
          {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          }
        )
      ).toEqual({ status: "deleted" });
      await expectPathMissing(path);
      expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("repeated distinct-path compensation inspection failures retain global permit capacity", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const directorySegments = ["permit-inspection-capacity"] as const;

    for (let index = 0; index < 8; index += 1) {
      const record = { id: `inspection-capacity-${index}` };
      const fileName = `${record.id}.json`;
      const evidenceRef = `permit.inspection.capacity.${index}`;
      const primaryError = new Error(`primary capacity failure ${index}`);
      const inspectionError = Object.assign(new Error(`inspection capacity failure ${index}`), {
        code: "EIO"
      });
      const failure = await captureError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterTemporaryFileWritten: () => {
              throw primaryError;
            },
            beforePublicationCompensationStateInspection: (input) => {
              expect(input.site).toBe("unpublished_cleanup");
              expect(input.activeCleanupPermitCount).toBe(1);
              throw inspectionError;
            }
          },
          () =>
            createJsonRecordIfAbsentWithCleanupPermit(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
        )
      );
      expect(semanticPrimaryError(failure)).toBe(primaryError);
      const compensationAggregate = findPreservedCompensationAggregate(failure);
      expect(compensationAggregate).toBeDefined();
      expect(compensationAggregate!.errors).toContain(inspectionError);
    }

    expect((await readdir(join(workspaceRoot, ...directorySegments))).some(isOwnedRecordPath)).toBe(
      false
    );
  });

  test("conditional delete keeps unproven post-isolation generations private", async () => {
    for (const authority of ["ordinary", "cleanup_permit"] as const) {
      for (const drift of ["same_inode_bytes", "replacement_inode"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `unproven-${authority}-${drift}` };
        const evidenceRef = `conditional.unproven.${authority}.${drift}`;
        const directorySegments = ["conditional-unproven"] as const;
        const fileName = `${authority}-${drift}.json`;
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (created.status !== "created") throw new Error("Expected unproven delete fixture.");
        const before = await readFileWithIdentity(path);
        const unprovenBytes = Buffer.from(`unproven-${authority}-${drift}\n`);
        let isolatedPath: string | undefined;
        let replacementIdentity: { dev: bigint; ino: bigint } | undefined;

        const failure = await captureError(() =>
          runWithWorkspaceRecordCompensationTestHooks(
            {
              afterOwnedPathIsolation: async (input) => {
                if (input.site !== "conditional_delete") return;
                isolatedPath = input.isolatedPath;
                if (drift === "same_inode_bytes") {
                  await writeFile(input.isolatedPath, unprovenBytes);
                } else {
                  await rm(input.isolatedPath);
                  await writeFile(input.isolatedPath, unprovenBytes, { flag: "wx" });
                  replacementIdentity = await stat(input.isolatedPath, { bigint: true });
                }
              }
            },
            () =>
              authority === "ordinary"
                ? conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                    kind: "record",
                    expected: record,
                    matches: (current, expected) => current.id === expected.id
                  })
                : conditionalDeleteJsonRecordWithCleanupPermit(
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

        const operationFailure =
          authority === "ordinary"
            ? failure
            : (failure as WorkspaceRecordConditionalDeleteError).cause;
        if (authority === "ordinary") {
          expect(failure).not.toBeInstanceOf(WorkspaceRecordConditionalDeleteError);
        } else {
          expect(failure).toBeInstanceOf(WorkspaceRecordConditionalDeleteError);
          expect((failure as WorkspaceRecordConditionalDeleteError).mutationPhase).toBe(
            "post_mutation"
          );
          expect((failure as WorkspaceRecordConditionalDeleteError).failureStage).toBe(
            "operation"
          );
        }
        expect(operationFailure).toBeInstanceOf(TaskServiceError);
        expect((operationFailure as TaskServiceError).code).toBe("record_malformed");
        expect((operationFailure as TaskServiceError).message).toBe(
          "Workspace record changed before conditional removal."
        );
        expect(findPreservedCompensationAggregate(operationFailure)).toBeDefined();
        await expectPathMissing(path);
        expect(isolatedPath).toBeDefined();
        expect(await readFile(isolatedPath!)).toEqual(unprovenBytes);
        const privateIdentity = await stat(isolatedPath!);
        if (drift === "same_inode_bytes") {
          expect(privateIdentity.dev).toBe(before.dev);
          expect(privateIdentity.ino).toBe(before.ino);
        } else {
          expect(BigInt(privateIdentity.dev)).toBe(replacementIdentity!.dev);
          expect(BigInt(privateIdentity.ino)).toBe(replacementIdentity!.ino);
          expect(privateIdentity.dev === before.dev && privateIdentity.ino === before.ino).toBe(
            false
          );
        }

        expect(await readJsonRecord(path, evidenceRef, schema)).toBeUndefined();
        const retry = await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        );
        expect(retry).toEqual({ status: "created", record });
        expect(
          await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        ).toEqual({ status: "deleted" });
        expect(await readFile(isolatedPath!)).toEqual(unprovenBytes);
      }
    }
  });

  test("partial owned temporary writes preserve compensation errors and only restore the proven generation", async () => {
    for (const outcome of ["restore_exact", "quarantine_replacement"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `partial-owned-temporary-${outcome}` };
      const evidenceRef = `temporary.partial.${outcome}`;
      const directorySegments = ["partial-owned-temporary"] as const;
      const fileName = `${outcome}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const partialBytes = Buffer.from(`partial-${outcome}\n`);
      const replacementBytes = Buffer.from(`replacement-${outcome}\n`);
      const primaryError = new Error(`partial write primary ${outcome}`);
      const isolationError = new Error(`conditional unlink isolation ${outcome}`);
      const inspectionError = Object.assign(
        new Error(`conditional unlink inspection ${outcome}`),
        { code: "EIO" }
      );
      let temporaryPath: string | undefined;
      let expectedIdentity: { dev: bigint; ino: bigint } | undefined;
      let isolatedPath: string | undefined;
      let replacementIdentity: { dev: bigint; ino: bigint } | undefined;
      let pinnedDescriptor: number | undefined;

      const failure = await captureTaskServiceError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              temporaryPath = input.path;
              expectedIdentity = input.identity;
              pinnedDescriptor = input.fd;
              await writeFile(input.path, partialBytes);
              throw primaryError;
            },
            afterOwnedPathIsolation: async (input) => {
              if (input.site !== "conditional_unlink_owned_path") return;
              isolatedPath = input.isolatedPath;
              if (outcome === "quarantine_replacement") {
                await rm(input.isolatedPath);
                await writeFile(input.isolatedPath, replacementBytes, { flag: "wx" });
                replacementIdentity = await stat(input.isolatedPath, { bigint: true });
              }
              const pinnedIdentity = await readFileDescriptorIdentity(pinnedDescriptor!);
              expect(workspaceRecordPhysicalIdentityMatches(pinnedIdentity, expectedIdentity!)).toBe(
                true
              );
              throw isolationError;
            },
            beforeOwnedPathCompensationStateInspection: ({ site }) => {
              if (site === "conditional_unlink_owned_path") throw inspectionError;
            }
          },
          () =>
            createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
        )
      );

      expect(failure.code).toBe("workspace_path_not_safe");
      expect(failure.message).toBe("Failed to write workspace record temporary file.");
      expect(findPreservedCompensationAggregate(failure)).toBeDefined();
      expect(errorTreeContains(failure, primaryError)).toBe(true);
      expect(aggregateErrorMessages(failure)).toContain(isolationError.message);
      expect(errorTreeContains(failure, inspectionError)).toBe(true);
      await expectPathMissing(path);
      expect(temporaryPath).toBeDefined();
      expect(expectedIdentity).toBeDefined();
      expect(isolatedPath).toBeDefined();
      expect(pinnedDescriptor).toBeDefined();
      await expectFileDescriptorClosed(pinnedDescriptor!);

      if (outcome === "restore_exact") {
        await expectPrivateAuthorityDirectory(dirname(temporaryPath!));
        expect(await readFile(temporaryPath!)).toEqual(partialBytes);
        const restoredIdentity = await stat(temporaryPath!, { bigint: true });
        expect(workspaceRecordPhysicalIdentityMatches(restoredIdentity, expectedIdentity!)).toBe(
          true
        );
        await expectPathMissing(isolatedPath!);
        expect((await readdir(dirname(temporaryPath!))).some(isOwnedRecordPath)).toBe(false);
      } else {
        await expectPrivateAuthorityDirectory(dirname(temporaryPath!));
        await expectPrivateAuthorityDirectory(dirname(isolatedPath!));
        await expectPathMissing(temporaryPath!);
        expect(await readFile(isolatedPath!)).toEqual(replacementBytes);
        const privateIdentity = await stat(isolatedPath!, { bigint: true });
        expect(privateIdentity.dev).toBe(replacementIdentity!.dev);
        expect(privateIdentity.ino).toBe(replacementIdentity!.ino);
        expect(
          workspaceRecordPhysicalIdentityMatches(privateIdentity, expectedIdentity!)
        ).toBe(false);
      }
    }
  });

  test("conditional delete keeps its post-isolation primary while inspection fails and restoration continues", async () => {
    for (const authority of ["ordinary", "cleanup_permit"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `post-isolation-${authority}` };
      const evidenceRef = `conditional.post-isolation.${authority}`;
      const directorySegments = ["conditional-post-isolation"] as const;
      const fileName = `${authority}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
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
      const primaryEvidenceRefs = [evidenceRef];
      const primaryRecommendedNextActions = ["Inspect the injected failure."];
      const primaryError = new TaskServiceError({
        code: "workspace_path_not_safe",
        status: 500,
        category: "workspace_error",
        message: `post-isolation ${authority} primary`,
        userMessage: "Injected post-isolation failure.",
        evidenceRefs: primaryEvidenceRefs,
        recommendedNextActions: primaryRecommendedNextActions
      });
      primaryError.stack = `TaskServiceError: ${primaryError.message}\n    at semantic-primary`;
      const inspectionError = Object.assign(
        new Error(`post-isolation ${authority} inspection`),
        { code: "EIO" }
      );
      const sites: string[] = [];

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: ({ site }) => {
              sites.push(`primary:${site}`);
              throw primaryError;
            },
            beforeOwnedPathCompensationStateInspection: ({ site }) => {
              sites.push(`inspection:${site}`);
              throw inspectionError;
            }
          },
          () =>
            authority === "ordinary"
              ? conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                  kind: "record",
                  expected: record,
                  matches: (current, expected) => current.id === expected.id
                })
              : conditionalDeleteJsonRecordWithCleanupPermit(
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

      const preservedPrimary =
        authority === "ordinary"
          ? failure
          : (failure as WorkspaceRecordConditionalDeleteError).cause;
      if (authority === "cleanup_permit") {
        expect(failure).toBeInstanceOf(WorkspaceRecordConditionalDeleteError);
        expect((failure as WorkspaceRecordConditionalDeleteError).mutationPhase).toBe(
          "post_mutation"
        );
        expect((failure as WorkspaceRecordConditionalDeleteError).failureStage).toBe("operation");
      }
      expect(preservedPrimary).toBeInstanceOf(TaskServiceError);
      expect(preservedPrimary).toMatchObject({
        code: primaryError.code,
        status: primaryError.status,
        category: primaryError.category,
        message: primaryError.message,
        userMessage: primaryError.userMessage
      });
      expect(errorTreeContains(preservedPrimary, inspectionError)).toBe(true);
      const compatibilityWrapper = preservedPrimary as TaskServiceError;
      expect(compatibilityWrapper).not.toBe(primaryError);
      expect(compatibilityWrapper.name).toBe(primaryError.name);
      expect(compatibilityWrapper.message).toBe(primaryError.message);
      expect(compatibilityWrapper.code).toBe(primaryError.code);
      expect(compatibilityWrapper.status).toBe(primaryError.status);
      expect(compatibilityWrapper.category).toBe(primaryError.category);
      expect(compatibilityWrapper.userMessage).toBe(primaryError.userMessage);
      expect(compatibilityWrapper.retryable).toBe(primaryError.retryable);
      expect(compatibilityWrapper.evidenceRefs).toEqual(primaryError.evidenceRefs);
      expect(compatibilityWrapper.evidenceRefs).not.toBe(primaryError.evidenceRefs);
      expect(compatibilityWrapper.recommendedNextActions).toEqual(
        primaryError.recommendedNextActions
      );
      expect(compatibilityWrapper.recommendedNextActions).not.toBe(
        primaryError.recommendedNextActions
      );
      expect(compatibilityWrapper.stack).toBe(primaryError.stack);
      expect(compatibilityWrapper.cause).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      expect(semanticPrimaryError(compatibilityWrapper)).toBe(primaryError);

      const compatibilityMutationCause = new Error("compatibility wrapper mutation");
      Object.assign(compatibilityWrapper, {
        name: "MutatedCompatibilityWrapper",
        message: "mutated compatibility message",
        code: "record_malformed",
        status: 400,
        category: "mutated_category",
        userMessage: "mutated user message",
        retryable: true,
        stack: "mutated compatibility stack",
        cause: compatibilityMutationCause
      });
      compatibilityWrapper.evidenceRefs.push("mutated.evidence");
      compatibilityWrapper.recommendedNextActions.push("Mutated action.");
      expect(primaryError).toMatchObject({
        name: "TaskServiceError",
        message: `post-isolation ${authority} primary`,
        code: "workspace_path_not_safe",
        status: 500,
        category: "workspace_error",
        userMessage: "Injected post-isolation failure.",
        retryable: false,
        stack: `TaskServiceError: post-isolation ${authority} primary\n    at semantic-primary`
      });
      expect(primaryError.evidenceRefs).toEqual(primaryEvidenceRefs);
      expect(primaryError.recommendedNextActions).toEqual(primaryRecommendedNextActions);
      expect(primaryError.cause).toBeUndefined();
      expect(semanticPrimaryError(compatibilityWrapper)).toBe(primaryError);
      expect(sites).toEqual([
        "primary:conditional_delete",
        "inspection:conditional_delete"
      ]);
      expect(await readFileWithIdentity(path)).toEqual(before);
      expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);

      if (authority === "cleanup_permit") {
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
        expect(reusedPermit.failureStage).toBe("permit_admission");
      }
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("isolated generation restore retries source unlink and rolls back only its exact public link", async () => {
    for (const outcome of ["rollback_exact_link", "preserve_public_replacement"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-source-unlink-${outcome}` };
      const replacement = { id: `restore-public-replacement-${outcome}` };
      const evidenceRef = `restore.source-unlink.${outcome}`;
      const directorySegments = ["restore-source-unlink"] as const;
      const fileName = `${outcome}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        )
      ).toEqual({ status: "created", record });
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
      const isolationFailure = new Error(`restore isolation primary ${outcome}`);
      const unlinkFailures = Array.from(
        { length: 3 },
        (_, index) => new Error(`restore source unlink ${outcome} attempt ${index + 1}`)
      );
      let isolatedPath: string | undefined;
      const attempts: Array<{ site: string; attempt: number }> = [];

      const failure = await captureTaskServiceError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: (input) => {
              if (input.site !== "conditional_delete") return;
              isolatedPath = input.isolatedPath;
              throw isolationFailure;
            },
            beforeOwnedIsolatedSourceUnlink: async (input) => {
              attempts.push({ site: input.site, attempt: input.attempt });
              if (outcome === "preserve_public_replacement" && input.attempt === 3) {
                await rm(input.path);
                await writeFile(input.path, replacementBytes, { flag: "wx" });
              }
              throw unlinkFailures[input.attempt - 1]!;
            }
          },
          () => conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        )
      );

      const errorMessages = aggregateErrorMessages(failure);
      expect(errorMessages).toContain(isolationFailure.message);
      for (const unlinkFailure of unlinkFailures) {
        expect(errorMessages).toContain(unlinkFailure.message);
      }
      const restoreFailure = findErrorNode(
        failure,
        (error) =>
          error instanceof TaskServiceError &&
          error.message ===
            "Workspace record generation could not be restored after a failed mutation."
      );
      expect(restoreFailure).toBeDefined();
      const restoreEnvelope = restoreFailure!.cause as PreservedErrorCompensationEnvelope;
      expect(restoreEnvelope).toBeInstanceOf(PreservedErrorCompensationEnvelope);
      const restorePrimary = semanticPrimaryError(restoreEnvelope);
      expect(restorePrimary).toBe(unlinkFailures[0]);
      expect(Object.getPrototypeOf(restorePrimary)).toBe(
        Object.getPrototypeOf(unlinkFailures[0]!)
      );
      expect(restorePrimary!.message).toBe(unlinkFailures[0]!.message);
      expect(restoreEnvelope.cause).toBeInstanceOf(AggregateError);
      const restoreCompensations = restoreEnvelope.cause as AggregateError;
      expect(restoreCompensations.message).toBe(
        "Workspace record publication compensation failed."
      );
      expect(restoreCompensations.errors[0]).toBe(unlinkFailures[1]);
      expect(restoreCompensations.errors[1]).toBe(unlinkFailures[2]);
      expect(
        restoreCompensations.errors.filter((error) => error instanceof AggregateError)
      ).toHaveLength(0);
      expect(countErrorNodes(restoreFailure, (error) => error instanceof AggregateError)).toBe(1);
      if (outcome === "rollback_exact_link") {
        expect(restoreCompensations.errors).toHaveLength(2);
      } else {
        expect(restoreCompensations.errors).toHaveLength(3);
        expect(restoreCompensations.errors[2]).toBeInstanceOf(TaskServiceError);
        expect(restoreCompensations.errors[2]).toMatchObject({
          code: "workspace_path_not_safe",
          status: 500,
          category: "workspace_error",
          message: "Workspace record publication authority could not be verified."
        });
      }
      expect(attempts).toEqual([
        { site: "conditional_delete", attempt: 1 },
        { site: "conditional_delete", attempt: 2 },
        { site: "conditional_delete", attempt: 3 }
      ]);
      expect(isolatedPath).toBeDefined();
      expect(await readFile(isolatedPath!)).toEqual(expectedBytes);
      expect((await stat(isolatedPath!, { bigint: true })).nlink).toBe(1n);
      if (outcome === "rollback_exact_link") {
        await expectPathMissing(path);
      } else {
        expect(await readFile(path)).toEqual(replacementBytes);
        expect((await stat(path, { bigint: true })).nlink).toBe(1n);
        expect(aggregateErrorMessages(failure)).toContain(
          "Workspace record publication authority could not be verified."
        );
      }
      await rm(dirname(isolatedPath!), { recursive: true });
    }
  });

  test("post-link proof failure rolls back its owned link and retries restoration without residue", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "restore-post-link-proof-retry" };
    const evidenceRef = "restore.post-link-proof.retry";
    const directorySegments = ["restore-post-link-proof"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
    const before = await readFileWithIdentity(path);
    const isolationFailure = new Error("force post-link restore proof");
    const proofFailure = new Error("transient post-link proof failure");
    let postLinkProofCalls = 0;
    let ownedRollbackCalls = 0;

    const failure = await captureTaskServiceError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: (input) => {
            if (input.site === "conditional_delete") throw isolationFailure;
          },
          afterOwnedPublicLinkCreated: (input) => {
            if (input.site !== "conditional_delete") return;
            postLinkProofCalls += 1;
            if (postLinkProofCalls === 1) throw proofFailure;
          },
          beforeExactOwnedPublicLinkUnlink: () => {
            ownedRollbackCalls += 1;
          }
        },
        () =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(errorTreeContains(failure, isolationFailure)).toBe(true);
    expect(errorTreeContains(failure, proofFailure)).toBe(false);
    expect(postLinkProofCalls).toBe(2);
    expect(ownedRollbackCalls).toBe(1);
    expect(await readFileWithIdentity(path)).toEqual(before);
    expect((await stat(path, { bigint: true })).nlink).toBe(1n);
    expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    expect(
      await conditionalDeleteJsonRecord(path, `${evidenceRef}.repaired`, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
    expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
  });

  test("all restore call sites share post-link rollback and repaired retry cleanup", async () => {
    for (const site of [
      "conditional_delete",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-post-link-shared-${site}` };
      const evidenceRef = `restore.post-link.shared.${site}`;
      const directorySegments = ["restore-post-link-shared"] as const;
      const fileName = `${site}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const primary = new Error(`post-link shared primary ${site}`);
      const isolationFailure = new Error(`post-link shared isolation ${site}`);
      const proofFailure = new Error(`post-link shared proof ${site}`);
      let temporaryPath: string | undefined;
      let isolatedPath = "";
      const postLinkSites: string[] = [];
      let rollbackCalls = 0;

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              if (site !== "conditional_unlink_owned_path") return;
              temporaryPath = input.path;
              await writeFile(input.path, Buffer.from(`partial ${site}\n`));
              throw primary;
            },
            afterOwnedPathIsolation: (input) => {
              if (input.site !== site) return;
              isolatedPath = input.isolatedPath;
              throw isolationFailure;
            },
            afterOwnedPublicLinkCreated: (input) => {
              if (input.site !== site) return;
              postLinkSites.push(input.site);
              if (postLinkSites.length === 1) throw proofFailure;
            },
            beforeExactOwnedPublicLinkUnlink: () => {
              rollbackCalls += 1;
            }
          },
          async () => {
            if (site === "conditional_delete") {
              expect(
                await createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
              ).toEqual({ status: "created", record });
              return await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                kind: "record",
                expected: record,
                matches: (current, expected) => current.id === expected.id
              });
            }
            return await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: async (input) => {
                  temporaryPath = input.temporaryPath;
                  if (site === "temporary_generation_compensation") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "published_rollback") throw primary;
                },
                beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                  if (site !== "temporary_generation_compensation") return;
                  await chmod(dirname(candidatePath), 0o500);
                  throw new Error("retain shared post-link generation for compensation");
                },
                beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                  if (
                    site === "temporary_generation_compensation" &&
                    inspectionSite === "unpublished_cleanup" &&
                    temporaryPath
                  ) {
                    await chmod(dirname(temporaryPath), 0o700);
                  }
                }
              },
              () =>
                createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
            );
          }
        )
      );

      expect(errorTreeContains(failure, site === "conditional_delete" ? isolationFailure : primary)).toBe(
        true
      );
      expect(errorTreeContains(failure, proofFailure)).toBe(false);
      expect(postLinkSites).toEqual([site, site]);
      expect(rollbackCalls).toBe(1);
      await expectPathMissing(dirname(isolatedPath));
      const recordDirectory = dirname(path);
      for (const name of (await readdir(recordDirectory)).filter(isOwnedRecordPath)) {
        await rm(join(recordDirectory, name), { recursive: true, force: true });
      }

      const repaired = await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        `${evidenceRef}.repaired`,
        schema
      );
      expect(["created", "exists"]).toContain(repaired.status);
      expect(
        await conditionalDeleteJsonRecord(path, `${evidenceRef}.repaired`, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
      expect((await readdir(recordDirectory)).some(isOwnedRecordPath)).toBe(false);
    }
  });

  test("post-link rollback preserves foreign public and namespace replacements", async () => {
    for (const replacement of ["public", "namespace"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-post-link-foreign-${replacement}` };
      const evidenceRef = `restore.post-link.foreign.${replacement}`;
      const directorySegments = ["restore-post-link-foreign"] as const;
      const fileName = `${replacement}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        )
      ).toEqual({ status: "created", record });
      const foreignBytes = Buffer.from(`foreign ${replacement} replacement\n`);
      const isolationFailure = new Error(`force foreign ${replacement} restore`);
      const proofFailure = new Error(`foreign ${replacement} post-link proof`);
      let isolatedPath = "";
      let displacedNamespace = "";
      let foreignSentinel = "";
      let postLinkCalls = 0;

      const failure = await captureTaskServiceError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: (input) => {
              if (input.site !== "conditional_delete") return;
              isolatedPath = input.isolatedPath;
              throw isolationFailure;
            },
            afterOwnedPublicLinkCreated: async (input) => {
              if (input.site !== "conditional_delete") return;
              postLinkCalls += 1;
              if (replacement === "public") {
                await rm(input.path);
                await writeFile(input.path, foreignBytes, { flag: "wx", mode: 0o600 });
              } else {
                const namespacePath = dirname(input.isolatedPath);
                displacedNamespace = join(tempRoot, "displaced-owned-namespace");
                await rename(namespacePath, displacedNamespace);
                await mkdir(namespacePath, { mode: 0o700 });
                foreignSentinel = join(namespacePath, "foreign-sentinel");
                await writeFile(foreignSentinel, foreignBytes, { flag: "wx", mode: 0o600 });
              }
              throw proofFailure;
            }
          },
          () =>
            conditionalDeleteJsonRecord(path, evidenceRef, schema, {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            })
        )
      );

      expect(errorTreeContains(failure, isolationFailure)).toBe(true);
      expect(errorTreeContains(failure, proofFailure)).toBe(true);
      expect(postLinkCalls).toBe(1);
      if (replacement === "public") {
        expect(await readFile(path)).toEqual(foreignBytes);
        expect((await stat(path, { bigint: true })).nlink).toBe(1n);
        expect((await stat(isolatedPath, { bigint: true })).nlink).toBe(1n);
      } else {
        expect(await readFile(foreignSentinel)).toEqual(foreignBytes);
        expect(await readFile(join(displacedNamespace, basename(isolatedPath)))).toEqual(
          Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
        );
        expect((await stat(path, { bigint: true })).nlink).toBe(2n);
      }
    }
  });

  test("first restore commit proof rolls back a displaced public link exactly once", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "restore-first-proof-owned" };
    const replacement = { id: "restore-first-proof-replacement" };
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
    const evidenceRef = "restore.first-proof.single-rollback";
    const directorySegments = ["restore-first-proof"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
    const ownedBefore = await readFileWithIdentity(path);
    const isolationFailure = new Error("force first restore commit proof");
    let isolatedPath = "";
    let sourceUnlinkHookCalls = 0;
    let replacementIdentity: { bytes: Buffer; dev: number; ino: number } | undefined;

    const failure = await captureTaskServiceError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: (input) => {
            if (input.site !== "conditional_delete") return;
            isolatedPath = input.isolatedPath;
            throw isolationFailure;
          },
          beforeOwnedIsolatedSourceUnlink: async (input) => {
            sourceUnlinkHookCalls += 1;
            await rm(input.path);
            await writeFile(input.path, replacementBytes, { flag: "wx", mode: 0o600 });
            replacementIdentity = await readFileWithIdentity(input.path);
          }
        },
        () =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(sourceUnlinkHookCalls).toBe(1);
    const restoreFailure = findErrorNode(
      failure,
      (error) =>
        error instanceof TaskServiceError &&
        error.message === "Workspace record generation could not be restored after a failed mutation."
    );
    expect(restoreFailure).toBeDefined();
    const proofFailure = restoreFailure!.cause as TaskServiceError;
    expect(proofFailure).toMatchObject({
      code: "workspace_path_not_safe",
      message: "Workspace record publication authority could not be verified."
    });
    expect(semanticPrimaryError(proofFailure)).toBeInstanceOf(TaskServiceError);
    expect(proofFailure.cause).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    const rollbackFailures = (
      (proofFailure.cause as PreservedErrorCompensationEnvelope).cause as AggregateError
    ).errors;
    expect(rollbackFailures).toHaveLength(1);
    expect(rollbackFailures[0]).toMatchObject({
      code: "workspace_path_not_safe",
      message: "Workspace record publication authority could not be verified."
    });
    expect(countErrorNodes(restoreFailure, (error) => error instanceof AggregateError)).toBe(1);
    expect(await readFileWithIdentity(path)).toEqual(replacementIdentity!);
    expect(replacementIdentity!.bytes).toEqual(replacementBytes);
    expect(replacementIdentity!.dev === ownedBefore.dev && replacementIdentity!.ino === ownedBefore.ino).toBe(
      false
    );
    expect((await stat(path, { bigint: true })).nlink).toBe(1n);
    expect(await readFile(isolatedPath)).toEqual(expectedBytes);
    const isolatedIdentity = await stat(isolatedPath, { bigint: true });
    expect(isolatedIdentity).toMatchObject({ dev: BigInt(ownedBefore.dev), ino: BigInt(ownedBefore.ino) });
    expect(isolatedIdentity.nlink).toBe(1n);
  });

  test("restore rejects a remove-and-relink of the exact isolated inode before source commit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "restore-first-proof-same-inode-rebind" };
    const evidenceRef = "restore.first-proof.same-inode-rebind";
    const directorySegments = ["restore-first-proof-rebind"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    await createJsonRecordIfAbsent(
      workspaceRoot,
      directorySegments,
      fileName,
      record,
      evidenceRef,
      schema
    );
    const ownedBefore = await readFileWithIdentity(path);
    const isolationFailure = new Error("force same-inode restore rollback");
    let isolatedPath = "";
    let rebindCalls = 0;
    let sourceCommitCalls = 0;

    const failure = await captureError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: (input) => {
            if (input.site !== "conditional_delete") return;
            isolatedPath = input.isolatedPath;
            throw isolationFailure;
          },
          afterOwnedPublicLinkCreated: async (input) => {
            rebindCalls += 1;
            await rm(input.path);
            await link(input.isolatedPath, input.path);
          },
          afterOwnedIsolatedSourceUnlink: () => {
            sourceCommitCalls += 1;
          }
        },
        () =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(rebindCalls).toBe(1);
    expect(sourceCommitCalls).toBe(0);
    const rebound = await readFileWithIdentity(path);
    expect(rebound).toEqual(ownedBefore);
    expect(await readFileWithIdentity(isolatedPath)).toEqual(ownedBefore);
    expect((await stat(path, { bigint: true })).nlink).toBe(2n);
    expect((await stat(isolatedPath, { bigint: true })).nlink).toBe(2n);
    expect(errorTreeContains(failure, isolationFailure)).toBe(true);

    const restoreFailure = findErrorNode(
      failure,
      (error) =>
        error instanceof TaskServiceError &&
        error.message === "Workspace record generation could not be restored after a failed mutation."
    );
    expect(restoreFailure).toBeDefined();
    expect(
      aggregateErrorMessages(failure).filter(
        (message) =>
          message === "Workspace record publication authority could not be verified."
      )
    ).not.toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")(
    "failed public rollback unlink retains the isolated source at every restore site",
    async () => {
      for (const site of [
        "conditional_delete",
        "conditional_unlink_owned_path",
        "published_rollback",
        "temporary_generation_compensation"
      ] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `rollback-unlink-retained-${site}` };
        const evidenceRef = `restore.rollback-unlink-retained.${site}`;
        const directorySegments = ["rollback-unlink-retained"] as const;
        const fileName = `${site}.json`;
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
        const primary = new Error(`rollback retained primary ${site}`);
        const isolationFailure = new Error(`rollback retained isolation ${site}`);
        const sourceFailure = new Error(`rollback retained source ${site}`);
        let isolatedPath = "";
        let restoredPath = "";
        let temporaryPath: string | undefined;
        let unlinkFailure: unknown;
        let sourceAttempts = 0;

        const failure = await captureError(() =>
          runWithWorkspaceRecordCompensationTestHooks(
            {
              beforeOwnedTemporaryRecordWrite: async (input) => {
                if (site !== "conditional_unlink_owned_path") return;
                temporaryPath = input.path;
                await writeFile(input.path, expectedBytes);
                throw primary;
              },
              afterOwnedPathIsolation: (input) => {
                if (input.site !== site) return;
                isolatedPath = input.isolatedPath;
                throw isolationFailure;
              },
              beforeOwnedIsolatedSourceUnlink: (input) => {
                restoredPath = input.path;
                sourceAttempts += 1;
                throw sourceFailure;
              },
              beforeExactOwnedPublicLinkUnlink: async ({ path: publicPath }) => {
                await chmod(dirname(publicPath), 0o500);
              },
              afterExactOwnedPublicLinkUnlinkFailure: async ({ path: publicPath, error }) => {
                unlinkFailure = error;
                await chmod(dirname(publicPath), 0o700);
              }
            },
            async () => {
              if (site === "conditional_delete") {
                await createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                );
                return await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                  kind: "record",
                  expected: record,
                  matches: (current, expected) => current.id === expected.id
                });
              }
              return await runWithWorkspaceRecordPublicationHooks(
                {
                  afterTemporaryFileWritten: (input) => {
                    temporaryPath = input.temporaryPath;
                    if (site === "temporary_generation_compensation") throw primary;
                  },
                  afterCanonicalLink: () => {
                    if (site === "published_rollback") throw primary;
                  },
                  beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                    if (site !== "temporary_generation_compensation") return;
                    await chmod(dirname(candidatePath), 0o500);
                    throw new Error("retain generation for rollback failure fixture");
                  },
                  beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                    if (
                      site === "temporary_generation_compensation" &&
                      inspectionSite === "unpublished_cleanup" &&
                      temporaryPath
                    ) {
                      await chmod(dirname(temporaryPath), 0o700);
                    }
                  }
                },
                () => createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
              );
            }
          )
        );

        expect(sourceAttempts).toBe(3);
        expect(unlinkFailure).toBeDefined();
        expect(errorTreeContains(failure, sourceFailure)).toBe(true);
        expect(isolatedPath).not.toBe("");
        expect(restoredPath).not.toBe("");
        expect(await readFile(restoredPath)).toEqual(expectedBytes);
        expect(await readFile(isolatedPath)).toEqual(expectedBytes);
        const [publicIdentity, isolatedIdentity] = await Promise.all([
          stat(restoredPath, { bigint: true }),
          stat(isolatedPath, { bigint: true })
        ]);
        expect(publicIdentity.dev).toBe(isolatedIdentity.dev);
        expect(publicIdentity.ino).toBe(isolatedIdentity.ino);
        expect(publicIdentity.nlink).toBe(2n);
        expect(isolatedIdentity.nlink).toBe(2n);

        await rm(restoredPath);
        await rename(isolatedPath, restoredPath);
        await rmdir(dirname(isolatedPath));
        expect(
          await conditionalDeleteJsonRecord(restoredPath, `${evidenceRef}.retry`, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        ).toEqual({ status: "deleted" });
        if (restoredPath !== path) {
          await rmdir(dirname(restoredPath));
        }
      }
    }
  );

  test("post-source observer and validation failures retain the committed public generation", async () => {
    for (const outcome of ["observer", "validation"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-post-source-${outcome.toLowerCase()}` };
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      const evidenceRef = `restore.post-source.${outcome.toLowerCase()}`;
      const directorySegments = ["restore-post-source"] as const;
      const fileName = `${outcome.toLowerCase()}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      const ownedBefore = await readFileWithIdentity(path);
      const isolationFailure = new Error(`force post-source cleanup ${outcome}`);
      const outsideAlias = join(tempRoot, `post-source-${outcome.toLowerCase()}-alias.json`);
      let isolatedPath = "";
      let sourceUnlinkCalls = 0;
      let postSourceCleanupCalls = 0;
      let finalUnlinkCalls = 0;
      const observerFailure = new Error(`post-source observer ${outcome}`);

      const failure = await captureTaskServiceError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: (input) => {
              if (input.site !== "conditional_delete") return;
              isolatedPath = input.isolatedPath;
              throw isolationFailure;
            },
            afterOwnedIsolatedSourceUnlink: async (input) => {
              sourceUnlinkCalls += 1;
              await link(input.path, outsideAlias);
              if (outcome === "observer") throw observerFailure;
            },
            beforePostSourcePublicLinkCleanup: async () => {
              postSourceCleanupCalls += 1;
            },
            beforeExactOwnedPublicLinkUnlink: async () => {
              finalUnlinkCalls += 1;
            }
          },
          () =>
            conditionalDeleteJsonRecord(path, evidenceRef, schema, {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            })
        )
      );

      expect(sourceUnlinkCalls).toBe(1);
      expect(postSourceCleanupCalls).toBe(0);
      expect(finalUnlinkCalls).toBe(0);
      expect(aggregateErrorMessages(failure)).toContain(isolationFailure.message);
      if (outcome === "observer") {
        expect(aggregateErrorMessages(failure)).toContain(observerFailure.message);
      } else {
        expect(aggregateErrorMessages(failure)).toContain(
          "Workspace record publication authority could not be verified."
        );
      }
      expect(await readFileWithIdentity(path)).toEqual(ownedBefore);
      expect(await readFileWithIdentity(outsideAlias)).toEqual(ownedBefore);
      expect(await readFile(outsideAlias)).toEqual(expectedBytes);
      expect((await stat(path, { bigint: true })).nlink).toBe(2n);
      expect((await stat(outsideAlias, { bigint: true })).nlink).toBe(2n);
      await expectPathMissing(isolatedPath);
      await rm(outsideAlias);
      expect((await stat(path, { bigint: true })).nlink).toBe(1n);
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("all restore sites retain canonical and alias links after direct post-source hardlink drift", async () => {
    for (const site of [
      "conditional_delete",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `shared-restore-${site}` };
        const evidenceRef = `restore.shared.${site}`;
        const directorySegments = ["shared-restore-sites"] as const;
        const fileName = `${site}.json`;
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const primary = new Error(`shared restore primary ${site}`);
        const isolationFailure = new Error(`shared restore isolation ${site}`);
        const sameInodeAlias = join(tempRoot, `same-inode-${site}.json`);
        let restoredPath: string | undefined;
        let isolatedPath: string | undefined;
        let temporaryPath: string | undefined;
        let ownedBeforeFinal: Awaited<ReturnType<typeof readFileWithIdentity>> | undefined;
        let postSourceHookCalls = 0;
        const restoreEvents: string[] = [];

        const failure = await captureError(() =>
          runWithWorkspaceRecordCompensationTestHooks(
            {
              beforeOwnedTemporaryRecordWrite: async (input) => {
                if (site !== "conditional_unlink_owned_path") return;
                temporaryPath = input.path;
                await writeFile(input.path, Buffer.from("partial shared restore\n"));
                throw primary;
              },
              afterOwnedPathIsolation: (input) => {
                if (input.site !== site) return;
                restoreEvents.push("isolation_failure");
                isolatedPath = input.isolatedPath;
                throw isolationFailure;
              },
              beforeOwnedIsolatedSourceUnlink: (input) => {
                restoredPath = input.path;
              },
              afterOwnedIsolatedSourceUnlink: async (input) => {
                restoreEvents.push("post_source_drift");
                postSourceHookCalls += 1;
                ownedBeforeFinal = await readFileWithIdentity(input.path);
                await link(input.path, sameInodeAlias);
              }
            },
            async () => {
              if (site === "conditional_delete") {
                expect(
                  await createJsonRecordIfAbsent(
                    workspaceRoot,
                    directorySegments,
                    fileName,
                    record,
                    evidenceRef,
                    schema
                  )
                ).toEqual({ status: "created", record });
                return await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                  kind: "record",
                  expected: record,
                  matches: (current, expected) => current.id === expected.id
                });
              }

              return await runWithWorkspaceRecordPublicationHooks(
                {
                  afterTemporaryFileWritten: async (input) => {
                    temporaryPath = input.temporaryPath;
                    if (site === "temporary_generation_compensation") throw primary;
                  },
                  afterCanonicalLink: () => {
                    if (site === "published_rollback") throw primary;
                  },
                  beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                    if (site !== "temporary_generation_compensation") return;
                    await chmod(dirname(candidatePath), 0o500);
                    throw new Error("hold exact temporary generation for compensation");
                  },
                  beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                    if (
                      site === "temporary_generation_compensation" &&
                      inspectionSite === "unpublished_cleanup" &&
                      temporaryPath
                    ) {
                      await chmod(dirname(temporaryPath), 0o700);
                    }
                  }
                },
                () => createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
              );
            }
          )
        );

        const messages = aggregateErrorMessages(failure);
        expect(messages).toContain(isolationFailure.message);
        expect(messages).toContain(
          "Workspace record publication authority could not be verified."
        );
        const causalPrimary = site === "conditional_delete" ? isolationFailure : primary;
        expect(errorTreeContains(failure, causalPrimary)).toBe(true);
        expect(restoreEvents).toEqual(["isolation_failure", "post_source_drift"]);
        const restoreFailure = findErrorNode(
          failure,
          (error) =>
            error instanceof TaskServiceError &&
            error.message ===
              "Workspace record generation could not be restored after a failed mutation."
        );
        expect(restoreFailure).toBeDefined();
        expect(semanticPrimaryError(restoreFailure!.cause)).toMatchObject({
          message: "Workspace record publication authority could not be verified."
        });
        expect(postSourceHookCalls).toBe(1);
        expect(restoredPath).toBeDefined();
        expect(ownedBeforeFinal).toBeDefined();
        expect(await readFileWithIdentity(restoredPath!)).toEqual(ownedBeforeFinal!);
        expect(await readFileWithIdentity(sameInodeAlias)).toEqual(ownedBeforeFinal!);
        expect((await stat(restoredPath!, { bigint: true })).nlink).toBe(2n);
        expect((await stat(sameInodeAlias, { bigint: true })).nlink).toBe(2n);
        await expectPathMissing(isolatedPath!);
        await rm(sameInodeAlias);
        expect((await stat(restoredPath!, { bigint: true })).nlink).toBe(1n);
        await rm(restoredPath!);
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
        ).toEqual({ status: "created", record });
        if (temporaryPath) await chmod(dirname(temporaryPath), 0o700).catch(() => undefined);
    }
  });

  test("beforeOwnedPathIsolation revalidates direct parent and namespace rebinds at every shared site", async () => {
    for (const site of [
      "conditional_delete",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      for (const rebind of ["parent", "namespace"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `before-isolation-${site}-${rebind}` };
        const evidenceRef = `before-isolation.${site}.${rebind}`;
        const directorySegments = ["before-isolation-sites"] as const;
        const fileName = `${site}-${rebind}.json`;
        const canonicalPath = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const primary = new Error(`before-isolation primary ${site} ${rebind}`);
        let temporaryPath: string | undefined;
        let ownedPath = "";
        let ownedBefore: Awaited<ReturnType<typeof readOwnedFileState>> | undefined;
        let namespaceBefore: Awaited<ReturnType<typeof readPathState>> | undefined;
        let isolatedPath = "";
        let namespacePath = "";
        let reboundPath = "";
        let displacedPath = "";
        let replacementSentinel = "";
        let hookCalls = 0;

        const failure = await captureError(() =>
          runWithWorkspaceRecordCompensationTestHooks(
            {
              beforeOwnedTemporaryRecordWrite: async (input) => {
                if (site !== "conditional_unlink_owned_path") return;
                temporaryPath = input.path;
                await writeFile(input.path, Buffer.from(`partial ${site} ${rebind}\n`));
                throw primary;
              },
              beforeOwnedPathIsolation: async (input) => {
                if (input.site !== site) return;
                hookCalls += 1;
                ownedPath = input.path;
                isolatedPath = input.isolatedPath;
                ownedBefore = await readOwnedFileState(input.path);
                namespacePath = dirname(input.isolatedPath);
                namespaceBefore = await readPathState(namespacePath);
                reboundPath = rebind === "parent" ? dirname(namespacePath) : namespacePath;
                displacedPath = join(tempRoot, `displaced-${site}-${rebind}`);
                await rename(reboundPath, displacedPath);
                await mkdir(reboundPath, { mode: 0o700 });
                if (rebind === "parent") {
                  await rename(join(displacedPath, basename(namespacePath)), namespacePath);
                  await rename(join(displacedPath, basename(ownedPath)), ownedPath);
                }
                replacementSentinel = join(reboundPath, "replacement-sentinel");
                await writeFile(replacementSentinel, `replacement ${site} ${rebind}`);
              }
            },
            async () => {
              if (site === "conditional_delete") {
                expect(
                  await createJsonRecordIfAbsent(
                    workspaceRoot,
                    directorySegments,
                    fileName,
                    record,
                    evidenceRef,
                    schema
                  )
                ).toEqual({ status: "created", record });
                return await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
                  kind: "record",
                  expected: record,
                  matches: (current, expected) => current.id === expected.id
                });
              }
              return await runWithWorkspaceRecordPublicationHooks(
                {
                  afterTemporaryFileWritten: (input) => {
                    temporaryPath = input.temporaryPath;
                    if (site === "temporary_generation_compensation") throw primary;
                  },
                  afterCanonicalLink: () => {
                    if (site === "published_rollback") throw primary;
                  },
                  beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                    if (site !== "temporary_generation_compensation") return;
                    await chmod(dirname(candidatePath), 0o500);
                    throw new Error("retain generation until shared compensation isolation");
                  },
                  beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                    if (
                      site === "temporary_generation_compensation" &&
                      inspectionSite === "unpublished_cleanup" &&
                      temporaryPath
                    ) {
                      await chmod(dirname(temporaryPath), 0o700);
                    }
                  }
                },
                () =>
                  createJsonRecordIfAbsent(
                    workspaceRoot,
                    directorySegments,
                    fileName,
                    record,
                    evidenceRef,
                    schema
                  )
              );
            }
          )
        );

        expect(hookCalls).toBe(1);
        expect(aggregateErrorMessages(failure)).toContain(
          "Workspace record publication authority could not be verified."
        );
        expect(await readFile(replacementSentinel, "utf8")).toBe(
          `replacement ${site} ${rebind}`
        );
        expect(await readOwnedFileState(ownedPath)).toEqual(ownedBefore!);
        if (rebind === "parent") {
          expect(await readPathState(namespacePath)).toEqual(namespaceBefore!);
          await expectPathMissing(join(displacedPath, basename(ownedPath)));
          await expectPathMissing(join(displacedPath, basename(namespacePath)));
        }
        await expectPathMissing(isolatedPath);
        if (rebind === "parent") {
          expect((await readdir(reboundPath)).filter(isOwnedRecordPath).sort()).toEqual(
            [basename(namespacePath)]
          );
        } else {
          expect((await readdir(reboundPath)).filter(isOwnedRecordPath)).toHaveLength(0);
        }

        if (rebind === "parent") {
          await rm(replacementSentinel);
          await rename(ownedPath, join(displacedPath, basename(ownedPath)));
          await rename(namespacePath, join(displacedPath, basename(namespacePath)));
          await rmdir(reboundPath);
        } else {
          await rm(reboundPath, { recursive: true });
        }
        await rename(displacedPath, reboundPath);
        const recordDirectory = dirname(canonicalPath);
        for (const name of await readdir(recordDirectory)) {
          if (isOwnedRecordPath(name)) {
            await rm(join(recordDirectory, name), { recursive: true, force: true });
          }
        }
        const terminalRecord = await readJsonRecord(canonicalPath, evidenceRef, schema);
        if (terminalRecord) {
          expect(terminalRecord).toEqual(record);
          expect(
            await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            })
          ).toEqual({ status: "deleted" });
        }
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
        ).toEqual({ status: "created", record });
      }
    }
  });

  test("all post-isolation sites and restore source unlink reject namespace symlink rebound", async () => {
    for (const site of [
      "conditional_delete",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `namespace-rebound-${site}` };
      const evidenceRef = `namespace.rebound.${site}`;
      const directorySegments = ["namespace-rebound-sites"] as const;
      const fileName = `${site}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const primary = new Error(`namespace rebound primary ${site}`);
      const replacementBytes = Buffer.from(`foreign namespace replacement ${site}\n`);
      let temporaryPath: string | undefined;
      let displacedNamespace: string | undefined;
      let foreignNamespace: string | undefined;
      let ownedBytes: Buffer | undefined;

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              if (site !== "conditional_unlink_owned_path") return;
              temporaryPath = input.path;
              await writeFile(input.path, Buffer.from(`partial ${site}\n`));
              throw primary;
            },
            afterOwnedPathIsolation: async (input) => {
              if (input.site !== site) return;
              const namespacePath = dirname(input.isolatedPath);
              displacedNamespace = join(tempRoot, `${site}-owned-namespace`);
              foreignNamespace = join(tempRoot, `${site}-foreign-namespace`);
              ownedBytes = await readFile(input.isolatedPath);
              await rename(namespacePath, displacedNamespace);
              await mkdir(foreignNamespace, { mode: 0o700 });
              await writeFile(join(foreignNamespace, "generation"), replacementBytes, {
                flag: "wx",
                mode: 0o600
              });
              await symlink(foreignNamespace, namespacePath);
            }
          },
          async () => {
            if (site === "conditional_delete") {
              expect(
                await createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
              ).toEqual({ status: "created", record });
              return await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
                kind: "record",
                expected: record,
                matches: (current, expected) => current.id === expected.id
              });
            }
            return await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: (input) => {
                  temporaryPath = input.temporaryPath;
                  if (site === "temporary_generation_compensation") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "published_rollback") throw primary;
                },
                beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                  if (site !== "temporary_generation_compensation") return;
                  await chmod(dirname(candidatePath), 0o500);
                  throw new Error("retain temporary generation for rebound compensation");
                },
                beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                  if (
                    site === "temporary_generation_compensation" &&
                    inspectionSite === "unpublished_cleanup" &&
                    temporaryPath
                  ) {
                    await chmod(dirname(temporaryPath), 0o700);
                  }
                }
              },
              () =>
                createJsonRecordIfAbsent(
                  workspaceRoot,
                  directorySegments,
                  fileName,
                  record,
                  evidenceRef,
                  schema
                )
            );
          }
        )
      );

      expect(aggregateErrorMessages(failure)).toContain(
        "Workspace record publication authority could not be verified."
      );
      expect(displacedNamespace).toBeDefined();
      expect(foreignNamespace).toBeDefined();
      expect(await readFile(join(displacedNamespace!, "generation"))).toEqual(ownedBytes!);
      expect(await readFile(join(foreignNamespace!, "generation"))).toEqual(replacementBytes);
      if (temporaryPath) await chmod(dirname(temporaryPath), 0o700).catch(() => undefined);
    }

    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "restore-source-unlink-namespace-rebound" };
    const evidenceRef = "restore.source-unlink.namespace-rebound";
    const directorySegments = ["restore-source-unlink-rebound"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
    const replacementBytes = Buffer.from("foreign restore source namespace\n");
    const sourceUnlinkFailure = new Error("restore source unlink namespace rebound trigger");
    let displacedNamespace: string | undefined;
    let foreignNamespace: string | undefined;
    let displacedIdentity: { dev: number; ino: number } | undefined;

    const failure = await captureError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: ({ site }) => {
            if (site === "conditional_delete") throw new Error("force restore");
          },
          beforeOwnedIsolatedSourceUnlink: async (input) => {
            const namespacePath = dirname(input.isolatedPath);
            displacedNamespace = join(tempRoot, "restore-owned-namespace");
            foreignNamespace = join(tempRoot, "restore-foreign-namespace");
            const owned = await stat(input.isolatedPath);
            displacedIdentity = { dev: owned.dev, ino: owned.ino };
            await rename(namespacePath, displacedNamespace);
            await mkdir(foreignNamespace, { mode: 0o700 });
            await writeFile(join(foreignNamespace, "generation"), replacementBytes, {
              flag: "wx",
              mode: 0o600
            });
            await symlink(foreignNamespace, namespacePath);
            throw sourceUnlinkFailure;
          }
        },
        () =>
          conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
      )
    );

    expect(aggregateErrorMessages(failure)).toContain(
      "Workspace record publication authority could not be verified."
    );
    const restoreFailure = findErrorNode(
      failure,
      (error) =>
        error instanceof TaskServiceError &&
        error.message === "Workspace record generation could not be restored after a failed mutation."
    );
    expect(restoreFailure).toBeDefined();
    const restoreEnvelope = restoreFailure!.cause as PreservedErrorCompensationEnvelope;
    expect(restoreEnvelope).toBeInstanceOf(PreservedErrorCompensationEnvelope);
    expect(semanticPrimaryError(restoreEnvelope)).toBe(sourceUnlinkFailure);
    const retryThenRollbackFailures = (restoreEnvelope.cause as AggregateError).errors;
    expect(retryThenRollbackFailures).toHaveLength(2);
    for (const retainedFailure of retryThenRollbackFailures) {
      expect(retainedFailure).toMatchObject({
        code: "workspace_path_not_safe",
        message: "Workspace record publication authority could not be verified."
      });
      expect(
        retryThenRollbackFailures.filter((candidate) => candidate === retainedFailure)
      ).toHaveLength(1);
    }
    expect(countErrorNodes(restoreFailure, (error) => error instanceof AggregateError)).toBe(1);
    expect(await stat(join(displacedNamespace!, "generation"))).toMatchObject(
      displacedIdentity!
    );
    expect(await stat(path)).toMatchObject(displacedIdentity!);
    expect(await readFile(join(foreignNamespace!, "generation"))).toEqual(replacementBytes);
  });

  test("all restore sites reject nonthrowing shared-inode mutation and preserve public replacements", async () => {
    for (const fixture of [
      "conditional_delete",
      "conditional_delete_cleanup_permit",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      const site = fixture === "conditional_delete_cleanup_permit"
        ? "conditional_delete"
        : fixture;
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-mutation-${fixture}` };
      const replacement = { id: `restore-replacement-${fixture}` };
      const evidenceRef = `restore.mutation.${fixture}`;
      const directorySegments = ["restore-mutation-sites"] as const;
      const fileName = `${fixture}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
      const mutatedBytes = Buffer.from(`mutated restore generation ${fixture}\n`);
      const primary = new Error(`restore mutation primary ${fixture}`);
      const isolationFailure = new Error(`restore mutation isolation ${fixture}`);
      let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
      let temporaryPath: string | undefined;
      let isolatedPath: string | undefined;
      let restoredPublicPath: string | undefined;
      let hookCount = 0;

      if (site === "conditional_delete") {
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (created.status !== "created") throw new Error("Expected mutation fixture.");
        cleanupPermit = created.cleanupPermit;
      }

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              if (site !== "conditional_unlink_owned_path") return;
              temporaryPath = input.path;
              await writeFile(input.path, expectedBytes);
              throw primary;
            },
            afterOwnedPathIsolation: (input) => {
              if (input.site !== site) return;
              isolatedPath = input.isolatedPath;
              throw isolationFailure;
            },
            beforeOwnedIsolatedSourceUnlink: async (input) => {
              if (input.site !== site) return;
              hookCount += 1;
              restoredPublicPath = input.path;
              await writeFile(input.isolatedPath, mutatedBytes);
              await rm(input.path);
              await writeFile(input.path, replacementBytes, { flag: "wx" });
            }
          },
          async () => {
            if (site === "conditional_delete") {
              const condition = {
                kind: "record" as const,
                expected: record,
                matches: (current: { id: string }, expected: { id: string }) =>
                  current.id === expected.id
              };
              return fixture === "conditional_delete_cleanup_permit"
                ? await conditionalDeleteJsonRecordWithCleanupPermit(
                    cleanupPermit!, path, evidenceRef, schema, condition
                  )
                : await conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);
            }
            return await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: (input) => {
                  temporaryPath = input.temporaryPath;
                  if (site === "temporary_generation_compensation") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "published_rollback") throw primary;
                },
                beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                  if (site !== "temporary_generation_compensation") return;
                  await chmod(dirname(candidatePath), 0o500);
                  throw new Error("retain temporary generation for mutation compensation");
                },
                beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                  if (
                    site === "temporary_generation_compensation" &&
                    inspectionSite === "unpublished_cleanup" &&
                    temporaryPath
                  ) {
                    await chmod(dirname(temporaryPath), 0o700);
                  }
                }
              },
              () => createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
            );
          }
        )
      );

      expect(aggregateErrorMessages(failure)).toContain(isolationFailure.message);
      expect(aggregateErrorMessages(failure)).toContain(
        "Workspace record publication authority could not be verified."
      );
      expect(hookCount).toBe(1);
      expect(restoredPublicPath).toBeDefined();
      expect(await readFile(restoredPublicPath!)).toEqual(replacementBytes);
      expect((await stat(restoredPublicPath!, { bigint: true })).nlink).toBe(1n);
      expect(isolatedPath).toBeDefined();
      expect(await readFile(isolatedPath!)).toEqual(mutatedBytes);
      expect((await stat(isolatedPath!, { bigint: true })).nlink).toBe(1n);

      await rm(restoredPublicPath!);
      const retried = await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      expect(retried).toEqual({ status: "created", record });
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
      if (temporaryPath) await chmod(dirname(temporaryPath), 0o700).catch(() => undefined);
    }
  });

  test("restore source cleanup preserves generations with mode or hardlink drift", async () => {
    for (const drift of ["mode", "hardlink"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-source-${drift}-drift` };
      const evidenceRef = `restore.source.${drift}.drift`;
      const directorySegments = ["restore-source-drift"] as const;
      const fileName = `${drift}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        )
      ).toEqual({ status: "created", record });
      const externalAlias = join(tempRoot, `${drift}-external-alias.json`);
      let isolatedPath: string | undefined;

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: (input) => {
              if (input.site !== "conditional_delete") return;
              isolatedPath = input.isolatedPath;
              throw new Error(`force ${drift} restore`);
            },
            beforeOwnedIsolatedSourceUnlink: async (input) => {
              if (drift === "mode") await chmod(input.isolatedPath, 0o400);
              else await link(input.isolatedPath, externalAlias);
            }
          },
          () =>
            conditionalDeleteJsonRecord(path, evidenceRef, schema, {
              kind: "record",
              expected: record,
              matches: (current, expected) => current.id === expected.id
            })
        )
      );

      expect(aggregateErrorMessages(failure)).toContain(
        "Workspace record publication authority could not be verified."
      );
      expect(isolatedPath).toBeDefined();
      if (drift === "mode") {
        expect(await readFile(isolatedPath!)).toEqual(
          Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
        );
        expect((await stat(isolatedPath!)).mode & 0o777).toBe(0o400);
      } else {
        await expectPathMissing(isolatedPath!);
        expect(await readFile(externalAlias)).toEqual(
          Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
        );
        expect((await stat(externalAlias)).nlink).toBe(1);
      }
    }
  });

  test("pre-isolation external hardlinks fail closed across every cleanup site without owned residue", async () => {
    for (const fixture of [
      "conditional_delete",
      "conditional_delete_cleanup_permit",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      const site = fixture === "conditional_delete_cleanup_permit"
        ? "conditional_delete"
        : fixture;
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `pre-isolation-external-link-${fixture}` };
      const evidenceRef = `pre-isolation.external-link.${fixture}`;
      const directorySegments = ["pre-isolation-external-link-sites"] as const;
      const fileName = `${fixture}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      const externalAlias = join(tempRoot, `pre-isolation-${fixture}.json`);
      const primary = new Error(`pre-isolation primary ${fixture}`);
      let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
      let temporaryPath: string | undefined;
      let hookCalls = 0;

      if (site === "conditional_delete") {
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (created.status !== "created") throw new Error("Expected pre-isolation fixture.");
        cleanupPermit = created.cleanupPermit;
      }

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              if (site !== "conditional_unlink_owned_path") return;
              temporaryPath = input.path;
              await writeFile(input.path, expectedBytes);
              throw primary;
            },
            beforeOwnedPathIsolation: async (input) => {
              if (input.site !== site) return;
              hookCalls += 1;
              await link(input.path, externalAlias);
            }
          },
          async () => {
            if (site === "conditional_delete") {
              const condition = {
                kind: "record" as const,
                expected: record,
                matches: (current: { id: string }, expected: { id: string }) =>
                  current.id === expected.id
              };
              return fixture === "conditional_delete_cleanup_permit"
                ? await conditionalDeleteJsonRecordWithCleanupPermit(
                    cleanupPermit!, path, evidenceRef, schema, condition
                  )
                : await conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);
            }
            return await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: (input) => {
                  temporaryPath = input.temporaryPath;
                  if (site === "temporary_generation_compensation") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "published_rollback") throw primary;
                },
                beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                  if (site !== "temporary_generation_compensation") return;
                  await chmod(dirname(candidatePath), 0o500);
                  throw new Error("retain pre-isolation generation for compensation");
                },
                beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                  if (
                    site === "temporary_generation_compensation" &&
                    inspectionSite === "unpublished_cleanup" &&
                    temporaryPath
                  ) {
                    await chmod(dirname(temporaryPath), 0o700);
                  }
                }
              },
              () => createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
            );
          }
        )
      );

      expect(hookCalls).toBe(1);
      expect(
        findErrorNode(failure, (error) => error instanceof TaskServiceError)
      ).toBeInstanceOf(TaskServiceError);
      expect(await readFile(externalAlias)).toEqual(expectedBytes);
      const ownedResidue = (await readdir(dirname(path))).filter(isOwnedRecordPath);
      expect(ownedResidue).toEqual([]);
      if (temporaryPath) await expectPathMissing(temporaryPath);

      await rm(externalAlias);
      const current = await readJsonRecord(path, `${evidenceRef}.repair-read`, schema);
      if (current) {
        expect(
          await conditionalDeleteJsonRecord(path, `${evidenceRef}.repair-delete`, schema, {
            kind: "record",
            expected: record,
            matches: (observed, expected) => observed.id === expected.id
          })
        ).toEqual({ status: "deleted" });
      }
      expect(
        await createJsonRecordIfAbsent(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          `${evidenceRef}.retry`,
          schema
        )
      ).toEqual({ status: "created", record });
      expect(
        await conditionalDeleteJsonRecord(path, `${evidenceRef}.cleanup`, schema, {
          kind: "record",
          expected: record,
          matches: (observed, expected) => observed.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("all restore sites remove residual private sources when an external hardlink appears after isolation", async () => {
    for (const fixture of [
      "conditional_delete",
      "conditional_delete_cleanup_permit",
      "conditional_unlink_owned_path",
      "published_rollback",
      "temporary_generation_compensation"
    ] as const) {
      const site = fixture === "conditional_delete_cleanup_permit"
        ? "conditional_delete"
        : fixture;
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const schema = z.object({ id: z.string() });
      const record = { id: `restore-external-link-${fixture}` };
      const evidenceRef = `restore.external-link.${fixture}`;
      const directorySegments = ["restore-external-link-sites"] as const;
      const fileName = `${fixture}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      const externalAlias = join(tempRoot, `external-${fixture}.json`);
      const primary = new Error(`restore external-link primary ${fixture}`);
      const isolationFailure = new Error(`restore external-link isolation ${fixture}`);
      let cleanupPermit: WorkspaceRecordCleanupPermit | undefined;
      let temporaryPath: string | undefined;
      let isolatedPath: string | undefined;

      if (site === "conditional_delete") {
        const created = await createJsonRecordIfAbsentWithCleanupPermit(
          workspaceRoot,
          directorySegments,
          fileName,
          record,
          evidenceRef,
          schema
        );
        if (created.status !== "created") throw new Error("Expected hardlink fixture.");
        cleanupPermit = created.cleanupPermit;
      }

      const failure = await captureError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            beforeOwnedTemporaryRecordWrite: async (input) => {
              if (site !== "conditional_unlink_owned_path") return;
              temporaryPath = input.path;
              await writeFile(input.path, expectedBytes);
              throw primary;
            },
            afterOwnedPathIsolation: async (input) => {
              if (input.site !== site) return;
              isolatedPath = input.isolatedPath;
              await link(input.isolatedPath, externalAlias);
              throw isolationFailure;
            }
          },
          async () => {
            if (site === "conditional_delete") {
              const condition = {
                kind: "record" as const,
                expected: record,
                matches: (current: { id: string }, expected: { id: string }) =>
                  current.id === expected.id
              };
              return fixture === "conditional_delete_cleanup_permit"
                ? await conditionalDeleteJsonRecordWithCleanupPermit(
                    cleanupPermit!, path, evidenceRef, schema, condition
                  )
                : await conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);
            }
            return await runWithWorkspaceRecordPublicationHooks(
              {
                afterTemporaryFileWritten: (input) => {
                  temporaryPath = input.temporaryPath;
                  if (site === "temporary_generation_compensation") throw primary;
                },
                afterCanonicalLink: () => {
                  if (site === "published_rollback") throw primary;
                },
                beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                  if (site !== "temporary_generation_compensation") return;
                  await chmod(dirname(candidatePath), 0o500);
                  throw new Error("retain temporary generation for hardlink compensation");
                },
                beforePublicationCompensationStateInspection: async ({ site: inspectionSite }) => {
                  if (
                    site === "temporary_generation_compensation" &&
                    inspectionSite === "unpublished_cleanup" &&
                    temporaryPath
                  ) {
                    await chmod(dirname(temporaryPath), 0o700);
                  }
                }
              },
              () => createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
            );
          }
        )
      );

      expect(aggregateErrorMessages(failure)).toContain(isolationFailure.message);
      await expectPathMissing(path);
      expect(await readFile(externalAlias)).toEqual(expectedBytes);
      expect((await stat(externalAlias, { bigint: true })).nlink).toBe(1n);
      if (isolatedPath) await expectPathMissing(isolatedPath);

      const retried = await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      expect(retried).toEqual({ status: "created", record });
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
      if (temporaryPath) await chmod(dirname(temporaryPath), 0o700).catch(() => undefined);
    }
  });

  test("published rollback restores only its exact isolated generation after inspection failure", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "published-rollback-post-isolation" };
    const evidenceRef = "published.rollback.post-isolation";
    const directorySegments = ["published-rollback-post-isolation"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const operationError = new Error("published operation primary");
    const rollbackError = new Error("published rollback post-isolation primary");
    const inspectionError = Object.assign(new Error("published rollback inspection"), {
      code: "EIO"
    });

    const failure = await captureTaskServiceError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: ({ site }) => {
            if (site === "published_rollback") throw rollbackError;
          },
          beforeOwnedPathCompensationStateInspection: ({ site }) => {
            if (site === "published_rollback") throw inspectionError;
          }
        },
        () =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterCanonicalLink: () => {
                throw operationError;
              }
            },
            () =>
              createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
          )
      )
    );

    expect(failure.code).toBe("workspace_path_not_safe");
    expect(failure.message).toBe("Failed to publish workspace record claim.");
    expect(errorTreeContains(failure, operationError)).toBe(true);
    expect(aggregateErrorMessages(failure)).toContain(rollbackError.message);
    expect(errorTreeContains(failure, inspectionError)).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
    expect((await readdir(join(path, ".."))).some(isOwnedRecordPath)).toBe(false);
    expect(
      await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
  });

  test("temporary-generation compensation fails closed on an unproven isolated generation", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "temporary-compensation-post-isolation" };
    const evidenceRef = "temporary.compensation.post-isolation";
    const directorySegments = ["temporary-compensation-post-isolation"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const operationError = new Error("temporary operation primary");
    const removalError = new Error("temporary removal post-isolation primary");
    const inspectionError = Object.assign(new Error("temporary removal inspection"), {
      code: "EIO"
    });
    const mutatedBytes = Buffer.from("mutated-unproven-generation\n");
    let temporaryPath: string | undefined;
    let mutationApplied = false;

    const failure = await captureError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: async ({ isolatedPath, site }) => {
            if (site !== "temporary_generation_compensation") return;
            await writeFile(isolatedPath, mutatedBytes);
            throw removalError;
          },
          beforeOwnedPathCompensationStateInspection: ({ site }) => {
            if (site === "temporary_generation_compensation") throw inspectionError;
          }
        },
        () =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterTemporaryFileWritten: (input) => {
                temporaryPath = input.temporaryPath;
                throw operationError;
              },
              beforeTemporaryUnlink: async ({ temporaryPath: candidatePath }) => {
                if (!mutationApplied) {
                  mutationApplied = true;
                }
                await chmod(dirname(candidatePath), 0o500);
                throw new Error("keep mutated temporary generation for compensation");
              },
              beforePublicationCompensationStateInspection: async ({ site }) => {
                if (site === "unpublished_cleanup" && temporaryPath) {
                  await chmod(dirname(temporaryPath), 0o700);
                }
              }
            },
            () =>
              createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
          )
      )
    );

    expect(semanticPrimaryError(failure)).toBe(operationError);
    expect(semanticPrimaryError(failure)?.message).toBe(operationError.message);
    expect(aggregateErrorMessages(failure)).toContain(removalError.message);
    expect(errorTreeContains(failure, inspectionError)).toBe(true);
    await expectPathMissing(path);
    expect(temporaryPath).toBeDefined();
    await expectPathMissing(temporaryPath!);
    const producerNamespacePath = dirname(temporaryPath!);
    const namespacePath = await findOnlyAuthorityNamespace(producerNamespacePath);
    expect(await readFile(join(namespacePath, "generation"))).toEqual(mutatedBytes);
    await rm(producerNamespacePath, { recursive: true });
  });

  test("repeated post-isolation delete failures release path and global admission capacity", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const directorySegments = ["post-isolation-capacity"] as const;

    for (let index = 0; index < 70; index += 1) {
      const record = { id: `same-path-${index}` };
      const evidenceRef = `post-isolation.capacity.same.${index}`;
      const fileName = "same-path.json";
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected repeated permit fixture.");
      await captureConditionalDeleteError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: () => {
              throw new Error(`same-path primary ${index}`);
            },
            beforeOwnedPathCompensationStateInspection: () => {
              throw Object.assign(new Error(`same-path inspection ${index}`), { code: "EIO" });
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
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }

    for (let index = 0; index < 8; index += 1) {
      const record = { id: `distinct-path-${index}` };
      const evidenceRef = `post-isolation.capacity.distinct.${index}`;
      const fileName = `distinct-${index}.json`;
      const path = workspaceRecordPath(
        workspaceRoot,
        [...directorySegments, fileName],
        evidenceRef
      );
      const created = await createJsonRecordIfAbsentWithCleanupPermit(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      );
      if (created.status !== "created") throw new Error("Expected distinct permit fixture.");
      await captureConditionalDeleteError(() =>
        runWithWorkspaceRecordCompensationTestHooks(
          {
            afterOwnedPathIsolation: () => {
              throw new Error(`distinct primary ${index}`);
            },
            beforeOwnedPathCompensationStateInspection: () => {
              throw Object.assign(new Error(`distinct inspection ${index}`), { code: "EIO" });
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
      expect(
        await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
          kind: "record",
          expected: record,
          matches: (current, expected) => current.id === expected.id
        })
      ).toEqual({ status: "deleted" });
    }
  });

  test("hardlink hook checkpoints reject parent and namespace rebound before publication", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "hardlink-pre-link-parent-rebound" };
    const evidenceRef = "hardlink.pre-link.parent-rebound";
    const directorySegments = ["hardlink-pre-link-parent-rebound"] as const;
    const fileName = "record.json";
    const canonicalPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const parentPath = dirname(canonicalPath);
    const displacedParentPath = join(tempRoot, "hardlink-pre-link-displaced-parent");
    let temporaryPath: string | undefined;
    let replacementNamespacePath: string | undefined;

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterTemporaryFileWritten: async (input) => {
            temporaryPath = input.temporaryPath;
            const producerNamespaceName = basename(dirname(input.temporaryPath));
            await rename(parentPath, displacedParentPath);
            await mkdir(parentPath);
            replacementNamespacePath = join(parentPath, producerNamespaceName);
            await symlink(
              join(displacedParentPath, producerNamespaceName),
              replacementNamespacePath
            );
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(temporaryPath).toBeDefined();
    await expectPathMissing(canonicalPath);
    await expectPathMissing(join(displacedParentPath, fileName));
    expect((await lstat(replacementNamespacePath!)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(displacedParentPath, basename(dirname(temporaryPath!)), "generation")))
      .toEqual(Buffer.from(`${JSON.stringify(record, null, 2)}\n`));

    await rm(parentPath, { recursive: true });
    await rm(join(displacedParentPath, basename(dirname(temporaryPath!))), { recursive: true });
    await rename(displacedParentPath, parentPath);
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
  });

  test("after-link parent and canonical rebound preserves replacement trees under forced rollback failure", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "hardlink-after-link-parent-rebound" };
    const evidenceRef = "hardlink.after-link.parent-rebound";
    const directorySegments = ["hardlink-after-link-parent-rebound"] as const;
    const fileName = "record.json";
    const canonicalPath = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );
    const parentPath = dirname(canonicalPath);
    const displacedParentPath = join(tempRoot, "hardlink-after-link-displaced-parent");
    const replacementBytes = Buffer.from("replacement canonical\n");
    const rollbackFailure = new Error("forced published rollback compensation failure");
    let temporaryPath: string | undefined;
    let ownedCanonicalIdentity: bigint | undefined;
    let replacementCanonicalIdentity: bigint | undefined;

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: async (input) => {
            temporaryPath = input.temporaryPath;
            ownedCanonicalIdentity = (await lstat(input.canonicalPath, { bigint: true })).ino;
            await rename(parentPath, displacedParentPath);
            await mkdir(parentPath);
            await writeFile(input.canonicalPath, replacementBytes, { flag: "wx" });
            replacementCanonicalIdentity = (
              await lstat(input.canonicalPath, { bigint: true })
            ).ino;
          },
          beforePublicationCompensationStateInspection: ({ site }) => {
            if (site === "published_rollback") throw rollbackFailure;
          }
        },
        () =>
          createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect(errorTreeContains(error, rollbackFailure)).toBe(true);
    expect(replacementCanonicalIdentity).not.toBe(ownedCanonicalIdentity);
    expect(await readFile(canonicalPath)).toEqual(replacementBytes);
    expect((await lstat(canonicalPath, { bigint: true })).ino).toBe(
      replacementCanonicalIdentity
    );
    expect((await lstat(join(displacedParentPath, fileName), { bigint: true })).ino).toBe(
      ownedCanonicalIdentity
    );
    expect(temporaryPath).toBeDefined();
    expect((await lstat(join(displacedParentPath, basename(dirname(temporaryPath!))))).isDirectory())
      .toBe(true);

    await rm(parentPath, { recursive: true });
    await rm(join(displacedParentPath, fileName));
    await rm(join(displacedParentPath, basename(dirname(temporaryPath!))), { recursive: true });
    await rename(displacedParentPath, parentPath);
    expect(
      await createJsonRecordIfAbsent(
        workspaceRoot,
        directorySegments,
        fileName,
        record,
        evidenceRef,
        schema
      )
    ).toEqual({ status: "created", record });
  });

  test("hardlink final acceptance retains the original generation mode checkpoint", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "hardlink-final-mode-checkpoint" };
    const evidenceRef = "hardlink.final.mode-checkpoint";
    const directorySegments = ["hardlink-final-mode-checkpoint"] as const;
    const fileName = "record.json";
    const path = workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, fileName],
      evidenceRef
    );

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          beforePublishedRecordFinalValidation: async ({ path: observedPath }) => {
            await chmod(observedPath, 0o640);
          }
        },
        () =>
          createJsonRecordIfAbsentWithCleanupPermit(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
      )
    );

    expect(error.code).toBe("workspace_path_not_safe");
    expect((await lstat(path, { bigint: true })).mode & 0o777n).toBe(0o640n);
    expect(await readFile(path)).toEqual(Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
    expect((await readdir(dirname(path))).some(isOwnedRecordPath)).toBe(false);
    await expect(
      conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).rejects.toBeInstanceOf(TaskServiceError);
    expect((await lstat(path, { bigint: true })).mode & 0o777n).toBe(0o640n);
    await chmod(path, 0o600);
    expect(
      await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
        kind: "record",
        expected: record,
        matches: (current, expected) => current.id === expected.id
      })
    ).toEqual({ status: "deleted" });
  });

  test("hardlink, shared cleanup, and conditional delete reject all generation special bits", async () => {
    for (const surface of ["hardlink", "shared_cleanup", "conditional_delete"] as const) {
      for (const specialBit of [0o4000, 0o2000, 0o1000] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `${surface}-${specialBit.toString(8)}` };
        const evidenceRef = `special-generation.${surface}.${specialBit.toString(8)}`;
        const directorySegments = [`special-generation-${surface}`] as const;
        const fileName = `${specialBit.toString(8)}.json`;
        const canonicalPath = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
        const externalSentinel = join(tempRoot, "external-sentinel");
        await writeFile(externalSentinel, `external ${surface}`);
        let temporaryPath = "";
        let mutated = false;

        if (surface === "conditional_delete") {
          expect(
            await createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
          ).toEqual({ status: "created", record });
        }

        const error = await captureTaskServiceError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              afterCanonicalLink: async (input) => {
                temporaryPath = input.temporaryPath;
                if (surface !== "hardlink") return;
                mutated = true;
                await chmodIncludingSpecialBits(input.canonicalPath, specialBit | 0o600);
              },
              beforeAuthorityOwnedUnlink: async ({ path, operation }) => {
                if (
                  surface !== "shared_cleanup" ||
                  operation !== "hardlink_temp_cleanup" ||
                  mutated
                ) {
                  return;
                }
                mutated = true;
                await chmodIncludingSpecialBits(path, specialBit | 0o600);
              },
              beforeGenerationIsolation: async ({ path, operation }) => {
                if (
                  surface !== "conditional_delete" ||
                  operation !== "conditional_delete" ||
                  mutated
                ) {
                  return;
                }
                mutated = true;
                await chmodIncludingSpecialBits(path, specialBit | 0o600);
              }
            },
            () =>
              surface === "conditional_delete"
                ? conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
                    kind: "record",
                    expected: record,
                    matches: (current, expected) => current.id === expected.id
                  })
                : createJsonRecordIfAbsent(
                    workspaceRoot,
                    directorySegments,
                    fileName,
                    record,
                    evidenceRef,
                    schema
                  )
          )
        );

        expect(mutated).toBe(true);
        expect(error.code).toBe(
          surface === "conditional_delete" ? "record_malformed" : "workspace_path_not_safe"
        );
        expect(aggregateErrorMessages(error)).toContain(
          surface === "conditional_delete"
            ? "Workspace record changed before conditional removal."
            : "Workspace record publication authority could not be verified."
        );
        expect(await readFile(canonicalPath)).toEqual(expectedBytes);
        expect((await stat(canonicalPath)).mode & 0o7777).toBe(specialBit | 0o600);
        expect(await readFile(externalSentinel, "utf8")).toBe(`external ${surface}`);

        await chmod(canonicalPath, 0o600);
        if (temporaryPath) {
          await rm(temporaryPath, { force: true });
          await rm(dirname(temporaryPath), { recursive: true, force: true });
        }
        expect(
          await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        ).toEqual({ status: "deleted" });
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
        ).toEqual({ status: "created", record });
      }
    }
  });

  test("rollback and restore namespace checkpoints reject all special bits and preserve primary causes", async () => {
    for (const surface of ["rollback", "restore"] as const) {
      for (const specialBit of [0o4000, 0o2000, 0o1000] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `${surface}-namespace-${specialBit.toString(8)}` };
        const evidenceRef = `special-namespace.${surface}.${specialBit.toString(8)}`;
        const directorySegments = [`special-namespace-${surface}`] as const;
        const fileName = `${specialBit.toString(8)}.json`;
        const canonicalPath = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
        const primary = new Error(`${surface} namespace primary ${specialBit.toString(8)}`);
        const externalSentinel = join(tempRoot, "external-sentinel");
        await writeFile(externalSentinel, `external ${surface}`);
        let namespacePath = "";
        let isolatedPath = "";

        if (surface === "restore") {
          expect(
            await createJsonRecordIfAbsent(
              workspaceRoot,
              directorySegments,
              fileName,
              record,
              evidenceRef,
              schema
            )
          ).toEqual({ status: "created", record });
        }

        const failure = await captureError(() =>
          runWithWorkspaceRecordCompensationTestHooks(
            {
              beforeOwnedPathIsolation: async (input) => {
                if (surface !== "rollback" || input.site !== "published_rollback") return;
                namespacePath = dirname(input.isolatedPath);
                await chmodIncludingSpecialBits(namespacePath, specialBit | 0o700);
              },
              afterOwnedPathIsolation: (input) => {
                if (surface !== "restore" || input.site !== "conditional_delete") return;
                isolatedPath = input.isolatedPath;
                throw primary;
              },
              beforeOwnedIsolatedSourceUnlink: async (input) => {
                if (surface !== "restore" || input.site !== "conditional_delete") return;
                isolatedPath = input.isolatedPath;
                namespacePath = dirname(input.isolatedPath);
                await chmodIncludingSpecialBits(namespacePath, specialBit | 0o700);
              }
            },
            () =>
              runWithWorkspaceRecordPublicationHooks(
                {
                  afterCanonicalLink: () => {
                    if (surface === "rollback") throw primary;
                  }
                },
                () =>
                  surface === "rollback"
                    ? createJsonRecordIfAbsent(
                        workspaceRoot,
                        directorySegments,
                        fileName,
                        record,
                        evidenceRef,
                        schema
                      )
                    : conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
                        kind: "record",
                        expected: record,
                        matches: (current, expected) => current.id === expected.id
                      })
              )
          )
        );

        expect(aggregateErrorMessages(failure)).toContain(primary.message);
        expect(aggregateErrorMessages(failure)).toContain(
          "Workspace record publication authority could not be verified."
        );
        expect((await stat(namespacePath)).mode & 0o7777).toBe(specialBit | 0o700);
        expect(await readFile(canonicalPath)).toEqual(expectedBytes);
        expect(await readFile(externalSentinel, "utf8")).toBe(`external ${surface}`);
        if (surface === "restore") {
          expect(await readFile(isolatedPath)).toEqual(expectedBytes);
        }

        await chmod(namespacePath, 0o700);
        if (isolatedPath) await rm(isolatedPath, { force: true });
        await rm(namespacePath, { recursive: true, force: true });
        expect((await stat(canonicalPath)).nlink).toBe(1);
        expect(
          await conditionalDeleteJsonRecord(canonicalPath, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        ).toEqual({ status: "deleted" });
        expect(
          await createJsonRecordIfAbsent(
            workspaceRoot,
            directorySegments,
            fileName,
            record,
            evidenceRef,
            schema
          )
        ).toEqual({ status: "created", record });
      }
    }
  });

  test("conditional-delete hook checkpoints retain admitted parents for ordinary and permit paths", async () => {
    for (const authority of ["ordinary", "cleanup-permit"] as const) {
      for (const conditionStatus of ["matched", "not_matched"] as const) {
        const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
        tempRoots.push(tempRoot);
        const schema = z.object({ id: z.string() });
        const record = { id: `conditional-${authority}-${conditionStatus}` };
        const evidenceRef = `conditional.${authority}.${conditionStatus}`;
        const directorySegments = [`conditional-${authority}-${conditionStatus}`] as const;
        const fileName = "record.json";
        const path = workspaceRecordPath(
          workspaceRoot,
          [...directorySegments, fileName],
          evidenceRef
        );
        const created =
          authority === "cleanup-permit"
            ? await createJsonRecordIfAbsentWithCleanupPermit(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              )
            : await createJsonRecordIfAbsent(
                workspaceRoot,
                directorySegments,
                fileName,
                record,
                evidenceRef,
                schema
              );
        if (created.status !== "created") throw new Error("Expected conditional fixture.");
        const before = await readFileWithIdentity(path);
        const parentPath = dirname(path);
        const displacedParentPath = join(
          tempRoot,
          `conditional-displaced-${authority}-${conditionStatus}`
        );
        let hookCalls = 0;
        const condition = {
          kind: "record" as const,
          expected: { id: conditionStatus === "matched" ? record.id : "different" },
          matches: (current: { id: string }, expected: { id: string }) =>
            current.id === expected.id
        };
        const action = () =>
          authority === "cleanup-permit"
            ? conditionalDeleteJsonRecordWithCleanupPermit(
                created.cleanupPermit,
                path,
                evidenceRef,
                schema,
                condition
              )
            : conditionalDeleteJsonRecord(path, evidenceRef, schema, condition);

        const error = await captureError(() =>
          runWithWorkspaceRecordPublicationHooks(
            {
              beforeConditionalDelete: async ({ conditionStatus: observedStatus }) => {
                hookCalls += 1;
                expect(observedStatus).toBe(conditionStatus);
                await rename(parentPath, displacedParentPath);
                await mkdir(parentPath);
                await rename(join(displacedParentPath, fileName), path);
              }
            },
            action
          )
        );

        expect(hookCalls).toBe(1);
        expect(error).toBeDefined();
        expect(await readFileWithIdentity(path)).toEqual(before);
        expect(await readdir(displacedParentPath)).toEqual([]);
        expect((await readdir(parentPath)).some(isOwnedRecordPath)).toBe(false);

        await rename(path, join(displacedParentPath, fileName));
        await rmdir(parentPath);
        await rename(displacedParentPath, parentPath);
        expect(
          await conditionalDeleteJsonRecord(path, evidenceRef, schema, {
            kind: "record",
            expected: record,
            matches: (current, expected) => current.id === expected.id
          })
        ).toEqual({ status: "deleted" });
      }
    }
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

  test("final-validator branded causes remain retrievable through publication compensation", async () => {
    class FinalValidatorBrandedError extends Error {
      #brand = "final-validator-brand";

      reveal(): string {
        return this.#brand;
      }
    }

    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const schema = z.object({ id: z.string() });
    const record = { id: "final-validator-branded-cause" };
    const evidenceRef = "publication.final-validator.branded";
    const marker = new FinalValidatorBrandedError("durable final validator failed");
    const compensation = new Error("published rollback compensation failed");

    const failure = await captureTaskServiceError(() =>
      runWithWorkspaceRecordCompensationTestHooks(
        {
          beforeOwnedPathIsolation: ({ site }) => {
            if (site === "published_rollback") throw compensation;
          }
        },
        () => runWithWorkspaceRecordPublicationHooks(
          {
            beforePublishedRecordFinalValidation: () => {
              throw marker;
            }
          },
          () => createJsonRecordIfAbsent(
            workspaceRoot,
            ["final-validator-branded"],
            "record.json",
            record,
            evidenceRef,
            schema
          )
        )
      )
    );

    const semantic = semanticPrimaryError(failure);
    expect(semantic).toBeInstanceOf(TaskServiceError);
    expect((semantic as TaskServiceError).cause).toBe(marker);
    expect(marker.reveal()).toBe("final-validator-brand");
    expect(errorTreeContains(failure, marker)).toBe(true);
    expect(errorTreeContains(failure, compensation)).toBe(true);
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
    let mutatedBytes: Buffer | undefined;
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
              mutatedBytes = Buffer.from(expectedBytes);
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
      expect(await readFile(publication!.canonicalPath)).toEqual(mutatedBytes!);
      await expectPathMissing(publication!.temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
      ).toBe(false);

      expect(
        await conditionalDeleteJsonRecord(
          publication!.canonicalPath,
          evidenceRef,
          LockRecordSchema,
          { kind: "malformed" }
        )
      ).toEqual({ status: "deleted" });

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

  test("durable final parent validation rejects a live leaf replacement before return", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    await mkdir(workspaceRoot);
    const path = join(workspaceRoot, "durable-final-parent.json");
    const displacedPath = join(workspaceRoot, "durable-final-parent.owner.json");
    const bytes = Buffer.from("durable-final-parent\n");
    await writeFile(path, bytes, { flag: "wx" });
    let validations = 0;

    const observed = await readDurableSingleLinkFile({
      path,
      maxBytes: 1024,
      validateParentPath: async () => {
        validations += 1;
        if (validations === 3) {
          await rename(path, displacedPath);
          await writeFile(path, bytes, { flag: "wx" });
        }
        return true;
      }
    });

    expect(observed.status).toBe("invalid");
    if (observed.status !== "invalid") throw new Error("Expected replacement rejection.");
    expect(observed.reason).toBe("changed_during_read");
    expect(await readFile(path)).toEqual(bytes);
    expect((await lstat(path, { bigint: true })).ino).not.toBe(
      (await lstat(displacedPath, { bigint: true })).ino
    );
  });

  test("publication final parent validation preserves a replacement and returns no permit", async () => {
    const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
    tempRoots.push(tempRoot);
    const record = { ...validLockRecord(), lock_id: "LOCK-final-parent-replacement" };
    const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
    const expectedBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    let publication: WorkspaceRecordPublicationHookInput | undefined;
    let replacementIdentity: bigint | undefined;

    const error = await captureTaskServiceError(() =>
      runWithWorkspaceRecordPublicationHooks(
        {
          afterCanonicalLink: (input) => {
            publication = input;
          },
          beforePublishedRecordFinalValidation: async ({ path }) => {
            const displacedPath = join(tempRoot, "final-parent-owned.json");
            await rename(path, displacedPath);
            await writeFile(path, expectedBytes, { flag: "wx" });
            replacementIdentity = (await lstat(path, { bigint: true })).ino;
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
    expect(publication).toBeDefined();
    expect((await lstat(publication!.canonicalPath, { bigint: true })).ino).toBe(
      replacementIdentity
    );
    expect(await readFile(publication!.canonicalPath)).toEqual(expectedBytes);
    await expectPathMissing(publication!.temporaryPath);
    expect(
      (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
    ).toBe(false);
  });

  test("hardlink rollback preserves non-owner public replacements without private residue", async () => {
    for (const kind of ["directory", "symlink", "file"] as const) {
      const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
      tempRoots.push(tempRoot);
      const record = {
        ...validLockRecord(),
        lock_id: `LOCK-hardlink-public-${kind}`
      };
      const evidenceRef = lockRecordEvidenceRef(record.scope, record.lock_id);
      const ownerPath = join(tempRoot, `${kind}-hardlink-owner.json`);
      const targetPath = join(tempRoot, `${kind}-hardlink-target.json`);
      const replacementBytes = Buffer.from(`hardlink-replacement-${kind}\n`);
      let publication: WorkspaceRecordPublicationHookInput | undefined;

      const error = await captureTaskServiceError(() =>
        runWithWorkspaceRecordPublicationHooks(
          {
            afterCanonicalLink: (input) => {
              publication = input;
            },
            beforePublishedRecordFinalValidation: async ({ path }) => {
              await rename(path, ownerPath);
              if (kind === "directory") await mkdir(path);
              else if (kind === "symlink") {
                await writeFile(targetPath, replacementBytes, { flag: "wx" });
                await symlink(targetPath, path);
              } else {
                await writeFile(path, replacementBytes, { flag: "wx" });
              }
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
      expect(publication).toBeDefined();
      expect(await readFile(ownerPath)).toEqual(
        Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
      );
      const replacement = await lstat(publication!.canonicalPath);
      if (kind === "directory") expect(replacement.isDirectory()).toBe(true);
      else if (kind === "symlink") {
        expect(replacement.isSymbolicLink()).toBe(true);
        expect(await readFile(targetPath)).toEqual(replacementBytes);
      } else {
        expect(await readFile(publication!.canonicalPath)).toEqual(replacementBytes);
      }
      await expectPathMissing(publication!.temporaryPath);
      expect(
        (await readdir(join(workspaceRoot, "locks", record.scope))).some(isOwnedRecordPath)
      ).toBe(false);
    }
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
            await writeFile(publication.canonicalPath, expectedBytes, {
              flag: "wx",
              mode: 0o600
            });
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
    const repeatedAggregate = findPreservedCompensationAggregate(repeatedError);
    expect(repeatedAggregate).toBeDefined();
    expect(repeatedAggregate!.errors).toHaveLength(2);
    expect(repeatedAggregate!.errors).toEqual([repeatedFailure, repeatedFailure]);
    expect(aggregateErrorMessages(repeatedError)).toEqual([
      "Workspace mutation namespace cleanup did not complete.",
      "same namespace cleanup failure",
      "Workspace record publication compensation failed."
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
          afterCanonicalLink: (input) => {
            publication = input;
          },
          beforeTemporaryUnlink: async ({ attempt }) => {
            attempts.push(attempt);
            if (attempt === 1) await link(publication!.canonicalPath, outsideAlias);
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

function asciiCaseVariant(lowerCaseName: string, variant: number): string {
  let letterIndex = 0;
  return Array.from(lowerCaseName, (character) => {
    if (character < "a" || character > "z") return character;
    const transformed = (variant & (1 << letterIndex)) === 0
      ? character
      : character.toUpperCase();
    letterIndex += 1;
    return transformed;
  }).join("");
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

async function detectCaseAliasWorkspaceSupport(): Promise<boolean> {
  const aliasWorkspace = await createCaseAliasWorkspacePath();
  if (!aliasWorkspace) return false;
  try {
    return true;
  } finally {
    await rm(aliasWorkspace.tempRoot, { recursive: true, force: true });
  }
}

type UnicodeAuthorityPairName = keyof typeof unicodeAuthorityPairs;
type UnicodeAuthorityCapabilities = Record<UnicodeAuthorityPairName, boolean>;

async function detectUnicodeCaseAliasCapabilities(): Promise<UnicodeAuthorityCapabilities> {
  const probeRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-unicode-alias-")));
  try {
    return {
      normalization: await supportsUnicodePathAlias(probeRoot, "normalization"),
      sigma: await supportsUnicodePathAlias(probeRoot, "sigma"),
      sharpS: await supportsUnicodePathAlias(probeRoot, "sharpS")
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function detectUnicodeDistinctEntryCapabilities(): Promise<UnicodeAuthorityCapabilities> {
  const probeRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-harness-unicode-distinct-")));
  try {
    return {
      normalization: await supportsDistinctUnicodeEntries(probeRoot, "normalization"),
      sigma: await supportsDistinctUnicodeEntries(probeRoot, "sigma"),
      sharpS: await supportsDistinctUnicodeEntries(probeRoot, "sharpS")
    };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

async function supportsUnicodePathAlias(
  probeRoot: string,
  pairName: UnicodeAuthorityPairName
): Promise<boolean> {
  const pairRoot = join(probeRoot, pairName);
  await mkdir(pairRoot);
  const [firstName, secondName] = unicodeAuthorityPairs[pairName];
  const firstPath = join(pairRoot, firstName);
  const secondPath = join(pairRoot, secondName);
  await writeFile(firstPath, pairName, { flag: "wx" });
  try {
    const [firstEntry, secondEntry] = await Promise.all([
      lstat(firstPath, { bigint: true }),
      lstat(secondPath, { bigint: true })
    ]);
    return firstEntry.dev === secondEntry.dev && firstEntry.ino === secondEntry.ino;
  } catch (error) {
    if (hasTestErrorCode(error, "ENOENT") || hasTestErrorCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function supportsDistinctUnicodeEntries(
  probeRoot: string,
  pairName: UnicodeAuthorityPairName
): Promise<boolean> {
  const pairRoot = join(probeRoot, pairName);
  await mkdir(pairRoot);
  const [firstName, secondName] = unicodeAuthorityPairs[pairName];
  const firstPath = join(pairRoot, firstName);
  const secondPath = join(pairRoot, secondName);
  await writeFile(firstPath, "first", { flag: "wx" });
  try {
    await writeFile(secondPath, "second", { flag: "wx" });
    const [firstEntry, secondEntry] = await Promise.all([
      lstat(firstPath, { bigint: true }),
      lstat(secondPath, { bigint: true })
    ]);
    return firstEntry.dev !== secondEntry.dev || firstEntry.ino !== secondEntry.ino;
  } catch (error) {
    if (hasTestErrorCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function expectUnicodeAuthorityPairOnCaseInsensitiveWorkspace(
  pairName: UnicodeAuthorityPairName
): Promise<void> {
  const aliasWorkspace = await createCaseAliasWorkspacePath();
  if (!aliasWorkspace) {
    throw new Error("Expected case-insensitive workspace aliases to be supported.");
  }
  const { tempRoot, workspaceRoot, aliasRoot } = aliasWorkspace;
  tempRoots.push(tempRoot);
  await mkdir(join(workspaceRoot, "UnicodeAuthority"));
  const [firstName, secondName] = unicodeAuthorityPairs[pairName];
  const [firstIdentity, secondIdentity] = await Promise.all([
    physicalAuthorityPathIdentity(
      join(workspaceRoot, "UnicodeAuthority", firstName),
      `unicode.visible.${pairName}.first`
    ),
    physicalAuthorityPathIdentity(
      join(aliasRoot, "unicodeauthority", secondName),
      `unicode.visible.${pairName}.second`
    )
  ]);
  expect(firstIdentity).toBe(secondIdentity);
}

async function expectUnicodeAuthorityPairOnCaseSensitiveWorkspace(
  pairName: UnicodeAuthorityPairName
): Promise<void> {
  const { tempRoot, workspaceRoot } = await createTempWorkspacePath();
  tempRoots.push(tempRoot);
  await mkdir(workspaceRoot);
  const [firstName, secondName] = unicodeAuthorityPairs[pairName];
  const [firstIdentity, secondIdentity] = await Promise.all([
    physicalAuthorityPathIdentity(
      join(workspaceRoot, firstName),
      `unicode.sensitive.visible.${pairName}.first`
    ),
    physicalAuthorityPathIdentity(
      join(workspaceRoot, secondName),
      `unicode.sensitive.visible.${pairName}.second`
    )
  ]);
  expect(firstIdentity).not.toBe(secondIdentity);
}

async function readFileWithIdentity(path: string): Promise<{ bytes: Buffer; dev: number; ino: number }> {
  const [bytes, identity] = await Promise.all([readFile(path), stat(path)]);
  return { bytes, dev: identity.dev, ino: identity.ino };
}

async function readOwnedFileState(path: string): Promise<{
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
}> {
  const [bytes, identity] = await Promise.all([readFile(path), lstat(path, { bigint: true })]);
  return {
    bytes,
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode,
    nlink: identity.nlink
  };
}

async function readPathState(path: string): Promise<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
}> {
  const identity = await lstat(path, { bigint: true });
  return {
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode,
    nlink: identity.nlink
  };
}

async function readPathIdentity(path: string): Promise<{ dev: number; ino: number }> {
  const identity = await lstat(path);
  return { dev: identity.dev, ino: identity.ino };
}

async function chmodIncludingSpecialBits(path: string, mode: number): Promise<void> {
  const process = Bun.spawn(["chmod", mode.toString(8), path], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text()
  ]);
  if (exitCode !== 0) {
    throw new Error(`chmod failed with exit ${exitCode}: ${stderr.trim()}`);
  }
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

async function readFileDescriptorIdentity(
  fd: number
): Promise<{ dev: bigint; ino: bigint }> {
  const entry = await new Promise<BigIntStats>(
    (resolvePromise, rejectPromise) => {
      fstat(fd, { bigint: true }, (statError, descriptorStat) => {
        if (statError) rejectPromise(statError);
        else resolvePromise(descriptorStat);
      });
    }
  );
  return { dev: entry.dev, ino: entry.ino };
}

function findPreservedCompensationAggregate(value: unknown): AggregateError | undefined {
  const envelope = findErrorNode(
    value,
    (error) => error instanceof PreservedErrorCompensationEnvelope
  ) as PreservedErrorCompensationEnvelope | undefined;
  return envelope?.cause instanceof AggregateError ? envelope.cause : undefined;
}

function aggregateErrorMessages(value: unknown, ancestors = new Set<unknown>()): string[] {
  if (!(value instanceof Error) || ancestors.has(value)) return [];
  ancestors.add(value);
  const semanticPrimary = semanticPrimaryError(value);
  const messages = semanticPrimary && semanticPrimary !== value ? [] : [value.message];
  if (semanticPrimary && semanticPrimary !== value) {
    messages.push(...aggregateErrorMessages(semanticPrimary, ancestors));
  }
  if (value instanceof AggregateError) {
    for (const error of value.errors) {
      messages.push(...aggregateErrorMessages(error, ancestors));
    }
  }
  messages.push(...aggregateErrorMessages(value.cause, ancestors));
  return messages;
}

function errorTreeContains(
  value: unknown,
  expected: unknown,
  ancestors = new Set<unknown>()
): boolean {
  if (value === expected) return true;
  if (!(value instanceof Error) || ancestors.has(value)) return false;
  ancestors.add(value);
  if (value instanceof AggregateError) {
    for (const error of value.errors) {
      if (errorTreeContains(error, expected, ancestors)) return true;
    }
  }
  const semanticPrimary = semanticPrimaryError(value);
  if (
    semanticPrimary &&
    semanticPrimary !== value &&
    errorTreeContains(semanticPrimary, expected, ancestors)
  ) {
    return true;
  }
  return errorTreeContains(value.cause, expected, ancestors);
}

function findErrorNode(
  value: unknown,
  predicate: (error: Error) => boolean,
  ancestors = new Set<unknown>()
): Error | undefined {
  if (!(value instanceof Error) || ancestors.has(value)) return undefined;
  ancestors.add(value);
  const semanticPrimary = semanticPrimaryError(value);
  if (semanticPrimary && semanticPrimary !== value) {
    const found = findErrorNode(semanticPrimary, predicate, ancestors);
    if (found) return found;
  }
  if (predicate(value)) return value;
  if (value instanceof AggregateError) {
    for (const error of value.errors) {
      const found = findErrorNode(error, predicate, ancestors);
      if (found) return found;
    }
  }
  return findErrorNode(value.cause, predicate, ancestors);
}

function countErrorNodes(
  value: unknown,
  predicate: (error: Error) => boolean,
  ancestors = new Set<unknown>()
): number {
  if (!(value instanceof Error) || ancestors.has(value)) return 0;
  ancestors.add(value);
  const semanticPrimary = semanticPrimaryError(value);
  let count = semanticPrimary && semanticPrimary !== value ? 0 : predicate(value) ? 1 : 0;
  if (semanticPrimary && semanticPrimary !== value) {
    count += countErrorNodes(semanticPrimary, predicate, ancestors);
  }
  if (value instanceof AggregateError) {
    for (const error of value.errors) {
      count += countErrorNodes(error, predicate, ancestors);
    }
  }
  return count + countErrorNodes(value.cause, predicate, ancestors);
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
  expect(entry.mode & 0o7777).toBe(0o700);
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
