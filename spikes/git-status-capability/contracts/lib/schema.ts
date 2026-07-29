import { createHash } from "node:crypto";
import { readdir, lstat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { canonicalEqual } from "./canonical-json";
import { COMMAND_PROFILE_V1 } from "./command-profile";
import { readRegularFileBounded, readSupplyFiles, validateDecisionToolchain, validatePlatformToolchain } from "./authority";
import {
  CATALOG_V1,
  FLOOR_V1,
  INGESTION_LIMITS,
  OBSERVER_LIMITS,
  OWNERSHIP_V1,
  REJECTION_CODES,
  SCHEMA_DESCRIPTORS,
  SUPPLY_IDENTITY,
  TARGET_GRAPH_EXPECTATIONS,
  TOOLCHAIN
} from "./frozen";
import { ContractError, readJsonFileBounded, type InputKind } from "./ingestion";
import { validateCargoManifest } from "./cargo-manifest";
import { validateSourceInputRecord } from "./source-record";
import { captureNoSymlinkPath, verifyNoSymlinkPath } from "./path-safety";
import { establishGitAuthority, runBoundGit } from "./authority-boundary";

type JsonRecord = Record<string, unknown>;

const CONTRACT_KEYS = [
  "schema_version", "catalog_version", "catalog", "floor_crosswalk", "ownership",
  "rejection_codes", "ingestion_limits", "observer_limits", "toolchain", "state_model",
  "source_input_digest_v1", "supply_identity", "command_profile", "schemas"
];
const OUTCOME_KEYS = ["kind"];
const REJECTED_OUTCOME_KEYS = ["kind", "code"];
const SOURCE_FRAME_FIELDS = [
  "u32_entry_count", "u32_path_byte_length", "path_utf8_bytes", "u32_git_mode_octal",
  "u64_content_byte_length", "raw_git_blob_bytes"
] as const;
const SYNTHETIC_LITERAL_PATH = "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.sha256";
const SOURCE_MANIFEST_MAX_BYTES = 256 * 1024;
const SYNTHETIC_FRAME_MAX_BYTES = 152;
const SYNTHETIC_DIGEST_MAX_BYTES = 65;
export const SOURCE_MANIFEST_RELATIVE = "spikes/git-status-capability/contracts/source-input-v1.paths";

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactJson(actual: unknown, expected: unknown): boolean {
  return canonicalEqual(actual, expected);
}

function outcome(value: unknown): boolean {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "rejected") return exactKeys(value, REJECTED_OUTCOME_KEYS) && typeof value.code === "string" && REJECTION_CODES.includes(value.code);
  return (value.kind === "clean" || value.kind === "dirty") && exactKeys(value, OUTCOME_KEYS);
}

function strictSchemaDescriptor(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["schema_version", "required_fields", "optional_fields", "additional_properties"])) return false;
  return typeof value.schema_version === "string" && Array.isArray(value.required_fields) && value.required_fields.every((field) => typeof field === "string") &&
    new Set(value.required_fields).size === value.required_fields.length && Array.isArray(value.optional_fields) &&
    value.optional_fields.every((field) => typeof field === "string") && new Set(value.optional_fields).size === value.optional_fields.length &&
    value.additional_properties === false;
}

