import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonDigest } from "../lib/canonical-frame";
import { checkCurrent } from "../lib/checker";
import { runCheck } from "../lib/checker";
import { INGESTION_LIMITS } from "../lib/frozen";
import * as frozen from "../lib/frozen";
import { ContractError } from "../lib/ingestion";
import { enumerateSourceCandidates, validateGitCandidateSet, validateManifest } from "../lib/schema";
import * as schema from "../lib/schema";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const manifestRelative = "spikes/git-status-capability/contracts/source-input-v1.paths";
const temporaryRoots: string[] = [];
const generic = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/valid/generic.json"), "utf8"));
const checkerPath = join(import.meta.dir, "../check.ts");

type EvidenceLane = "source" | "platform" | "gates" | "final";
type JsonRecord = Record<string, any>;

const digest = "01".repeat(32);
const otherDigest = "02".repeat(32);
const D9_IDS = [
  "GATE-BASE", "GATE-SOURCE-INPUT", "GATE-INSTALL", "GATE-CHECK", "GATE-SCHEMA", "GATE-PERF",
  "GATE-DOCS-SELF", "GATE-DOCS-LINKS", "GATE-OPENSPEC-STATUS", "GATE-OPENSPEC", "GATE-DIFF-CHECK",
  "GATE-SCOPE", "GATE-UNTRACKED", "GATE-PRODUCTION", "GATE-GOVERNANCE", "GATE-SUBMODULE-DIFF",
  "GATE-SUBMODULE-PINS"
] as const;
const COMPLETENESS_FIELDS = [
  "lockfile_completeness_verdict", "direct_feature_completeness_verdict",
  "macos_target_graph_completeness_verdict", "linux_target_graph_completeness_verdict",
  "call_ledger_completeness_verdict", "sbom_completeness_verdict", "license_inventory_completeness_verdict"
] as const;
const clone = <T>(value: T): T => structuredClone(value);

const evidenceStatuses: Record<EvidenceLane, readonly string[]> = {
  source: ["source-input-recorded"],
  platform: ["platform-observation-recorded"],
  gates: ["repository-gates-passed"],
  final: ["accepted", "rejected"]
};

function canonicalMarkdown(
  lane: EvidenceLane,
  digest: string,
  platform: "macos" | "linux" | "none" = "none",
  status = evidenceStatuses[lane][0]!,
  sourceRecordSha = sha256Record(sourceRecordForDigest(digest))
): string {
  return [
    "# SHUD Git Status Capability Evidence",
    "Schema: shud.git-status-capability.markdown-evidence.v1",
    `Lane: ${lane}`,
    `Platform: ${platform}`,
    `Source input: ${digest}`,
    `Source record SHA-256: ${sourceRecordSha}`,
    `Artifact SHA-256: ${"a5".repeat(32)}`,
    `Status: ${status}`,
    ""
  ].join("\n");
}

function publicCurrentCheck(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    checkerPath, "--repository-root", root, "--manifest", manifestRelative, "--check-current"
  ], { cwd: root, encoding: "utf8" });
}

function sourceRecordForDigest(digest: string): Record<string, any> {
  const record = structuredClone(generic.source_input_record);
  record.source_input_digest = digest;
  record.primary_encoder.result.source_input_digest = digest;
  record.witness_encoder.result.source_input_digest = digest;
  return record;
}

function sourceRecordBytes(record: Record<string, any> = generic.source_input_record): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function sha256Record(record: Record<string, any>): string {
  return createHash("sha256").update(sourceRecordBytes(record)).digest("hex");
}

function sourceRecordSha(record: Record<string, any> = generic.source_input_record): string {
  return sha256Record(record);
}

function bindSourceRecord<T>(value: T, sourceRecordSha: string): T {
  const visit = (item: any): any => Array.isArray(item) ? item.map(visit) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, key === "source_input_record_sha256" ? sourceRecordSha : visit(child)]))
    : item;
  return visit(value) as T;
}

function immutableReference(lane: EvidenceLane, platform: "macos" | "linux" | "none", sourceRecordSha: string, seed = "03", byteLength = 128): Record<string, unknown> {
  const sha256 = seed.length === 64 ? seed : seed.repeat(32);
  return {
    schema_version: "shud.git-status-capability.immutable-evidence-reference.v1",
    lane,
    platform,
    source_input_record_sha256: sourceRecordSha,
    media_type: "application/json",
    sha256,
    byte_length: byteLength,
    immutable_identity: `sha256:${sha256}`,
    retention: { policy: "retain-until-change-archived-v1", minimum_days: 3650 },
    access: { scope: "repository-local", requires_network: false },
    offline_retrieval: {
      kind: "content-addressed-path-v1", path: `artifacts/sha256/${sha256}`, sha256, byte_length: byteLength
    }
  };
}

async function installSourceRecord(root: string, digest: string): Promise<string> {
  const record = sourceRecordForDigest(digest);
  await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceRecordBytes(record));
  return sha256Record(record);
}

async function installRound4SourceRecord(root: string, record: JsonRecord = generic.source_input_record): Promise<string> {
  await writeEvidence(root, `source/${record.source_input_digest}/source-input-record.json`, sourceRecordBytes(record));
  return sourceRecordSha(record);
}

function paddedJson(value: unknown, bytes: number): Buffer {
  const serialized = Buffer.from(JSON.stringify(value));
  if (serialized.length > bytes) throw new Error("fixture exceeds requested byte size");
  return Buffer.concat([serialized, Buffer.alloc(bytes - serialized.length, 0x20)]);
}

