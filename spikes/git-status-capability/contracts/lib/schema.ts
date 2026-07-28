import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, lstat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import {
  CATALOG_V1,
  FLOOR_V1,
  INGESTION_LIMITS,
  OBSERVER_LIMITS,
  OWNERSHIP_V1,
  REJECTION_CODES,
  SCHEMA_DESCRIPTORS,
  SOURCE_INPUT_DIGEST_V1,
  TARGET_GRAPH_EXPECTATIONS,
  TOOLCHAIN
} from "./frozen";
import { ContractError, readJsonFileBounded, type InputKind } from "./ingestion";

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
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((item, index) => exactJson(item, expected[index]));
  if (record(actual) || record(expected)) {
    if (!record(actual) || !record(expected) || !exactKeys(actual, Object.keys(expected))) return false;
    return Object.keys(expected).every((key) => exactJson(actual[key], expected[key]));
  }
  return false;
}

function outcome(value: unknown): boolean {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "rejected") return exactKeys(value, REJECTED_OUTCOME_KEYS) && typeof value.code === "string" && REJECTION_CODES.includes(value.code);
  return (value.kind === "clean" || value.kind === "dirty") && exactKeys(value, OUTCOME_KEYS);
}

function strictSchemaDescriptor(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["schema_version", "required_fields", "optional_fields", "field_types", "additional_properties"])) return false;
  return typeof value.schema_version === "string" && Array.isArray(value.required_fields) && value.required_fields.every((field) => typeof field === "string") &&
    new Set(value.required_fields).size === value.required_fields.length && Array.isArray(value.optional_fields) &&
    value.optional_fields.every((field) => typeof field === "string") && new Set(value.optional_fields).size === value.optional_fields.length && record(value.field_types) &&
    exactKeys(value.field_types, [...value.required_fields, ...value.optional_fields]) && Object.values(value.field_types).every(nonEmptyString) &&
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
  if (!exactJson(value.source_input_digest_v1, SOURCE_INPUT_DIGEST_V1)) return false;
  if (!record(value.schemas) || !exactKeys(value.schemas, ["frame", "row_evidence", "platform_bundle", "final_bundle", "decision", "source_input_record"])) return false;
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
  if (!record(value) || !exactKeys(value, ["schema_version", "rust_version", "git_oracle_version", "lockfile_version", "direct_dependencies", "prohibited_sources", "target_graphs"])) return false;
  if (value.schema_version !== "shud.git-status-capability.dependency-graph.v1" || value.rust_version !== "1.88.0" || value.git_oracle_version !== "2.49.0" || value.lockfile_version !== 4 || !exactJson(value.direct_dependencies, DIRECT_DEPENDENCIES) || !exactJson(value.prohibited_sources, ["git", "branch", "path", "wildcard"])) return false;
  if (!record(value.target_graphs) || !exactKeys(value.target_graphs, ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"])) return false;
  for (const [target, graphValue] of Object.entries(value.target_graphs)) {
    const expected = TARGET_GRAPH_EXPECTATIONS[target as keyof typeof TARGET_GRAPH_EXPECTATIONS];
    if (!record(graphValue) || !exactKeys(graphValue, ["target", "packages", "edges", "activated_features", "allowed_target_predicates", "registry_source", "graph_digest"]) || graphValue.target !== target || graphValue.registry_source !== "registry+https://github.com/rust-lang/crates.io-index" || !Array.isArray(graphValue.packages) || !Array.isArray(graphValue.edges) || !Array.isArray(graphValue.activated_features) || !Array.isArray(graphValue.allowed_target_predicates) || typeof graphValue.graph_digest !== "string") return false;
    if (!expected || graphValue.packages.length !== expected.packages || graphValue.edges.length !== expected.edges || graphValue.allowed_target_predicates.length !== expected.predicates || graphValue.graph_digest !== expected.graph_digest) return false;
    if (new Set(graphValue.packages).size !== graphValue.packages.length || new Set(graphValue.edges).size !== graphValue.edges.length) return false;
    const packageCoordinates = new Set<string>();
    for (const pkg of graphValue.packages) {
      if (typeof pkg !== "string" || !/^[A-Za-z0-9_.-]+@[0-9][A-Za-z0-9.+-]*#[0-9a-f]{64}$/.test(pkg)) return false;
      packageCoordinates.add(pkg.slice(0, pkg.lastIndexOf("#")));
    }
    if (graphValue.activated_features.length !== graphValue.packages.length) return false;
    for (let index = 0; index < graphValue.activated_features.length; index += 1) {
      const activation = graphValue.activated_features[index];
      if (!record(activation) || !exactKeys(activation, ["package", "features"]) || activation.package !== (graphValue.packages[index] as string).slice(0, (graphValue.packages[index] as string).lastIndexOf("#")) || !Array.isArray(activation.features) || activation.features.some((feature) => typeof feature !== "string") || new Set(activation.features).size !== activation.features.length || !exactJson(activation.features, [...activation.features].sort())) return false;
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
    const digest = createHash("sha256").update(JSON.stringify({ packages: graphValue.packages, edges: graphValue.edges, activated_features: graphValue.activated_features })).digest("hex");
    if (graphValue.graph_digest !== digest) return false;
  }
  return true;
}

export async function validateSupplyFiles(spikeRoot: string): Promise<void> {
  const dependencyPath = join(spikeRoot, "dependency-graph-catalog.json");
  const dependencyCatalog = await readJsonFileBounded(dependencyPath, "dependency_graph", validateDependencyCatalog) as JsonRecord;
  const cargo = await readFile(join(spikeRoot, "native", "Cargo.toml"), "utf8");
  const toolchain = await readFile(join(spikeRoot, "native", "rust-toolchain.toml"), "utf8");
  const lock = await readFile(join(spikeRoot, "native", "Cargo.lock"), "utf8");
  const exactCargo = `[package]\nname = "shud-git-status-capability-spike"\nversion = "0.0.0"\nedition = "2024"\nrust-version = "1.88.0"\npublish = false\n\n[dependencies]\ncap-std = { version = "=4.0.2", default-features = false }\ngix-index = { version = "=0.54.0", default-features = false, features = ["sha1"] }\ngix-status = { version = "=0.33.0", default-features = false, features = ["sha1", "worktree-rewrites"] }\n`;
  if (cargo !== exactCargo || toolchain !== '[toolchain]\nchannel = "1.88.0"\nprofile = "minimal"\ncomponents = ["cargo", "rustc", "rust-std"]\n' || createHash("sha256").update(lock).digest("hex") !== "0b464510a35a2812bdc3fd5960d98a350baa949019ce7181ef01a4eb8195c02a" || !lock.startsWith("# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n") || /source = "git\+|source = "path\+/.test(lock)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
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
    if (path === "openspec/changes/m2-capability-observer-spike/evidence" || path.startsWith("openspec/changes/m2-capability-observer-spike/evidence/")) continue;
    const absolute = join(root, ...path.split("/"));
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (stat.isDirectory()) await walkRegular(root, path, output);
    else output.push(path);
  }
}

async function walkSpecs(root: string, prefix: string, output: string[]): Promise<void> {
  const directory = join(root, ...prefix.split("/"));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    const stat = await lstat(join(root, ...path.split("/")));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    if (stat.isDirectory()) await walkSpecs(root, path, output);
    else if (entry.name === "spec.md") output.push(path);
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
    "openspec/changes/m2-capability-observer-spike/tasks.md"
  ]) {
    const stat = await lstat(join(repositoryRoot, ...path.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    candidates.push(path);
  }
  await walkSpecs(repositoryRoot, "openspec/changes/m2-capability-observer-spike/specs", candidates);
  const workflow = ".github/workflows/git-status-capability-spike.yml";
  try {
    const stat = await lstat(join(repositoryRoot, ...workflow.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ContractError("CONTRACT_SCHEMA_INVALID");
    candidates.push(workflow);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ContractError("CONTRACT_SCHEMA_INVALID");
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
  const result = spawnSync("git", ["ls-files", "--stage", "-z", "--", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike", ".github/workflows/git-status-capability-spike.yml"], {
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
    if (!match[3]!.startsWith("openspec/changes/m2-capability-observer-spike/evidence/")) tracked.push(match[3]!);
  }
  const trackedSpike = tracked.filter((path) => path.startsWith("spikes/git-status-capability/"));
  if (trackedSpike.length === 0) throw new ContractError("CONTRACT_SCHEMA_INVALID");
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

function sortedUniqueStrings(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(nonEmptyString) &&
    new Set(value).size === value.length && exactJson(value, [...value].sort());
}

function admittedPath(value: unknown): boolean {
  return record(value) && exactKeys(value, ["path", "git_mode"]) && typeof value.path === "string" &&
    canonicalRelativePath(value.path) && ["100644", "100755"].includes(value.git_mode as string);
}

function admittedPathSet(value: unknown, count: number): boolean {
  if (!Array.isArray(value) || value.length !== count || !value.every(admittedPath)) return false;
  const keys = value.map((entry) => `${entry.path}\0${entry.git_mode}`);
  return new Set(value.map((entry) => entry.path)).size === value.length && new Set(keys).size === keys.length &&
    exactJson(value.map((entry) => entry.path), [...value.map((entry) => entry.path)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))));
}

function encoderResult(value: unknown, count: number, expectedPaths: unknown): boolean {
  return record(value) && exactKeys(value, ["source_input_digest", "manifest_digest", "entry_count", "admitted_paths"]) &&
    sha256(value.source_input_digest) && sha256(value.manifest_digest) && value.entry_count === count &&
    admittedPathSet(value.admitted_paths, count) && exactJson(value.admitted_paths, expectedPaths);
}

function encoderRecord(value: unknown, count: number, expectedPaths: unknown): boolean {
  return record(value) && exactKeys(value, ["identity", "result"]) && nonEmptyString(value.identity) && encoderResult(value.result, count, expectedPaths);
}

function executionReceipt(value: unknown): boolean {
  return record(value) && exactKeys(value, ["argv", "tool_version", "exit_code"]) &&
    stringArray(value.argv) && value.argv.length > 0 && nonEmptyString(value.tool_version) && value.exit_code === 0;
}

function sourceCommandArgv(value: unknown, sourceSha: unknown, recordOption: "--record" | "--verify-record", terminalOption: "--create" | "--no-write"): boolean {
  if (!Array.isArray(value) || value.length !== 15 || !value.every((item) => typeof item === "string")) return false;
  const expectedPrefix = [
    "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", sourceSha,
    "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
    "--witness", "source-input-witness-v1", recordOption
  ];
  return exactJson(value.slice(0, 13), expectedPrefix) && nonEmptyString(value[13]) &&
    (value[13] as string).endsWith("/source-input-record.json") && value[14] === terminalOption;
}

function sourceCommandReceipt(value: unknown, sourceSha: unknown): boolean {
  return record(value) && exactKeys(value, ["argv", "version", "exit_code"]) && value.version === "1" && value.exit_code === 0 &&
    sourceCommandArgv(value.argv, sourceSha, "--record", "--create");
}

function sourceGateReceipt(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["argv", "tool_version", "exit_code", "summary_digest", "source_input_record_sha256"]) ||
    !Array.isArray(value.argv) || !gitObjectId(value.argv[5]) || value.tool_version !== "1" || value.exit_code !== 0 ||
    !sha256(value.summary_digest) || !sha256(value.source_input_record_sha256)) return false;
  return sourceCommandArgv(value.argv, value.argv[5], "--verify-record", "--no-write");
}

function boundedInteger(value: unknown, maximum: number, allowZero = true): value is number {
  return Number.isSafeInteger(value) && (allowZero ? (value as number) >= 0 : (value as number) > 0) && (value as number) <= maximum;
}

function digestSizedBytes(value: unknown, maximum: number): boolean {
  return record(value) && exactKeys(value, ["byte_length", "digest"]) && boundedInteger(value.byte_length, maximum) && sha256(value.digest);
}

function framePath(value: unknown): value is string {
  return typeof value === "string" && canonicalRelativePath(value) && Buffer.byteLength(value) <= OBSERVER_LIMITS.path_bytes &&
    value.split("/").length <= OBSERVER_LIMITS.path_depth;
}

function unsigned(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function indexStat(value: unknown): boolean {
  return record(value) && exactKeys(value, [
    "ctime_seconds", "ctime_nanoseconds", "mtime_seconds", "mtime_nanoseconds", "device", "inode", "uid", "gid", "size"
  ]) && unsigned(value.ctime_seconds) && unsigned(value.mtime_seconds) && unsigned(value.device) && unsigned(value.inode) &&
    unsigned(value.uid) && unsigned(value.gid) && unsigned(value.size) && unsigned(value.ctime_nanoseconds) &&
    unsigned(value.mtime_nanoseconds) && (value.ctime_nanoseconds as number) < 1_000_000_000 &&
    (value.mtime_nanoseconds as number) < 1_000_000_000;
}

function indexFlags(value: unknown): boolean {
  return record(value) && exactKeys(value, ["assume_unchanged", "skip_worktree", "intent_to_add", "fsmonitor_valid"]) &&
    Object.values(value).every((flag) => typeof flag === "boolean");
}

function indexEntry(value: unknown, gitlinkOnly = false): boolean {
  if (!record(value) || !exactKeys(value, ["path", "stage", "mode", "object_id", "stat", "flags"]) || !framePath(value.path) ||
    !Number.isInteger(value.stage) || (value.stage as number) < 0 || (value.stage as number) > 4 ||
    !["100644", "100755", "120000", "160000"].includes(value.mode as string) || !gitObjectId(value.object_id) || !indexFlags(value.flags)) return false;
  if (gitlinkOnly && value.mode !== "160000") return false;
  return value.stage === 0 ? indexStat(value.stat) : value.stat === null;
}

function comparePathStage(left: JsonRecord, right: JsonRecord): number {
  const pathOrder = Buffer.from(left.path as string).compare(Buffer.from(right.path as string));
  return pathOrder || (left.stage as number) - (right.stage as number);
}

function indexEntrySet(value: unknown, maximum = OBSERVER_LIMITS.index_entries): value is JsonRecord[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((entry) => indexEntry(entry))) return false;
  const keys = value.map((entry) => `${entry.path}\0${entry.stage}`);
  return new Set(keys).size === keys.length && value.every((entry, index) => index === 0 || comparePathStage(value[index - 1]!, entry) < 0);
}

function sortedPathSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(framePath) && new Set(value).size === value.length &&
    value.every((path, index) => index === 0 || Buffer.from(value[index - 1]!).compare(Buffer.from(path)) < 0);
}

function inlineByteMaterial(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["kind", "byte_length", "digest", "content_base64"]) ||
    value.kind !== "inline-bytes-v1" || !boundedInteger(value.byte_length, OBSERVER_LIMITS.index_bytes, false) ||
    !sha256(value.digest) || typeof value.content_base64 !== "string") return false;
  const bytes = Buffer.from(value.content_base64, "base64");
  return bytes.toString("base64") === value.content_base64 && bytes.length === value.byte_length &&
    createHash("sha256").update(bytes).digest("hex") === value.digest;
}

function repeatedIndexByteMaterial(value: unknown): boolean {
  return record(value) && exactKeys(value, ["kind", "byte", "byte_length", "digest"]) && value.kind === "repeat-byte-v1" &&
    value.byte === 0 && value.byte_length === OBSERVER_LIMITS.index_bytes + 1 &&
    value.digest === "8996de63e472cbfe218412fd3512ad6d908f83119f02c439fbc16446d6d9e5db";
}

function materialIndex(value: JsonRecord): boolean {
  if (!exactKeys(value, ["state", "primary", "shared_index"]) || value.state !== "material" ||
    (!inlineByteMaterial(value.primary) && !repeatedIndexByteMaterial(value.primary)) || !record(value.shared_index)) return false;
  const shared = value.shared_index;
  return (exactKeys(shared, ["state"]) && shared.state === "absent") ||
    (exactKeys(shared, ["state", "material"]) && shared.state === "present" && inlineByteMaterial(shared.material));
}

function frameIndex(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.state === "material") return materialIndex(value);
  if (!exactKeys(value, [
    "state", "format_version", "byte_length", "digest", "entry_count", "entries", "effective_entries", "extensions", "shared_index"
  ]) || value.state !== "parsed" || ![2, 4].includes(value.format_version as number) ||
    !boundedInteger(value.byte_length, OBSERVER_LIMITS.index_bytes, false) ||
    !sha256(value.digest) || !boundedInteger(value.entry_count, OBSERVER_LIMITS.index_entries) || !indexEntrySet(value.entries) ||
    !indexEntrySet(value.effective_entries) || value.entry_count !== value.effective_entries.length || !Array.isArray(value.extensions)) return false;
  if (!value.extensions.every((extension) => record(extension) && exactKeys(extension, ["signature", "byte_length", "digest"]) &&
    typeof extension.signature === "string" && /^[A-Za-z][A-Za-z0-9 ]{3}$/.test(extension.signature) &&
    boundedInteger(extension.byte_length, OBSERVER_LIMITS.index_bytes) && sha256(extension.digest))) return false;
  const extensionKeys = value.extensions.map((extension) => (extension as JsonRecord).signature as string);
  if (new Set(extensionKeys).size !== extensionKeys.length || !exactJson(extensionKeys, [...extensionKeys].sort())) return false;
  const shared = value.shared_index;
  if (!record(shared)) return false;
  if (exactKeys(shared, ["state"]) && shared.state === "absent") {
    return !extensionKeys.includes("link") && exactJson(value.effective_entries, value.entries);
  }
  if (!exactKeys(shared, ["state", "byte_length", "digest", "entries", "deleted_paths", "replaced_paths"]) || shared.state !== "present" ||
    !digestSizedBytes({ byte_length: shared.byte_length, digest: shared.digest }, OBSERVER_LIMITS.index_bytes) || !indexEntrySet(shared.entries) ||
    !sortedPathSet(shared.deleted_paths) || !sortedPathSet(shared.replaced_paths) || !extensionKeys.includes("link")) return false;
  const deleted = new Set(shared.deleted_paths as string[]);
  const replaced = new Set(shared.replaced_paths as string[]);
  if ([...deleted].some((path) => replaced.has(path))) return false;
  const sharedPaths = new Set((shared.entries as JsonRecord[]).map((entry) => entry.path as string));
  const localPaths = new Set((value.entries as JsonRecord[]).map((entry) => entry.path as string));
  if ([...deleted].some((path) => !sharedPaths.has(path) || localPaths.has(path)) ||
    [...replaced].some((path) => !sharedPaths.has(path) || !localPaths.has(path))) return false;
  const expected = [...(shared.entries as JsonRecord[]).filter((entry) => !deleted.has(entry.path as string) && !replaced.has(entry.path as string)),
    ...(value.entries as JsonRecord[])].sort(comparePathStage);
  return exactJson(value.effective_entries, expected);
}