export function validateContract(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, CONTRACT_KEYS)) return false;
  if (value.schema_version !== "shud.git-status-capability.contract.v1" || value.catalog_version !== 1) return false;
  if (!Array.isArray(value.catalog) || value.catalog.length !== 174) return false;
  for (const row of value.catalog) {
    if (!record(row) || !exactKeys(row, ["id", "macos_expected", "linux_expected"]) || typeof row.id !== "string" || !outcome(row.macos_expected) || !outcome(row.linux_expected)) return false;
  }
  if (!exactJson(value.catalog, CATALOG_V1) || !exactJson(value.floor_crosswalk, FLOOR_V1) || !exactJson(value.ownership, OWNERSHIP_V1)) return false;
  if (!exactJson(value.rejection_codes, REJECTION_CODES) || !exactJson(value.ingestion_limits, INGESTION_LIMITS) || !exactJson(value.observer_limits, OBSERVER_LIMITS) || !exactJson(value.toolchain, TOOLCHAIN)) return false;
  if (!exactJson(value.supply_identity, SUPPLY_IDENTITY) || !exactJson(value.command_profile, COMMAND_PROFILE_V1)) return false;
  if (!record(value.state_model) || !exactKeys(value.state_model, ["observer_outcome", "expected_platforms", "row_verdict", "run_status", "terminal_decision", "terminal_decision_rule"])) return false;
  if (!exactJson(value.state_model, {
    observer_outcome: ["clean", "dirty", "rejected(code)"], expected_platforms: ["macos", "linux"],
    row_verdict: ["pass", "fail"], run_status: ["valid_complete", "invalid"], terminal_decision: ["accepted", "rejected"],
    terminal_decision_rule: "present_if_and_only_if_run_status_valid_complete"
  })) return false;
  if (!record(value.source_input_digest_v1) || !exactKeys(value.source_input_digest_v1, ["domain_prefix", "entry_order", "integer_encoding", "allowed_git_modes", "frame_fields", "source_sha_hashed", "live_literal_allowed", "synthetic_literal_path"])) return false;
  if (value.source_input_digest_v1.domain_prefix !== "SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0" || value.source_input_digest_v1.entry_order !== "raw_repository_relative_utf8_bytes" || value.source_input_digest_v1.integer_encoding !== "unsigned_big_endian" || !exactJson(value.source_input_digest_v1.allowed_git_modes, ["100644", "100755"]) || !exactJson(value.source_input_digest_v1.frame_fields, SOURCE_FRAME_FIELDS) || value.source_input_digest_v1.source_sha_hashed !== false || value.source_input_digest_v1.live_literal_allowed !== false || value.source_input_digest_v1.synthetic_literal_path !== SYNTHETIC_LITERAL_PATH) return false;
  if (!record(value.schemas) || !exactKeys(value.schemas, [
    "authority_set", "frame", "row_evidence", "platform_bundle", "final_bundle", "decision", "source_input_record",
    "source_input_encoder_result", "source_input_command_receipt"
  ])) return false;
  return Object.values(value.schemas).every(strictSchemaDescriptor) && exactJson(value.schemas, SCHEMA_DESCRIPTORS);
}

export async function loadAndValidateContract(path: string): Promise<void> {
  await readJsonFileBounded(path, "catalog", validateContract);
}

const DIRECT_DEPENDENCIES = [
  { name: "cap-std", version: "4.0.2", default_features: false, features: [], source: "registry+https://github.com/rust-lang/crates.io-index" },
  { name: "gix-index", version: "0.54.0", default_features: false, features: ["sha1"], source: "registry+https://github.com/rust-lang/crates.io-index" },
  { name: "gix-status", version: "0.33.0", default_features: false, features: ["sha1", "worktree-rewrites"], source: "registry+https://github.com/rust-lang/crates.io-index" }
];