function compactInvalidPlatformBundle(platform: "macos" | "linux"): Record<string, unknown> {
  const bundle = structuredClone(platform === "macos" ? generic.platform_bundle : generic.linux_platform_bundle);
  bundle.run_status = "invalid";
  bundle.rows = [];
  bundle.protection_set = [];
  bundle.raw_command_manifest = [];
  bundle.first_cause = "SYNTHETIC_INVALID_BUNDLE";
  bundle.all_failure_codes = ["SYNTHETIC_INVALID_BUNDLE"];
  return bundle;
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

async function writeEvidence(root: string, relative: string, content: Uint8Array | string | JsonRecord): Promise<string> {
  const absolute = join(root, "openspec/changes/m2-capability-observer-spike/evidence", ...relative.split("/"));
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, typeof content === "string" || content instanceof Uint8Array ? content : `${JSON.stringify(content)}\n`);
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

function d9RawReceipts(recordSha = sourceRecordSha(), failedId?: string): JsonRecord[] {
  return D9_IDS.map((id, ordinal) => {
    const profile = frozen.D9_COMMAND_PROFILE[ordinal]!;
    const stdout_summary = id === failedId ? "" : "ok";
    const stderr_summary = id === failedId ? "failed" : "";
    return {
      id,
      argv: [...profile.argv],
      version: profile.version,
      exit_code: id === failedId ? 1 : 0,
      stdout_summary,
      stderr_summary,
      summary_digest: canonicalJsonDigest({ stdout_summary, stderr_summary }),
      source_input_record_sha256: recordSha
    };
  });
}

function repositoryGate(recordSha = sourceRecordSha()): JsonRecord {
  return {
    schema_version: "shud.git-status-capability.repository-gate.v1",
    source_input_record_sha256: recordSha,
    gates: d9RawReceipts(recordSha)
  };
}

function publicationAssertion(decision: JsonRecord, recordSha = sourceRecordSha()): JsonRecord {
  return {
    schema_version: "shud.git-status-capability.publication-assertion.v1",
    source_input_record_sha256: recordSha,
    decision_sha256: createHash("sha256").update(`${JSON.stringify(decision)}\n`).digest("hex"),
    expected_decision: "accepted",
    command_receipt: {
      argv: ["spikes/git-status-capability/verify.sh", "evidence", "expect", "accepted", "--decision", "/external-staging/candidate-decision.json"],
      version: "1",
      exit_code: 0,
      summary_digest: "32".repeat(32)
    }
  };
}

function publicationGovernance(gate: JsonRecord, recordSha = sourceRecordSha()): JsonRecord {
  const governanceDigest = canonicalJsonDigest(gate.gates[D9_IDS.indexOf("GATE-GOVERNANCE")]);
  return {
    schema_version: "shud.git-status-capability.publication-governance-recheck.v1",
    source_input_record_sha256: recordSha,
    d9_governance_receipt_sha256: governanceDigest,
    repeated_receipt_sha256: governanceDigest,
    exact_match: true,
    mutation_count: 0
  };
}

function synchronizeFinalBundle(finalBundle: JsonRecord, decision: JsonRecord, macos?: JsonRecord, linux?: JsonRecord, gate?: JsonRecord): void {
  if (macos) finalBundle.macos_bundle_sha256 = createHash("sha256").update(`${JSON.stringify(macos)}\n`).digest("hex");
  if (linux) finalBundle.linux_bundle_sha256 = createHash("sha256").update(`${JSON.stringify(linux)}\n`).digest("hex");
  if (gate) {
    finalBundle.repository_gate_sha256 = createHash("sha256").update(`${JSON.stringify(gate)}\n`).digest("hex");
    finalBundle.repository_gates = clone(gate.gates);
  }
  finalBundle.decision_projection_digest = canonicalJsonDigest(decision);
}

async function installPublicationCompanions(root: string, recordSha: string): Promise<{ gate: JsonRecord; decision: JsonRecord }> {
  const macos = bindSourceRecord(clone(generic.platform_bundle), recordSha);
  const linux = bindSourceRecord(clone(generic.linux_platform_bundle), recordSha);
  const gate = repositoryGate(recordSha);
  const decision = bindSourceRecord(clone(generic.decision), recordSha);
  const finalBundle = bindSourceRecord(clone(generic.final_bundle), recordSha);
  synchronizeFinalBundle(finalBundle, decision, macos, linux, gate);
  await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`, macos);
  await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`, linux);
  await writeEvidence(root, `gates/${digest}/repository-gate.json`, gate);
  await writeEvidence(root, `final/${digest}/final-bundle.json`, finalBundle);
  await writeEvidence(root, `final/${digest}/decision.json`, decision);
  return { gate, decision };
}

async function installReferencedPlatforms(root: string, recordSha: string): Promise<void> {
  await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`,
    immutableReference("platform", "macos", recordSha, "e1", 1));
  await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`,
    immutableReference("platform", "linux", recordSha, "e2", 1));
}

async function installReferencedTerminalCompanions(
  root: string,
  recordSha: string,
  omittedPath: string
): Promise<void> {
  const paths: Array<[string, JsonRecord]> = [
    [`platform/${digest}/macos/platform-bundle.json`, immutableReference("platform", "macos", recordSha, "e1", 1)],
    [`platform/${digest}/linux/platform-bundle.json`, immutableReference("platform", "linux", recordSha, "e2", 1)],
    [`gates/${digest}/repository-gate.json`, immutableReference("gates", "none", recordSha, "e3", 1)],
    [`final/${digest}/final-bundle.json`, immutableReference("final", "none", recordSha, "e4", 1)],
    [`final/${digest}/decision.json`, immutableReference("final", "none", recordSha, "e5", 1)],
    [`final/${digest}/publication-assertion.json`, immutableReference("final", "none", recordSha, "e6", 1)],
    [`final/${digest}/publication-governance-recheck.json`, immutableReference("final", "none", recordSha, "e7", 1)]
  ];
  await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceRecordBytes(sourceRecordForDigest(digest)));
  for (const [path, value] of paths) if (path !== omittedPath) await writeEvidence(root, path, value);
}

function invalidDecisionFrom(base: JsonRecord, codes: string[]): JsonRecord {
  const decision = clone(base);
  decision.run_status = "invalid";
  delete decision.terminal_decision;
  decision.first_cause = codes[0];
  decision.all_failure_codes = [...new Set(codes)].sort();
  return decision;
}

function bindControlFailure(row: JsonRecord, controlId: string, producer: "observer" | "launcher" | "tripwire"): void {
  row.actual_producing_boundary = producer;
  const receipt = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1",
    platform: row.platform,
    producer,
    row_id: row.row_id,
    observation_id: row.observation_id,
    supplied_input_digest: row.frame_digest,
    control_id: controlId,
    control_verdict: "fail"
  };
  row.failure_cause = { kind: "control-failure-v1", receipt: { ...receipt, receipt_digest: canonicalJsonDigest(receipt) } };
}

