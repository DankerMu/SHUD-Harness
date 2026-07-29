import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { INGESTION_LIMITS } from "../lib/frozen";
import { ContractError, canonicalReceipt } from "../lib/ingestion";
import { validateCargoManifest } from "../lib/cargo-manifest";
import { runCheck } from "../lib/checker";
import { invokeAuthority, loadAuthority, repositoryRoot } from "./authority-test-helpers";

const temporaryRoots: string[] = [];
const encoder = new TextEncoder();
const errorReceipt = (code: string) => canonicalReceipt({
  schema_version: "shud.git-status-capability.contract-error.v1", status: "error", code
});

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  temporaryRoots.push(root);
  return root;
}

async function invokeAuthorityBytes(bytes: Uint8Array) {
  const root = await temporaryRoot("shud-nested-authority-");
  const input = join(root, "authority.json");
  await writeFile(input, bytes);
  let stdout = "";
  let stderr = "";
  const exit = await runCheck(["--input", input, "--kind", "authority_set", "--repository-root", repositoryRoot], {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }
  });
  return { exit, stdout, stderr };
}

function withRawSourceRecord(authority: Record<string, any>, sourceRecord: string): Uint8Array {
  const canonical = JSON.stringify(authority);
  const canonicalSource = JSON.stringify(authority.source_record);
  const offset = canonical.indexOf(canonicalSource);
  if (offset < 0) throw new Error("source record was not found in authority fixture");
  return encoder.encode(`${canonical.slice(0, offset)}${sourceRecord}${canonical.slice(offset + canonicalSource.length)}`);
}

function padObjectToBytes(value: Record<string, any>, bytes: number): string {
  const canonical = JSON.stringify(value);
  const padding = bytes - Buffer.byteLength(canonical);
  if (padding < 0) throw new Error("fixture exceeds requested raw-source bound");
  return `${canonical.slice(0, -1)}${" ".repeat(padding)}}`;
}

function structuralCounts(value: unknown): { nodes: number; items: number } {
  if (Array.isArray(value)) {
    const nested = value.map(structuralCounts);
    return { nodes: 1 + nested.reduce((sum, item) => sum + item.nodes, 0), items: value.length + nested.reduce((sum, item) => sum + item.items, 0) };
  }
  if (typeof value === "object" && value !== null) {
    const nested = Object.values(value).map(structuralCounts);
    return { nodes: 1 + nested.reduce((sum, item) => sum + item.nodes, 0), items: nested.length + nested.reduce((sum, item) => sum + item.items, 0) };
  }
  return { nodes: 1, items: 0 };
}

function sourceWithProbe(source: Record<string, any>, probe: string): string {
  const canonical = JSON.stringify(source);
  return `${canonical.slice(0, -1)},"round3_probe":${probe}}`;
}

function authorityWithProbe(authority: Record<string, any>, probe: string): Uint8Array {
  const canonical = JSON.stringify(authority);
  return encoder.encode(`${canonical.slice(0, -1)},"round4_probe":${probe}}`);
}

