import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspacePathSafetyError,
  resolveWorkspacePath,
  type ResolveWorkspacePathInput
} from "./index";
import { runWithWorkspacePathSafetyHooks } from "./workspace-path-safety";

const tempRoots: string[] = [];
const INVALID_POLICY_MESSAGE =
  "deniedRelativeRoots must contain unambiguous workspace-relative subtrees.";
const DENIED_BOUNDARY_MESSAGE =
  "Resolved path targets a denied workspace boundary.";

describe("workspace path denied relative roots", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("public service input exposes the opt-in deniedRelativeRoots contract", async () => {
    const workspaceRoot = await createWorkspace();
    const input: ResolveWorkspacePathInput = {
      workspaceRoot,
      inputPath: "public/report.md",
      evidenceRef: "path.public-contract",
      deniedRelativeRoots: ["secrets"]
    };

    expect((await resolveWorkspacePath(input)).normalizedPath).toBe("public/report.md");
  });

  test("exact, nested, and traversal-normalized secrets targets fail with the denied-boundary error", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets", "nested"), { recursive: true, mode: 0o700 });

    for (const inputPath of [
      "secrets",
      "secrets/nested/token.txt",
      "public/../secrets/local-token",
      join(workspaceRoot, "secrets", "nested")
    ]) {
      const error = await captureSafetyError(() => resolveWorkspacePath({
        workspaceRoot,
        inputPath,
        evidenceRef: "path.denied",
        deniedRelativeRoots: ["secrets"]
      }));
      expect(error.message, inputPath).toBe(DENIED_BOUNDARY_MESSAGE);
      expect(error.evidenceRef, inputPath).toBe("path.denied");
    }
  });

  test("a physical symlink alias into secrets fails as denied before generic symlink rejection", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets"), { mode: 0o700 });
    await writeFile(join(workspaceRoot, "secrets", "value"), "private");
    await symlink(join(workspaceRoot, "secrets"), join(workspaceRoot, "alias"), "dir");

    const error = await captureSafetyError(() => resolveWorkspacePath({
      workspaceRoot,
      inputPath: "alias/value",
      evidenceRef: "path.physical-alias",
      access: "read",
      deniedRelativeRoots: ["secrets"]
    }));
    expect(error.message).toBe(DENIED_BOUNDARY_MESSAGE);
    expect(error.evidenceRef).toBe("path.physical-alias");
  });

  test("denied workspace roots dominate overlapping read-only boundaries", async () => {
    const workspaceRoot = await createWorkspace();
    const secretsRoot = join(workspaceRoot, "secrets");
    await mkdir(join(secretsRoot, "nested"), { recursive: true, mode: 0o700 });
    const workspaceParent = join(workspaceRoot, "..");
    const physicalAlias = join(workspaceParent, "workspace-physical-alias");
    await symlink(workspaceRoot, physicalAlias, "dir");

    const fixtures = [
      {
        label: "workspace read-only root",
        allowedReadonlyRoots: [workspaceRoot],
        exactPath: secretsRoot,
        nestedPath: join(secretsRoot, "nested", "token")
      },
      {
        label: "denied subtree read-only root",
        allowedReadonlyRoots: [secretsRoot],
        exactPath: secretsRoot,
        nestedPath: join(secretsRoot, "nested", "token")
      },
      {
        label: "workspace ancestor read-only root",
        allowedReadonlyRoots: [workspaceParent],
        exactPath: secretsRoot,
        nestedPath: join(secretsRoot, "nested", "token")
      },
      {
        label: "physical workspace alias read-only root",
        allowedReadonlyRoots: [physicalAlias],
        exactPath: join(physicalAlias, "secrets"),
        nestedPath: join(physicalAlias, "secrets", "nested", "token")
      }
    ];

    for (const fixture of fixtures) {
      for (const [kind, inputPath] of [
        ["exact", fixture.exactPath],
        ["nested", fixture.nestedPath]
      ] as const) {
        const error = await captureSafetyError(() => resolveWorkspacePath({
          workspaceRoot,
          inputPath,
          evidenceRef: `path.readonly-deny-dominance.${fixture.label}.${kind}`,
          access: "read",
          allowedReadonlyRoots: fixture.allowedReadonlyRoots,
          deniedRelativeRoots: ["secrets"]
        }));
        expect(error.message, `${fixture.label} ${kind}`).toBe(DENIED_BOUNDARY_MESSAGE);
      }
    }
  });

  test("denied roots dominate descendant read-only aliases landing in the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets", "nested"), {
      recursive: true,
      mode: 0o700
    });
    const readonlyRoot = join(workspaceRoot, "..", "disjoint-readonly-alias-root");
    await mkdir(readonlyRoot);

    for (const fixture of [
      {
        label: "workspace alias",
        aliasName: "workspace-alias",
        aliasTarget: workspaceRoot,
        paths: [
          "workspace-alias/secrets",
          "workspace-alias/secrets/nested/token",
          "workspace-alias/secrets/missing/token"
        ]
      },
      {
        label: "secrets alias",
        aliasName: "secrets-alias",
        aliasTarget: join(workspaceRoot, "secrets"),
        paths: [
          "secrets-alias",
          "secrets-alias/nested/token",
          "secrets-alias/missing/token"
        ]
      }
    ]) {
      await symlink(fixture.aliasTarget, join(readonlyRoot, fixture.aliasName), "dir");
      for (const [index, relativePath] of fixture.paths.entries()) {
        const error = await captureSafetyError(() => resolveWorkspacePath({
          workspaceRoot,
          inputPath: join(readonlyRoot, relativePath),
          evidenceRef: `path.descendant-readonly-alias.${fixture.label}.${index}`,
          access: "read",
          allowedReadonlyRoots: [readonlyRoot],
          deniedRelativeRoots: ["secrets"]
        }));
        expect(error.message, `${fixture.label} ${relativePath}`).toBe(
          DENIED_BOUNDARY_MESSAGE
        );
      }
    }

    const disjointFile = join(readonlyRoot, "ordinary", "input.dat");
    await mkdir(join(readonlyRoot, "ordinary"));
    await writeFile(disjointFile, "readonly");
    const resolution = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: disjointFile,
      evidenceRef: "path.descendant-readonly-alias.disjoint",
      access: "read",
      allowedReadonlyRoots: [readonlyRoot],
      deniedRelativeRoots: ["secrets"]
    });
    expect(resolution.boundary).toBe("allowed_readonly");
    expect(resolution.absolutePath).toBe(disjointFile);
  });

  test("outside targets fail containment before denied-root physical observation", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets"), { mode: 0o700 });
    const outsidePath = join(workspaceRoot, "..", "outside.txt");
    await writeFile(outsidePath, "outside");
    let physicalCandidateObservations = 0;

    const error = await captureSafetyError(() =>
      runWithWorkspacePathSafetyHooks(
        {
          afterPhysicalCandidateLstat: () => {
            physicalCandidateObservations += 1;
            throw new Error("outside target reached physical candidate observation");
          }
        },
        () => resolveWorkspacePath({
          workspaceRoot,
          inputPath: outsidePath,
          evidenceRef: "path.outside-containment",
          deniedRelativeRoots: ["secrets"]
        })
      )
    );

    expect(error.message).toBe("Resolved path escapes the configured workspace.");
    expect(error.evidenceRef).toBe("path.outside-containment");
    expect(physicalCandidateObservations).toBe(0);
  });

  test("allowed read-only targets remain readable without denied-root physical observation", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets"), { mode: 0o700 });
    const readonlyRoot = join(workspaceRoot, "..", "readonly-with-policy");
    await mkdir(readonlyRoot);
    const readonlyPath = join(readonlyRoot, "input.dat");
    await writeFile(readonlyPath, "readonly");
    let physicalCandidateObservations = 0;

    const resolution = await runWithWorkspacePathSafetyHooks(
      {
        afterPhysicalCandidateLstat: () => {
          physicalCandidateObservations += 1;
          throw new Error("readonly target reached denied-root physical observation");
        }
      },
      () => resolveWorkspacePath({
        workspaceRoot,
        inputPath: readonlyPath,
        evidenceRef: "path.readonly-with-policy",
        access: "read",
        allowedReadonlyRoots: [readonlyRoot],
        deniedRelativeRoots: ["secrets"]
      })
    );

    expect(resolution.boundary).toBe("allowed_readonly");
    expect(resolution.absolutePath).toBe(readonlyPath);
    expect(physicalCandidateObservations).toBe(0);
  });

  test("invalid policies fail with the one stable policy error", async () => {
    const workspaceRoot = await createWorkspace();
    const invalidRoots = [
      "",
      " ",
      ".",
      "..",
      "secrets/.",
      "secrets/..",
      "secrets//nested",
      "secrets/",
      "/secrets",
      "\\secrets",
      "C:\\secrets",
      "C:secrets",
      "secrets\u0000nested"
    ];

    for (const deniedRoot of invalidRoots) {
      const error = await captureSafetyError(() => resolveWorkspacePath({
        workspaceRoot,
        inputPath: "public/report.md",
        evidenceRef: "path.invalid-policy",
        deniedRelativeRoots: [deniedRoot]
      }));
      expect(error.message, JSON.stringify(deniedRoot)).toBe(INVALID_POLICY_MESSAGE);
      expect(error.evidenceRef, JSON.stringify(deniedRoot)).toBe("path.invalid-policy");
    }
  });

  test("sibling paths and omitted or empty policies preserve prior resolution and symlink errors", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, "secrets"), { mode: 0o700 });
    await mkdir(join(workspaceRoot, "secret-sibling"));

    const sibling = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "secret-sibling/report.md",
      evidenceRef: "path.sibling",
      deniedRelativeRoots: ["secrets"]
    });
    expect(sibling.normalizedPath).toBe("secret-sibling/report.md");

    const omitted = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "secrets/report.md",
      evidenceRef: "path.omitted"
    });
    const empty = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: "secrets/report.md",
      evidenceRef: "path.empty",
      deniedRelativeRoots: []
    });
    expect(omitted.normalizedPath).toBe("secrets/report.md");
    expect(empty.normalizedPath).toBe(omitted.normalizedPath);

    const readonlyRoot = join(workspaceRoot, "..", "readonly");
    await mkdir(readonlyRoot);
    const readonlyResolution = await resolveWorkspacePath({
      workspaceRoot,
      inputPath: join(readonlyRoot, "input.dat"),
      evidenceRef: "path.readonly-compatible",
      access: "read",
      allowedReadonlyRoots: [readonlyRoot],
      deniedRelativeRoots: []
    });
    expect(readonlyResolution.boundary).toBe("allowed_readonly");
    const readonlyWriteError = await captureSafetyError(() => resolveWorkspacePath({
      workspaceRoot,
      inputPath: join(readonlyRoot, "input.dat"),
      evidenceRef: "path.readonly-compatible",
      access: "write",
      allowedReadonlyRoots: [readonlyRoot]
    }));
    expect(readonlyWriteError.message).toBe(
      "Resolved path targets a read-only boundary for a write operation."
    );

    await symlink(join(workspaceRoot, "secrets"), join(workspaceRoot, "legacy-alias"), "dir");
    const legacyError = await captureSafetyError(() => resolveWorkspacePath({
      workspaceRoot,
      inputPath: "legacy-alias/report.md",
      evidenceRef: "path.legacy"
    }));
    expect(legacyError.message).toBe("Workspace path crosses a symlink.");
  });
});

async function createWorkspace(): Promise<string> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "workspace-path-denied-")));
  tempRoots.push(tempRoot);
  const workspaceRoot = join(tempRoot, "workspace");
  await mkdir(join(workspaceRoot, "public"), { recursive: true });
  return workspaceRoot;
}

async function captureSafetyError(action: () => Promise<unknown>): Promise<WorkspacePathSafetyError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspacePathSafetyError);
    return error as WorkspacePathSafetyError;
  }
  throw new Error("Expected WorkspacePathSafetyError.");
}
