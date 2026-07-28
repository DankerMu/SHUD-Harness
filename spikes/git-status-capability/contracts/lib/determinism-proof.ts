import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-frame";
import { encodeDecisionRowProjectionCore } from "./row-projection";

type JsonRecord = Record<string, any>;

const AXES = Object.freeze({
  "DET-001": "same-input-repeat", "DET-002": "fixture-creation-order",
  "DET-003": "fixture-root", "DET-004": "volatile-fields"
} as const);
const INPUT_KEYS = Object.freeze([
  "platform", "row_id", "observation_id", "checkout_capability_identity", "git_state_generation_digest",
  "supplied_input_digest", "expected_outcome", "oracle_digest", "source_input_record_sha256"
]);
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

function axisMaterial(rowId: string, value: unknown, input: JsonRecord): boolean {
  if (!record(value)) return false;
  if (rowId === "DET-001") return exactKeys(value, ["kind", "input_digest"]) && value.kind === "same-input-repeat" && value.input_digest === digest(input);
  if (rowId === "DET-002") return exactKeys(value, ["kind", "first_order", "second_order"]) && value.kind === "fixture-creation-order" &&
    stringSet(value.first_order) && stringSet(value.second_order) && !exactJson(value.first_order, value.second_order) &&
    exactJson([...value.first_order].sort(), [...value.second_order].sort());
  if (rowId === "DET-003") return exactKeys(value, ["kind", "first_root_token", "second_root_token"]) && value.kind === "fixture-root" &&
    sha256(value.first_root_token) && sha256(value.second_root_token) && value.first_root_token !== value.second_root_token;
  if (rowId !== "DET-004" || !exactKeys(value, ["kind", "first", "second"]) || value.kind !== "permitted-volatile-material") return false;
  const volatile = (item: unknown) => record(item) && exactKeys(item, ["timestamp_digest", "map_order_digest", "below_bound_counter_digest"]) && Object.values(item).every(sha256);
  return volatile(value.first) && volatile(value.second) && !exactJson(value.first, value.second);
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

function receipt(value: unknown, row: JsonRecord, token: string): value is JsonRecord {
  if (!record(value) || !exactKeys(value, RECEIPT_KEYS) || !sha256(value.receipt_id) || !record(value.input) ||
    !exactKeys(value.input, INPUT_KEYS) || !record(value.output) || !exactKeys(value.output, OUTPUT_KEYS) ||
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
  if (!exactJson(value.input, expectedInput) || !exactJson(value.output, expectedOutput) ||
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
    proof.variation_axis !== expectedAxis || !sha256(proof.axis_digest) || !record(proof.first) ||
    !axisMaterial(row.row_id, proof.axis_material, proof.first.input) || proof.axis_digest !== digest(proof.axis_material) ||
    !receipt(proof.first, row, token) || !receipt(proof.second, row, token) || proof.first.receipt_id === proof.second.receipt_id ||
    !record(proof.comparison) || !exactKeys(proof.comparison, ["normalized_row_output_equal", "decision_projection_equal"]) ||
    proof.comparison.normalized_row_output_equal !== true || proof.comparison.decision_projection_equal !== true) return false;
  return exactJson(proof.first.input, proof.second.input) && exactJson(proof.first.output, proof.second.output) &&
    proof.first.normalized_row_output_digest === proof.second.normalized_row_output_digest &&
    proof.first.decision_projection_digest === proof.second.decision_projection_digest;
}

export function determinismProjectionToken(row: JsonRecord): string | null {
  const match = /^DET-00([1-4])$/.exec(row.row_id);
  if (!match) return row.determinism_proof === undefined ? "0" : null;
  return validateDeterminismProof(row) ? match[1]! : null;
}