function changedProtectionBundle(): JsonRecord {
  const bundle = bindSourceRecord(clone(generic.platform_bundle), sourceRecordSha());
  const row = bundle.rows[0];
  row.control_assertions.protection.verdict = "fail";
  row.protection_set_equal = false;
  row.row_verdict = "fail";
  bindControlFailure(row, "protection", "tripwire");
  const receipt = bundle.protection_set[0];
  const member = receipt.inventory[0];
  member.post_measurement.content.encoding = "observed-change-v1";
  member.post_measurement.content.text = "changed:canonical-superproject\n";
  member.post_measurement.metadata.byte_length = Buffer.byteLength(member.post_measurement.content.text);
  member.post_digest = canonicalJsonDigest(member.post_measurement);
  member.event_material.kind = "verified-changed-v1";
  member.event_material.post_digest = member.post_digest;
  member.event_digest = canonicalJsonDigest(member.event_material);
  const unsigned = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receipt_digest"));
  receipt.receipt_digest = canonicalJsonDigest(unsigned);
  return bundle;
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
    const recordSha = await installSourceRecord(root, digest);
    await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`,
      bindSourceRecord(clone(generic.platform_bundle), recordSha));
    await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`,
      bindSourceRecord(clone(generic.linux_platform_bundle), recordSha));
    await mkdir(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}/macos`), { recursive: true });
    await writeFile(join(root, `openspec/changes/m2-capability-observer-spike/evidence/platform/${digest}/macos/result.md`),
      canonicalMarkdown("platform", digest, "macos"));
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
    const digest = "01".repeat(32);
    const record = sourceRecordForDigest(digest);
    const recordSha = sha256Record(record);
    const validMacos = bindSourceRecord(clone(generic.platform_bundle), recordSha);
    const validLinux = bindSourceRecord(clone(generic.linux_platform_bundle), recordSha);
    const validDecision = bindSourceRecord(clone(generic.decision), recordSha);
    const validFinal = bindSourceRecord(clone(generic.final_bundle), recordSha);
    const validGate = repositoryGate(recordSha);
    synchronizeFinalBundle(validFinal, validDecision, validMacos, validLinux, validGate);
    const validRecords: Array<[string, unknown | string]> = [
      [`source/${digest}/source-input-record.json`, record],
      [`platform/${digest}/macos/platform-bundle.json`, validMacos],
      [`platform/${digest}/linux/platform-bundle.json`, validLinux],
      [`gates/${digest}/repository-gate.json`, validGate],
      [`final/${digest}/source-input-record.json`, record],
      [`final/${digest}/final-bundle.json`, validFinal],
      [`final/${digest}/decision.json`, validDecision],
      [`final/${digest}/publication-assertion.json`, publicationAssertion(validDecision, recordSha)],
      [`final/${digest}/publication-governance-recheck.json`, publicationGovernance(validGate, recordSha)],
      [`final/${digest}/summary.md`, canonicalMarkdown("final", digest, "none", "accepted", recordSha)]
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
    const stagedRecordSha = await installSourceRecord(stagedRoot, digest);
    await writeEvidence(stagedRoot, `platform/${digest}/macos/platform-bundle.json`,
      immutableReference("platform", "macos", stagedRecordSha, "c1", 1));
    await writeEvidence(stagedRoot, `platform/${digest}/linux/platform-bundle.json`,
      immutableReference("platform", "linux", stagedRecordSha, "c2", 1));
    await writeEvidence(stagedRoot, `gates/${digest}/repository-gate.json`,
      immutableReference("gates", "none", stagedRecordSha, "c3", 1));
    const stagedDirectory = join(stagedRoot, `openspec/changes/m2-capability-observer-spike/evidence/gates/${digest}`);
    const stagedPath = join(stagedDirectory, "receipt.md");
    await mkdir(stagedDirectory, { recursive: true });
    await writeFile(stagedPath, "import hidden from 'covered-source';\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: stagedRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: stagedRoot }).status).toBe(0);
    await writeFile(stagedPath, canonicalMarkdown("gates", digest));
    const stagedCandidates = await enumerateSourceCandidates(stagedRoot);
    expect(() => validateGitCandidateSet(stagedRoot, stagedCandidates), "staged-invalid/worktree-legal").toThrow(ContractError);
  });

  test("Markdown evidence accepts only the canonical path-bound positive grammar", async () => {
    const digest = "01".repeat(32);
    const positives = [
      [`source/${digest}/summary.md`, canonicalMarkdown("source", digest)],
      [`platform/${digest}/macos/summary.md`, canonicalMarkdown("platform", digest, "macos")],
      [`platform/${digest}/linux/summary.md`, canonicalMarkdown("platform", digest, "linux")],
      [`gates/${digest}/summary.md`, canonicalMarkdown("gates", digest)],
      [`final/${digest}/accepted.md`, canonicalMarkdown("final", digest, "none", "accepted")],
      [`final/${digest}/rejected.md`, canonicalMarkdown("final", digest, "none", "rejected")]
    ] as const;
    const positiveRoot = await temporaryRepository();
    const recordSha = await installSourceRecord(positiveRoot, digest);
    const { gate, decision } = await installPublicationCompanions(positiveRoot, recordSha);
    await writeEvidence(positiveRoot, `final/${digest}/source-input-record.json`, sourceRecordBytes(sourceRecordForDigest(digest)));
    await writeEvidence(positiveRoot, `final/${digest}/publication-assertion.json`, publicationAssertion(decision, recordSha));
    await writeEvidence(positiveRoot, `final/${digest}/publication-governance-recheck.json`, publicationGovernance(gate, recordSha));
    for (const [path, content] of positives) await writeEvidence(positiveRoot, path, content);
    const candidates = await enumerateSourceCandidates(positiveRoot);
    expect(candidates).toHaveLength(40);
    expect(spawnSync("git", ["init", "-q"], { cwd: positiveRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: positiveRoot }).status).toBe(0);
    expect(() => validateGitCandidateSet(positiveRoot, candidates), "tracked-positive").not.toThrow();
    const publicPositive = publicCurrentCheck(positiveRoot);
    expect(publicPositive.status, publicPositive.stderr).toBe(0);

    const canonical = canonicalMarkdown("platform", digest, "macos");
    const invalidGrammar = [
      ["free-prose", "bounded observation\n"],
      ["fence", "```json\n{\"status\":\"ok\"}\n```\n"],
      ["missing-field", canonical.replace(/^Artifact SHA-256:.*\n/m, "")],
      ["extra-field", canonical.replace(/Status:/, "Comment: hidden\nStatus:")],
      ["reordered-field", canonical.replace(/Lane: platform\nPlatform: macos/, "Platform: macos\nLane: platform")],
      ["no-terminal-lf", canonical.slice(0, -1)],
      ["extra-byte", `${canonical}\n`],
      ["wrong-title", canonical.replace("# SHUD Git Status Capability Evidence", "# Evidence")],
      ["wrong-schema", canonical.replace("markdown-evidence.v1", "markdown-evidence.v2")],
      ["wrong-lane", canonical.replace("Lane: platform", "Lane: gates")],
      ["wrong-platform", canonical.replace("Platform: macos", "Platform: linux")],
      ["wrong-source", canonical.replace(`Source input: ${digest}`, `Source input: ${"06".repeat(32)}`)],
      ["bad-artifact", canonical.replace("a5".repeat(32), "A5".repeat(32))],
      ["wrong-status", canonical.replace("platform-observation-recorded", "accepted")],
      ["encoded-payload", canonical.replace("Status: platform-observation-recorded", "Status: aW1wb3J0IHg=")]
    ] as const;
    for (const [name, content] of invalidGrammar) {
      const root = await temporaryRepository();
      await installSourceRecord(root, digest);
      await writeEvidence(root, `platform/${digest}/macos/${name}.md`, content);
      await expect(enumerateSourceCandidates(root), name).rejects.toBeInstanceOf(ContractError);
    }

    const sourceRepresentatives = [
      ["typescript", "declare const token: string;\n"],
      ["rust", "use std::fs; struct Receipt { digest: String }\n"],
      ["python", "class Evidence:\n    pass\n"],
      ["c", "int validate_record(const char *p) { return 1; }\n"],
      ["expression", "(() => 1)();\n"],
      ["shell", "echo hidden > result\n"],
      ["r", "hidden <- function(x) x + 1\n"],
      ["cpp", "template<class T> T hidden(T value) { return value; }\n"],
      ["macro", "#define HIDDEN(x) ((x) + 1)\n"],
      ["polyglot", "//<!--\nconsole.log('hidden')\n//-->\n"],
      ["encoded", "aW1wb3J0IHggaGVsbG8K\n"]
    ] as const;
    for (const [name, content] of sourceRepresentatives) {
      for (const tracked of [false, true] as const) {
        const root = await temporaryRepository();
        await installSourceRecord(root, digest);
        await writeEvidence(root, `final/${digest}/${name}.md`, content);
        if (tracked) {
          expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
          expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
        }
        const result = publicCurrentCheck(root);
        expect(result.status, `${tracked ? "tracked" : "untracked"}:${name}:${result.stdout}:${result.stderr}`).toBe(2);
      }
    }

    const stagedRoot = await temporaryRepository();
    await installSourceRecord(stagedRoot, digest);
    const stagedPath = await writeEvidence(stagedRoot, `final/${digest}/staged.md`, "declare const hidden: string;\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: stagedRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: stagedRoot }).status).toBe(0);
    await writeFile(stagedPath, canonicalMarkdown("final", digest, "none", "accepted"));
    const staged = publicCurrentCheck(stagedRoot);
    expect(staged.status, `staged-invalid/worktree-legal:${staged.stdout}:${staged.stderr}`).toBe(2);
  }, 120_000);

  test("closed evidence JSON schemas enforce their own byte, depth, node, and item limits after version discovery", async () => {
    const digest = "01".repeat(32);
    const recordSha = sha256Record(sourceRecordForDigest(digest));
    const cases = [
      ["source-input-record", `source/${digest}/source-input-record.json`, "shud.git-status-capability.source-input-record.v1", INGESTION_LIMITS.source_input_record, sourceRecordForDigest(digest)],
      ["platform-bundle", `platform/${digest}/macos/platform-bundle.json`, "shud.git-status-capability.platform-bundle.v1", INGESTION_LIMITS.platform_bundle, bindSourceRecord(generic.platform_bundle, recordSha)],
      ["repository-gate", `gates/${digest}/repository-gate.json`, "shud.git-status-capability.repository-gate.v1", { bytes: 256 * 1024, depth: 12, nodes: 4096, items: 1024 }, bindSourceRecord(generic.repository_gate, recordSha)],
      ["final-bundle", `final/${digest}/final-bundle.json`, "shud.git-status-capability.final-bundle.v1", INGESTION_LIMITS.final_bundle, bindSourceRecord(generic.final_bundle, recordSha)],
      ["decision", `final/${digest}/decision.json`, "shud.git-status-capability.decision.v1", INGESTION_LIMITS.decision, bindSourceRecord(generic.decision, recordSha)],
      ["publication-assertion", `final/${digest}/publication-assertion.json`, "shud.git-status-capability.publication-assertion.v1", { bytes: 64 * 1024, depth: 12, nodes: 2048, items: 512 }, bindSourceRecord(generic.publication_assertion, recordSha)],
      ["publication-governance-recheck", `final/${digest}/publication-governance-recheck.json`, "shud.git-status-capability.publication-governance-recheck.v1", { bytes: 64 * 1024, depth: 12, nodes: 2048, items: 512 }, bindSourceRecord(generic.publication_governance_recheck, recordSha)],
      ["immutable-reference", `gates/${digest}/repository-gate.json`, "shud.git-status-capability.immutable-evidence-reference.v1",
        { bytes: 4096, depth: 6, nodes: 64, items: 32 }, immutableReference("gates", "none", recordSha, "13")]
    ] as const;
    const boundaries = [
      ["depth", depthBoundaryJson, "CONTRACT_JSON_DEPTH_LIMIT"],
      ["nodes", nodeBoundaryJson, "CONTRACT_JSON_NODE_LIMIT"],
      ["items", itemBoundaryJson, "CONTRACT_JSON_ITEM_LIMIT"]
    ] as const;

    for (const [kind, path, schemaVersion, limits, valid] of cases) {
      const root = await temporaryRepository();
      if (kind !== "source-input-record") await installSourceRecord(root, digest);
      if (kind === "platform-bundle") {
        await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`,
          immutableReference("platform", "linux", recordSha, "d2", 1));
      }
      if (kind === "repository-gate" || kind === "immutable-reference") await installReferencedPlatforms(root, recordSha);
      if (kind === "final-bundle" || kind === "decision") {
        await installReferencedTerminalCompanions(root, recordSha, path);
        if (kind === "final-bundle") {
          valid.macos_bundle_sha256 = "e1".repeat(32);
          valid.linux_bundle_sha256 = "e2".repeat(32);
          valid.repository_gate_sha256 = "e3".repeat(32);
        }
      }
      if (kind === "publication-assertion") {
        const companions = await installPublicationCompanions(root, recordSha);
        await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceRecordBytes(sourceRecordForDigest(digest)));
        await writeEvidence(root, `final/${digest}/publication-governance-recheck.json`, publicationGovernance(companions.gate, recordSha));
        Object.assign(valid, publicationAssertion(companions.decision, recordSha));
      }
      if (kind === "publication-governance-recheck") {
        const companions = await installPublicationCompanions(root, recordSha);
        await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceRecordBytes(sourceRecordForDigest(digest)));
        await writeEvidence(root, `final/${digest}/publication-assertion.json`, publicationAssertion(companions.decision, recordSha));
        Object.assign(valid, publicationGovernance(companions.gate, recordSha));
      }
      const admittedBytes = kind === "final-bundle"
        ? limits.bytes - sourceRecordBytes(sourceRecordForDigest(digest)).byteLength - [
          immutableReference("final", "none", recordSha, "e5", 1),
          immutableReference("final", "none", recordSha, "e6", 1),
          immutableReference("final", "none", recordSha, "e7", 1)
        ].reduce((total, reference) => total + Buffer.byteLength(`${JSON.stringify(reference)}\n`), 0)
        : limits.bytes;
      await writeEvidence(root, path, paddedJson(valid, admittedBytes));
      expect(await enumerateSourceCandidates(root), `${kind}:bytes:exact`).toBeInstanceOf(Array);
      await writeEvidence(root, path, paddedJson(valid, admittedBytes + 1));
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

  test("logical evidence ceilings compose across references, inline bytes, digests, platforms, worktree, tracked, and staged views", async () => {
    const digestA = "06".repeat(32);
    const digestB = "07".repeat(32);
    const platformLimit = INGESTION_LIMITS.platform_bundle.bytes;
    const finalLimit = INGESTION_LIMITS.final_bundle.bytes;

    const initialized = async (root: string, sourceDigest = digestA) => ({
      recordSha: await installSourceRecord(root, sourceDigest),
      sourceBytes: sourceRecordBytes(sourceRecordForDigest(sourceDigest)).byteLength
    });
    const admitTracked = async (root: string, label: string): Promise<void> => {
      const candidates = await enumerateSourceCandidates(root);
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
      expect(() => validateGitCandidateSet(root, candidates), label).not.toThrow();
    };

    for (const tracked of [false, true]) {
      const exact = await temporaryRepository();
      const { recordSha, sourceBytes } = await initialized(exact);
      await writeEvidence(exact, `source/${digestA}/supplement.json`,
        `${JSON.stringify(immutableReference("source", "none", recordSha, "20", 128 * 1024 - sourceBytes))}\n`);
      try { expect(await enumerateSourceCandidates(exact), "source-lane-exact").toBeInstanceOf(Array); }
      catch (error) { throw new Error(`source-lane-exact:${String(error)}`); }
      await writeEvidence(exact, `platform/${digestA}/macos/platform-bundle.json`,
        `${JSON.stringify(immutableReference("platform", "macos", recordSha, "23", 4 * 1024 * 1024))}\n`);
      await writeEvidence(exact, `platform/${digestA}/macos/second.json`,
        `${JSON.stringify(immutableReference("platform", "macos", recordSha, "24", 4 * 1024 * 1024))}\n`);
      await writeEvidence(exact, `platform/${digestA}/linux/platform-bundle.json`,
        `${JSON.stringify(immutableReference("platform", "linux", recordSha, "26", 1))}\n`);
      try { expect(await enumerateSourceCandidates(exact), "platform-lane-exact").toBeInstanceOf(Array); }
      catch (error) { throw new Error(`platform-lane-exact:${String(error)}`); }
      await writeEvidence(exact, `gates/${digestA}/repository-gate.json`,
        `${JSON.stringify(immutableReference("gates", "none", recordSha, "21", 512 * 1024))}\n`);
      await writeEvidence(exact, `gates/${digestA}/second.json`,
        `${JSON.stringify(immutableReference("gates", "none", recordSha, "22", 512 * 1024))}\n`);
      try { expect(await enumerateSourceCandidates(exact), "gates-lane-exact").toBeInstanceOf(Array); }
      catch (error) { throw new Error(`gates-lane-exact:${String(error)}`); }
      const finalSource = sourceRecordBytes(sourceRecordForDigest(digestA));
      const finalReferences: Array<[string, JsonRecord]> = [
        [`final/${digestA}/decision.json`, immutableReference("final", "none", recordSha, "27", 1)],
        [`final/${digestA}/publication-assertion.json`, immutableReference("final", "none", recordSha, "28", 1)],
        [`final/${digestA}/publication-governance-recheck.json`, immutableReference("final", "none", recordSha, "29", 1)]
      ];
      const fixedFinalBytes = finalSource.byteLength + finalReferences.reduce((total, [, reference]) =>
        total + Buffer.byteLength(`${JSON.stringify(reference)}\n`), 0);
      await writeEvidence(exact, `final/${digestA}/source-input-record.json`, finalSource);
      await writeEvidence(exact, `final/${digestA}/final-bundle.json`,
        `${JSON.stringify(immutableReference("final", "none", recordSha, "25", finalLimit - fixedFinalBytes))}\n`);
      for (const [path, reference] of finalReferences) await writeEvidence(exact, path, `${JSON.stringify(reference)}\n`);
      try { expect(await enumerateSourceCandidates(exact), "all-lanes-exact").toBeInstanceOf(Array); }
      catch (error) { throw new Error(`all-lanes-exact:${String(error)}`); }
      if (tracked) await admitTracked(exact, "tracked-all-lanes-exact");
    }

    const singlePlusOne = await temporaryRepository();
    const singleSha = (await initialized(singlePlusOne)).recordSha;
    await writeEvidence(singlePlusOne, `platform/${digestA}/macos/plus-one.json`,
      `${JSON.stringify(immutableReference("platform", "macos", singleSha, "30", platformLimit + 1))}\n`);
    await expect(enumerateSourceCandidates(singlePlusOne), "single-reference-plus-one")
      .rejects.toMatchObject({ code: "CONTRACT_BYTES_LIMIT" });

    const aggregatePlusOne = await temporaryRepository();
    const aggregateSha = (await initialized(aggregatePlusOne)).recordSha;
    await writeEvidence(aggregatePlusOne, `platform/${digestA}/macos/first.json`,
      `${JSON.stringify(immutableReference("platform", "macos", aggregateSha, "31", 4 * 1024 * 1024))}\n`);
    await writeEvidence(aggregatePlusOne, `platform/${digestA}/macos/second.json`,
      `${JSON.stringify(immutableReference("platform", "macos", aggregateSha, "32", 4 * 1024 * 1024 + 1))}\n`);
    await expect(enumerateSourceCandidates(aggregatePlusOne), "aggregate-plus-one")
      .rejects.toMatchObject({ code: "CONTRACT_BYTES_LIMIT" });

    for (const extra of [0, 1]) {
      const mixed = await temporaryRepository();
      const mixedSha = (await initialized(mixed)).recordSha;
      const inline = canonicalMarkdown("platform", digestA, "macos", "platform-observation-recorded", mixedSha);
      const inlineBytes = Buffer.byteLength(inline);
      await writeEvidence(mixed, `platform/${digestA}/macos/summary.md`, inline);
      await writeEvidence(mixed, `platform/${digestA}/macos/platform-bundle.json`,
        `${JSON.stringify(immutableReference("platform", "macos", mixedSha, `4${extra}`, platformLimit - inlineBytes + extra))}\n`);
      await writeEvidence(mixed, `platform/${digestA}/linux/platform-bundle.json`,
        `${JSON.stringify(immutableReference("platform", "linux", mixedSha, `7${extra}`, 1))}\n`);
      if (extra === 0) {
        try { expect(await enumerateSourceCandidates(mixed), "mixed-exact").toBeInstanceOf(Array); }
        catch (error) { throw new Error(`mixed-exact:${String(error)}`); }
      }
      else await expect(enumerateSourceCandidates(mixed), "mixed-plus-one").rejects.toMatchObject({ code: "CONTRACT_BYTES_LIMIT" });
    }

    const duplicate = await temporaryRepository();
    const duplicateSha = (await initialized(duplicate)).recordSha;
    const repeated = `${JSON.stringify(immutableReference("platform", "macos", duplicateSha, "50", 1024))}\n`;
    await writeEvidence(duplicate, `platform/${digestA}/macos/first.json`, repeated);
    await writeEvidence(duplicate, `platform/${digestA}/macos/second.json`, repeated);
    await expect(enumerateSourceCandidates(duplicate), "duplicate-reference")
      .rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

    const isolated = await temporaryRepository();
    const shaA = (await initialized(isolated, digestA)).recordSha;
    const shaB = (await initialized(isolated, digestB)).recordSha;
    await writeEvidence(isolated, `platform/${digestA}/macos/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "macos", shaA, "61", 5 * 1024 * 1024))}\n`);
    await writeEvidence(isolated, `platform/${digestA}/linux/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "linux", shaA, "62", 5 * 1024 * 1024))}\n`);
    await writeEvidence(isolated, `platform/${digestB}/macos/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "macos", shaB, "63", 5 * 1024 * 1024))}\n`);
    await writeEvidence(isolated, `platform/${digestB}/linux/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "linux", shaB, "64", 5 * 1024 * 1024))}\n`);
    try { expect(await enumerateSourceCandidates(isolated), "platform-and-digest-isolation").toBeInstanceOf(Array); }
    catch (error) { throw new Error(`platform-and-digest-isolation:${String(error)}`); }

    const staged = await temporaryRepository();
    const stagedSha = (await initialized(staged)).recordSha;
    const stagedPath = await writeEvidence(staged, `platform/${digestA}/macos/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "macos", stagedSha, "70", platformLimit + 1))}\n`);
    await writeEvidence(staged, `platform/${digestA}/linux/platform-bundle.json`,
      `${JSON.stringify(immutableReference("platform", "linux", stagedSha, "71", 1024))}\n`);
    expect(spawnSync("git", ["init", "-q"], { cwd: staged }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: staged }).status).toBe(0);
    await writeFile(stagedPath, `${JSON.stringify(immutableReference("platform", "macos", stagedSha, "70", 1024))}\n`);
    const candidates = await enumerateSourceCandidates(staged);
    expect(() => validateGitCandidateSet(staged, candidates), "staged-invalid/worktree-valid").toThrow(ContractError);
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

describe("Round 4 terminal contract model", () => {
  test("collection identity binds the live digest, exact source-record bytes, final copy, and every descendant", async () => {
    const mismatch = await temporaryRepository();
    await writeEvidence(mismatch, `source/${otherDigest}/source-input-record.json`, sourceRecordBytes());
    await expect(schema.enumerateSourceCandidates(mismatch)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

    const referencedSource = await temporaryRepository();
    await writeEvidence(referencedSource, `source/${digest}/source-input-record.json`,
      immutableReference("source", "none", sourceRecordSha(), "79", 1024));
    await expect(schema.enumerateSourceCandidates(referencedSource)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

    const copyDrift = await temporaryRepository();
    const recordSha = await installRound4SourceRecord(copyDrift);
    await writeEvidence(copyDrift, `final/${digest}/source-input-record.json`, Buffer.concat([sourceRecordBytes(), Buffer.from(" ")]));
    await expect(schema.enumerateSourceCandidates(copyDrift)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });

    const wrongBinding = await temporaryRepository();
    await installRound4SourceRecord(wrongBinding);
    await writeEvidence(wrongBinding, `platform/${digest}/macos/platform-bundle.json`,
      bindSourceRecord(clone(generic.platform_bundle), "ff".repeat(32)));
    await expect(schema.enumerateSourceCandidates(wrongBinding)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    expect(recordSha).toBe(createHash("sha256").update(sourceRecordBytes()).digest("hex"));
  }, 60_000);

  test("complete Tasks 5.1-5.4 direct and referenced vocabularies preserve final-only publication receipts", async () => {
    const root = await temporaryRepository();
    const recordSha = await installRound4SourceRecord(root);
    await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`, bindSourceRecord(clone(generic.platform_bundle), recordSha));
    await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`, bindSourceRecord(clone(generic.linux_platform_bundle), recordSha));
    const gate = repositoryGate(recordSha);
    await writeEvidence(root, `gates/${digest}/repository-gate.json`, gate);
    await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceRecordBytes());
    const finalBundle = bindSourceRecord(clone(generic.final_bundle), recordSha);
    const decision = bindSourceRecord(clone(generic.decision), recordSha);
    synchronizeFinalBundle(finalBundle, decision, bindSourceRecord(clone(generic.platform_bundle), recordSha),
      bindSourceRecord(clone(generic.linux_platform_bundle), recordSha), gate);
    await writeEvidence(root, `final/${digest}/final-bundle.json`, finalBundle);
    await writeEvidence(root, `final/${digest}/decision.json`, decision);
    await writeEvidence(root, `final/${digest}/publication-assertion.json`, publicationAssertion(decision, recordSha));
    await writeEvidence(root, `final/${digest}/publication-governance-recheck.json`, publicationGovernance(gate, recordSha));
    await expect(schema.enumerateSourceCandidates(root)).resolves.toBeInstanceOf(Array);

    const referenced = await temporaryRepository();
    const referencedSha = await installRound4SourceRecord(referenced);
    const references = [
      [`platform/${digest}/macos/platform-bundle.json`, immutableReference("platform", "macos", referencedSha, "81".repeat(32), 1024)],
      [`platform/${digest}/linux/platform-bundle.json`, immutableReference("platform", "linux", referencedSha, "82".repeat(32), 1024)],
      [`gates/${digest}/repository-gate.json`, immutableReference("gates", "none", referencedSha, "83".repeat(32), 1024)],
      [`final/${digest}/final-bundle.json`, immutableReference("final", "none", referencedSha, "84".repeat(32), 1024)],
      [`final/${digest}/decision.json`, immutableReference("final", "none", referencedSha, "85".repeat(32), 1024)],
      [`final/${digest}/publication-assertion.json`, immutableReference("final", "none", referencedSha, "86".repeat(32), 1024)],
      [`final/${digest}/publication-governance-recheck.json`, immutableReference("final", "none", referencedSha, "87".repeat(32), 1024)]
    ] as const;
    await writeEvidence(referenced, `final/${digest}/source-input-record.json`, sourceRecordBytes());
    for (const [path, reference] of references) await writeEvidence(referenced, path, reference);
    await expect(schema.enumerateSourceCandidates(referenced)).resolves.toBeInstanceOf(Array);

    const mismatchedAssertion = publicationAssertion(decision, recordSha);
    mismatchedAssertion.expected_decision = "rejected";
    mismatchedAssertion.command_receipt.argv[3] = "rejected";
    await writeEvidence(root, `final/${digest}/publication-assertion.json`, mismatchedAssertion);
    await expect(schema.enumerateSourceCandidates(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    await writeEvidence(root, `final/${digest}/publication-assertion.json`, publicationAssertion(decision, recordSha));

    await writeEvidence(root, `gates/${digest}/evidence-index.json`, { schema_version: "shud.git-status-capability.evidence-index.v1" });
    await expect(schema.enumerateSourceCandidates(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    const wrongLane = await temporaryRepository();
    const wrongLaneSha = await installRound4SourceRecord(wrongLane);
    await writeEvidence(wrongLane, `gates/${digest}/publication-assertion.json`,
      bindSourceRecord(clone(generic.publication_assertion), wrongLaneSha));
    await expect(schema.enumerateSourceCandidates(wrongLane)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
  }, 60_000);

  test("invalid decisions are evidence-derived and reject arbitrary all-pass labels", () => {
    const valid = bindSourceRecord(clone(generic.decision), sourceRecordSha());
    const supplyFailure = invalidDecisionFrom(valid, ["SUPPLY_SBOM_INCOMPLETE"]);
    supplyFailure.sbom_completeness_verdict = "fail";
    expect(schema.validateDecision(supplyFailure)).toBe(true);
    expect(schema.validateDecision(invalidDecisionFrom(valid, ["ARBITRARY_LABEL"]))).toBe(false);

    const duplicateRows = clone(valid);
    duplicateRows.run_status = "invalid";
    delete duplicateRows.terminal_decision;
    duplicateRows.rows = [valid.rows[0], valid.rows[0]];
    const coverageFailure = schema.deriveInvalidState({
      completeness: Object.fromEntries(COMPLETENESS_FIELDS.map((field) => [field, "pass"])),
      gates: d9RawReceipts(), coverage: { macos_rows: 1, linux_rows: 0 }, invalidity_receipts: []
    })!;
    Object.assign(duplicateRows, coverageFailure);
    expect(schema.validateDecision(duplicateRows)).toBe(false);

    const forgedGate = d9RawReceipts()[0]!;
    forgedGate.stdout_summary = "forged-without-rehash";
    expect(() => schema.encodeDecisionGateProjection(forgedGate, 0)).toThrow();
  });

  test("every direct/reference kind freezes independently reachable byte/depth/node/item limits", () => {
    expect(frozen.EVIDENCE_RECORD_LIMITS).toEqual({
      markdown: { bytes: 4096, depth: 1, nodes: 1, items: 0 },
      immutable_evidence_reference: { bytes: 4096, depth: 6, nodes: 64, items: 32 },
      source_input_record: { bytes: 64 * 1024, depth: 12, nodes: 2048, items: 512 },
      platform_bundle: { bytes: 8 * 1024 * 1024, depth: 32, nodes: 1_048_576, items: 262_144 },
      repository_gate: { bytes: 256 * 1024, depth: 12, nodes: 4096, items: 1024 },
      final_bundle: { bytes: 20 * 1024 * 1024, depth: 32, nodes: 2_097_152, items: 524_288 },
      decision: { bytes: 128 * 1024, depth: 16, nodes: 8192, items: 2048 },
      publication_assertion: { bytes: 64 * 1024, depth: 12, nodes: 2048, items: 512 },
      publication_governance_recheck: { bytes: 64 * 1024, depth: 12, nodes: 2048, items: 512 }
    });
    expect(Object.keys(frozen.SCHEMA_DESCRIPTORS).sort()).toEqual([
      "decision", "final_bundle", "frame", "immutable_evidence_reference", "platform_bundle",
      "publication_assertion", "publication_governance_recheck", "repository_gate", "row_evidence", "source_input_record"
    ]);
  });

  test("recomputable changed protection material remains valid technical rejection end-to-end", () => {
    const bundle = changedProtectionBundle();
    expect(schema.validateRowEvidence(bundle.rows[0])).toBe(true);
    expect(schema.validatePlatformBundle(bundle)).toBe(true);
    expect(bundle.rows[0]).toMatchObject({ row_verdict: "fail", protection_set_equal: false });
    const malformed = clone(bundle);
    delete malformed.protection_set[0].inventory[0].post_digest;
    expect(schema.validatePlatformBundle(malformed)).toBe(false);
  });

  test("all seven completeness failures and all 17 D9 failures derive exact deterministic invalid causes", () => {
    for (const field of COMPLETENESS_FIELDS) {
      const state = schema.deriveInvalidState({
        completeness: Object.fromEntries(COMPLETENESS_FIELDS.map((name) => [name, name === field ? "fail" : "pass"])),
        gates: d9RawReceipts(), coverage: { macos_rows: 174, linux_rows: 174 }, invalidity_receipts: []
      });
      expect(state.all_failure_codes).toHaveLength(1);
      expect(state.first_cause).toBe(state.all_failure_codes[0]);
    }
    for (const id of D9_IDS) {
      const state = schema.deriveInvalidState({
        completeness: Object.fromEntries(COMPLETENESS_FIELDS.map((name) => [name, "pass"])),
        gates: d9RawReceipts(sourceRecordSha(), id), coverage: { macos_rows: 174, linux_rows: 174 }, invalidity_receipts: []
      });
      expect(state).toEqual({ first_cause: `D9_${id.replaceAll("-", "_")}_FAILED`, all_failure_codes: [`D9_${id.replaceAll("-", "_")}_FAILED`] });
    }
  });

  test("exact ordered 17-gate compact D8 fits all-pass and all-348-row-failure actual/exact/+1", async () => {
    const decision = bindSourceRecord(clone(generic.decision), sourceRecordSha());
    decision.gates = d9RawReceipts().map((receipt, ordinal) => schema.encodeDecisionGateProjection(receipt, ordinal));
    expect(decision.gates).toHaveLength(17);
    expect(schema.validateDecision(decision)).toBe(true);
    const failed = clone(decision);
    const catalogNegativeRows = new Set([
      "CAP-005", "CAP-006", "CAP-008", "CAP-009", "CAP-016", "CAP-017",
      "PRT-001", "PRT-002", "PRT-003", "PRT-004", "PRT-005", "PRT-006", "PRT-007", "PRT-008", "PRT-009",
      "PRT-010", "PRT-011", "LIF-003", "LIF-004", "LIF-005", "LIF-007"
    ]);
    const longestAlternate = (expected: string): string => [...frozen.REJECTION_CODES]
      .filter((code) => code !== expected)
      .sort((left, right) => Buffer.byteLength(right) - Buffer.byteLength(left) || left.localeCompare(right))[0]!;
    failed.rows = decision.rows.map((scalar: string) => {
      const fields = scalar.split("\0");
      const rowId = fields[1]!;
      if (rowId === "PRT-012") { fields[6] = "f"; fields[12] = "6f"; fields[18] = "c"; return fields.join("\0"); }
      const evenLimit = /^LIM-(\d{3})$/.exec(rowId)?.[1];
      if (evenLimit && Number(evenLimit) % 2 === 0) { fields[6] = "f"; fields[10] = "l"; fields[18] = "r"; return fields.join("\0"); }
      fields[4] = "r";
      fields[5] = longestAlternate(fields[3]!);
      fields[6] = "f";
      if (["LIF-002", "LIF-006"].includes(rowId)) fields[18] = "l";
      else if (catalogNegativeRows.has(rowId)) fields[18] = "n";
      else { fields[10] = "o"; fields[18] = "o"; }
      return fields.join("\0");
    });
    failed.terminal_decision = "rejected";
    failed.first_cause = "ROW_FAILURE";
    failed.all_failure_codes = ["ROW_FAILURE"];
    expect(schema.validateDecision(failed)).toBe(true);
    const actualBytes = Buffer.byteLength(JSON.stringify(failed));
    expect(actualBytes).toBeLessThanOrEqual(frozen.INGESTION_LIMITS.decision.bytes);
    const root = await mkdtemp(join(tmpdir(), "shud-d9-capacity-"));
    temporaryRoots.push(root);
    const input = join(root, "decision.json");
    await writeFile(input, `${JSON.stringify(failed)}${" ".repeat(frozen.INGESTION_LIMITS.decision.bytes - actualBytes)}`);
    let stdout = "";
    let stderr = "";
    expect(await runCheck(["--input", input, "--kind", "decision"], { stdout: (text) => stdout += text, stderr: (text) => stderr += text })).toBe(0);
    await writeFile(input, `${await readFile(input, "utf8")} `);
    stdout = "";
    stderr = "";
    expect(await runCheck(["--input", input, "--kind", "decision"], { stdout: (text) => stdout += text, stderr: (text) => stderr += text })).toBe(2);
    expect(JSON.parse(stderr).code).toBe("CONTRACT_BYTES_LIMIT");
  }, 60_000);

  test("FIFO, symlink, directory, socket, and device inputs terminate with one closed bounded rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-descriptor-input-"));
    temporaryRoots.push(root);
    const regular = join(root, "regular.json");
    const fifo = join(root, "input.fifo");
    const link = join(root, "input.link");
    const socket = join(root, "input.sock");
    await writeFile(regular, "{}\n");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await symlink(regular, link);
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.listen(socket, resolve).once("error", reject));
    try {
      for (const input of [fifo, link, root, socket, "/dev/null"]) {
        const before = input === "/dev/null" ? null : await lstat(input);
        const result = spawnSync(process.execPath, [checkerPath, "--input", input, "--kind", "schema"], { encoding: "utf8", timeout: 1500 });
        expect(result.status, `${input}:${result.signal}:${result.error?.message}`).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n")).toHaveLength(1);
        expect(Buffer.byteLength(result.stderr)).toBeLessThan(512);
        if (before) expect((await lstat(input)).size).toBe(before.size);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
