import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateSourceCandidates } from "../lib/schema";
import { errorReceipt, invoke, repositoryRoot } from "./authority-test-helpers";

const manifestRelative = "spikes/git-status-capability/contracts/source-input-v1.paths";
const frameRelative = "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.frame";
const digestRelative = "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.sha256";
const checkPath = join(repositoryRoot, "spikes", "git-status-capability", "contracts", "check.ts");

async function temporaryCurrentRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shud-current-files-"));
  await mkdir(join(root, "spikes"), { recursive: true });
  await cp(
    join(repositoryRoot, "spikes", "git-status-capability"),
    join(root, "spikes", "git-status-capability"),
    { recursive: true }
  );
  await cp(
    join(repositoryRoot, "openspec", "changes", "m2-capability-observer-spike"),
    join(root, "openspec", "changes", "m2-capability-observer-spike"),
    { recursive: true }
  );
  await writeFile(join(root, manifestRelative), `${(await enumerateSourceCandidates(root)).join("\n")}\n`);
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
  return root;
}

async function invokeCurrent(root: string) {
  return invoke(["--repository-root", root, "--manifest", manifestRelative, "--check-current"]);
}

async function padManifestToExactBound(root: string, bound: number): Promise<void> {
  const original = await enumerateSourceCandidates(root);
  const originalBytes = Buffer.byteLength(`${original.join("\n")}\n`);
  const remaining = bound - originalBytes;
  const entryCount = Math.ceil(remaining / 220);
  const baseContribution = Math.floor(remaining / entryCount);
  const largerEntries = remaining % entryCount;
  const paddingRoot = join(root, "spikes", "git-status-capability", "padding");
  await mkdir(paddingRoot, { recursive: true });
  for (let index = 0; index < entryCount; index += 1) {
    const contribution = baseContribution + (index < largerEntries ? 1 : 0);
    const prefix = `spikes/git-status-capability/padding/${String(index).padStart(4, "0")}-`;
    const pathLength = contribution - 1;
    expect(pathLength).toBeGreaterThan(prefix.length);
    await writeFile(join(root, `${prefix}${"x".repeat(pathLength - prefix.length)}`), "");
  }
  const candidates = await enumerateSourceCandidates(root);
  const manifest = `${candidates.join("\n")}\n`;
  expect(Buffer.byteLength(manifest)).toBe(bound);
  await writeFile(join(root, manifestRelative), manifest);
  expect(spawnSync("git", ["add", "spikes/git-status-capability/padding", manifestRelative], { cwd: root }).status).toBe(0);
}

function invokeCurrentWithTimeout(root: string) {
  return spawnSync(process.execPath, [
    checkPath, "--repository-root", root, "--manifest", manifestRelative, "--check-current"
  ], { cwd: root, encoding: "utf8", timeout: 2_000 });
}

async function replaceWithKind(root: string, relativePath: string, kind: "symlink" | "directory" | "fifo"): Promise<void> {
  const path = join(root, relativePath);
  const target = join(root, `.target-${relativePath.replaceAll("/", "-")}`);
  await rename(path, target);
  if (kind === "symlink") await symlink(target, path);
  if (kind === "directory") await mkdir(path);
  if (kind === "fifo") expect(spawnSync("mkfifo", [path]).status).toBe(0);
}

describe("current checker bounded no-follow authority files", () => {
  test("the regular manifest and both exact synthetic golden files succeed", async () => {
    const root = await temporaryCurrentRepository();
    try {
      const result = await invokeCurrent(root);
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("manifest bound plus one fails with only the stable bytes-limit receipt", async () => {
    const root = await temporaryCurrentRepository();
    try {
      await writeFile(join(root, manifestRelative), Buffer.alloc(256 * 1024 + 1, 0x61));
      expect(await invokeCurrent(root)).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an otherwise valid manifest succeeds at the inclusive byte bound", async () => {
    const root = await temporaryCurrentRepository();
    try {
      await padManifestToExactBound(root, 256 * 1024);
      const result = await invokeCurrent(root);
      expect(result.exit).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("each authority file rejects symlink, directory, and FIFO without blocking or partial output", async () => {
    for (const relativePath of [manifestRelative, frameRelative, digestRelative]) {
      for (const kind of ["symlink", "directory", "fifo"] as const) {
        const root = await temporaryCurrentRepository();
        try {
          await replaceWithKind(root, relativePath, kind);
          const result = invokeCurrentWithTimeout(root);
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(errorReceipt("CONTRACT_SCHEMA_INVALID"));
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);

  test("synthetic frame and digest bound plus one fail before content acceptance", async () => {
    const frameRoot = await temporaryCurrentRepository();
    try {
      const framePath = join(frameRoot, frameRelative);
      const digestPath = join(frameRoot, digestRelative);
      const frame = Buffer.concat([await readFile(framePath), Buffer.from([0])]);
      await writeFile(framePath, frame);
      await writeFile(digestPath, `${createHash("sha256").update(frame).digest("hex")}\n`);
      expect(await invokeCurrent(frameRoot)).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT") });
    } finally {
      await rm(frameRoot, { recursive: true, force: true });
    }

    const digestRoot = await temporaryCurrentRepository();
    try {
      await writeFile(join(digestRoot, digestRelative), `${await readFile(join(digestRoot, digestRelative), "utf8")} `);
      expect(await invokeCurrent(digestRoot)).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT") });
    } finally {
      await rm(digestRoot, { recursive: true, force: true });
    }
  });

  test("truncated and malformed synthetic digests fail with one stable schema receipt", async () => {
    for (const literal of [`${"0".repeat(63)}\n`, `${"g".repeat(64)}\n`]) {
      const root = await temporaryCurrentRepository();
      try {
        await writeFile(join(root, digestRelative), literal);
        expect(await invokeCurrent(root)).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_SCHEMA_INVALID") });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("synchronized oversized frame and digest are still rejected with no partial success", async () => {
    const root = await temporaryCurrentRepository();
    try {
      const frame = Buffer.alloc(152 + 64, 0x61);
      await writeFile(join(root, frameRelative), frame);
      await writeFile(join(root, digestRelative), `${createHash("sha256").update(frame).digest("hex")}\n`);
      expect(await invokeCurrent(root)).toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
