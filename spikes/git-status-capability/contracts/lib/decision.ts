import { createHash } from "node:crypto";
import { CATALOG_V1, CONTROL_ASSERTION_IDS, DECISION_LIMIT_TOKENS, DECISION_ROW_SEGMENTS, REJECTION_CODES } from "./frozen";
import { canonicalJsonBytes } from "./canonical-frame";
import { determinismProjectionToken } from "./determinism-proof";
import { encodeDecisionRowProjectionCore } from "./row-projection";

type JsonRecord = Record<string, any>;

const RECEIPT_FIELDS = Object.freeze([
  "id", "argv", "version", "exit_verdict", "summary_digest", "source_input_record_sha256"
]);

const IDENTITY_FIELDS = Object.freeze([
  "fixture_identity", "oracle_identity", "frame_identity", "runner_identity", "validator_identity", "tripwire_identity",
  "macos_toolchain_identity", "linux_toolchain_identity"
]);

const DIGEST_FIELDS = Object.freeze([
  "lockfile_digest", "direct_feature_digest", "macos_target_graph_digest", "linux_target_graph_digest",
  "call_ledger_digest", "sbom_digest", "license_inventory_digest"
]);

const COMPLETENESS_FIELDS = Object.freeze([
  "lockfile_completeness_verdict", "direct_feature_completeness_verdict",
  "macos_target_graph_completeness_verdict", "linux_target_graph_completeness_verdict",
  "call_ledger_completeness_verdict", "sbom_completeness_verdict", "license_inventory_completeness_verdict"
]);

const TOKEN_TO_KIND = Object.freeze({ c: "clean", d: "dirty", r: "rejected" });
const TOKEN_TO_BOUNDARY = Object.freeze({ b: "below", e: "exact", x: "exceeded" });
const TOKEN_TO_PRODUCER = Object.freeze({ o: "observer", l: "launcher", t: "tripwire" });
const ALL_CONTROL_BITS = (1 << CONTROL_ASSERTION_IDS.length) - 1;
const ALL_CONTROL_TOKEN = ALL_CONTROL_BITS.toString(16).padStart(2, "0");
const LIMIT_REJECTION_BY_NAME = Object.freeze<Record<string, string>>({
  frame_bytes: "LIMIT_FRAME_BYTES", index_bytes: "LIMIT_INDEX_BYTES", index_entries: "LIMIT_INDEX_ENTRIES",
  path_bytes: "LIMIT_PATH_BYTES", path_depth: "LIMIT_PATH_DEPTH", nested_repositories: "LIMIT_NESTED_REPOSITORIES",
  traversal_entries: "LIMIT_TRAVERSAL_ENTRIES", hashed_bytes: "LIMIT_HASHED_BYTES", wall_time_ms: "LIMIT_WALL_TIME",
  cpu_time_ms: "LIMIT_CPU_TIME", threads: "LIMIT_THREADS", memory_bytes: "LIMIT_MEMORY", output_bytes: "LIMIT_OUTPUT_BYTES"
});

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && (/^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value));
}

function exactJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((item, index) => exactJson(item, right[index]));
  if (record(left) || record(right)) {
    if (!record(left) || !record(right) || !exactKeys(left, Object.keys(right))) return false;
    return Object.keys(right).every((key) => exactJson(left[key], right[key]));
  }
  return false;
}

