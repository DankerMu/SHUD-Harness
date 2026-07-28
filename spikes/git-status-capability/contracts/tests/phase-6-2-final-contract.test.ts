import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFrameBytes, canonicalFrameDigest } from "../lib/canonical-frame";
import { runCheck } from "../lib/checker";
import { encodeDecisionRowProjection, validateDecisionProjection } from "../lib/decision";
import { expectedOutcome, OBSERVER_LIMITS } from "../lib/frozen";
import { validatePlatformBundle, validateRowEvidence } from "../lib/schema";
import { frameForEvidenceSlot, resealFrame } from "./frame-fixture";

const shaA = "01".repeat(32);
const shaB = "ab".repeat(32);
const generic = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/valid/generic.json"), "utf8"));

const controlIds = [
  "oracle", "ambient_path", "subprocess", "network", "protected_write", "protection", "cleanup"
] as const;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rejectedDecision(code: string): any {
  const decision = structuredClone(generic.decision);
  const fields = decision.rows[0].split("\0");
  fields[4] = "r";
  fields[5] = code;
  fields[6] = "f";
  const receipt = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1", producer: "observer",
    row_id: fields[1], observation_id: fields[7], supplied_input_digest: fields[9],
    observed_outcome: { kind: "rejected", code }
  };
  const cause = { kind: "outcome-mismatch-v1", receipt: { ...receipt, receipt_digest: canonicalDigest(receipt) } };
  fields[18] = Buffer.from(JSON.stringify(canonicalValue(cause)), "utf8").toString("base64url");
  decision.rows[0] = fields.join("\0");
  decision.terminal_decision = "rejected";
  decision.first_cause = "ROW_VERDICT_FAILED";
  decision.all_failure_codes = ["ROW_VERDICT_FAILED"];
  return decision;
}

const WIRE_MAGIC = Buffer.from("SHUDCAP1", "ascii");
const WIRE_HEADER_BYTES = 128;
const WIRE_CHECKSUM_OFFSET = 96;

function referenceWireBytes(frame: Record<string, any>, byteLength?: number): Buffer {
  const body = canonicalFrameBytes(frame);
  const totalLength = byteLength ?? WIRE_HEADER_BYTES + body.length;
  const extensionLength = totalLength - WIRE_HEADER_BYTES - body.length;
  if (extensionLength < 0) throw new Error("wire target is shorter than its header and body");
  const extension = Buffer.alloc(extensionLength);
  const header = Buffer.alloc(WIRE_HEADER_BYTES);
  WIRE_MAGIC.copy(header, 0);
  header[8] = 1;
  header[9] = 0;
  header.writeUInt16BE(WIRE_HEADER_BYTES, 10);
  header.writeBigUInt64BE(BigInt(totalLength), 12);
  header.writeUInt32BE(body.length, 20);
  header.writeBigUInt64BE(BigInt(extensionLength), 24);
  Buffer.from(digest(body), "hex").copy(header, 32);
  Buffer.from(digest(extension), "hex").copy(header, 64);
  const checksum = createHash("sha256").update(header.subarray(0, WIRE_CHECKSUM_OFFSET)).update(body).update(extension).digest();
  checksum.copy(header, WIRE_CHECKSUM_OFFSET);
  return Buffer.concat([header, body, extension]);
}

function referenceDecode(bytes: Buffer): "clean" | "LIMIT_FRAME_BYTES" | "FRAME_CHECKSUM" | "FRAME_TRUNCATED" | "FRAME_SURPLUS" | "FRAME_MALFORMED" {
  if (bytes.length > OBSERVER_LIMITS.frame_bytes) return "LIMIT_FRAME_BYTES";
  if (bytes.length < WIRE_HEADER_BYTES) return "FRAME_TRUNCATED";
  if (!bytes.subarray(0, 8).equals(WIRE_MAGIC) || bytes[8] !== 1 || bytes[9] !== 0 || bytes.readUInt16BE(10) !== WIRE_HEADER_BYTES) {
    return "FRAME_MALFORMED";
  }
  const totalLength = Number(bytes.readBigUInt64BE(12));
  const bodyLength = bytes.readUInt32BE(20);
  const extensionLength = Number(bytes.readBigUInt64BE(24));
  if (!Number.isSafeInteger(totalLength) || !Number.isSafeInteger(extensionLength) ||
    totalLength !== WIRE_HEADER_BYTES + bodyLength + extensionLength) return "FRAME_MALFORMED";
  if (bytes.length < totalLength) return "FRAME_TRUNCATED";
  if (bytes.length > totalLength) return "FRAME_SURPLUS";
  const body = bytes.subarray(WIRE_HEADER_BYTES, WIRE_HEADER_BYTES + bodyLength);
  const extension = bytes.subarray(WIRE_HEADER_BYTES + bodyLength);
  if (digest(body) !== bytes.subarray(32, 64).toString("hex") || digest(extension) !== bytes.subarray(64, 96).toString("hex")) {
    return "FRAME_CHECKSUM";
  }
  const checksum = createHash("sha256")
    .update(bytes.subarray(0, WIRE_CHECKSUM_OFFSET))
    .update(body)
    .update(extension)
    .digest("hex");
  return checksum === bytes.subarray(WIRE_CHECKSUM_OFFSET, WIRE_HEADER_BYTES).toString("hex") ? "clean" : "FRAME_CHECKSUM";
}

