import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CATALOG_V1,
  FLOOR_V1,
  INGESTION_LIMITS,
  OBSERVER_LIMITS,
  OWNERSHIP_V1,
  REJECTION_CODES,
  SCHEMA_DESCRIPTORS,
  TARGET_GRAPH_EXPECTATIONS,
  TOOLCHAIN
} from "./frozen";
import { ContractError, ingestJson, type InputKind } from "./ingestion";

type JsonRecord = Record<string, unknown>;

const CONTRACT_KEYS = [
  "schema_version", "catalog_version", "catalog", "floor_crosswalk", "ownership",
  "rejection_codes", "ingestion_limits", "observer_limits", "toolchain", "state_model",
  "source_input_digest_v1", "schemas"
];
const OUTCOME_KEYS = ["kind"];
const REJECTED_OUTCOME_KEYS = ["kind", "code"];

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactJson(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(actual, expected);
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
  if (!record(value.state_model) || !exactKeys(value.state_model, ["observer_outcome", "expected_platforms", "row_verdict", "run_status", "terminal_decision", "terminal_decision_rule"])) return false;
  if (!exactJson(value.state_model, {
    observer_outcome: ["clean", "dirty", "rejected(code)"], expected_platforms: ["macos", "linux"],
    row_verdict: ["pass", "fail"], run_status: ["valid_complete", "invalid"], terminal_decision: ["accepted", "rejected"],
    terminal_decision_rule: "present_if_and_only_if_run_status_valid_complete"
  })) return false;
  if (!record(value.source_input_digest_v1) || !exactKeys(value.source_input_digest_v1, ["domain_prefix", "entry_order", "integer_encoding", "allowed_git_modes", "frame_fields", "source_sha_hashed", "live_literal_allowed", "synthetic_literal_path"])) return false;
  if (value.source_input_digest_v1.domain_prefix !== "SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-INPUT-DIGEST\0V1\0" || value.source_input_digest_v1.entry_order !== "raw_repository_relative_utf8_bytes" || value.source_input_digest_v1.integer_encoding !== "unsigned_big_endian" || !exactJson(value.source_input_digest_v1.allowed_git_modes, ["100644", "100755"]) || value.source_input_digest_v1.source_sha_hashed !== false || value.source_input_digest_v1.live_literal_allowed !== false) return false;
  if (!record(value.schemas) || !exactKeys(value.schemas, ["frame", "row_evidence", "platform_bundle", "final_bundle", "decision", "source_input_record"])) return false;
  return Object.values(value.schemas).every(strictSchemaDescriptor) && exactJson(value.schemas, SCHEMA_DESCRIPTORS);
}

export async function loadAndValidateContract(path: string): Promise<void> {
  const bytes = new Uint8Array(await readFile(path));
  ingestJson(bytes, "catalog", validateContract);
}

const DIRECT_DEPENDENCIES = [
  { name: "cap-std", version: "4.0.2", default_features: false, features: [], source: "registry+https://github.com/rust-lang/crates.io-index" },
  { name: "gix-index", version: "0.54.0", default_features: false, features: ["sha1"], source: "registry+https://github.com/rust-lang/crates.io-index" },
  { name: "gix-status", version: "0.33.0", default_features: false, features: ["sha1", "worktree-rewrites"], source: "registry+https://github.com/rust-lang/crates.io-index" }
];

