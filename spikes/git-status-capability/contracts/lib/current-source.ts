import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONTRACT_METADATA, SOURCE_MANIFEST, SOURCE_METADATA_PROFILE, SYNTHETIC_FRAME, SYNTHETIC_SIDECAR
} from "./constants";
import { ContractError, readBoundedFile } from "./ingress";
import { validateContractMetadata } from "./schemas";
import { validateSyntheticOracle } from "./source-frame";

type IndexEntry = Readonly<{ path: string; mode: "100644" | "100755"; objectId: string }>;
type GitDirectories = Readonly<{ worktree: string; common: string }>;

const GITFILE_BYTES = 4_096;
const COMMONDIR_BYTES = 1_024;
const GIT_CONFIG_BYTES = 1_048_576;

function fail(): never {
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function bytesCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function inside(root: string, path: string): boolean {
  const candidate = resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isCandidate(path: string): boolean {
  if (path.startsWith("spikes/git-status-capability/")) return true;
  if (path === ".github/workflows/git-status-capability-spike.yml") return true;
  const prefix = "openspec/changes/m2-capability-observer-spike/";
  if (!path.startsWith(prefix)) return false;
  const local = path.slice(prefix.length);
  return local === ".openspec.yaml" || local === "proposal.md" || local === "design.md" || local === "tasks.md" ||
    (local.startsWith("specs/") && local.endsWith("/spec.md"));
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}

async function admittedDirectory(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail();
  return path;
}

async function gitDirectories(root: string): Promise<GitDirectories> {
  const path = join(root, ".git");
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) fail();
  if (stat.isDirectory()) return { worktree: path, common: path };
  if (!stat.isFile()) fail();

  const gitfile = strictUtf8(await readBoundedFile(path, GITFILE_BYTES));
  const match = /^gitdir: ([^\r\n\0]+)\n$/.exec(gitfile);
  if (!match) fail();
  const declared = match[1]!;
  if (!isAbsolute(declared) || resolve(declared) !== declared || declared.includes("\\")) fail();
  const worktree = await admittedDirectory(declared);

  const commondir = strictUtf8(await readBoundedFile(join(worktree, "commondir"), COMMONDIR_BYTES));
  if (commondir !== "../..\n") fail();
  const common = await admittedDirectory(resolve(worktree, "../.."));
  if (dirname(dirname(worktree)) !== common || dirname(worktree) !== join(common, "worktrees")) fail();
  const backlink = strictUtf8(await readBoundedFile(join(worktree, "gitdir"), GITFILE_BYTES));
  const backlinkMatch = /^([^\r\n\0]+)\n$/.exec(backlink);
  if (!backlinkMatch) fail();
  const backlinkPath = backlinkMatch[1]!;
  if (!isAbsolute(backlinkPath) || resolve(backlinkPath) !== backlinkPath || backlinkPath.includes("\\")) fail();
  const backlinkStat = await lstat(backlinkPath).catch(() => undefined);
  if (!backlinkStat?.isFile() || backlinkStat.isSymbolicLink() || backlinkStat.dev !== stat.dev || backlinkStat.ino !== stat.ino) fail();
  return { worktree, common };
}

async function objectFormat(gitDir: string): Promise<"sha1" | "sha256"> {
  const config = strictUtf8(await readBoundedFile(join(gitDir, "config"), GIT_CONFIG_BYTES));
  return /^\s*objectFormat\s*=\s*sha256\s*$/im.test(config) ? "sha256" : "sha1";
}

async function readIndex(gitDir: string, algorithm: "sha1" | "sha256"): Promise<IndexEntry[]> {
  const oidLength = algorithm === "sha256" ? 32 : 20;
  const bytes = Buffer.from(await readBoundedFile(join(gitDir, "index"), 20 * 1024 * 1024));
  if (bytes.length < 12 + oidLength || bytes.toString("ascii", 0, 4) !== "DIRC") fail();
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) fail();
  const expectedChecksum = bytes.subarray(bytes.length - oidLength);
  const actualChecksum = createHash(algorithm).update(bytes.subarray(0, -oidLength)).digest();
  if (!actualChecksum.equals(expectedChecksum)) fail();
  const count = bytes.readUInt32BE(8);
  const entries: IndexEntry[] = [];
  let cursor = 12;
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const fixed = 40 + oidLength + 2;
    if (cursor + fixed > bytes.length - oidLength) fail();
    const rawMode = bytes.readUInt32BE(cursor + 24);
    const objectId = bytes.subarray(cursor + 40, cursor + 40 + oidLength).toString("hex");
    const flags = bytes.readUInt16BE(cursor + 40 + oidLength);
    if (((flags >>> 12) & 3) !== 0) fail();
    cursor += fixed;
    if (version === 3 && (flags & 0x4000) !== 0) {
      if (cursor + 2 > bytes.length - oidLength) fail();
      cursor += 2;
    }
    const nul = bytes.indexOf(0, cursor);
    if (nul < 0 || nul >= bytes.length - oidLength) fail();
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor, nul));
    } catch {
      fail();
    }
    if (!canonicalRelativePath(path)) fail();
    cursor = start + Math.ceil((nul + 1 - start) / 8) * 8;
    const mode = rawMode === 0o100644 ? "100644" : rawMode === 0o100755 ? "100755" : undefined;
    if (isCandidate(path) && !mode) fail();
    if (isCandidate(path)) entries.push({ path, mode: mode!, objectId });
  }
  entries.sort((left, right) => bytesCompare(left.path, right.path));
  for (let index = 1; index < entries.length; index += 1) if (entries[index - 1]!.path === entries[index]!.path) fail();
  return entries;
}

