import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkCurrent } from "../lib/checker";
import { ContractError } from "../lib/ingestion";
import { enumerateSourceCandidates, validateGitCandidateSet, validateManifest } from "../lib/schema";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const manifestRelative = "spikes/git-status-capability/contracts/source-input-v1.paths";
const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shud-contract-manifest-"));
  temporaryRoots.push(root);
  await cp(join(repositoryRoot, "spikes"), join(root, "spikes"), { recursive: true });
  await cp(
    join(repositoryRoot, "openspec", "changes", "m2-capability-observer-spike"),
    join(root, "openspec", "changes", "m2-capability-observer-spike"),
    { recursive: true }
  );
  return root;
}

async function rewriteManifest(root: string, mutate: (paths: string[]) => string[]): Promise<void> {
  const path = join(root, manifestRelative);
  const paths = (await readFile(path, "utf8")).trimEnd().split("\n");
  await writeFile(path, `${mutate(paths).join("\n")}\n`);
}

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const stat = await lstat(absolute);
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        result[relative(root, absolute)] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${digest}`;
      }
    }
  }
  await walk(root);
  return result;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("source-input-v1 current-set authority", () => {
  test("current manifest is byte-sorted and exactly equals the current candidate set", async () => {
    const candidates = await enumerateSourceCandidates(repositoryRoot);
    const manifest = (await readFile(join(repositoryRoot, manifestRelative), "utf8")).trimEnd().split("\n");
    expect(manifest).toEqual(candidates);
    expect(await validateManifest(repositoryRoot, join(repositoryRoot, manifestRelative))).toBe(candidates.length);
  });

  test("missing, extra/future, duplicate, unsorted, and candidate drift fail closed", async () => {
    const mutations: Array<(paths: string[]) => string[]> = [
      (paths) => paths.slice(1),
      (paths) => [...paths, "spikes/git-status-capability/future.ts"],
      (paths) => [...paths, paths[0]!],
      (paths) => [paths[1]!, paths[0]!, ...paths.slice(2)]
    ];
    for (const mutate of mutations) {
      const root = await temporaryRepository();
      await rewriteManifest(root, mutate);
      await expect(validateManifest(root, join(root, manifestRelative))).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    }
    const root = await temporaryRepository();
    await writeFile(join(root, "spikes", "git-status-capability", "unexpected.ts"), "export {};\n");
    await expect(validateManifest(root, join(root, manifestRelative))).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
  });

  test("unsafe absolute, escape, dot, backslash, empty, CRLF, and symlink paths fail closed", async () => {
    const unsafe = [
      "/absolute", "../escape", "spikes/./dot", "spikes\\backslash", "", "spikes//empty"
    ];
    for (const value of unsafe) {
      const root = await temporaryRepository();
      await rewriteManifest(root, (paths) => [value, ...paths.slice(1)]);
      await expect(validateManifest(root, join(root, manifestRelative))).rejects.toBeInstanceOf(ContractError);
    }
    const crlfRoot = await temporaryRepository();
    const path = join(crlfRoot, manifestRelative);
    await writeFile(path, (await readFile(path, "utf8")).replaceAll("\n", "\r\n"));
    await expect(validateManifest(crlfRoot, path)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    const symlinkRoot = await temporaryRepository();
    await symlink("contract-v1.json", join(symlinkRoot, "spikes", "git-status-capability", "contracts", "linked.json"));
    await expect(enumerateSourceCandidates(symlinkRoot)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
  });

  test("once the spike is tracked, untracked candidate drift fails closed", async () => {
    const root = await temporaryRepository();
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
    const tracked = await enumerateSourceCandidates(root);
    expect(() => validateGitCandidateSet(root, tracked)).not.toThrow();
    await writeFile(join(root, "spikes", "git-status-capability", "untracked.ts"), "export {};\n");
    const drifted = await enumerateSourceCandidates(root);
    expect(() => validateGitCandidateSet(root, drifted)).toThrow(ContractError);
  });

  test("the exact current checker returns one complete receipt and writes zero files", async () => {
    const before = await inventory(repositoryRoot);
    const receipt = await checkCurrent(repositoryRoot, manifestRelative);
    const after = await inventory(repositoryRoot);
    expect(receipt).toEqual({
      schema_version: "shud.git-status-capability.contract-check-receipt.v1", status: "ok", catalog_rows: 174,
      floor_mappings: 25, fixture_owners: 174, native_owners: 174, source_entries: Object.keys(before).filter((path) => path.startsWith("spikes/git-status-capability/") || path.startsWith("openspec/changes/m2-capability-observer-spike/")).length,
      rust_version: "1.88.0", git_oracle_version: "2.49.0"
    });
    expect(after).toEqual(before);
  });
});
