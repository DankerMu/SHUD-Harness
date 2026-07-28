import { createHash } from "node:crypto";

type JsonRecord = Record<string, any>;

const AXES = Object.freeze({
  "DET-001": "same-input-repeat",
  "DET-002": "fixture-creation-order",
  "DET-003": "fixture-root",
  "DET-004": "volatile-fields"
} as const);

const OBSERVATION_KEYS = Object.freeze([
  "invocation_id", "variation_value_digest", "row_id", "observation_id", "checkout_capability_identity",
  "git_state_generation_digest", "supplied_input_digest", "observer_outcome", "normalized_row_output", "decision_projection"
]);
const MATERIAL_KEYS = Object.freeze(["byte_length", "digest", "content_base64"]);
const MAX_COMPARISON_BYTES = 64 * 1024;

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

function byteMaterial(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, MATERIAL_KEYS) || !Number.isSafeInteger(value.byte_length) ||
    value.byte_length < 0 || value.byte_length > MAX_COMPARISON_BYTES || !sha256(value.digest) ||
    typeof value.content_base64 !== "string") return false;
  const bytes = Buffer.from(value.content_base64, "base64");
  return bytes.length === value.byte_length && bytes.toString("base64") === value.content_base64 &&
    createHash("sha256").update(bytes).digest("hex") === value.digest;
}

function observation(value: unknown, row: JsonRecord): value is JsonRecord {
  return record(value) && exactKeys(value, OBSERVATION_KEYS) && sha256(value.invocation_id) &&
    sha256(value.variation_value_digest) && value.row_id === row.row_id && value.observation_id === row.observation_id &&
    value.checkout_capability_identity === row.checkout_capability_identity &&
    value.git_state_generation_digest === row.git_state_generation_digest &&
    value.supplied_input_digest === row.frame_digest && exactJson(value.observer_outcome, row.observer_outcome) &&
    byteMaterial(value.normalized_row_output) && byteMaterial(value.decision_projection);
}

export function validateDeterminismProof(row: JsonRecord): boolean {
  const expectedAxis = AXES[row.row_id as keyof typeof AXES];
  if (!expectedAxis || !record(row.determinism_proof)) return false;
  const proof = row.determinism_proof;
  if (!exactKeys(proof, ["variation_axis", "first", "second", "comparison"]) || proof.variation_axis !== expectedAxis ||
    !observation(proof.first, row) || !observation(proof.second, row) || !record(proof.comparison) ||
    !exactKeys(proof.comparison, ["normalized_row_output_equal", "decision_projection_equal"]) ||
    proof.comparison.normalized_row_output_equal !== true || proof.comparison.decision_projection_equal !== true) return false;
  const first = proof.first as JsonRecord;
  const second = proof.second as JsonRecord;
  if (first.invocation_id === second.invocation_id ||
    !exactJson(first.normalized_row_output, second.normalized_row_output) ||
    !exactJson(first.decision_projection, second.decision_projection)) return false;
  return row.row_id === "DET-001"
    ? first.variation_value_digest === second.variation_value_digest
    : first.variation_value_digest !== second.variation_value_digest;
}

export function determinismProjectionToken(row: JsonRecord): string | null {
  const match = /^DET-00([1-4])$/.exec(row.row_id);
  if (!match) return row.determinism_proof === undefined ? "0" : null;
  return validateDeterminismProof(row) ? match[1]! : null;
}