async function filesystemSpikePaths(root: string): Promise<string[]> {
  const spikeRoot = join(root, "spikes", "git-status-capability");
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail());
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const local = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(local);
      else fail();
    }
  }
  await walk(spikeRoot);
  return result.sort(bytesCompare);
}

async function manifestPaths(root: string, manifest: string): Promise<string[]> {
  if (manifest !== SOURCE_MANIFEST || isAbsolute(manifest) || !inside(root, manifest)) fail();
  const bytes = await readBoundedFile(join(root, manifest), SOURCE_METADATA_PROFILE.bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError("CONTRACT_UTF8_INVALID");
  }
  if (!text.endsWith("\n") || text.includes("\r") || text.slice(0, -1).includes("\n\n")) fail();
  const paths = text.slice(0, -1).split("\n");
  if (!paths.length || paths.some((path) => !canonicalRelativePath(path))) fail();
  for (let index = 1; index < paths.length; index += 1) if (bytesCompare(paths[index - 1]!, paths[index]!) >= 0) fail();
  return paths;
}

async function verifyWorktreeEntry(root: string, entry: IndexEntry, algorithm: "sha1" | "sha256"): Promise<void> {
  const absolute = join(root, entry.path);
  if (!inside(root, entry.path)) fail();
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail();
  const mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
  if (mode !== entry.mode) fail();
  const bytes = await readFile(absolute);
  const header = Buffer.from(`blob ${bytes.length}\0`, "ascii");
  if (createHash(algorithm).update(header).update(bytes).digest("hex") !== entry.objectId) fail();
}

export async function checkCurrentSourceAuthority(repositoryRoot: string, manifest: string): Promise<void> {
  const root = resolve(repositoryRoot);
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail();
  const gitDirs = await gitDirectories(root);
  const algorithm = await objectFormat(gitDirs.common);
  const tracked = await readIndex(gitDirs.worktree, algorithm);
  const declared = await manifestPaths(root, manifest);
  const trackedPaths = tracked.map((entry) => entry.path);
  if (!canonicalEqualStrings(declared, trackedPaths)) fail();
  const worktreeSpike = await filesystemSpikePaths(root);
  const trackedSpike = trackedPaths.filter((path) => path.startsWith("spikes/git-status-capability/"));
  if (!canonicalEqualStrings(worktreeSpike, trackedSpike)) fail();
  for (const entry of tracked) await verifyWorktreeEntry(root, entry, algorithm);
  validateContractMetadata(await readBoundedFile(join(root, CONTRACT_METADATA), SOURCE_METADATA_PROFILE.bytes));
  validateSyntheticOracle(
    await readBoundedFile(join(root, SYNTHETIC_FRAME), SOURCE_METADATA_PROFILE.bytes),
    await readBoundedFile(join(root, SYNTHETIC_SIDECAR), SOURCE_METADATA_PROFILE.bytes)
  );
}

function canonicalEqualStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
