import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  LocalTokenStorageError,
  openWorkspaceLocalTokenAuthority
} from "./local-token-store";
import { runWithLocalTokenStoreTestContext } from "./local-token-test-support";
import {
  cleanupLocalTokenTestWorkspace,
  createLocalTokenTestWorkspace,
  createPrivateSecrets,
  interruptLocalTokenStore,
  replaceLocalTokenArtifact,
  transactionNames,
  type LocalTokenTestWorkspace
} from "./local-token-test-helpers";

const ADVERSARIAL_MATRIX_TIMEOUT_MS = 30_000;

function expectReplacementPreserved(input: {
  readonly workspace: LocalTokenTestWorkspace;
  readonly replacement: { readonly name: string; readonly dev: bigint; readonly ino: bigint };
  readonly bytes: string;
}): void {
  const path = join(input.workspace.secretsRoot, input.replacement.name);
  const observed = lstatSync(path, { bigint: true });
  expect(observed.dev).toBe(input.replacement.dev);
  expect(observed.ino).toBe(input.replacement.ino);
  expect(readFileSync(path, "utf8")).toBe(input.bytes);
}

describe("workspace local-token store transaction authority", () => {
  const workspaces: LocalTokenTestWorkspace[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      cleanupLocalTokenTestWorkspace(workspace);
    }
  });

  test("a no-clobber collision adopts a valid external canonical token", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const externalToken = "external-collision-winner";
    let installed = false;

    const authority = runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage !== "after_publishing_marker_fsync" || installed) return;
        installed = true;
        writeFileSync(join(workspace.secretsRoot, "local-token"), externalToken, {
          flag: "wx",
          mode: 0o600
        });
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(installed).toBe(true);
    expect(authority.token).toBe(externalToken);
    authority.assertCurrent();
    expect(readdirSync(workspace.secretsRoot)).toEqual(["local-token"]);
  });

  test("the directory lease rejects a concurrent publisher without polling", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    let nestedFailure: unknown;
    let attempted = false;

    const authority = runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage !== "after_staged_fsync" || attempted) return;
        attempted = true;
        try {
          openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
        } catch (error) {
          nestedFailure = error;
        }
      }
    }, () => openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot }));

    expect(attempted).toBe(true);
    expect(nestedFailure).toBeInstanceOf(LocalTokenStorageError);
    authority.assertCurrent();
    expect(readdirSync(workspace.secretsRoot)).toEqual(["local-token"]);
  });

  for (const fixture of [
    {
      name: "live publishing marker",
      targetStage: "before_publishing_cleanup" as const,
      artifactSuffix: ".publishing"
    },
    {
      name: "live lease",
      targetStage: "before_lease_cleanup" as const,
      artifactSuffix: ".lease"
    }
  ]) {
    test(`${fixture.name} replacement is preserved and no authority returns`, () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      const bytes = `foreign-${fixture.name}`;
      let replacement:
        | { name: string; dev: bigint; ino: bigint }
        | undefined;

      expect(() => runWithLocalTokenStoreTestContext({
        hook: ({ stage, name }) => {
          if (stage !== fixture.targetStage || !name || replacement) return;
          expect(name.endsWith(fixture.artifactSuffix)).toBe(true);
          const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
          replacement = { name, dev: identity.dev, ino: identity.ino };
        }
      }, () => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      }))).toThrow(LocalTokenStorageError);

      expect(replacement).toBeDefined();
      expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
    });
  }

  test("live rolling-back marker replacement is preserved and no authority returns", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const bytes = "foreign-live-rolling-marker";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage === "before_post_publish_binding") {
          throw new Error("enter rollback");
        }
        if (stage !== "before_rolling_back_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(replacement).toBeDefined();
    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  });

  test("publishing recovery preserves a marker replaced after validation", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(workspace.workspaceRoot, "after_publish");
    const bytes = "foreign-recovery-publishing-marker";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_publishing_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(replacement).toBeDefined();
    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("rolling-back recovery preserves a marker replaced after validation", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(
      workspace.workspaceRoot,
      "after_rollback_move",
      "before_post_publish_binding"
    );
    const bytes = "foreign-recovery-rolling-marker";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_rolling_back_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(replacement).toBeDefined();
    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("pre-publish recovery preserves a lease replaced after validation", async () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    await interruptLocalTokenStore(workspace.workspaceRoot, "after_staged_fsync");
    const bytes = "foreign-recovery-lease";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_lease_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(replacement).toBeDefined();
    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  }, ADVERSARIAL_MATRIX_TIMEOUT_MS);

  test("live rollback preserves a foreign candidate generation as canonical", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const foreign = "foreign-candidate-generation";
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage === "before_post_publish_binding") throw new Error("enter rollback");
        if (stage !== "after_rollback_move" || replacementIdentity) return;
        const candidate = transactionNames(workspace.secretsRoot).find((entry) =>
          entry.endsWith(".candidate")
        );
        expect(candidate).toBeDefined();
        const identity = replaceLocalTokenArtifact(
          workspace.secretsRoot,
          candidate!,
          foreign
        );
        replacementIdentity = { dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const canonical = lstatSync(join(workspace.secretsRoot, "local-token"), { bigint: true });
    expect(canonical.dev).toBe(replacementIdentity?.dev);
    expect(canonical.ino).toBe(replacementIdentity?.ino);
    expect(readFileSync(join(workspace.secretsRoot, "local-token"), "utf8")).toBe(foreign);
    expect(transactionNames(workspace.secretsRoot)).toEqual([]);
  });

  test("legacy single-link residue is retired before a fresh authority is published", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const legacy = `.local-token-123-${randomUUID()}.tmp`;
    writeFileSync(join(workspace.secretsRoot, legacy), "partial", { mode: 0o600 });

    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });

    authority.assertCurrent();
    expect(readdirSync(workspace.secretsRoot)).toEqual(["local-token"]);
  });

  test("legacy double-link residue converges to one canonical authority", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const token = "legacy-double-link-token";
    const canonical = join(workspace.secretsRoot, "local-token");
    const legacy = join(workspace.secretsRoot, `.local-token-123-${randomUUID()}.tmp`);
    writeFileSync(canonical, token, { mode: 0o600 });
    linkSync(canonical, legacy);

    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });

    expect(authority.token).toBe(token);
    authority.assertCurrent();
    expect(lstatSync(canonical, { bigint: true }).nlink).toBe(1n);
    expect(readdirSync(workspace.secretsRoot)).toEqual(["local-token"]);
  });

  test("legacy cleanup preserves a same-name replacement", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const legacy = `.local-token-123-${randomUUID()}.tmp`;
    writeFileSync(join(workspace.secretsRoot, legacy), "partial", { mode: 0o600 });
    const bytes = "foreign-legacy-replacement";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_legacy_cleanup" || !name || replacement) return;
        const identity = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: identity.dev, ino: identity.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  });

  test("retired cleanup preserves a same-name replacement", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const temporary = join(workspace.secretsRoot, "temporary-retired");
    writeFileSync(temporary, "retired-bytes", { mode: 0o600 });
    const identity = lstatSync(temporary, { bigint: true });
    const retired = `.local-token-retired-${identity.dev.toString(16)}-${identity.ino.toString(16)}-${randomUUID()}.retired`;
    renameSync(temporary, join(workspace.secretsRoot, retired));
    const bytes = "foreign-retired-replacement";
    let replacement: { name: string; dev: bigint; ino: bigint } | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage, name }) => {
        if (stage !== "before_retired_cleanup" || !name || replacement) return;
        const next = replaceLocalTokenArtifact(workspace.secretsRoot, name, bytes);
        replacement = { name, dev: next.dev, ino: next.ino };
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expectReplacementPreserved({ workspace, replacement: replacement!, bytes });
  });

  test("synchronous workspace displacement rolls back through held descriptors", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const displaced = join(workspace.tempRoot, "displaced-workspace");
    let moved = false;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage !== "before_post_publish_binding" || moved) return;
        moved = true;
        renameSync(workspace.workspaceRoot, displaced);
        mkdirSync(workspace.workspaceRoot, { mode: 0o700 });
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(moved).toBe(true);
    expect(readdirSync(join(displaced, "secrets"))).toEqual([]);
    expect(readdirSync(workspace.workspaceRoot)).toEqual([]);
  });
});
