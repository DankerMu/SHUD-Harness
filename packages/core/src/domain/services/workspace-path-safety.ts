import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type WorkspacePathBoundary = "workspace" | "allowed_readonly";
export type WorkspacePathAccess = "read" | "write";

export interface WorkspacePathResolution {
  absolutePath: string;
  normalizedPath: string;
  boundary: WorkspacePathBoundary;
  boundaryRoot: string;
}

export interface ResolveWorkspacePathInput {
  workspaceRoot: string;
  inputPath: string;
  evidenceRef: string;
  access?: WorkspacePathAccess;
  allowedReadonlyRoots?: readonly string[];
}

export class WorkspacePathSafetyError extends Error {
  readonly evidenceRef: string;

  constructor(message: string, evidenceRef: string) {
    super(message);
    this.name = "WorkspacePathSafetyError";
    this.evidenceRef = evidenceRef;
  }
}

type BoundaryCandidate = {
  kind: WorkspacePathBoundary;
  root: string;
};

type FileStat = Awaited<ReturnType<typeof lstat>>;

const PHYSICAL_CANONICAL_PATH_RESTARTS = 3;

export interface WorkspacePathSafetyHooks {
  afterPhysicalCandidateLstat?: (
    input: Readonly<{
      candidatePath: string;
      targetPath: string;
      exists: boolean;
      missingSegmentCount: number;
    }>
  ) => Promise<void> | void;
}

const workspacePathSafetyHookStorage = new AsyncLocalStorage<WorkspacePathSafetyHooks>();

export async function runWithWorkspacePathSafetyHooks<T>(
  hooks: WorkspacePathSafetyHooks,
  action: () => Promise<T>
): Promise<T> {
  return await workspacePathSafetyHookStorage.run(hooks, action);
}

export async function resolveWorkspacePath(
  input: ResolveWorkspacePathInput
): Promise<WorkspacePathResolution> {
  assertAbsolutePath(input.workspaceRoot, "workspaceRoot", input.evidenceRef);
  for (const readonlyRoot of input.allowedReadonlyRoots ?? []) {
    assertAbsolutePath(readonlyRoot, "allowedReadonlyRoots", input.evidenceRef);
  }

  const workspaceRoot = resolve(input.workspaceRoot);
  const rawPath = input.inputPath;
  if (rawPath.trim().length === 0) {
    throw new WorkspacePathSafetyError("Workspace path is blank.", input.evidenceRef);
  }

  const access = input.access ?? "write";
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
  const boundary = matchingBoundary(workspaceRoot, input.allowedReadonlyRoots ?? [], absolutePath);
  if (!boundary) {
    throw new WorkspacePathSafetyError(
      "Resolved path escapes the configured workspace.",
      input.evidenceRef
    );
  }
  if (boundary.kind === "allowed_readonly" && access !== "read") {
    throw new WorkspacePathSafetyError(
      "Resolved path targets a read-only boundary for a write operation.",
      input.evidenceRef
    );
  }

  await rejectSymlinkEscape(absolutePath, input.evidenceRef);

  return {
    absolutePath,
    normalizedPath:
      boundary.kind === "workspace"
        ? workspaceRelativePath(workspaceRoot, absolutePath)
        : absolutePath,
    boundary: boundary.kind,
    boundaryRoot: boundary.root
  };
}

export function assertPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
  evidenceRef: string
): void {
  assertAbsolutePath(workspaceRoot, "workspaceRoot", evidenceRef);
  assertAbsolutePath(targetPath, "targetPath", evidenceRef);

  if (isPathInsideBoundary(resolve(workspaceRoot), resolve(targetPath))) {
    return;
  }

  throw new WorkspacePathSafetyError(
    "Resolved path escapes the configured workspace.",
    evidenceRef
  );
}

export function isPathInsideBoundary(boundaryRoot: string, targetPath: string): boolean {
  const relativePath = relative(resolve(boundaryRoot), resolve(targetPath));
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

export async function isSafeExistingDirectoryPath(path: string): Promise<boolean> {
  const { rootPath, segments } = pathParts(path);
  const rootEntry = await maybeLstat(rootPath);
  if (!isSafeDirectoryEntry(rootEntry)) {
    return false;
  }

  let currentPath = rootPath;
  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const entry = await maybeLstat(currentPath);
    if (!isSafeDirectoryEntry(entry)) {
      return false;
    }
  }

  return true;
}

/**
 * Returns one filesystem-aware name for a path without treating that name as a
 * safety decision. Existing leaves use their physical path. Missing leaves are
 * anchored at the nearest existing physical directory so case aliases of the
 * same workspace converge while separate workspaces remain isolated.
 */
export async function physicalCanonicalPath(path: string, evidenceRef: string): Promise<string> {
  const targetPath = resolve(path);
  for (let attempt = 0; attempt < PHYSICAL_CANONICAL_PATH_RESTARTS; attempt += 1) {
    const canonicalPath = await tryPhysicalCanonicalPath(targetPath, evidenceRef);
    if (canonicalPath !== undefined) return canonicalPath;
  }

  return await physicalCanonicalUnresolvedPath(targetPath, evidenceRef);
}