function decodedFailureCause(token: string, context: {
  rowVerdict: "pass" | "fail"; expectedOutcome: JsonRecord; observedOutcome: JsonRecord; producingBoundary: string;
  rowId: string; observationId: string; frameDigest: string; declaredLimit: string; boundaryClass: string; passedControlBits: number;
}): boolean {
  if (context.rowVerdict === "pass") return token === "";
  if (!token) return false;
  let bytes: Buffer;
  let cause: JsonRecord;
  try {
    bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) return false;
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!record(parsed) || !canonicalJsonBytes(parsed).equals(bytes)) return false;
    cause = parsed;
  } catch { return false; }
  if (!exactKeys(cause, ["kind", "receipt"]) || !record(cause.receipt)) return false;
  const receipt = cause.receipt;
  const baseKeys = ["schema_version", "producer", "row_id", "observation_id", "supplied_input_digest", "receipt_digest"];
  if (receipt.schema_version !== "shud.git-status-capability.row-failure-receipt.v1" || receipt.producer !== context.producingBoundary ||
    receipt.row_id !== context.rowId || receipt.observation_id !== context.observationId || receipt.supplied_input_digest !== context.frameDigest ||
    !sha256(receipt.receipt_digest) || receipt.receipt_digest !== createHash("sha256").update(canonicalJsonBytes(
      Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receipt_digest")))).digest("hex")) return false;
  const controlsPassed = context.passedControlBits === ALL_CONTROL_BITS;
  if (cause.kind === "outcome-mismatch-v1") return exactKeys(receipt, [...baseKeys, "observed_outcome"]) &&
    exactJson(receipt.observed_outcome, context.observedOutcome) && !exactJson(context.expectedOutcome, context.observedOutcome) &&
    context.boundaryClass !== "exceeded" && controlsPassed;
  if (cause.kind === "control-failure-v1") {
    if (!exactKeys(receipt, [...baseKeys, "control_id", "control_verdict"]) || !CONTROL_ASSERTION_IDS.includes(receipt.control_id as any) ||
      receipt.control_verdict !== "fail" || exactJson(context.expectedOutcome, context.observedOutcome) === false || context.boundaryClass === "exceeded") return false;
    const controlIndex = CONTROL_ASSERTION_IDS.indexOf(receipt.control_id as any);
    if ((context.passedControlBits & (1 << controlIndex)) !== 0) return false;
    const allowed = context.producingBoundary === "tripwire" ? ["protected_write", "protection"] :
      context.producingBoundary === "observer" ? ["oracle"] : ["ambient_path", "subprocess", "network", "cleanup"];
    return allowed.includes(receipt.control_id as string);
  }
  if (cause.kind === "resource-exceeded-v1") return exactKeys(receipt, [...baseKeys, "declared_limit", "stimulus_receipt_digest", "observed_outcome"]) &&
    context.producingBoundary === "launcher" && context.boundaryClass === "exceeded" && receipt.declared_limit === context.declaredLimit &&
    sha256(receipt.stimulus_receipt_digest) && exactJson(receipt.observed_outcome, context.observedOutcome) &&
    context.observedOutcome.kind === "rejected" && (context.observedOutcome.code === LIMIT_REJECTION_BY_NAME[context.declaredLimit] ||
      (context.declaredLimit === "wall_time_ms" && context.observedOutcome.code === "TIMEOUT")) && controlsPassed;
  return cause.kind === "lifecycle-fault-v1" && exactKeys(receipt, [...baseKeys, "mutation_kind", "first_cause", "cleanup_verdict"]) &&
    ["LIF-002", "LIF-006", "LIF-007"].includes(context.rowId) && nonEmptyString(receipt.mutation_kind) &&
    nonEmptyString(receipt.first_cause) && ["pass", "fail"].includes(receipt.cleanup_verdict as string);
}

function decodeOutcome(kindToken: string, code: string): JsonRecord | null {
  const kind = TOKEN_TO_KIND[kindToken as keyof typeof TOKEN_TO_KIND];
  if (kind === "clean" || kind === "dirty") return code === "" ? { kind } : null;
  return kind === "rejected" && REJECTION_CODES.includes(code) ? { kind, code } : null;
}

type DecodedRow = {
  platform: "macos" | "linux";
  rowId: string;
  rowVerdict: "pass" | "fail";
  observationId: string;
  generationPayloadDigest: string;
  frameDigest: string;
};

function decodeDecisionRow(value: unknown): DecodedRow | null {
  if (typeof value !== "string") return null;
  const fields = value.split("\0");
  if (fields.length !== DECISION_ROW_SEGMENTS.length) return null;
  const [platformToken, rowId, expectedKind, expectedCode, observedKind, observedCode, verdictToken,
    observationId, generationPayloadDigest, frameDigest, producingBoundaryToken, activeControls, passedControls,
    protectionSetEqual, cleanupVerdict, declaredLimitToken, boundaryToken, determinismToken, failureCauseToken] = fields;
  const platform = platformToken === "m" ? "macos" : platformToken === "l" ? "linux" : null;
  const expectedOutcome = decodeOutcome(expectedKind!, expectedCode!);
  const observedOutcome = decodeOutcome(observedKind!, observedCode!);
  const rowVerdict = verdictToken === "p" ? "pass" : verdictToken === "f" ? "fail" : null;
  const limitOrdinal = /^(?:[0-9]|1[0-3])$/.test(declaredLimitToken!) ? Number(declaredLimitToken) : -1;
  const declaredLimit = DECISION_LIMIT_TOKENS[limitOrdinal];
  const boundaryClass = TOKEN_TO_BOUNDARY[boundaryToken as keyof typeof TOKEN_TO_BOUNDARY];
  const producingBoundary = TOKEN_TO_PRODUCER[producingBoundaryToken as keyof typeof TOKEN_TO_PRODUCER];
  const expectedDeterminismToken = /^DET-00([1-4])$/.exec(rowId!)?.[1] ?? "0";
  const passedControlBits = /^[0-9a-f]{2}$/.test(passedControls!) ? Number.parseInt(passedControls!, 16) : -1;
  if (!platform || !nonEmptyString(rowId) || !expectedOutcome || !observedOutcome || !rowVerdict || !sha256(observationId) ||
    !sha256(generationPayloadDigest) || !sha256(frameDigest) || !producingBoundary || activeControls !== ALL_CONTROL_TOKEN ||
    passedControlBits < 0 || (passedControlBits & ~ALL_CONTROL_BITS) !== 0 || !["0", "1"].includes(protectionSetEqual!) ||
    !["p", "f"].includes(cleanupVerdict!) || !declaredLimit || !boundaryClass || determinismToken !== expectedDeterminismToken ||
    ((boundaryClass === "below") !== (declaredLimit === "none"))) return null;
  const catalog = CATALOG_V1.find((row) => row.id === rowId);
  const frozenExpected = platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
  const limitMatch = /^LIM-(\d{3})$/.exec(rowId);
  const frozenLimitOrdinal = limitMatch ? Math.floor((Number(limitMatch[1]) - 1) / 2) + 1 : 0;
  const frozenBoundary = limitMatch ? Number(limitMatch[1]) % 2 === 1 ? "exact" : "exceeded" : "below";
  const protectionPassed = (passedControlBits & (1 << CONTROL_ASSERTION_IDS.indexOf("protection"))) !== 0;
  const cleanupPassed = (passedControlBits & (1 << CONTROL_ASSERTION_IDS.indexOf("cleanup"))) !== 0;
  const controlsPassed = passedControlBits === ALL_CONTROL_BITS;
  const cleanupFailureIsEvidence = rowId === "LIF-006" || rowId === "LIF-007";
  const actualMatchesExpected = producingBoundary === catalog?.producing_boundary && limitOrdinal === frozenLimitOrdinal && boundaryClass === frozenBoundary;
  const failureCauseValid = decodedFailureCause(failureCauseToken!, {
    rowVerdict, expectedOutcome, observedOutcome, producingBoundary, rowId: rowId!, observationId: observationId!,
    frameDigest: frameDigest!, declaredLimit, boundaryClass, passedControlBits
  });
  if (!exactJson(expectedOutcome, frozenExpected) || (rowVerdict === "pass" && !actualMatchesExpected) ||
    protectionPassed !== (protectionSetEqual === "1") ||
    (cleanupFailureIsEvidence ? !(cleanupPassed && cleanupVerdict === "f") : cleanupPassed !== (cleanupVerdict === "p")) ||
    ((rowVerdict === "pass") !== (exactJson(expectedOutcome, observedOutcome) && controlsPassed && actualMatchesExpected)) || !failureCauseValid) return null;
  return { platform, rowId, rowVerdict, observationId, generationPayloadDigest, frameDigest };
}

export function encodeDecisionRowProjection(row: JsonRecord): string {
  const determinismToken = determinismProjectionToken(row);
  if (determinismToken === null) throw new Error("invalid D8 projection source");
  return encodeDecisionRowProjectionCore(row, determinismToken);
}

function repositoryReceipt(value: unknown, sourceInputDigest: string): value is JsonRecord {
  return record(value) && exactKeys(value, RECEIPT_FIELDS) && nonEmptyString(value.id) &&
    Array.isArray(value.argv) && value.argv.length > 0 && value.argv.every(nonEmptyString) && nonEmptyString(value.version) &&
    value.exit_verdict === "pass" && sha256(value.summary_digest) && value.source_input_record_sha256 === sourceInputDigest;
}

export function validateDecisionProjection(value: JsonRecord): boolean {
  if (!gitObjectId(value.base_sha) || !IDENTITY_FIELDS.every((field) => sha256(value[field])) ||
    !DIGEST_FIELDS.every((field) => sha256(value[field])) || !COMPLETENESS_FIELDS.every((field) => value[field] === "pass") ||
    value.macos_target_identity !== "aarch64-apple-darwin" || value.linux_target_identity !== "x86_64-unknown-linux-gnu" ||
    !sha256(value.source_input_record_sha256) || !Array.isArray(value.platforms) || !exactJson(value.platforms, ["macos", "linux"]) ||
    !Array.isArray(value.rows) || !Array.isArray(value.gates) || value.gates.length === 0 ||
    !value.gates.every((receipt) => repositoryReceipt(receipt, value.source_input_record_sha256))) return false;
  const rows = value.rows.map(decodeDecisionRow);
  if (rows.some((row) => row === null)) return false;
  const receiptIds = value.gates.map((receipt) => (receipt as JsonRecord).id);
  if (new Set(receiptIds).size !== receiptIds.length) return false;
  if (value.run_status !== "valid_complete") return true;
  const completeRows = rows as DecodedRow[];
  if (completeRows.length !== 348 || new Set(completeRows.map((row) => `${row.platform}/${row.rowId}`)).size !== 348 ||
    new Set(completeRows.map((row) => row.observationId)).size !== 348 ||
    new Set(completeRows.map((row) => row.generationPayloadDigest)).size !== 348 ||
    new Set(completeRows.map((row) => row.frameDigest)).size !== 348) return false;
  const aggregate = completeRows.every((row) => row.rowVerdict === "pass") ? "accepted" : "rejected";
  return value.terminal_decision === aggregate;
}
