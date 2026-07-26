import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { devNull, platform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
const GIT_TIMEOUT_MS = 10_000;
const GIT_NO_LAZY_FETCH_GLOBAL_ARG = "--no-lazy-fetch";
const GITLINK_PATTERN = /^160000 commit ([0-9A-Fa-f]{40})\t([^\0]+)$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type StackLockRepositoryName = (typeof STACK_LOCK_REPOSITORY_NAMES)[number];
export type StackLockDegradedReason = typeof STACK_LOCK_RENV_MISSING;
export type StackLockCollectedContent = Pick<StackLock, "repos" | "runtime" | "harness" | "llm">;

export interface StackLockCollectionResult extends StackLockCollectedContent {
  readonly degraded: readonly StackLockDegradedReason[];
}

export interface StackLockGitCommandInput {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface StackLockGitCommandResult {
  readonly stdout: string;
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
  fileHasher: StackLockFileHasher
): Promise<StackLockCollectionResult> {
  return await collectStackLockContextWithHasher(options, fileHasher);
}

async function collectStackLockContextWithHasher(
  options: CollectStackLockContextOptions,
  fileHasher: StackLockFileHasher
): Promise<StackLockCollectionResult> {
  const repositoryRoot = await resolveRepositoryRoot(options.repositoryRoot);
  const gitCommand = options.gitCommand ?? runReadOnlyGitCommand;
  const firstCheap = await collectCheapSnapshot(repositoryRoot, gitCommand);
  assertExpectedGitmodules(firstCheap.gitmodules);
  const first = await completeSnapshot(repositoryRoot, firstCheap, fileHasher);
  const secondCheap = await collectCheapSnapshot(repositoryRoot, gitCommand);
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

  return freezeCollectionResult(content, rPackagesLock.degraded);
}

interface StackLockCheapSnapshot {
  readonly repositoryRoot: string;
  readonly repos: StackLock["repos"];
  readonly harness: HarnessIdentity;
  readonly provider: ProviderIdentity;
  readonly gitmodules: GitmodulesIdentity;
}

interface StackLockCollectionSnapshot extends StackLockCheapSnapshot {
  readonly rPackagesLock: Awaited<ReturnType<typeof collectRPackagesLock>>;
}

async function collectCheapSnapshot(
  repositoryRoot: string,
  gitCommand: StackLockGitCommand
): Promise<StackLockCheapSnapshot> {
  const reportedRepositoryRoot = await collectRepositoryRootIdentity(repositoryRoot, gitCommand);
  const [revisions, harness, provider, gitmodules] = await Promise.all([
    collectGitlinkRevisions(reportedRepositoryRoot, gitCommand),
    readHarnessVersion(reportedRepositoryRoot),
    readProviderIdentity(reportedRepositoryRoot),
    readGitmodulesIdentity(reportedRepositoryRoot)
  ]);
  const repos = repositoriesFromSnapshot(revisions, gitmodules);
  return Object.freeze({
    repositoryRoot: reportedRepositoryRoot,
    repos,
    harness,
    provider,
    gitmodules
  });
}

async function completeSnapshot(
  repositoryRoot: string,
  cheap: StackLockCheapSnapshot,
  fileHasher: StackLockFileHasher
): Promise<StackLockCollectionSnapshot> {
  const rPackagesLock = await collectRPackagesLock(repositoryRoot, fileHasher);
  return Object.freeze({ ...cheap, rPackagesLock });
}

function cheapSnapshotsMatch(
  first: StackLockCheapSnapshot,
  second: StackLockCheapSnapshot
): boolean {
  return (
    first.repositoryRoot === second.repositoryRoot &&
    JSON.stringify(first.repos) === JSON.stringify(second.repos) &&
    first.harness.version === second.harness.version &&
    first.harness.sourceDigest === second.harness.sourceDigest &&
    first.provider.provider === second.provider.provider &&
    first.provider.modelId === second.provider.modelId &&
    first.provider.baseUrl === second.provider.baseUrl &&
    first.provider.sourceDigest === second.provider.sourceDigest &&
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

async function resolveRepositoryRoot(input: string): Promise<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new StackLockCollectionError("repository_root_invalid");
  }
  try {
    const physicalPath = await realpath(resolve(input));
    if (!(await isSafeExistingDirectoryPath(physicalPath))) {
      throw new Error("repository root is not a safe directory");
    }
    return physicalPath;
  } catch {
    throw new StackLockCollectionError("repository_root_invalid");
  }
}

async function collectRepositoryRootIdentity(
  repositoryRoot: string,
  gitCommand: StackLockGitCommand
): Promise<string> {
  let rawResult: unknown;
  try {
    rawResult = await gitCommand({
      cwd: repositoryRoot,
      args: Object.freeze([
        GIT_NO_LAZY_FETCH_GLOBAL_ARG,
        "rev-parse",
        "--show-toplevel"
      ])
    });
  } catch {
    throw new StackLockCollectionError("git_read_failed");
  }

  let stdout: unknown;
  try {
    stdout = asRecord(rawResult)?.stdout;
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    !stdout.endsWith("\n")
  ) {
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
  if (physicalReportedPath !== repositoryRoot) {
    throw new StackLockCollectionError("repository_root_invalid");
  }
  return physicalReportedPath;
}

async function collectGitlinkRevisions(
  repositoryRoot: string,
  gitCommand: StackLockGitCommand
): Promise<Readonly<Record<StackLockRepositoryName, string>>> {
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
        ...STACK_LOCK_REPOSITORY_NAMES
      ])
    });
  } catch {
    throw new StackLockCollectionError("git_read_failed");
  }

  let stdout: unknown;
  try {
    stdout = asRecord(rawResult)?.stdout;
  } catch {
    throw new StackLockCollectionError("git_output_invalid");
  }
  if (
    typeof stdout !== "string" ||
    Buffer.byteLength(stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    !stdout.endsWith("\0")
  ) {
    throw new StackLockCollectionError("git_output_invalid");
  }

  const revisions = new Map<StackLockRepositoryName, string>();
  const records = stdout.slice(0, -1).split("\0");
  if (records.length !== STACK_LOCK_REPOSITORY_NAMES.length) {
    throw new StackLockCollectionError("git_output_invalid");
  }

  for (const record of records) {
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

  return Object.freeze(Object.fromEntries(
    STACK_LOCK_REPOSITORY_NAMES.map((name) => [name, revisions.get(name)!])
  )) as Readonly<Record<StackLockRepositoryName, string>>;
}

function repositoriesFromSnapshot(
  revisions: Readonly<Record<StackLockRepositoryName, string>>,
  gitmodules: GitmodulesIdentity
): StackLock["repos"] {
  return Object.freeze(Object.fromEntries(
    STACK_LOCK_REPOSITORY_NAMES.map((name) => [
      name,
      Object.freeze({ commit: revisions[name], branch: gitmodules.declarations[name].branch })
    ])
  )) as StackLock["repos"];
}

function isStackLockRepositoryName(value: string): value is StackLockRepositoryName {
  return (STACK_LOCK_REPOSITORY_NAMES as readonly string[]).includes(value);
}

interface ReadOnlyGitExecOptions {
  readonly cwd: string;
  readonly encoding: "utf8";
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

function runReadOnlyGitCommand(input: StackLockGitCommandInput): Promise<StackLockGitCommandResult> {
  return runReadOnlyGitCommandWithExecutor(input, execFile as StackLockGitProcessExecutor);
}

function runReadOnlyGitCommandWithExecutor(
  input: StackLockGitCommandInput,
  executor: StackLockGitProcessExecutor
): Promise<StackLockGitCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    try {
      executor(
        "git",
        [...input.args],
        {
          cwd: input.cwd,
          encoding: "utf8",
          env: readOnlyGitEnvironment(env),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true
        },
        (error: Error | null, stdout: unknown, stderr: unknown) => {
          if (error) {
            rejectCommand(new StackLockCollectionError("git_read_failed"));
            return;
          }
          if (typeof stdout !== "string") {
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

/** Internal deterministic seam for the collector's process-boundary tests; not barrel-exported. */
export function __runReadOnlyGitCommandForTest(
  input: StackLockGitCommandInput,
  executor: StackLockGitProcessExecutor
): Promise<StackLockGitCommandResult> {
  return runReadOnlyGitCommandWithExecutor(input, executor);
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

function readOnlyGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
    GCM_INTERACTIVE: "Never"
  };
}

interface GitmoduleDeclaration {
  readonly path: string;
  readonly branch: string;
}

interface GitmodulesIdentity {
  readonly declarations: Readonly<Record<StackLockRepositoryName, GitmoduleDeclaration>>;
  readonly sourceDigest: string;
}

async function readGitmodulesIdentity(repositoryRoot: string): Promise<GitmodulesIdentity> {
  const absolutePath = join(repositoryRoot, GITMODULES_RELATIVE_PATH);
  try {
    const resolution = await resolveWorkspacePath({
      workspaceRoot: repositoryRoot,
      inputPath: GITMODULES_RELATIVE_PATH,
      evidenceRef: "stack-lock.gitmodules",
      access: "read"
    });
    const result = await readDurableSingleLinkFile({
      path: resolution.absolutePath,
      maxBytes: MAX_GITMODULES_FILE_BYTES,
      validateParentPath: async () => await isSafeExistingDirectoryPath(dirname(absolutePath))
    });
    if (result.status !== "read") throw new Error("gitmodules unavailable");
    const text = UTF8_DECODER.decode(result.bytes);
    return Object.freeze({
      declarations: parseGitmoduleDeclarations(text),
      sourceDigest: createHash("sha256").update(result.bytes).digest("hex")
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