function scheduledBytes(row: any): Buffer {
  const scheduled = row.frame_binding.scheduled;
  const frame = scheduled.frame_reference.frame;
  if (scheduled.material.kind === "canonical-frame-wire-v1") return referenceWireBytes(frame, scheduled.input_length);
  const body = canonicalFrameBytes(frame);
  return Buffer.concat([body, Buffer.alloc(scheduled.input_length - body.length)]);
}

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    .map((key) => [key, canonicalValue(value[key])]));
}

function canonicalDigest(value: any): string {
  return digest(Buffer.from(JSON.stringify(canonicalValue(value)), "utf8"));
}

function formalDetProjection(input: any, output: any, token: string): string {
  return [
    input.platform === "macos" ? "m" : "l", input.row_id, "c", "", "c", "", "p",
    input.observation_id, input.git_state_generation_digest, input.supplied_input_digest, "o",
    "7f", "7f", "1", output.cleanup.verdict === "pass" ? "p" : "f", "0", "b", token, ""
  ].join("\0");
}

function receiptAxisBinding(rowId: string, side: "first" | "second"): any {
  if (rowId === "DET-002") return {
    kind: "fixture-creation-order", side,
    sequence: side === "first" ? ["checkout", "nested"] : ["nested", "checkout"]
  };
  if (rowId === "DET-003") return {
    kind: "fixture-root", side, root_token: digest(Buffer.from(`root:${side}`))
  };
  if (rowId === "DET-004") return {
    kind: "permitted-volatile-material", side,
    timestamp_digest: digest(Buffer.from(`time:${side}`)),
    map_order_digest: digest(Buffer.from(`map:${side}`)),
    below_bound_counter_digest: digest(Buffer.from(`counter:${side}`))
  };
}

function axisMaterialFromReceipts(rowId: string, first: any, second: any): any {
  if (rowId === "DET-001") return { kind: "same-input-repeat", input_digest: canonicalDigest(first.input) };
  if (rowId === "DET-002") return {
    kind: "fixture-creation-order",
    first_order: structuredClone(first.input.axis_binding.sequence),
    second_order: structuredClone(second.input.axis_binding.sequence)
  };
  if (rowId === "DET-003") return {
    kind: "fixture-root",
    first_root_token: first.input.axis_binding.root_token,
    second_root_token: second.input.axis_binding.root_token
  };
  const volatile = (binding: any) => ({
    timestamp_digest: binding.timestamp_digest,
    map_order_digest: binding.map_order_digest,
    below_bound_counter_digest: binding.below_bound_counter_digest
  });
  return {
    kind: "permitted-volatile-material",
    first: volatile(first.input.axis_binding), second: volatile(second.input.axis_binding)
  };
}

function determinismProof(row: any): any {
  const axes: Record<string, string> = {
    "DET-001": "same-input-repeat",
    "DET-002": "fixture-creation-order",
    "DET-003": "fixture-root",
    "DET-004": "volatile-fields"
  };
  const input = {
    platform: row.platform,
    row_id: row.row_id,
    observation_id: row.observation_id,
    checkout_capability_identity: row.checkout_capability_identity,
    git_state_generation_digest: row.git_state_generation_digest,
    supplied_input_digest: row.frame_digest,
    expected_outcome: structuredClone(row.expected_outcome),
    oracle_digest: row.oracle_digest,
    source_input_record_sha256: row.source_input_record_sha256
  };
  const output = {
    observer_outcome: structuredClone(row.observer_outcome),
    producing_boundary: row.producing_boundary,
    actual_producing_boundary: row.actual_producing_boundary,
    row_verdict: row.row_verdict,
    control_assertions: structuredClone(row.control_assertions),
    protection_set_equal: row.protection_set_equal,
    cleanup: structuredClone(row.cleanup),
    resource_record: structuredClone(row.resource_record),
    actual_resource_record: structuredClone(row.actual_resource_record)
  };
  const token = row.row_id.at(-1);
  const normalizedDigest = canonicalDigest(output);
  const projectionDigest = digest(Buffer.from(formalDetProjection(input, output, token), "utf8"));
  const receipt = (side: "first" | "second") => ({
    receipt_id: digest(Buffer.from(`${row.row_id}:receipt:${side}`)),
    input: { ...structuredClone(input), ...(row.row_id === "DET-001" ? {} : { axis_binding: receiptAxisBinding(row.row_id, side) }) },
    output: structuredClone(output),
    normalized_row_output_digest: normalizedDigest,
    decision_projection_digest: projectionDigest
  });
  const first = receipt("first");
  const second = receipt("second");
  const axisMaterial = axisMaterialFromReceipts(row.row_id, first, second);
  return {
    variation_axis: axes[row.row_id],
    axis_material: axisMaterial,
    axis_digest: canonicalDigest(axisMaterial),
    first, second,
    comparison: { normalized_row_output_equal: true, decision_projection_equal: true }
  };
}

function controls(verdict: "pass" | "fail" = "pass") {
  return Object.fromEntries(controlIds.map((id) => [id, { active: true, verdict }]));
}

