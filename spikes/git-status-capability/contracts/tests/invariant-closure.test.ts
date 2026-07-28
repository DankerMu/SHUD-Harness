import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFrameBytes, canonicalFrameChecksum } from "../lib/canonical-frame";
import { canonicalWireFrameBytes, canonicalWireFrameDigest, canonicalWireFrameMaterial } from "../lib/wire-frame";
import { runCheck } from "../lib/checker";
import { CATALOG_V1, CONTROL_ASSERTION_IDS, FLOOR_V1 } from "../lib/frozen";
import {
  enumerateSourceCandidates,
  validateContract,
  validateDependencyCatalog,
  validateDecision,
  validateFinalBundle,
  validateFrame,
  validatePlatformBundle,
  validateRowEvidence,
  validateSourceInputRecord,
  validateSupplyFiles
} from "../lib/schema";
import { frameForEvidenceSlot, materialFrame, resealFrame } from "./frame-fixture";

const contractRoot = join(import.meta.dir, "..");
const repositoryRoot = join(contractRoot, "..", "..", "..");
const shaA = "01".repeat(32);
const shaB = "ab".repeat(32);
const frameEvidenceEncoding = "shud.git-status-capability.canonical-frame-json.v1";
const frameEvidenceFields = [
  "schema_version", "catalog_version", "row_id", "observation_id", "checkout_capability_identity",
  "git_state_generation_digest", "body_length", "body_digest", "checksum", "index", "head_tree",
  "effective_config", "exclude_state", "attribute_state", "nested_state", "limit_stimulus"
] as const;

function canonicalEvidenceValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalEvidenceValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
    .map((key) => [key, canonicalEvidenceValue(value[key])]));
}

function canonicalFrameEvidenceBytes(frame: Record<string, any>): Buffer {
  const entries = frameEvidenceFields.filter((field) => Object.hasOwn(frame, field))
    .map((field) => [field, canonicalEvidenceValue(frame[field])]);
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8");
}

function synchronizeRowDeclarations(row: any, recomputeChecksum: boolean): void {
  const frame = row.frame_binding.scheduled.frame_reference.frame;
  if (recomputeChecksum) frame.checksum = canonicalFrameChecksum(frame);
  const bytes = canonicalWireFrameBytes(frame);
  const digest = canonicalWireFrameDigest(frame);
  row.git_state_generation_digest = frame.git_state_generation_digest;
  row.frame_digest = digest;
  Object.assign(row.frame_binding.scheduled, {
    git_state_generation_digest: frame.git_state_generation_digest,
    input_length: bytes.length,
    input_digest: digest
  });
  Object.assign(row.frame_binding.supplied, {
    git_state_generation_digest: frame.git_state_generation_digest,
    input_length: bytes.length,
    input_digest: digest
  });
}

function frameForSlot(rowId: string, observationId: string, capabilityIdentity: string): Record<string, any> {
  const frame = materialFrame();
  frame.row_id = rowId;
  frame.observation_id = observationId;
  frame.checkout_capability_identity = capabilityIdentity;
  return resealFrame(frame);
}

function bindRowFrame(row: any, frame = frameForEvidenceSlot(row.platform, row.row_id, row.observation_id, row.checkout_capability_identity)): void {
  const frameBytes = canonicalWireFrameBytes(frame);
  const frameDigest = canonicalWireFrameDigest(frame);
  row.git_state_generation_digest = frame.git_state_generation_digest;
  row.frame_digest = frameDigest;
  const slot = {
    row_id: row.row_id,
    observation_id: row.observation_id,
    checkout_capability_identity: row.checkout_capability_identity,
    git_state_generation_digest: frame.git_state_generation_digest,
    input_length: frameBytes.length,
    input_digest: frameDigest
  };
  row.frame_binding = {
    scheduled: {
      ...slot,
      material: canonicalWireFrameMaterial(frame),
      frame_reference: { encoding: frameEvidenceEncoding, frame }
    },
    supplied: { ...slot, material: { kind: "scheduled-input-v1" } }
  };
}

function outcome(text: string): Record<string, string> {
  const rejected = /^rejected\(([^)]+)\)$/.exec(text);
  return rejected ? { kind: "rejected", code: rejected[1]! } : { kind: text };
}

