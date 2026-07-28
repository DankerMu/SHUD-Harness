import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-frame";
import {
  CATALOG_NEGATIVE_RELATIONSHIPS_V1,
  CATALOG_V1,
  CONTROL_ASSERTION_IDS,
  OBSERVER_LIMITS,
  REJECTION_CODES
} from "./frozen";

type JsonRecord = Record<string, any>;

export type CausalContext = {
  platform: "macos" | "linux";
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
  "schema_version", "platform", "producer", "row_id", "observation_id", "supplied_input_digest", "receipt_digest"
]);
const FAILURE_CAUSE_KIND_TO_TAG = Object.freeze<Record<string, string>>({
  "outcome-mismatch-v1": "o",
  "control-failure-v1": "c",
  "resource-exceeded-v1": "r",
  "lifecycle-fault-v1": "l",
  "catalog-negative-mismatch-v1": "n",
  "launcher-fault-v1": "u"
});
const FAILURE_CAUSE_TAG_TO_KIND = Object.freeze(Object.fromEntries(
  Object.entries(FAILURE_CAUSE_KIND_TO_TAG).map(([kind, tag]) => [tag, kind])
));

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

const LAUNCHER_FAILURE_CODES = Object.freeze(["SIGNALLED_TERM", "SIGNALLED_KILL", "TIMEOUT", "CLEANUP_FAILED"]);

function launcherCausalMaterial(context: CausalContext): JsonRecord | null {
  const code = context.observedOutcome.code;
  if (context.producingBoundary !== "launcher" || context.observedOutcome.kind !== "rejected" ||
    !LAUNCHER_FAILURE_CODES.includes(code) || context.boundaryClass === "exceeded" ||
    context.passedControlBits !== ALL_CONTROL_BITS || exactJson(context.expectedOutcome, context.observedOutcome) ||
    catalogNegativeProjection(context) || lifecycleProjection(context)) return null;
  if (code === "CLEANUP_FAILED") return context.cleanupVerdict === "fail"
    ? { first_cause: code, secondary_errors: [] } : null;
  return context.cleanupVerdict === "pass"
    ? { first_cause: code, secondary_errors: [] }
    : { first_cause: code, secondary_errors: ["CLEANUP_FAILED"] };
}

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
    receipt.platform !== context.platform || receipt.producer !== context.producingBoundary || receipt.row_id !== context.rowId ||
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

function catalogRelationshipRecipe(rowId: string, suppliedMaterialDigest: string): JsonRecord | null {
  const frozen = CATALOG_NEGATIVE_RELATIONSHIPS_V1[rowId];
  if (!record(frozen) || !sha256(suppliedMaterialDigest)) return null;
  const core = {
    schema_version: "shud.git-status-capability.catalog-negative-relationship.v1",
    row_id: rowId,
    identity: frozen.identity,
    supplied_material_kind: frozen.supplied_material_kind,
    supplied_material_digest: suppliedMaterialDigest
  };
  return { ...core, recipe_digest: canonicalDigest(core) };
}

function suppliedMaterialProof(value: JsonRecord, expectedKind: string): boolean {
  if (expectedKind === "scheduled-input-v1") return exactKeys(value, ["kind"]) && value.kind === expectedKind;
  return expectedKind === "canonical-frame-wire-v1" &&
    exactKeys(value, ["kind", "version", "header_length", "body_length", "extension_length", "frame_reference"]) &&
    value.kind === expectedKind && value.version === 1 && value.header_length === 128 &&
    Number.isSafeInteger(value.body_length) && value.body_length >= 0 && Number.isSafeInteger(value.extension_length) &&
    value.extension_length >= 0 && record(value.frame_reference) && exactKeys(value.frame_reference, ["encoding", "frame"]) &&
    value.frame_reference.encoding === "shud.git-status-capability.canonical-frame-json.v1" && record(value.frame_reference.frame);
}

function catalogNegativeProjection(context: CausalContext): boolean {
  const catalog = CATALOG_V1.find((row) => row.id === context.rowId);
  const frozenExpected = context.platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
  const expectedCleanup = context.rowId === "LIF-007" ? "fail" : "pass";
  return record(CATALOG_NEGATIVE_RELATIONSHIPS_V1[context.rowId]) && frozenExpected?.kind === "rejected" &&
    ["launcher", "tripwire"].includes(catalog?.producing_boundary as string) &&
    context.expectedOutcome.kind === "rejected" && context.expectedOutcome.code === frozenExpected.code &&
    context.observedOutcome.kind === "rejected" && REJECTION_CODES.includes(context.observedOutcome.code as any) &&
    context.observedOutcome.code !== frozenExpected.code && context.producingBoundary === catalog?.producing_boundary &&
    context.passedControlBits === ALL_CONTROL_BITS && context.boundaryClass === "below" && context.declaredLimit === "none" &&
    context.cleanupVerdict === expectedCleanup;
}

function lifecycleProjection(context: CausalContext): boolean {
  const expected = LIFECYCLE_MATERIAL[context.rowId];
  return record(expected) && context.producingBoundary === expected.producer &&
    context.passedControlBits === ALL_CONTROL_BITS && context.boundaryClass !== "exceeded" &&
    !exactJson(context.expectedOutcome, context.observedOutcome) && context.cleanupVerdict === expected.cleanup.verdict &&
    !catalogNegativeProjection(context);
}