const resourceLimits = [
  ["frame_bytes", "bytes", OBSERVER_LIMITS.frame_bytes], ["index_bytes", "bytes", OBSERVER_LIMITS.index_bytes],
  ["index_entries", "count", OBSERVER_LIMITS.index_entries], ["path_bytes", "bytes", OBSERVER_LIMITS.path_bytes],
  ["path_depth", "segments", OBSERVER_LIMITS.path_depth], ["nested_repositories", "count", OBSERVER_LIMITS.nested_repositories],
  ["traversal_entries", "count", OBSERVER_LIMITS.traversal_entries], ["hashed_bytes", "bytes", OBSERVER_LIMITS.hashed_bytes],
  ["wall_time_ms", "milliseconds", OBSERVER_LIMITS.wall_time_ms], ["cpu_time_ms", "milliseconds", OBSERVER_LIMITS.cpu_time_ms],
  ["threads", "count", OBSERVER_LIMITS.threads], ["memory_bytes", "bytes", OBSERVER_LIMITS.memory_bytes],
  ["output_bytes", "bytes", OBSERVER_LIMITS.output_bytes]
] as const;

function measuredResource(row: any, limit: string, unit: string, value: number): any {
  const recipe = { kind: "literal-counter-v1", limit, unit, value };
  const recipeDigest = canonicalDigest(recipe);
  const locatorCore = {
    kind: resourceLimits.findIndex(([candidate]) => candidate === limit) < 8 ? "supplied-frame-locator-v1" : "launcher-receipt-v1",
    row_id: row.row_id, observation_id: row.observation_id, supplied_input_digest: row.frame_digest,
    recipe_digest: recipeDigest,
    source: resourceLimits.findIndex(([candidate]) => candidate === limit) < 8 ? "canonical-supplied-frame" : "launcher-counter"
  };
  const locator = { ...locatorCore, receipt_digest: canonicalDigest(locatorCore) };
  return {
    boundary_class: value > (OBSERVER_LIMITS as any)[limit] ? "exceeded" : value === (OBSERVER_LIMITS as any)[limit] ? "exact" : "below",
    declared_limit: limit, within_limits: value <= (OBSERVER_LIMITS as any)[limit],
    stimulus: { schema_version: "shud.git-status-capability.limit-stimulus.v1", recipe, recipe_digest: recipeDigest, locator },
    measurement: { schema_version: "shud.git-status-capability.limit-measurement.v1", limit, unit, value, stimulus_receipt_digest: locator.receipt_digest }
  };
}

function bindControlFailure(row: any, controlId: string): void {
  row.actual_producing_boundary = controlId === "oracle" ? "observer" :
    ["protected_write", "protection"].includes(controlId) ? "tripwire" : "launcher";
  const receipt = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1", producer: row.actual_producing_boundary,
    row_id: row.row_id, observation_id: row.observation_id, supplied_input_digest: row.frame_digest,
    control_id: controlId, control_verdict: "fail"
  };
  row.failure_cause = { kind: "control-failure-v1", receipt: { ...receipt, receipt_digest: canonicalDigest(receipt) } };
}

function expectedBoundary(rowId: string): "observer" | "launcher" | "tripwire" {
  if (/^PRT-01[0-2]$/.test(rowId)) return "tripwire";
  if (["CAP-005", "CAP-006", "CAP-008", "CAP-009", "CAP-016", "CAP-017",
    "LIF-003", "LIF-004", "LIF-005", "LIF-007"].includes(rowId) || /^PRT-00[1-9]$/.test(rowId)) return "launcher";
  return "observer";
}

function rowFor(rowId: string): any {
  const row = structuredClone(generic.row_evidence);
  row.row_id = rowId;
  row.expected_outcome = expectedOutcome(rowId);
  row.observer_outcome = structuredClone(row.expected_outcome);
  row.producing_boundary = expectedBoundary(rowId);
  row.actual_producing_boundary = row.producing_boundary;
  row.row_verdict = "pass";
  row.control_assertions = controls();
  delete row.oracle_verdict;
  delete row.tripwire_verdicts;
  const match = /^LIM-(\d{3})$/.exec(rowId);
  if (match) {
    const limits = [
      "frame_bytes", "index_bytes", "index_entries", "path_bytes", "path_depth", "nested_repositories",
      "traversal_entries", "hashed_bytes", "wall_time_ms", "cpu_time_ms", "threads", "memory_bytes", "output_bytes"
    ];
    const ordinal = Number(match[1]);
    row.resource_record = {
      boundary_class: ordinal % 2 === 1 ? "exact" : "exceeded",
      declared_limit: limits[Math.floor((ordinal - 1) / 2)],
      within_limits: ordinal % 2 === 1
    };
    const [limit, unit, ceiling] = resourceLimits[Math.floor((ordinal - 1) / 2)]!;
    row.actual_resource_record = { limit, unit, ceiling, ordinal };
  } else {
    row.resource_record = { boundary_class: "below", declared_limit: "none", within_limits: true };
    row.actual_resource_record = structuredClone(row.resource_record);
  }
  const frame = frameForEvidenceSlot("macos", rowId, row.observation_id, row.checkout_capability_identity);
  bindScheduled(row, frame, /^LIM-00[12]$/.test(rowId) ? OBSERVER_LIMITS.frame_bytes : undefined);
  if (match) {
    const { limit, unit, ceiling, ordinal } = row.actual_resource_record;
    row.actual_resource_record = measuredResource(row, limit, unit, ceiling + (ordinal % 2 === 0 ? 1 : 0));
  }
  if (rowId === "LIF-002" || rowId === "LIF-006") {
    const bytes = scheduledBytes(row);
    bytes[8] = 2;
    suppliedBytes(row, bytes, { kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 });
  }
  if (rowId === "LIF-002") {
    row.first_cause = "FRAME_VERSION_UNSUPPORTED";
    row.secondary_errors = [];
  }
  if (rowId === "LIF-006" || rowId === "LIF-007") {
    row.first_cause = rowId === "LIF-006" ? "FRAME_VERSION_UNSUPPORTED" : "CLEANUP_FAILED";
    row.secondary_errors = rowId === "LIF-006" ? ["CLEANUP_FAILED"] : [];
    row.cleanup = { verdict: "fail", descriptors_restored: false, processes_reaped: true };
  } else {
    delete row.cleanup.secondary_errors;
  }
  if (/^DET-00[1-4]$/.test(rowId)) row.determinism_proof = determinismProof(row);
  return row;
}