export function validateDependencyCatalog(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["schema_version", "rust_version", "git_oracle_version", "lockfile_version", "direct_dependencies", "prohibited_sources", "target_graphs"])) return false;
  if (value.schema_version !== "shud.git-status-capability.dependency-graph.v1" || value.rust_version !== "1.88.0" || value.git_oracle_version !== "2.49.0" || value.lockfile_version !== 4 || !exactJson(value.direct_dependencies, DIRECT_DEPENDENCIES) || !exactJson(value.prohibited_sources, ["git", "branch", "path", "wildcard"])) return false;
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
  const dependencyCatalog = ingestJson(new Uint8Array(await readFile(dependencyPath)), "dependency_graph", validateDependencyCatalog) as JsonRecord;
  const cargo = await readFile(join(spikeRoot, "native", "Cargo.toml"), "utf8");
  const toolchain = await readFile(join(spikeRoot, "native", "rust-toolchain.toml"), "utf8");
  const lock = await readFile(join(spikeRoot, "native", "Cargo.lock"), "utf8");
  for (const literal of [
    'rust-version = "1.88.0"',
    'cap-std = { version = "=4.0.2", default-features = false }',
    'gix-index = { version = "=0.54.0", default-features = false, features = ["sha1"] }',
    'gix-status = { version = "=0.33.0", default-features = false, features = ["sha1", "worktree-rewrites"] }'
  ]) if (!cargo.includes(literal)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  if (/\b(?:git|branch|path)\s*=|version\s*=\s*"(?:\*|[^"=]*[\^~><])/.test(cargo) || /\[lib\]|\[\[bin\]\]|\[\[example\]\]/.test(cargo) || toolchain !== '[toolchain]\nchannel = "1.88.0"\nprofile = "minimal"\ncomponents = ["cargo", "rustc", "rust-std"]\n' || !lock.startsWith("# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n") || /source = "git\+|source = "path\+/.test(lock)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
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

async function walkRegular(root: string, prefix: string, output: string[]): Promise<void> {
  const directory = join(root, ...prefix.split("/").filter(Boolean));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path.includes("/evidence/") || path.endsWith("/evidence")) continue;
    const absolute = join(root, ...path.split("/"));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (stat.isDirectory()) await walkRegular(root, path, output);
    else output.push(path);
  }
}

