import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCurrent } from "../lib/checker";
import { INGESTION_LIMITS } from "../lib/frozen";
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
  for (const path of await enumerateSourceCandidates(root)) {
    const absolute = join(root, ...path.split("/"));
    const stat = await lstat(absolute);
    const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
    result[path] = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${digest}`;
  }
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

  test("the fixed workflow participates only when present and canonical evidence never changes the set", async () => {
    const root = await temporaryRepository();
    const before = await enumerateSourceCandidates(root);
    const digest = "01".repeat(32);
    await mkdir(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}`), { recursive: true });
    await writeFile(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}/result.json`), "{}\n");
    expect(await enumerateSourceCandidates(root)).toEqual(before);
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/git-status-capability-spike.yml"), "name: spike\n");
    const withWorkflow = await enumerateSourceCandidates(root);
    expect(withWorkflow).toEqual([...before, ".github/workflows/git-status-capability-spike.yml"].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike", ".github/workflows/git-status-capability-spike.yml"], { cwd: root }).status).toBe(0);
    expect(() => validateGitCandidateSet(root, withWorkflow)).not.toThrow();
  });

  test("evidence exclusion is a closed lane/digest/mode/content classifier for tracked and untracked files", async () => {
    const digest = "02".repeat(32);
    const validPaths = [
      `source/${digest}/record.json`, `platform/${digest}/summary.md`,
      `gates/${digest}/receipt.json`, `final/${digest}/decision.md`
    ];
    const validRoot = await temporaryRepository();
    const evidenceRoot = join(validRoot, "openspec/changes/m2-capability-observer-spike/evidence");
    for (const path of validPaths) {
      await mkdir(join(evidenceRoot, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(evidenceRoot, ...path.split("/")), path.endsWith(".json") ? "{}\n" : "# bounded evidence\n");
    }
    const before = await enumerateSourceCandidates(validRoot);
    expect(spawnSync("git", ["init", "-q"], { cwd: validRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: validRoot }).status).toBe(0);
    expect(() => validateGitCandidateSet(validRoot, before)).not.toThrow();

    const invalidCases: Array<[string, Uint8Array | string, boolean]> = [
      [`wrong/${digest}/result.json`, "{}\n", false],
      ["platform/not-a-digest/result.json", "{}\n", false],
      [`platform/${digest}/observer.ts`, "export {};\n", false],
      [`platform/${digest}/import.md`, "import x from 'source';\n", false],
      [`platform/${digest}/binary.json`, new Uint8Array([0, 255, 0]), false],
      [`platform/${digest}/unsupported.png`, "image", false],
      [`platform/${digest}/executable.md`, "# evidence\n", true],
      [`platform/${digest}/oversize.json`, new Uint8Array(INGESTION_LIMITS.platform_bundle.bytes + 1), false]
    ];
    for (const [path, content, executable] of invalidCases) {
      const root = await temporaryRepository();
      const absolute = join(root, "openspec/changes/m2-capability-observer-spike/evidence", ...path.split("/"));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, content);
      if (executable) expect(spawnSync("chmod", ["755", absolute]).status).toBe(0);
      await expect(enumerateSourceCandidates(root), path).rejects.toBeInstanceOf(ContractError);
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
      await expect(enumerateSourceCandidates(root), `tracked:${path}`).rejects.toBeInstanceOf(ContractError);
    }
    const symlinkRoot = await temporaryRepository();
    const symlinkDirectory = join(symlinkRoot, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}`);
    await mkdir(symlinkDirectory, { recursive: true });
    await symlink("../../../../proposal.md", join(symlinkDirectory, "linked.md"));
    await expect(enumerateSourceCandidates(symlinkRoot)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    expect(spawnSync("git", ["init", "-q"], { cwd: symlinkRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: symlinkRoot }).status).toBe(0);
    await expect(enumerateSourceCandidates(symlinkRoot)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

    const stagedRoot = await temporaryRepository();
    const stagedDirectory = join(stagedRoot, `openspec/changes/m2-capability-observer-spike/evidence/gates/${digest}`);
    const stagedPath = join(stagedDirectory, "receipt.md");
    await mkdir(stagedDirectory, { recursive: true });
    await writeFile(stagedPath, "import hidden from 'covered-source';\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: stagedRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: stagedRoot }).status).toBe(0);
    await writeFile(stagedPath, "# legal worktree evidence\n");
    const stagedCandidates = await enumerateSourceCandidates(stagedRoot);
    expect(() => validateGitCandidateSet(stagedRoot, stagedCandidates), "staged-invalid/worktree-legal").toThrow(ContractError);
  });

  test("the exact current checker returns one complete receipt and writes zero files", async () => {
    const before = await inventory(repositoryRoot);
    const statusBefore = spawnSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repositoryRoot, encoding: "buffer" }).stdout;
    const receipt = await checkCurrent(repositoryRoot, manifestRelative);
    const after = await inventory(repositoryRoot);
    const statusAfter = spawnSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repositoryRoot, encoding: "buffer" }).stdout;
    expect(receipt).toEqual({
      schema_version: "shud.git-status-capability.contract-check-receipt.v1", status: "ok", catalog_rows: 174,
      floor_mappings: 25, fixture_owners: 174, native_owners: 174, source_entries: (await enumerateSourceCandidates(repositoryRoot)).length,
      rust_version: "1.88.0", git_oracle_version: "2.49.0"
    });
    expect(after).toEqual(before);
    expect(statusAfter).toEqual(statusBefore);
  }, 15_000);
});