export function validateDependencyCatalog(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, [
    "schema_version", "rust_version", "rust_commit", "cargo", "git_oracle_version", "lockfile_version",
    "lockfile_digest", "rust_toolchain_digest", "direct_dependencies", "prohibited_sources", "target_graphs"
  ])) return false;
  if (value.schema_version !== "shud.git-status-capability.dependency-graph.v1" || value.rust_version !== SUPPLY_IDENTITY.rust_release ||
    value.rust_commit !== SUPPLY_IDENTITY.rust_commit || value.git_oracle_version !== SUPPLY_IDENTITY.git_version || value.lockfile_version !== 4 ||
    value.lockfile_digest !== SUPPLY_IDENTITY.lockfile_digest || value.rust_toolchain_digest !== SUPPLY_IDENTITY.rust_toolchain_digest ||
    !exactJson(value.cargo, { cli_release: SUPPLY_IDENTITY.cargo_cli_release, commit: SUPPLY_IDENTITY.cargo_commit, package_version: SUPPLY_IDENTITY.cargo_package_version }) ||
    !exactJson(value.direct_dependencies, DIRECT_DEPENDENCIES) || !exactJson(value.prohibited_sources, ["git", "branch", "path", "wildcard"])) return false;
  if (!record(value.target_graphs) || !exactKeys(value.target_graphs, ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"])) return false;
  for (const [target, graphValue] of Object.entries(value.target_graphs)) {
    const expected = TARGET_GRAPH_EXPECTATIONS[target as keyof typeof TARGET_GRAPH_EXPECTATIONS];
    if (!record(graphValue) || !exactKeys(graphValue, ["target", "packages", "edges", "allowed_target_predicates", "registry_source", "graph_digest"]) || graphValue.target !== target || graphValue.registry_source !== "registry+https://github.com/rust-lang/crates.io-index" || !Array.isArray(graphValue.packages) || !Array.isArray(graphValue.edges) || !Array.isArray(graphValue.allowed_target_predicates) || typeof graphValue.graph_digest !== "string") return false;
    if (!expected || graphValue.packages.length !== expected.packages || graphValue.edges.length !== expected.edges || graphValue.allowed_target_predicates.length !== expected.predicates || graphValue.graph_digest !== expected.graph_digest) return false;
    if (new Set(graphValue.packages).size !== graphValue.packages.length || new Set(graphValue.edges).size !== graphValue.edges.length) return false;
    const packageCoordinates = new Set<string>();
    for (const pkg of graphValue.packages) {
      if (typeof pkg !== "string" || !/^[A-Za-z0-9_.-]+@[0-9][A-Za-z0-9.+-]*#[0-9a-f]{64}$/.test(pkg)) return false;
      packageCoordinates.add(pkg.slice(0, pkg.lastIndexOf("#")));
    }
    const adjacency = new Map<string, string[]>();
    const rootEdges: string[] = [];
    for (const edge of graphValue.edges) {
      if (typeof edge !== "string") return false;
      const [from, to, dependencyKind, predicate, ...surplus] = edge.split("\0");
      if (surplus.length !== 0 || !from || !to || !["normal", "build"].includes(dependencyKind!) || predicate === undefined) return false;
      if ((from !== "root" && !packageCoordinates.has(from)) || !packageCoordinates.has(to)) return false;
      if (from === "root") rootEdges.push(edge);
      const targets = adjacency.get(from) ?? [];
      targets.push(to);
      adjacency.set(from, targets);
    }
    const directCoordinates = DIRECT_DEPENDENCIES.map((dependency) => `${dependency.name}@${dependency.version}`);
    const expectedRootEdges = directCoordinates.map((coordinate) => `root\0${coordinate}\0normal\0`);
    if (!exactJson(rootEdges, expectedRootEdges)) return false;
    const reachable = new Set<string>(["root"]);
    const pending = ["root"];
    while (pending.length > 0) {
      for (const coordinate of adjacency.get(pending.shift()!) ?? []) {
        if (!reachable.has(coordinate)) {
          reachable.add(coordinate);
          pending.push(coordinate);
        }
      }
    }
    if (directCoordinates.some((coordinate) => !reachable.has(coordinate)) || [...packageCoordinates].some((coordinate) => !reachable.has(coordinate))) return false;
    const predicates = [...new Set(graphValue.edges.map((edge) => (edge as string).split("\0")[3]).filter((item): item is string => Boolean(item)))].sort();
    if (!exactJson(graphValue.allowed_target_predicates, predicates)) return false;
    const digest = createHash("sha256").update(JSON.stringify({ packages: graphValue.packages, edges: graphValue.edges })).digest("hex");
    if (graphValue.graph_digest !== digest) return false;
  }
  return true;
}

export async function validateSupplyFiles(spikeRoot: string): Promise<void> {
  const dependencyPath = join(spikeRoot, "dependency-graph-catalog.json");
  const dependencyCatalog = await readJsonFileBounded(dependencyPath, "dependency_graph", validateDependencyCatalog) as JsonRecord;
  const supplyFiles = await readSupplyFiles(spikeRoot);
  const actualSupply = {
    lockfile_digest: supplyFiles.lockfile_digest,
    rust_toolchain_digest: supplyFiles.rust_toolchain_digest
  };
  if (!exactJson(actualSupply, {
    lockfile_digest: SUPPLY_IDENTITY.lockfile_digest,
    rust_toolchain_digest: SUPPLY_IDENTITY.rust_toolchain_digest
  })) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const cargoBytes = await readRegularFileBounded(join(spikeRoot, "native", "Cargo.toml"), 64 * 1024);
  let cargo: string;
  try { cargo = new TextDecoder("utf-8", { fatal: true }).decode(cargoBytes); } catch { throw new ContractError("CONTRACT_UTF8_INVALID"); }
  const toolchain = supplyFiles.rust_toolchain.toString("utf8");
  const lock = supplyFiles.lockfile.toString("utf8");
  if (!validateCargoManifest(cargo, dependencyCatalog.direct_dependencies) ||
      toolchain !== '[toolchain]\nchannel = "1.88.0"\nprofile = "minimal"\ncomponents = ["cargo", "rustc", "rust-std"]\n' ||
      !lock.startsWith("# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n") ||
      /source = "git\+|source = "path\+/.test(lock)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const lockBlocks = lock.split("[[package]]").slice(1);
  const lockedPackages = new Set<string>();
  let rootDependencies: string[] | undefined;
  for (const block of lockBlocks) {
    const name = /(?:^|\n)name = "([^"]+)"/.exec(block)?.[1];
    const version = /(?:^|\n)version = "([^"]+)"/.exec(block)?.[1];
    if (!name || !version) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (name === "shud-git-status-capability-spike") {
      rootDependencies = [...block.matchAll(/^ "([^"]+)",$/gm)].map((match) => match[1]!);
      continue;
    }
    const source = /(?:^|\n)source = "([^"]+)"/.exec(block)?.[1];
    const checksum = /(?:^|\n)checksum = "([0-9a-f]{64})"/.exec(block)?.[1];
    if (source !== "registry+https://github.com/rust-lang/crates.io-index" || !checksum) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    lockedPackages.add(`${name}@${version}#${checksum}`);
  }
  if (!exactJson(rootDependencies, ["cap-std", "gix-index", "gix-status"])) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const graphs = dependencyCatalog.target_graphs as JsonRecord;
  for (const graph of Object.values(graphs)) {
    for (const pkg of (graph as JsonRecord).packages as string[]) if (!lockedPackages.has(pkg)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
}

function canonicalRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") && posix.normalize(path) === path;
}

