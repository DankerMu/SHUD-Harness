import { expect, test } from "bun:test";
import { lstat, link, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const store = await import(
  "../../../../packages/core/src/domain/services/workspace-record-store.ts"
);
const conditionalDeleteWithPrivateSettlement = (
  store as typeof store & {
    conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement?:
      typeof store.conditionalDeleteJsonRecordWithCleanupPermit;
  }
).conditionalDeleteJsonRecordWithCleanupPermitAndExactFailureSettlement ??
  store.conditionalDeleteJsonRecordWithCleanupPermit;

test("base-compatible acceptance reaches public B preservation and terminal private settlement", async () => {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "issue-108-base-compatible-terminal-"))
  );
  try {
    const workspaceRoot = join(tempRoot, "workspace");
    const schema = z.object({ id: z.string() });
    const record = { id: "base-compatible-terminal-a" };
    const evidenceRef = "issue-108.base-compatible.terminal";
    const directorySegments = ["base-compatible-terminal"] as const;
    const path = store.workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, "record.json"],
      evidenceRef
    );
    const successorBytes = Buffer.from('{"id":"base-compatible-terminal-b"}\n');
    const authorityBaseline = store.workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = store.workspaceRecordDirectoryBindingDiagnosticsForTest();
    const created = await store.createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      "record.json",
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected terminal red fixture.");
    let isolatedPath = "";
    let actionOutcome:
      | { status: "fulfilled"; value: unknown }
      | { status: "rejected"; reason: unknown };

    try {
      const value = await store.runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: async ({ site, isolatedPath: observed }) => {
            if (site !== "conditional_delete") return;
            isolatedPath = observed;
            await writeFile(path, successorBytes, { flag: "wx", mode: 0o600 });
            throw new Error("force base-compatible terminal settlement");
          }
        },
        () =>
          conditionalDeleteWithPrivateSettlement(
            created.cleanupPermit,
            path,
            evidenceRef,
            schema,
            { kind: "record", expected: record, matches: () => true }
          )
      );
      actionOutcome = { status: "fulfilled", value };
    } catch (reason) {
      actionOutcome = { status: "rejected", reason };
    }

    expect(isolatedPath).not.toBe("");
    expect(await readFile(path)).toEqual(successorBytes);
    expect(store.workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(store.workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
    expect(actionOutcome).toEqual({
      status: "fulfilled",
      value: { status: "recovered", settlement: "deleted" }
    });
    await expect(lstat(isolatedPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("base-compatible acceptance reaches irreversible private proof drift assertions", async () => {
  const tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), "issue-108-base-compatible-proof-"))
  );
  try {
    const workspaceRoot = join(tempRoot, "workspace");
    const schema = z.object({ id: z.string() });
    const record = { id: "base-compatible-proof-a" };
    const evidenceRef = "issue-108.base-compatible.proof";
    const directorySegments = ["base-compatible-proof"] as const;
    const path = store.workspaceRecordPath(
      workspaceRoot,
      [...directorySegments, "record.json"],
      evidenceRef
    );
    const successorBytes = Buffer.from('{"id":"base-compatible-proof-b"}\n');
    const authorityBaseline = store.workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = store.workspaceRecordDirectoryBindingDiagnosticsForTest();
    const created = await store.createJsonRecordIfAbsentWithCleanupPermit(
      workspaceRoot,
      directorySegments,
      "record.json",
      record,
      evidenceRef,
      schema
    );
    if (created.status !== "created") throw new Error("Expected proof red fixture.");
    let isolatedPath = "";
    let proofAttempts = 0;
    let restoreAlias: Promise<void> | undefined;
    let failure: unknown;

    try {
      await store.runWithWorkspaceRecordCompensationTestHooks(
        {
          afterOwnedPathIsolation: async ({ site, isolatedPath: observed }) => {
            if (site !== "conditional_delete") return;
            isolatedPath = observed;
            await writeFile(path, successorBytes, { flag: "wx", mode: 0o600 });
            throw new Error("force base-compatible proof settlement");
          },
          beforeOwnedIsolatedSourceUnlink: async ({ isolatedPath: observed, attempt }) => {
            if (observed !== isolatedPath || attempt !== 1 || proofAttempts !== 0) return;
            proofAttempts += 1;
            const aliasPath = join(tempRoot, "transient-private-alias");
            await link(isolatedPath, aliasPath);
            restoreAlias = new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
              .then(async () => await unlink(aliasPath));
          }
        },
        () =>
          conditionalDeleteWithPrivateSettlement(
            created.cleanupPermit,
            path,
            evidenceRef,
            schema,
            { kind: "record", expected: record, matches: () => true }
          )
      );
    } catch (error) {
      failure = error;
    }
    await restoreAlias;

    expect(failure).toBeDefined();
    expect(proofAttempts).toBe(1);
    expect(await readFile(path)).toEqual(successorBytes);
    expect(await readFile(isolatedPath)).toEqual(
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
    );
    expect(store.workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(store.workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