async function oracleTables(): Promise<{ rows: Map<string, string>; floors: string[][] }> {
  const design = await readFile(join(repositoryRoot, "openspec/changes/m2-capability-observer-spike/design.md"), "utf8");
  const rows = new Map<string, string>();
  const floors: string[][] = [];
  for (const line of design.split("\n")) {
    const row = /^\| `((?:BAS|STG|UNT|ATR|CFG|IDX|LAY|NES|CAP|HLP|PRT|LIM|LIF|DET)-\d{3})` \|.*\| `([^`]+)` \| `([^`]+)` \|$/.exec(line);
    if (row) {
      expect(row[2]).toBe(row[3]);
      rows.set(row[1]!, row[2]!);
    }
    const floor = /^\| `F132-(\d{2})`.*\| `([^`]+)` \| ([0-9.]+) \/ ([0-9.]+) \| (.*) \|$/.exec(line);
    if (floor) floors.push([`F132-${floor[1]}`, floor[2]!, floor[3]!, floor[4]!, floor[5]!.replaceAll("`", "")]);
  }
  return { rows, floors };
}

function validRow(): Record<string, unknown> {
  const frame = frameForSlot("BAS-001", shaA, shaB);
  const frameBytes = canonicalWireFrameBytes(frame);
  const frameDigest = canonicalWireFrameDigest(frame);
  return {
    schema_version: "shud.git-status-capability.row-evidence.v1", platform: "macos", row_id: "BAS-001",
    observation_id: shaA, checkout_capability_identity: shaB,
    git_state_generation_digest: frame.git_state_generation_digest, frame_digest: frameDigest,
    frame_binding: {
      scheduled: {
        row_id: "BAS-001", observation_id: shaA, checkout_capability_identity: shaB,
        git_state_generation_digest: frame.git_state_generation_digest,
        input_length: frameBytes.length, input_digest: frameDigest,
        material: canonicalWireFrameMaterial(frame),
        frame_reference: { encoding: frameEvidenceEncoding, frame }
      },
      supplied: {
        row_id: "BAS-001", observation_id: shaA, checkout_capability_identity: shaB,
        git_state_generation_digest: frame.git_state_generation_digest,
        input_length: frameBytes.length, input_digest: frameDigest,
        material: { kind: "scheduled-input-v1" }
      }
    },
    expected_outcome: { kind: "clean" }, observer_outcome: { kind: "clean" }, producing_boundary: "observer",
    actual_producing_boundary: "observer",
    row_verdict: "pass", oracle_digest: shaA,
    control_assertions: Object.fromEntries(CONTROL_ASSERTION_IDS.map((id) => [id, { active: true, verdict: "pass" }])),
    protection_set_equal: true,
    cleanup: { verdict: "pass", descriptors_restored: true, processes_reaped: true },
    resource_record: { boundary_class: "below", declared_limit: "none", within_limits: true },
    actual_resource_record: { boundary_class: "below", declared_limit: "none", within_limits: true },
    source_input_record_sha256: shaB
  };
}

function d8Decision(generic: any): Record<string, any> {
  return structuredClone(generic.decision);
}

function decisionRowFields(row: string): string[] {
  return row.split("\0");
}

function mutateDecisionRow(decision: Record<string, any>, rowIndex: number, segment: number, value: string): void {
  const fields = decisionRowFields(decision.rows[rowIndex]);
  fields[segment] = value;
  decision.rows[rowIndex] = fields.join("\0");
}

function admittedPaths() {
  return [{ path: "a.txt", git_mode: "100644" }, { path: "bin/run", git_mode: "100755" }];
}

function manifestDigest(): string {
  const pieces = [Buffer.from("SHUD-HARNESS\0GIT-STATUS-CAPABILITY\0SOURCE-MANIFEST-DIGEST\0V1\n", "utf8")];
  for (const entry of admittedPaths()) pieces.push(Buffer.from(`${entry.git_mode}\0${entry.path}\n`, "utf8"));
  return createHash("sha256").update(Buffer.concat(pieces)).digest("hex");
}

function encoder(identity: string) {
  return { identity, result: { source_input_digest: shaA, manifest_digest: manifestDigest(), entry_count: 2, admitted_paths: admittedPaths() } };
}