describe("round-3 authority boundary matrix", () => {
  test("declares every actual authority resource and its mismatch proof", async () => {
    const module = await import("../lib/authority-boundary") as any;
    expect(module.AUTHORITY_TRUST_MODEL).toEqual({
      task_1_1a_assumption: "stable_build_source_workspace_without_hostile_concurrent_rename_replace",
      task_1_1a_non_goal: "cryptographic_binary_provenance_or_atomic_executable_repository_capability",
      runtime_acceptance_precondition: "later_descriptor_bound_launcher_observer_tripwire_evidence"
    });
    expect(module.AUTHORITY_BOUNDARY_MATRIX).toEqual([
      { owner: "task_1_1a_stable_workspace", resource: "resource", actual_boundary: "opened_regular_file_handle", identity_profile: "captured_path_and_file_identity", foreign_negative: "symlink_replacement_or_non_regular" },
      { owner: "task_1_1a_stable_workspace", resource: "tool", actual_boundary: "resolved_git_path", identity_profile: "persistent_path_reports_exact_2.49.0_and_usable_exec_path", foreign_negative: "version_mismatch_or_unusable_persistent_path_or_exec_path" },
      { owner: "task_1_1a_stable_workspace", resource: "repository", actual_boundary: "supplied_repository_root", identity_profile: "exact_git_top_level_and_common_directory", foreign_negative: "nonrepository_parent_or_foreign_root" },
      { owner: "task_1_1a_stable_workspace", resource: "raw_nested_input", actual_boundary: "raw_authority_set_source_record_subtree", identity_profile: "64kib_depth_12_nodes_2048_items_512_item_precedes_redundant_node", foreign_negative: "nested_profile_bound_plus_one" },
      { owner: "task_1_1a_stable_workspace", resource: "path", actual_boundary: "captured_no_symlink_path", identity_profile: "ancestor_and_opened_file_identity", foreign_negative: "alias_or_persistent_path_mismatch" },
      { owner: "task_1_1a_stable_workspace", resource: "canonical_manifest", actual_boundary: "source_input_v1_paths", identity_profile: "shared_candidate_predicate_and_exact_tracked_set", foreign_negative: "alternate_stale_or_evidence_path" },
      { owner: "later_rust_launcher", resource: "hostile_executable_replacement", actual_boundary: "native_launch_tripwire", identity_profile: "mandatory_concurrent_rename_replace_evidence", foreign_negative: "no_runtime_decision_without_tripwire" },
      { owner: "later_rust_observer", resource: "hostile_repository_replacement", actual_boundary: "descriptor_bound_checkout_capability", identity_profile: "mandatory_descriptor_relative_rename_replace_evidence", foreign_negative: "no_runtime_decision_without_tripwire" }
    ]);
  });

  test("the actual Git 2.49.0 executable and exact repository root are bound before tracked inspection", async () => {
    const { establishGitAuthority } = await import("../lib/authority-boundary") as any;
    const authority = establishGitAuthority(repositoryRoot);
    expect(authority.version).toBe("2.49.0");
    expect(authority.repositoryRoot).toBe(realpathSync(repositoryRoot));
    expect(authority.gitCommonDirectory).toBeTruthy();
  });

  test("a Git version mismatch, unusable persistent path, or unusable exec-path fails closed", async () => {
    const { establishGitAuthority } = await import("../lib/authority-boundary") as any;
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    for (const kind of ["non_executable", "non_file"] as const) {
      const root = await temporaryRoot("shud-unusable-git-");
      const executable = join(root, "git");
      if (kind === "non_executable") await writeFile(executable, "not executable\n");
      else await mkdir(executable);
      const savedPath = process.env.PATH;
      try {
        process.env.PATH = root;
        expect(() => establishGitAuthority(repositoryRoot)).toThrow(ContractError);
      } finally {
        if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      }
    }
    for (const [version, delegatesExecPath] of [["2.50.0", true], ["2.49.0", false]] as const) {
      const root = await temporaryRoot("shud-fake-git-");
      const executable = join(root, "git");
      await writeFile(executable, `#!${process.execPath}\nconst a=Bun.argv.slice(2);if(a[0]==="--version"){console.log("git version ${version}");process.exit(0)}if(a[0]==="--exec-path"&&!${delegatesExecPath})process.exit(7);const r=Bun.spawnSync([process.env.ROUND3_REAL_GIT,...a],{stdout:"inherit",stderr:"inherit",env:process.env});process.exit(r.exitCode);\n`);
      await chmod(executable, 0o755);
      const savedPath = process.env.PATH;
      const savedRealGit = process.env.ROUND3_REAL_GIT;
      try {
        process.env.PATH = `${root}:${savedPath ?? ""}`;
        process.env.ROUND3_REAL_GIT = realGit;
        expect(() => establishGitAuthority(repositoryRoot)).toThrow(ContractError);
      } finally {
        if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
        if (savedRealGit === undefined) delete process.env.ROUND3_REAL_GIT; else process.env.ROUND3_REAL_GIT = savedRealGit;
      }
    }
  });

  test("a transparent exact-version delegating wrapper is admitted within the stable-workspace contract", async () => {
    const { establishGitAuthority } = await import("../lib/authority-boundary") as any;
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const root = await temporaryRoot("shud-transparent-git-");
    const executable = join(root, "git");
    await writeFile(executable, `#!${process.execPath}\nconst a=Bun.argv.slice(2);if(a[0]==="--version"){console.log("git version 2.49.0");process.exit(0)}const r=Bun.spawnSync([process.env.ROUND3_REAL_GIT,...a],{stdout:"inherit",stderr:"inherit",env:process.env});process.exit(r.exitCode);\n`);
    await chmod(executable, 0o755);
    const savedPath = process.env.PATH;
    const savedRealGit = process.env.ROUND3_REAL_GIT;
    try {
      process.env.PATH = `${root}:${savedPath ?? ""}`;
      process.env.ROUND3_REAL_GIT = realGit;
      const authority = establishGitAuthority(repositoryRoot);
      expect(authority.executable).toBe(realpathSync(executable));
      expect(authority.version).toBe("2.49.0");
      expect(authority.repositoryRoot).toBe(realpathSync(repositoryRoot));
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (savedRealGit === undefined) delete process.env.ROUND3_REAL_GIT; else process.env.ROUND3_REAL_GIT = savedRealGit;
    }
  });

  test("parent discovery is rejected while an exact linked worktree root succeeds", async () => {
    const { establishGitAuthority } = await import("../lib/authority-boundary") as any;
    const parent = await temporaryRoot("shud-repository-binding-");
    expect(spawnSync("git", ["init", "-q"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "round3@example.invalid"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Round Three"], { cwd: parent }).status).toBe(0);
    await writeFile(join(parent, "README"), "authority\n");
    expect(spawnSync("git", ["add", "README"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-qm", "fixture"], { cwd: parent }).status).toBe(0);
    const child = join(parent, "not-a-repository");
    await mkdir(child);
    expect(() => establishGitAuthority(child)).toThrow(ContractError);
    const worktree = await temporaryRoot("shud-linked-worktree-");
    await rm(worktree, { recursive: true, force: true });
    expect(spawnSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: parent }).status).toBe(0);
    const admitted = establishGitAuthority(worktree);
    expect(admitted.repositoryRoot).toBe(realpathSync(worktree));
    expect(admitted.gitCommonDirectory).toBe(realpathSync(join(parent, ".git")));
  });

  test("authority-set supply uses one exact repository authority: nonrepository, parent-discovered, and foreign roots fail while a linked worktree succeeds", async () => {
    const sourceSpike = join(repositoryRoot, "spikes", "git-status-capability");
    const parent = await temporaryRoot("shud-authority-set-root-");
    expect(spawnSync("git", ["init", "-q"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "round4@example.invalid"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Round Four"], { cwd: parent }).status).toBe(0);
    await mkdir(join(parent, "spikes"), { recursive: true });
    await cp(sourceSpike, join(parent, "spikes", "git-status-capability"), { recursive: true });
    expect(spawnSync("git", ["add", "spikes/git-status-capability"], { cwd: parent }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-qm", "authority fixture"], { cwd: parent }).status).toBe(0);

    const nonrepository = await temporaryRoot("shud-authority-set-nonrepo-");
    await mkdir(join(nonrepository, "spikes"), { recursive: true });
    await cp(sourceSpike, join(nonrepository, "spikes", "git-status-capability"), { recursive: true });
    expect((await invokeAuthority(undefined, nonrepository)).exit).toBe(2);

    const child = join(parent, "parent-discovered");
    await mkdir(join(child, "spikes"), { recursive: true });
    await cp(sourceSpike, join(child, "spikes", "git-status-capability"), { recursive: true });
    expect((await invokeAuthority(undefined, child)).exit).toBe(2);

    const foreign = await temporaryRoot("shud-authority-set-foreign-");
    expect(spawnSync("git", ["init", "-q"], { cwd: foreign }).status).toBe(0);
    expect((await invokeAuthority(undefined, foreign)).exit).toBe(2);

    const linked = await temporaryRoot("shud-authority-set-linked-");
    await rm(linked, { recursive: true, force: true });
    expect(spawnSync("git", ["worktree", "add", "-q", "--detach", linked], { cwd: parent }).status).toBe(0);
    expect((await invokeAuthority(undefined, linked)).exit).toBe(0);
  });
});

describe("raw nested source-record accounting", () => {
  test("accepts exactly 64 KiB of raw source-record bytes and rejects 64 KiB plus one", async () => {
    const authority = await loadAuthority();
    const exact = await invokeAuthorityBytes(withRawSourceRecord(authority, padObjectToBytes(authority.source_record, INGESTION_LIMITS.source_input_record.bytes)));
    expect(exact.exit).toBe(0);
    expect(exact.stderr).toBe("");
    expect(await invokeAuthorityBytes(withRawSourceRecord(authority, padObjectToBytes(authority.source_record, INGESTION_LIMITS.source_input_record.bytes + 1))))
      .toEqual({ exit: 2, stdout: "", stderr: errorReceipt("CONTRACT_BYTES_LIMIT") });
  });

  test("reapplies exact and plus-one depth and item limits to the raw nested subtree", async () => {
    const authority = await loadAuthority();
    const depthExact = sourceWithProbe(authority.source_record, `${"[".repeat(10)}0${"]".repeat(10)}`);
    const depthPlusOne = sourceWithProbe(authority.source_record, `${"[".repeat(11)}0${"]".repeat(11)}`);
    expect((await invokeAuthorityBytes(withRawSourceRecord(authority, depthExact))).stderr).toBe(errorReceipt("CONTRACT_SCHEMA_INVALID"));
    expect((await invokeAuthorityBytes(withRawSourceRecord(authority, depthPlusOne))).stderr).toBe(errorReceipt("CONTRACT_JSON_DEPTH_LIMIT"));

    const baseline = structuralCounts(authority.source_record).items;
    const exactItems = INGESTION_LIMITS.source_input_record.items - baseline - 1;
    const itemExact = sourceWithProbe(authority.source_record, `[${Array.from({ length: exactItems }, () => "null").join(",")}]`);
    const itemPlusOne = sourceWithProbe(authority.source_record, `[${Array.from({ length: exactItems + 1 }, () => "null").join(",")}]`);
    expect((await invokeAuthorityBytes(withRawSourceRecord(authority, itemExact))).stderr).toBe(errorReceipt("CONTRACT_SCHEMA_INVALID"));
    expect((await invokeAuthorityBytes(withRawSourceRecord(authority, itemPlusOne))).stderr).toBe(errorReceipt("CONTRACT_JSON_ITEM_LIMIT"));
  });

  test("the shared raw-subtree helper accounts for exact and plus-one node profiles", async () => {
    const { ingestJsonWithNestedLimits } = await import("../lib/ingestion") as any;
    const nestedAt = (nodes: number) => encoder.encode(`{"source_record":[${Array.from({ length: nodes - 1 }, () => "null").join(",")}]}`);
    const outer = { bytes: 512 * 1024, depth: 32, nodes: 32_768, items: 8_192 };
    const nested = { bytes: 64 * 1024, depth: 12, nodes: 2_048, items: 8_192 };
    expect(ingestJsonWithNestedLimits(nestedAt(2_048), outer, "source_record", nested)).toBeDefined();
    expect(() => ingestJsonWithNestedLimits(nestedAt(2_049), outer, "source_record", nested)).toThrow("CONTRACT_JSON_NODE_LIMIT");
  });

  test("the frozen authority-set profile publicly applies its reachable item limit before its redundant node fail-safe", async () => {
    const authority = await loadAuthority();
    const baseline = structuralCounts(authority).items;
    const exactProbeItems = INGESTION_LIMITS.authority_set.items - baseline - 1;
    const exact = authorityWithProbe(authority, `[${Array.from({ length: exactProbeItems }, () => "null").join(",")}]`);
    const plusOne = authorityWithProbe(authority, `[${Array.from({ length: exactProbeItems + 1 }, () => "null").join(",")}]`);
    const exceedsBoth = authorityWithProbe(authority, `[${Array.from({ length: INGESTION_LIMITS.authority_set.nodes + 1 }, () => "null").join(",")}]`);
    expect((await invokeAuthorityBytes(exact)).stderr).toBe(errorReceipt("CONTRACT_SCHEMA_INVALID"));
    expect((await invokeAuthorityBytes(plusOne)).stderr).toBe(errorReceipt("CONTRACT_JSON_ITEM_LIMIT"));
    expect((await invokeAuthorityBytes(exceedsBoth)).stderr).toBe(errorReceipt("CONTRACT_JSON_ITEM_LIMIT"));
  });
});

describe("task-local Cargo lexical boundary", () => {
  test("accepts TOML ASCII space/tab but rejects Unicode whitespace and non-TOML controls", async () => {
    const cargo = await readFile(join(repositoryRoot, "spikes", "git-status-capability", "native", "Cargo.toml"), "utf8");
    const catalog = JSON.parse(await readFile(join(repositoryRoot, "spikes", "git-status-capability", "dependency-graph-catalog.json"), "utf8"));
    expect(validateCargoManifest(cargo.replace("name =", "name\t=\t"), catalog.direct_dependencies)).toBe(true);
    for (const separator of ["\u00a0", "\u2003", "\u2028", "\u000b", "\u000c"]) {
      expect(validateCargoManifest(cargo.replace("name =", `name${separator}=${separator}`), catalog.direct_dependencies)).toBe(false);
    }
  });
});
