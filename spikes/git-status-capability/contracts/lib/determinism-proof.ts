import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-frame";
import { encodeDecisionRowProjectionCore } from "./row-projection";

type JsonRecord = Record<string, any>;

const AXES = Object.freeze({
  "DET-001": "same-input-repeat", "DET-002": "fixture-creation-order",
  "DET-003": "fixture-root", "DET-004": "volatile-fields"
} as const);
const STABLE_INPUT_KEYS = Object.freeze([
  "platform", "row_id", "observation_id", "checkout_capability_identity", "git_state_generation_digest",
  "supplied_input_digest", "expected_outcome", "oracle_digest", "source_input_record_sha256"
]);
const AXIS_INPUT_KEYS = Object.freeze([...STABLE_INPUT_KEYS, "axis_binding"]);
const OUTPUT_KEYS = Object.freeze([
  "observer_outcome", "producing_boundary", "row_verdict", "control_assertions", "protection_set_equal", "cleanup", "resource_record"
]);
const RECEIPT_KEYS = Object.freeze([
  "receipt_id", "input", "output", "normalized_row_output_digest", "decision_projection_digest"
]);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function stringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 1 && value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
}

function axisBinding(rowId: string, value: unknown, side: "first" | "second"): value is JsonRecord {
  if (!record(value) || value.side !== side) return false;
  if (rowId === "DET-002") return exactKeys(value, ["kind", "side", "sequence"]) &&
    value.kind === "fixture-creation-order" && stringSet(value.sequence);
  if (rowId === "DET-003") return exactKeys(value, ["kind", "side", "root_token"]) &&
    value.kind === "fixture-root" && sha256(value.root_token);
  return rowId === "DET-004" &&
    exactKeys(value, ["kind", "side", "timestamp_digest", "map_order_digest", "below_bound_counter_digest"]) &&
    value.kind === "permitted-volatile-material" && sha256(value.timestamp_digest) &&
    sha256(value.map_order_digest) && sha256(value.below_bound_counter_digest);
}

function stableInput(input: JsonRecord): JsonRecord {
  return Object.fromEntries(STABLE_INPUT_KEYS.map((key) => [key, input[key]]));
}

function derivedAxisMaterial(rowId: string, firstInput: JsonRecord, secondInput: JsonRecord): JsonRecord | null {
  if (rowId === "DET-001") return exactJson(firstInput, secondInput)
    ? { kind: "same-input-repeat", input_digest: digest(firstInput) } : null;
  const first = firstInput.axis_binding;
  const second = secondInput.axis_binding;
  if (!axisBinding(rowId, first, "first") || !axisBinding(rowId, second, "second")) return null;
  if (rowId === "DET-002") {
    if (exactJson(first.sequence, second.sequence) ||
      !exactJson([...(first.sequence as string[])].sort(), [...(second.sequence as string[])].sort())) return null;
    return { kind: "fixture-creation-order", first_order: first.sequence, second_order: second.sequence };
  }
  if (rowId === "DET-003") return first.root_token !== second.root_token
    ? { kind: "fixture-root", first_root_token: first.root_token, second_root_token: second.root_token } : null;
  const volatile = (binding: JsonRecord) => ({
    timestamp_digest: binding.timestamp_digest, map_order_digest: binding.map_order_digest,
    below_bound_counter_digest: binding.below_bound_counter_digest
  });
  const firstVolatile = volatile(first);
  const secondVolatile = volatile(second);
  return !exactJson(firstVolatile, secondVolatile)
    ? { kind: "permitted-volatile-material", first: firstVolatile, second: secondVolatile } : null;
}

function reconstructedRow(input: JsonRecord, output: JsonRecord): JsonRecord {
  return {
    platform: input.platform, row_id: input.row_id, observation_id: input.observation_id,
    checkout_capability_identity: input.checkout_capability_identity,
    git_state_generation_digest: input.git_state_generation_digest, frame_digest: input.supplied_input_digest,
    expected_outcome: input.expected_outcome, observer_outcome: output.observer_outcome,
    producing_boundary: output.producing_boundary, row_verdict: output.row_verdict,
    oracle_digest: input.oracle_digest, control_assertions: output.control_assertions,
    protection_set_equal: output.protection_set_equal, cleanup: output.cleanup,
    resource_record: output.resource_record, source_input_record_sha256: input.source_input_record_sha256
  };
}