const CHANGE_ROOT = "openspec/changes/m2-capability-observer-spike";
const WORKFLOW_PATH = ".github/workflows/git-status-capability-spike.yml";
const CHANGE_ROOT_FILES = new Set([".openspec.yaml", "proposal.md", "design.md", "tasks.md"]);

export function isSourceCandidate(path: string): boolean {
  if (path.startsWith("spikes/git-status-capability/")) return true;
  if (path === WORKFLOW_PATH) return true;
  if (!path.startsWith(`${CHANGE_ROOT}/`)) return false;
  const relativePath = path.slice(CHANGE_ROOT.length + 1);
  if (relativePath === "evidence" || relativePath.startsWith("evidence/")) return false;
  if (CHANGE_ROOT_FILES.has(relativePath)) return true;
  return relativePath.startsWith("specs/") && relativePath.endsWith("/spec.md");
}

async function walkCandidateFiles(root: string, prefix: string, output: string[]): Promise<void> {
  const directory = join(root, ...prefix.split("/").filter(Boolean));
  const directorySnapshot = await captureNoSymlinkPath(directory, "directory");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === `${CHANGE_ROOT}/evidence` || path.startsWith(`${CHANGE_ROOT}/evidence/`)) continue;
    const absolute = join(root, ...path.split("/"));
    const stat = await lstat(absolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await walkCandidateFiles(root, path, output);
    else if (isSourceCandidate(path)) {
      if (stat.isSymbolicLink() || !stat.isFile()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
      const fileSnapshot = await captureNoSymlinkPath(absolute, "file");
      await verifyNoSymlinkPath(fileSnapshot);
      output.push(path);
    }
  }
  await verifyNoSymlinkPath(directorySnapshot);
}

