import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDirectorySha256, hashFileSha256 } from "./hashing-service";
import { WorkspacePathSafetyError } from "./index";

const tempRoots: string[] = [];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256LineProtocolTextDigest(lines: string[]): string {
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

async function createWorkspaceRoot(): Promise<{ tempRoot: string; workspaceRoot: string }> {
  const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "shud-issue-90-")));
  const workspaceRoot = join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  tempRoots.push(tempRoot);
  return { tempRoot, workspaceRoot };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { recursive: true, force: true }))
  );
});

describe("hashing service", () => {
  test("hashes file content with streaming behavior", async () => {
    const { workspaceRoot } = await createWorkspaceRoot();
    const filePath = join(workspaceRoot, "payload.txt");
    await writeFile(filePath, "payload");

    const observed = await hashFileSha256({
      workspaceRoot,
      inputPath: "payload.txt",
      evidenceRef: "test:hash-file"
    });

    expect(observed).toBe(sha256Hex("payload"));
  });

  test("hashes directory deterministically with sorted relative path protocol and detects changes", async () => {
    const { workspaceRoot } = await createWorkspaceRoot();
    await mkdir(join(workspaceRoot, "forcing"), { recursive: true });
    await mkdir(join(workspaceRoot, "forcing", "nested"), { recursive: true });

    await writeFile(join(workspaceRoot, "forcing", "beta.txt"), "beta");
    await writeFile(join(workspaceRoot, "forcing", "alpha.txt"), "alpha");
    await writeFile(join(workspaceRoot, "forcing", "nested", "gamma.txt"), "gamma");

    const first = await hashDirectorySha256({
      workspaceRoot,
      inputPath: "forcing",
      evidenceRef: "test:hash-dir"
    });

    const expectedLines = [
      `alpha.txt\n${sha256Hex("alpha")}\n`,
      `beta.txt\n${sha256Hex("beta")}\n`,
      `nested/gamma.txt\n${sha256Hex("gamma")}\n`
    ];
    expect(first).toBe(sha256LineProtocolTextDigest(expectedLines));

    await writeFile(join(workspaceRoot, "forcing", "delta.txt"), "delta");
    const second = await hashDirectorySha256({
      workspaceRoot,
      inputPath: "forcing",
      evidenceRef: "test:hash-dir"
    });

    expect(second).not.toBe(first);
  });

  test("rejects symbolic links during file and directory hashing", async () => {
    const { workspaceRoot } = await createWorkspaceRoot();
    await writeFile(join(workspaceRoot, "target.txt"), "target");
    await symlink(
      join(workspaceRoot, "target.txt"),
      join(workspaceRoot, "link.txt")
    );

    await expect(
      hashFileSha256({
        workspaceRoot,
        inputPath: "link.txt",
        evidenceRef: "test:hash-file-link"
      })
    ).rejects.toThrow(WorkspacePathSafetyError);

    await mkdir(join(workspaceRoot, "dir"), { recursive: true });
    await writeFile(join(workspaceRoot, "dir", "ok.txt"), "ok");
    await symlink(
      join(workspaceRoot, "target.txt"),
      join(workspaceRoot, "dir", "link.txt")
    );

    await expect(
      hashDirectorySha256({
        workspaceRoot,
        inputPath: "dir",
        evidenceRef: "test:hash-dir-link"
      })
    ).rejects.toThrow(WorkspacePathSafetyError);
  });

  test("rejects empty directories", async () => {
    const { workspaceRoot } = await createWorkspaceRoot();
    await mkdir(join(workspaceRoot, "empty"), { recursive: true });

    await expect(
      hashDirectorySha256({
        workspaceRoot,
        inputPath: "empty",
        evidenceRef: "test:empty-dir"
      })
    ).rejects.toThrow(WorkspacePathSafetyError);
  });

  test("rejects path escape attempts before filesystem access", async () => {
    const { workspaceRoot } = await createWorkspaceRoot();
    await expect(
      hashFileSha256({
        workspaceRoot,
        inputPath: "../outside.txt",
        evidenceRef: "test:escape"
      })
    ).rejects.toThrow(WorkspacePathSafetyError);
  });
});