function projectedCauseKindValid(kind: string, context: CausalContext): boolean {
  const controlsPassed = context.passedControlBits === ALL_CONTROL_BITS;
  if (kind === "outcome-mismatch-v1") return context.producingBoundary === "observer" &&
    !record(LIFECYCLE_MATERIAL[context.rowId]) && !exactJson(context.expectedOutcome, context.observedOutcome) &&
    context.boundaryClass !== "exceeded" && controlsPassed;
  if (kind === "control-failure-v1") {
    if (!exactJson(context.expectedOutcome, context.observedOutcome) || context.boundaryClass === "exceeded") return false;
    const allowed = context.producingBoundary === "tripwire" ? ["protected_write", "protection"] :
      context.producingBoundary === "observer" ? ["oracle"] : context.producingBoundary === "launcher"
        ? ["ambient_path", "subprocess", "network", "cleanup"] : [];
    return allowed.some((id) => {
      const index = CONTROL_ASSERTION_IDS.indexOf(id as any);
      return index >= 0 && (context.passedControlBits & (1 << index)) === 0;
    });
  }
  if (kind === "resource-exceeded-v1") {
    const index = RESOURCE_LIMITS.indexOf(context.declaredLimit);
    return context.producingBoundary === "launcher" && context.boundaryClass === "exceeded" && controlsPassed && index >= 0 &&
      context.observedOutcome.kind === "rejected" && (context.observedOutcome.code === RESOURCE_REJECTIONS[index] ||
        (context.declaredLimit === "wall_time_ms" && context.observedOutcome.code === "TIMEOUT"));
  }
  if (kind === "catalog-negative-mismatch-v1") return catalogNegativeProjection(context);
  if (kind === "launcher-fault-v1") return launcherCausalMaterial(context) !== null;
  return kind === "lifecycle-fault-v1" && lifecycleProjection(context);
}

function projectedCauseTag(context: CausalContext): string | null {
  const matchingTags = Object.entries(FAILURE_CAUSE_KIND_TO_TAG)
    .filter(([kind]) => projectedCauseKindValid(kind, context))
    .map(([, tag]) => tag);
  return matchingTags.length === 1 ? matchingTags[0]! : null;
}

