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
const generic = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/valid/generic.json"), "utf8"));

function immutableReference(seed = "03"): Record<string, unknown> {
  const sha256 = seed.repeat(32);
  return {
    schema_version: "shud.git-status-capability.immutable-evidence-reference.v1",
    media_type: "application/json",
    sha256,
    byte_length: 128,
    immutable_identity: `sha256:${sha256}`,
    retention: { policy: "retain-until-change-archived-v1", minimum_days: 3650 },
    access: { scope: "repository-local", requires_network: false },
    offline_retrieval: {
      kind: "content-addressed-path-v1", path: `artifacts/sha256/${sha256}`, sha256, byte_length: 128
    }
  };
}

function paddedJson(value: unknown, bytes: number): Buffer {
  const serialized = Buffer.from(JSON.stringify(value));
  if (serialized.length > bytes) throw new Error("fixture exceeds requested byte size");
  return Buffer.concat([serialized, Buffer.alloc(bytes - serialized.length, 0x20)]);
}

function depthBoundaryJson(schemaVersion: string, depth: number): string {
  let padding: unknown = null;
  for (let current = 2; current < depth; current += 1) padding = [padding];
  return JSON.stringify({ schema_version: schemaVersion, padding });
}

function nodeBoundaryJson(schemaVersion: string, nodes: number): string {
  // Root + schema_version value + padding array are three parser nodes.
  return JSON.stringify({ schema_version: schemaVersion, padding: Array(nodes - 3).fill(null) });
}

function itemBoundaryJson(schemaVersion: string, items: number): string {
  // The root contributes the schema_version and padding keys; array elements do
  // not consume the strict parser's object-member item budget.
  return JSON.stringify({
    schema_version: schemaVersion,
    padding: Object.fromEntries(Array.from({ length: items - 2 }, (_, index) => [`k${index}`, null]))
  });
}

