import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-frame";
import { CONTROL_ASSERTION_IDS, OBSERVER_LIMITS } from "./frozen";

type JsonRecord = Record<string, any>;

export type CausalContext = {
  rowVerdict: "pass" | "fail";
  expectedOutcome: JsonRecord;
  observedOutcome: JsonRecord;
  producingBoundary: string;
  rowId: string;
  observationId: string;
  suppliedInputDigest: string;
  declaredLimit: string;
  boundaryClass: string;
  passedControlBits: number;
  cleanupVerdict: "pass" | "fail";
};

const ALL_CONTROL_BITS = (1 << CONTROL_ASSERTION_IDS.length) - 1;
const RESOURCE_LIMITS = Object.freeze([
  "frame_bytes", "index_bytes", "index_entries", "path_bytes", "path_depth", "nested_repositories",
  "traversal_entries", "hashed_bytes", "wall_time_ms", "cpu_time_ms", "threads", "memory_bytes", "output_bytes"
]);
const RESOURCE_UNITS = Object.freeze([
  "bytes", "bytes", "count", "bytes", "segments", "count", "count", "bytes", "milliseconds", "milliseconds",
  "count", "bytes", "bytes"
]);
const RESOURCE_REJECTIONS = Object.freeze([
  "LIMIT_FRAME_BYTES", "LIMIT_INDEX_BYTES", "LIMIT_INDEX_ENTRIES", "LIMIT_PATH_BYTES", "LIMIT_PATH_DEPTH",
  "LIMIT_NESTED_REPOSITORIES", "LIMIT_TRAVERSAL_ENTRIES", "LIMIT_HASHED_BYTES", "LIMIT_WALL_TIME", "LIMIT_CPU_TIME",
  "LIMIT_THREADS", "LIMIT_MEMORY", "LIMIT_OUTPUT_BYTES"
]);
const COMMON_RECEIPT_KEYS = Object.freeze([
  "schema_version", "producer", "row_id", "observation_id", "supplied_input_digest", "receipt_digest"
]);

const LIFECYCLE_MATERIAL = Object.freeze<Record<string, JsonRecord>>({
  "LIF-002": {
    producer: "observer",
    supplied_mutation: { kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 },
    first_cause: "FRAME_VERSION_UNSUPPORTED", secondary_errors: [],
    cleanup: { verdict: "pass", descriptors_restored: true, processes_reaped: true }
  },
  "LIF-006": {
    producer: "observer",
    supplied_mutation: { kind: "set-wire-version-v1", offset: 8, from: 1, to: 2 },
    first_cause: "FRAME_VERSION_UNSUPPORTED", secondary_errors: ["CLEANUP_FAILED"],
    cleanup: { verdict: "fail", descriptors_restored: false, processes_reaped: true }
  },
  "LIF-007": {
    producer: "launcher", supplied_mutation: { kind: "scheduled-input-v1" }, first_cause: "CLEANUP_FAILED",
    secondary_errors: [], cleanup: { verdict: "fail", descriptors_restored: false, processes_reaped: true }
  }
});

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((item, index) => exactJson(item, right[index]));
  if (record(left) || record(right)) {
    if (!record(left) || !record(right) || !exactKeys(left, Object.keys(right))) return false;
    return Object.keys(right).every((key) => exactJson(left[key], right[key]));
  }
  return false;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function signedReceipt(receipt: JsonRecord): JsonRecord {
  return { ...receipt, receipt_digest: canonicalDigest(receipt) };
}

function receiptIsBound(receipt: JsonRecord, context: CausalContext): boolean {
  if (receipt.schema_version !== "shud.git-status-capability.row-failure-receipt.v1" ||
    receipt.producer !== context.producingBoundary || receipt.row_id !== context.rowId ||
    receipt.observation_id !== context.observationId || receipt.supplied_input_digest !== context.suppliedInputDigest ||
    !sha256(receipt.receipt_digest)) return false;
  const unsigned = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receipt_digest"));
  return receipt.receipt_digest === canonicalDigest(unsigned);
}