function bindScheduled(row: any, frame: Record<string, any>, inputLength?: number): void {
  const bytes = referenceWireBytes(frame, inputLength);
  const extensionLength = bytes.length - WIRE_HEADER_BYTES - canonicalFrameBytes(frame).length;
  const inputDigest = digest(bytes);
  row.git_state_generation_digest = frame.git_state_generation_digest;
  row.frame_digest = inputDigest;
  row.frame_binding = {
    scheduled: {
      row_id: frame.row_id,
      observation_id: frame.observation_id,
      checkout_capability_identity: frame.checkout_capability_identity,
      git_state_generation_digest: frame.git_state_generation_digest,
      input_length: bytes.length,
      input_digest: inputDigest,
      material: {
        kind: "canonical-frame-wire-v1",
        version: 1,
        header_length: WIRE_HEADER_BYTES,
        body_length: canonicalFrameBytes(frame).length,
        extension_length: extensionLength
      },
      frame_reference: {
        encoding: "shud.git-status-capability.canonical-frame-json.v1",
        frame
      }
    },
    supplied: {
      row_id: frame.row_id,
      observation_id: frame.observation_id,
      checkout_capability_identity: frame.checkout_capability_identity,
      git_state_generation_digest: frame.git_state_generation_digest,
      input_length: bytes.length,
      input_digest: inputDigest,
      material: { kind: "scheduled-input-v1" }
    }
  };
}

function suppliedWireMaterial(frame: Record<string, any>, inputLength: number, extra: Record<string, unknown> = {}) {
  const bodyLength = canonicalFrameBytes(frame).length;
  return {
    kind: "canonical-frame-wire-v1",
    version: 1,
    header_length: WIRE_HEADER_BYTES,
    body_length: bodyLength,
    extension_length: inputLength - WIRE_HEADER_BYTES - bodyLength,
    frame_reference: { encoding: "shud.git-status-capability.canonical-frame-json.v1", frame },
    ...extra
  };
}

function legacySameSlotRow(rowId: string): any {
  const row = structuredClone(generic.row_evidence);
  const frame = frameForEvidenceSlot("macos", rowId, row.observation_id, row.checkout_capability_identity);
  const frameBytes = canonicalFrameBytes(frame);
  const frameDigest = canonicalFrameDigest(frame);
  row.row_id = rowId;
  row.expected_outcome = expectedOutcome(rowId);
  row.observer_outcome = structuredClone(row.expected_outcome);
  row.row_verdict = "pass";
  delete row.control_assertions;
  row.oracle_verdict = "pass";
  row.tripwire_verdicts = { ambient_path: true, subprocess: true, protected_write: true };
  row.git_state_generation_digest = frame.git_state_generation_digest;
  row.frame_digest = frameDigest;
  row.frame_binding = {
    row_id: rowId,
    observation_id: row.observation_id,
    checkout_capability_identity: row.checkout_capability_identity,
    git_state_generation_digest: frame.git_state_generation_digest,
    frame_length: frameBytes.length,
    frame_digest: frameDigest,
    payload_length: frame.body_length,
    payload_digest: frame.body_digest,
    canonical_body_length: frame.body_length,
    canonical_body_digest: frame.body_digest,
    frame_reference: { encoding: "shud.git-status-capability.canonical-frame-json.v1", frame }
  };
  return row;
}

function suppliedBytes(row: any, bytes: Buffer, material: Record<string, unknown>, claims?: Record<string, string>): void {
  Object.assign(row.frame_binding.supplied, {
    ...claims,
    input_length: bytes.length,
    input_digest: digest(bytes),
    material
  });
  row.frame_digest = row.frame_binding.supplied.input_digest;
}

function replayFrame(row: any, mutate: (frame: any) => void): void {
  const frame = structuredClone(row.frame_binding.scheduled.frame_reference.frame);
  mutate(frame);
  resealFrame(frame);
  const bytes = referenceWireBytes(frame);
  suppliedBytes(row, bytes, suppliedWireMaterial(frame, bytes.length), {
    row_id: frame.row_id,
    observation_id: frame.observation_id,
    checkout_capability_identity: frame.checkout_capability_identity,
    git_state_generation_digest: frame.git_state_generation_digest
  });
}

