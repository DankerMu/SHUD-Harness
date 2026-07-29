import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SOURCE_MANIFEST } from "../lib/constants";
import { capture, contractsRoot, failure, success } from "./helpers";

const projectRoot = join(contractsRoot, "..", "..", "..");
const roots: string[] = [];

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shud-current-source-"));
  roots.push(root);
  await mkdir(join(root, "spikes", "git-status-capability"), { recursive: true });
  await cp(contractsRoot, join(root, "spikes", "git-status-capability", "contracts"), { recursive: true });
  await cp(
    join(projectRoot, "openspec", "changes", "m2-capability-observer-spike"),
    join(root, "openspec", "changes", "m2-capability-observer-spike"),
    { recursive: true }
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"]);
  return root;
}

async function linkedRepository(): Promise<{ main: string; linked: string; gitDir: string }> {
  const main = await repository();
  git(main, ["-c", "user.name=SHUD Contract Test", "-c", "user.email=contract@example.invalid", "commit", "-qm", "initial"]);
  const container = await mkdtemp(join(tmpdir(), "shud-linked-container-"));
  roots.push(container);
  const linked = join(container, "linked");
  git(main, ["worktree", "add", "-q", "-b", `contract-linked-${Date.now()}-${Math.random()}`, linked]);
  const gitfile = await readFile(join(linked, ".git"), "utf8");
  const match = /^gitdir: ([^\r\n]+)\n$/.exec(gitfile);
  if (!match) throw new Error("git did not create an ordinary linked-worktree gitfile");
  return { main, linked, gitDir: match[1]! };
}

async function rewriteManifest(root: string, mutate: (paths: string[]) => string[]): Promise<void> {
  const path = join(root, SOURCE_MANIFEST);
  const entries = (await readFile(path, "utf8")).trimEnd().split("\n");
  await writeFile(path, `${mutate(entries).join("\n")}\n`);
  git(root, ["add", SOURCE_MANIFEST]);
}

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      if (entry.isDirectory()) {
        result[path] = "directory";
        await walk(absolute);
      }
      else {
        const stat = await lstat(absolute);
        const bytes = entry.isFile() ? await readFile(absolute) : Buffer.from("symlink");
        result[path] = `${stat.mode}:${stat.size}:${createHash("sha256").update(bytes).digest("hex")}`;
      }
    }
  }
  await walk(root);
  return result;
}

