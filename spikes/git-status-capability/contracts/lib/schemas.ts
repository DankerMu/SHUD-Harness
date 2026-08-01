import { posix } from "node:path";
import { canonicalJson } from "./canonical-json";
import { SOURCE_PROFILE } from "./constants";
import { ContractError, parseBoundedJson } from "./ingress";

type JsonRecord = Record<string, unknown>;
export type SourceInputKind = "source_input_record" | "source_identity_projection";

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function gitObject(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function relativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\r") || value.includes("\n") ||
      value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..") && posix.normalize(value) === value;
}

function admittedSet(value: JsonRecord): boolean {
  if (!Number.isSafeInteger(value.entry_count) || (value.entry_count as number) < 0 ||
      !Array.isArray(value.admitted_paths) || !Array.isArray(value.admitted_modes) ||
      value.admitted_paths.length !== value.entry_count || value.admitted_modes.length !== value.entry_count) return false;
  if (!value.admitted_paths.every(relativePath) ||
      !value.admitted_modes.every((mode) => mode === "100644" || mode === "100755")) return false;
  const paths = value.admitted_paths as string[];
  const sorted = [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return new Set(paths).size === paths.length && paths.every((path, index) => path === sorted[index]);
}

const RESULT_KEYS = ["status", "source_input_digest", "manifest_digest", "entry_count"] as const;
function encoderResult(value: unknown): value is JsonRecord {
  return record(value) && exactKeys(value, RESULT_KEYS) && value.status === "ok" &&
    sha256(value.source_input_digest) && sha256(value.manifest_digest) &&
    Number.isSafeInteger(value.entry_count) && (value.entry_count as number) >= 0;
}

function commandReceipt(value: unknown, sourceSha: string): boolean {
  if (!record(value) || !exactKeys(value, ["argv", "version", "exit_code"]) || !Array.isArray(value.argv)) return false;
  const expected = [
    "spikes/git-status-capability/verify.sh", "source-input-digest", "--version", "1", "--source-sha", sourceSha,
    "--manifest", "spikes/git-status-capability/contracts/source-input-v1.paths", "--primary", "source-input-primary-v1",
    "--witness", "source-input-witness-v1", "--record"
  ];
  const recordPath = value.argv[13];
  const canonicalRecordPath = typeof recordPath === "string" && recordPath.startsWith("/") && !recordPath.includes("\0") &&
    !recordPath.includes("\\") && recordPath.split("/").slice(1).every((part) => part && part !== "." && part !== "..") &&
    recordPath.endsWith("/source-input-record.json");
  return value.argv.length === 15 &&
    expected.every((item, index) => Array.isArray(value.argv) && value.argv[index] === item) && canonicalRecordPath &&
    value.argv[14] === "--create" && value.version === "1" && value.exit_code === 0;
}

const SOURCE_KEYS = [
  "schema_version", "source_sha", "source_input_digest", "manifest_digest", "entry_count", "admitted_paths", "admitted_modes",
  "primary_encoder", "primary_result", "witness_encoder", "witness_result", "command_receipt"
] as const;

export function validateSourceInputRecord(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, SOURCE_KEYS) ||
      value.schema_version !== "shud.git-status-capability.source-input-record.v1" || !gitObject(value.source_sha) ||
      !sha256(value.source_input_digest) || !sha256(value.manifest_digest) || !admittedSet(value) ||
      !encoderResult(value.primary_result) || !encoderResult(value.witness_result)) return false;
  const expectedTuple = [value.source_input_digest, value.manifest_digest, value.entry_count];
  const primaryTuple = [
    value.primary_result.source_input_digest, value.primary_result.manifest_digest, value.primary_result.entry_count
  ];
  const witnessTuple = [
    value.witness_result.source_input_digest, value.witness_result.manifest_digest, value.witness_result.entry_count
  ];
  return value.primary_encoder === "source-input-primary-v1" && value.witness_encoder === "source-input-witness-v1" &&
    expectedTuple.every((item, index) => item === primaryTuple[index]) &&
    expectedTuple.every((item, index) => item === witnessTuple[index]) &&
    commandReceipt(value.command_receipt, value.source_sha as string);
}

export function validateSourceIdentityProjection(value: unknown): value is JsonRecord {
  if (!record(value) || !exactKeys(value, ["schema_version", "source_record", "platforms", "decision"]) ||
      value.schema_version !== "shud.git-status-capability.source-identity-projection.v1" || !record(value.source_record) ||
      !exactKeys(value.source_record, ["source_sha"]) || !gitObject(value.source_record.source_sha) ||
      !Array.isArray(value.platforms) || value.platforms.length !== 2 || !record(value.decision) ||
      !exactKeys(value.decision, ["base_sha"]) || !gitObject(value.decision.base_sha)) return false;
  const expectedPlatforms = ["macos", "linux"];
  for (let index = 0; index < 2; index += 1) {
    const platform = value.platforms[index];
    if (!record(platform) || !exactKeys(platform, ["platform", "source_commit"]) ||
        platform.platform !== expectedPlatforms[index] || !gitObject(platform.source_commit)) return false;
  }
  const peers = [
    value.source_record.source_sha,
    (value.platforms[0] as JsonRecord).source_commit,
    (value.platforms[1] as JsonRecord).source_commit,
    value.decision.base_sha
  ];
  return peers.every((peer) => peer === peers[0]);
}

export function admitSourceInput(kind: SourceInputKind, bytes: Uint8Array): Uint8Array {
  const value = parseBoundedJson(bytes, SOURCE_PROFILE);
  const valid = kind === "source_input_record" ? validateSourceInputRecord(value) : validateSourceIdentityProjection(value);
  if (!valid) throw new ContractError("CONTRACT_SCHEMA_INVALID");
  return new TextEncoder().encode(canonicalJson(value));
}
