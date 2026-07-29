import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ContractError } from "./ingestion";

export const AUTHORITY_BOUNDARY_MATRIX = Object.freeze([
  { resource: "resource", actual_boundary: "opened_regular_file_handle", identity_profile: "captured_path_and_file_identity", foreign_negative: "symlink_replacement_or_non_regular" },
  { resource: "tool", actual_boundary: "resolved_git_executable", identity_profile: "same_executable_exact_2.49.0_and_exec_path", foreign_negative: "path_impostor_or_version_mismatch" },
  { resource: "repository", actual_boundary: "supplied_repository_root", identity_profile: "exact_git_top_level_and_common_directory", foreign_negative: "parent_or_foreign_repository_discovery" },
  { resource: "raw_nested_input", actual_boundary: "raw_authority_set_source_record_subtree", identity_profile: "64kib_depth_12_nodes_2048_items_512", foreign_negative: "nested_profile_bound_plus_one" },
  { resource: "path", actual_boundary: "captured_no_symlink_path", identity_profile: "ancestor_and_opened_file_identity", foreign_negative: "alias_or_path_replacement" },
  { resource: "canonical_manifest", actual_boundary: "source_input_v1_paths", identity_profile: "shared_candidate_predicate_and_exact_tracked_set", foreign_negative: "alternate_stale_or_evidence_path" }
] as const);

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
};

export type GitAuthority = {
  executable: string;
  version: "2.49.0";
  execPath: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  environment: NodeJS.ProcessEnv;
  executableIdentity: FileIdentity;
};

function fail(): never {
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function fileIdentity(path: string): FileIdentity {
  let stat;
  try {
    stat = statSync(path, { bigint: true });
  } catch {
    return fail();
  }
  if (!stat.isFile()) return fail();
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function resolveExecutable(name: string): { path: string; identity: FileIdentity } {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      return { path, identity: fileIdentity(path) };
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
  identity: FileIdentity,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): SpawnSyncReturns<Buffer> {
  if (!sameFileIdentity(identity, fileIdentity(executable))) return fail();
  const result = spawnSync(executable, [...args], {
    encoding: "buffer", env: environment, stdio: ["ignore", "pipe", "ignore"]
  });
  if (!sameFileIdentity(identity, fileIdentity(executable))) return fail();
  return result;
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
  const resolved = resolveExecutable("git");
  const environment = controlledGitEnvironment();
  const versionLine = exactLine(invokeExecutable(resolved.path, resolved.identity, ["--version"], environment));
  if (versionLine !== "git version 2.49.0") return fail();

  const execPath = exactLine(invokeExecutable(resolved.path, resolved.identity, ["--exec-path"], environment));
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

  const identityResult = invokeExecutable(resolved.path, resolved.identity, [
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
    executable: resolved.path,
    executableIdentity: resolved.identity,
    version: "2.49.0",
    execPath: canonicalExecPath,
    repositoryRoot: root,
    gitCommonDirectory: commonDirectory,
    environment
  };
}

export function runBoundGit(authority: GitAuthority, args: readonly string[]): SpawnSyncReturns<Buffer> {
  return invokeExecutable(authority.executable, authority.executableIdentity, args, authority.environment);
}