function limitStimulus(value: unknown, rowId: string): boolean {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "repeat-byte-v1") {
    return exactKeys(value, ["kind", "byte", "byte_length", "digest"]) && value.byte === 0 &&
      rowId === "LIM-016" && value.byte_length === OBSERVER_LIMITS.hashed_bytes + 1 &&
      value.digest === "da6ce8755151acd05195db67ebce3ee0fb5f4012e71e821cc5750f3304eaf41e";
  }
  if (value.kind === "index-entry-series-v1") {
    return exactKeys(value, ["kind", "count", "path_prefix", "object_id"]) &&
      rowId === "LIM-006" && value.count === OBSERVER_LIMITS.index_entries + 1 && value.path_prefix === "limit-index-" && gitObjectId(value.object_id);
  }
  if (value.kind === "nested-repository-series-v1") {
    return exactKeys(value, ["kind", "count", "path_prefix", "object_id"]) &&
      rowId === "LIM-012" && value.count === OBSERVER_LIMITS.nested_repositories + 1 && value.path_prefix === "limit-nested-" && gitObjectId(value.object_id);
  }
  if (value.kind === "tree-entry-series-v1") {
    return exactKeys(value, ["kind", "count", "path_prefix", "mode", "object_id"]) &&
      rowId === "LIM-014" && value.count === OBSERVER_LIMITS.traversal_entries + 1 && value.path_prefix === "limit-tree-" &&
      value.mode === "100644" && gitObjectId(value.object_id);
  }
  if (value.kind !== "path-material-v1" || !exactKeys(value, ["kind", "byte_length", "digest", "content_base64"]) ||
    !sha256(value.digest) || typeof value.content_base64 !== "string") return false;
  const bytes = Buffer.from(value.content_base64, "base64");
  if (bytes.toString("base64") !== value.content_base64 || bytes.length !== value.byte_length ||
    createHash("sha256").update(bytes).digest("hex") !== value.digest) return false;
  const path = bytes.toString("utf8");
  return canonicalRelativePath(path) && ((rowId === "LIM-008" && path === "x".repeat(OBSERVER_LIMITS.path_bytes + 1)) ||
    (rowId === "LIM-010" && path === Array.from({ length: OBSERVER_LIMITS.path_depth + 1 }, () => "x").join("/")));
}

