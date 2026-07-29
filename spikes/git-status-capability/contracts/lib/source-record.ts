import { posix } from "node:path";
import { canonicalEqual } from "./canonical-json";

type JsonRecord = Record<string, unknown>;

const SOURCE_RECORD_KEYS = [
  "schema_version", "source_sha", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths",
  "admitted_modes", "primary_encoder", "primary_result", "witness_encoder", "witness_result", "command_receipt"
] as const;
const ENCODER_RESULT_KEYS = [
  "status", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths", "admitted_modes"
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

function admittedSet(value: JsonRecord): boolean {
  if (!Number.isSafeInteger(value.entry_count) || (value.entry_count as number) < 0 ||
      !Array.isArray(value.admitted_paths) || !Array.isArray(value.admitted_modes) ||
      value.admitted_paths.length !== value.entry_count || value.admitted_modes.length !== value.entry_count) return false;
  if (!value.admitted_paths.every(canonicalRelativePath) ||
      !value.admitted_modes.every((mode) => mode === "100644" || mode === "100755")) return false;
  const paths = value.admitted_paths as string[];
  const sorted = [...paths].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
  return new Set(paths).size === paths.length && exactStrings(paths, sorted);
}

function encoderResult(value: unknown): value is JsonRecord {
  return record(value) && exactKeys(value, ENCODER_RESULT_KEYS) && value.status === "ok" &&
    sha256(value.source_input_digest) && sha256(value.manifest_digest) && admittedSet(value);
}

function canonicalExternalRecordPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.includes("\\") || /[<>]/.test(value)) return false;
  const parts = value.split("/");
  return parts.at(-1) === "source-input-record.json" && parts.slice(1).every((part) => part !== "" && part !== "." && part !== "..") && posix.normalize(value) === value;
}

function commandReceipt(value: unknown, sourceSha: string): boolean {
  if (!record(value) || !exactKeys(value, ["argv", "version", "exit_code"]) || !Array.isArray(value.argv)) return false;
  const argv = value.argv;
  return argv.length === 15 && exactStrings(argv.slice(0, 5), [
    "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha"
  ]) && argv[5] === sourceSha && exactStrings(argv.slice(6, 14), [
    "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
    "--witness", "source-input-witness-v1", "--record", argv[13] as string
  ]) && canonicalExternalRecordPath(argv[13]) && argv[14] === "--create" &&
    value.version === "1" && value.exit_code === 0;
}

export function validateSourceInputRecord(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, SOURCE_RECORD_KEYS) ||
      value.schema_version !== "shud.git-status-capability.source-input-record.v1") return false;
  if (!gitObjectId(value.source_sha) || !sha256(value.source_input_digest) || !sha256(value.manifest_digest)) return false;
  if (!admittedSet(value) || !encoderResult(value.primary_result) || !encoderResult(value.witness_result)) return false;
  const topLevel = [value.source_input_digest, value.manifest_digest, value.entry_count, value.admitted_paths, value.admitted_modes];
  const primary = [value.primary_result.source_input_digest, value.primary_result.manifest_digest, value.primary_result.entry_count,
    value.primary_result.admitted_paths, value.primary_result.admitted_modes];
  const witness = [value.witness_result.source_input_digest, value.witness_result.manifest_digest, value.witness_result.entry_count,
    value.witness_result.admitted_paths, value.witness_result.admitted_modes];
  return value.primary_encoder === "source-input-primary-v1" && value.witness_encoder === "source-input-witness-v1" &&
    canonicalEqual(primary, topLevel) && canonicalEqual(witness, topLevel) && commandReceipt(value.command_receipt, value.source_sha as string);
}