function malformedPathRow(rowId: "CAP-013" | "CAP-014", origin: string): any {
  const row = rowFor(rowId);
  const frame = structuredClone(row.frame_binding.scheduled.frame_reference.frame);
  frame.effective_config.entries[0].origin = origin;
  resealFrame(frame);
  const bytes = referenceWireBytes(frame);
  suppliedBytes(row, bytes, suppliedWireMaterial(frame, bytes.length, {
    violation: rowId === "CAP-013" ? "absolute-path" : "path-escape"
  }), {
    row_id: frame.row_id,
    observation_id: frame.observation_id,
    checkout_capability_identity: frame.checkout_capability_identity,
    git_state_generation_digest: frame.git_state_generation_digest
  });
  return row;
}

describe("Phase 6.2 row control-state closure", () => {
  test("outcome match plus an active tripwire failure is a valid technical row failure", () => {
    const row = rowFor("BAS-001");
    row.control_assertions.ambient_path.verdict = "fail";
    row.row_verdict = "fail";
    bindControlFailure(row, "ambient_path");
    expect(validateRowEvidence(row)).toBe(true);
    expect(() => encodeDecisionRowProjection(row)).not.toThrow();
  });

  test("outcome match plus protection failure is a valid technical row failure", () => {
    const row = rowFor("BAS-001");
    row.control_assertions.protection.verdict = "fail";
    row.protection_set_equal = false;
    row.row_verdict = "fail";
    bindControlFailure(row, "protection");
    expect(validateRowEvidence(row)).toBe(true);
  });

  test("oracle, network, and cleanup assertion failures remain representable technical row failures", () => {
    for (const controlId of ["oracle", "network", "cleanup"] as const) {
      const row = rowFor("BAS-001");
      row.control_assertions[controlId].verdict = "fail";
      if (controlId === "cleanup") {
        row.cleanup.verdict = "fail";
        row.cleanup.descriptors_restored = false;
      }
      row.row_verdict = "fail";
      bindControlFailure(row, controlId);
      expect(validateRowEvidence(row), controlId).toBe(true);
      expect(() => encodeDecisionRowProjection(row), controlId).not.toThrow();
    }
  });

  test("launcher-produced expected rejection remains a passing negative row", () => {
    const row = rowFor("CAP-005");
    expect(validateRowEvidence(row)).toBe(true);
    expect(encodeDecisionRowProjection(row).split("\0")[10]).toBe("l");
  });

  test("missing or inactive required control evidence is structurally invalid", () => {
    expect(validateRowEvidence(legacySameSlotRow("BAS-001")), "legacy row has no complete active-control assertion state").toBe(false);
    const missing = rowFor("BAS-001");
    delete missing.control_assertions.network;
    expect(validateRowEvidence(missing)).toBe(false);
    const inactive = rowFor("BAS-001");
    inactive.control_assertions.cleanup.active = false;
    expect(validateRowEvidence(inactive)).toBe(false);
  });
});

