import { CATALOG_V1, CONTROL_ASSERTION_IDS, DECISION_LIMIT_TOKENS, DECISION_ROW_SEGMENTS, REJECTION_CODES } from "./frozen";
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
  return JSON.stringify(left) === JSON.stringify(right);
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
    protectionSetEqual, cleanupVerdict, declaredLimitToken, boundaryToken, determinismToken] = fields;
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
  if (!exactJson(expectedOutcome, frozenExpected) || producingBoundary !== catalog?.producing_boundary ||
    limitOrdinal !== frozenLimitOrdinal || boundaryClass !== frozenBoundary || protectionPassed !== (protectionSetEqual === "1") ||
    (cleanupFailureIsEvidence ? !(cleanupPassed && cleanupVerdict === "f") : cleanupPassed !== (cleanupVerdict === "p")) ||
    ((rowVerdict === "pass") !== (exactJson(expectedOutcome, observedOutcome) && controlsPassed))) return null;
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
