import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import {
  LocalTokenStorageError,
  openWorkspaceLocalTokenAuthority
} from "./local-token-store";
import { runWithLocalTokenStoreTestContext } from "./local-token-test-support";
import {
  cleanupLocalTokenTestWorkspace,
  createLocalTokenTestWorkspace,
  descriptorInventory,
  interruptLocalTokenStore,
  replaceLocalTokenArtifact,
  transactionNames,
  type LocalTokenTestWorkspace
} from "./local-token-test-helpers";

const ADVERSARIAL_MATRIX_TIMEOUT_MS = 30_000;

describe("workspace local-token store descriptor lifecycle", () => {
  const workspaces: LocalTokenTestWorkspace[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      cleanupLocalTokenTestWorkspace(workspace);
    }
  });

  test("staged open failure closes descriptors before exact lease cleanup mismatch", () => {
    const before = descriptorInventory();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      const bytes = `foreign-lease-${attempt}`;
      let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

      expect(() => runWithLocalTokenStoreTestContext({
        failures: new Set(["staged_open"]),
        hook: ({ stage }) => {
          if (stage !== "before_staged_open" || replacement) return;
          const lease = transactionNames(workspace.secretsRoot).find((name) =>
            name.endsWith(".lease")
          );
          expect(lease).toBeDefined();
          const identity = replaceLocalTokenArtifact(workspace.secretsRoot, lease!, bytes);
          replacement = { name: lease!, dev: identity.dev, ino: identity.ino };
        }
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      }))).toThrow(LocalTokenStorageError);

      expect(replacement).toBeDefined();
      const path = join(workspace.secretsRoot, replacement!.name);
      const observed = lstatSync(path, { bigint: true });
      expect(observed.dev).toBe(replacement!.dev);
      expect(observed.ino).toBe(replacement!.ino);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(descriptorInventory()).toEqual(before);
    }
  });

  test("staged fstat failure closes every acquired descriptor on repeated isolated attempts", () => {
    const before = descriptorInventory();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);

      expect(() => runWithLocalTokenStoreTestContext({
        failures: new Set(["staged_fstat"])
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      }))).toThrow(LocalTokenStorageError);

      const names = transactionNames(workspace.secretsRoot);
      expect(names).toHaveLength(1);
      expect(names[0]?.endsWith(".staged")).toBe(true);
      expect(descriptorInventory()).toEqual(before);
    }
  });

  test("ordinary staged open failure removes the exact lease without residue", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);

    expect(() => runWithLocalTokenStoreTestContext({
      failures: new Set(["staged_open"])
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(readdirSync(workspace.secretsRoot)).toEqual([]);
  });

  test("lease setup failure cleans only its captured generation", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);

    expect(() => runWithLocalTokenStoreTestContext({
      failures: new Set(["lease_setup"])
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(readdirSync(workspace.secretsRoot)).toEqual([]);
  });

  test("lease setup cleanup preserves a replacement generation", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const bytes = "foreign-lease-setup";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      failures: new Set(["lease_setup"]),
      hook: ({ stage, name }) => {
        if (stage !== "before_lease_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const path = join(workspace.secretsRoot, replacement!.name);
    expect(lstatSync(path, { bigint: true }).ino).toBe(replacement!.ino);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("marker setup failure cleans marker, staged generation, and lease", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);

    expect(() => runWithLocalTokenStoreTestContext({
      failures: new Set(["marker_setup"])
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(readdirSync(workspace.secretsRoot)).toEqual([]);
  });

  test("marker setup cleanup preserves a replacement generation", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const bytes = "foreign-marker-setup";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      failures: new Set(["marker_setup"]),
      hook: ({ stage, name }) => {
        if (stage !== "before_publishing_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const path = join(workspace.secretsRoot, replacement!.name);
    expect(lstatSync(path, { bigint: true }).ino).toBe(replacement!.ino);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("staged recovery cleanup preserves a replacement generation", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(workspace.workspaceRoot, "after_staged_fsync");
    const bytes = "foreign-staged-recovery";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_staged_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const path = join(workspace.secretsRoot, replacement!.name);
    expect(lstatSync(path, { bigint: true }).ino).toBe(replacement!.ino);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("candidate recovery cleanup preserves a replacement generation", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(
      workspace.workspaceRoot,
      "after_rollback_move",
      "before_post_publish_binding"
    );
    const bytes = "foreign-candidate-recovery";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_candidate_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const path = join(workspace.secretsRoot, replacement!.name);
    expect(lstatSync(path, { bigint: true }).ino).toBe(replacement!.ino);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("two uncoordinated foreign canonical generations are preserved and fail closed", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(
      workspace.workspaceRoot,
      "after_rollback_move",
      "before_post_publish_binding"
    );
    const candidate = transactionNames(workspace.secretsRoot).find((name) =>
      name.endsWith(".candidate")
    );
    expect(candidate).toBeDefined();
    const candidateBytes = "foreign-candidate-A";
    const candidateIdentity = replaceLocalTokenArtifact(
      workspace.secretsRoot,
      candidate!,
      candidateBytes
    );
    const canonicalBytes = "foreign-canonical-B";
    const canonicalPath = join(workspace.secretsRoot, "local-token");
    writeFileSync(canonicalPath, canonicalBytes, { mode: 0o600 });
    const canonicalIdentity = lstatSync(canonicalPath, { bigint: true });

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);

    expect(lstatSync(join(workspace.secretsRoot, candidate!), { bigint: true }).ino).toBe(
      candidateIdentity.ino
    );
    expect(readFileSync(join(workspace.secretsRoot, candidate!), "utf8")).toBe(candidateBytes);
    expect(lstatSync(canonicalPath, { bigint: true }).ino).toBe(canonicalIdentity.ino);
    expect(readFileSync(canonicalPath, "utf8")).toBe(canonicalBytes);
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);
});
