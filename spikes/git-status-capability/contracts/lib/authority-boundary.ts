import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ContractError } from "./ingestion";

export const AUTHORITY_TRUST_MODEL = Object.freeze({
  task_1_1a_assumption: "stable_build_source_workspace_without_hostile_concurrent_rename_replace",
  task_1_1a_non_goal: "cryptographic_binary_provenance_or_atomic_executable_repository_capability",
  runtime_acceptance_precondition: "later_descriptor_bound_launcher_observer_tripwire_evidence"
} as const);

export const AUTHORITY_BOUNDARY_MATRIX = Object.freeze([
  { owner: "task_1_1a_stable_workspace", resource: "resource", actual_boundary: "opened_regular_file_handle", identity_profile: "captured_path_and_file_identity", foreign_negative: "symlink_replacement_or_non_regular" },
  { owner: "task_1_1a_stable_workspace", resource: "tool", actual_boundary: "resolved_git_path", identity_profile: "persistent_path_reports_exact_2.49.0_and_usable_exec_path", foreign_negative: "version_mismatch_or_unusable_persistent_path_or_exec_path" },
  { owner: "task_1_1a_stable_workspace", resource: "repository", actual_boundary: "supplied_repository_root", identity_profile: "exact_git_top_level_and_common_directory", foreign_negative: "nonrepository_parent_or_foreign_root" },
  { owner: "task_1_1a_stable_workspace", resource: "raw_nested_input", actual_boundary: "raw_authority_set_source_record_subtree", identity_profile: "64kib_depth_12_nodes_2048_items_512_item_precedes_redundant_node", foreign_negative: "nested_profile_bound_plus_one" },
  { owner: "task_1_1a_stable_workspace", resource: "path", actual_boundary: "captured_no_symlink_path", identity_profile: "ancestor_and_opened_file_identity", foreign_negative: "alias_or_persistent_path_mismatch" },
  { owner: "task_1_1a_stable_workspace", resource: "canonical_manifest", actual_boundary: "source_input_v1_paths", identity_profile: "shared_candidate_predicate_and_exact_tracked_set", foreign_negative: "alternate_stale_or_evidence_path" },
  { owner: "later_rust_launcher", resource: "hostile_executable_replacement", actual_boundary: "native_launch_tripwire", identity_profile: "mandatory_concurrent_rename_replace_evidence", foreign_negative: "no_runtime_decision_without_tripwire" },
  { owner: "later_rust_observer", resource: "hostile_repository_replacement", actual_boundary: "descriptor_bound_checkout_capability", identity_profile: "mandatory_descriptor_relative_rename_replace_evidence", foreign_negative: "no_runtime_decision_without_tripwire" }
] as const);

export type GitAuthority = {
  executable: string;
  version: "2.49.0";
  execPath: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  environment: NodeJS.ProcessEnv;
};

function fail(): never {
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function resolveExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (!statSync(path).isFile()) return fail();
      return path;
    } catch {
      // Continue to the next explicit PATH entry; no shell or command lookup is used.
    }
  }
  return fail();
}

function controlledGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C"
  });
  return environment;
}

function invokeExecutable(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): SpawnSyncReturns<Buffer> {
  try {
    if (realpathSync(executable) !== executable || !statSync(executable).isFile()) return fail();
  } catch {
    return fail();
  }
  return spawnSync(executable, [...args], {
    encoding: "buffer", env: environment, stdio: ["ignore", "pipe", "ignore"]
  });
}

function exactLine(result: SpawnSyncReturns<Buffer>): string {
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return fail();
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    return fail();
  }
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) return fail();
  return value.slice(0, -1);
}

export function establishGitAuthority(repositoryRoot: string): GitAuthority {
  const executable = resolveExecutable("git");
  const environment = controlledGitEnvironment();
  const versionLine = exactLine(invokeExecutable(executable, ["--version"], environment));
  if (versionLine !== "git version 2.49.0") return fail();

  const execPath = exactLine(invokeExecutable(executable, ["--exec-path"], environment));
  if (!isAbsolute(execPath)) return fail();
  let canonicalExecPath: string;
  let root: string;
  try {
    canonicalExecPath = realpathSync(execPath);
    if (!statSync(canonicalExecPath).isDirectory()) return fail();
    root = realpathSync(resolve(repositoryRoot));
    if (!statSync(root).isDirectory()) return fail();
  } catch {
    return fail();
  }

  const identityResult = invokeExecutable(executable, [
    "-C", root, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"
  ], environment);
  if (identityResult.status !== 0 || !Buffer.isBuffer(identityResult.stdout)) return fail();
  let identityText: string;
  try {
    identityText = new TextDecoder("utf-8", { fatal: true }).decode(identityResult.stdout);
  } catch {
    return fail();
  }
  if (!identityText.endsWith("\n") || identityText.includes("\r")) return fail();
  const lines = identityText.slice(0, -1).split("\n");
  if (lines.length !== 2 || !lines.every(isAbsolute)) return fail();
  let topLevel: string;
  let commonDirectory: string;
  try {
    topLevel = realpathSync(lines[0]!);
    commonDirectory = realpathSync(lines[1]!);
    if (!statSync(commonDirectory).isDirectory()) return fail();
  } catch {
    return fail();
  }
  if (topLevel !== root) return fail();

  return {
    executable,
    version: "2.49.0",
    execPath: canonicalExecPath,
    repositoryRoot: root,
    gitCommonDirectory: commonDirectory,
    environment
  };
}

export function runBoundGit(authority: GitAuthority, args: readonly string[]): SpawnSyncReturns<Buffer> {
  return invokeExecutable(authority.executable, args, authority.environment);
}