async function tryPhysicalCanonicalPath(
  targetPath: string,
  evidenceRef: string
): Promise<string | undefined> {
  const missingSegments: string[] = [];
  let candidatePath = targetPath;

  for (;;) {
    let entry: FileStat | undefined;
    try {
      entry = await lstat(candidatePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
        throw new WorkspacePathSafetyError(
          "Workspace path cannot be canonicalized safely.",
          evidenceRef
        );
      }
    }

    await workspacePathSafetyHookStorage.getStore()?.afterPhysicalCandidateLstat?.(
      Object.freeze({
        candidatePath,
        targetPath,
        exists: entry !== undefined,
        missingSegmentCount: missingSegments.length
      })
    );

    if (entry) {
      if (missingSegments.length > 0 && !entry.isDirectory()) {
        throw new WorkspacePathSafetyError(
          "Workspace path crosses a non-directory ancestor.",
          evidenceRef
        );
      }
      try {
        if (missingSegments.length === 0 && !entry.isDirectory()) {
          const physicalPath = await realpath(candidatePath);
          return join(
            parse(physicalPath).dir,
            conservativeMissingPathIdentitySegment(parse(physicalPath).base)
          );
        }
        return join(
          await realpath(candidatePath),
          ...missingSegments.reverse().map(conservativeMissingPathIdentitySegment)
        );
      } catch (error) {
        if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
          return undefined;
        }
        throw new WorkspacePathSafetyError(
          "Workspace path cannot be canonicalized safely.",
          evidenceRef
        );
      }
    }

    const parentPath = parse(candidatePath).dir;
    if (parentPath === candidatePath) {
      throw new WorkspacePathSafetyError(
        "Workspace path has no canonical physical ancestor.",
        evidenceRef
      );
    }
    missingSegments.push(parse(candidatePath).base);
    candidatePath = parentPath;
  }
}

async function physicalCanonicalUnresolvedPath(
  targetPath: string,
  evidenceRef: string
): Promise<string> {
  const unresolvedSegments = [parse(targetPath).base];
  let candidatePath = parse(targetPath).dir;

  for (;;) {
    let entry: FileStat | undefined;
    try {
      entry = await lstat(candidatePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
        throw new WorkspacePathSafetyError(
          "Workspace path cannot be canonicalized safely.",
          evidenceRef
        );
      }
    }

    if (entry) {
      if (!entry.isDirectory()) {
        throw new WorkspacePathSafetyError(
          "Workspace path crosses a non-directory ancestor.",
          evidenceRef
        );
      }
      try {
        return join(
          await realpath(candidatePath),
          ...unresolvedSegments.reverse().map(conservativeMissingPathIdentitySegment)
        );
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
          throw new WorkspacePathSafetyError(
            "Workspace path cannot be canonicalized safely.",
            evidenceRef
          );
        }
      }
    }

    const parentPath = parse(candidatePath).dir;
    if (parentPath === candidatePath) {
      throw new WorkspacePathSafetyError(
        "Workspace path has no canonical physical ancestor.",
        evidenceRef
      );
    }
    unresolvedSegments.push(parse(candidatePath).base);
    candidatePath = parentPath;
  }
}

function conservativeMissingPathIdentitySegment(segment: string): string {
  return /^[\x00-\x7f]+$/.test(segment) ? segment.toLowerCase() : segment;
}

function matchingBoundary(
  workspaceRoot: string,
  allowedReadonlyRoots: readonly string[],
  targetPath: string
): BoundaryCandidate | undefined {
  const readonlyBoundary = allowedReadonlyRoots
    .map((root) => ({ kind: "allowed_readonly" as const, root: resolve(root) }))
    .find((boundary) => isPathInsideBoundary(boundary.root, targetPath));
  if (readonlyBoundary) {
    return readonlyBoundary;
  }

  const workspaceBoundary = { kind: "workspace" as const, root: workspaceRoot };
  if (isPathInsideBoundary(workspaceBoundary.root, targetPath)) {
    return workspaceBoundary;
  }
}

function assertAbsolutePath(path: string, label: string, evidenceRef: string): void {
  if (isAbsolute(path)) {
    return;
  }

  throw new WorkspacePathSafetyError(`${label} must be absolute.`, evidenceRef);
}

async function rejectSymlinkEscape(path: string, evidenceRef: string): Promise<void> {
  const targetPath = resolve(path);
  const { rootPath, segments } = pathParts(targetPath);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const entry = await lstatExistingPath(currentPath, evidenceRef);
    if (!entry) {
      return;
    }
    if (entry.isSymbolicLink()) {
      throw new WorkspacePathSafetyError("Workspace path crosses a symlink.", evidenceRef);
    }
    if (currentPath !== targetPath && !entry.isDirectory()) {
      throw new WorkspacePathSafetyError(
        "Workspace path crosses a non-directory ancestor.",
        evidenceRef
      );
    }
  }
}

function workspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  const relativePath = relative(resolve(workspaceRoot), resolve(targetPath));
  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

function pathParts(path: string): { rootPath: string; segments: string[] } {
  const resolvedPath = resolve(path);
  const rootPath = parse(resolvedPath).root;
  return {
    rootPath,
    segments: resolvedPath.slice(rootPath.length).split(sep).filter(Boolean)
  };
}

function isSafeDirectoryEntry(entry: FileStat | undefined): boolean {
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function maybeLstat(path: string): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function lstatExistingPath(
  path: string,
  evidenceRef: string
): Promise<FileStat | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw new WorkspacePathSafetyError(
      "Workspace path cannot be inspected safely.",
      evidenceRef
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
