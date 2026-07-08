import { lstat } from "node:fs/promises";
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

export async function resolveWorkspacePath(
  input: ResolveWorkspacePathInput
): Promise<WorkspacePathResolution> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const rawPath = input.inputPath.trim();
  if (rawPath.length === 0) {
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
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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

function matchingBoundary(
  workspaceRoot: string,
  allowedReadonlyRoots: readonly string[],
  targetPath: string
): BoundaryCandidate | undefined {
  const workspaceBoundary = { kind: "workspace" as const, root: workspaceRoot };
  if (isPathInsideBoundary(workspaceBoundary.root, targetPath)) {
    return workspaceBoundary;
  }

  return allowedReadonlyRoots
    .map((root) => ({ kind: "allowed_readonly" as const, root: resolve(root) }))
    .find((boundary) => isPathInsideBoundary(boundary.root, targetPath));
}

async function rejectSymlinkEscape(path: string, evidenceRef: string): Promise<void> {
  const targetPath = resolve(path);
  const { rootPath, segments } = pathParts(targetPath);
  let currentPath = rootPath;

  for (const segment of segments) {
    currentPath = join(currentPath, segment);
    const entry = await maybeLstat(currentPath);
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
