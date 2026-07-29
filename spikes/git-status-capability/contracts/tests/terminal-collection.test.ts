import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonDigest } from "../lib/canonical-frame";
import { encodeDecisionRowProjection } from "../lib/decision";
import { D9_COMMAND_PROFILE } from "../lib/frozen";
import { ContractError } from "../lib/ingestion";
import {
  enumerateSourceCandidates,
  validateDecision,
  validateFinalBundle,
  validateGitCandidateSet
} from "../lib/schema";

type JsonRecord = Record<string, any>;
type EvidenceLane = "source" | "platform" | "gates" | "final";
type TerminalMode = "accepted" | "ordinary-rejected" | "protection-rejected" | "invalid";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const evidenceRoot = "openspec/changes/m2-capability-observer-spike/evidence";
const manifestRelative = "spikes/git-status-capability/contracts/source-input-v1.paths";
const checkerPath = join(import.meta.dir, "../check.ts");
let generic: JsonRecord;
const digest = "01".repeat(32);
const temporaryRoots: string[] = [];
const clone = <T>(value: T): T => structuredClone(value);

beforeAll(async () => {
  generic = JSON.parse(await readFile(join(import.meta.dir, "../fixtures/valid/generic.json"), "utf8"));
});

afterAll(() => {
  generic = undefined as unknown as JsonRecord;
});

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bindSourceRecord<T>(value: T, sourceRecordSha: string): T {
  const visit = (item: any): any => Array.isArray(item) ? item.map(visit) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key, key === "source_input_record_sha256" ? sourceRecordSha : visit(child)
    ])) : item;
  return visit(value) as T;
}

function sourceRecord(): JsonRecord {
  return clone(generic.source_input_record);
}

function d9Receipts(sourceRecordSha: string): JsonRecord[] {
  return D9_COMMAND_PROFILE.map((profile) => {
    const stdout_summary = "ok";
    const stderr_summary = "";
    return {
      id: profile.id,
      argv: [...profile.argv],
      version: profile.version,
      exit_code: 0,
      stdout_summary,
      stderr_summary,
      summary_digest: canonicalJsonDigest({ stdout_summary, stderr_summary }),
      source_input_record_sha256: sourceRecordSha
    };
  });
}

function repositoryGate(sourceRecordSha: string): JsonRecord {
  return {
    schema_version: "shud.git-status-capability.repository-gate.v1",
    source_input_record_sha256: sourceRecordSha,
    gates: d9Receipts(sourceRecordSha)
  };
}

function immutableReference(
  lane: EvidenceLane,
  platform: "macos" | "linux" | "none",
  sourceRecordSha: string,
  seed: string,
  byteLength: number
): JsonRecord {
  const artifactSha = seed.repeat(64).slice(0, 64);
  return {
    schema_version: "shud.git-status-capability.immutable-evidence-reference.v1",
    lane,
    platform,
    source_input_record_sha256: sourceRecordSha,
    media_type: "application/json",
    sha256: artifactSha,
    byte_length: byteLength,
    immutable_identity: `sha256:${artifactSha}`,
    retention: { policy: "retain-until-change-archived-v1", minimum_days: 3650 },
    access: { scope: "repository-local", requires_network: false },
    offline_retrieval: {
      kind: "content-addressed-path-v1",
      path: `artifacts/sha256/${artifactSha}`,
      sha256: artifactSha,
      byte_length: byteLength
    }
  };
}

function exactImmutableReference(
  lane: EvidenceLane,
  platform: "macos" | "linux" | "none",
  sourceRecordSha: string,
  bytes: Uint8Array
): JsonRecord {
  const reference = immutableReference(lane, platform, sourceRecordSha, "00", bytes.byteLength);
  const artifactSha = sha256(bytes);
  reference.sha256 = artifactSha;
  reference.immutable_identity = `sha256:${artifactSha}`;
  reference.offline_retrieval.path = `artifacts/sha256/${artifactSha}`;
  reference.offline_retrieval.sha256 = artifactSha;
  reference.offline_retrieval.byte_length = bytes.byteLength;
  return reference;
}

function laneSummary(
  lane: EvidenceLane,
  platform: "macos" | "linux" | "none",
  sourceRecordSha: string,
  status: "source-input-recorded" | "platform-observation-recorded" | "repository-gates-passed"
): Buffer {
  return Buffer.from([
    "# SHUD Git Status Capability Evidence",
    "Schema: shud.git-status-capability.markdown-evidence.v1",
    `Lane: ${lane}`,
    `Platform: ${platform}`,
    `Source input: ${digest}`,
    `Source record SHA-256: ${sourceRecordSha}`,
    `Artifact SHA-256: ${"cd".repeat(32)}`,
    `Status: ${status}`,
    ""
  ].join("\n"), "utf8");
}

