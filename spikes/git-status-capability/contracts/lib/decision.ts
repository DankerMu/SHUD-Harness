import { createHash } from "node:crypto";
import {
  CATALOG_V1,
  COMPLETENESS_FIELDS,
  CONTROL_ASSERTION_IDS,
  D9_COMMAND_PROFILE,
  DECISION_LIMIT_TOKENS,
  DECISION_ROW_SEGMENTS,
  INVALIDITY_CODES,
  REJECTION_CODES
} from "./frozen";
import { validateFailureCauseTag } from "./causal-proof";
import { determinismProjectionToken } from "./determinism-proof";
import { encodeDecisionRowProjectionCore } from "./row-projection";

type JsonRecord = Record<string, any>;

const IDENTITY_FIELDS = Object.freeze([
  "fixture_identity", "oracle_identity", "frame_identity", "runner_identity", "validator_identity", "tripwire_identity",
  "macos_toolchain_identity", "linux_toolchain_identity"
]);

const DIGEST_FIELDS = Object.freeze([
  "lockfile_digest", "direct_feature_digest", "macos_target_graph_digest", "linux_target_graph_digest",
  "call_ledger_digest", "sbom_digest", "license_inventory_digest"
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
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((item, index) => exactJson(item, right[index]));
  if (record(left) || record(right)) {
    if (!record(left) || !record(right) || !exactKeys(left, Object.keys(right))) return false;
    return Object.keys(right).every((key) => exactJson(left[key], right[key]));
  }
  return false;
}

function digestJson(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : record(item)
    ? Object.fromEntries(Object.keys(item).sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).map((key) => [key, canonical(item[key])]))
    : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const COMPLETENESS_CODES = Object.freeze(Object.fromEntries(COMPLETENESS_FIELDS.map((field) => [
  field, `SUPPLY_${field.replace("_completeness_verdict", "").toUpperCase()}_INCOMPLETE`
])) as Record<string, string>);

export type InvalidStateInput = {
  completeness: Record<string, unknown>;
  gates: unknown[];
  coverage: { macos_rows: number; linux_rows: number };
  invalidity_receipts?: unknown[];
  source_input_record_sha256?: string;
};

function invalidityReceipt(value: unknown, sourceRecordSha?: string): value is JsonRecord {
  return record(value) && exactKeys(value, ["schema_version", "code", "subject_sha256", "summary_digest", "source_input_record_sha256"]) &&
    value.schema_version === "shud.git-status-capability.invalidity-receipt.v1" &&
    INVALIDITY_CODES.includes(value.code as any) && sha256(value.subject_sha256) && sha256(value.summary_digest) &&
    sha256(value.source_input_record_sha256) && (!sourceRecordSha || value.source_input_record_sha256 === sourceRecordSha);
}

function gateFailureId(value: unknown, ordinal: number): string | null {
  if (typeof value === "string") return decodeDecisionGateProjection(value, ordinal)?.verdict === "fail"
    ? D9_COMMAND_PROFILE[ordinal]!.id : null;
  if (!record(value)) return null;
  return value.id === D9_COMMAND_PROFILE[ordinal]?.id &&
    ((value.exit_code !== undefined && value.exit_code !== 0) || value.exit_verdict === "fail")
    ? value.id as string : null;
}

export function deriveInvalidState(input: InvalidStateInput): { first_cause: string; all_failure_codes: string[] } | null {
  if (!record(input.completeness) || !exactKeys(input.completeness, COMPLETENESS_FIELDS) ||
    !COMPLETENESS_FIELDS.every((field) => ["pass", "fail"].includes(input.completeness[field] as string)) ||
    !Array.isArray(input.gates) || input.gates.length !== D9_COMMAND_PROFILE.length ||
    !record(input.coverage) || !exactKeys(input.coverage, ["macos_rows", "linux_rows"]) ||
    !Number.isSafeInteger(input.coverage.macos_rows) || !Number.isSafeInteger(input.coverage.linux_rows) ||
    input.coverage.macos_rows < 0 || input.coverage.macos_rows > 174 || input.coverage.linux_rows < 0 || input.coverage.linux_rows > 174 ||
    !Array.isArray(input.invalidity_receipts ?? []) || !(input.invalidity_receipts ?? []).every((receipt) => invalidityReceipt(receipt, input.source_input_record_sha256))) return null;
  const precedence: string[] = [];
  for (const code of INVALIDITY_CODES) if ((input.invalidity_receipts ?? []).some((receipt) => (receipt as JsonRecord).code === code)) precedence.push(code);
  for (const field of COMPLETENESS_FIELDS) if (input.completeness[field] === "fail") precedence.push(COMPLETENESS_CODES[field]!);
  for (let index = 0; index < D9_COMMAND_PROFILE.length; index += 1) {
    const id = gateFailureId(input.gates[index], index);
    if (id) precedence.push(`D9_${id.replaceAll("-", "_")}_FAILED`);
  }
  if (input.coverage.macos_rows !== 174) precedence.push("COVERAGE_MACOS_INCOMPLETE");
  if (input.coverage.linux_rows !== 174) precedence.push("COVERAGE_LINUX_INCOMPLETE");
  if (precedence.length === 0) return null;
  return { first_cause: precedence[0]!, all_failure_codes: [...new Set(precedence)].sort() };
}

type DecodedGate = { verdict: "pass" | "fail"; summaryDigest: string };

export function encodeDecisionGateProjection(receipt: JsonRecord, ordinal: number): string {
  const profile = D9_COMMAND_PROFILE[ordinal];
  if (!profile || !record(receipt) || !exactKeys(receipt, ["id", "argv", "version", "exit_code", "stdout_summary", "stderr_summary", "summary_digest", "source_input_record_sha256"]) ||
    receipt.id !== profile.id || !exactJson(receipt.argv, profile.argv) ||
    receipt.version !== profile.version || !Number.isSafeInteger(receipt.exit_code) || (receipt.exit_code as number) < 0 ||
    typeof receipt.stdout_summary !== "string" || typeof receipt.stderr_summary !== "string" ||
    Buffer.byteLength(receipt.stdout_summary) > 4096 || Buffer.byteLength(receipt.stderr_summary) > 4096 ||
    receipt.summary_digest !== digestJson({ stdout_summary: receipt.stdout_summary, stderr_summary: receipt.stderr_summary }) ||
    !sha256(receipt.source_input_record_sha256)) throw new Error("invalid D9 receipt");
  return [String(ordinal).padStart(2, "0"), digestJson(profile.argv), profile.version,
    receipt.exit_code === 0 ? "p" : "f", receipt.summary_digest].join("\0");
}

export function decodeDecisionGateProjection(value: unknown, ordinal: number): DecodedGate | null {
  if (typeof value !== "string") return null;
  const profile = D9_COMMAND_PROFILE[ordinal];
  const fields = value.split("\0");
  if (!profile || fields.length !== 5 || fields[0] !== String(ordinal).padStart(2, "0") ||
    fields[1] !== digestJson(profile.argv) || fields[2] !== profile.version || !["p", "f"].includes(fields[3]!) ||
    !sha256(fields[4])) return null;
  return { verdict: fields[3] === "p" ? "pass" : "fail", summaryDigest: fields[4]! };
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
  const nonLimLauncherCounter = limitOrdinal >= 9 && limitOrdinal <= 13;
  if (!platform || !nonEmptyString(rowId) || !expectedOutcome || !observedOutcome || !rowVerdict || !sha256(observationId) ||
    !sha256(generationPayloadDigest) || !sha256(frameDigest) || !producingBoundary || activeControls !== ALL_CONTROL_TOKEN ||
    passedControlBits < 0 || (passedControlBits & ~ALL_CONTROL_BITS) !== 0 || !["0", "1"].includes(protectionSetEqual!) ||
    !["p", "f"].includes(cleanupVerdict!) || !declaredLimit || !boundaryClass || determinismToken !== expectedDeterminismToken ||
    (declaredLimit === "none" ? boundaryClass !== "below" : boundaryClass === "below" && !nonLimLauncherCounter)) return null;
  const catalog = CATALOG_V1.find((row) => row.id === rowId);
  const frozenExpected = platform === "macos" ? catalog?.macos_expected : catalog?.linux_expected;
  const limitMatch = /^LIM-(\d{3})$/.exec(rowId);
  const frozenLimitOrdinal = limitMatch ? Math.floor((Number(limitMatch[1]) - 1) / 2) + 1 : 0;
  const frozenBoundary = limitMatch ? Number(limitMatch[1]) % 2 === 1 ? "exact" : "exceeded" : "below";
  const protectionPassed = (passedControlBits & (1 << CONTROL_ASSERTION_IDS.indexOf("protection"))) !== 0;
  const cleanupPassed = (passedControlBits & (1 << CONTROL_ASSERTION_IDS.indexOf("cleanup"))) !== 0;
  const controlsPassed = passedControlBits === ALL_CONTROL_BITS;
  const cleanupFailureIsEvidence = rowId === "LIF-006" || rowId === "LIF-007" ||
    (failureCauseToken === "u" && cleanupVerdict === "f");
  const nonLimWithinLimit = !limitMatch && ((limitOrdinal === 0 && boundaryClass === "below") ||
    (limitOrdinal >= 9 && limitOrdinal <= 13 && ["below", "exact"].includes(boundaryClass)));
  const actualMatchesExpected = producingBoundary === catalog?.producing_boundary &&
    (limitMatch ? limitOrdinal === frozenLimitOrdinal && boundaryClass === frozenBoundary : nonLimWithinLimit);
  const failureCauseValid = validateFailureCauseTag(failureCauseToken!, {
    platform, rowVerdict, expectedOutcome, observedOutcome, producingBoundary, rowId: rowId!, observationId: observationId!,
    suppliedInputDigest: frameDigest!, declaredLimit, boundaryClass, passedControlBits,
    cleanupVerdict: cleanupVerdict === "p" ? "pass" : "fail"
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

export function validateDecisionProjection(value: JsonRecord): boolean {
  if (!gitObjectId(value.base_sha) || !IDENTITY_FIELDS.every((field) => sha256(value[field])) ||
    !DIGEST_FIELDS.every((field) => sha256(value[field])) || !COMPLETENESS_FIELDS.every((field) => ["pass", "fail"].includes(value[field] as string)) ||
    value.macos_target_identity !== "aarch64-apple-darwin" || value.linux_target_identity !== "x86_64-unknown-linux-gnu" ||
    !sha256(value.source_input_record_sha256) || !Array.isArray(value.platforms) || !exactJson(value.platforms, ["macos", "linux"]) ||
    !Array.isArray(value.rows) || !Array.isArray(value.gates) || value.gates.length !== D9_COMMAND_PROFILE.length ||
    !value.gates.every((gate, ordinal) => decodeDecisionGateProjection(gate, ordinal) !== null)) return false;
  const rows = value.rows.map(decodeDecisionRow);
  if (rows.some((row) => row === null)) return false;
  const decodedRows = rows as DecodedRow[];
  if (new Set(decodedRows.map((row) => `${row.platform}/${row.rowId}`)).size !== decodedRows.length ||
    new Set(decodedRows.map((row) => row.observationId)).size !== decodedRows.length ||
    new Set(decodedRows.map((row) => row.generationPayloadDigest)).size !== decodedRows.length ||
    new Set(decodedRows.map((row) => row.frameDigest)).size !== decodedRows.length) return false;
  const invalidityReceipts = value.invalidity_receipts ?? [];
  if (!Array.isArray(invalidityReceipts) || !invalidityReceipts.every((receipt) => invalidityReceipt(receipt, value.source_input_record_sha256))) return false;
  if (value.run_status === "invalid") {
    const state = deriveInvalidState({
      completeness: Object.fromEntries(COMPLETENESS_FIELDS.map((field) => [field, value[field]])),
      gates: value.gates,
      coverage: {
        macos_rows: decodedRows.filter((row) => row.platform === "macos").length,
        linux_rows: decodedRows.filter((row) => row.platform === "linux").length
      },
      invalidity_receipts: invalidityReceipts,
      source_input_record_sha256: value.source_input_record_sha256
    });
    return !!state && value.first_cause === state.first_cause && exactJson(value.all_failure_codes, state.all_failure_codes);
  }
  if (value.run_status !== "valid_complete" || invalidityReceipts.length !== 0 ||
    !COMPLETENESS_FIELDS.every((field) => value[field] === "pass") ||
    !value.gates.every((gate, ordinal) => decodeDecisionGateProjection(gate, ordinal)?.verdict === "pass")) return false;
  const completeRows = decodedRows;
  if (completeRows.length !== 348 || new Set(completeRows.map((row) => `${row.platform}/${row.rowId}`)).size !== 348 ||
    new Set(completeRows.map((row) => row.observationId)).size !== 348 ||
    new Set(completeRows.map((row) => row.generationPayloadDigest)).size !== 348 ||
    new Set(completeRows.map((row) => row.frameDigest)).size !== 348) return false;
  const aggregate = completeRows.every((row) => row.rowVerdict === "pass") ? "accepted" : "rejected";
  return value.terminal_decision === aggregate;
}
