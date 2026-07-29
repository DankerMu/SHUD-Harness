import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, stat as followStat } from "node:fs/promises";
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
const SPIKE_PREFIX = "spikes/git-status-capability/";
const WORKFLOW_PATH = ".github/workflows/git-status-capability-spike.yml";
const CHANGE_PREFIX = "openspec/changes/m2-capability-observer-spike/";
const INDEX_ENTRY_PATH_LENGTH_MASK = 0x0fff;
const INDEX_ENTRY_EXTENDED = 0x4000;
const INDEX_ENTRY_EXTENDED_FLAGS = 0x6000;
const MANDATORY_CHANGE_PATHS = Object.freeze([
  `${CHANGE_PREFIX}.openspec.yaml`,
  `${CHANGE_PREFIX}proposal.md`,
  `${CHANGE_PREFIX}design.md`,
  `${CHANGE_PREFIX}tasks.md`
]);

function fail(): never {
  throw new ContractError("CONTRACT_SCHEMA_INVALID");
}

function bytesCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\r") || path.includes("\n") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function inside(root: string, path: string): boolean {
  const candidate = resolve(root, path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isCandidate(path: string): boolean {
  if (path.startsWith(SPIKE_PREFIX)) return true;
  if (path === WORKFLOW_PATH) return true;
  if (!path.startsWith(CHANGE_PREFIX)) return false;
  const local = path.slice(CHANGE_PREFIX.length);
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

async function repositoryPathStat(root: string, path: string): Promise<Stats | undefined> {
  if (!canonicalRelativePath(path)) fail();
  let current = root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let candidate: Stats;
    try {
      candidate = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail();
    }
    if (candidate.isSymbolicLink() || (index < parts.length - 1 && !candidate.isDirectory())) fail();
    if (index === parts.length - 1) return candidate;
  }
  fail();
}

async function admittedRepositoryDirectory(root: string, path: string): Promise<string> {
  const stat = await repositoryPathStat(root, path);
  if (!stat?.isDirectory()) fail();
  return join(root, path);
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
  let section: string | undefined;
  let subsection = false;
  let repositoryFormatVersion: string | undefined;
  let declaredObjectFormat: string | undefined;
  const extensions = new Map<string, string>();

  for (const line of config.split("\n")) {
    if (line.endsWith("\r") || /\\\s*$/.test(line)) fail();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    if (trimmed.startsWith("[")) {
      const match = /^\[([A-Za-z][A-Za-z0-9.-]*)(?:\s+"(?:[^"\\]|\\.)*")?\]\s*(?:[#;].*)?$/.exec(trimmed);
      if (!match) fail();
      section = match[1]!.toLowerCase();
      subsection = /^\[[^\]]+\s+"/.test(trimmed) || section.includes(".");
      if (section === "include" || section === "includeif") fail();
      continue;
    }

    const variable = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.*))?$/.exec(trimmed);
    if (!variable || !section) fail();
    const key = variable[1]!.toLowerCase();
    const value = variable[2] === undefined ? "true" : gitConfigValue(variable[2]);
    if (!subsection && section === "core" && key === "repositoryformatversion") {
      if (repositoryFormatVersion !== undefined) fail();
      repositoryFormatVersion = value;
    }
    if (!subsection && section === "extensions" && key === "objectformat") {
      if (declaredObjectFormat !== undefined || extensions.has(key)) fail();
      declaredObjectFormat = value;
      extensions.set(key, value);
    } else if (!subsection && section === "extensions") {
      if (extensions.has(key)) fail();
      extensions.set(key, value);
    }
  }

  const version = repositoryFormatVersion ?? "0";
  if (version !== "0" && version !== "1") fail();
  if (extensions.size > 0 && version !== "1") fail();
  for (const [key, value] of extensions) {
    if (key === "objectformat") {
      if (value !== "sha1" && value !== "sha256") fail();
    } else if (key === "noop") {
      if (value !== "true") fail();
    } else fail();
  }
  return declaredObjectFormat ?? "sha1";
}

function gitConfigValue(raw: string): string {
  let value = "";
  let meaningfulLength = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (escaped) {
      const replacements: Readonly<Record<string, string>> = { n: "\n", t: "\t", b: "\b", "\\": "\\", '"': '"' };
      const replacement = replacements[character];
      if (replacement === undefined) fail();
      value += replacement;
      meaningfulLength = value.length;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "#" || character === ";")) {
      break;
    } else {
      value += character;
      if (quoted || !/\s/.test(character)) meaningfulLength = value.length;
    }
  }
  if (quoted || escaped) fail();
  return value.slice(0, meaningfulLength);
}