function outcomeRejected(bundle: JsonRecord): void {
  const row = bundle.rows[0];
  row.observer_outcome = { kind: "dirty" };
  row.row_verdict = "fail";
  const receipt = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1",
    platform: row.platform,
    producer: row.actual_producing_boundary,
    row_id: row.row_id,
    observation_id: row.observation_id,
    supplied_input_digest: row.frame_digest,
    observed_outcome: clone(row.observer_outcome)
  };
  row.failure_cause = {
    kind: "outcome-mismatch-v1",
    receipt: { ...receipt, receipt_digest: canonicalJsonDigest(receipt) }
  };
}

function protectionRejected(bundle: JsonRecord): void {
  const row = bundle.rows[0];
  row.actual_producing_boundary = "tripwire";
  row.control_assertions.protection.verdict = "fail";
  row.protection_set_equal = false;
  row.row_verdict = "fail";
  const failure = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1",
    platform: row.platform,
    producer: "tripwire",
    row_id: row.row_id,
    observation_id: row.observation_id,
    supplied_input_digest: row.frame_digest,
    control_id: "protection",
    control_verdict: "fail"
  };
  row.failure_cause = {
    kind: "control-failure-v1",
    receipt: { ...failure, receipt_digest: canonicalJsonDigest(failure) }
  };
  const protection = bundle.protection_set[0];
  const member = protection.inventory[0];
  member.post_measurement.content.encoding = "observed-change-v1";
  member.post_measurement.content.text = "changed:canonical-superproject\n";
  member.post_measurement.metadata.byte_length = Buffer.byteLength(member.post_measurement.content.text);
  member.post_digest = canonicalJsonDigest(member.post_measurement);
  member.event_material.kind = "verified-changed-v1";
  member.event_material.post_digest = member.post_digest;
  member.event_digest = canonicalJsonDigest(member.event_material);
  const unsigned = Object.fromEntries(Object.entries(protection).filter(([key]) => key !== "receipt_digest"));
  protection.receipt_digest = canonicalJsonDigest(unsigned);
}

function terminalCauses(value: JsonRecord, cause: string): void {
  value.first_cause = cause;
  value.all_failure_codes = [cause];
}

function publicationAssertion(decision: JsonRecord, sourceRecordSha: string): JsonRecord {
  const expected = decision.terminal_decision;
  return {
    schema_version: "shud.git-status-capability.publication-assertion.v1",
    source_input_record_sha256: sourceRecordSha,
    decision_sha256: sha256(jsonBytes(decision)),
    expected_decision: expected,
    command_receipt: {
      argv: [
        "spikes/git-status-capability/verify.sh", "evidence", "expect", expected,
        "--decision", "/external-staging/candidate-decision.json"
      ],
      version: "1",
      exit_code: 0,
      summary_digest: "32".repeat(32)
    }
  };
}

function publicationGovernance(gate: JsonRecord, sourceRecordSha: string): JsonRecord {
  const receipt = gate.gates.find((candidate: JsonRecord) => candidate.id === "GATE-GOVERNANCE");
  const receiptSha = canonicalJsonDigest(receipt);
  return {
    schema_version: "shud.git-status-capability.publication-governance-recheck.v1",
    source_input_record_sha256: sourceRecordSha,
    d9_governance_receipt_sha256: receiptSha,
    repeated_receipt_sha256: receiptSha,
    exact_match: true,
    mutation_count: 0
  };
}

async function temporaryRepository(): Promise<{ root: string; candidates: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "shud-terminal-collection-"));
  temporaryRoots.push(root);
  await cp(join(repositoryRoot, "spikes"), join(root, "spikes"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE
  });
  await cp(
    join(repositoryRoot, "openspec/changes/m2-capability-observer-spike"),
    join(root, "openspec/changes/m2-capability-observer-spike"),
    { recursive: true, mode: constants.COPYFILE_FICLONE }
  );
  return { root, candidates: await enumerateSourceCandidates(root) };
}

async function writeEvidence(root: string, relative: string, value: Uint8Array | JsonRecord): Promise<void> {
  const path = join(root, evidenceRoot, ...relative.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, value instanceof Uint8Array ? value : jsonBytes(value));
}