function validSourceRecord(): Record<string, unknown> {
  return {
    schema_version: "shud.git-status-capability.source-input-record.v1", source_sha: "01".repeat(20),
    source_input_digest: shaA, manifest_digest: manifestDigest(), entry_count: 2, admitted_paths: admittedPaths(),
    primary_encoder: encoder("source-input-primary-v1"), witness_encoder: encoder("source-input-witness-v1"),
    command_receipt: {
      argv: [
        "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", "01".repeat(20),
        "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
        "--witness", "source-input-witness-v1", "--record", "/external-evidence-root/source-input-record.json", "--create"
      ],
      version: "1", exit_code: 0
    }
  };
}

function validFrame(): Record<string, unknown> {
  return materialFrame();
}

describe("round-1 invariant closure", () => {
  test("exhaustively binds all 174 outcomes to the reviewed OpenSpec table", async () => {
    const oracle = await oracleTables();
    expect(oracle.rows.size).toBe(174);
    expect(CATALOG_V1).toHaveLength(174);
    for (const row of CATALOG_V1) {
      expect(row.macos_expected).toEqual(outcome(oracle.rows.get(row.id)!));
      expect(row.linux_expected).toEqual(outcome(oracle.rows.get(row.id)!));
    }
  });

  test("exhaustively binds all 25 floor oracle/owner tuples to OpenSpec", async () => {
    const oracle = await oracleTables();
    expect(oracle.floors).toHaveLength(25);
    expect(FLOOR_V1.map((item) => [item.floor_id, item.row_id, item.fixture_owner, item.native_owner, item.oracle])).toEqual(oracle.floors);
  });

  test("row evidence binds its frozen platform slot, replay identities, and verdict iff", () => {
    expect(validateRowEvidence(validRow())).toBe(true);
    for (const mutate of [
      (row: any) => { row.expected_outcome = { kind: "dirty" }; },
      (row: any) => { row.row_verdict = "fail"; },
      (row: any) => { delete row.observation_id; },
      (row: any) => { delete row.control_assertions.oracle; },
      (row: any) => { row.control_assertions.network.active = false; },
      (row: any) => { row.frame_digest = "short"; },
      (row: any) => { delete row.frame_binding.supplied.input_length; },
      (row: any) => { row.frame_binding.scheduled.observation_id = shaB; },
      (row: any) => { row.frame_binding.supplied.input_digest = shaA; },
      (row: any) => { row.frame_binding.supplied.material = { kind: "future" }; },
      (row: any) => { row.producing_boundary = "launcher"; }
    ]) {
      const row = structuredClone(validRow()); mutate(row); expect(validateRowEvidence(row)).toBe(false);
    }
  });

  test("row evidence binds one canonical complete-frame JSON reference and rejects declaration drift", () => {
    const baseFrameBytes = canonicalFrameEvidenceBytes(materialFrame());
    expect(baseFrameBytes.length).toBe(4079);
    expect(createHash("sha256").update(baseFrameBytes).digest("hex"))
      .toBe("fab8dfefd91991c8260c06aec44ea9708a864a1c3ae7ae3aa7f982ad3630d1b0");
    expect(validateRowEvidence(validRow())).toBe(true);
    const reordered: any = structuredClone(validRow());
    reordered.frame_binding.scheduled.frame_reference.frame = Object.fromEntries(
      Object.entries(reordered.frame_binding.scheduled.frame_reference.frame).reverse()
    );
    expect(validateRowEvidence(reordered)).toBe(true);
    for (const mutate of [
      (row: any) => { delete row.frame_binding.scheduled.frame_reference; },
      (row: any) => { row.frame_binding.scheduled.frame_reference.encoding = "json"; },
      (row: any) => { row.frame_binding.scheduled.input_length += 1; },
      (row: any) => { row.frame_binding.scheduled.input_digest = shaA; },
      (row: any) => { row.frame_digest = shaA; row.frame_binding.supplied.input_digest = shaA; },
      (row: any) => { row.frame_binding.scheduled.frame_reference.frame.row_id = "BAS-002"; },
      (row: any) => { row.frame_binding.scheduled.frame_reference.frame.observation_id = shaB; },
      (row: any) => { row.frame_binding.scheduled.frame_reference.frame.checkout_capability_identity = shaA; },
      (row: any) => { row.frame_binding.scheduled.frame_reference.frame.body_length += 1; },
      (row: any) => {
        row.frame_binding.scheduled.frame_reference.frame.body_length += 1;
        synchronizeRowDeclarations(row, true);
      },
      (row: any) => {
        row.frame_binding.scheduled.frame_reference.frame.body_digest = shaA;
        row.frame_binding.scheduled.frame_reference.frame.git_state_generation_digest = shaA;
        synchronizeRowDeclarations(row, true);
      },
      (row: any) => {
        row.frame_binding.scheduled.frame_reference.frame.checksum = shaA;
        synchronizeRowDeclarations(row, false);
      }
    ]) {
      const row = structuredClone(validRow()); mutate(row); expect(validateRowEvidence(row)).toBe(false);
    }
  });

  test("canonical complete-frame bytes replay through the public frame validator", () => {
    const bytes = canonicalFrameEvidenceBytes(materialFrame());
    expect(bytes.length).toBe(4079);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("fab8dfefd91991c8260c06aec44ea9708a864a1c3ae7ae3aa7f982ad3630d1b0");
    const replay = JSON.parse(bytes.toString("utf8"));
    expect(validateFrame(replay)).toBe(true);
    expect(canonicalFrameEvidenceBytes(replay)).toEqual(bytes);
  });

  test("nested object key reordering converges to the same sealed frame bytes and digest", () => {
    const original = materialFrame();
    const reordered = structuredClone(original);
    const reverse = (value: Record<string, any>) => Object.fromEntries(Object.entries(value).reverse());
    reordered.index.entries[0].stat = reverse(reordered.index.entries[0].stat);
    resealFrame(reordered);
    expect(validateFrame(reordered)).toBe(true);
    const originalBytes = canonicalFrameEvidenceBytes(original);
    const reorderedBytes = canonicalFrameEvidenceBytes(reordered);
    expect(reorderedBytes).toEqual(originalBytes);
    expect(createHash("sha256").update(reorderedBytes).digest("hex"))
      .toBe(createHash("sha256").update(originalBytes).digest("hex"));
  });

  test("all row resource records use the frozen catalog boundary and truthful within_limits value", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    for (const catalog of CATALOG_V1) {
      const row: any = structuredClone(generic.platform_bundle.rows.find((item: any) => item.row_id === catalog.id));
      expect(validateRowEvidence(row), catalog.id).toBe(true);
      for (const mutate of [
        (changed: any) => { changed.resource_record.within_limits = !changed.resource_record.within_limits; },
        (changed: any) => { changed.resource_record.declared_limit = changed.resource_record.declared_limit === "none" ? "frame_bytes" : "none"; },
        (changed: any) => { changed.resource_record.boundary_class = changed.resource_record.boundary_class === "below" ? "exact" : "below"; }
      ]) {
        const changed = structuredClone(row); mutate(changed);
        expect(validateRowEvidence(changed), `${catalog.id}:drift`).toBe(false);
      }
    }
  });

  test("schema public CLI accepts one strict generation-bound frame and rejects nested drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-frame-schema-"));
    try {
      const cases: Array<[boolean, (frame: any) => void]> = [
        [true, () => {}],
        [false, (frame) => { delete frame.index.shared_index; }],
        [false, (frame) => { frame.index.future = true; }],
        [false, (frame) => { frame.index.entry_count = "2"; }],
        [false, (frame) => { frame.head_tree = "01".repeat(20); }],
        [false, (frame) => { frame.effective_config.entries[0].origin = "/absolute/config"; }],
        [false, (frame) => { frame.nested_state[0].gitlink.stage = 5; }]
      ];
      for (let index = 0; index < cases.length; index += 1) {
        const [expectedValid, mutate] = cases[index]!;
        const frame = structuredClone(validFrame()); mutate(frame);
        const path = join(root, `${index}.json`); await writeFile(path, JSON.stringify(frame));
        let stdout = ""; let stderr = "";
        const exit = await runCheck(["--input", path, "--kind", "schema"], { stdout: (chunk) => stdout += chunk, stderr: (chunk) => stderr += chunk });
        expect(exit).toBe(expectedValid ? 0 : 2);
        expect(expectedValid ? stderr : stdout).toBe("");
        if (!expectedValid) expect(JSON.parse(stderr).code).toBe("CONTRACT_SCHEMA_INVALID");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source record binds path/mode sets, two independent equal results, and exact receipt", () => {
    expect(validateSourceInputRecord(validSourceRecord())).toBe(true);
    for (const mutate of [
      (record: any) => { record.admitted_paths[0].git_mode = "100600"; },
      (record: any) => { record.witness_encoder.result.source_input_digest = shaB; },
      (record: any) => { record.witness_encoder.identity = record.primary_encoder.identity; },
      (record: any) => { record.command_receipt = {}; },
      (record: any) => { record.command_receipt.argv[12] = "--verify-record"; },
      (record: any) => { record.command_receipt.argv[14] = "--no-write"; },
      (record: any) => { record.command_receipt.argv.splice(8, 2); },
      (record: any) => { record.command_receipt.version = "opaque"; },
      (record: any) => { record.command_receipt.exit_code = 1; }
    ]) {
      const record = structuredClone(validSourceRecord()); mutate(record); expect(validateSourceInputRecord(record)).toBe(false);
    }
  });

  test("complete platform bundles own 174 unique observation, generation, and frame identities", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    for (const bundle of [generic.platform_bundle, generic.linux_platform_bundle]) {
      expect(validatePlatformBundle(bundle), bundle.platform).toBe(true);
      expect(new Set(bundle.rows.map((row: any) => row.observation_id)).size, bundle.platform).toBe(174);
      expect(new Set(bundle.rows.map((row: any) => row.git_state_generation_digest)).size, bundle.platform).toBe(174);
      expect(new Set(bundle.rows.map((row: any) => row.frame_digest)).size, bundle.platform).toBe(174);
      for (const row of bundle.rows) {
        const reference = row.frame_binding.scheduled.frame_reference;
        expect(reference.encoding, `${bundle.platform}/${row.row_id}`).toBe(frameEvidenceEncoding);
        expect(reference.frame.row_id, `${bundle.platform}/${row.row_id}`).toBe(row.row_id);
        expect(reference.frame.observation_id, `${bundle.platform}/${row.row_id}`).toBe(row.observation_id);
        expect(reference.frame.checkout_capability_identity, `${bundle.platform}/${row.row_id}`).toBe(row.checkout_capability_identity);
        expect(row.frame_digest, `${bundle.platform}/${row.row_id}`).toBe(row.frame_binding.supplied.input_digest);
      }
    }
    const allRows = [...generic.platform_bundle.rows, ...generic.linux_platform_bundle.rows];
    expect(new Set(allRows.map((row: any) => row.observation_id)).size).toBe(348);
    expect(new Set(allRows.map((row: any) => row.git_state_generation_digest)).size).toBe(348);
    expect(new Set(allRows.map((row: any) => row.frame_digest)).size).toBe(348);

    const repeatedObservation = structuredClone(generic.platform_bundle);
    repeatedObservation.rows[1].observation_id = repeatedObservation.rows[0].observation_id;
    repeatedObservation.rows[1].frame_binding.scheduled.frame_reference.frame.observation_id = repeatedObservation.rows[0].observation_id;
    bindRowFrame(repeatedObservation.rows[1], resealFrame(repeatedObservation.rows[1].frame_binding.scheduled.frame_reference.frame));
    expect(validateRowEvidence(repeatedObservation.rows[1])).toBe(true);
    expect(validatePlatformBundle(repeatedObservation)).toBe(false);

    const repeatedGeneration = structuredClone(generic.platform_bundle);
    const sourceFrame = repeatedGeneration.rows[0].frame_binding.scheduled.frame_reference.frame;
    const targetFrame = repeatedGeneration.rows[1].frame_binding.scheduled.frame_reference.frame;
    for (const field of ["index", "head_tree", "effective_config", "exclude_state", "attribute_state", "nested_state"]) {
      targetFrame[field] = structuredClone(sourceFrame[field]);
    }
    bindRowFrame(repeatedGeneration.rows[1], resealFrame(targetFrame));
    expect(validateRowEvidence(repeatedGeneration.rows[1])).toBe(true);
    expect(repeatedGeneration.rows[1].git_state_generation_digest).toBe(repeatedGeneration.rows[0].git_state_generation_digest);
    expect(repeatedGeneration.rows[1].frame_digest).not.toBe(repeatedGeneration.rows[0].frame_digest);
    expect(validatePlatformBundle(repeatedGeneration)).toBe(false);

    const repeatedFrame = structuredClone(generic.platform_bundle);
    repeatedFrame.rows[1].frame_digest = repeatedFrame.rows[0].frame_digest;
    repeatedFrame.rows[1].frame_binding.supplied.input_digest = repeatedFrame.rows[0].frame_digest;
    expect(validatePlatformBundle(repeatedFrame)).toBe(false);

    for (const mutate of [
      (bundle: any) => { bundle.rows[0].platform = "linux"; },
      (bundle: any) => { bundle.rows[0].source_input_record_sha256 = shaA; },
      (bundle: any) => { bundle.rows[0].frame_binding.supplied.input_digest = "short"; },
      (bundle: any) => { bundle.rows[0].resource_record.within_limits = !bundle.rows[0].resource_record.within_limits; }
    ]) {
      const bundle = structuredClone(generic.platform_bundle); mutate(bundle);
      expect(validatePlatformBundle(bundle)).toBe(false);
    }
    const invalidPlatform = structuredClone(generic.platform_bundle);
    invalidPlatform.run_status = "invalid"; invalidPlatform.rows = []; invalidPlatform.first_cause = "EVIDENCE_MISSING"; invalidPlatform.all_failure_codes = ["EVIDENCE_MISSING"];
    expect(validatePlatformBundle(invalidPlatform)).toBe(true);
  });

  test("final bundle rejects equal platform bundle digests while preserving terminal state rules", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    expect(validateFinalBundle(generic.final_bundle)).toBe(true);
    const sameBundleDigest = structuredClone(generic.final_bundle);
    sameBundleDigest.linux_bundle_sha256 = sameBundleDigest.macos_bundle_sha256;
    expect(validateFinalBundle(sameBundleDigest)).toBe(false);
    const invalidFinal = structuredClone(generic.final_bundle);
    invalidFinal.run_status = "invalid"; delete invalidFinal.terminal_decision; invalidFinal.first_cause = "PLATFORM_MISSING"; invalidFinal.all_failure_codes = ["PLATFORM_MISSING"];
    expect(validateFinalBundle(invalidFinal)).toBe(true);
    for (const mutate of [
      (bundle: any) => { delete bundle.repository_gates["GATE-SOURCE-INPUT"]; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].argv[12] = "--record"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].argv[14] = "--create"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].tool_version = "opaque"; },
      (bundle: any) => { bundle.repository_gates["GATE-SOURCE-INPUT"].exit_code = 1; }
    ]) {
      const bundle = structuredClone(generic.final_bundle); mutate(bundle); expect(validateFinalBundle(bundle)).toBe(false);
    }
  });

  test("D8 decision projects strict rows, identities, receipts, and global slot uniqueness", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    const decision = d8Decision(generic);
    expect(validateDecision(decision)).toBe(true);
    expect(new Set(decision.rows.map((row: string) => decisionRowFields(row)[7])).size).toBe(348);
    expect(new Set(decision.rows.map((row: string) => decisionRowFields(row)[8])).size).toBe(348);
    expect(new Set(decision.rows.map((row: string) => decisionRowFields(row)[9])).size).toBe(348);
    for (const { label, targetIndex } of [
      { label: "cross-platform", targetIndex: 1 },
      { label: "cross-row", targetIndex: 2 }
    ]) {
      for (const { identityField, segment } of [
        { identityField: "observation_id", segment: 7 },
        { identityField: "generation_payload_digest", segment: 8 },
        { identityField: "frame_digest", segment: 9 }
      ]) {
        const reused = structuredClone(decision);
        mutateDecisionRow(reused, targetIndex, segment, decisionRowFields(reused.rows[0])[segment]!);
        expect(validateDecision(reused), `${label}/${identityField}`).toBe(false);
      }
    }
    const detMac = decision.rows.findIndex((row: string) => decisionRowFields(row)[0] === "m" && decisionRowFields(row)[1] === "DET-001");
    const detLinux = decision.rows.findIndex((row: string) => decisionRowFields(row)[0] === "l" && decisionRowFields(row)[1] === "DET-001");
    const detReuse = structuredClone(decision);
    mutateDecisionRow(detReuse, detLinux, 8, decisionRowFields(detReuse.rows[detMac])[8]!);
    expect(validateDecision(detReuse), "DET-001-cross-platform-generation").toBe(false);

    const duplicateSlot = structuredClone(decision); duplicateSlot.rows[1] = duplicateSlot.rows[0];
    expect(validateDecision(duplicateSlot)).toBe(false);

    for (const mutate of [
      (value: any) => { delete value.base_sha; },
      (value: any) => { value.extra = true; },
      (value: any) => { value.fixture_identity = "short"; },
      (value: any) => { value.lockfile_completeness_verdict = "incomplete"; },
      (value: any) => { value.rows[0] = decisionRowFields(value.rows[0]).slice(0, 16).join("\0"); },
      (value: any) => { value.rows[0] += "\0surplus"; },
      (value: any) => { mutateDecisionRow(value, 0, 0, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 1, "UNKNOWN-001"); },
      (value: any) => { mutateDecisionRow(value, 0, 2, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 3, "UNEXPECTED"); },
      (value: any) => { mutateDecisionRow(value, 0, 4, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 5, "UNEXPECTED"); },
      (value: any) => { mutateDecisionRow(value, 0, 6, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 7, "short"); },
      (value: any) => { mutateDecisionRow(value, 0, 8, "short"); },
      (value: any) => { mutateDecisionRow(value, 0, 9, "short"); },
      (value: any) => { mutateDecisionRow(value, 0, 10, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 11, "x"); },
      (value: any) => { mutateDecisionRow(value, 0, 12, "6"); },
      (value: any) => { mutateDecisionRow(value, 0, 13, "0"); },
      (value: any) => { mutateDecisionRow(value, 0, 14, "f"); },
      (value: any) => { mutateDecisionRow(value, 0, 15, "14"); },
      (value: any) => { mutateDecisionRow(value, 0, 15, "1"); },
      (value: any) => { mutateDecisionRow(value, 0, 16, "q"); },
      (value: any) => { mutateDecisionRow(value, 0, 16, "e"); },
      (value: any) => { delete value.gates[0].id; },
      (value: any) => { value.gates[0].extra = true; },
      (value: any) => { value.gates[1].id = value.gates[0].id; },
      (value: any) => { value.gates[0].source_input_record_sha256 = shaA; },
      (value: any) => { value.gates[0].exit_verdict = "fail"; },
      (value: any) => { value.gates[0].argv = []; }
    ]) {
      const changed = structuredClone(decision); mutate(changed); expect(validateDecision(changed)).toBe(false);
    }
  });

  test("D8 terminal decision is accepted iff every projected row verdict passes", async () => {
    const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
    const accepted = d8Decision(generic);
    expect(validateDecision(accepted)).toBe(true);

    const rejected = structuredClone(accepted);
    mutateDecisionRow(rejected, 0, 4, "d");
    mutateDecisionRow(rejected, 0, 5, "");
    mutateDecisionRow(rejected, 0, 6, "f");
    rejected.terminal_decision = "rejected";
    rejected.first_cause = "ROW_VERDICT_FAILED";
    rejected.all_failure_codes = ["ROW_VERDICT_FAILED"];
    expect(validateDecision(rejected)).toBe(true);

    const controlRejected = structuredClone(accepted);
    mutateDecisionRow(controlRejected, 0, 6, "f");
    mutateDecisionRow(controlRejected, 0, 12, "7d");
    controlRejected.terminal_decision = "rejected";
    controlRejected.first_cause = "ROW_CONTROL_FAILED";
    controlRejected.all_failure_codes = ["ROW_CONTROL_FAILED"];
    expect(validateDecision(controlRejected)).toBe(true);

    const falseRejected = structuredClone(accepted);
    falseRejected.terminal_decision = "rejected";
    falseRejected.first_cause = "ROW_VERDICT_FAILED";
    falseRejected.all_failure_codes = ["ROW_VERDICT_FAILED"];
    expect(validateDecision(falseRejected)).toBe(false);

    const falseAccepted = structuredClone(rejected);
    falseAccepted.terminal_decision = "accepted";
    delete falseAccepted.first_cause;
    delete falseAccepted.all_failure_codes;
    expect(validateDecision(falseAccepted)).toBe(false);
  });

  test("raw __proto__ remains an own key and fails every strict public schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-proto-"));
    try {
      const generic = JSON.parse(await readFile(join(contractRoot, "fixtures/valid/generic.json"), "utf8"));
      const values: Record<string, unknown> = {
        catalog: JSON.parse(await readFile(join(contractRoot, "contract-v1.json"), "utf8")),
        dependency_graph: JSON.parse(await readFile(join(contractRoot, "../dependency-graph-catalog.json"), "utf8")),
        schema: generic.schema, source_input_record: generic.source_input_record, row_evidence: generic.row_evidence,
        platform_bundle: generic.platform_bundle, final_bundle: generic.final_bundle, decision: generic.decision
      };
      for (const [kind, value] of Object.entries(values)) {
        const text = JSON.stringify(value).replace(/}$/, ',"__proto__":{"polluted":true}}');
        const inputPath = join(root, `${kind}.json`); await writeFile(inputPath, text);
        let stdout = ""; let stderr = "";
        const exit = await runCheck(["--input", inputPath, "--kind", kind as any], { stdout: (chunk) => stdout += chunk, stderr: (chunk) => stderr += chunk });
        expect(exit).toBe(2); expect(stdout).toBe(""); expect(JSON.parse(stderr).code).toBe("CONTRACT_SCHEMA_INVALID");
      }
      expect(({} as any).polluted).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source candidates include spike evidence names and conditionally include the workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-candidates-"));
    try {
      await cp(join(repositoryRoot, "spikes"), join(root, "spikes"), { recursive: true });
      await cp(join(repositoryRoot, "openspec"), join(root, "openspec"), { recursive: true });
      await writeFile(join(root, "spikes/git-status-capability/contracts/evidence/source.ts"), "source\n", { flag: "w" }).catch(async () => {
        const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, "spikes/git-status-capability/contracts/evidence"), { recursive: true });
        await writeFile(join(root, "spikes/git-status-capability/contracts/evidence/source.ts"), "source\n");
      });
      let paths = await enumerateSourceCandidates(root);
      expect(paths).toContain("spikes/git-status-capability/contracts/evidence/source.ts");
      expect(paths).not.toContain(".github/workflows/git-status-capability-spike.yml");
      const { mkdir } = await import("node:fs/promises"); await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, ".github/workflows/git-status-capability-spike.yml"), "name: spike\n");
      paths = await enumerateSourceCandidates(root);
      expect(paths).toContain(".github/workflows/git-status-capability-spike.yml");
      expect(paths.some((path) => path.startsWith("openspec/changes/m2-capability-observer-spike/evidence/"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("source digest descriptor is exact and supply graph carries activated features", async () => {
    const contract = JSON.parse(await readFile(join(contractRoot, "contract-v1.json"), "utf8"));
    for (const field of ["frame_fields", "synthetic_literal_path", "domain_prefix", "entry_order"]) {
      const changed = structuredClone(contract); changed.source_input_digest_v1[field] = field === "frame_fields" ? [] : "drift";
      expect(validateContract(changed)).toBe(false);
    }
    const graph = JSON.parse(await readFile(join(contractRoot, "..", "dependency-graph-catalog.json"), "utf8"));
    expect(validateDependencyCatalog(graph)).toBe(true);
    for (const target of Object.values(graph.target_graphs) as any[]) {
      expect(target.activated_features.length).toBe(target.packages.length);
      expect(target.activated_features.every((item: any) => typeof item.package === "string" && Array.isArray(item.features))).toBe(true);
    }
    const changed = structuredClone(graph); changed.target_graphs["aarch64-apple-darwin"].activated_features[0].features.push("drift");
    const changedTarget = changed.target_graphs["aarch64-apple-darwin"];
    changedTarget.graph_digest = createHash("sha256").update(JSON.stringify({ packages: changedTarget.packages, edges: changedTarget.edges, activated_features: changedTarget.activated_features })).digest("hex");
    expect(validateDependencyCatalog(changed)).toBe(false);
  });

  test("Cargo manifest is exact and rejects extra tables or dependency drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "shud-supply-"));
    try {
      await cp(join(contractRoot, ".."), root, { recursive: true });
      await expect(validateSupplyFiles(root)).resolves.toBeUndefined();
      for (const suffix of ["\n[features]\ndefault = []\n", "\n[dependencies.serde]\nversion = \"=1.0.0\"\n"]) {
        const cargo = join(root, "native/Cargo.toml"); const original = await readFile(cargo, "utf8"); await writeFile(cargo, original + suffix);
        await expect(validateSupplyFiles(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" }); await writeFile(cargo, original);
      }
      const lockPath = join(root, "native/Cargo.lock");
      await writeFile(lockPath, `${await readFile(lockPath, "utf8")}\n# drift\n`);
      await expect(validateSupplyFiles(root)).rejects.toMatchObject({ code: "CONTRACT_SCHEMA_INVALID" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
