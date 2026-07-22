import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WorkspacePathSafetyError,
  resolveWorkspacePath
} from "./workspace-path-safety";

const tempRoots: string[] = [];

describe("workspace denied boundary physical precedence", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("physical case and Unicode aliases of workspace secrets remain denied before readonly", async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-path-deny-alias-")));
    tempRoots.push(tempRoot);
    const workspaceRoot = join(tempRoot, "Wórkspace");
    const secretsRoot = join(workspaceRoot, "sécrets");
    await mkdir(secretsRoot, { recursive: true });
    const physicalWorkspace = await realpath(workspaceRoot);
    const caseAliasWorkspace = physicalWorkspace.replace("Wórkspace", "wórkspace");
    const unicodeAliasSecrets = join(
      physicalWorkspace,
      `s${"é".normalize("NFD")}crets`,
      "local-token"
    );
    const aliasCandidates = [
      join(caseAliasWorkspace, "sécrets", "local-token"),
      unicodeAliasSecrets
    ];
    const physicalSecrets = await realpath(secretsRoot);
    const candidates = [join(physicalWorkspace, "sécrets", "local-token")];
    for (const aliasCandidate of aliasCandidates) {
      const aliasPhysicalParent = await realpath(dirname(aliasCandidate)).catch(() => undefined);
      if (aliasPhysicalParent === physicalSecrets) candidates.push(aliasCandidate);
    }

    for (const inputPath of candidates) {
      try {
        await resolveWorkspacePath({
          workspaceRoot: physicalWorkspace,
          inputPath,
          evidenceRef: "artifact.physical_alias",
          access: "read",
          allowedReadonlyRoots: [caseAliasWorkspace, physicalWorkspace],
          deniedRelativeRoots: ["sécrets"]
        });
        throw new Error("Expected the physical workspace alias to be denied.");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspacePathSafetyError);
        expect((error as WorkspacePathSafetyError).message).toContain("denied workspace boundary");
        expect((error as WorkspacePathSafetyError).evidenceRef).toBe("artifact.physical_alias");
      }
    }
  });

  test("external readonly roots and workspace siblings remain compatible", async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-path-deny-compatible-")));
    tempRoots.push(tempRoot);
    const workspaceRoot = join(tempRoot, "workspace");
    const externalRoot = join(tempRoot, "external");
    const siblingRoot = join(tempRoot, "workspace-sibling");
    await Promise.all([
      mkdir(join(workspaceRoot, "secrets"), { recursive: true }),
      mkdir(externalRoot),
      mkdir(siblingRoot)
    ]);

    for (const readonlyRoot of [externalRoot, siblingRoot]) {
      const result = await resolveWorkspacePath({
        workspaceRoot,
        inputPath: join(readonlyRoot, "input.dat"),
        evidenceRef: "readonly.compatible",
        access: "read",
        allowedReadonlyRoots: [readonlyRoot],
        deniedRelativeRoots: ["secrets"]
      });
      expect(result.boundary).toBe("allowed_readonly");
    }
  });
});