async function assertViews(
  root: string,
  candidates: string[],
  accepted: boolean,
  label: string,
  publicCheck = false
): Promise<void> {
  if (accepted) await expect(enumerateSourceCandidates(root), `worktree:${label}`).resolves.toBeInstanceOf(Array);
  else await expect(enumerateSourceCandidates(root), `worktree:${label}`).rejects.toBeInstanceOf(ContractError);
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
  const staged = () => validateGitCandidateSet(root, candidates);
  if (accepted) expect(staged, `staged:${label}`).not.toThrow();
  else expect(staged, `staged:${label}`).toThrow(ContractError);
  if (publicCheck) {
    const result = spawnSync(process.execPath, [
      checkerPath, "--repository-root", root, "--manifest", manifestRelative, "--check-current"
    ], { cwd: root, encoding: "utf8" });
    expect(result.status, `public:${label}`).toBe(accepted ? 0 : 2);
    if (accepted) expect(result.stderr, `public-stderr:${label}`).toBe("");
    else {
      expect(result.stdout, `public-stdout:${label}`).toBe("");
      expect(result.stderr, `public-stderr:${label}`).toContain("CONTRACT_SCHEMA_INVALID");
    }
  }
}

async function validationViews(root: string, candidates: string[]): Promise<[boolean, boolean, boolean]> {
  let worktree = true;
  try {
    await enumerateSourceCandidates(root);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    worktree = false;
  }
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], {
    cwd: root
  }).status).toBe(0);
  let staged = true;
  try {
    validateGitCandidateSet(root, candidates);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    staged = false;
  }
  const result = spawnSync(process.execPath, [
    checkerPath, "--repository-root", root, "--manifest", manifestRelative, "--check-current"
  ], { cwd: root, encoding: "utf8" });
  expect([0, 2]).toContain(result.status);
  if (result.status === 0) expect(result.stderr).toBe("");
  else {
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CONTRACT_SCHEMA_INVALID");
  }
  return [worktree, staged, result.status === 0];
}

const mandatoryPaths = Object.freeze([
  `source/${digest}/source-input-record.json`,
  `platform/${digest}/macos/platform-bundle.json`,
  `platform/${digest}/linux/platform-bundle.json`,
  `gates/${digest}/repository-gate.json`,
  `final/${digest}/source-input-record.json`,
  `final/${digest}/final-bundle.json`,
  `final/${digest}/decision.json`,
  `final/${digest}/publication-assertion.json`,
  `final/${digest}/publication-governance-recheck.json`
]);

async function removeEvidence(root: string, relative: string): Promise<void> {
  await rm(join(root, evidenceRoot, ...relative.split("/")));
}

async function installReferencedTerminal(): Promise<{ root: string; candidates: string[]; sourceRecordSha: string }> {
  const { root, candidates } = await temporaryRepository();
  const sourceBytes = jsonBytes(sourceRecord());
  const sourceRecordSha = sha256(sourceBytes);
  await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
  await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceBytes);
  const references: Array<[string, JsonRecord]> = [
    [`platform/${digest}/macos/platform-bundle.json`, immutableReference("platform", "macos", sourceRecordSha, "81", 1)],
    [`platform/${digest}/linux/platform-bundle.json`, immutableReference("platform", "linux", sourceRecordSha, "82", 1)],
    [`gates/${digest}/repository-gate.json`, immutableReference("gates", "none", sourceRecordSha, "83", 1)],
    [`final/${digest}/final-bundle.json`, immutableReference("final", "none", sourceRecordSha, "84", 1)],
    [`final/${digest}/decision.json`, immutableReference("final", "none", sourceRecordSha, "85", 1)],
    [`final/${digest}/publication-assertion.json`, immutableReference("final", "none", sourceRecordSha, "86", 1)],
    [`final/${digest}/publication-governance-recheck.json`, immutableReference("final", "none", sourceRecordSha, "87", 1)]
  ];
  for (const [path, value] of references) await writeEvidence(root, path, value);
  return { root, candidates, sourceRecordSha };
}