describe("Phase 6.2 scheduled versus supplied frame proof", () => {
  test("a valid same-slot scheduled frame alone cannot claim CAP-010 through CAP-017", () => {
    expect(validateRowEvidence(legacySameSlotRow("CAP-010")), "legacy same-slot proof").toBe(false);
    for (let ordinal = 10; ordinal <= 17; ordinal += 1) {
      const rowId = `CAP-${String(ordinal).padStart(3, "0")}`;
      expect(validateRowEvidence(rowFor(rowId)), rowId).toBe(false);
    }
  });

  test("tamper, truncate, surplus, absolute, and escape supplied material validate only in matching rows", () => {
    const tamper = rowFor("CAP-010");
    const tampered = Buffer.from(scheduledBytes(tamper));
    const payloadOffset = WIRE_HEADER_BYTES;
    tampered[payloadOffset] ^= 1;
    suppliedBytes(tamper, tampered, { kind: "xor-byte-v1", offset: payloadOffset, xor: 1 });

    const truncate = rowFor("CAP-011");
    const scheduledTruncate = scheduledBytes(truncate);
    suppliedBytes(truncate, scheduledTruncate.subarray(0, -1), { kind: "truncate-tail-v1", byte_count: 1 });

    const surplus = rowFor("CAP-012");
    const scheduledSurplus = scheduledBytes(surplus);
    suppliedBytes(surplus, Buffer.concat([scheduledSurplus, scheduledSurplus]), { kind: "append-scheduled-input-v1", copies: 1 });

    const rows = [tamper, truncate, surplus, malformedPathRow("CAP-013", "/absolute/config"), malformedPathRow("CAP-014", "../escape")];
    for (const row of rows) expect(validateRowEvidence(row), row.row_id).toBe(true);
    const wrong = structuredClone(tamper);
    wrong.row_id = "CAP-011";
    wrong.expected_outcome = expectedOutcome("CAP-011");
    expect(validateRowEvidence(wrong)).toBe(false);
  });

  test("foreign, stale, and cross-row canonical supplied frames require the exact slot difference", () => {
    const foreign = rowFor("CAP-015");
    replayFrame(foreign, (frame) => { frame.checkout_capability_identity = shaA; });
    const stale = rowFor("CAP-016");
    replayFrame(stale, (frame) => { frame.head_tree.object_id = "cd".repeat(20); });
    const crossRow = rowFor("CAP-017");
    replayFrame(crossRow, (frame) => { frame.row_id = "CAP-001"; frame.observation_id = shaA; });
    for (const row of [foreign, stale, crossRow]) expect(validateRowEvidence(row), row.row_id).toBe(true);
    const wrong = structuredClone(foreign);
    wrong.frame_binding.supplied.checkout_capability_identity = shaB;
    expect(validateRowEvidence(wrong)).toBe(false);
  });

  test("LIM-001 exact and LIM-002 exact-plus-one remain content-addressed below the row ceiling", () => {
    const exact = rowFor("LIM-001");
    expect(validateRowEvidence(exact)).toBe(true);
    expect(exact.frame_binding.supplied.input_length).toBe(OBSERVER_LIMITS.frame_bytes);
    const exactWire = scheduledBytes(exact);
    expect(referenceDecode(exactWire)).toBe("clean");
    const changedExtension = Buffer.from(exactWire);
    changedExtension[changedExtension.length - 1] ^= 1;
    expect(referenceDecode(changedExtension)).toBe("FRAME_CHECKSUM");

    const over = rowFor("LIM-002");
    const scheduledLength = over.frame_binding.scheduled.input_length;
    const appendedBytes = Buffer.concat([scheduledBytes(over), Buffer.from([0])]);
    const appendedDigest = digest(appendedBytes);
    Object.assign(over.frame_binding.supplied, {
      input_length: OBSERVER_LIMITS.frame_bytes + 1,
      input_digest: appendedDigest,
      material: { kind: "append-byte-v1", byte: 0, count: 1 }
    });
    over.frame_digest = appendedDigest;
    over.actual_resource_record = measuredResource(
      over, "frame_bytes", "bytes", OBSERVER_LIMITS.frame_bytes + 1
    );
    expect(validateRowEvidence(over)).toBe(true);
    expect(referenceDecode(appendedBytes)).toBe("LIMIT_FRAME_BYTES");
    const malformedOver = Buffer.from(appendedBytes);
    malformedOver[0] ^= 1;
    expect(referenceDecode(malformedOver)).toBe("LIMIT_FRAME_BYTES");
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(over))).toBeLessThan(512 * 1024);
  });

  test("the independent decoder distinguishes checksum, truncation, and surplus on one explicit wire", () => {
    const row = rowFor("CAP-010");
    const wire = scheduledBytes(row);
    const legacyJson = canonicalFrameBytes(row.frame_binding.scheduled.frame_reference.frame);
    const legacyPostJsonPadding = Buffer.concat([legacyJson, Buffer.alloc(OBSERVER_LIMITS.frame_bytes - legacyJson.length)]);
    const tampered = Buffer.from(wire);
    tampered[WIRE_HEADER_BYTES] ^= 1;
    expect(referenceDecode(legacyPostJsonPadding)).toBe("FRAME_MALFORMED");
    expect(referenceDecode(wire)).toBe("clean");
    expect(referenceDecode(tampered)).toBe("FRAME_CHECKSUM");
    expect(referenceDecode(wire.subarray(0, -1))).toBe("FRAME_TRUNCATED");
    const twoFrames = Buffer.concat([wire, wire]);
    expect(twoFrames.length).toBeLessThan(OBSERVER_LIMITS.frame_bytes);
    expect(referenceDecode(twoFrames)).toBe("FRAME_SURPLUS");
  });

  test("CAP-010 requires a payload mutation while checksum-only and wrong-row retags fail", () => {
    const payload = rowFor("CAP-010");
    const payloadBytes = Buffer.from(scheduledBytes(payload));
    payloadBytes[WIRE_HEADER_BYTES] ^= 1;
    suppliedBytes(payload, payloadBytes, { kind: "xor-byte-v1", offset: WIRE_HEADER_BYTES, xor: 1 });
    expect(validateRowEvidence(payload)).toBe(true);

    const checksumOnly = rowFor("CAP-010");
    const checksumBytes = Buffer.from(scheduledBytes(checksumOnly));
    checksumBytes[WIRE_CHECKSUM_OFFSET] ^= 1;
    suppliedBytes(checksumOnly, checksumBytes, { kind: "xor-byte-v1", offset: WIRE_CHECKSUM_OFFSET, xor: 1 });
    expect(validateRowEvidence(checksumOnly)).toBe(false);

    const retagged = structuredClone(payload);
    retagged.row_id = "CAP-011";
    retagged.expected_outcome = expectedOutcome("CAP-011");
    expect(validateRowEvidence(retagged)).toBe(false);
  });
});