async function current(root: string) {
  return await capture(["--repository-root", root, "--manifest", SOURCE_MANIFEST, "--check-current"]);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("current source authority", () => {
  test("a valid temporary tracked repository succeeds twice with exact receipts, no writes, and no child launch", async () => {
    const root = await repository();
    const beforeStatus = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const beforeInventory = await inventory(root);
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let launches = 0;
    try {
      (Bun as any).spawn = () => { launches += 1; throw new Error("child process forbidden"); };
      (Bun as any).spawnSync = () => { launches += 1; throw new Error("child process forbidden"); };
      const expected = { exit: 0, stdout: success("current_source_authority"), stderr: "" };
      expect(await current(root)).toEqual(expected);
      expect(await current(root)).toEqual(expected);
    } finally {
      (Bun as any).spawn = originalSpawn;
      (Bun as any).spawnSync = originalSpawnSync;
    }
    expect(launches).toBe(0);
    expect(await inventory(root)).toEqual(beforeInventory);
    expect(git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
  });

  test("checker implementation has no process, Git command, network, production import, or write seam", async () => {
    const implementation = [
      join(contractsRoot, "check.ts"),
      ...((await readdir(join(contractsRoot, "lib"))).map((name) => join(contractsRoot, "lib", name)))
    ];
    const forbidden = ["node:child_process", "Bun.spawn", "spawnSync(", "execFile(", "execSync(", "fetch(", "node:http", "node:https", "node:net", "writeFile(", "appendFile(", "mkdir("];
    for (const path of implementation) {
      const source = await readFile(path, "utf8");
      for (const token of forbidden) expect(source).not.toContain(token);
      expect(source).not.toContain("packages/");
      expect(source).not.toContain("verify.sh ");
    }
  });

  test("ordinary linked worktree uses its per-worktree index and common object format", async () => {
    const { main, linked, gitDir } = await linkedRepository();
    const mainOnly = join(main, "spikes", "git-status-capability", "contracts", "contract-v1.json");
    await writeFile(mainOnly, `${await readFile(mainOnly, "utf8")} `);
    git(main, ["add", "spikes/git-status-capability/contracts/contract-v1.json"]);
    await writeFile(join(gitDir, "config"), "[extensions]\n\tobjectFormat = sha256\n");
    expect(await current(linked)).toEqual({ exit: 0, stdout: success("current_source_authority"), stderr: "" });
  });

  test("malformed, unsafe, and oversized linked-worktree gitfiles fail closed", async () => {
    const cases: Array<[Uint8Array | string, string]> = [
      ["gitdir: ../relative\n", "CONTRACT_SCHEMA_INVALID"],
      ["gitdir: /tmp/../escape\n", "CONTRACT_SCHEMA_INVALID"],
      ["gitdir: /tmp/missing\r\n", "CONTRACT_SCHEMA_INVALID"],
      ["gitdir: /tmp/missing\nextra\n", "CONTRACT_SCHEMA_INVALID"],
      [Buffer.from("gitdir: /tmp/missing\0suffix\n"), "CONTRACT_SCHEMA_INVALID"],
      [`gitdir: /${"a".repeat(4_096)}\n`, "CONTRACT_BYTES_LIMIT"]
    ];
    for (const [gitfile, code] of cases) {
      const { linked } = await linkedRepository();
      await writeFile(join(linked, ".git"), gitfile);
      expect(await current(linked)).toEqual({ exit: 2, stdout: "", stderr: failure(code) });
    }
  });

  test("linked-worktree gitfile cannot borrow another worktree's metadata directory", async () => {
    const { main, linked } = await linkedRepository();
    const container = await mkdtemp(join(tmpdir(), "shud-linked-borrowed-container-"));
    roots.push(container);
    const borrowed = join(container, "borrowed");
    git(main, ["worktree", "add", "-q", "-b", `contract-borrowed-${Date.now()}-${Math.random()}`, borrowed]);
    const borrowedGitfile = await readFile(join(borrowed, ".git"), "utf8");
    await writeFile(join(linked, ".git"), borrowedGitfile);
    expect(await current(linked)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
  });

  test("manifest missing, extra/future, duplicate, unsafe, and tracked-set drift fail at the public seam", async () => {
    const mutations: Array<(paths: string[]) => string[]> = [
      (paths) => paths.slice(1),
      (paths) => [...paths, "spikes/git-status-capability/future.ts"].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
      (paths) => [...paths, paths[0]!],
      (paths) => ["../escape", ...paths.slice(1)]
    ];
    for (const mutate of mutations) {
      const root = await repository();
      await rewriteManifest(root, mutate);
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
    const root = await repository();
    const extra = join(root, "spikes", "git-status-capability", "future.ts");
    await writeFile(extra, "export {};\n");
    git(root, ["add", "spikes/git-status-capability/future.ts"]);
    expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
  });

  test("untracked, symlink, non-regular, and mode drift inputs fail closed", async () => {
    const untracked = await repository();
    await writeFile(join(untracked, "spikes", "git-status-capability", "untracked.ts"), "export {};\n");
    expect(await current(untracked)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });

    const symlinked = await repository();
    const symlinkPath = join(symlinked, "spikes", "git-status-capability", "contracts", "contract-v1.json");
    await unlink(symlinkPath);
    await symlink("fixtures/valid/source-identity-projection-v1.json", symlinkPath);
    expect(await current(symlinked)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });

    const nonRegular = await repository();
    const directoryPath = join(nonRegular, "spikes", "git-status-capability", "contracts", "contract-v1.json");
    await unlink(directoryPath);
    await mkdir(directoryPath);
    expect(await current(nonRegular)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });

    const mode = await repository();
    await chmod(join(mode, "spikes", "git-status-capability", "contracts", "contract-v1.json"), 0o755);
    expect(await current(mode)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
  });

  test("synchronized truncated and same-length synthetic frame+sidecar attacks fail through --check-current", async () => {
    for (const mutate of [
      (frame: Buffer) => frame.subarray(0, 58),
      (frame: Buffer) => { const changed = Buffer.from(frame); changed[changed.length - 1] ^= 1; return changed; }
    ]) {
      const root = await repository();
      const framePath = join(root, "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.frame");
      const sidecarPath = join(root, "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.sha256");
      const changed = mutate(await readFile(framePath));
      await writeFile(framePath, changed);
      await writeFile(sidecarPath, `${createHash("sha256").update(changed).digest("hex")}\n`);
      git(root, ["add", "spikes/git-status-capability/contracts/goldens"]);
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });

  test("unknown or missing metadata fields and exact-oracle drift fail without a success receipt", async () => {
    for (const mutate of [(value: any) => { value.future = true; }, (value: any) => { delete value.synthetic_oracle.entry_count; }]) {
      const root = await repository();
      const path = join(root, "spikes/git-status-capability/contracts/contract-v1.json");
      const value = JSON.parse(await readFile(path, "utf8"));
      mutate(value);
      await writeFile(path, JSON.stringify(value));
      git(root, ["add", "spikes/git-status-capability/contracts/contract-v1.json"]);
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });
});