function validateProjection(value: unknown, context: CausalContext): boolean {
  if (context.rowVerdict === "pass") return value === undefined;
  if (!record(value) || !exactKeys(value, ["kind", "receipt"]) || !record(value.receipt)) return false;
  const receipt = value.receipt;
  if (!receiptIsBound(receipt, context) || !projectedCauseKindValid(value.kind, context)) return false;
  if (value.kind === "outcome-mismatch-v1") return exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "observed_outcome"]) &&
    exactJson(receipt.observed_outcome, context.observedOutcome);
  if (value.kind === "control-failure-v1") {
    if (!exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "control_id", "control_verdict"]) ||
      !CONTROL_ASSERTION_IDS.includes(receipt.control_id as any) || receipt.control_verdict !== "fail") return false;
    const controlIndex = CONTROL_ASSERTION_IDS.indexOf(receipt.control_id as any);
    if ((context.passedControlBits & (1 << controlIndex)) !== 0) return false;
    const allowed = context.producingBoundary === "tripwire" ? ["protected_write", "protection"] :
      context.producingBoundary === "observer" ? ["oracle"] : context.producingBoundary === "launcher"
        ? ["ambient_path", "subprocess", "network", "cleanup"] : [];
    return allowed.includes(receipt.control_id as string);
  }
  if (value.kind === "resource-exceeded-v1") {
    if (!exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "observed_outcome", "resource"]) ||
      !exactJson(receipt.observed_outcome, context.observedOutcome) || !resourceProof(receipt.resource, context)) return false;
    return true;
  }
  if (value.kind === "catalog-negative-mismatch-v1") {
    if (!exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "frozen_expected_code", "frozen_boundary",
      "actual_code", "actual_boundary", "supplied_state", "relationship_recipe"]) ||
      receipt.platform !== context.platform || receipt.actual_code !== context.observedOutcome.code ||
      receipt.actual_boundary !== context.producingBoundary || !record(receipt.supplied_state) ||
      !exactKeys(receipt.supplied_state, ["material", "material_digest"]) || !record(receipt.supplied_state.material) ||
      !sha256(receipt.supplied_state.material_digest) ||
      receipt.supplied_state.material_digest !== canonicalDigest(receipt.supplied_state.material) ||
      !record(receipt.relationship_recipe)) return false;
    const catalog = CATALOG_V1.find((row) => row.id === context.rowId);
    const frozenExpected = context.platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
    const relationship = catalogRelationshipRecipe(context.rowId, receipt.supplied_state.material_digest as string);
    return frozenExpected?.kind === "rejected" && receipt.frozen_expected_code === frozenExpected.code &&
      receipt.frozen_boundary === catalog?.producing_boundary &&
      receipt.actual_code === context.observedOutcome.code && receipt.actual_boundary === catalog?.producing_boundary &&
      record(relationship) && exactJson(receipt.relationship_recipe, relationship) &&
      suppliedMaterialProof(receipt.supplied_state.material, relationship.supplied_material_kind as string);
  }
  if (value.kind === "launcher-fault-v1") {
    const expected = launcherCausalMaterial(context);
    return record(expected) && exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "observed_outcome", "first_cause", "secondary_errors", "cleanup"]) &&
      exactJson(receipt.observed_outcome, context.observedOutcome) && receipt.first_cause === expected.first_cause &&
      exactJson(receipt.secondary_errors, expected.secondary_errors) && record(receipt.cleanup) &&
      exactKeys(receipt.cleanup, ["verdict", "descriptors_restored", "processes_reaped"]) &&
      receipt.cleanup.verdict === context.cleanupVerdict && typeof receipt.cleanup.descriptors_restored === "boolean" &&
      typeof receipt.cleanup.processes_reaped === "boolean" && (context.cleanupVerdict === "pass"
        ? receipt.cleanup.descriptors_restored && receipt.cleanup.processes_reaped
        : !receipt.cleanup.descriptors_restored || !receipt.cleanup.processes_reaped);
  }
  if (value.kind !== "lifecycle-fault-v1" ||
    !exactKeys(receipt, [...COMMON_RECEIPT_KEYS, "supplied_mutation", "first_cause", "secondary_errors", "cleanup"])) return false;
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
    platform: row.platform, rowVerdict: row.row_verdict, expectedOutcome: row.expected_outcome, observedOutcome: row.observer_outcome,
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
    schema_version: "shud.git-status-capability.row-failure-receipt.v1", platform: row.platform,
    producer: row.actual_producing_boundary,
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
  } else if (row.failure_cause.kind === "launcher-fault-v1") {
    receipt.observed_outcome = row.observer_outcome;
    receipt.first_cause = row.first_cause;
    receipt.secondary_errors = row.secondary_errors;
    receipt.cleanup = row.cleanup;
  } else if (row.failure_cause.kind === "catalog-negative-mismatch-v1") {
    if (!record(row.frame_binding?.supplied?.material)) return null;
    const suppliedMaterialDigest = canonicalDigest(row.frame_binding.supplied.material);
    const relationship = catalogRelationshipRecipe(row.row_id, suppliedMaterialDigest);
    if (!relationship) return null;
    const catalog = CATALOG_V1.find((candidate) => candidate.id === row.row_id);
    const frozenExpected = row.platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
    if (frozenExpected?.kind !== "rejected") return null;
    receipt.frozen_expected_code = frozenExpected.code;
    receipt.frozen_boundary = catalog?.producing_boundary;
    receipt.actual_code = row.observer_outcome?.code;
    receipt.actual_boundary = row.actual_producing_boundary;
    receipt.supplied_state = {
      material: row.frame_binding.supplied.material,
      material_digest: suppliedMaterialDigest
    };
    receipt.relationship_recipe = relationship;
  } else return null;
  const projection = { kind: row.failure_cause.kind, receipt: signedReceipt(receipt) };
  const context = rawContext(row, row.control_assertions);
  return exactJson(projection, row.failure_cause) && validateProjection(projection, context) ? projection : null;
}

export function validateFailureCauseForRow(row: JsonRecord): boolean {
  return row.row_verdict === "pass"
    ? passCauseMetadataValid(row)
    : canonicalFailureCauseForRow(row) !== null;
}

function passCauseMetadataValid(row: JsonRecord): boolean {
  if (row.failure_cause !== undefined) return false;
  const expected = LIFECYCLE_MATERIAL[row.row_id];
  if (!record(expected)) return row.first_cause === undefined && row.secondary_errors === undefined;
  return row.actual_producing_boundary === expected.producer && row.first_cause === expected.first_cause &&
    exactJson(row.secondary_errors, expected.secondary_errors) && exactJson(row.cleanup, expected.cleanup);
}

export function projectedFailureCauseTagForRow(row: JsonRecord): string | null {
  if (!record(row.control_assertions) || !["pass", "fail"].includes(row.row_verdict)) return null;
  if (row.row_verdict === "pass") return "";
  const context = rawContext(row, row.control_assertions);
  return projectedCauseTag(context);
}

export function encodeFailureCauseTokenForRow(row: JsonRecord): string | null {
  if (row.row_verdict === "pass") return passCauseMetadataValid(row) ? "" : null;
  const cause = canonicalFailureCauseForRow(row);
  const rawTag = cause ? FAILURE_CAUSE_KIND_TO_TAG[cause.kind] : undefined;
  const projectedTag = projectedFailureCauseTagForRow(row);
  return rawTag && rawTag === projectedTag ? rawTag : null;
}

export function validateFailureCauseTag(token: string, context: CausalContext): boolean {
  if (context.rowVerdict === "pass") return token === "";
  const kind = FAILURE_CAUSE_TAG_TO_KIND[token];
  return typeof kind === "string" && token.length === 1 && projectedCauseTag(context) === token;
}