describe("Phase 6.2 paired determinism proof", () => {
  for (const rowId of ["DET-002", "DET-003", "DET-004"]) {
    test(`${rowId} binds its declared variation directly to both receipt inputs`, () => {
      const row = rowFor(rowId);
      expect(validateRowEvidence(row)).toBe(true);
      expect(row.determinism_proof.first.input.axis_binding.side).toBe("first");
      expect(row.determinism_proof.second.input.axis_binding.side).toBe("second");
    });
  }

  test("recomputed outer axis claims cannot replace unchanged receipt inputs", () => {
    const replacements: Record<string, any> = {
      "DET-002": { kind: "fixture-creation-order", first_order: ["alpha", "beta"], second_order: ["beta", "alpha"] },
      "DET-003": { kind: "fixture-root", first_root_token: shaA, second_root_token: shaB },
      "DET-004": {
        kind: "permitted-volatile-material",
        first: { timestamp_digest: shaA, map_order_digest: shaA, below_bound_counter_digest: shaA },
        second: { timestamp_digest: shaB, map_order_digest: shaB, below_bound_counter_digest: shaB }
      }
    };
    const results = ["DET-002", "DET-003", "DET-004"].map((rowId) => {
      const row = structuredClone(generic.platform_bundle.rows.find((candidate: any) => candidate.row_id === rowId));
      row.determinism_proof.axis_material = replacements[rowId];
      row.determinism_proof.axis_digest = canonicalDigest(row.determinism_proof.axis_material);
      return validateRowEvidence(row);
    });
    expect(results).toEqual([false, false, false]);
  });

  test("same, wrong-kind, wrong-side, and swapped receipt axes fail even when outer claims are recomputed", () => {
    const fixtureRow = (rowId: string) => structuredClone(
      generic.platform_bundle.rows.find((candidate: any) => candidate.row_id === rowId)
    );
    const same = fixtureRow("DET-003");
    same.determinism_proof.second.input.axis_binding = {
      ...structuredClone(same.determinism_proof.first.input.axis_binding), side: "second"
    };
    same.determinism_proof.axis_material = axisMaterialFromReceipts("DET-003", same.determinism_proof.first, same.determinism_proof.second);
    same.determinism_proof.axis_digest = canonicalDigest(same.determinism_proof.axis_material);

    const wrongKind = fixtureRow("DET-002");
    wrongKind.determinism_proof.first.input.axis_binding.kind = "fixture-root";

    const wrongSide = fixtureRow("DET-004");
    wrongSide.determinism_proof.first.input.axis_binding.side = "second";
    wrongSide.determinism_proof.axis_material = axisMaterialFromReceipts("DET-004", wrongSide.determinism_proof.first, wrongSide.determinism_proof.second);
    wrongSide.determinism_proof.axis_digest = canonicalDigest(wrongSide.determinism_proof.axis_material);

    const swapped = fixtureRow("DET-002");
    [swapped.determinism_proof.first.input.axis_binding, swapped.determinism_proof.second.input.axis_binding] =
      [swapped.determinism_proof.second.input.axis_binding, swapped.determinism_proof.first.input.axis_binding];
    swapped.determinism_proof.axis_material = axisMaterialFromReceipts("DET-002", swapped.determinism_proof.first, swapped.determinism_proof.second);
    swapped.determinism_proof.axis_digest = canonicalDigest(swapped.determinism_proof.axis_material);

    expect([same, wrongKind, wrongSide, swapped].map(validateRowEvidence)).toEqual([false, false, false, false]);
  });

  test("DET-001 through DET-004 require a bound second invocation and exact variation axis", () => {
    for (const rowId of ["DET-001", "DET-002", "DET-003", "DET-004"]) {
      const row = rowFor(rowId);
      expect(validateRowEvidence(row), rowId).toBe(true);
      expect(encodeDecisionRowProjection(row).split("\0")[17], rowId).toBe(rowId.at(-1));

      const missingSecond = structuredClone(row);
      delete missingSecond.determinism_proof.second;
      expect(validateRowEvidence(missingSecond), `${rowId}:missing-second`).toBe(false);

      const changedFrame = structuredClone(row);
      changedFrame.determinism_proof.second.input.supplied_input_digest = shaA;
      expect(validateRowEvidence(changedFrame), `${rowId}:changed-frame`).toBe(false);

      const sharedStableDrift = structuredClone(row);
      sharedStableDrift.determinism_proof.first.input.source_input_record_sha256 = shaA;
      sharedStableDrift.determinism_proof.second.input.source_input_record_sha256 = shaA;
      expect(validateRowEvidence(sharedStableDrift), `${rowId}:shared-stable-drift`).toBe(false);

      const changedOutcome = structuredClone(row);
      changedOutcome.determinism_proof.second.output.observer_outcome = { kind: "dirty" };
      expect(validateRowEvidence(changedOutcome), `${rowId}:changed-outcome`).toBe(false);

      const changedOutput = structuredClone(row);
      changedOutput.determinism_proof.second.output.resource_record.within_limits = false;
      expect(validateRowEvidence(changedOutput), `${rowId}:changed-output`).toBe(false);

      const changedProjection = structuredClone(row);
      changedProjection.determinism_proof.second.decision_projection_digest = shaA;
      expect(validateRowEvidence(changedProjection), `${rowId}:changed-projection`).toBe(false);

      const wrongAxis = structuredClone(row);
      wrongAxis.determinism_proof.axis_material = rowId === "DET-003"
        ? { kind: "fixture-root", first_root_token: shaA, second_root_token: shaA }
        : { kind: "fixture-root", first_root_token: shaA, second_root_token: shaB };
      wrongAxis.determinism_proof.axis_digest = canonicalDigest(wrongAxis.determinism_proof.axis_material);
      expect(validateRowEvidence(wrongAxis), `${rowId}:wrong-axis`).toBe(false);
    }
  });

  test("equal forged digests and stale formal projections cannot replace structured derivation", () => {
    const forged = rowFor("DET-004");
    forged.determinism_proof.second.output.resource_record.within_limits = false;
    forged.determinism_proof.second.normalized_row_output_digest = forged.determinism_proof.first.normalized_row_output_digest;
    forged.determinism_proof.second.decision_projection_digest = forged.determinism_proof.first.decision_projection_digest;
    expect(validateRowEvidence(forged)).toBe(false);

    const staleProjection = rowFor("DET-002");
    staleProjection.determinism_proof.second.decision_projection_digest = digest(Buffer.from("legacy-projection"));
    expect(validateRowEvidence(staleProjection)).toBe(false);
  });

  test("same-row sub-observation repeat is legal but a duplicate catalog row and unprojected proof remain invalid", () => {
    const det = rowFor("DET-001");
    expect(det.determinism_proof.first.input.observation_id).toBe(det.determinism_proof.second.input.observation_id);
    expect(det.determinism_proof.first.receipt_id).not.toBe(det.determinism_proof.second.receipt_id);
    expect(validateRowEvidence(det)).toBe(true);

    const bundle = structuredClone(generic.platform_bundle);
    expect(validatePlatformBundle(bundle)).toBe(true);
    const collidingInvocation = structuredClone(bundle);
    const firstDet = collidingInvocation.rows.find((row: any) => row.row_id === "DET-001");
    const secondDet = collidingInvocation.rows.find((row: any) => row.row_id === "DET-002");
    secondDet.determinism_proof.first.receipt_id = firstDet.determinism_proof.first.receipt_id;
    expect(validatePlatformBundle(collidingInvocation)).toBe(false);
    bundle.rows.push(structuredClone(bundle.rows.find((row: any) => row.row_id === "DET-001")));
    expect(validatePlatformBundle(bundle)).toBe(false);

    const decision = structuredClone(generic.decision);
    expect(validateDecisionProjection(decision)).toBe(true);
    const index = decision.rows.findIndex((scalar: string) => scalar.split("\0")[1] === "DET-001");
    const fields = decision.rows[index].split("\0");
    fields[fields.length - 1] = "0";
    decision.rows[index] = fields.join("\0");
    expect(validateDecisionProjection(decision)).toBe(false);
  });
});

