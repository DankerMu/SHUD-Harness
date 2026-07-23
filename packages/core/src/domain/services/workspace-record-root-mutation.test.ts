import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import {
  ensureWorkspaceDirectoryTree,
  probeWorkspaceRecordDirectoryWritable,
  runWithWorkspaceRecordRootMutationAuthority,
  workspaceRecordAuthorityDiagnosticsForTest,
  workspaceRecordDirectoryBindingDiagnosticsForTest
} from "./workspace-record-store";

const tempRoots: string[] = [];
const SYNCHRONOUS_CALLBACK_ERROR =
  "Workspace root mutation callback must return synchronously.";

describe("workspace record root mutation authority", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  test("the public type contract rejects async callbacks and accepts synchronous callbacks", async () => {
    const tempRoot = await createTempRoot();
    const fixturePath = join(tempRoot, "root-mutation-type-fixture.ts");
    const modulePath = join(import.meta.dir, "../../index.ts");
    await writeFile(fixturePath, [
      `import { runWithWorkspaceRecordRootMutationAuthority } from ${JSON.stringify(modulePath)};`,
      "runWithWorkspaceRecordRootMutationAuthority('/workspace', 'sync', () => 42);",
      "// @ts-expect-error root mutation callbacks must not return Promise-like values",
      "runWithWorkspaceRecordRootMutationAuthority('/workspace', 'async', async () => 42);"
    ].join("\n"));

    const program = ts.createProgram({
      rootNames: [fixturePath],
      options: {
        allowImportingTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022
      }
    });
    const fixtureDiagnostics = ts.getPreEmitDiagnostics(program).filter(
      (diagnostic) => diagnostic.file?.fileName === fixturePath
    );
    expect(fixtureDiagnostics.map((diagnostic) => diagnostic.messageText)).toEqual([]);
  });

  test("a hostile thenable is rejected without assimilation and releases root authority", async () => {
    const workspaceRoot = await createWorkspace();
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let thenPropertyReads = 0;
    let thenCalls = 0;
    const hostileThenable = Object.freeze(Object.defineProperty({}, "then", {
      get: () => {
        thenPropertyReads += 1;
        return () => {
          thenCalls += 1;
        };
      }
    }));

    await expect(within(
      runWithWorkspaceRecordRootMutationAuthority(
        workspaceRoot,
        "root-mutation.hostile-thenable",
        () => hostileThenable as unknown as object
      ),
      2_000,
      "thenable callback rejection deadlocked"
    )).rejects.toMatchObject({
      name: "TypeError",
      message: SYNCHRONOUS_CALLBACK_ERROR
    });
    expect(thenPropertyReads).toBe(0);
    expect(thenCalls).toBe(0);
    expect(await within(
      probeWorkspaceRecordDirectoryWritable(
        workspaceRoot,
        "root-mutation.hostile-thenable.follow-up"
      ),
      2_000,
      "follow-up root probe did not finish"
    )).toBe(true);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });

  test("a same-root Promise operation is rejected promptly and completes after lock release", async () => {
    const workspaceRoot = await createWorkspace();
    const authorityBaseline = workspaceRecordAuthorityDiagnosticsForTest();
    const bindingBaseline = workspaceRecordDirectoryBindingDiagnosticsForTest();
    let nestedProbe!: Promise<boolean>;

    await expect(within(
      runWithWorkspaceRecordRootMutationAuthority(
        workspaceRoot,
        "root-mutation.same-root-promise",
        () => {
          nestedProbe = probeWorkspaceRecordDirectoryWritable(
            workspaceRoot,
            "root-mutation.same-root-promise.nested"
          );
          return nestedProbe as unknown as boolean;
        }
      ),
      2_000,
      "Promise callback rejection deadlocked"
    )).rejects.toMatchObject({
      name: "TypeError",
      message: SYNCHRONOUS_CALLBACK_ERROR
    });
    expect(await within(
      nestedProbe,
      2_000,
      "nested same-root probe did not finish after rejection"
    )).toBe(true);
    expect(workspaceRecordAuthorityDiagnosticsForTest()).toEqual(authorityBaseline);
    expect(workspaceRecordDirectoryBindingDiagnosticsForTest()).toEqual(bindingBaseline);
  });
});

async function createTempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-root-mutation-")));
  tempRoots.push(root);
  return root;
}

async function createWorkspace(): Promise<string> {
  const tempRoot = await createTempRoot();
  const workspaceRoot = join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { mode: 0o700 });
  await ensureWorkspaceDirectoryTree(workspaceRoot, [], "root-mutation.setup");
  return workspaceRoot;
}

async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  return await Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), milliseconds);
    })
  ]);
}