async function readIndex(gitDir: string, algorithm: "sha1" | "sha256"): Promise<IndexEntry[]> {
  const oidLength = algorithm === "sha256" ? 32 : 20;
  const bytes = Buffer.from(await readBoundedFile(join(gitDir, "index"), 20 * 1024 * 1024));
  if (bytes.length < 12 + oidLength || bytes.toString("ascii", 0, 4) !== "DIRC") fail();
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3 && version !== 4) fail();
  const expectedChecksum = bytes.subarray(bytes.length - oidLength);
  const actualChecksum = createHash(algorithm).update(bytes.subarray(0, -oidLength)).digest();
  if (!actualChecksum.equals(expectedChecksum)) fail();
  const count = bytes.readUInt32BE(8);
  const entries: IndexEntry[] = [];
  const stageZeroPaths = new Set<string>();
  const checksumStart = bytes.length - oidLength;
  let cursor = 12;
  let previousPath = Buffer.alloc(0);
  for (let index = 0; index < count; index += 1) {
    const start = cursor;
    const fixed = 40 + oidLength + 2;
    if (cursor + fixed > checksumStart) fail();
    const rawMode = bytes.readUInt32BE(cursor + 24);
    if (rawMode !== 0o100644 && rawMode !== 0o100755 && rawMode !== 0o120000 && rawMode !== 0o160000) fail();
    const objectId = bytes.subarray(cursor + 40, cursor + 40 + oidLength).toString("hex");
    const flags = bytes.readUInt16BE(cursor + 40 + oidLength);
    if (((flags >>> 12) & 3) !== 0) fail();
    cursor += fixed;
    if (version === 2 && (flags & INDEX_ENTRY_EXTENDED) !== 0) fail();
    if (version >= 3 && (flags & INDEX_ENTRY_EXTENDED) !== 0) {
      if (cursor + 2 > checksumStart) fail();
      const extendedFlags = bytes.readUInt16BE(cursor);
      if (extendedFlags === 0 || (extendedFlags & ~INDEX_ENTRY_EXTENDED_FLAGS) !== 0) fail();
      cursor += 2;
    }
    let pathBytes: Buffer;
    if (version === 4) {
      let removed = 0;
      let prefixCursor = cursor;
      while (true) {
        if (prefixCursor >= checksumStart) fail();
        const byte = bytes[prefixCursor++]!;
        const value = byte & 0x7f;
        if (removed > Math.floor((previousPath.length - value) / 128)) fail();
        removed = removed * 128 + value;
        if ((byte & 0x80) === 0) break;
        if (removed >= previousPath.length) fail();
        removed += 1;
      }
      if (removed > previousPath.length) fail();
      const nul = bytes.indexOf(0, prefixCursor);
      if (nul < 0 || nul >= checksumStart) fail();
      pathBytes = Buffer.concat([previousPath.subarray(0, previousPath.length - removed), bytes.subarray(prefixCursor, nul)]);
      if (pathBytes.length > bytes.length) fail();
      cursor = nul + 1;
    } else {
      const nul = bytes.indexOf(0, cursor);
      if (nul < 0 || nul >= checksumStart) fail();
      pathBytes = bytes.subarray(cursor, nul);
      const alignedCursor = start + Math.ceil((nul + 1 - start) / 8) * 8;
      if (alignedCursor > checksumStart) fail();
      for (let padding = nul + 1; padding < alignedCursor; padding += 1) if (bytes[padding] !== 0) fail();
      cursor = alignedCursor;
    }
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
    } catch {
      fail();
    }
    if ((flags & INDEX_ENTRY_PATH_LENGTH_MASK) !== Math.min(pathBytes.length, INDEX_ENTRY_PATH_LENGTH_MASK)) fail();
    if (!canonicalRelativePath(path)) fail();
    if (stageZeroPaths.has(path)) fail();
    if (Buffer.compare(previousPath, pathBytes) >= 0) fail();
    stageZeroPaths.add(path);
    previousPath = pathBytes;
    const mode = rawMode === 0o100644 ? "100644" : rawMode === 0o100755 ? "100755" : undefined;
    if (isCandidate(path) && !mode) fail();
    if (isCandidate(path)) entries.push({ path, mode: mode!, objectId });
  }
  while (cursor < checksumStart) {
    if (checksumStart - cursor < 8) fail();
    const signatureFirstByte = bytes[cursor]!;
    if (signatureFirstByte < 0x41 || signatureFirstByte > 0x5a) fail();
    const length = bytes.readUInt32BE(cursor + 4);
    cursor += 8;
    if (length > checksumStart - cursor) fail();
    cursor += length;
  }
  if (cursor !== checksumStart) fail();
  entries.sort((left, right) => bytesCompare(left.path, right.path));
  return entries;
}