describe("Phase 6.2 lifecycle causal surface", () => {
  test("LIF-002, LIF-006, and LIF-007 accept only their exact cleanup causality", () => {
    for (const rowId of ["LIF-002", "LIF-006", "LIF-007"]) expect(validateRowEvidence(rowFor(rowId)), rowId).toBe(true);

    const promoted = rowFor("LIF-006");
    promoted.first_cause = "CLEANUP_FAILED";
    expect(validateRowEvidence(promoted)).toBe(false);

    const demoted = rowFor("LIF-006");
    demoted.secondary_errors = [];
    expect(validateRowEvidence(demoted)).toBe(false);

    const duplicate = rowFor("LIF-006");
    duplicate.secondary_errors = ["CLEANUP_FAILED", "CLEANUP_FAILED"];
    expect(validateRowEvidence(duplicate)).toBe(false);

    const cleanupCausalDuplicate = rowFor("LIF-006");
    cleanupCausalDuplicate.cleanup.secondary_errors = ["CLEANUP_FAILED"];
    expect(validateRowEvidence(cleanupCausalDuplicate)).toBe(false);

    const lif002CleanupCause = rowFor("LIF-002");
    lif002CleanupCause.secondary_errors = ["CLEANUP_FAILED"];
    expect(validateRowEvidence(lif002CleanupCause)).toBe(false);

    const lif007Secondary = rowFor("LIF-007");
    lif007Secondary.secondary_errors = ["CLEANUP_FAILED"];
    expect(validateRowEvidence(lif007Secondary)).toBe(false);
  });
});

describe("Phase 6.2 D8 rejection taxonomy", () => {
  test("direct decision validation rejects an observed code outside the frozen taxonomy", () => {
    expect(validateDecisionProjection(rejectedDecision("UNKNOWN_REJECTION_CODE"))).toBe(false);
  });

  test("public decision ingestion rejects an observed code outside the frozen taxonomy", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "shud-d8-rejection-"));
    try {
      const path = join(temporary, "decision.json");
      await writeFile(path, JSON.stringify(rejectedDecision("UNKNOWN_REJECTION_CODE")));
      let stdout = "";
      let stderr = "";
      const exit = await runCheck(["--input", path, "--kind", "decision"], {
        stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }
      });
      expect(exit).toBe(2);
      expect(stdout).toBe("");
      expect(JSON.parse(stderr)).toEqual({
        schema_version: "shud.git-status-capability.contract-error.v1",
        status: "error", code: "CONTRACT_SCHEMA_INVALID"
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("PLATFORM_UNSUPPORTED remains legal only as an observed rejection and expected codes stay catalog-bound", () => {
    expect(validateDecisionProjection(rejectedDecision("PLATFORM_UNSUPPORTED"))).toBe(true);
    const unknownExpected = structuredClone(generic.decision);
    const fields = unknownExpected.rows[0].split("\0");
    fields[2] = "r";
    fields[3] = "UNKNOWN_REJECTION_CODE";
    unknownExpected.rows[0] = fields.join("\0");
    expect(validateDecisionProjection(unknownExpected)).toBe(false);
  });
});