export async function enumerateSourceCandidates(repositoryRoot: string): Promise<string[]> {
  const candidates: string[] = [];
  const spikePrefix = "spikes/git-status-capability";
  await walkRegular(repositoryRoot, spikePrefix, candidates);
  for (const path of [
    "openspec/changes/m2-capability-observer-spike/.openspec.yaml",
    "openspec/changes/m2-capability-observer-spike/proposal.md",
    "openspec/changes/m2-capability-observer-spike/design.md",
    "openspec/changes/m2-capability-observer-spike/tasks.md",
    "openspec/changes/m2-capability-observer-spike/specs/git-status-capability-spike/spec.md"
  ]) {
    const stat = await lstat(join(repositoryRoot, ...path.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    candidates.push(path);
  }
  return candidates.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export async function validateManifest(repositoryRoot: string, manifestPath: string): Promise<number> {
  const absoluteRoot = resolve(repositoryRoot);
  const absoluteManifest = resolve(manifestPath);
  const manifestRelative = relative(absoluteRoot, absoluteManifest).split(sep).join("/");
  if (!canonicalRelativePath(manifestRelative)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const bytes = await readFile(absoluteManifest);
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
  const result = spawnSync("git", ["ls-files", "--stage", "-z", "--", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const records = result.stdout.subarray(0, result.stdout.length - (result.stdout.at(-1) === 0 ? 1 : 0)).toString("utf8").split("\0").filter(Boolean);
  const tracked: string[] = [];
  for (const record of records) {
    const match = /^(\d{6}) [0-9a-f]{40,64} (\d)\t(.+)$/.exec(record);
    if (!match || match[2] !== "0" || !["100644", "100755"].includes(match[1]!)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (!match[3]!.includes("/evidence/")) tracked.push(match[3]!);
  }
  const trackedSpike = tracked.filter((path) => path.startsWith("spikes/git-status-capability/"));
  if (trackedSpike.length === 0) return;
  const sorted = tracked.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!exactJson(sorted, candidates)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

export async function validateSyntheticGolden(spikeRoot: string): Promise<void> {
  const goldenRoot = join(spikeRoot, "contracts", "goldens");
  const names = (await readdir(goldenRoot)).sort();
  if (!exactJson(names, ["source-input-v1.synthetic.frame", "source-input-v1.synthetic.sha256"])) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const frame = await readFile(join(goldenRoot, "source-input-v1.synthetic.frame"));
  const literal = await readFile(join(goldenRoot, "source-input-v1.synthetic.sha256"), "utf8");
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

export function validateSourceInputRecord(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.source_input_record;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!gitObjectId(value.source_sha) || !sha256(value.source_input_digest) || !sha256(value.manifest_digest)) return false;
  if (!Number.isSafeInteger(value.entry_count) || (value.entry_count as number) < 0 || !Array.isArray(value.admitted_paths) || value.admitted_paths.length !== value.entry_count) return false;
  if (value.admitted_paths.some((path) => typeof path !== "string" || !canonicalRelativePath(path)) || new Set(value.admitted_paths).size !== value.admitted_paths.length) return false;
  return nonEmptyString(value.primary_encoder) && nonEmptyString(value.witness_encoder) && value.primary_encoder !== value.witness_encoder && record(value.command_receipt);
}

export function validateRowEvidence(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.row_evidence;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || typeof value.row_id !== "string" || !CATALOG_V1.some((row) => row.id === value.row_id)) return false;
  if (!outcome(value.expected_outcome) || !outcome(value.observer_outcome) || !nonEmptyString(value.producing_boundary) || !["pass", "fail"].includes(value.row_verdict as string)) return false;
  if (value.row_verdict === "pass" && !exactJson(value.expected_outcome, value.observer_outcome)) return false;
  if (!sha256(value.oracle_digest) || !record(value.tripwire_verdicts) || typeof value.protection_set_equal !== "boolean" || !record(value.cleanup) || !record(value.resource_record) || !sha256(value.source_input_record_sha256)) return false;
  if (value.first_cause !== undefined && !nonEmptyString(value.first_cause)) return false;
  return value.secondary_errors === undefined || stringArray(value.secondary_errors);
}

export function validatePlatformBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.platform_bundle;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || !["valid_complete", "invalid"].includes(value.run_status as string) || !gitObjectId(value.source_commit)) return false;
  const target = value.platform === "macos" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu";
  if (value.target !== target || !record(value.toolchain) || !Array.isArray(value.rows) || !Array.isArray(value.protection_set) || !Array.isArray(value.raw_command_manifest)) return false;
  return [
    value.source_input_record_sha256, value.catalog_digest, value.dependency_graph_digest, value.direct_feature_digest,
    value.call_ledger_digest, value.sbom_digest, value.license_inventory_digest
  ].every(sha256);
}

function terminalState(value: JsonRecord): boolean {
  if (!["valid_complete", "invalid"].includes(value.run_status as string)) return false;
  const hasDecision = Object.hasOwn(value, "terminal_decision");
  if (hasDecision !== (value.run_status === "valid_complete")) return false;
  if (hasDecision && !["accepted", "rejected"].includes(value.terminal_decision as string)) return false;
  if (value.first_cause !== undefined && !nonEmptyString(value.first_cause)) return false;
  return value.all_failure_codes === undefined || stringArray(value.all_failure_codes);
}

export function validateFinalBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.final_bundle;
  if (!matchesDescriptor(value, descriptor) || !terminalState(value) || !record(value.repository_gates)) return false;
  return [value.source_input_record_sha256, value.macos_bundle_sha256, value.linux_bundle_sha256, value.raw_evidence_digest, value.decision_projection_digest].every(sha256);
}

export function validateDecision(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.decision;
  if (!matchesDescriptor(value, descriptor) || !terminalState(value) || value.catalog_version !== 1 || !sha256(value.catalog_digest) || !sha256(value.source_input_record_sha256)) return false;
  if (!Array.isArray(value.platforms) || !exactJson(value.platforms, ["macos", "linux"]) || !Array.isArray(value.rows) || !record(value.gates)) return false;
  return true;
}

const INPUT_VALIDATORS: Record<InputKind, SchemaValidator> = {
  catalog: validateContract,
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