const LIMIT_STIMULUS_ROWS = new Set(["LIM-006", "LIM-008", "LIM-010", "LIM-012", "LIM-014", "LIM-016"]);

function indexMaterialRowConsistency(index: unknown, rowId: string): boolean {
  if (!record(index) || index.state !== "material") return true;
  return repeatedIndexByteMaterial(index.primary)
    ? ["IDX-011", "LIM-004"].includes(rowId)
    : ["IDX-007", "IDX-008", "IDX-009", "IDX-010", "IDX-020"].includes(rowId);
}

function treeEntry(value: unknown): boolean {
  return record(value) && exactKeys(value, ["path", "mode", "object_id"]) && framePath(value.path) &&
    ["100644", "100755", "120000", "160000"].includes(value.mode as string) && gitObjectId(value.object_id);
}

function treeEntrySet(value: unknown): value is JsonRecord[] {
  return Array.isArray(value) && value.length <= OBSERVER_LIMITS.traversal_entries && value.every(treeEntry) &&
    new Set(value.map((entry) => entry.path)).size === value.length &&
    value.every((entry, index) => index === 0 || Buffer.from(value[index - 1]!.path as string).compare(Buffer.from(entry.path as string)) < 0);
}

function headTree(value: unknown): boolean {
  if (!record(value) || !Object.hasOwn(value, "state") || !Object.hasOwn(value, "entry_count") || !Object.hasOwn(value, "entries") ||
    !treeEntrySet(value.entries) || value.entry_count !== value.entries.length) return false;
  return (exactKeys(value, ["state", "entry_count", "entries"]) && value.state === "unborn" && value.entry_count === 0) ||
    (exactKeys(value, ["state", "object_id", "entry_count", "entries"]) && value.state === "present" && gitObjectId(value.object_id));
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function frameConfig(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["digest", "entries"]) || !sha256(value.digest) || !Array.isArray(value.entries)) return false;
  const entries = value.entries;
  if (!entries.every((entry) => record(entry) && exactKeys(entry, ["scope", "key", "value", "origin"]) &&
    ["local", "worktree", "include"].includes(entry.scope as string) && nonEmptyString(entry.key) && typeof entry.value === "string" &&
    framePath(entry.origin))) return false;
  const keys = entries.map((entry) => `${entry.scope}\0${entry.key}\0${entry.origin}`);
  return new Set(keys).size === keys.length && exactJson(keys, [...keys].sort()) && value.digest === canonicalDigest(entries);
}

