import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonDigest } from "../lib/canonical-frame";
import { encodeDecisionRowProjection } from "../lib/decision";
import { D9_COMMAND_PROFILE } from "../lib/frozen";
import { ContractError } from "../lib/ingestion";
import { enumerateSourceCandidates, validateGitCandidateSet } from "../lib/schema";

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

async function assertViews(root: string, candidates: string[], accepted: boolean, label: string): Promise<void> {
  if (accepted) await expect(enumerateSourceCandidates(root), `worktree:${label}`).resolves.toBeInstanceOf(Array);
  else await expect(enumerateSourceCandidates(root), `worktree:${label}`).rejects.toBeInstanceOf(ContractError);
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "spikes/git-status-capability", "openspec/changes/m2-capability-observer-spike"], { cwd: root }).status).toBe(0);
  const staged = () => validateGitCandidateSet(root, candidates);
  if (accepted) expect(staged, `staged:${label}`).not.toThrow();
  else expect(staged, `staged:${label}`).toThrow(ContractError);
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

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Phase 6.2 terminal evidence collection", () => {
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
      await writeEvidence(root, `gates/${digest}/repository-gate.json`, immutableReference("gates", "none", sourceRecordSha, "8a", byteLength));
      await assertViews(root, candidates, byteLength === 1, `${byteLength}-byte-reference`);
    }
  }, 60_000);

  test("complete direct terminal states and content-addressed reference layouts are admitted", async () => {
    for (const mode of ["accepted", "ordinary-rejected", "protection-rejected", "invalid"] as const) {
      const collection = await installDirect(mode);
      await assertViews(collection.root, collection.candidates, true, mode);
    }

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
    await assertViews(root, candidates, true, "content-addressed-reference-layout");
  }, 240_000);

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