async function writeEvidence(root: string, relative: string, content: Uint8Array | string): Promise<string> {
  const absolute = join(root, "openspec/changes/m2-capability-observer-spike/evidence", ...relative.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

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
    await mkdir(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}/macos`), { recursive: true });
    await writeFile(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}/macos/result.md`), "# bounded evidence\n");
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
    const validRecords: Array<[string, unknown | string]> = [
      [`source/${digest}/record.json`, generic.source_input_record],
      [`platform/${digest}/macos/platform.json`, generic.platform_bundle],
      [`platform/${digest}/linux/platform.json`, generic.linux_platform_bundle],
      [`gates/${digest}/receipt.json`, immutableReference("04")],
      [`final/${digest}/final.json`, generic.final_bundle],
      [`final/${digest}/decision.json`, generic.decision],
      [`final/${digest}/summary.md`, "# bounded evidence\n"]
    ];
    const validRoot = await temporaryRepository();
    for (const [path, value] of validRecords) {
      await writeEvidence(validRoot, path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    }
    const before = await enumerateSourceCandidates(validRoot);
    expect(spawnSync("git", ["init", "-q"], { cwd: validRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: validRoot }).status).toBe(0);
    expect(() => validateGitCandidateSet(validRoot, before)).not.toThrow();

    const invalidCases: Array<[string, Uint8Array | string, boolean]> = [
      [`wrong/${digest}/result.json`, "{}\n", false],
      ["platform/not-a-digest/result.json", "{}\n", false],
      [`platform/${digest}/macos/observer.ts`, "export {};\n", false],
      [`platform/${digest}/macos/import.md`, "import x from 'source';\n", false],
      [`platform/${digest}/macos/binary.json`, new Uint8Array([0, 255, 0]), false],
      [`platform/${digest}/macos/unsupported.png`, "image", false],
      [`platform/${digest}/macos/executable.md`, "# evidence\n", true],
      [`platform/${digest}/macos/oversize.json`, new Uint8Array(INGESTION_LIMITS.platform_bundle.bytes + 1), false],
      [`source/${digest}/unknown.json`, '{"schema_version":"unknown.v1"}\n', false],
      [`source/${digest}/source-wrapper.json`, '{"schema_version":"wrapper.v1","source":"import x from \'covered\';"}\n', false],
      [`source/${digest}/base64-wrapper.json`, '{"schema_version":"wrapper.v1","content_base64":"aW1wb3J0IHg="}\n', false],
      [`source/${digest}/byte-array.json`, '{"schema_version":"wrapper.v1","bytes":[105,109,112,111,114,116]}\n', false],
      [`gates/${digest}/mutable-url.json`, '{"schema_version":"shud.git-status-capability.immutable-evidence-reference.v1","url":"https://mutable.invalid/latest"}\n', false]
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

  test("Markdown evidence admits bounded prose and text/json/console fences but rejects executable declarations", async () => {
    const digest = "05".repeat(32);
    const positive = [
      "Import results are summarized below.\nExport notes remain prose.\n",
      "```text\nbounded observation\n```\n",
      "```json\n{\"status\":\"ok\",\"count\":1}\n```\n",
      "```console\ncheck: pass\n```\n"
    ].join("\n");
    for (const tracked of [false, true]) {
      const root = await temporaryRepository();
      await writeEvidence(root, `final/${digest}/summary.md`, positive);
      const candidates = await enumerateSourceCandidates(root);
      if (tracked) {
        expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
        expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
        expect(() => validateGitCandidateSet(root, candidates), "tracked-positive").not.toThrow();
      }
    }
    const negatives = [
      "```ts\nconst hidden = true;\n```\n",
      "````ts\nconst hidden = true;\n````\n",
      "~~~js\nconst hidden = true;\n~~~\n",
      "```bash\necho hidden\n```\n",
      "```json\n{not-json}\n```\n",
      "import hidden from 'covered-source';\n",
      "import type { Hidden } from 'covered-source';\n",
      "import('covered-source');\n",
      "export const hidden = true;\n",
      "export async function hidden() {}\n",
      "```text\nexport const hidden = true;\n```\n",
      "```console\nimport hidden from 'covered-source';\n```\n",
      "```text\nconst hidden = true;\n```\n",
      "```console\nfunction hidden() {}\n```\n"
    ];
    for (const [index, content] of negatives.entries()) {
      for (const tracked of [false, true]) {
        const root = await temporaryRepository();
        await writeEvidence(root, `final/${digest}/invalid-${index}.md`, content);
        if (tracked) {
          expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
          expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
          const candidates = (await enumerateSourceCandidates(root).catch(() => []));
          expect(() => validateGitCandidateSet(root, candidates), `tracked-negative-${index}`).toThrow(ContractError);
        } else {
          await expect(enumerateSourceCandidates(root), `untracked-negative-${index}`).rejects.toBeInstanceOf(ContractError);
        }
      }
    }
  }, 30_000);

  test("closed evidence JSON schemas enforce their own byte, depth, node, and item limits after version discovery", async () => {
    const digest = "13".repeat(32);
    const cases = [
      ["source-input-record", `source/${digest}/record.json`, "shud.git-status-capability.source-input-record.v1", INGESTION_LIMITS.source_input_record, generic.source_input_record],
      ["platform-bundle", `platform/${digest}/macos/platform.json`, "shud.git-status-capability.platform-bundle.v1", INGESTION_LIMITS.platform_bundle, generic.platform_bundle],
      ["final-bundle", `final/${digest}/final.json`, "shud.git-status-capability.final-bundle.v1", INGESTION_LIMITS.final_bundle, generic.final_bundle],
      ["decision", `final/${digest}/decision.json`, "shud.git-status-capability.decision.v1", INGESTION_LIMITS.decision, generic.decision],
      ["immutable-reference", `gates/${digest}/reference.json`, "shud.git-status-capability.immutable-evidence-reference.v1",
        { bytes: 4096, depth: 6, nodes: 64, items: 32 }, immutableReference("13")]
    ] as const;
    const boundaries = [
      ["depth", depthBoundaryJson, "CONTRACT_JSON_DEPTH_LIMIT"],
      ["nodes", nodeBoundaryJson, "CONTRACT_JSON_NODE_LIMIT"],
      ["items", itemBoundaryJson, "CONTRACT_JSON_ITEM_LIMIT"]
    ] as const;

    const root = await temporaryRepository();
    for (const [kind, path, schemaVersion, limits, valid] of cases) {
      await writeEvidence(root, path, paddedJson(valid, limits.bytes));
      expect(await enumerateSourceCandidates(root), `${kind}:bytes:exact`).toBeInstanceOf(Array);
      await writeEvidence(root, path, paddedJson(valid, limits.bytes + 1));
      await expect(enumerateSourceCandidates(root), `${kind}:bytes:plus-one`)
        .rejects.toMatchObject({ code: "CONTRACT_BYTES_LIMIT" });
      await writeEvidence(root, path, `${JSON.stringify(valid)}\n`);
      for (const [axis, build, code] of boundaries) {
        const exact = build(schemaVersion, limits[axis]);
        await writeEvidence(root, path, exact);
        await expect(enumerateSourceCandidates(root), `${kind}:${axis}:exact`)
          .rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

        const plusOne = build(schemaVersion, limits[axis] + 1);
        await writeEvidence(root, path, plusOne);
        await expect(enumerateSourceCandidates(root), `${kind}:${axis}:plus-one`)
          .rejects.toMatchObject({ code });
        await writeEvidence(root, path, `${JSON.stringify(valid)}\n`);
      }
    }
  }, 120_000);

  test("evidence byte ceilings are isolated per digest and per platform subtree for tracked and untracked blobs", async () => {
    const digestA = "06".repeat(32);
    const digestB = "07".repeat(32);
    const platformLimit = INGESTION_LIMITS.platform_bundle.bytes;
    const finalLimit = INGESTION_LIMITS.final_bundle.bytes;

    for (const tracked of [false, true]) {
      const exact = await temporaryRepository();
      await writeEvidence(exact, `platform/${digestA}/macos/exact.md`, Buffer.alloc(platformLimit, 0x20));
      await writeEvidence(exact, `platform/${digestA}/linux/exact.md`, Buffer.alloc(platformLimit, 0x20));
      await writeEvidence(exact, `final/${digestA}/exact.md`, Buffer.alloc(finalLimit, 0x20));
      const exactCandidates = await enumerateSourceCandidates(exact);
      if (tracked) {
        expect(spawnSync("git", ["init", "-q"], { cwd: exact }).status).toBe(0);
        expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: exact }).status).toBe(0);
        expect(() => validateGitCandidateSet(exact, exactCandidates), "tracked-exact").not.toThrow();
      }

      const isolated = await temporaryRepository();
      await writeEvidence(isolated, `platform/${digestA}/macos/a.md`, Buffer.alloc(5 * 1024 * 1024, 0x20));
      await writeEvidence(isolated, `platform/${digestA}/linux/a.md`, Buffer.alloc(5 * 1024 * 1024, 0x20));
      await writeEvidence(isolated, `platform/${digestB}/macos/b.md`, Buffer.alloc(5 * 1024 * 1024, 0x20));
      await writeEvidence(isolated, `final/${digestA}/a.md`, Buffer.alloc(12 * 1024 * 1024, 0x20));
      await writeEvidence(isolated, `final/${digestB}/b.md`, Buffer.alloc(12 * 1024 * 1024, 0x20));
      const isolatedCandidates = await enumerateSourceCandidates(isolated);
      if (tracked) {
        expect(spawnSync("git", ["init", "-q"], { cwd: isolated }).status).toBe(0);
        expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: isolated }).status).toBe(0);
        expect(() => validateGitCandidateSet(isolated, isolatedCandidates), "tracked-isolated").not.toThrow();
      }
    }

    for (const [path, limit] of [
      [`platform/${digestA}/macos/plus-one.md`, platformLimit],
      [`platform/${digestA}/linux/plus-one.md`, platformLimit],
      [`final/${digestA}/plus-one.md`, finalLimit]
    ] as const) {
      const untracked = await temporaryRepository();
      await writeEvidence(untracked, path, paddedJson(immutableReference("10"), limit + 1));
      await expect(enumerateSourceCandidates(untracked), `untracked:${path}`).rejects.toMatchObject({ code: "CONTRACT_BYTES_LIMIT" });

      const staged = await temporaryRepository();
      const stagedPath = await writeEvidence(staged, path, paddedJson(immutableReference("11"), limit + 1));
      expect(spawnSync("git", ["init", "-q"], { cwd: staged }).status).toBe(0);
      expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: staged }).status).toBe(0);
      await writeFile(stagedPath, "bounded legal worktree evidence\n");
      const candidates = await enumerateSourceCandidates(staged);
      expect(() => validateGitCandidateSet(staged, candidates), `tracked:${path}`).toThrow(ContractError);
    }
  }, 120_000);

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