function framePathState(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["digest", "sources"]) || !sha256(value.digest) || !Array.isArray(value.sources)) return false;
  let totalBytes = 0;
  const paths: string[] = [];
  for (const source of value.sources) {
    if (!record(source) || !exactKeys(source, ["path", "byte_length", "digest", "content_base64"]) || !framePath(source.path) ||
      !boundedInteger(source.byte_length, OBSERVER_LIMITS.hashed_bytes) || !sha256(source.digest) || typeof source.content_base64 !== "string") return false;
    const bytes = Buffer.from(source.content_base64, "base64");
    if (bytes.toString("base64") !== source.content_base64) return false;
    if (bytes.length !== source.byte_length || createHash("sha256").update(bytes).digest("hex") !== source.digest) return false;
    totalBytes += bytes.length;
    if (totalBytes > OBSERVER_LIMITS.hashed_bytes) return false;
    paths.push(source.path);
  }
  return new Set(paths).size === paths.length && paths.every((path, index) => index === 0 || Buffer.from(paths[index - 1]!).compare(Buffer.from(path)) < 0) &&
    value.digest === canonicalDigest(value.sources);
}

function gitlink(value: unknown): boolean {
  return record(value) && exactKeys(value, ["path", "stage", "mode", "object_id"]) && framePath(value.path) &&
    Number.isInteger(value.stage) && (value.stage as number) >= 0 && (value.stage as number) <= 4 &&
    value.mode === "160000" && gitObjectId(value.object_id);
}