function resourceProof(value: unknown, context: CausalContext): boolean {
  if (!record(value) || !exactKeys(value, ["boundary_class", "declared_limit", "within_limits", "stimulus", "measurement"]) ||
    value.boundary_class !== "exceeded" || value.within_limits !== false || value.declared_limit !== context.declaredLimit ||
    !record(value.stimulus) || !record(value.measurement)) return false;
  const limitIndex = RESOURCE_LIMITS.indexOf(value.declared_limit as string);
  if (limitIndex < 0) return false;
  const limit = RESOURCE_LIMITS[limitIndex]! as keyof typeof OBSERVER_LIMITS;
  const unit = RESOURCE_UNITS[limitIndex]!;
  const stimulus = value.stimulus;
  const measurement = value.measurement;
  if (!exactKeys(stimulus, ["schema_version", "recipe", "recipe_digest", "locator"]) ||
    stimulus.schema_version !== "shud.git-status-capability.limit-stimulus.v1" || !record(stimulus.recipe) ||
    !exactKeys(stimulus.recipe, ["kind", "limit", "unit", "value"]) || stimulus.recipe.kind !== "literal-counter-v1" ||
    stimulus.recipe.limit !== limit || stimulus.recipe.unit !== unit || !Number.isSafeInteger(stimulus.recipe.value) ||
    stimulus.recipe.value <= OBSERVER_LIMITS[limit] || stimulus.recipe_digest !== canonicalDigest(stimulus.recipe) ||
    !record(stimulus.locator)) return false;
  const locator = stimulus.locator;
  if (!exactKeys(locator, ["kind", "row_id", "observation_id", "supplied_input_digest", "recipe_digest", "source", "receipt_digest"]) ||
    locator.row_id !== context.rowId || locator.observation_id !== context.observationId ||
    locator.supplied_input_digest !== context.suppliedInputDigest || locator.recipe_digest !== stimulus.recipe_digest ||
    !sha256(locator.receipt_digest)) return false;
  const frameDerived = limitIndex < 8;
  if (frameDerived ? locator.kind !== "supplied-frame-locator-v1" || locator.source !== "canonical-supplied-frame" :
    locator.kind !== "launcher-receipt-v1" || locator.source !== "launcher-counter") return false;
  const unsignedLocator = Object.fromEntries(Object.entries(locator).filter(([key]) => key !== "receipt_digest"));
  if (locator.receipt_digest !== canonicalDigest(unsignedLocator)) return false;
  return exactKeys(measurement, ["schema_version", "limit", "unit", "value", "stimulus_receipt_digest"]) &&
    measurement.schema_version === "shud.git-status-capability.limit-measurement.v1" && measurement.limit === limit &&
    measurement.unit === unit && measurement.value === stimulus.recipe.value &&
    measurement.stimulus_receipt_digest === locator.receipt_digest;
}

function validateProjection(value: unknown, context: CausalContext): boolean {
  if (context.rowVerdict === "pass") return value === undefined;
  if (!record(value) || !exactKeys(value, ["kind", "receipt"]) || !record(value.receipt)) return false;
  const receipt = value.receipt;
  if (!receiptIsBound(receipt, context)) return false;
  const controlsPassed = context.passedControlBits === ALL_CONTROL_BITS;
  if (value.kind === "outcome-mismatch-v1") return exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "observed_outcome"]) &&
    context.producingBoundary === "observer" && exactJson(receipt.observed_outcome, context.observedOutcome) &&
    !exactJson(context.expectedOutcome, context.observedOutcome) && context.boundaryClass !== "exceeded" && controlsPassed;
  if (value.kind === "control-failure-v1") {
    if (!exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "control_id", "control_verdict"]) ||
      !CONTROL_ASSERTION_IDS.includes(receipt.control_id as any) || receipt.control_verdict !== "fail" ||
      !exactJson(context.expectedOutcome, context.observedOutcome) || context.boundaryClass === "exceeded") return false;
    const controlIndex = CONTROL_ASSERTION_IDS.indexOf(receipt.control_id as any);
    if ((context.passedControlBits & (1 << controlIndex)) !== 0) return false;
    const allowed = context.producingBoundary === "tripwire" ? ["protected_write", "protection"] :
      context.producingBoundary === "observer" ? ["oracle"] : context.producingBoundary === "launcher"
        ? ["ambient_path", "subprocess", "network", "cleanup"] : [];
    return allowed.includes(receipt.control_id as string);
  }
  if (value.kind === "resource-exceeded-v1") {
    if (!exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "observed_outcome", "resource"]) ||
      context.producingBoundary !== "launcher" || context.boundaryClass !== "exceeded" || !controlsPassed ||
      !exactJson(receipt.observed_outcome, context.observedOutcome) || !resourceProof(receipt.resource, context)) return false;
    const index = RESOURCE_LIMITS.indexOf(context.declaredLimit);
    return index >= 0 && context.observedOutcome.kind === "rejected" &&
      (context.observedOutcome.code === RESOURCE_REJECTIONS[index] ||
        (context.declaredLimit === "wall_time_ms" && context.observedOutcome.code === "TIMEOUT"));
  }
  if (value.kind !== "lifecycle-fault-v1" ||
    !exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "supplied_mutation", "first_cause", "secondary_errors", "cleanup"]) ||
    !controlsPassed || context.boundaryClass === "exceeded" || exactJson(context.expectedOutcome, context.observedOutcome)) return false;
  const expected = LIFECYCLE_MATERIAL[context.rowId];
  return record(expected) && context.producingBoundary === expected.producer &&
    exactJson(receipt.supplied_mutation, expected.supplied_mutation) && receipt.first_cause === expected.first_cause &&
    exactJson(receipt.secondary_errors, expected.secondary_errors) && exactJson(receipt.cleanup, expected.cleanup) &&
    receipt.cleanup.verdict === context.cleanupVerdict;
}