function receipt(value: unknown, row: JsonRecord, token: string, side: "first" | "second"): value is JsonRecord {
  const inputKeys = row.row_id === "DET-001" ? STABLE_INPUT_KEYS : AXIS_INPUT_KEYS;
  if (!record(value) || !exactKeys(value, RECEIPT_KEYS) || !sha256(value.receipt_id) || !record(value.input) ||
    !exactKeys(value.input, inputKeys) || (row.row_id !== "DET-001" && !axisBinding(row.row_id, value.input.axis_binding, side)) ||
    !record(value.output) || !exactKeys(value.output, OUTPUT_KEYS) ||
    !sha256(value.normalized_row_output_digest) || !sha256(value.decision_projection_digest)) return false;
  const expectedInput = {
    platform: row.platform, row_id: row.row_id, observation_id: row.observation_id,
    checkout_capability_identity: row.checkout_capability_identity, git_state_generation_digest: row.git_state_generation_digest,
    supplied_input_digest: row.frame_digest, expected_outcome: row.expected_outcome, oracle_digest: row.oracle_digest,
    source_input_record_sha256: row.source_input_record_sha256
  };
  const expectedOutput = {
    observer_outcome: row.observer_outcome, producing_boundary: row.producing_boundary, row_verdict: row.row_verdict,
    control_assertions: row.control_assertions, protection_set_equal: row.protection_set_equal,
    cleanup: row.cleanup, resource_record: row.resource_record
  };
  if (!exactJson(stableInput(value.input), expectedInput) || !exactJson(value.output, expectedOutput) ||
    value.normalized_row_output_digest !== digest(value.output)) return false;
  let projection: string;
  try { projection = encodeDecisionRowProjectionCore(reconstructedRow(value.input, value.output), token); } catch { return false; }
  return value.decision_projection_digest === createHash("sha256").update(projection).digest("hex");
}

export function validateDeterminismProof(row: JsonRecord): boolean {
  const expectedAxis = AXES[row.row_id as keyof typeof AXES];
  const token = /^DET-00([1-4])$/.exec(row.row_id)?.[1];
  if (!expectedAxis || !token || !record(row.determinism_proof)) return false;
  const proof = row.determinism_proof;
  if (!exactKeys(proof, ["variation_axis", "axis_material", "axis_digest", "first", "second", "comparison"]) ||
    proof.variation_axis !== expectedAxis || !sha256(proof.axis_digest) || !record(proof.first) || !record(proof.second) ||
    !receipt(proof.first, row, token, "first") || !receipt(proof.second, row, token, "second") ||
    proof.first.receipt_id === proof.second.receipt_id ||
    !record(proof.comparison) || !exactKeys(proof.comparison, ["normalized_row_output_equal", "decision_projection_equal"]) ||
    proof.comparison.normalized_row_output_equal !== true || proof.comparison.decision_projection_equal !== true) return false;
  const axisMaterial = derivedAxisMaterial(row.row_id, proof.first.input, proof.second.input);
  if (!axisMaterial || !exactJson(proof.axis_material, axisMaterial) || proof.axis_digest !== digest(axisMaterial)) return false;
  const stableInputsEqual = row.row_id === "DET-001"
    ? exactJson(proof.first.input, proof.second.input)
    : exactJson(stableInput(proof.first.input), stableInput(proof.second.input));
  return stableInputsEqual && exactJson(proof.first.output, proof.second.output) &&
    proof.first.normalized_row_output_digest === proof.second.normalized_row_output_digest &&
    proof.first.decision_projection_digest === proof.second.decision_projection_digest;
}

export function determinismProjectionToken(row: JsonRecord): string | null {
  const match = /^DET-00([1-4])$/.exec(row.row_id);
  if (!match) return row.determinism_proof === undefined ? "0" : null;
  return validateDeterminismProof(row) ? match[1]! : null;
}