function nestedFrameState(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["path", "relation", "gitlink", "checkout_state", "audit"]) || !framePath(value.path) ||
    !["direct", "recursive"].includes(value.relation as string) || !gitlink(value.gitlink) ||
    !record(value.gitlink) || value.gitlink.path !== value.path || !record(value.audit) || value.audit.state !== value.checkout_state) return false;
  const audit = value.audit;
  if (value.checkout_state === "initialized") {
    return exactKeys(audit, ["state", "directory_identity", "index", "head_tree", "effective_config", "exclude_state", "attribute_state"]) &&
      sha256(audit.directory_identity) && frameIndex(audit.index) && headTree(audit.head_tree) && frameConfig(audit.effective_config) &&
      framePathState(audit.exclude_state) && framePathState(audit.attribute_state);
  }
  const basename = (value.path as string).split("/").at(-1);
  if (value.checkout_state === "deinitialized") {
    return exactKeys(audit, ["state", "parent_identity", "basename", "directory_identity"]) && sha256(audit.parent_identity) &&
      audit.basename === basename && sha256(audit.directory_identity);
  }
  return value.checkout_state === "absent" && exactKeys(audit, ["state", "parent_identity", "basename"]) &&
    sha256(audit.parent_identity) && audit.basename === basename;
}

function frameBody(value: JsonRecord): JsonRecord {
  const body: JsonRecord = {
    index: value.index,
    head_tree: value.head_tree,
    effective_config: value.effective_config,
    exclude_state: value.exclude_state,
    attribute_state: value.attribute_state,
    nested_state: value.nested_state
  };
  if (Object.hasOwn(value, "limit_stimulus")) body.limit_stimulus = value.limit_stimulus;
  return body;
}