function passedBits(assertions: JsonRecord): number {
  let bits = 0;
  for (let index = 0; index < CONTROL_ASSERTION_IDS.length; index += 1) {
    if (assertions[CONTROL_ASSERTION_IDS[index]!]!.verdict === "pass") bits |= 1 << index;
  }
  return bits;
}

function rawContext(row: JsonRecord, assertions: JsonRecord): CausalContext {
  return {
    rowVerdict: row.row_verdict, expectedOutcome: row.expected_outcome, observedOutcome: row.observer_outcome,
    producingBoundary: row.actual_producing_boundary, rowId: row.row_id, observationId: row.observation_id,
    suppliedInputDigest: row.frame_digest, declaredLimit: row.actual_resource_record.declared_limit,
    boundaryClass: row.actual_resource_record.boundary_class, passedControlBits: passedBits(assertions),
    cleanupVerdict: row.cleanup.verdict
  };
}

export function canonicalFailureCauseForRow(row: JsonRecord): JsonRecord | null {
  if (row.row_verdict !== "fail" || !record(row.failure_cause) || typeof row.failure_cause.kind !== "string" ||
    !record(row.control_assertions)) return null;
  const receipt: JsonRecord = {
    schema_version: "shud.git-status-capability.row-failure-receipt.v1", producer: row.actual_producing_boundary,
    row_id: row.row_id, observation_id: row.observation_id, supplied_input_digest: row.frame_digest
  };
  if (row.failure_cause.kind === "outcome-mismatch-v1") receipt.observed_outcome = row.observer_outcome;
  else if (row.failure_cause.kind === "control-failure-v1") {
    const controlId = row.failure_cause.receipt?.control_id;
    if (!CONTROL_ASSERTION_IDS.includes(controlId)) return null;
    receipt.control_id = controlId;
    receipt.control_verdict = row.control_assertions[controlId]?.verdict;
  } else if (row.failure_cause.kind === "resource-exceeded-v1") {
    receipt.observed_outcome = row.observer_outcome;
    receipt.resource = row.actual_resource_record;
  } else if (row.failure_cause.kind === "lifecycle-fault-v1") {
    receipt.supplied_mutation = row.frame_binding?.supplied?.material;
    receipt.first_cause = row.first_cause;
    receipt.secondary_errors = row.secondary_errors;
    receipt.cleanup = row.cleanup;
  } else return null;
  const projection = { kind: row.failure_cause.kind, receipt: signedReceipt(receipt) };
  const context = rawContext(row, row.control_assertions);
  return exactJson(projection, row.failure_cause) && validateProjection(projection, context) ? projection : null;
}

export function validateFailureCauseForRow(row: JsonRecord): boolean {
  return row.row_verdict === "pass" ? row.failure_cause === undefined : canonicalFailureCauseForRow(row) !== null;
}

export function encodeFailureCauseTokenForRow(row: JsonRecord): string | null {
  if (row.row_verdict === "pass") return row.failure_cause === undefined ? "" : null;
  const cause = canonicalFailureCauseForRow(row);
  return cause ? canonicalJsonBytes(cause).toString("base64url") : null;
}

export function decodeAndValidateFailureCause(token: string, context: CausalContext): boolean {
  if (context.rowVerdict === "pass") return token === "";
  if (!token) return false;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) return false;
    const cause = JSON.parse(bytes.toString("utf8"));
    return canonicalJsonBytes(cause).equals(bytes) && validateProjection(cause, context);
  } catch { return false; }
}
