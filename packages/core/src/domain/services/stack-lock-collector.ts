import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import {
  access,
  lstat,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { devNull, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { env } from "node:process";
import { StackLockSchema, type StackLock } from "../schemas/stack-lock";
import { readDurableSingleLinkFile } from "./durable-single-link-reader";
import { hashFile } from "./hashing-service";
import { isSafeExistingDirectoryPath, resolveWorkspacePath } from "./workspace-path-safety";

export const STACK_LOCK_REPOSITORY_NAMES = ["SHUD", "rSHUD", "AutoSHUD", "zero"] as const;
export const STACK_LOCK_ZERO_PIN = "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6" as const;
export const STACK_LOCK_RENV_MISSING = "renv_lock_missing" as const;
export const STACK_LOCK_UNKNOWN_VERSION = "unknown" as const;
export const STACK_LOCK_PROMPT_PACK = "promptpack-unset" as const;
export const STACK_LOCK_SKILLS_VERSION = "skills-unset" as const;
export const STACK_LOCK_PARAMS_DIGEST = createHash("sha256").update("{}", "utf8").digest("hex");
export const STACK_LOCK_PROMPT_PACK_DIGEST = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const EXPECTED_GITMODULE_DECLARATIONS = Object.freeze({
  SHUD: Object.freeze({ path: "SHUD", branch: "master" }),
  rSHUD: Object.freeze({ path: "rSHUD", branch: "master" }),
  AutoSHUD: Object.freeze({ path: "AutoSHUD", branch: "master" }),
  zero: Object.freeze({ path: "zero", branch: "development" })
} as const);
const STACK_LOCK_CONTENT_SCHEMA = StackLockSchema.pick({
  repos: true,
  runtime: true,
  harness: true,
  llm: true
});
const PACKAGE_JSON_RELATIVE_PATH = "package.json";
const PROVIDER_CONFIG_RELATIVE_PATH = "config/providers/glm.dmxapi.json";
const GITMODULES_RELATIVE_PATH = ".gitmodules";
const R_PACKAGES_LOCK_RELATIVE_PATH = "renv.lock";
const MAX_JSON_FILE_BYTES = 64 * 1024;
const MAX_GITMODULES_FILE_BYTES = 64 * 1024;
const STACK_LOCK_RENV_MAX_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_GIT_INDEX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_STATUS_AUXILIARY_BYTES = 1024 * 1024;
const MAX_GIT_ADMIN_PATH_BYTES = 4096;
const GIT_TIMEOUT_MS = 10_000;
const GIT_NO_LAZY_FETCH_GLOBAL_ARG = "--no-lazy-fetch";
const GITLINK_PATTERN = /^160000 commit ([0-9A-Fa-f]{40})\t([^\0]+)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DETACHED_BRANCH_LABEL = "detached";
const CWD_IDENTITY_MISMATCH_MARKER = "STACK_LOCK_CWD_IDENTITY_MISMATCH";

export type StackLockRepositoryName = (typeof STACK_LOCK_REPOSITORY_NAMES)[number];
export type StackLockDegradedReason = typeof STACK_LOCK_RENV_MISSING;
export type StackLockCollectedContent = Pick<StackLock, "repos" | "runtime" | "harness" | "llm">;

export interface StackLockCollectionResult extends StackLockCollectedContent {
  readonly degraded: readonly StackLockDegradedReason[];
}

export interface StackLockGitCommandInput {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Per-command bounded output cap; omitted means the 64 KiB default. */
  readonly maxOutputBytes?: number;
  /** Physical cwd identity required by the production checkout command wrapper. */
  readonly cwdIdentity?: Readonly<{ dev: string; ino: string }>;
  /** Object directory selected by the helper-free dirty observer. */
  readonly gitObjectDirectory?: string;
}

export interface StackLockGitCommandResult {
  readonly stdout: string | Uint8Array;
  readonly stderr?: string;
}

export type StackLockGitCommand = (
  input: StackLockGitCommandInput
) => Promise<StackLockGitCommandResult>;

export interface CollectStackLockContextOptions {
  readonly repositoryRoot: string;
  readonly gitCommand?: StackLockGitCommand;
}

export type StackLockCollectionErrorCode =
  | "repository_root_invalid"
  | "git_read_failed"
  | "git_output_invalid"
  | "gitmodules_invalid"
  | "package_json_invalid"
  | "provider_config_invalid"
  | "renv_lock_invalid"
  | "collection_state_changed"
  | "collection_contract_invalid";

export class StackLockCollectionError extends Error {
  readonly code: StackLockCollectionErrorCode;

  constructor(code: StackLockCollectionErrorCode) {
    super("StackLock context collection failed.");
    this.name = "StackLockCollectionError";
    this.code = code;
  }
}

export async function collectStackLockContext(
  options: CollectStackLockContextOptions
): Promise<StackLockCollectionResult> {
  return await collectStackLockContextWithHasher(options, hashFile);
}

type StackLockFileHasher = typeof hashFile;

/** Internal deterministic seam for proving producer ordering; not barrel-exported. */
export async function __collectStackLockContextWithHasherForTest(
  options: CollectStackLockContextOptions,
  fileHasher: StackLockFileHasher,
  testHooks: StackLockCollectorTestHooks = {}
): Promise<StackLockCollectionResult> {
  return await collectStackLockContextWithHasher(options, fileHasher, testHooks);
}

async function collectStackLockContextWithHasher(
  options: CollectStackLockContextOptions,
  fileHasher: StackLockFileHasher,
  testHooks: StackLockCollectorTestHooks = {}
): Promise<StackLockCollectionResult> {
  const gitCommand = options.gitCommand ?? await createDefaultGitCommand();
  const repositoryRoot = await resolveRepositoryRoot(options.repositoryRoot);
  const authorityOwner = new RepositoryCheckoutAuthorityOwner(testHooks.closeCheckoutDirectory);
  const temporaryDirectoryAuthority = resolveCollectionTemporaryDirectoryAuthority(
    repositoryRoot,
    testHooks.createTemporaryDirectory
  );
  const context: StackLockCollectorContext = Object.freeze({
    authorityOwner,
    temporaryDirectoryAuthority,
    testHooks
  });
  let firstCheap: StackLockCheapSnapshot | undefined;
  let secondCheap: StackLockCheapSnapshot | undefined;
  let result: StackLockCollectionResult | undefined;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    firstCheap = await collectCheapSnapshot(repositoryRoot, gitCommand, context);
    assertExpectedGitmodules(firstCheap.gitmodules);
    const first = await completeSnapshot(repositoryRoot, firstCheap, fileHasher);
    secondCheap = await collectCheapSnapshot(repositoryRoot, gitCommand, context);
    if (!cheapSnapshotsMatch(firstCheap, secondCheap)) {
      throw new StackLockCollectionError("collection_state_changed");
    }
    assertExpectedGitmodules(secondCheap.gitmodules);
    const second = await completeSnapshot(repositoryRoot, secondCheap, fileHasher);
    if (!snapshotsMatch(first, second)) {
      throw new StackLockCollectionError("collection_state_changed");
    }
    const { repos, harness, provider, rPackagesLock } = second;
    const runtime = collectRuntimeVersions(rPackagesLock.value);
    await assertCurrentRepositoryRoot(repositoryRoot);

    let content: StackLockCollectedContent;
    try {
      content = STACK_LOCK_CONTENT_SCHEMA.parse({
        repos,
        runtime,
        harness: {
          version: harness.version,
          cli_version: STACK_LOCK_UNKNOWN_VERSION,
          prompt_pack: STACK_LOCK_PROMPT_PACK,
          skills_version: STACK_LOCK_SKILLS_VERSION
        },
        llm: {
          provider: provider.provider,
          model_id: provider.modelId,
          base_url: provider.baseUrl,
          params_digest: STACK_LOCK_PARAMS_DIGEST,
          prompt_pack_digest: STACK_LOCK_PROMPT_PACK_DIGEST
        }
      });
    } catch {
      throw new StackLockCollectionError("collection_contract_invalid");
    }

    result = freezeCollectionResult(content, rPackagesLock.degraded);
    await assertPublicationSnapshot(repositoryRoot, second, gitCommand, context);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }
  const closeFailed = await authorityOwner.closeAll();
  if (primaryFailed) throw primaryError;
  if (closeFailed) throw new StackLockCollectionError("collection_contract_invalid");
  return result!;
}

interface StackLockCollectorTestHooks {
  readonly closeCheckoutDirectory?: (directory: FileHandle) => Promise<void>;
  readonly observeCheckoutPath?: typeof observeRepositoryRootIdentity;
  readonly realpathCheckoutPath?: typeof realpath;
  readonly openCheckoutDirectory?: typeof open;
  readonly afterCheckoutAuthorityAcquired?: (
    name: StackLockRepositoryName,
    authority: RepositoryCheckoutAuthority
  ) => Promise<void>;
  /** Deterministic TOCTOU seam after recursive config/index audit and before dirty observation. */
  readonly afterRepositoryDirtyAudit?: (repositoryPath: string) => Promise<void>;
  /** Deterministic oracle proving protected temporary parents reject before creation. */
  readonly createTemporaryDirectory?: typeof mkdtempSync;
}

interface StackLockCollectorContext {
  readonly authorityOwner: RepositoryCheckoutAuthorityOwner;
  readonly temporaryDirectoryAuthority: CollectionTemporaryDirectoryAuthority;
  readonly testHooks: StackLockCollectorTestHooks;
}

class RepositoryCheckoutAuthorityOwner {
  private readonly authorities = new Set<RepositoryCheckoutAuthority>();
  private readonly closer: (directory: FileHandle) => Promise<void>;

  constructor(closer: ((directory: FileHandle) => Promise<void>) | undefined) {
    this.closer = closer ?? (async (directory) => await directory.close());
  }

  register(authority: RepositoryCheckoutAuthority): void {
    this.authorities.add(authority);
  }

  async closeAll(): Promise<boolean> {
    const settlements = await Promise.allSettled(
      [...this.authorities].map(async (authority) => await this.closer(authority.directory))
    );
    this.authorities.clear();
    return settlements.some((settlement) => settlement.status === "rejected");
  }
}

interface RepositoryRootIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface RepositoryRootAuthority {
  readonly path: string;
  readonly identity: RepositoryRootIdentity;
}

interface CollectionTemporaryDirectoryAuthority {
  readonly parent: string;
  readonly identity: RepositoryRootIdentity;
  readonly create: typeof mkdtempSync;
}

interface RepositoryCheckoutAuthority {
  readonly path: string;
  readonly identity: RepositoryRootIdentity;
  readonly directory: FileHandle;
}

interface StackLockCheapSnapshot {
  readonly repositoryRoot: RepositoryRootAuthority;
  readonly repos: StackLock["repos"];
  readonly gitlinks: Readonly<Record<StackLockRepositoryName, string>>;
  readonly repositoryCheckouts: Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>;
  readonly harness: HarnessIdentity;
  readonly provider: ProviderIdentity;
  readonly gitmodules: GitmodulesIdentity;
}

interface StackLockCollectionSnapshot extends StackLockCheapSnapshot {
  readonly rPackagesLock: Awaited<ReturnType<typeof collectRPackagesLock>>;
}

async function collectCheapSnapshot(
  repositoryRoot: RepositoryRootAuthority,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<StackLockCheapSnapshot> {
  return await withRepositoryRootAuthority(repositoryRoot, async () => {
    const reportedRepositoryRoot = await withRepositoryRootAuthority(
      repositoryRoot,
      async () => await collectRepositoryRootIdentity(repositoryRoot, gitCommand)
    );
    const authority = await withRepositoryRootAuthority(
      repositoryRoot,
      async () => await collectHeadAuthority(reportedRepositoryRoot, gitCommand, context)
    );
    const harness = await withRepositoryRootAuthority(
      repositoryRoot,
      async () => await readHarnessVersion(reportedRepositoryRoot.path)
    );
    const provider = await withRepositoryRootAuthority(
      repositoryRoot,
      async () => await readProviderIdentity(reportedRepositoryRoot.path)
    );
    return Object.freeze({
      repositoryRoot: reportedRepositoryRoot,
      repos: authority.repos,
      gitlinks: authority.gitlinks,
      repositoryCheckouts: authority.repositoryCheckouts,
      harness,
      provider,
      gitmodules: authority.gitmodules
    });
  });
}

async function completeSnapshot(
  repositoryRoot: RepositoryRootAuthority,
  cheap: StackLockCheapSnapshot,
  fileHasher: StackLockFileHasher
): Promise<StackLockCollectionSnapshot> {
  return await withRepositoryRootAuthority(repositoryRoot, async () => {
    const rPackagesLock = await withRepositoryRootAuthority(
      repositoryRoot,
      async () => await collectRPackagesLock(repositoryRoot.path, fileHasher)
    );
    return Object.freeze({ ...cheap, rPackagesLock });
  });
}

function cheapSnapshotsMatch(
  first: StackLockCheapSnapshot,
  second: StackLockCheapSnapshot
): boolean {
  return (
    sameRepositoryRootAuthority(first.repositoryRoot, second.repositoryRoot) &&
    JSON.stringify(first.repos) === JSON.stringify(second.repos) &&
    JSON.stringify(first.gitlinks) === JSON.stringify(second.gitlinks) &&
    repositoryCheckoutAuthoritiesMatch(first.repositoryCheckouts, second.repositoryCheckouts) &&
    first.harness.version === second.harness.version &&
    first.harness.sourceDigest === second.harness.sourceDigest &&
    first.provider.provider === second.provider.provider &&
    first.provider.modelId === second.provider.modelId &&
    first.provider.baseUrl === second.provider.baseUrl &&
    first.provider.sourceDigest === second.provider.sourceDigest &&
    first.gitmodules.objectId === second.gitmodules.objectId &&
    first.gitmodules.sourceDigest === second.gitmodules.sourceDigest &&
    JSON.stringify(first.gitmodules.declarations) ===
      JSON.stringify(second.gitmodules.declarations)
  );
}

function snapshotsMatch(
  first: StackLockCollectionSnapshot,
  second: StackLockCollectionSnapshot
): boolean {
  return (
    cheapSnapshotsMatch(first, second) &&
    JSON.stringify(first.rPackagesLock) === JSON.stringify(second.rPackagesLock)
  );
}

async function assertPublicationSnapshot(
  repositoryRoot: RepositoryRootAuthority,
  snapshot: StackLockCollectionSnapshot,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<void> {
  const firstSweep = await collectPublicationSweep(repositoryRoot, snapshot, gitCommand, context);
  const secondSweep = await collectPublicationSweep(repositoryRoot, snapshot, gitCommand, context);
  if (
    JSON.stringify(firstSweep) !== JSON.stringify(snapshot.repos) ||
    JSON.stringify(secondSweep) !== JSON.stringify(snapshot.repos) ||
    JSON.stringify(firstSweep) !== JSON.stringify(secondSweep)
  ) {
    throw new StackLockCollectionError("collection_state_changed");
  }
  await assertCurrentRepositoryRoot(repositoryRoot);
  for (const name of STACK_LOCK_REPOSITORY_NAMES) {
    await assertCurrentRepositoryCheckout(snapshot.repositoryCheckouts[name]);
  }
  await assertCurrentRepositoryRoot(repositoryRoot);
}

async function collectPublicationSweep(
  repositoryRoot: RepositoryRootAuthority,
  snapshot: StackLockCollectionSnapshot,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<StackLock["repos"]> {
  await assertCurrentRepositoryRoot(repositoryRoot);
  const repos = {} as StackLock["repos"];
  for (const name of STACK_LOCK_REPOSITORY_NAMES) {
    const authority = snapshot.repositoryCheckouts[name];
    repos[name] = await withRepositoryCheckoutAuthority(
      authority,
      async () => await collectStableRepositoryRevision(authority, gitCommand, context)
    );
  }
  await assertCurrentRepositoryRoot(repositoryRoot);
  return Object.freeze(repos);
}

async function resolveRepositoryRoot(input: string): Promise<RepositoryRootAuthority> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new StackLockCollectionError("repository_root_invalid");
  }
  try {
    const requestedPath = resolve(input);
    const physicalPath = await realpath(requestedPath);
    const firstIdentity = await observeRepositoryRootIdentity(physicalPath);
    if (!(await isSafeExistingDirectoryPath(physicalPath))) {
      throw new Error("repository root is not a safe directory");
    }
    if (await realpath(requestedPath) !== physicalPath) {
      throw new Error("repository root changed during admission");
    }
    const secondIdentity = await observeRepositoryRootIdentity(physicalPath);
    if (!sameRepositoryRootIdentity(firstIdentity, secondIdentity)) {
      throw new Error("repository root changed during admission");
    }
    return Object.freeze({ path: physicalPath, identity: secondIdentity });
  } catch {
    throw new StackLockCollectionError("repository_root_invalid");
  }
}

function resolveCollectionTemporaryDirectoryAuthority(
  repositoryRoot: RepositoryRootAuthority,
  create: typeof mkdtempSync | undefined
): CollectionTemporaryDirectoryAuthority {
  try {
    const configuredParent = tmpdir();
    if (
      configuredParent.length === 0 ||
      configuredParent.includes("\0") ||
      configuredParent.includes("\n") ||
      configuredParent.includes("\r")
    ) {
      throw new Error("invalid temporary parent");
    }
    const physicalParent = realpathSync(configuredParent);
    const parentIdentity = observeRepositoryRootIdentitySync(physicalParent);
    const relativeFromCollectionRoot = relative(repositoryRoot.path, physicalParent);
    if (
      relativeFromCollectionRoot === "" ||
      (
        !isAbsolute(relativeFromCollectionRoot) &&
        relativeFromCollectionRoot !== ".." &&
        !relativeFromCollectionRoot.startsWith(`..${sep}`)
      )
    ) {
      throw new Error("temporary parent is inside protected collection root");
    }
    return Object.freeze({
      parent: physicalParent,
      identity: parentIdentity,
      create: create ?? mkdtempSync
    });
  } catch {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

async function collectRepositoryRootIdentity(
  repositoryRoot: RepositoryRootAuthority,
  gitCommand: StackLockGitCommand
): Promise<RepositoryRootAuthority> {
  let rawResult: unknown;
  try {
    rawResult = await gitCommand({
      cwd: repositoryRoot.path,
      args: Object.freeze([
        GIT_NO_LAZY_FETCH_GLOBAL_ARG,
        "rev-parse",
        "--show-toplevel"
      ])
    });
  } catch {
    throw new StackLockCollectionError("git_read_failed");
  }

  let stdoutBytes: Buffer;
  try {
    stdoutBytes = boundedGitOutputBytes(asRecord(rawResult)?.stdout, MAX_GIT_OUTPUT_BYTES);
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  let stdout: string;
  try {
    stdout = UTF8_DECODER.decode(stdoutBytes);
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  if (!stdout.endsWith("\n")) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  const reportedPath = stdout.slice(0, -1).replace(/\r$/u, "");
  if (
    reportedPath.length === 0 ||
    reportedPath.includes("\n") ||
    reportedPath.includes("\0") ||
    !isAbsolute(reportedPath)
  ) {
    throw new StackLockCollectionError("git_output_invalid");
  }

  let physicalReportedPath: string;
  try {
    physicalReportedPath = await realpath(reportedPath);
  } catch {
    throw new StackLockCollectionError("repository_root_invalid");
  }
  if (physicalReportedPath !== repositoryRoot.path) {
    throw new StackLockCollectionError("repository_root_invalid");
  }
  await assertCurrentRepositoryRoot(repositoryRoot);
  return repositoryRoot;
}

async function observeRepositoryRootIdentity(path: string): Promise<RepositoryRootIdentity> {
  const observation = await lstat(path, { bigint: true });
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    throw new Error("repository root is not a physical directory");
  }
  return Object.freeze({ dev: observation.dev, ino: observation.ino });
}

function sameRepositoryRootIdentity(
  left: RepositoryRootIdentity,
  right: RepositoryRootIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRepositoryRootAuthority(
  left: RepositoryRootAuthority,
  right: RepositoryRootAuthority
): boolean {
  return left.path === right.path && sameRepositoryRootIdentity(left.identity, right.identity);
}

function repositoryCheckoutAuthoritiesMatch(
  left: Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>,
  right: Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>
): boolean {
  return STACK_LOCK_REPOSITORY_NAMES.every((name) =>
    left[name].path === right[name].path &&
    sameRepositoryRootIdentity(left[name].identity, right[name].identity)
  );
}

async function assertCurrentRepositoryRoot(
  repositoryRoot: RepositoryRootAuthority
): Promise<void> {
  try {
    const current = await observeRepositoryRootIdentity(repositoryRoot.path);
    if (!sameRepositoryRootIdentity(repositoryRoot.identity, current)) {
      throw new Error("repository root identity changed");
    }
  } catch {
    throw new StackLockCollectionError("collection_state_changed");
  }
}

async function withRepositoryRootAuthority<T>(
  repositoryRoot: RepositoryRootAuthority,
  producer: () => Promise<T>
): Promise<T> {
  await assertCurrentRepositoryRoot(repositoryRoot);
  let result: T | undefined;
  let producerThrew = false;
  let producerError: unknown;
  try {
    result = await producer();
  } catch (error) {
    producerThrew = true;
    producerError = error;
  }
  await assertCurrentRepositoryRoot(repositoryRoot);
  if (producerThrew) throw producerError;
  return result as T;
}

interface HeadAuthorityInventory {
  readonly revisions: Readonly<Record<StackLockRepositoryName, string>>;
  readonly gitmodulesObjectId: string;
}

interface RepositoryCollection {
  readonly repos: StackLock["repos"];
  readonly authorities: Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>;
}

async function collectHeadAuthority(
  repositoryRoot: RepositoryRootAuthority,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<{
  readonly repos: StackLock["repos"];
  readonly gitlinks: Readonly<Record<StackLockRepositoryName, string>>;
  readonly repositoryCheckouts: Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>;
  readonly gitmodules: GitmodulesIdentity;
}> {
  const inventory = await withRepositoryRootAuthority(
    repositoryRoot,
    async () => await collectHeadAuthorityInventory(repositoryRoot.path, gitCommand)
  );
  const gitmodules = await withRepositoryRootAuthority(
    repositoryRoot,
    async () => await readHeadGitmodulesIdentity(
      repositoryRoot.path,
      inventory.gitmodulesObjectId,
      gitCommand
    )
  );
  assertExpectedGitmodules(gitmodules);
  const repositoryCollection = await withRepositoryRootAuthority(
    repositoryRoot,
    async () =>
      await collectRepositoryRevisions(
        repositoryRoot.path,
        gitmodules.declarations,
        gitCommand,
        context
      )
  );
  return Object.freeze({
    repos: repositoryCollection.repos,
    gitlinks: inventory.revisions,
    repositoryCheckouts: repositoryCollection.authorities,
    gitmodules
  });
}

async function collectHeadAuthorityInventory(
  repositoryRoot: string,
  gitCommand: StackLockGitCommand
): Promise<HeadAuthorityInventory> {
  let rawResult: unknown;
  try {
    rawResult = await gitCommand({
      cwd: repositoryRoot,
      args: Object.freeze([
        GIT_NO_LAZY_FETCH_GLOBAL_ARG,
        "ls-tree",
        "-z",
        "--full-tree",
        "HEAD",
        "--",
        GITMODULES_RELATIVE_PATH,
        ...STACK_LOCK_REPOSITORY_NAMES
      ])
    });
  } catch {
    throw new StackLockCollectionError("git_read_failed");
  }

  let stdoutBytes: Buffer;
  try {
    stdoutBytes = boundedGitOutputBytes(asRecord(rawResult)?.stdout, MAX_GIT_OUTPUT_BYTES);
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  let stdout: string;
  try {
    stdout = UTF8_DECODER.decode(stdoutBytes);
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  if (!stdout.endsWith("\0")) {
    throw new StackLockCollectionError("git_output_invalid");
  }

  const revisions = new Map<StackLockRepositoryName, string>();
  let gitmodulesObjectId: string | undefined;
  const records = stdout.slice(0, -1).split("\0");
  if (records.length === 0 || records.length > STACK_LOCK_REPOSITORY_NAMES.length + 1) {
    throw new StackLockCollectionError("git_output_invalid");
  }

  for (const record of records) {
    const gitmodulesMatch = /^100644 blob ([0-9A-Fa-f]{40})\t\.gitmodules$/u.exec(record);
    if (gitmodulesMatch) {
      if (gitmodulesObjectId !== undefined) {
        throw new StackLockCollectionError("gitmodules_invalid");
      }
      gitmodulesObjectId = gitmodulesMatch[1]!.toLowerCase();
      continue;
    }
    if (record.endsWith(`\t${GITMODULES_RELATIVE_PATH}`)) {
      throw new StackLockCollectionError("gitmodules_invalid");
    }
    const match = GITLINK_PATTERN.exec(record);
    if (!match) throw new StackLockCollectionError("git_output_invalid");
    const repositoryName = match[2];
    if (!isStackLockRepositoryName(repositoryName) || revisions.has(repositoryName)) {
      throw new StackLockCollectionError("git_output_invalid");
    }
    revisions.set(repositoryName, match[1]!.toLowerCase());
  }

  for (const repositoryName of STACK_LOCK_REPOSITORY_NAMES) {
    if (!revisions.has(repositoryName)) {
      throw new StackLockCollectionError("git_output_invalid");
    }
  }
  if (gitmodulesObjectId === undefined) {
    throw new StackLockCollectionError("gitmodules_invalid");
  }

  return Object.freeze({
    revisions: Object.freeze(Object.fromEntries(
      STACK_LOCK_REPOSITORY_NAMES.map((name) => [name, revisions.get(name)!])
    )) as Readonly<Record<StackLockRepositoryName, string>>,
    gitmodulesObjectId
  });
}

async function collectRepositoryRevisions(
  repositoryRoot: string,
  declarations: Readonly<Record<StackLockRepositoryName, GitmoduleDeclaration>>,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<RepositoryCollection> {
  const resolved: Array<readonly [
    StackLockRepositoryName,
    StackLock["repos"][StackLockRepositoryName],
    RepositoryCheckoutAuthority
  ]> = [];
  for (const name of STACK_LOCK_REPOSITORY_NAMES) {
    const authority = await resolveRepositoryCheckoutAuthority(
      repositoryRoot,
      declarations[name].path,
      context.testHooks,
      context.authorityOwner
    );
    await context.testHooks.afterCheckoutAuthorityAcquired?.(name, authority);
    const revision = await withRepositoryCheckoutAuthority(authority, async () => {
      await assertRepositoryGitTopLevel(authority, gitCommand);
      return await collectStableRepositoryRevision(authority, gitCommand, context);
    });
    resolved.push([name, revision, authority] as const);
  }
  return Object.freeze({
    repos: Object.freeze(Object.fromEntries(
      resolved.map(([name, revision]) => [name, revision])
    )) as StackLock["repos"],
    authorities: Object.freeze(Object.fromEntries(
      resolved.map(([name, _revision, authority]) => [name, authority])
    )) as Readonly<Record<StackLockRepositoryName, RepositoryCheckoutAuthority>>
  });
}

async function collectStableRepositoryRevision(
  authority: RepositoryCheckoutAuthority,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<StackLock["repos"][StackLockRepositoryName]> {
  const firstCommit = await collectRepositoryHeadCommit(authority, gitCommand);
  const firstBranch = await collectRepositoryHeadBranch(authority, gitCommand);
  const dirty = await collectRepositoryDirty(authority, firstCommit, gitCommand, context);
  const secondCommit = await collectRepositoryHeadCommit(authority, gitCommand);
  const secondBranch = await collectRepositoryHeadBranch(authority, gitCommand);
  const secondDirty = await collectRepositoryDirty(
    authority,
    secondCommit,
    gitCommand,
    context
  );
  if (
    firstCommit !== secondCommit ||
    JSON.stringify(firstBranch) !== JSON.stringify(secondBranch) ||
    dirty !== secondDirty
  ) {
    throw new StackLockCollectionError("collection_state_changed");
  }
  return Object.freeze({ commit: secondCommit, ...secondBranch, dirty: secondDirty });
}

async function resolveRepositoryCheckoutAuthority(
  repositoryRoot: string,
  relativePath: string,
  testHooks: StackLockCollectorTestHooks = {},
  authorityOwner?: RepositoryCheckoutAuthorityOwner
): Promise<RepositoryCheckoutAuthority> {
  const requestedPath = join(repositoryRoot, relativePath);
  let directory: FileHandle | undefined;
  let ownerRegistered = false;
  try {
    const observeCheckoutPath = testHooks.observeCheckoutPath ?? observeRepositoryRootIdentity;
    const realpathCheckoutPath = testHooks.realpathCheckoutPath ?? realpath;
    const openCheckoutDirectory = testHooks.openCheckoutDirectory ?? open;
    const firstIdentity = await observeCheckoutPath(requestedPath);
    if (!(await isSafeExistingDirectoryPath(requestedPath))) {
      throw new Error("repository checkout is not a safe physical directory");
    }
    directory = await openCheckoutDirectory(
      requestedPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const descriptorStat = await directory.stat({ bigint: true });
    const descriptorIdentity = Object.freeze({ dev: descriptorStat.dev, ino: descriptorStat.ino });
    const authority = Object.freeze({
      path: requestedPath,
      identity: descriptorIdentity,
      directory
    });
    authorityOwner?.register(authority);
    ownerRegistered = authorityOwner !== undefined;
    const physicalPath = await realpathCheckoutPath(requestedPath);
    const secondIdentity = await observeCheckoutPath(requestedPath);
    if (!sameRepositoryRootIdentity(firstIdentity, secondIdentity)) {
      throw new Error("repository checkout changed during admission");
    }
    if (
      physicalPath !== requestedPath ||
      !sameRepositoryRootIdentity(secondIdentity, descriptorIdentity)
    ) {
      throw new Error("repository checkout is not the admitted directory object");
    }
    return authority;
  } catch {
    if (!ownerRegistered) await directory?.close().catch(() => undefined);
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

async function assertCurrentRepositoryCheckout(
  authority: RepositoryCheckoutAuthority
): Promise<void> {
  try {
    const current = await observeRepositoryRootIdentity(authority.path);
    if (!sameRepositoryRootIdentity(authority.identity, current)) {
      throw new Error("repository checkout identity changed");
    }
  } catch {
    throw new StackLockCollectionError("collection_state_changed");
  }
}

async function withRepositoryCheckoutAuthority<T>(
  authority: RepositoryCheckoutAuthority,
  producer: () => Promise<T>
): Promise<T> {
  await assertCurrentRepositoryCheckout(authority);
  let result: T | undefined;
  let producerError: unknown;
  try {
    result = await producer();
  } catch (error) {
    producerError = error;
  }
  await assertCurrentRepositoryCheckout(authority);
  if (producerError !== undefined) throw producerError;
  return result as T;
}

async function readRepositoryGitText(
  authority: RepositoryCheckoutAuthority,
  args: readonly string[],
  gitCommand: StackLockGitCommand,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES
): Promise<string> {
  await assertCurrentRepositoryCheckout(authority);
  let rawResult: unknown;
  try {
    rawResult = await gitCommand({
      cwd: authority.path,
      args: Object.freeze([...args]),
      maxOutputBytes,
      cwdIdentity: Object.freeze({
        dev: authority.identity.dev.toString(),
        ino: authority.identity.ino.toString()
      })
    });
  } catch (error) {
    if (error instanceof StackLockCollectionError) throw error;
    throw new StackLockCollectionError("git_read_failed");
  }
  await assertCurrentRepositoryCheckout(authority);
  try {
    return UTF8_DECODER.decode(
      boundedGitOutputBytes(asRecord(rawResult)?.stdout, maxOutputBytes)
    );
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
}

function parseSingleGitLine(stdout: string): string {
  if (!stdout.endsWith("\n")) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  const value = stdout.slice(0, -1).replace(/\r$/u, "");
  if (value.length === 0 || value.includes("\0") || value.includes("\n")) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  return value;
}

async function assertRepositoryGitTopLevel(
  authority: RepositoryCheckoutAuthority,
  gitCommand: StackLockGitCommand
): Promise<void> {
  const stdout = await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "rev-parse", "--show-toplevel", "--show-prefix"],
    gitCommand
  );
  const normalized = stdout.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines[2] !== "" ||
    !isAbsolute(lines[0]!)
  ) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  if (lines[1] !== "") {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  let physicalTopLevel: string;
  try {
    physicalTopLevel = await realpath(lines[0]!);
  } catch {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  if (physicalTopLevel !== authority.path) {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

async function assertNestedRepositoryGitTopLevel(
  authority: RepositoryCheckoutAuthority,
  gitCommand: StackLockGitCommand
): Promise<void> {
  const prefix = await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "rev-parse", "--show-prefix"],
    gitCommand
  );
  const inside = await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "rev-parse", "--is-inside-work-tree"],
    gitCommand
  );
  if (prefix !== "\n" || parseSingleGitLine(inside) !== "true") {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

async function collectRepositoryHeadCommit(
  authority: RepositoryCheckoutAuthority,
  gitCommand: StackLockGitCommand
): Promise<string> {
  const commit = parseSingleGitLine(await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "rev-parse", "HEAD"],
    gitCommand
  ));
  if (!/^[0-9A-Fa-f]{40}$/u.test(commit)) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  return commit.toLowerCase();
}

async function collectRepositoryHeadBranch(
  authority: RepositoryCheckoutAuthority,
  gitCommand: StackLockGitCommand
): Promise<Readonly<{ branch: string; detached: boolean }>> {
  const branch = parseSingleGitLine(await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "rev-parse", "--abbrev-ref", "HEAD"],
    gitCommand
  ));
  if (branch === "HEAD") {
    return Object.freeze({ branch: DETACHED_BRANCH_LABEL, detached: true });
  }
  return Object.freeze({ branch, detached: false });
}

async function collectRepositoryDirty(
  authority: RepositoryCheckoutAuthority,
  headCommit: string,
  gitCommand: StackLockGitCommand,
  context: StackLockCollectorContext
): Promise<boolean> {
  const owner = new RepositoryCheckoutAuthorityOwner(undefined);
  let result: boolean | undefined;
  let primaryError: unknown;
  try {
    const audit = await auditRepositoryForDirtyObservation(
      authority,
      headCommit,
      gitCommand,
      context.temporaryDirectoryAuthority,
      owner
    );
    await context.testHooks.afterRepositoryDirtyAudit?.(authority.path);
    result = await observeAuditedRepositoryDirty(audit, gitCommand);
  } catch (error) {
    primaryError = error;
  }
  const closeFailed = await owner.closeAll();
  if (primaryError !== undefined) throw primaryError;
  if (closeFailed) throw new StackLockCollectionError("collection_contract_invalid");
  return result!;
}

interface CapturedGitFile {
  readonly bytes: Uint8Array;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly source: string;
  readonly identity: Readonly<{
    dev: bigint;
    ino: bigint;
    size: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
  }>;
}

interface CapturedRepositoryIndex {
  readonly index: CapturedGitFile;
  readonly sharedIndex?: Readonly<{ name: string; file: CapturedGitFile }>;
}

interface FrozenStatusConfig {
  readonly booleans: Readonly<Record<string, boolean>>;
  readonly checkStat?: "default" | "minimal";
  readonly autocrlf?: "true" | "false" | "input";
  readonly eol?: "lf" | "crlf" | "native";
  readonly excludesFile?: CapturedGitFile;
  readonly attributesFile?: CapturedGitFile;
}

interface AuditedDirtyRepository {
  readonly authority: RepositoryCheckoutAuthority;
  readonly temporaryDirectoryAuthority: CollectionTemporaryDirectoryAuthority;
  readonly headCommit: string;
  readonly paths: RepositoryGitAdministrativePaths;
  readonly statusConfig: FrozenStatusConfig;
  readonly infoExclude?: CapturedGitFile;
  readonly infoAttributes?: CapturedGitFile;
  readonly capturedIndex: CapturedRepositoryIndex;
  readonly nested: readonly AuditedNestedRepository[];
}

type AuditedNestedRepository = Readonly<{
  indexCommit: string;
  path: string;
} & (
  | { state: "initialized"; repository: AuditedDirtyRepository }
  | { state: "deinitialized"; identity: RepositoryRootIdentity }
  | { state: "absent" }
)>;

async function auditRepositoryForDirtyObservation(
  authority: RepositoryCheckoutAuthority,
  headCommit: string,
  gitCommand: StackLockGitCommand,
  temporaryDirectoryAuthority: CollectionTemporaryDirectoryAuthority,
  owner: RepositoryCheckoutAuthorityOwner
): Promise<AuditedDirtyRepository> {
  const paths = await resolveRepositoryGitAdministrativePaths(authority);
  const localConfig = await readRepositoryGitText(
    authority,
    [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "config", "--local", "--includes", "--null", "--list"],
    gitCommand
  );
  const statusConfig: MutableFrozenStatusConfig = { booleans: {} };
  const localRecords = parseAndAuditRepositoryConfig(localConfig, statusConfig);
  const worktreeConfigEnabled = localRecords.has("extensions.worktreeconfig")
    ? parseGitBoolean(localRecords.get("extensions.worktreeconfig"), "git_output_invalid")
    : false;
  if (worktreeConfigEnabled) {
    const worktreeConfig = await readRepositoryGitText(
      authority,
      [GIT_NO_LAZY_FETCH_GLOBAL_ARG, "config", "--worktree", "--includes", "--null", "--list"],
      gitCommand
    );
    parseAndAuditRepositoryConfig(worktreeConfig, statusConfig);
  }

  const capturedIndex = await captureRepositoryIndex(authority, paths, gitCommand);
  const excludesPath = statusConfig.excludesPath === undefined
    ? undefined
    : resolveSafeStatusConfigPath(authority.path, statusConfig.excludesPath);
  const attributesPath = statusConfig.attributesPath === undefined
    ? undefined
    : resolveSafeStatusConfigPath(authority.path, statusConfig.attributesPath);
  const observationBase: AuditedDirtyRepository = Object.freeze({
    authority,
    temporaryDirectoryAuthority,
    headCommit,
    paths,
    statusConfig: Object.freeze({
      booleans: Object.freeze(statusConfig.booleans),
      ...(statusConfig.checkStat === undefined ? {} : { checkStat: statusConfig.checkStat }),
      ...(statusConfig.autocrlf === undefined ? {} : { autocrlf: statusConfig.autocrlf }),
      ...(statusConfig.eol === undefined ? {} : { eol: statusConfig.eol }),
      ...(excludesPath === undefined ? {} : {
        excludesFile: captureBoundedStableGitFile(excludesPath, MAX_GIT_STATUS_AUXILIARY_BYTES)
      }),
      ...(attributesPath === undefined ? {} : {
        attributesFile: captureBoundedStableGitFile(attributesPath, MAX_GIT_STATUS_AUXILIARY_BYTES)
      })
    }),
    infoExclude: captureOptionalBoundedStableGitFile(
      join(paths.commonDirectory, "info", "exclude"),
      MAX_GIT_STATUS_AUXILIARY_BYTES
    ),
    infoAttributes: captureOptionalBoundedStableGitFile(
      join(paths.commonDirectory, "info", "attributes"),
      MAX_GIT_STATUS_AUXILIARY_BYTES
    ),
    capturedIndex,
    nested: Object.freeze([])
  });
  const indexObservation = await collectRepositoryGitOutputWithoutHelpers(
    observationBase,
    gitCommand,
    ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"],
    MAX_GIT_INDEX_OUTPUT_BYTES
  );
  assertCapturedRepositoryIndexCurrent(capturedIndex);
  const gitlinks = parseIndexGitlinks(indexObservation);
  const nested: AuditedNestedRepository[] = [];
  for (const gitlink of gitlinks) {
    const nestedObservation = await observeNestedRepositoryState(
      authority,
      gitlink.path,
      gitCommand,
      owner
    );
    if (nestedObservation.state === "absent") {
      nested.push(Object.freeze({
        indexCommit: gitlink.commit,
        path: nestedObservation.path,
        state: "absent"
      }));
    } else if (nestedObservation.state === "deinitialized") {
      nested.push(Object.freeze({
        indexCommit: gitlink.commit,
        path: nestedObservation.path,
        state: "deinitialized",
        identity: nestedObservation.identity
      }));
    } else {
      const nestedHead = await collectRepositoryHeadCommit(nestedObservation.authority, gitCommand);
      nested.push(Object.freeze({
        indexCommit: gitlink.commit,
        path: nestedObservation.path,
        state: "initialized",
        repository: await auditRepositoryForDirtyObservation(
          nestedObservation.authority,
          nestedHead,
          gitCommand,
          temporaryDirectoryAuthority,
          owner
        )
      }));
    }
  }
  return Object.freeze({
    ...observationBase,
    nested: Object.freeze(nested)
  });
}

interface MutableFrozenStatusConfig {
  readonly booleans: Record<string, boolean>;
  checkStat?: "default" | "minimal";
  autocrlf?: "true" | "false" | "input";
  eol?: "lf" | "crlf" | "native";
  excludesPath?: string;
  attributesPath?: string;
}

function parseAndAuditRepositoryConfig(
  config: string,
  statusConfig: MutableFrozenStatusConfig
): ReadonlyMap<string, string | undefined> {
  const values = new Map<string, string | undefined>();
  for (const record of config.split("\0")) {
    if (record === "") continue;
    const separator = record.indexOf("\n");
    const key = (separator === -1 ? record : record.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? "" : record.slice(separator + 1);
    if (/^filter\..+\.(clean|process)$/u.test(key)) {
      throw new StackLockCollectionError("collection_contract_invalid");
    }
    if ([
      "core.filemode",
      "core.symlinks",
      "core.ignorecase",
      "core.precomposeunicode",
      "core.trustctime",
      "core.ignorestat"
    ]
      .includes(key)) {
      statusConfig.booleans[key] = parseGitBoolean(
        separator === -1 ? undefined : value,
        "git_output_invalid"
      );
    } else if (key === "core.checkstat") {
      const normalizedValue = separator === -1 ? "" : value.toLowerCase();
      if (!(normalizedValue === "default" || normalizedValue === "minimal")) {
        throw new StackLockCollectionError("git_output_invalid");
      }
      statusConfig.checkStat = normalizedValue;
    } else if (key === "core.autocrlf") {
      const normalizedValue = separator === -1 ? "true" : value.toLowerCase();
      if (!["true", "false", "input", "yes", "no", "on", "off", "1", "0"]
        .includes(normalizedValue)) {
        throw new StackLockCollectionError("git_output_invalid");
      }
      statusConfig.autocrlf = normalizedValue === "input"
        ? "input"
        : parseGitBoolean(normalizedValue, "git_output_invalid") ? "true" : "false";
    } else if (key === "core.eol") {
      const normalizedValue = separator === -1 ? "" : value.toLowerCase();
      if (!(normalizedValue === "lf" || normalizedValue === "crlf" || normalizedValue === "native")) {
        throw new StackLockCollectionError("git_output_invalid");
      }
      statusConfig.eol = normalizedValue;
    } else if (key === "core.excludesfile") {
      if (separator === -1 || value.length === 0 || value.includes("\0") || value.includes("\n")) {
        throw new StackLockCollectionError("git_output_invalid");
      }
      statusConfig.excludesPath = value;
    } else if (key === "core.attributesfile") {
      if (separator === -1 || value.length === 0 || value.includes("\0") || value.includes("\n")) {
        throw new StackLockCollectionError("git_output_invalid");
      }
      statusConfig.attributesPath = value;
    }
    values.set(key, separator === -1 ? undefined : value);
  }
  return values;
}

function parseGitBoolean(
  value: string | undefined,
  errorCode: "git_output_invalid" | "collection_contract_invalid"
): boolean {
  const normalized = value === undefined ? "true" : value.toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  throw new StackLockCollectionError(errorCode);
}

function resolveSafeStatusConfigPath(checkout: string, configuredPath: string): string {
  try {
    let candidate: string;
    if (configuredPath.startsWith("~/")) {
      const home = env.HOME;
      if (typeof home !== "string" || !isAbsolute(home) || home.includes("\0")) {
        throw new Error("home unavailable");
      }
      candidate = resolve(home, configuredPath.slice(2));
    } else if (configuredPath.startsWith("~")) {
      throw new Error("user home expansion is not admitted");
    } else {
      candidate = isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(checkout, configuredPath);
    }
    if (candidate.includes("\0")) throw new Error("invalid config path");
    return candidate;
  } catch {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

function parseIndexGitlinks(index: string): readonly Readonly<{
  path: string;
  commit: string;
}>[] {
  if (index !== "" && !index.endsWith("\0")) {
    throw new StackLockCollectionError("git_output_invalid");
  }
  const gitlinks = new Map<string, string>();
  const records = index === "" ? [] : index.slice(0, -1).split("\0");
  for (const record of records) {
    if (record.length === 0) throw new StackLockCollectionError("git_output_invalid");
    const tab = record.indexOf("\t");
    if (tab <= 0 || tab === record.length - 1) {
      throw new StackLockCollectionError("git_output_invalid");
    }
    const header = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const fields = header.split(" ");
    if (
      fields.length !== 3 ||
      !/^[0-7]{6}$/u.test(fields[0]!) ||
      !/^[0-9A-Fa-f]{40}$/u.test(fields[1]!) ||
      !/^[0-3]$/u.test(fields[2]!)
    ) {
      throw new StackLockCollectionError("git_output_invalid");
    }
    if (fields[0] !== "160000") continue;
    if (fields[2] !== "0") {
      throw new StackLockCollectionError("collection_contract_invalid");
    }
    if (gitlinks.has(path)) throw new StackLockCollectionError("git_output_invalid");
    gitlinks.set(path, fields[1]!.toLowerCase());
  }
  return Object.freeze([...gitlinks].map(([path, commit]) => Object.freeze({ path, commit })));
}

type NestedRepositoryState = Readonly<
  | { state: "initialized"; path: string; authority: RepositoryCheckoutAuthority }
  | { state: "deinitialized"; path: string; identity: RepositoryRootIdentity }
  | { state: "absent"; path: string }
>;

type OptionalNestedDirectoryObservation = Readonly<
  | { state: "absent" }
  | { state: "present"; identity: RepositoryRootIdentity }
>;

async function observeOptionalNestedDirectory(
  path: string
): Promise<OptionalNestedDirectoryObservation> {
  try {
    return Object.freeze({ state: "present", identity: await observeRepositoryRootIdentity(path) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ state: "absent" });
    }
    throw error;
  }
}

async function observeNestedRepositoryState(
  parent: RepositoryCheckoutAuthority,
  nestedPath: string,
  gitCommand: StackLockGitCommand,
  owner: RepositoryCheckoutAuthorityOwner
): Promise<NestedRepositoryState> {
  try {
    const resolvedNestedPath = await resolveWorkspacePath({
      workspaceRoot: parent.path,
      inputPath: nestedPath,
      evidenceRef: "stack-lock-nested-submodule-filter-audit",
      access: "read"
    });
    const path = join(parent.path, resolvedNestedPath.normalizedPath);
    const pathBefore = await observeOptionalNestedDirectory(path);
    if (pathBefore.state === "absent") {
      const pathAfter = await observeOptionalNestedDirectory(path);
      if (pathAfter.state !== "absent") {
        throw new StackLockCollectionError("collection_state_changed");
      }
      return Object.freeze({ state: "absent", path });
    }
    let dotGitPresent = true;
    try {
      await lstat(join(path, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      dotGitPresent = false;
    }
    const pathAfter = await observeOptionalNestedDirectory(path);
    if (
      pathAfter.state !== "present" ||
      !sameRepositoryRootIdentity(pathBefore.identity, pathAfter.identity)
    ) {
      throw new StackLockCollectionError("collection_state_changed");
    }
    if (!dotGitPresent) {
      return Object.freeze({ state: "deinitialized", path, identity: pathAfter.identity });
    }
    const authority = await resolveRepositoryCheckoutAuthority(
      parent.path,
      nestedPath,
      {},
      owner
    );
    await assertNestedRepositoryGitTopLevel(authority, gitCommand);
    return Object.freeze({ state: "initialized", path, authority });
  } catch (error) {
    if (error instanceof StackLockCollectionError) throw error;
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

async function observeAuditedRepositoryDirty(
  audit: AuditedDirtyRepository,
  gitCommand: StackLockGitCommand
): Promise<boolean> {
  const stdout = await collectRepositoryStatusWithoutHelpers(audit, gitCommand);
  if (stdout.length > 0) return true;
  for (const nested of audit.nested) {
    if (nested.state === "absent") {
      await assertNestedRepositoryRemainsAbsent(nested);
      return true;
    }
    if (nested.state === "deinitialized") {
      await assertNestedRepositoryRemainsDeinitialized(nested);
      continue;
    }
    const currentHead = await collectRepositoryHeadCommit(nested.repository.authority, gitCommand);
    if (currentHead !== nested.indexCommit) return true;
    if (await observeAuditedRepositoryDirty(nested.repository, gitCommand)) return true;
  }
  return false;
}

async function assertNestedRepositoryRemainsAbsent(
  nested: Extract<AuditedNestedRepository, { state: "absent" }>
): Promise<void> {
  try {
    const current = await observeOptionalNestedDirectory(nested.path);
    if (current.state !== "absent") throw new Error("nested path appeared");
  } catch {
    throw new StackLockCollectionError("collection_state_changed");
  }
}

async function assertNestedRepositoryRemainsDeinitialized(
  nested: Extract<AuditedNestedRepository, { state: "deinitialized" }>
): Promise<void> {
  try {
    const current = await observeRepositoryRootIdentity(nested.path);
    if (!sameRepositoryRootIdentity(current, nested.identity)) {
      throw new Error("nested path changed");
    }
    try {
      await lstat(join(nested.path, ".git"));
      throw new Error("nested checkout initialized");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch {
    throw new StackLockCollectionError("collection_state_changed");
  }
}

interface RepositoryGitAdministrativePaths {
  readonly gitDirectory: string;
  readonly commonDirectory: string;
  readonly indexPath: string;
  readonly objectDirectory: string;
}

async function collectRepositoryStatusWithoutHelpers(
  audit: AuditedDirtyRepository,
  gitCommand: StackLockGitCommand
): Promise<string> {
  return await collectRepositoryGitOutputWithoutHelpers(
    audit,
    gitCommand,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--"
    ],
    MAX_GIT_OUTPUT_BYTES
  );
}

async function collectRepositoryGitOutputWithoutHelpers(
  audit: AuditedDirtyRepository,
  gitCommand: StackLockGitCommand,
  commandArgs: readonly string[],
  maxOutputBytes: number
): Promise<string> {
  let frozenDirectory: string | undefined;
  let frozenIdentity: RepositoryRootIdentity | undefined;
  let stdout: string | undefined;
  let primaryError: unknown;
  try {
    frozenDirectory = createExternalFrozenGitDirectory(audit.temporaryDirectoryAuthority);
    try {
      frozenIdentity = observeRepositoryRootIdentitySync(frozenDirectory);
    } catch {
      try {
        rmSync(frozenDirectory, { recursive: true, force: true });
      } catch {
        // The stable typed failure below takes precedence over cleanup details.
      }
      frozenDirectory = undefined;
      throw new StackLockCollectionError("collection_contract_invalid");
    }
    mkdirSync(join(frozenDirectory, "refs"), { mode: 0o700 });
    mkdirSync(join(frozenDirectory, "objects"), { mode: 0o700 });
    mkdirSync(join(frozenDirectory, "info"), { mode: 0o700 });
    writeFileSync(
      join(frozenDirectory, "HEAD"),
      `${audit.headCommit}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    writeFileSync(
      join(frozenDirectory, "config"),
      frozenStatusConfig(audit.statusConfig, frozenDirectory),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    writeCapturedGitFile(audit.capturedIndex.index, join(frozenDirectory, "index"));
    if (audit.capturedIndex.sharedIndex !== undefined) {
      writeCapturedGitFile(
        audit.capturedIndex.sharedIndex.file,
        join(frozenDirectory, audit.capturedIndex.sharedIndex.name)
      );
    }
    if (audit.infoExclude !== undefined) {
      writeCapturedGitFile(audit.infoExclude, join(frozenDirectory, "info", "exclude"));
    }
    if (audit.infoAttributes !== undefined) {
      writeCapturedGitFile(audit.infoAttributes, join(frozenDirectory, "info", "attributes"));
    }
    if (audit.statusConfig.excludesFile !== undefined) {
      writeCapturedGitFile(
        audit.statusConfig.excludesFile,
        join(frozenDirectory, "info", "core-excludes")
      );
    }
    if (audit.statusConfig.attributesFile !== undefined) {
      writeCapturedGitFile(
        audit.statusConfig.attributesFile,
        join(frozenDirectory, "info", "core-attributes")
      );
    }
    stdout = await readRepositoryGitText(
      audit.authority,
      [
        GIT_NO_LAZY_FETCH_GLOBAL_ARG,
        `--git-dir=${frozenDirectory}`,
        "--work-tree=.",
        ...commandArgs
      ],
      withGitObjectDirectory(gitCommand, checkoutRelativeObjectDirectory(
        audit.authority.path,
        audit.paths.objectDirectory
      )),
      maxOutputBytes
    );
  } catch (error) {
    primaryError = error instanceof StackLockCollectionError
      ? error
      : new StackLockCollectionError("collection_contract_invalid");
  }

  let cleanupFailed = false;
  if (frozenDirectory !== undefined && frozenIdentity !== undefined) {
    cleanupFailed = !removeOwnedFrozenGitDirectory(frozenDirectory, frozenIdentity);
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupFailed) throw new StackLockCollectionError("collection_contract_invalid");
  return stdout!;
}

function createExternalFrozenGitDirectory(
  authority: CollectionTemporaryDirectoryAuthority
): string {
  try {
    const current = observeRepositoryRootIdentitySync(authority.parent);
    if (!sameRepositoryRootIdentity(current, authority.identity)) {
      throw new StackLockCollectionError("collection_state_changed");
    }
    return authority.create(join(authority.parent, "stack-lock-status-"));
  } catch (error) {
    if (error instanceof StackLockCollectionError) throw error;
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

function checkoutRelativeObjectDirectory(checkout: string, objectDirectory: string): string {
  const relativePath = relative(checkout, objectDirectory);
  return (
    relativePath !== "" &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  ) ? relativePath : objectDirectory;
}

function withGitObjectDirectory(
  gitCommand: StackLockGitCommand,
  objectDirectory: string
): StackLockGitCommand {
  return async (input) => await gitCommand(Object.freeze({ ...input, gitObjectDirectory: objectDirectory }));
}

async function captureRepositoryIndex(
  _authority: RepositoryCheckoutAuthority,
  paths: RepositoryGitAdministrativePaths,
  _gitCommand: StackLockGitCommand
): Promise<CapturedRepositoryIndex> {
  const index = captureBoundedStableGitFile(paths.indexPath, MAX_GIT_INDEX_OUTPUT_BYTES);
  const sharedName = referencedSharedIndexName(index.bytes);
  const sharedIndex = sharedName === undefined
    ? undefined
    : Object.freeze({
        name: sharedName,
        file: captureBoundedStableGitFile(
          join(paths.gitDirectory, sharedName),
          MAX_GIT_INDEX_OUTPUT_BYTES
        )
      });
  assertCapturedGitFileCurrent(index);
  if (sharedIndex !== undefined) assertCapturedGitFileCurrent(sharedIndex.file);
  return Object.freeze({ index, ...(sharedIndex === undefined ? {} : { sharedIndex }) });
}

function referencedSharedIndexName(indexBytes: Uint8Array): string | undefined {
  const index = Buffer.from(indexBytes);
  const checksumStart = index.byteLength - 20;
  if (
    index.byteLength < 32 ||
    index.subarray(0, 4).toString("ascii") !== "DIRC" ||
    ![2, 3, 4].includes(index.readUInt32BE(4))
  ) {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  const candidates: number[] = [];
  for (let offset = 12; offset + 28 <= checksumStart; offset += 1) {
    if (index.subarray(offset, offset + 4).toString("ascii") !== "link") continue;
    const size = index.readUInt32BE(offset + 4);
    if (size < 20 || offset + 8 + size > checksumStart) continue;
    if (isValidIndexExtensionChain(index, offset, checksumStart)) candidates.push(offset);
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  const hash = index.subarray(candidates[0]! + 8, candidates[0]! + 28).toString("hex");
  return `sharedindex.${hash}`;
}

function isValidIndexExtensionChain(index: Buffer, start: number, end: number): boolean {
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return false;
    const signature = index.subarray(offset, offset + 4).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(signature)) return false;
    const size = index.readUInt32BE(offset + 4);
    offset += 8 + size;
    if (offset > end) return false;
  }
  return offset === end;
}

function assertCapturedRepositoryIndexCurrent(captured: CapturedRepositoryIndex): void {
  assertCapturedGitFileCurrent(captured.index);
  if (captured.sharedIndex !== undefined) assertCapturedGitFileCurrent(captured.sharedIndex.file);
}

function captureOptionalBoundedStableGitFile(
  source: string,
  maxBytes: number
): CapturedGitFile | undefined {
  try {
    lstatSync(source, { bigint: true });
    return captureBoundedStableGitFile(source, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof StackLockCollectionError) throw error;
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

function captureBoundedStableGitFile(source: string, maxBytes: number): CapturedGitFile {
  let descriptor: number | undefined;
  let primaryError: unknown;
  let captured: CapturedGitFile | undefined;
  try {
    const pathBefore = lstatSync(source, { bigint: true });
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      pathBefore.nlink !== 1n ||
      pathBefore.size > BigInt(maxBytes)
    ) {
      throw new Error("invalid Git observation file");
    }
    descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      openedBefore.dev !== pathBefore.dev ||
      openedBefore.ino !== pathBefore.ino ||
      openedBefore.size !== pathBefore.size ||
      openedBefore.size > BigInt(maxBytes)
    ) {
      throw new Error("Git observation file changed before read");
    }
    const bytes = Buffer.alloc(Number(openedBefore.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error("short Git observation file");
      offset += count;
    }
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(source, { bigint: true });
    if (
      pathAfter.dev !== pathBefore.dev ||
      pathAfter.ino !== pathBefore.ino ||
      pathAfter.size !== pathBefore.size ||
      pathAfter.ctimeNs !== pathBefore.ctimeNs ||
      pathAfter.mtimeNs !== pathBefore.mtimeNs ||
      openedAfter.dev !== openedBefore.dev ||
      openedAfter.ino !== openedBefore.ino ||
      openedAfter.size !== openedBefore.size ||
      openedAfter.ctimeNs !== openedBefore.ctimeNs ||
      openedAfter.mtimeNs !== openedBefore.mtimeNs
    ) {
      throw new Error("Git observation file changed while reading");
    }
    captured = Object.freeze({
      bytes: Uint8Array.from(bytes),
      atimeMs: Number(pathBefore.atimeMs),
      mtimeMs: Number(pathBefore.mtimeMs),
      source,
      identity: Object.freeze({
        dev: pathBefore.dev,
        ino: pathBefore.ino,
        size: pathBefore.size,
        ctimeNs: pathBefore.ctimeNs,
        mtimeNs: pathBefore.mtimeNs
      })
    });
  } catch (error) {
    primaryError = error;
  }
  let closeFailed = false;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch {
      closeFailed = true;
    }
  }
  if (primaryError !== undefined || closeFailed) {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  return captured!;
}

function assertCapturedGitFileCurrent(captured: CapturedGitFile): void {
  try {
    const current = lstatSync(captured.source, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== captured.identity.dev ||
      current.ino !== captured.identity.ino ||
      current.size !== captured.identity.size ||
      current.ctimeNs !== captured.identity.ctimeNs ||
      current.mtimeNs !== captured.identity.mtimeNs
    ) {
      throw new Error("captured Git file changed");
    }
  } catch {
    throw new StackLockCollectionError("collection_state_changed");
  }
}

function writeCapturedGitFile(captured: CapturedGitFile, destination: string): void {
  writeFileSync(destination, captured.bytes, { flag: "wx", mode: 0o600 });
  utimesSync(destination, new Date(captured.atimeMs), new Date(captured.mtimeMs));
}

function frozenStatusConfig(statusConfig: FrozenStatusConfig, frozenDirectory: string): string {
  const booleanValue = (key: string, fallback: boolean): string =>
    (statusConfig.booleans[key] ?? fallback) ? "true" : "false";
  return `[core]\n` +
    `\trepositoryformatversion = 0\n` +
    `\tbare = false\n` +
    `\tfilemode = ${booleanValue("core.filemode", platform() !== "win32")}\n` +
    `\tsymlinks = ${booleanValue("core.symlinks", platform() !== "win32")}\n` +
    `\tignorecase = ${booleanValue("core.ignorecase", platform() === "win32")}\n` +
    `\tprecomposeunicode = ${booleanValue("core.precomposeunicode", false)}\n` +
    `\ttrustctime = ${booleanValue("core.trustctime", true)}\n` +
    `\tcheckStat = ${statusConfig.checkStat ?? "default"}\n` +
    `\tignoreStat = ${booleanValue("core.ignorestat", false)}\n` +
    (statusConfig.autocrlf === undefined ? "" : `\tautocrlf = ${statusConfig.autocrlf}\n`) +
    (statusConfig.eol === undefined ? "" : `\teol = ${statusConfig.eol}\n`) +
    (statusConfig.excludesFile === undefined
      ? ""
      : `\texcludesFile = ${quoteGitConfigValue(join(frozenDirectory, "info", "core-excludes"))}\n`) +
    (statusConfig.attributesFile === undefined
      ? ""
      : `\tattributesFile = ${quoteGitConfigValue(join(frozenDirectory, "info", "core-attributes"))}\n`);
}

function quoteGitConfigValue(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new StackLockCollectionError("collection_contract_invalid");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

async function resolveRepositoryGitAdministrativePaths(
  authority: RepositoryCheckoutAuthority
): Promise<RepositoryGitAdministrativePaths> {
  try {
    const dotGit = join(authority.path, ".git");
    const dotGitStat = await lstat(dotGit);
    let gitDirectory: string;
    if (dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink()) {
      gitDirectory = await realpath(dotGit);
    } else if (dotGitStat.isFile() && !dotGitStat.isSymbolicLink()) {
      const link = await readDurableSingleLinkFile({
        path: dotGit,
        maxBytes: MAX_GIT_ADMIN_PATH_BYTES,
        validateParentPath: async () => await isSafeExistingDirectoryPath(authority.path)
      });
      if (link.status !== "read") throw new Error("unreadable gitdir link");
      const target = parseGitAdministrativePathFile(link.bytes, "gitdir: ");
      gitDirectory = await realpath(resolve(authority.path, target));
    } else {
      throw new Error("unsupported gitdir entry");
    }
    if (!(await isSafeExistingDirectoryPath(gitDirectory))) {
      throw new Error("unsafe gitdir");
    }

    let commonDirectory = gitDirectory;
    const commonPath = join(gitDirectory, "commondir");
    const common = await readDurableSingleLinkFile({
      path: commonPath,
      maxBytes: MAX_GIT_ADMIN_PATH_BYTES,
      validateParentPath: async () => await isSafeExistingDirectoryPath(gitDirectory)
    });
    if (common.status === "read") {
      commonDirectory = await realpath(resolve(gitDirectory, parseGitAdministrativePathFile(
        common.bytes,
        ""
      )));
    } else if (common.status !== "missing") {
      throw new Error("unreadable commondir");
    }
    const objectDirectory = await realpath(join(commonDirectory, "objects"));
    if (
      !(await isSafeExistingDirectoryPath(commonDirectory)) ||
      !(await isSafeExistingDirectoryPath(objectDirectory))
    ) {
      throw new Error("unsafe common git directory");
    }
    return Object.freeze({
      gitDirectory,
      commonDirectory,
      indexPath: join(gitDirectory, "index"),
      objectDirectory
    });
  } catch (error) {
    if (error instanceof StackLockCollectionError) throw error;
    throw new StackLockCollectionError("collection_contract_invalid");
  }
}

function parseGitAdministrativePathFile(bytes: Uint8Array, prefix: string): string {
  const text = UTF8_DECODER.decode(bytes);
  if (!text.endsWith("\n") || text.includes("\0")) throw new Error("invalid git path file");
  const value = text.slice(0, -1).replace(/\r$/u, "");
  if (!value.startsWith(prefix)) throw new Error("invalid git path prefix");
  const path = value.slice(prefix.length);
  if (path.length === 0 || path.includes("\n")) throw new Error("invalid git path value");
  return path;
}

function observeRepositoryRootIdentitySync(path: string): RepositoryRootIdentity {
  const observation = lstatSync(path, { bigint: true });
  if (observation.isSymbolicLink() || !observation.isDirectory()) {
    throw new Error("repository root is not a physical directory");
  }
  return Object.freeze({ dev: observation.dev, ino: observation.ino });
}

function removeOwnedFrozenGitDirectory(
  directory: string,
  identity: RepositoryRootIdentity
): boolean {
  try {
    const current = observeRepositoryRootIdentitySync(directory);
    if (!sameRepositoryRootIdentity(identity, current)) return false;
    rmSync(directory, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function isStackLockRepositoryName(value: string): value is StackLockRepositoryName {
  return (STACK_LOCK_REPOSITORY_NAMES as readonly string[]).includes(value);
}

interface ReadOnlyGitExecOptions {
  readonly cwd: string;
  readonly encoding: null;
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type StackLockGitProcessExecutor = (
  file: string,
  args: readonly string[],
  options: ReadOnlyGitExecOptions,
  callback: (error: Error | null, stdout: unknown, stderr: unknown) => void
) => unknown;

async function createDefaultGitCommand(): Promise<StackLockGitCommand> {
  const gitExecutable = await resolveTrustedGitExecutable(env);
  return async (input) => await runReadOnlyGitCommandWithExecutor(
    input,
    execFile as StackLockGitProcessExecutor,
    gitExecutable
  );
}

function runReadOnlyGitCommandWithExecutor(
  input: StackLockGitCommandInput,
  executor: StackLockGitProcessExecutor,
  gitExecutable: string
): Promise<StackLockGitCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    try {
      const descriptorBound = input.cwdIdentity !== undefined;
      const identity = input.cwdIdentity;
      const commandFile = descriptorBound ? "/bin/sh" : gitExecutable;
      const commandArgs = descriptorBound
        ? [
            "-c",
            descriptorBoundGitScript(),
            "stack-lock-git",
            `${identity!.dev}:${identity!.ino}`,
            gitExecutable,
            ...input.args
          ]
        : [...input.args];
      executor(
        commandFile,
        commandArgs,
        {
          cwd: input.cwd,
          encoding: null,
          env: readOnlyGitEnvironment(env, input.gitObjectDirectory),
          maxBuffer: input.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true
        },
        (error: Error | null, stdout: unknown, stderr: unknown) => {
          if (error) {
            const errorCode = (error as Error & { code?: unknown }).code;
            if (errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              rejectCommand(new StackLockCollectionError("git_output_invalid"));
            } else if (
              descriptorBound &&
              (errorCode === 73 || errorCode === "73") &&
              boundedStderrEquals(stderr, `${CWD_IDENTITY_MISMATCH_MARKER}\n`)
            ) {
              rejectCommand(new StackLockCollectionError("collection_state_changed"));
            } else {
              rejectCommand(new StackLockCollectionError("git_read_failed"));
            }
            return;
          }
          if (typeof stdout !== "string" && !(stdout instanceof Uint8Array)) {
            rejectCommand(new StackLockCollectionError("git_output_invalid"));
            return;
          }
          void stderr;
          resolveCommand(Object.freeze({ stdout }));
        }
      );
    } catch {
      rejectCommand(new StackLockCollectionError("git_read_failed"));
    }
  });
}

function descriptorBoundGitScript(): string {
  const statCommand = platform() === "darwin"
    ? "/usr/bin/stat -f '%d:%i' ."
    : "/usr/bin/stat -c '%d:%i' .";
  return `actual=$(${statCommand}) || { printf '%s\\n' '${CWD_IDENTITY_MISMATCH_MARKER}' >&2; exit 73; }
[ "$actual" = "$1" ] || { printf '%s\\n' '${CWD_IDENTITY_MISMATCH_MARKER}' >&2; exit 73; }
git_executable=$2
shift 2
exec "$git_executable" "$@"`;
}

/** Internal deterministic seam for the collector's process-boundary tests; not barrel-exported. */
export function __runReadOnlyGitCommandForTest(
  input: StackLockGitCommandInput,
  executor: StackLockGitProcessExecutor,
  gitExecutable = "/usr/bin/git"
): Promise<StackLockGitCommandResult> {
  return runReadOnlyGitCommandWithExecutor(input, executor, gitExecutable);
}

function boundedStderrEquals(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (value instanceof Uint8Array) return Buffer.from(value).equals(Buffer.from(expected, "utf8"));
  return false;
}

async function resolveTrustedGitExecutable(source: NodeJS.ProcessEnv): Promise<string> {
  const pathValue = platform() === "win32" ? (source.Path ?? source.PATH) : source.PATH;
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.includes("\0")) {
    throw new StackLockCollectionError("git_read_failed");
  }
  const components = pathValue.split(delimiter);
  if (components.some((component) => component.length === 0 || !isAbsolute(component))) {
    throw new StackLockCollectionError("git_read_failed");
  }
  const executableName = platform() === "win32" ? "git.exe" : "git";
  for (const component of components) {
    const candidate = join(component, executableName);
    try {
      await access(candidate, constants.X_OK);
      const physical = await realpath(candidate);
      if (!isAbsolute(physical)) continue;
      const executableStat = await lstat(physical);
      if (!executableStat.isFile()) continue;
      return physical;
    } catch {
      // Continue searching only within the already-validated absolute PATH.
    }
  }
  throw new StackLockCollectionError("git_read_failed");
}

/** Internal filesystem-order seam; not barrel-exported. */
export async function __resolveRepositoryCheckoutAuthorityForTest(
  repositoryRoot: string,
  relativePath: string,
  testHooks: StackLockCollectorTestHooks
): Promise<void> {
  const authority = await resolveRepositoryCheckoutAuthority(repositoryRoot, relativePath, testHooks);
  await authority.directory.close();
}

const GIT_CHILD_POSIX_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE"
] as const);
const GIT_CHILD_WINDOWS_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT"
] as const);

function readOnlyGitEnvironment(
  source: NodeJS.ProcessEnv,
  gitObjectDirectory?: string
): NodeJS.ProcessEnv {
  if (
    gitObjectDirectory !== undefined &&
    (
      gitObjectDirectory.length === 0 ||
      gitObjectDirectory.includes("\0") ||
      (isAbsolute(gitObjectDirectory) && resolve(gitObjectDirectory) !== gitObjectDirectory) ||
      (!isAbsolute(gitObjectDirectory) && gitObjectDirectory
        .split(sep)
        .some((component) => component === "" || component === "." || component === ".."))
    )
  ) {
    throw new StackLockCollectionError("git_read_failed");
  }
  const sanitized: NodeJS.ProcessEnv = {};
  const allowlist = platform() === "win32"
    ? GIT_CHILD_WINDOWS_ENVIRONMENT_ALLOWLIST
    : GIT_CHILD_POSIX_ENVIRONMENT_ALLOWLIST;
  for (const key of allowlist) {
    const value = source[key];
    if (typeof value === "string" && !value.includes("\0")) sanitized[key] = value;
  }
  return {
    ...sanitized,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...(gitObjectDirectory === undefined ? {} : { GIT_OBJECT_DIRECTORY: gitObjectDirectory })
  };
}

interface GitmoduleDeclaration {
  readonly path: string;
  readonly branch: string;
}

interface GitmodulesIdentity {
  readonly declarations: Readonly<Record<StackLockRepositoryName, GitmoduleDeclaration>>;
  readonly objectId: string;
  readonly sourceDigest: string;
}

async function readHeadGitmodulesIdentity(
  repositoryRoot: string,
  objectId: string,
  gitCommand: StackLockGitCommand
): Promise<GitmodulesIdentity> {
  let rawResult: unknown;
  try {
    rawResult = await gitCommand({
      cwd: repositoryRoot,
      args: Object.freeze([
        GIT_NO_LAZY_FETCH_GLOBAL_ARG,
        "cat-file",
        "blob",
        objectId
      ])
    });
  } catch {
    throw new StackLockCollectionError("git_read_failed");
  }

  try {
    const bytes = boundedGitOutputBytes(
      asRecord(rawResult)?.stdout,
      MAX_GITMODULES_FILE_BYTES
    );
    if (bytes.includes(0)) {
      throw new Error("invalid gitmodules blob output");
    }
    const text = UTF8_DECODER.decode(bytes);
    return Object.freeze({
      declarations: parseGitmoduleDeclarations(text),
      objectId,
      sourceDigest: createHash("sha256").update(bytes).digest("hex")
    });
  } catch {
    throw new StackLockCollectionError("gitmodules_invalid");
  }
}

function parseGitmoduleDeclarations(
  text: string
): Readonly<Record<StackLockRepositoryName, GitmoduleDeclaration>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[submodule "([^"]+)"\]$/u.exec(line);
    if (section) {
      const name = section[1]!;
      if (!isStackLockRepositoryName(name) || sections.has(name)) {
        throw new Error("invalid submodule inventory");
      }
      current = new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const property = /^([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*)$/u.exec(line);
    if (!current || !property) throw new Error("invalid gitmodules syntax");
    const key = property[1]!.toLowerCase();
    const value = property[2]!.trim();
    if (!(["path", "url", "branch"] as const).includes(key as "path" | "url" | "branch")) {
      throw new Error("unknown gitmodules property");
    }
    if (current.has(key) || !isBoundedGitmoduleValue(value)) {
      throw new Error("invalid gitmodules property");
    }
    current.set(key, value);
  }

  if (sections.size !== STACK_LOCK_REPOSITORY_NAMES.length) {
    throw new Error("incomplete submodule inventory");
  }
  const entries = STACK_LOCK_REPOSITORY_NAMES.map((name) => {
    const section = sections.get(name);
    const path = section?.get("path");
    const branch = section?.get("branch");
    const url = section?.get("url");
    if (
      section?.size !== 3 ||
      path === undefined ||
      branch === undefined ||
      url === undefined ||
      !isSafeBranchDeclaration(branch)
    ) {
      throw new Error("incomplete submodule declaration");
    }
    return [name, Object.freeze({ path, branch })] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<StackLockRepositoryName, GitmoduleDeclaration>
  >;
}

function boundedGitOutputBytes(value: unknown, maxBytes: number): Buffer {
  let bytes: Buffer;
  if (typeof value === "string") {
    bytes = Buffer.from(value, "utf8");
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw new Error("invalid git output type");
  }
  if (bytes.byteLength > maxBytes) throw new Error("git output exceeds bound");
  return bytes;
}

function isBoundedGitmoduleValue(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

function isSafeBranchDeclaration(value: string): boolean {
  return (
    value.length <= 255 &&
    !/\s|\\|\.\.|@\{|\*|\?|\[|\^|~|:|\x7f/u.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function assertExpectedGitmodules(gitmodules: GitmodulesIdentity): void {
  for (const name of STACK_LOCK_REPOSITORY_NAMES) {
    const actual = gitmodules.declarations[name];
    const expected = EXPECTED_GITMODULE_DECLARATIONS[name];
    if (actual.path !== expected.path || actual.branch !== expected.branch) {
      throw new StackLockCollectionError("gitmodules_invalid");
    }
  }
}

interface HarnessIdentity {
  readonly version: string;
  readonly sourceDigest: string;
}

async function readHarnessVersion(repositoryRoot: string): Promise<HarnessIdentity> {
  const source = await readBoundedRepositoryJson(
    repositoryRoot,
    PACKAGE_JSON_RELATIVE_PATH,
    "package_json_invalid"
  );
  const version = boundedNonBlankString(source.document.version);
  if (version === undefined) {
    throw new StackLockCollectionError("package_json_invalid");
  }
  return Object.freeze({ version, sourceDigest: source.sha256 });
}

interface ProviderIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly sourceDigest: string;
}

async function readProviderIdentity(repositoryRoot: string): Promise<ProviderIdentity> {
  const source = await readBoundedRepositoryJson(
    repositoryRoot,
    PROVIDER_CONFIG_RELATIVE_PATH,
    "provider_config_invalid"
  );
  const { document } = source;
  const provider = boundedNonBlankString(document.default_provider);
  const defaultModel = boundedNonBlankString(document.default_model);
  const targetModelId = boundedNonBlankString(document.target_model_id);
  const selector = defaultModel?.split("/");
  const selectedProvider = selector?.length === 2 ? boundedNonBlankString(selector[0]) : undefined;
  const selectedModel = selector?.length === 2 ? boundedNonBlankString(selector[1]) : undefined;
  const providers = asRecord(document.providers);
  const providerDocument = provider === undefined ? undefined : asRecord(providers?.[provider]);
  const baseUrl = boundedNonBlankString(providerDocument?.base_url, 2048);
  const models = asRecord(providerDocument?.models);
  const selectedModelDocument =
    selectedModel === undefined ? undefined : asRecord(models?.[selectedModel]);
  const nestedModelId = boundedNonBlankString(selectedModelDocument?.model_id);

  if (
    provider === undefined ||
    selectedProvider !== provider ||
    selectedModel === undefined ||
    targetModelId === undefined ||
    baseUrl === undefined ||
    nestedModelId !== targetModelId ||
    !isSafeProviderBaseUrl(baseUrl)
  ) {
    throw new StackLockCollectionError("provider_config_invalid");
  }

  return Object.freeze({
    provider,
    modelId: targetModelId,
    baseUrl,
    sourceDigest: source.sha256
  });
}

function isSafeProviderBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

async function readBoundedRepositoryJson(
  repositoryRoot: string,
  relativePath: string,
  errorCode: "package_json_invalid" | "provider_config_invalid"
): Promise<{
  readonly document: Record<string, unknown>;
  readonly sha256: string;
}> {
  let absolutePath: string;
  try {
    const resolution = await resolveWorkspacePath({
      workspaceRoot: repositoryRoot,
      inputPath: relativePath,
      evidenceRef: `stack-lock.${relativePath}`,
      access: "read"
    });
    absolutePath = resolution.absolutePath;
  } catch {
    throw new StackLockCollectionError(errorCode);
  }

  const result = await readDurableSingleLinkFile({
    path: absolutePath,
    maxBytes: MAX_JSON_FILE_BYTES,
    validateParentPath: async () => await isSafeExistingDirectoryPath(dirname(absolutePath))
  });
  if (result.status !== "read") {
    throw new StackLockCollectionError(errorCode);
  }

  let text: string;
  let parsed: unknown;
  try {
    text = UTF8_DECODER.decode(result.bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StackLockCollectionError(errorCode);
  }
  const document = asRecord(parsed);
  if (!document) throw new StackLockCollectionError(errorCode);
  return Object.freeze({
    document,
    sha256: createHash("sha256").update(result.bytes).digest("hex")
  });
}

async function collectRPackagesLock(
  repositoryRoot: string,
  fileHasher: StackLockFileHasher
): Promise<{
  readonly value: StackLock["runtime"]["r_packages_lock"];
  readonly degraded: readonly StackLockDegradedReason[];
}> {
  const absolutePath = join(repositoryRoot, R_PACKAGES_LOCK_RELATIVE_PATH);
  try {
    await lstat(absolutePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return Object.freeze({
        value: null,
        degraded: Object.freeze([STACK_LOCK_RENV_MISSING])
      });
    }
    throw new StackLockCollectionError("renv_lock_invalid");
  }

  let sha256: string;
  try {
    sha256 = await fileHasher({
      workspaceRoot: repositoryRoot,
      inputPath: R_PACKAGES_LOCK_RELATIVE_PATH,
      evidenceRef: "stack-lock.runtime.r_packages_lock",
      maxBytes: STACK_LOCK_RENV_MAX_BYTES
    });
  } catch {
    throw new StackLockCollectionError("renv_lock_invalid");
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new StackLockCollectionError("renv_lock_invalid");
  }
  return Object.freeze({
    value: Object.freeze({ path: R_PACKAGES_LOCK_RELATIVE_PATH, sha256 }),
    degraded: Object.freeze([])
  });
}

function collectRuntimeVersions(
  rPackagesLock: StackLock["runtime"]["r_packages_lock"]
): StackLock["runtime"] {
  return Object.freeze({
    os: `${platform()} ${release()}`,
    r_version: STACK_LOCK_UNKNOWN_VERSION,
    r_packages_lock: rPackagesLock,
    python_version: STACK_LOCK_UNKNOWN_VERSION,
    sundials_version: STACK_LOCK_UNKNOWN_VERSION,
    gcc_version: STACK_LOCK_UNKNOWN_VERSION,
    gdal_version: STACK_LOCK_UNKNOWN_VERSION
  });
}

function freezeCollectionResult(
  content: StackLockCollectedContent,
  degraded: readonly StackLockDegradedReason[]
): StackLockCollectionResult {
  const repos = Object.freeze({
    SHUD: Object.freeze({ ...content.repos.SHUD }),
    rSHUD: Object.freeze({ ...content.repos.rSHUD }),
    AutoSHUD: Object.freeze({ ...content.repos.AutoSHUD }),
    zero: Object.freeze({ ...content.repos.zero })
  });
  const runtime = Object.freeze({
    ...content.runtime,
    r_packages_lock:
      content.runtime.r_packages_lock === null
        ? null
        : Object.freeze({ ...content.runtime.r_packages_lock })
  });
  return Object.freeze({
    repos,
    runtime,
    harness: Object.freeze({ ...content.harness }),
    llm: Object.freeze({ ...content.llm }),
    degraded: Object.freeze([...degraded])
  });
}

function boundedNonBlankString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