function effectiveIndexEntries(value: unknown): JsonRecord[] | null {
  return record(value) && value.state === "parsed" && Array.isArray(value.effective_entries)
    ? value.effective_entries as JsonRecord[] : null;
}

function matchingParentGitlink(entries: JsonRecord[] | null, path: string, nested: JsonRecord): boolean {
  if (!entries) return false;
  const parent = entries.find((entry) => entry.path === path && entry.stage === 0);
  const link = nested.gitlink as JsonRecord;
  return !!parent && parent.mode === "160000" && parent.object_id === link.object_id && link.stage === 0 && link.mode === "160000";
}

function nestedParentConsistency(rootIndex: unknown, nestedState: JsonRecord[]): boolean {
  const rootEntries = effectiveIndexEntries(rootIndex);
  for (const nested of nestedState) {
    const path = nested.path as string;
    if (nested.relation === "direct") {
      if (!matchingParentGitlink(rootEntries, path, nested)) return false;
      continue;
    }
    const ancestors = nestedState.filter((candidate) => candidate.checkout_state === "initialized" &&
      path.startsWith(`${candidate.path as string}/`)).sort((left, right) => (right.path as string).length - (left.path as string).length);
    const parent = ancestors[0];
    if (!parent) return false;
    const relativePath = path.slice((parent.path as string).length + 1);
    const audit = parent.audit as JsonRecord;
    if (!matchingParentGitlink(effectiveIndexEntries(audit.index), relativePath, nested)) return false;
  }
  return true;
}

function frameHeader(value: JsonRecord): JsonRecord {
  return {
    schema_version: value.schema_version,
    catalog_version: value.catalog_version,
    row_id: value.row_id,
    observation_id: value.observation_id,
    checkout_capability_identity: value.checkout_capability_identity,
    git_state_generation_digest: value.git_state_generation_digest,
    body_length: value.body_length,
    body_digest: value.body_digest
  };
}

export function validateFrame(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.frame;
  const hasLimitStimulus = record(value) && Object.hasOwn(value, "limit_stimulus");
  if (!matchesDescriptor(value, descriptor) || value.catalog_version !== 1 || typeof value.row_id !== "string" ||
    !CATALOG_V1.some((row) => row.id === value.row_id) || !sha256(value.observation_id) || !sha256(value.checkout_capability_identity) ||
    !sha256(value.git_state_generation_digest) || !boundedInteger(value.body_length, OBSERVER_LIMITS.frame_bytes, false) ||
    !sha256(value.body_digest) || !sha256(value.checksum) || !frameIndex(value.index) || !headTree(value.head_tree) ||
    !frameConfig(value.effective_config) || !framePathState(value.exclude_state) || !framePathState(value.attribute_state) ||
    !Array.isArray(value.nested_state) || value.nested_state.length > OBSERVER_LIMITS.nested_repositories ||
    !value.nested_state.every(nestedFrameState) || !indexMaterialRowConsistency(value.index, value.row_id) ||
    (hasLimitStimulus !== LIMIT_STIMULUS_ROWS.has(value.row_id)) ||
    (hasLimitStimulus && !limitStimulus(value.limit_stimulus, value.row_id))) return false;
  const nestedPaths = value.nested_state.map((nested) => (nested as JsonRecord).path as string);
  if (new Set(nestedPaths).size !== nestedPaths.length || !nestedPaths.every((path, index) => index === 0 || Buffer.from(nestedPaths[index - 1]!).compare(Buffer.from(path)) < 0)) return false;
  if (!nestedParentConsistency(value.index, value.nested_state as JsonRecord[])) return false;
  const body = frameBody(value);
  const bodyBytes = JSON.stringify(body);
  const bodyDigest = canonicalDigest(body);
  return value.body_length === Buffer.byteLength(bodyBytes) && value.body_digest === bodyDigest &&
    value.git_state_generation_digest === bodyDigest && value.checksum === canonicalDigest({ header: frameHeader(value), body });
}

export function deriveFrameComparisonInputs(value: unknown): JsonRecord {
  if (!validateFrame(value)) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  const frame = value as JsonRecord;
  const index = frame.index as JsonRecord;
  const head = frame.head_tree as JsonRecord;
  const clone = <T>(item: T): T => structuredClone(item);
  const pathPolicy = {
    effective_config: clone((frame.effective_config as JsonRecord).entries),
    exclude_sources: clone((frame.exclude_state as JsonRecord).sources),
    attribute_sources: clone((frame.attribute_state as JsonRecord).sources)
  };
  const stimulus = Object.hasOwn(frame, "limit_stimulus") ? { limit_stimulus: clone(frame.limit_stimulus) } : {};
  if (index.state === "material") {
    return {
      baseline: null,
      staged: null,
      index: clone(index),
      path_policy: pathPolicy,
      ...stimulus
    };
  }
  const shared = index.shared_index as JsonRecord;
  return {
    baseline: {
      tracked_entries: clone((index.effective_entries as JsonRecord[]).filter((entry) => entry.stage === 0)),
      head_tree_entries: clone(head.entries)
    },
    staged: { index_entries: clone(index.effective_entries), head_tree_entries: clone(head.entries) },
    index: {
      state: "parsed",
      format_version: index.format_version,
      primary_entries: clone(index.entries),
      shared_entries: clone(shared.state === "present" ? shared.entries : []),
      effective_entries: clone(index.effective_entries)
    },
    path_policy: pathPolicy,
    ...stimulus
  };
}