async function classifyRegularFile(root: string, path: string, output: string[], required: boolean): Promise<void> {
  if (!isSourceCandidate(path)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  try {
    const stat = await lstat(join(root, ...path.split("/")));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    const snapshot = await captureNoSymlinkPath(join(root, ...path.split("/")), "file");
    await verifyNoSymlinkPath(snapshot);
    output.push(path);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  }
}

export async function enumerateSourceCandidates(repositoryRoot: string): Promise<string[]> {
  const rootSnapshot = await captureNoSymlinkPath(repositoryRoot, "directory");
  const candidates: string[] = [];
  await walkCandidateFiles(repositoryRoot, "spikes/git-status-capability", candidates);
  for (const file of CHANGE_ROOT_FILES) await classifyRegularFile(repositoryRoot, `${CHANGE_ROOT}/${file}`, candidates, true);
  await walkCandidateFiles(repositoryRoot, `${CHANGE_ROOT}/specs`, candidates);
  await classifyRegularFile(repositoryRoot, WORKFLOW_PATH, candidates, false);
  await verifyNoSymlinkPath(rootSnapshot);
  return candidates.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export async function validateManifest(repositoryRoot: string, manifestPath: string): Promise<number> {
  const absoluteRoot = resolve(repositoryRoot);
  const absoluteManifest = resolve(manifestPath);
  const manifestRelative = relative(absoluteRoot, absoluteManifest).split(sep).join("/");
  if (manifestRelative !== SOURCE_MANIFEST_RELATIVE || !canonicalRelativePath(manifestRelative)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const bytes = await readRegularFileBounded(absoluteManifest, SOURCE_MANIFEST_MAX_BYTES);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ContractError("CONTRACT_UTF8_INVALID"); }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\n\n")) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const paths = text.slice(0, -1).split("\n");
  if (paths.some((path) => !canonicalRelativePath(path)) || new Set(paths).size !== paths.length) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const sorted = [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!exactJson(paths, sorted)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const candidates = await enumerateSourceCandidates(absoluteRoot);
  if (!exactJson(paths, candidates) || !paths.includes(manifestRelative)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return paths.length;
}

export function validateGitCandidateSet(repositoryRoot: string, candidates: readonly string[]): void {
  const authority = establishGitAuthority(repositoryRoot);
  const result = runBoundGit(authority, [
    "-C", authority.repositoryRoot, "ls-files", "--stage", "-z", "--",
    "spikes/git-status-capability", CHANGE_ROOT, WORKFLOW_PATH
  ]);
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  let records: string[];
  try {
    records = new TextDecoder("utf-8", { fatal: true }).decode(
      result.stdout.subarray(0, result.stdout.length - (result.stdout.at(-1) === 0 ? 1 : 0))
    ).split("\0").filter(Boolean);
  } catch { throw new ContractError("CONTRACT_SCHEMA_INVALID"); }
  const tracked: string[] = [];
  for (const record of records) {
    const match = /^(\d{6}) [0-9a-f]{40,64} (\d)\t(.+)$/.exec(record);
    if (!match) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (!isSourceCandidate(match[3]!)) continue;
    if (match[2] !== "0" || !["100644", "100755"].includes(match[1]!)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    tracked.push(match[3]!);
  }
  const sorted = tracked.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!exactJson(sorted, candidates)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

export async function validateSyntheticGolden(spikeRoot: string): Promise<void> {
  const goldenRoot = join(spikeRoot, "contracts", "goldens");
  const names = (await readdir(goldenRoot)).sort();
  if (!exactJson(names, ["source-input-v1.synthetic.frame", "source-input-v1.synthetic.sha256"])) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const frame = await readRegularFileBounded(join(goldenRoot, "source-input-v1.synthetic.frame"), SYNTHETIC_FRAME_MAX_BYTES);
  const literalBytes = await readRegularFileBounded(join(goldenRoot, "source-input-v1.synthetic.sha256"), SYNTHETIC_DIGEST_MAX_BYTES);
  let literal: string;
  try { literal = new TextDecoder("utf-8", { fatal: true }).decode(literalBytes); } catch { throw new ContractError("CONTRACT_UTF8_INVALID"); }
  if (!/^[0-9a-f]{64}\n$/.test(literal) || createHash("sha256").update(frame).digest("hex") !== literal.trim()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  if (!frame.subarray(0, 58).equals(Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0", "ascii"))) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

type SchemaDescriptor = (typeof SCHEMA_DESCRIPTORS)[keyof typeof SCHEMA_DESCRIPTORS];
type SchemaValidator = (value: unknown) => boolean;

function matchesDescriptor(value: unknown, descriptor: SchemaDescriptor): value is JsonRecord {
  if (!record(value) || value.schema_version !== descriptor.schema_version) return false;
  const actual = Object.keys(value);
  const allowed = new Set<string>([...descriptor.required_fields, ...descriptor.optional_fields]);
  return descriptor.required_fields.every((field) => Object.hasOwn(value, field)) && actual.every((field) => allowed.has(field));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validateSchema(value: unknown): boolean {
  return Object.values(SCHEMA_DESCRIPTORS).some((descriptor) => exactJson(value, descriptor));
}

export function validateRowEvidence(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.row_evidence;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || typeof value.row_id !== "string" || !CATALOG_V1.some((row) => row.id === value.row_id)) return false;
  if (!outcome(value.expected_outcome) || !outcome(value.observer_outcome) || !nonEmptyString(value.producing_boundary) || !["pass", "fail"].includes(value.row_verdict as string)) return false;
  if (!sha256(value.oracle_digest) || !record(value.tripwire_verdicts) || typeof value.protection_set_equal !== "boolean" || !record(value.cleanup) || !record(value.resource_record) || !sha256(value.source_input_record_sha256)) return false;
  if (value.first_cause !== undefined && !nonEmptyString(value.first_cause)) return false;
  return value.secondary_errors === undefined || stringArray(value.secondary_errors);
}

export function validatePlatformBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.platform_bundle;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || !["valid_complete", "invalid"].includes(value.run_status as string) || !gitObjectId(value.source_commit)) return false;
  const target = value.platform === "macos" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu";
  if (value.target !== target || !validatePlatformToolchain(value.toolchain, value.platform as "macos" | "linux") || !Array.isArray(value.rows) || !Array.isArray(value.protection_set) || !Array.isArray(value.raw_command_manifest)) return false;
  return [
    value.source_input_record_sha256, value.catalog_digest, value.lockfile_digest, value.rust_toolchain_digest,
    value.dependency_graph_digest, value.direct_feature_digest,
    value.call_ledger_digest, value.sbom_digest, value.license_inventory_digest
  ].every(sha256) && value.lockfile_digest === SUPPLY_IDENTITY.lockfile_digest && value.rust_toolchain_digest === SUPPLY_IDENTITY.rust_toolchain_digest;
}

function structuralTerminalFields(value: JsonRecord): boolean {
  if (typeof value.run_status !== "string") return false;
  if (value.terminal_decision !== undefined && typeof value.terminal_decision !== "string") return false;
  if (value.first_cause !== undefined && !nonEmptyString(value.first_cause)) return false;
  return value.all_failure_codes === undefined || stringArray(value.all_failure_codes);
}

export function validateFinalBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.final_bundle;
  if (!matchesDescriptor(value, descriptor) || !structuralTerminalFields(value) || !record(value.repository_gates)) return false;
  return [value.source_input_record_sha256, value.macos_bundle_sha256, value.linux_bundle_sha256, value.raw_evidence_digest, value.decision_projection_digest].every(sha256);
}

export function validateDecision(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.decision;
  if (!matchesDescriptor(value, descriptor) || !structuralTerminalFields(value) || value.catalog_version !== 1 || !sha256(value.catalog_digest) || !sha256(value.source_input_record_sha256) || !gitObjectId(value.base_sha)) return false;
  if (value.lockfile_digest !== SUPPLY_IDENTITY.lockfile_digest || value.rust_toolchain_digest !== SUPPLY_IDENTITY.rust_toolchain_digest || !validateDecisionToolchain(value.toolchain)) return false;
  if (!Array.isArray(value.platforms) || !exactJson(value.platforms, ["macos", "linux"]) || !Array.isArray(value.rows) || !record(value.gates)) return false;
  return true;
}

const INPUT_VALIDATORS: Record<InputKind, SchemaValidator> = {
  catalog: validateContract,
  authority_set: () => false,
  dependency_graph: validateDependencyCatalog,
  schema: validateSchema,
  source_input_record: validateSourceInputRecord,
  row_evidence: validateRowEvidence,
  platform_bundle: validatePlatformBundle,
  final_bundle: validateFinalBundle,
  decision: validateDecision
};

export function validatorForInputKind(kind: InputKind): SchemaValidator {
  return INPUT_VALIDATORS[kind];
}