async function installCheckpoint(
  stage: "source" | "platform" | "gates",
  referenced: boolean
): Promise<{ root: string; candidates: string[] }> {
  const { root, candidates } = await temporaryRepository();
  const sourceBytes = jsonBytes(sourceRecord());
  const sourceRecordSha = sha256(sourceBytes);
  await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
  await writeEvidence(root, `source/${digest}/summary.md`,
    laneSummary("source", "none", sourceRecordSha, "source-input-recorded"));
  if (stage === "source") return { root, candidates };
  await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`, referenced
    ? immutableReference("platform", "macos", sourceRecordSha, "91", 1)
    : bindSourceRecord(clone(generic.platform_bundle), sourceRecordSha));
  await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`, referenced
    ? immutableReference("platform", "linux", sourceRecordSha, "92", 1)
    : bindSourceRecord(clone(generic.linux_platform_bundle), sourceRecordSha));
  await writeEvidence(root, `platform/${digest}/macos/summary.md`,
    laneSummary("platform", "macos", sourceRecordSha, "platform-observation-recorded"));
  await writeEvidence(root, `platform/${digest}/linux/summary.md`,
    laneSummary("platform", "linux", sourceRecordSha, "platform-observation-recorded"));
  if (stage === "platform") return { root, candidates };
  await writeEvidence(root, `gates/${digest}/repository-gate.json`, referenced
    ? immutableReference("gates", "none", sourceRecordSha, "93", 1)
    : repositoryGate(sourceRecordSha));
  await writeEvidence(root, `gates/${digest}/summary.md`,
    laneSummary("gates", "none", sourceRecordSha, "repository-gates-passed"));
  return { root, candidates };
}

function refreshDirectDigests(collection: DirectCollection): void {
  collection.finalBundle.macos_bundle_sha256 = sha256(jsonBytes(collection.macos));
  collection.finalBundle.linux_bundle_sha256 = sha256(jsonBytes(collection.linux));
  collection.finalBundle.decision_projection_digest = canonicalJsonDigest(collection.decision);
  if (collection.assertion) collection.assertion = publicationAssertion(collection.decision, collection.sourceRecordSha);
}

type DirectCollection = {
  root: string;
  candidates: string[];
  sourceRecordSha: string;
  macos: JsonRecord;
  linux: JsonRecord;
  gate: JsonRecord;
  finalBundle: JsonRecord;
  decision: JsonRecord;
  assertion?: JsonRecord;
  governance: JsonRecord;
};

async function installDirect(mode: TerminalMode): Promise<DirectCollection> {
  const { root, candidates } = await temporaryRepository();
  const source = sourceRecord();
  const sourceBytes = jsonBytes(source);
  const sourceRecordSha = sha256(sourceBytes);
  const macos = bindSourceRecord(clone(generic.platform_bundle), sourceRecordSha);
  const linux = bindSourceRecord(clone(generic.linux_platform_bundle), sourceRecordSha);
  if (mode === "ordinary-rejected") outcomeRejected(macos);
  if (mode === "protection-rejected") protectionRejected(macos);
  const gate = repositoryGate(sourceRecordSha);
  const decision = bindSourceRecord(clone(generic.decision), sourceRecordSha);
  if (mode === "ordinary-rejected" || mode === "protection-rejected") {
    const row = macos.rows[0];
    const index = decision.rows.findIndex((scalar: string) => {
      const fields = scalar.split("\0");
      return fields[0] === "m" && fields[1] === row.row_id;
    });
    decision.rows[index] = encodeDecisionRowProjection(row);
    decision.terminal_decision = "rejected";
    terminalCauses(decision, "ROW_VERDICT_FAILED");
  } else if (mode === "invalid") {
    decision.run_status = "invalid";
    delete decision.terminal_decision;
    decision.sbom_completeness_verdict = "fail";
    terminalCauses(decision, "SUPPLY_SBOM_INCOMPLETE");
  }
  const finalBundle = bindSourceRecord(clone(generic.final_bundle), sourceRecordSha);
  finalBundle.macos_bundle_sha256 = sha256(jsonBytes(macos));
  finalBundle.linux_bundle_sha256 = sha256(jsonBytes(linux));
  finalBundle.repository_gate_sha256 = sha256(jsonBytes(gate));
  finalBundle.repository_gates = clone(gate.gates);
  finalBundle.decision_projection_digest = canonicalJsonDigest(decision);
  if (mode === "ordinary-rejected" || mode === "protection-rejected") {
    finalBundle.terminal_decision = "rejected";
    terminalCauses(finalBundle, "ROW_VERDICT_FAILED");
  } else if (mode === "invalid") {
    finalBundle.run_status = "invalid";
    delete finalBundle.terminal_decision;
    finalBundle.completeness.sbom_completeness_verdict = "fail";
    terminalCauses(finalBundle, "SUPPLY_SBOM_INCOMPLETE");
  }
  const assertion = mode === "invalid" ? undefined : publicationAssertion(decision, sourceRecordSha);
  const governance = publicationGovernance(gate, sourceRecordSha);
  const collection = { root, candidates, sourceRecordSha, macos, linux, gate, finalBundle, decision, assertion, governance };
  await persistDirect(collection, sourceBytes);
  return collection;
}