function validateSchema(value: unknown): boolean {
  return validateFrame(value);
}

export function validateSourceInputRecord(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.source_input_record;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!gitObjectId(value.source_sha) || !sha256(value.source_input_digest) || !sha256(value.manifest_digest)) return false;
  if (!Number.isSafeInteger(value.entry_count) || (value.entry_count as number) <= 0 || !admittedPathSet(value.admitted_paths, value.entry_count as number)) return false;
  if (!encoderRecord(value.primary_encoder, value.entry_count as number, value.admitted_paths) || !encoderRecord(value.witness_encoder, value.entry_count as number, value.admitted_paths)) return false;
  const primary = value.primary_encoder as JsonRecord;
  const witness = value.witness_encoder as JsonRecord;
  if (primary.identity !== "source-input-primary-v1" || witness.identity !== "source-input-witness-v1" || !exactJson(primary.result, witness.result)) return false;
  const result = primary.result as JsonRecord;
  return result.source_input_digest === value.source_input_digest && result.manifest_digest === value.manifest_digest && sourceCommandReceipt(value.command_receipt, value.source_sha);
}

const ROW_RESOURCE_LIMITS = Object.freeze([
  "frame_bytes", "index_bytes", "index_entries", "path_bytes", "path_depth", "nested_repositories",
  "traversal_entries", "hashed_bytes", "wall_time_ms", "cpu_time_ms", "threads", "memory_bytes", "output_bytes"
]);

function rowResourceRecord(value: unknown, rowId: string): boolean {
  if (!record(value) || !exactKeys(value, ["boundary_class", "declared_limit", "within_limits"])) return false;
  const match = /^LIM-(\d{3})$/.exec(rowId);
  if (!match) return value.boundary_class === "below" && value.declared_limit === "none" && value.within_limits === true;
  const ordinal = Number(match[1]);
  const declaredLimit = ROW_RESOURCE_LIMITS[Math.floor((ordinal - 1) / 2)];
  if (!declaredLimit) return false;
  const exceeded = ordinal % 2 === 0;
  return value.boundary_class === (exceeded ? "exceeded" : "exact") && value.declared_limit === declaredLimit &&
    value.within_limits === !exceeded;
}

export function validateRowEvidence(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.row_evidence;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || typeof value.row_id !== "string" || !CATALOG_V1.some((row) => row.id === value.row_id)) return false;
  const catalog = CATALOG_V1.find((row) => row.id === value.row_id);
  const frozenExpected = value.platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
  if (!outcome(value.expected_outcome) || !exactJson(value.expected_outcome, frozenExpected) || !outcome(value.observer_outcome) || !nonEmptyString(value.producing_boundary) || !["pass", "fail"].includes(value.row_verdict as string)) return false;
  if (![value.observation_id, value.checkout_capability_identity, value.git_state_generation_digest, value.frame_digest].every(sha256)) return false;
  if (!record(value.frame_binding) || !exactKeys(value.frame_binding, [
    "row_id", "observation_id", "checkout_capability_identity", "git_state_generation_digest",
    "frame_length", "frame_digest", "payload_length", "payload_digest", "canonical_body_length", "canonical_body_digest"
  ]) || value.frame_binding.row_id !== value.row_id || value.frame_binding.observation_id !== value.observation_id ||
    value.frame_binding.checkout_capability_identity !== value.checkout_capability_identity ||
    value.frame_binding.git_state_generation_digest !== value.git_state_generation_digest ||
    value.frame_binding.frame_digest !== value.frame_digest || !boundedInteger(value.frame_binding.frame_length, OBSERVER_LIMITS.frame_bytes, false) ||
    !boundedInteger(value.frame_binding.payload_length, (value.frame_binding.frame_length as number) - 1, false) ||
    !boundedInteger(value.frame_binding.canonical_body_length, (value.frame_binding.frame_length as number) - 1, false) ||
    value.frame_binding.payload_length !== value.frame_binding.canonical_body_length || !sha256(value.frame_binding.payload_digest) ||
    !sha256(value.frame_binding.canonical_body_digest) || value.frame_binding.payload_digest !== value.frame_binding.canonical_body_digest ||
    value.frame_binding.payload_digest !== value.git_state_generation_digest) return false;
  if (!sha256(value.oracle_digest) || value.oracle_verdict !== "pass" || !record(value.tripwire_verdicts) || !exactKeys(value.tripwire_verdicts, ["ambient_path", "subprocess", "protected_write"]) || !Object.values(value.tripwire_verdicts).every((item) => item === true) || value.protection_set_equal !== true) return false;
  if (!record(value.cleanup) || !exactKeys(value.cleanup, ["verdict", "descriptors_restored", "processes_reaped", "secondary_errors"]) || value.cleanup.verdict !== "pass" || value.cleanup.descriptors_restored !== true || value.cleanup.processes_reaped !== true || !Array.isArray(value.cleanup.secondary_errors) || !value.cleanup.secondary_errors.every(nonEmptyString)) return false;
  if (!rowResourceRecord(value.resource_record, value.row_id as string) || !sha256(value.source_input_record_sha256)) return false;
  const shouldPass = exactJson(value.expected_outcome, value.observer_outcome);
  if ((value.row_verdict === "pass") !== shouldPass) return false;
  if (value.first_cause !== undefined && !nonEmptyString(value.first_cause)) return false;
  return value.secondary_errors === undefined || stringArray(value.secondary_errors);
}

