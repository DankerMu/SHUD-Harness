import { posix } from "node:path";

type JsonRecord = Record<string, unknown>;

const SOURCE_COMMAND_ARGV = [
  "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", "<SOURCE_SHA>",
  "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
  "--witness", "source-input-witness-v1", "--record", "<EXTERNAL_EVIDENCE_ROOT>/source-input-record.json", "--create"
] as const;

const SOURCE_RECORD_KEYS = [
  "schema_version", "source_sha", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths",
  "admitted_modes", "primary_encoder", "primary_result", "witness_encoder", "witness_result", "command_receipt"
] as const;
const ENCODER_RESULT_KEYS = [
  "status", "source_input_digest_matches", "manifest_digest_matches", "entry_count_matches", "admitted_set_matches"
] as const;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function canonicalRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") && posix.normalize(value) === value;
}

function encoderResult(value: unknown): boolean {
  return record(value) && exactKeys(value, ENCODER_RESULT_KEYS) && value.status === "ok" &&
    value.source_input_digest_matches === true && value.manifest_digest_matches === true &&
    value.entry_count_matches === true && value.admitted_set_matches === true;
}

function commandReceipt(value: unknown): boolean {
  return record(value) && exactKeys(value, ["argv", "version", "exit_code"]) &&
    exactStrings(value.argv, SOURCE_COMMAND_ARGV) && value.version === "1" && value.exit_code === 0;
}

export function validateSourceInputRecord(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, SOURCE_RECORD_KEYS) ||
      value.schema_version !== "shud.git-status-capability.source-input-record.v1") return false;
  if (!gitObjectId(value.source_sha) || !sha256(value.source_input_digest) || !sha256(value.manifest_digest)) return false;
  if (!Number.isSafeInteger(value.entry_count) || (value.entry_count as number) < 0 ||
      !Array.isArray(value.admitted_paths) || !Array.isArray(value.admitted_modes) ||
      value.admitted_paths.length !== value.entry_count || value.admitted_modes.length !== value.entry_count) return false;
  if (!value.admitted_paths.every(canonicalRelativePath) ||
      !value.admitted_modes.every((mode) => mode === "100644" || mode === "100755")) return false;
  const paths = value.admitted_paths as string[];
  if (new Set(paths).size !== paths.length) return false;
  const sorted = [...paths].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
  if (!exactStrings(paths, sorted)) return false;
  return value.primary_encoder === "source-input-primary-v1" && value.witness_encoder === "source-input-witness-v1" &&
    encoderResult(value.primary_result) && encoderResult(value.witness_result) && commandReceipt(value.command_receipt);
}