async function persistDirect(collection: DirectCollection, sourceBytes = jsonBytes(sourceRecord())): Promise<void> {
  const { root, macos, linux, gate, finalBundle, decision, assertion, governance } = collection;
  await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
  await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`, macos);
  await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`, linux);
  await writeEvidence(root, `gates/${digest}/repository-gate.json`, gate);
  await writeEvidence(root, `final/${digest}/source-input-record.json`, sourceBytes);
  await writeEvidence(root, `final/${digest}/final-bundle.json`, finalBundle);
  await writeEvidence(root, `final/${digest}/decision.json`, decision);
  if (assertion) await writeEvidence(root, `final/${digest}/publication-assertion.json`, assertion);
  await writeEvidence(root, `final/${digest}/publication-governance-recheck.json`, governance);
}

const replaceableArtifacts = Object.freeze([
  ["macos", "platform", "macos", `platform/${digest}/macos/platform-bundle.json`],
  ["linux", "platform", "linux", `platform/${digest}/linux/platform-bundle.json`],
  ["gate", "gates", "none", `gates/${digest}/repository-gate.json`],
  ["finalBundle", "final", "none", `final/${digest}/final-bundle.json`],
  ["decision", "final", "none", `final/${digest}/decision.json`],
  ["assertion", "final", "none", `final/${digest}/publication-assertion.json`],
  ["governance", "final", "none", `final/${digest}/publication-governance-recheck.json`]
] as const satisfies ReadonlyArray<readonly [keyof DirectCollection, EvidenceLane, "macos" | "linux" | "none", string]>);

