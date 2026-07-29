import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { CONTRACT_METADATA, SOURCE_MANIFEST, SYNTHETIC_FRAME, SYNTHETIC_SIDECAR } from "../lib/constants";
import { checkCurrentSourceOracleForTest } from "../lib/current-source";
import { capture, captureAfterAdmission, contractsRoot, failure, success } from "./helpers";

const roots: string[] = [];
const mandatory = [CONTRACT_METADATA, SYNTHETIC_FRAME, SYNTHETIC_SIDECAR] as const;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shud-current-oracle-"));
  roots.push(root);
  for (const path of [SOURCE_MANIFEST, ...mandatory]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(contractsRoot, relative("spikes/git-status-capability/contracts", path)), join(root, path));
  }
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  return root;
}

async function current(root: string) {
  return await capture(["--repository-root", root, "--manifest", SOURCE_MANIFEST, "--check-current"]);
}

async function rewriteManifest(root: string, paths: readonly string[], lineEnding = "\n"): Promise<void> {
  await writeFile(join(root, SOURCE_MANIFEST), `${paths.join(lineEnding)}${lineEnding}`);
}

async function treeIdentity(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      const stat = await lstat(absolute);
      if (entry.isDirectory()) {
        result[path] = `directory:${stat.mode}`;
        await walk(absolute);
      } else if (entry.isFile()) {
        result[path] = `file:${stat.mode}:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`;
      } else {
        result[path] = `other:${stat.mode}:${entry.isSymbolicLink() ? await readFile(absolute).catch(() => Buffer.from("symlink")) : ""}`;
      }
    }
  }
  await walk(root);
  return result;
}

function status(root: string): string {
  const result = Bun.spawnSync(["git", "status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root, stdout: "pipe", stderr: "pipe"
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("committed source oracle current check", () => {
  test("emits the exact deterministic receipt twice without writes, child processes, or status drift", async () => {
    const root = await fixture();
    const beforeTree = await treeIdentity(root);
    const beforeStatus = status(root);
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
    expect(await treeIdentity(root)).toEqual(beforeTree);
    expect(status(root)).toBe(beforeStatus);
  });

  test("accepts declared future source paths without discovering the filesystem or a tracked set", async () => {
    const root = await fixture();
    const paths = (await readFile(join(root, SOURCE_MANIFEST), "utf8")).trimEnd().split("\n");
    paths.push("spikes/git-status-capability/future/not-yet-present.json");
    paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    await rewriteManifest(root, paths);
    expect(await current(root)).toEqual({ exit: 0, stdout: success("current_source_authority"), stderr: "" });
  });

  test("rejects missing, duplicate, unsorted, unsafe, non-LF, and CRLF manifest declarations", async () => {
    const original = (await readFile(join(await fixture(), SOURCE_MANIFEST), "utf8")).trimEnd().split("\n");
    const cases: Array<{ paths: string[]; ending?: string }> = [
      { paths: original.filter((path) => path !== CONTRACT_METADATA) },
      { paths: [...original, original.at(-1)!] },
      { paths: [...original].reverse() },
      { paths: [...original.slice(0, -1), "../unsafe"] },
      { paths: original, ending: "\r\n" }
    ];
    for (const entry of cases) {
      const root = await fixture();
      await rewriteManifest(root, entry.paths, entry.ending);
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
    const root = await fixture();
    await writeFile(join(root, SOURCE_MANIFEST), original.join("\n"));
    expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    const invalidUtf8Root = await fixture();
    await writeFile(join(invalidUtf8Root, SOURCE_MANIFEST), Buffer.from([0xff, 0x0a]));
    expect(await current(invalidUtf8Root)).toEqual({
      exit: 2, stdout: "", stderr: failure("CONTRACT_UTF8_INVALID")
    });
  });

  test("rejects a missing, symlink, or nonregular manifest and every mandatory oracle file", async () => {
    for (const relativePath of [SOURCE_MANIFEST, ...mandatory]) {
      for (const kind of ["missing", "symlink", "directory"] as const) {
        const root = await fixture();
        const path = join(root, relativePath);
        await rm(path);
        if (kind === "symlink") await symlink(join(root, SYNTHETIC_SIDECAR), path);
        if (kind === "directory") await mkdir(path);
        expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      }
    }
  });

  test("rejects an external same-content symlink at any declared file ancestor", async () => {
    for (const relativePath of [SOURCE_MANIFEST, ...mandatory]) {
      const root = await fixture();
      const ancestor = dirname(join(root, relativePath));
      const external = await mkdtemp(join(tmpdir(), "shud-current-oracle-external-"));
      roots.push(external);
      const copy = join(external, "same-content");
      await cp(ancestor, copy, { recursive: true });
      await rm(ancestor, { recursive: true });
      await symlink(copy, ancestor);
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });

  test("rejects a repository-root upper symlink alias without writes", async () => {
    const root = await fixture();
    const before = await treeIdentity(root);
    const aliasContainer = await mkdtemp(join(tmpdir(), "shud-current-oracle-alias-"));
    roots.push(aliasContainer);
    const alias = join(aliasContainer, "upper");
    await symlink(dirname(root), alias);
    expect(await current(join(alias, basename(root)))).toEqual({
      exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID")
    });
    expect(await treeIdentity(root)).toEqual(before);
  });

  test("rejects repository-root ancestor replacement after admission for every retained file", async () => {
    for (const relativePath of [SOURCE_MANIFEST, ...mandatory]) {
      const root = await fixture();
      const admittedRoot = `${root}.admitted`;
      let replaced = false;
      const result = await captureAfterAdmission(
        ["--repository-root", root, "--manifest", SOURCE_MANIFEST, "--check-current"],
        async (absolutePath) => {
          if (absolutePath !== join(root, relativePath) || replaced) return;
          replaced = true;
          await rename(root, admittedRoot);
          await symlink(admittedRoot, root);
        }
      );
      roots.push(admittedRoot);
      expect(replaced).toBe(true);
      expect(result).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
      expect(await readFile(join(admittedRoot, relativePath))).toEqual(await readFile(join(root, relativePath)));
    }
  });

  test("rejects frozen metadata, frame, and sidecar mutations", async () => {
    for (const path of mandatory) {
      const root = await fixture();
      const absolute = join(root, path);
      const bytes = Buffer.from(await readFile(absolute));
      if (path === CONTRACT_METADATA) {
        const value = JSON.parse(bytes.toString("utf8"));
        value.synthetic_oracle.entry_count = 4;
        await writeFile(absolute, `${JSON.stringify(value)}\n`);
      } else {
        bytes[Math.floor(bytes.length / 2)]! ^= 1;
        await writeFile(absolute, bytes);
      }
      expect(await current(root)).toEqual({ exit: 2, stdout: "", stderr: failure("CONTRACT_SCHEMA_INVALID") });
    }
  });

  test("descriptor admission rejects symlink and foreign-file replacement before read", async () => {
    for (const replacement of ["symlink", "regular"] as const) {
      const root = await fixture();
      const target = join(root, CONTRACT_METADATA);
      const admitted = `${target}.admitted`;
      let replaced = false;
      await expect(checkCurrentSourceOracleForTest(root, SOURCE_MANIFEST, async (absolutePath) => {
        if (absolutePath !== target || replaced) return;
        replaced = true;
        await rename(target, admitted);
        if (replacement === "symlink") await symlink(admitted, target);
        else await writeFile(target, await readFile(admitted));
      })).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
      expect(replaced).toBe(true);
    }
  });
});
