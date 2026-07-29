import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json";
import { validateCommandProfile } from "./command-profile";
import { SUPPLY_IDENTITY } from "./frozen";
import { ContractError } from "./ingestion";
import {
  captureNoSymlinkPath, runPathSafetyTestInterlock, verifyNoSymlinkPath, verifyOpenedRegularFile, type SafePathSnapshot
} from "./path-safety";
import { validateSourceInputRecord } from "./source-record";

type JsonRecord = Record<string, unknown>;

export type ActualSupply = {
  lockfile_digest: string;
  rust_toolchain_digest: string;
};

export type SupplyFiles = ActualSupply & {
  lockfile: Buffer;
  rust_toolchain: Buffer;
};

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

function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

export function validatePlatformToolchain(value: unknown, platform: "macos" | "linux"): value is JsonRecord {
  if (!record(value)) return false;
  const toolchainKeys = [
    "rust_release", "rust_commit", "rust_host", "rust_target", "cargo_cli_release", "cargo_commit",
    "cargo_package_version", "git_version"
  ];
  if (!exactKeys(value, toolchainKeys)) return false;
  const target = SUPPLY_IDENTITY.targets[platform];
  return value.rust_release === SUPPLY_IDENTITY.rust_release && value.rust_commit === SUPPLY_IDENTITY.rust_commit &&
    value.rust_host === target && value.rust_target === target && value.cargo_cli_release === SUPPLY_IDENTITY.cargo_cli_release &&
    value.cargo_commit === SUPPLY_IDENTITY.cargo_commit && value.cargo_package_version === SUPPLY_IDENTITY.cargo_package_version &&
    value.git_version === SUPPLY_IDENTITY.git_version;
}

function validatePlatform(value: unknown, platform: "macos" | "linux"): value is JsonRecord {
  const keys = ["schema_version", "platform", "source_commit", "lockfile_digest", "rust_toolchain_digest", "toolchain"];
  return record(value) && exactKeys(value, keys) && value.schema_version === "shud.git-status-capability.platform-authority.v1" &&
    value.platform === platform && gitObjectId(value.source_commit) && sha256(value.lockfile_digest) &&
    sha256(value.rust_toolchain_digest) && validatePlatformToolchain(value.toolchain, platform);
}

export function validateDecisionToolchain(value: unknown): value is JsonRecord {
  if (!record(value)) return false;
  const toolchainKeys = [
    "rust_release", "rust_commit", "rust_hosts", "rust_targets", "cargo_cli_release", "cargo_commit",
    "cargo_package_version", "git_version"
  ];
  if (!exactKeys(value, toolchainKeys) || !record(value.rust_hosts) || !record(value.rust_targets)) return false;
  if (!exactKeys(value.rust_hosts, ["macos", "linux"]) || !exactKeys(value.rust_targets, ["macos", "linux"])) return false;
  return value.rust_release === SUPPLY_IDENTITY.rust_release && value.rust_commit === SUPPLY_IDENTITY.rust_commit &&
    value.rust_hosts.macos === SUPPLY_IDENTITY.targets.macos && value.rust_hosts.linux === SUPPLY_IDENTITY.targets.linux &&
    value.rust_targets.macos === SUPPLY_IDENTITY.targets.macos && value.rust_targets.linux === SUPPLY_IDENTITY.targets.linux &&
    value.cargo_cli_release === SUPPLY_IDENTITY.cargo_cli_release && value.cargo_commit === SUPPLY_IDENTITY.cargo_commit &&
    value.cargo_package_version === SUPPLY_IDENTITY.cargo_package_version && value.git_version === SUPPLY_IDENTITY.git_version;
}

function validateDecision(value: unknown): value is JsonRecord {
  const keys = ["schema_version", "base_sha", "lockfile_digest", "rust_toolchain_digest", "toolchain"];
  return record(value) && exactKeys(value, keys) && value.schema_version === "shud.git-status-capability.decision-authority.v1" &&
    gitObjectId(value.base_sha) && sha256(value.lockfile_digest) && sha256(value.rust_toolchain_digest) &&
    validateDecisionToolchain(value.toolchain);
}

export async function readRegularFileBounded(path: string, maximumBytes: number): Promise<Buffer> {
  let handle;
  let snapshot: SafePathSnapshot;
  try {
    snapshot = await captureNoSymlinkPath(path, "file");
    await runPathSafetyTestInterlock("after-capture", path);
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    await runPathSafetyTestInterlock("after-open", path);
    verifyOpenedRegularFile(snapshot, stat);
    if (stat.size > BigInt(maximumBytes)) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) throw new ContractError("CONTRACT_BYTES_LIMIT");
    await verifyNoSymlinkPath(snapshot);
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError("CONTRACT_SCHEMA_INVALID");
  } finally {
    await handle?.close();
  }
}

export async function readSupplyFiles(spikeRoot: string): Promise<SupplyFiles> {
  const [lockfile, toolchain] = await Promise.all([
    readRegularFileBounded(join(spikeRoot, "native", "Cargo.lock"), 2 * 1024 * 1024),
    readRegularFileBounded(join(spikeRoot, "native", "rust-toolchain.toml"), 4 * 1024)
  ]);
  return {
    lockfile_digest: createHash("sha256").update(lockfile).digest("hex"),
    rust_toolchain_digest: createHash("sha256").update(toolchain).digest("hex"),
    lockfile,
    rust_toolchain: toolchain
  };
}

export async function readActualSupply(spikeRoot: string): Promise<ActualSupply> {
  const { lockfile_digest, rust_toolchain_digest } = await readSupplyFiles(spikeRoot);
  return { lockfile_digest, rust_toolchain_digest };
}

export function validateAuthoritySet(value: unknown, actual: ActualSupply): boolean {
  if (!record(value) || !exactKeys(value, ["schema_version", "source_record", "platforms", "decision", "command_profile"])) return false;
  if (value.schema_version !== "shud.git-status-capability.authority-set.v1" || !validateSourceInputRecord(value.source_record)) return false;
  if (!record(value.platforms) || !exactKeys(value.platforms, ["macos", "linux"]) || !validatePlatform(value.platforms.macos, "macos") || !validatePlatform(value.platforms.linux, "linux") || !validateDecision(value.decision)) return false;
  const sourceRecord = value.source_record;
  const macos = value.platforms.macos;
  const linux = value.platforms.linux;
  const decision = value.decision;
  if (![sourceRecord.source_sha, macos.source_commit, linux.source_commit, decision.base_sha].every((identity) => identity === sourceRecord.source_sha)) return false;
  if (actual.lockfile_digest !== SUPPLY_IDENTITY.lockfile_digest || actual.rust_toolchain_digest !== SUPPLY_IDENTITY.rust_toolchain_digest) return false;
  if (![macos.lockfile_digest, linux.lockfile_digest, decision.lockfile_digest].every((digest) => digest === actual.lockfile_digest)) return false;
  if (![macos.rust_toolchain_digest, linux.rust_toolchain_digest, decision.rust_toolchain_digest].every((digest) => digest === actual.rust_toolchain_digest)) return false;
  if (!validateCommandProfile(value.command_profile)) return false;
  try { canonicalJson(value); } catch { return false; }
  return true;
}
