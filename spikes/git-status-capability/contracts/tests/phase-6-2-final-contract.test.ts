import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalFrameBytes, canonicalFrameDigest } from "../lib/canonical-frame";
import { encodeDecisionRowProjection } from "../lib/decision";
import { expectedOutcome, OBSERVER_LIMITS } from "../lib/frozen";
import { validateRowEvidence } from "../lib/schema";
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

function envelopeDigest(frame: Record<string, any>, byteLength: number): string {
  const frameBytes = canonicalFrameBytes(frame);
  const hash = createHash("sha256").update(frameBytes);
  let remaining = byteLength - frameBytes.length;
  const zeros = Buffer.alloc(64 * 1024);
  while (remaining > 0) {
    const count = Math.min(remaining, zeros.length);
    hash.update(zeros.subarray(0, count));
    remaining -= count;
  }
  return hash.digest("hex");
}

function controls(verdict: "pass" | "fail" = "pass") {
  return Object.fromEntries(controlIds.map((id) => [id, { active: true, verdict }]));
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
  } else {
    row.resource_record = { boundary_class: "below", declared_limit: "none", within_limits: true };
  }
  const frame = frameForEvidenceSlot("macos", rowId, row.observation_id, row.checkout_capability_identity);
  bindScheduled(row, frame, /^LIM-00[12]$/.test(rowId) ? OBSERVER_LIMITS.frame_bytes : canonicalFrameBytes(frame).length);
  return row;
}

function bindScheduled(row: any, frame: Record<string, any>, inputLength: number): void {
  const inputDigest = envelopeDigest(frame, inputLength);
  row.git_state_generation_digest = frame.git_state_generation_digest;
  row.frame_digest = inputDigest;
  row.frame_binding = {
    scheduled: {
      row_id: frame.row_id,
      observation_id: frame.observation_id,
      checkout_capability_identity: frame.checkout_capability_identity,
      git_state_generation_digest: frame.git_state_generation_digest,
      input_length: inputLength,
      input_digest: inputDigest,
      material: { kind: "canonical-frame-envelope-v1", padding_byte: 0 },
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
      input_length: inputLength,
      input_digest: inputDigest,
      material: { kind: "scheduled-input-v1" }
    }
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
  const bytes = canonicalFrameBytes(frame);
  suppliedBytes(row, bytes, {
    kind: "canonical-frame-envelope-v1",
    padding_byte: 0,
    frame_reference: { encoding: "shud.git-status-capability.canonical-frame-json.v1", frame }
  }, {
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
  const bytes = canonicalFrameBytes(frame);
  suppliedBytes(row, bytes, {
    kind: "inline-bytes-v1",
    violation: rowId === "CAP-013" ? "absolute-path" : "path-escape",
    content_base64: bytes.toString("base64")
  }, {
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
    expect(validateRowEvidence(row)).toBe(true);
    expect(() => encodeDecisionRowProjection(row)).not.toThrow();
  });

  test("outcome match plus protection failure is a valid technical row failure", () => {
    const row = rowFor("BAS-001");
    row.control_assertions.protection.verdict = "fail";
    row.protection_set_equal = false;
    row.row_verdict = "fail";
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
    const tampered = Buffer.concat([canonicalFrameBytes(tamper.frame_binding.scheduled.frame_reference.frame)]);
    const checksumOffset = tampered.indexOf(tamper.frame_binding.scheduled.frame_reference.frame.checksum) + 1;
    tampered[checksumOffset] ^= 1;
    suppliedBytes(tamper, tampered, { kind: "xor-byte-v1", offset: checksumOffset, xor: 1 });

    const truncate = rowFor("CAP-011");
    const scheduledTruncate = canonicalFrameBytes(truncate.frame_binding.scheduled.frame_reference.frame);
    suppliedBytes(truncate, scheduledTruncate.subarray(0, -1), { kind: "truncate-tail-v1", byte_count: 1 });

    const surplus = rowFor("CAP-012");
    const scheduledSurplus = canonicalFrameBytes(surplus.frame_binding.scheduled.frame_reference.frame);
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

    const over = rowFor("LIM-002");
    const scheduledLength = over.frame_binding.scheduled.input_length;
    const appendedDigest = createHash("sha256")
      .update(canonicalFrameBytes(over.frame_binding.scheduled.frame_reference.frame))
      .update(Buffer.alloc(scheduledLength - canonicalFrameBytes(over.frame_binding.scheduled.frame_reference.frame).length))
      .update(Buffer.from([0]))
      .digest("hex");
    Object.assign(over.frame_binding.supplied, {
      input_length: OBSERVER_LIMITS.frame_bytes + 1,
      input_digest: appendedDigest,
      material: { kind: "append-byte-v1", byte: 0, count: 1 }
    });
    over.frame_digest = appendedDigest;
    expect(validateRowEvidence(over)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(over))).toBeLessThan(512 * 1024);
  });
});