async function regularCandidate(root: string, path: string, required: boolean): Promise<string | undefined> {
  const stat = await repositoryPathStat(root, path);
  if (!stat) {
    if (required) fail();
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
  return path;
}

async function filesystemCandidatePaths(root: string): Promise<string[]> {
  const spikeRoot = await admittedRepositoryDirectory(root, "spikes/git-status-capability");
  const result: string[] = [];
  async function walkSpike(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail());
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const local = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await walkSpike(absolute);
      else if (entry.isFile()) result.push(local);
      else fail();
    }
  }
  await walkSpike(spikeRoot);

  const workflow = await regularCandidate(root, WORKFLOW_PATH, false);
  if (workflow) result.push(workflow);

  for (const path of MANDATORY_CHANGE_PATHS) result.push((await regularCandidate(root, path, true))!);

  const specsRoot = await admittedRepositoryDirectory(root, `${CHANGE_PREFIX}specs`);
  let specCount = 0;
  async function walkSpecs(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => fail());
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const local = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        if (isCandidate(local) || (await followStat(absolute).catch(() => undefined))?.isDirectory()) fail();
      } else if (entry.isDirectory()) await walkSpecs(absolute);
      else if (isCandidate(local)) {
        if (!entry.isFile()) fail();
        result.push(local);
        specCount += 1;
      }
    }
  }
  await walkSpecs(specsRoot);
  if (specCount === 0) fail();
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

type WorktreeAdmissionHook = (absolutePath: string) => void | Promise<void>;

async function verifyWorktreeEntry(
  root: string,
  entry: IndexEntry,
  algorithm: "sha1" | "sha256",
  afterAdmission?: WorktreeAdmissionHook
): Promise<void> {
  const absolute = join(root, entry.path);
  if (!inside(root, entry.path)) fail();
  const admitted = await lstat(absolute).catch(() => undefined);
  if (!admitted?.isFile() || admitted.isSymbolicLink()) fail();
  await afterAdmission?.(absolute);
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await descriptor.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== admitted.dev || opened.ino !== admitted.ino) fail();
    const mode = (opened.mode & 0o111) === 0 ? "100644" : "100755";
    if (mode !== entry.mode) fail();
    const bytes = await descriptor.readFile();
    const final = await descriptor.stat();
    if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== bytes.length) fail();
    const header = Buffer.from(`blob ${bytes.length}\0`, "ascii");
    if (createHash(algorithm).update(header).update(bytes).digest("hex") !== entry.objectId) fail();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    fail();
  } finally {
    await descriptor?.close().catch(() => undefined);
  }
}

async function checkCurrentSourceAuthorityWithHook(
  repositoryRoot: string,
  manifest: string,
  afterAdmission?: WorktreeAdmissionHook
): Promise<void> {
  const root = resolve(repositoryRoot);
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail();
  const gitDirs = await gitDirectories(root);
  const algorithm = await objectFormat(gitDirs.common);
  const tracked = await readIndex(gitDirs.worktree, algorithm);
  const filesystemCandidates = await filesystemCandidatePaths(root);
  const declared = await manifestPaths(root, manifest);
  const trackedPaths = tracked.map((entry) => entry.path);
  if (!canonicalEqualStrings(declared, trackedPaths)) fail();
  if (!canonicalEqualStrings(filesystemCandidates, trackedPaths)) fail();
  for (const entry of tracked) await verifyWorktreeEntry(root, entry, algorithm, afterAdmission);
  validateContractMetadata(await readBoundedFile(join(root, CONTRACT_METADATA), SOURCE_METADATA_PROFILE.bytes));
  validateSyntheticOracle(
    await readBoundedFile(join(root, SYNTHETIC_FRAME), SOURCE_METADATA_PROFILE.bytes),
    await readBoundedFile(join(root, SYNTHETIC_SIDECAR), SOURCE_METADATA_PROFILE.bytes)
  );
}

export async function checkCurrentSourceAuthority(repositoryRoot: string, manifest: string): Promise<void> {
  await checkCurrentSourceAuthorityWithHook(repositoryRoot, manifest);
}

/** Deterministic descriptor-race seam for contract tests; production callers use checkCurrentSourceAuthority. */
export async function checkCurrentSourceAuthorityForTest(
  repositoryRoot: string,
  manifest: string,
  afterAdmission: WorktreeAdmissionHook
): Promise<void> {
  await checkCurrentSourceAuthorityWithHook(repositoryRoot, manifest, afterAdmission);
}

function canonicalEqualStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