async function replaceWithExactReference(
  collection: DirectCollection,
  key: typeof replaceableArtifacts[number][0]
): Promise<void> {
  const descriptor = replaceableArtifacts.find(([candidate]) => candidate === key);
  if (!descriptor) throw new Error(`missing replaceable artifact descriptor: ${key}`);
  const [, lane, platform, path] = descriptor;
  const value = collection[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing direct artifact: ${key}`);
  const bytes = jsonBytes(value);
  await writeEvidence(collection.root, path,
    exactImmutableReference(lane, platform, collection.sourceRecordSha, bytes));
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Phase 6.2 terminal evidence collection", () => {
  test("each exact single-artifact reference preserves an accepted published collection in every view", async () => {
    const results: Array<[string, [boolean, boolean, boolean]]> = [];
    for (const [key] of replaceableArtifacts) {
      const collection = await installDirect("accepted");
      await replaceWithExactReference(collection, key);
      results.push([key, await validationViews(collection.root, collection.candidates)]);
    }
    expect(results).toEqual(replaceableArtifacts.map(([key]) => [key, [true, true, true]]));
  }, 600_000);

  test("visible invalid terminal peers reject mixed reference publications in every view", async () => {
    const results: Array<[string, [boolean, boolean, boolean]]> = [];

    const referencedDecision = await installDirect("invalid");
    await replaceWithExactReference(referencedDecision, "decision");
    await writeEvidence(referencedDecision.root, `final/${digest}/publication-assertion.json`,
      immutableReference("final", "none", referencedDecision.sourceRecordSha, "d1", 1));
    results.push(["direct-invalid-final", await validationViews(referencedDecision.root, referencedDecision.candidates)]);

    const referencedFinal = await installDirect("invalid");
    await replaceWithExactReference(referencedFinal, "finalBundle");
    await writeEvidence(referencedFinal.root, `final/${digest}/publication-assertion.json`,
      immutableReference("final", "none", referencedFinal.sourceRecordSha, "d2", 1));
    results.push(["direct-invalid-decision", await validationViews(referencedFinal.root, referencedFinal.candidates)]);

    const referencedReceipts = await installDirect("invalid");
    await writeEvidence(referencedReceipts.root, `final/${digest}/publication-assertion.json`,
      immutableReference("final", "none", referencedReceipts.sourceRecordSha, "d3", 1));
    await replaceWithExactReference(referencedReceipts, "governance");
    results.push(["direct-invalid-peers", await validationViews(referencedReceipts.root, referencedReceipts.candidates)]);

    expect(results).toEqual([
      ["direct-invalid-final", [false, false, false]],
      ["direct-invalid-decision", [false, false, false]],
      ["direct-invalid-peers", [false, false, false]]
    ]);
  }, 300_000);

  test("direct final hash consumers reject drift from exact referenced producers", async () => {
    const cases: Array<[string, "macos" | "gate", keyof JsonRecord]> = [
      ["platform", "macos", "macos_bundle_sha256"],
      ["gate", "gate", "repository_gate_sha256"]
    ];
    for (const [label, key, digestField] of cases) {
      const collection = await installDirect("accepted");
      await replaceWithExactReference(collection, key);
      collection.finalBundle[digestField] = "fe".repeat(32);
      await writeEvidence(collection.root, `final/${digest}/final-bundle.json`, collection.finalBundle);
      await assertViews(collection.root, collection.candidates, false, `referenced-producer:${label}`, true);
    }

    const referencedDecision = await installDirect("accepted");
    await replaceWithExactReference(referencedDecision, "decision");
    referencedDecision.assertion!.decision_sha256 = "fe".repeat(32);
    await writeEvidence(referencedDecision.root, `final/${digest}/publication-assertion.json`,
      referencedDecision.assertion!);
    await assertViews(referencedDecision.root, referencedDecision.candidates, false,
      "referenced-producer:decision", true);
  }, 180_000);

  test("direct platform supply identities are bound to the decision projection in both views", async () => {
    const mutations: Array<[string, (bundle: JsonRecord) => void]> = [
      ["source-commit", (bundle) => { bundle.source_commit = "02".repeat(20); }],
      ["catalog", (bundle) => { bundle.catalog_digest = "03".repeat(32); }],
      ["target", (bundle) => {
        bundle.target = bundle.platform === "macos" ? "x86_64-unknown-linux-gnu" : "aarch64-apple-darwin";
      }],
      ["target-graph", (bundle) => { bundle.dependency_graph_digest = "04".repeat(32); }],
      ["direct-feature", (bundle) => { bundle.direct_feature_digest = "05".repeat(32); }],
      ["call-ledger", (bundle) => { bundle.call_ledger_digest = "06".repeat(32); }],
      ["sbom", (bundle) => { bundle.sbom_digest = "07".repeat(32); }],
      ["license-inventory", (bundle) => { bundle.license_inventory_digest = "08".repeat(32); }],
      ["toolchain", (bundle) => { bundle.toolchain.rustc_vv = "rustc 1.88.0 (drift)"; }]
    ];
    for (const platform of ["macos", "linux"] as const) {
      for (const [field, mutate] of mutations) {
        const collection = await installDirect("accepted");
        mutate(collection[platform]);
        refreshDirectDigests(collection);
        await persistDirect(collection);
        await assertViews(collection.root, collection.candidates, false, `${platform}:${field}`);
      }
    }
  }, 900_000);

  test("public checker rejects a complete collection with platform supply drift", async () => {
    const collection = await installDirect("accepted");
    collection.macos.sbom_digest = "09".repeat(32);
    refreshDirectDigests(collection);
    await persistDirect(collection);
    expect(spawnSync("git", ["init", "-q"], { cwd: collection.root }).status).toBe(0);
    expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], {
      cwd: collection.root
    }).status).toBe(0);
    const result = spawnSync(process.execPath, [
      checkerPath, "--repository-root", collection.root, "--manifest", manifestRelative, "--check-current"
    ], { cwd: collection.root, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CONTRACT_SCHEMA_INVALID");
  }, 120_000);

  test("every direct descendant binds the exact source-record bytes in worktree and staged views", async () => {
    const wrongSha = "ff".repeat(32);
    const cases: Array<[string, string, JsonRecord]> = [
      ["platform", `platform/${digest}/macos/platform-bundle.json`, bindSourceRecord(clone(generic.platform_bundle), wrongSha)],
      ["gates", `gates/${digest}/repository-gate.json`, repositoryGate(wrongSha)],
      ["final", `final/${digest}/final-bundle.json`, bindSourceRecord(clone(generic.final_bundle), wrongSha)],
      ["decision", `final/${digest}/decision.json`, bindSourceRecord(clone(generic.decision), wrongSha)],
      ["publication", `final/${digest}/publication-assertion.json`, bindSourceRecord(clone(generic.publication_assertion), wrongSha)],
      ["governance", `final/${digest}/publication-governance-recheck.json`, bindSourceRecord(clone(generic.publication_governance_recheck), wrongSha)]
    ];
    for (const [label, path, value] of cases) {
      const { root, candidates } = await temporaryRepository();
      await writeEvidence(root, `source/${digest}/source-input-record.json`, jsonBytes(sourceRecord()));
      await writeEvidence(root, path, value);
      await assertViews(root, candidates, false, label);
    }
  }, 180_000);

  test("immutable references reject zero bytes and preserve the one-byte boundary in both views", async () => {
    for (const byteLength of [0, 1]) {
      const { root, candidates } = await temporaryRepository();
      const sourceBytes = jsonBytes(sourceRecord());
      const sourceRecordSha = sha256(sourceBytes);
      await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
      await writeEvidence(root, `platform/${digest}/macos/platform-bundle.json`,
        immutableReference("platform", "macos", sourceRecordSha, "8a", byteLength));
      await writeEvidence(root, `platform/${digest}/linux/platform-bundle.json`,
        immutableReference("platform", "linux", sourceRecordSha, "8b", 1));
      await assertViews(root, candidates, byteLength === 1, `${byteLength}-byte-reference`);
    }
  }, 60_000);

  test("complete direct terminal states and content-addressed reference layouts are admitted", async () => {
    for (const mode of ["accepted", "ordinary-rejected", "protection-rejected"] as const) {
      const collection = await installDirect(mode);
      await assertViews(collection.root, collection.candidates, true, mode);
    }

    const referenced = await installReferencedTerminal();
    await assertViews(referenced.root, referenced.candidates, true, "content-addressed-reference-layout");
  }, 240_000);

  test("only monotonic Tasks 5.1-5.3 checkpoints and complete Task 5.4 publication are admitted", async () => {
    for (const stage of ["source", "platform", "gates"] as const) {
      for (const referenced of [false, true]) {
        if (stage === "source" && referenced) continue;
        const checkpoint = await installCheckpoint(stage, referenced);
        await assertViews(checkpoint.root, checkpoint.candidates, true, `${stage}:${referenced ? "referenced" : "direct"}`);
      }
    }

    const sourceBytes = jsonBytes(sourceRecord());
    const sourceRecordSha = sha256(sourceBytes);
    const invalidOrders: Array<[string, Array<[string, Uint8Array | JsonRecord]>]> = [
      ["one-platform", [[`platform/${digest}/macos/platform-bundle.json`,
        immutableReference("platform", "macos", sourceRecordSha, "a1", 1)]]],
      ["gate-before-platforms", [[`gates/${digest}/repository-gate.json`,
        immutableReference("gates", "none", sourceRecordSha, "a2", 1)]]],
      ["final-source-before-gate", [[`final/${digest}/source-input-record.json`, sourceBytes]]],
      ["final-artifact-before-gate", [[`final/${digest}/final-bundle.json`,
        immutableReference("final", "none", sourceRecordSha, "a3", 1)]]]
    ];
    for (const [label, artifacts] of invalidOrders) {
      const { root, candidates } = await temporaryRepository();
      await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
      for (const [path, value] of artifacts) await writeEvidence(root, path, value);
      await assertViews(root, candidates, false, label, true);
    }
  }, 300_000);

  test("each mandatory direct and referenced terminal path is required by every public validation view", async () => {
    for (const representation of ["direct", "referenced"] as const) {
      for (const path of mandatoryPaths) {
        const collection = representation === "direct"
          ? await installDirect("accepted")
          : await installReferencedTerminal();
        await removeEvidence(collection.root, path);
        await assertViews(collection.root, collection.candidates, false, `${representation}:omit:${path}`, true);
      }
    }
  }, 900_000);

  test("exact canonical paths admit references while renamed or misplaced references do not", async () => {
    const renamed = await installReferencedTerminal();
    await rename(
      join(renamed.root, evidenceRoot, `platform/${digest}/macos/platform-bundle.json`),
      join(renamed.root, evidenceRoot, `platform/${digest}/macos/renamed-platform-bundle.json`)
    );
    await assertViews(renamed.root, renamed.candidates, false, "renamed-platform-reference", true);

    const misplaced = await installReferencedTerminal();
    await removeEvidence(misplaced.root, `gates/${digest}/repository-gate.json`);
    await writeEvidence(misplaced.root, `final/${digest}/misplaced-repository-gate.json`,
      immutableReference("final", "none", misplaced.sourceRecordSha, "b1", 1));
    await assertViews(misplaced.root, misplaced.candidates, false, "misplaced-gate-reference", true);

    const finalSourceReference = await installReferencedTerminal();
    await writeEvidence(finalSourceReference.root, `final/${digest}/source-input-record.json`,
      immutableReference("final", "none", finalSourceReference.sourceRecordSha, "b2", 1));
    await assertViews(finalSourceReference.root, finalSourceReference.candidates, false, "referenced-final-source", true);
  }, 300_000);

  test("invalid records remain valid in isolation but cannot form a published evidence tree", async () => {
    const invalid = await installDirect("invalid");
    expect(validateFinalBundle(invalid.finalBundle)).toBe(true);
    expect(validateDecision(invalid.decision)).toBe(true);
    await assertViews(invalid.root, invalid.candidates, false, "invalid-published-tree", true);
  }, 120_000);

  test("cross-record terminal flips and stale projections fail closed in both views", async () => {
    const cases: Array<[string, TerminalMode, (collection: DirectCollection) => void]> = [
      ["terminal-flip", "accepted", ({ finalBundle }) => {
        finalBundle.terminal_decision = "rejected";
        terminalCauses(finalBundle, "ROW_VERDICT_FAILED");
      }],
      ["stale-decision-projection", "accepted", ({ finalBundle }) => {
        finalBundle.decision_projection_digest = "ee".repeat(32);
      }],
      ["cause-mismatch", "ordinary-rejected", ({ finalBundle }) => {
        terminalCauses(finalBundle, "DIFFERENT_ROW_CAUSE");
      }],
      ["completeness-mismatch", "invalid", ({ finalBundle }) => {
        finalBundle.completeness.direct_feature_completeness_verdict = "fail";
        finalBundle.first_cause = "SUPPLY_DIRECT_FEATURE_INCOMPLETE";
        finalBundle.all_failure_codes = ["SUPPLY_DIRECT_FEATURE_INCOMPLETE", "SUPPLY_SBOM_INCOMPLETE"];
      }],
      ["coverage-mismatch", "invalid", ({ finalBundle }) => {
        finalBundle.coverage.macos_rows = 173;
        finalBundle.all_failure_codes = ["COVERAGE_MACOS_INCOMPLETE", "SUPPLY_SBOM_INCOMPLETE"];
      }],
      ["d9-projection-mismatch", "accepted", ({ decision, finalBundle }) => {
        const fields = decision.gates[0].split("\0");
        fields[4] = "dd".repeat(32);
        decision.gates[0] = fields.join("\0");
        finalBundle.decision_projection_digest = canonicalJsonDigest(decision);
      }],
      ["raw-platform-protection-mismatch", "protection-rejected", ({ decision, finalBundle, sourceRecordSha }) => {
        Object.assign(decision, bindSourceRecord(clone(generic.decision), sourceRecordSha));
        delete decision.first_cause;
        delete decision.all_failure_codes;
        finalBundle.terminal_decision = "accepted";
        delete finalBundle.first_cause;
        delete finalBundle.all_failure_codes;
        finalBundle.decision_projection_digest = canonicalJsonDigest(decision);
      }]
    ];
    for (const [label, mode, mutate] of cases) {
      const collection = await installDirect(mode);
      mutate(collection);
      if (collection.assertion) collection.assertion = publicationAssertion(collection.decision, collection.sourceRecordSha);
      await persistDirect(collection);
      await assertViews(collection.root, collection.candidates, false, label);
    }

    const publicationMismatch = await installDirect("accepted");
    publicationMismatch.assertion!.expected_decision = "rejected";
    publicationMismatch.assertion!.command_receipt.argv[3] = "rejected";
    await persistDirect(publicationMismatch);
    await assertViews(publicationMismatch.root, publicationMismatch.candidates, false, "publication-terminal-mismatch");
  }, 300_000);

  test("publication cannot invent a decision for an invalid or missing decision collection", async () => {
    const invalid = await installDirect("invalid");
    invalid.assertion = publicationAssertion({ ...invalid.decision, terminal_decision: "accepted" }, invalid.sourceRecordSha);
    invalid.assertion.decision_sha256 = sha256(jsonBytes(invalid.decision));
    await persistDirect(invalid);
    await assertViews(invalid.root, invalid.candidates, false, "invalid-publication");

    const { root, candidates } = await temporaryRepository();
    const sourceBytes = jsonBytes(sourceRecord());
    const sourceRecordSha = sha256(sourceBytes);
    const accepted = bindSourceRecord(clone(generic.decision), sourceRecordSha);
    await writeEvidence(root, `source/${digest}/source-input-record.json`, sourceBytes);
    await writeEvidence(root, `final/${digest}/publication-assertion.json`, publicationAssertion(accepted, sourceRecordSha));
    await assertViews(root, candidates, false, "missing-decision-publication");

    const publicResult = spawnSync(process.execPath, [
      checkerPath, "--repository-root", root, "--manifest", manifestRelative, "--check-current"
    ], { cwd: root, encoding: "utf8" });
    expect(publicResult.status).toBe(2);
    expect(publicResult.stdout).toBe("");
  }, 120_000);
});
