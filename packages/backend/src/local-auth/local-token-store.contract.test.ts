import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats
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
  createPrivateSecrets,
  replaceLocalTokenArtifact,
  type LocalTokenTestWorkspace
} from "./local-token-test-helpers";

describe("workspace local-token store contract", () => {
  const workspaces: LocalTokenTestWorkspace[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      cleanupLocalTokenTestWorkspace(workspace);
    }
  });

  test("creates one frozen reusable 0600 authority under a 0700 secrets directory", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);

    const first = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    expect(first.source).toBe("workspace");
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.token.length).toBeGreaterThan(0);
    first.assertCurrent();

    const secrets = lstatSync(workspace.secretsRoot, { bigint: true });
    const token = lstatSync(join(workspace.secretsRoot, "local-token"), { bigint: true });
    expect(secrets.isDirectory()).toBe(true);
    expect(secrets.mode & 0o7777n).toBe(0o700n);
    expect(token.isFile()).toBe(true);
    expect(token.mode & 0o7777n).toBe(0o600n);
    expect(token.nlink).toBe(1n);

    const second = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    expect(second.token).toBe(first.token);
    second.assertCurrent();
  });

  test("creates an absent safe workspace leaf descriptor-relatively", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const absent = join(workspace.tempRoot, "new-workspace");

    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: absent });

    expect(authority.source).toBe("workspace");
    authority.assertCurrent();
    expect(lstatSync(absent).isDirectory()).toBe(true);
  });

  test("accepts and exactly reuses a 4096-byte valid UTF-8 token", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const expected = "x".repeat(4096);
    writeFileSync(join(workspace.secretsRoot, "local-token"), expected, { mode: 0o600 });

    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });

    expect(authority.token).toBe(expected);
    authority.assertCurrent();
    expect(readFileSync(join(workspace.secretsRoot, "local-token"), "utf8")).toBe(expected);
  });

  for (const fixture of [
    { name: "empty", bytes: Buffer.alloc(0) },
    { name: "4097-byte", bytes: Buffer.alloc(4097, 0x61) },
    { name: "malformed UTF-8", bytes: Buffer.from([0xff]) }
  ]) {
    test(`rejects a ${fixture.name} token without overwriting it`, () => {
      const workspace = createLocalTokenTestWorkspace();
      workspaces.push(workspace);
      createPrivateSecrets(workspace);
      const path = join(workspace.secretsRoot, "local-token");
      writeFileSync(path, fixture.bytes, { mode: 0o600 });

      expect(() => openWorkspaceLocalTokenAuthority({
        workspaceRoot: workspace.workspaceRoot
      })).toThrow(LocalTokenStorageError);
      expect(readFileSync(path)).toEqual(fixture.bytes);
    });
  }

  test("rejects a token with non-private permissions without normalizing it", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const path = join(workspace.secretsRoot, "local-token");
    writeFileSync(path, "foreign-token", { mode: 0o600 });
    chmodSync(path, 0o644);

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(lstatSync(path, { bigint: true }).mode & 0o7777n).toBe(0o644n);
    expect(readFileSync(path, "utf8")).toBe("foreign-token");
  });

  test("rejects a non-private secrets directory without normalizing it", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    chmodSync(workspace.secretsRoot, 0o755);

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(lstatSync(workspace.secretsRoot, { bigint: true }).mode & 0o7777n).toBe(0o755n);
  });

  test("rejects a symlink token without reading or changing its target", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const outside = join(workspace.tempRoot, "outside-token");
    writeFileSync(outside, "outside-secret", { mode: 0o600 });
    symlinkSync(outside, join(workspace.secretsRoot, "local-token"));

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(readFileSync(outside, "utf8")).toBe("outside-secret");
    expect(lstatSync(join(workspace.secretsRoot, "local-token")).isSymbolicLink()).toBe(true);
  });

  test("rejects a directory at the canonical token leaf", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const path = join(workspace.secretsRoot, "local-token");
    mkdirSync(path, { mode: 0o700 });

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  test("rejects a FIFO without blocking", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const path = join(workspace.secretsRoot, "local-token");
    execFileSync("mkfifo", [path], { timeout: 2_000 });
    chmodSync(path, 0o600);

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(lstatSync(path).isFIFO()).toBe(true);
  });

  test("rejects a hardlinked token and preserves both links", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const tokenPath = join(workspace.secretsRoot, "local-token");
    const aliasPath = join(workspace.secretsRoot, "foreign-alias");
    writeFileSync(tokenPath, "hardlinked-token", { mode: 0o600 });
    linkSync(tokenPath, aliasPath);

    expect(() => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    })).toThrow(LocalTokenStorageError);
    expect(lstatSync(tokenPath, { bigint: true }).nlink).toBe(2n);
    expect(lstatSync(aliasPath, { bigint: true }).ino).toBe(
      lstatSync(tokenPath, { bigint: true }).ino
    );
  });

  test("rejects a symlinked workspace ancestor without writing outside", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const outside = join(workspace.tempRoot, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const linked = join(workspace.tempRoot, "linked");
    symlinkSync(outside, linked);

    expect(() => openWorkspaceLocalTokenAuthority({ workspaceRoot: linked })).toThrow(
      LocalTokenStorageError
    );
    expect(lstatSync(outside).isDirectory()).toBe(true);
    expect(() => lstatSync(join(outside, "secrets"))).toThrow();
  });

  test("assertCurrent rejects a same-byte replacement generation and preserves it", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    const replacement = replaceLocalTokenArtifact(
      workspace.secretsRoot,
      "local-token",
      authority.token
    );

    expect(() => authority.assertCurrent()).toThrow(LocalTokenStorageError);
    const current = lstatSync(join(workspace.secretsRoot, "local-token"), { bigint: true });
    expect(current.dev).toBe(replacement.dev);
    expect(current.ino).toBe(replacement.ino);
    expect(readFileSync(join(workspace.secretsRoot, "local-token"), "utf8")).toBe(
      authority.token
    );
  });

  test("assertCurrent rejects a replaced secrets directory", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    const displaced = join(workspace.workspaceRoot, "old-secrets");
    renameSync(workspace.secretsRoot, displaced);
    mkdirSync(workspace.secretsRoot, { mode: 0o700 });
    writeFileSync(join(workspace.secretsRoot, "local-token"), authority.token, { mode: 0o600 });

    expect(() => authority.assertCurrent()).toThrow(LocalTokenStorageError);
    expect(readFileSync(join(workspace.secretsRoot, "local-token"), "utf8")).toBe(
      authority.token
    );
  });

  test("assertCurrent rejects a replaced workspace root", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const authority = openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    const displaced = join(workspace.tempRoot, "old-workspace");
    renameSync(workspace.workspaceRoot, displaced);
    mkdirSync(workspace.workspaceRoot, { mode: 0o700 });

    expect(() => authority.assertCurrent()).toThrow(LocalTokenStorageError);
  });

  test("final authority reproof rejects and preserves a canonical replacement", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const replacementBytes = "foreign-final-token";
    let replacement: BigIntStats | undefined;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage !== "before_authority_return" || replacement) return;
        replacement = replaceLocalTokenArtifact(
          workspace.secretsRoot,
          "local-token",
          replacementBytes
        );
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    const current = lstatSync(join(workspace.secretsRoot, "local-token"), { bigint: true });
    expect(current.ino).toBe(replacement?.ino);
    expect(readFileSync(join(workspace.secretsRoot, "local-token"), "utf8")).toBe(
      replacementBytes
    );
  });

  test("final authority reproof rejects a secrets pathname replacement", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    const displaced = join(workspace.workspaceRoot, "displaced-secrets");
    let replaced = false;

    expect(() => runWithLocalTokenStoreTestContext({
      hook: ({ stage }) => {
        if (stage !== "before_authority_return" || replaced) return;
        replaced = true;
        renameSync(workspace.secretsRoot, displaced);
        mkdirSync(workspace.secretsRoot, { mode: 0o700 });
      }
    }, () => openWorkspaceLocalTokenAuthority({
      workspaceRoot: workspace.workspaceRoot
    }))).toThrow(LocalTokenStorageError);

    expect(replaced).toBe(true);
    expect(readdirSync(workspace.secretsRoot)).toEqual([]);
    expect(readFileSync(join(displaced, "local-token"), "utf8").length).toBeGreaterThan(0);
  });

  test("stable failures disclose neither token bytes nor absolute paths", () => {
    const workspace = createLocalTokenTestWorkspace();
    workspaces.push(workspace);
    createPrivateSecrets(workspace);
    const secret = "do-not-disclose-this-token";
    const path = join(workspace.secretsRoot, "local-token");
    writeFileSync(path, secret, { mode: 0o644 });

    let observed: unknown;
    try {
      openWorkspaceLocalTokenAuthority({ workspaceRoot: workspace.workspaceRoot });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(LocalTokenStorageError);
    expect((observed as LocalTokenStorageError).code).toBe("local_token_storage_unsafe");
    expect((observed as Error).message).toBe("Local API token storage is unsafe.");
    expect((observed as Error).message).not.toContain(secret);
    expect((observed as Error).message).not.toContain(workspace.workspaceRoot);
  });
});