export function validatePlatformBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.platform_bundle;
  if (!matchesDescriptor(value, descriptor)) return false;
  if (!["macos", "linux"].includes(value.platform as string) || !["valid_complete", "invalid"].includes(value.run_status as string) || !gitObjectId(value.source_commit)) return false;
  const target = value.platform === "macos" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu";
  if (value.target !== target || !record(value.toolchain) || !exactKeys(value.toolchain, ["rustc_vv", "cargo_version", "git_version", "target_triple"]) || !Object.values(value.toolchain).every(nonEmptyString) || value.toolchain.target_triple !== target) return false;
  if (!Array.isArray(value.rows) || !value.rows.every(validateRowEvidence) || !Array.isArray(value.protection_set) || !value.protection_set.every((item) => record(item) && exactKeys(item, ["identity", "pre_digest", "post_digest", "event_digest"]) && Object.values(item).every(sha256)) || !Array.isArray(value.raw_command_manifest) || !value.raw_command_manifest.every(executionReceipt)) return false;
  if (value.rows.some((row) => (row as JsonRecord).platform !== value.platform || (row as JsonRecord).source_input_record_sha256 !== value.source_input_record_sha256)) return false;
  if (value.run_status === "valid_complete" && (value.rows.length !== 174 || new Set(value.rows.map((row) => (row as JsonRecord).row_id)).size !== 174 ||
    new Set(value.rows.map((row) => (row as JsonRecord).observation_id)).size !== 174 || new Set(value.rows.map((row) => (row as JsonRecord).frame_digest)).size !== 174 ||
    value.protection_set.length === 0 || value.raw_command_manifest.length === 0)) return false;
  if (value.run_status === "invalid") {
    if (!nonEmptyString(value.first_cause) || !sortedUniqueStrings(value.all_failure_codes) || !(value.all_failure_codes as string[]).includes(value.first_cause)) return false;
  } else if (value.first_cause !== undefined || value.all_failure_codes !== undefined) return false;
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
  if (value.run_status === "invalid" || value.terminal_decision === "rejected") {
    return nonEmptyString(value.first_cause) && sortedUniqueStrings(value.all_failure_codes) && (value.all_failure_codes as string[]).includes(value.first_cause);
  }
  return value.first_cause === undefined && value.all_failure_codes === undefined;
}

export function validateFinalBundle(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.final_bundle;
  if (!matchesDescriptor(value, descriptor) || !terminalState(value) || !record(value.repository_gates) || Object.keys(value.repository_gates).length === 0 || !Object.values(value.repository_gates).every((gate) => record(gate) && exactKeys(gate, ["argv", "tool_version", "exit_code", "summary_digest", "source_input_record_sha256"]) && stringArray(gate.argv) && nonEmptyString(gate.tool_version) && gate.exit_code === 0 && sha256(gate.summary_digest) && sha256(gate.source_input_record_sha256))) return false;
  if (Object.values(value.repository_gates).some((gate) => (gate as JsonRecord).source_input_record_sha256 !== value.source_input_record_sha256)) return false;
  if (!Object.hasOwn(value.repository_gates, "GATE-SOURCE-INPUT") || !sourceGateReceipt(value.repository_gates["GATE-SOURCE-INPUT"])) return false;
  return [value.source_input_record_sha256, value.macos_bundle_sha256, value.linux_bundle_sha256, value.raw_evidence_digest, value.decision_projection_digest].every(sha256);
}

export function validateDecision(value: unknown): boolean {
  const descriptor = SCHEMA_DESCRIPTORS.decision;
  if (!matchesDescriptor(value, descriptor) || !terminalState(value) || value.catalog_version !== 1 || !sha256(value.catalog_digest) || !sha256(value.source_input_record_sha256)) return false;
  if (!Array.isArray(value.platforms) || !exactJson(value.platforms, ["macos", "linux"]) || !Array.isArray(value.rows) || !value.rows.every((row) => {
    if (typeof row !== "string") return false;
    const [platform, rowId, expectedKind, expectedCode, observedKind, observedCode, verdict, observationId, frameDigest, ...surplus] = row.split("\0");
    const catalog = CATALOG_V1.find((item) => item.id === rowId);
    const frozen = platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
    const expected = expectedKind === "rejected" ? { kind: expectedKind, code: expectedCode } : { kind: expectedKind };
    const observed = observedKind === "rejected" ? { kind: observedKind, code: observedCode } : { kind: observedKind };
    return surplus.length === 0 && ["macos", "linux"].includes(platform!) && outcome(expected) && exactJson(expected, frozen) && outcome(observed) && ["pass", "fail"].includes(verdict!) && sha256(observationId) && sha256(frameDigest) && ((verdict === "pass") === exactJson(expected, observed));
  }) || !record(value.gates) || Object.keys(value.gates).length === 0 || !Object.values(value.gates).every((gate) => gate === "pass")) return false;
  if (value.run_status === "valid_complete" && (value.rows.length !== 348 || new Set(value.rows.map((row) => (row as string).split("\0").slice(0, 2).join("/"))).size !== 348)) return false;
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
