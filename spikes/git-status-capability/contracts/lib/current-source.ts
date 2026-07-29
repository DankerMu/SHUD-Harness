import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  CONTRACT_METADATA, SOURCE_MANIFEST, SOURCE_METADATA_PROFILE, SYNTHETIC_FRAME, SYNTHETIC_SIDECAR
} from "./constants";
import { ContractError } from "./ingress";
import { validateContractMetadata } from "./schemas";
import { validateSyntheticOracle } from "./source-frame";

const MANDATORY_ORACLE_PATHS = Object.freeze([CONTRACT_METADATA, SYNTHETIC_FRAME, SYNTHETIC_SIDECAR]);

function fail(): never {
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function bytesCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\r") || path.includes("\n") || path.includes("\\") ||
      path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function inside(root: string, path: string): boolean {
  const candidate = resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

type DescriptorAdmissionHook = (absolutePath: string) => void | Promise<void>;

async function readDeclaredFile(
  root: string,
  relativePath: string,
  maximum: number,
  afterAdmission?: DescriptorAdmissionHook
): Promise<Uint8Array> {
  if (!canonicalRelativePath(relativePath) || !inside(root, relativePath)) fail();
  const absolutePath = join(root, relativePath);
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let admitted = await lstat(root);
    let current = root;
    const parts = relativePath.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      admitted = await lstat(current);
      if (admitted.isSymbolicLink()) fail();
      if (index < parts.length - 1 && !admitted.isDirectory()) fail();
    }
    if (!admitted.isFile() || admitted.isSymbolicLink()) fail();
    await afterAdmission?.(absolutePath);
    descriptor = await open(absolutePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = await descriptor.stat();
    if (!opened.isFile() || opened.dev !== admitted.dev || opened.ino !== admitted.ino) fail();
    if (opened.size > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await descriptor.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new ContractError("CONTRACT_BYTES_LIMIT");
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof ContractError) throw error;
    fail();
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

function parseManifest(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.slice(0, -1).includes("\n\n")) fail();
  const paths = text.slice(0, -1).split("\n");
  if (!paths.length || paths.some((path) => !canonicalRelativePath(path))) fail();
  for (let index = 1; index < paths.length; index += 1) {
    if (bytesCompare(paths[index - 1]!, paths[index]!) >= 0) fail();
  }
  for (const mandatory of MANDATORY_ORACLE_PATHS) {
    if (!paths.includes(mandatory)) fail();
  }
  return paths;
}

async function checkCurrentSourceOracleWithHook(
  repositoryRoot: string,
  manifest: string,
  afterAdmission?: DescriptorAdmissionHook
): Promise<void> {
  const root = resolve(repositoryRoot);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail();
  if (manifest !== SOURCE_MANIFEST || isAbsolute(manifest) || !inside(root, manifest)) fail();

  const manifestBytes = await readDeclaredFile(root, manifest, SOURCE_METADATA_PROFILE.bytes, afterAdmission);
  parseManifest(manifestBytes);
  const metadata = await readDeclaredFile(root, CONTRACT_METADATA, SOURCE_METADATA_PROFILE.bytes, afterAdmission);
  const frame = await readDeclaredFile(root, SYNTHETIC_FRAME, SOURCE_METADATA_PROFILE.bytes, afterAdmission);
  const sidecar = await readDeclaredFile(root, SYNTHETIC_SIDECAR, SOURCE_METADATA_PROFILE.bytes, afterAdmission);
  validateContractMetadata(metadata);
  validateSyntheticOracle(frame, sidecar);
}

/** Validate only the declared manifest and committed source-contract oracle. */
export async function checkCurrentSourceOracle(repositoryRoot: string, manifest: string): Promise<void> {
  await checkCurrentSourceOracleWithHook(repositoryRoot, manifest);
}

/** Descriptor-replacement seam for contract tests; it adds no repository snapshot semantics. */
export async function checkCurrentSourceOracleForTest(
  repositoryRoot: string,
  manifest: string,
  afterAdmission: DescriptorAdmissionHook
): Promise<void> {
  await checkCurrentSourceOracleWithHook(repositoryRoot, manifest, afterAdmission);
}
