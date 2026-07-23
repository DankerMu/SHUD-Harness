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
  deniedRelativeRoots?: readonly string[];
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
export type FilesystemCaseSemantics = "case_sensitive" | "case_insensitive" | "unknown";

export interface PhysicalAuthorityPathIdentityCandidates {
  exact: string;
  aliases: readonly string[];
}

interface PhysicalCanonicalExactObservation {
  exact: string;
  physicalAncestor: string;
  missingSegments: readonly string[];
  targetExists: boolean;
}

interface FilesystemCaseObservation {
  semantics: FilesystemCaseSemantics;
  deviceRoot: string;
}

class AuthorityObservationHookError {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

class AuthorityObservationChangedError {}

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
  filesystemCaseSemantics?: (
    input: Readonly<{ existingPath: string }>
  ) => FilesystemCaseSemantics | undefined;
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
  const deniedRoots = normalizeDeniedRelativeRoots(
    workspaceRoot,
    input.deniedRelativeRoots ?? [],
    input.evidenceRef
  );
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
  if (
    boundary.kind === "workspace" &&
    await targetsDeniedWorkspaceBoundary(
      workspaceRoot,
      deniedRoots,
      absolutePath,
      input.evidenceRef
    )
  ) {
    throw new WorkspacePathSafetyError(
      "Resolved path targets a denied workspace boundary.",
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
    try {
      const canonicalPath = await tryPhysicalCanonicalPath(targetPath, evidenceRef);
      if (canonicalPath !== undefined) return canonicalPath;
    } catch (error) {
      if (error instanceof AuthorityObservationHookError) throw error.cause;
      throw error;
    }
  }

  try {
    return await physicalCanonicalUnresolvedPath(targetPath, evidenceRef);
  } catch (error) {
    if (error instanceof AuthorityObservationHookError) throw error.cause;
    throw error;
  }
}

export async function physicalAuthorityPathIdentity(
  path: string,
  evidenceRef: string
): Promise<string> {
  const candidates = await physicalAuthorityPathIdentityCandidates(path, evidenceRef);
  return candidates.aliases.at(-1) ?? candidates.exact;
}

export async function physicalAuthorityPathIdentityCandidates(
  path: string,
  evidenceRef: string
): Promise<PhysicalAuthorityPathIdentityCandidates> {
  const targetPath = resolve(path);
  for (let attempt = 0; attempt < PHYSICAL_CANONICAL_PATH_RESTARTS; attempt += 1) {
    try {
      return await observePhysicalAuthorityPathIdentityCandidates(targetPath, evidenceRef);
    } catch (error) {
      if (error instanceof AuthorityObservationHookError) throw error.cause;
      const observationChanged =
        error instanceof AuthorityObservationChangedError ||
        hasErrorCode(error, "ENOENT") ||
        hasErrorCode(error, "ENOTDIR");
      if (observationChanged && attempt + 1 < PHYSICAL_CANONICAL_PATH_RESTARTS) {
        continue;
      }
      if (observationChanged) {
        throw new WorkspacePathSafetyError(
          "Workspace path authority identity could not be observed safely.",
          evidenceRef
        );
      }
      throw error;
    }
  }

  throw new WorkspacePathSafetyError(
    "Workspace path authority identity could not be observed safely.",
    evidenceRef
  );
}

async function observePhysicalAuthorityPathIdentityCandidates(
  targetPath: string,
  evidenceRef: string
): Promise<PhysicalAuthorityPathIdentityCandidates> {
  const observation = await physicalCanonicalExactPathObservation(targetPath, evidenceRef);
  let targetEntry: FileStat | undefined;
  try {
    targetEntry = await lstat(targetPath);
  } catch (error) {
    if (
      !observation.targetExists &&
      (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR"))
    ) {
      targetEntry = undefined;
    } else if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      throw error;
    } else {
      throw new WorkspacePathSafetyError(
        "Workspace path authority identity could not be observed safely.",
        evidenceRef
      );
    }
  }

  if (Boolean(targetEntry) !== observation.targetExists) {
    throw new AuthorityObservationChangedError();
  }

  if (targetEntry) {
    await invokeAuthorityCandidateLstatHook(
      targetPath,
      targetPath,
      observation.missingSegments.length
    );
    const caseObservation = await authorityExistingPathCaseObservation(
      observation.exact,
      evidenceRef
    );
    const aliases =
      caseObservation.semantics === "case_sensitive"
        ? [observation.exact]
        : [
            composeDeviceBoundedCaseAlias(
              caseObservation.deviceRoot,
              observation.exact
            )
          ];
    return Object.freeze({ exact: observation.exact, aliases: Object.freeze(aliases) });
  }

  try {
    const ancestorEntry = await lstat(observation.physicalAncestor);
    if (!ancestorEntry.isDirectory()) {
      throw new WorkspacePathSafetyError(
        "Workspace path crosses a non-directory ancestor.",
        evidenceRef
      );
    }
  } catch (error) {
    if (error instanceof WorkspacePathSafetyError) throw error;
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) throw error;
    throw new WorkspacePathSafetyError(
      "Workspace path authority identity could not be observed safely.",
      evidenceRef
    );
  }

  await invokeAuthorityCandidateLstatHook(
    observation.physicalAncestor,
    targetPath,
    observation.missingSegments.length
  );

  try {
    targetEntry = await lstat(targetPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      targetEntry = undefined;
    } else {
      throw new WorkspacePathSafetyError(
        "Workspace path authority identity could not be observed safely.",
        evidenceRef
      );
    }
  }
  if (targetEntry) throw new AuthorityObservationChangedError();

  const caseObservation = await authorityExistingPathCaseObservation(
    observation.physicalAncestor,
    evidenceRef
  );
  if (caseObservation.semantics === "case_sensitive") {
    return Object.freeze({
      exact: observation.exact,
      aliases: Object.freeze([observation.exact])
    });
  }
  const conservative = composeDeviceBoundedCaseAlias(
    caseObservation.deviceRoot,
    observation.exact
  );
  return Object.freeze({
    exact: observation.exact,
    aliases: Object.freeze(Array.from(new Set([observation.exact, conservative])))
  });
}

async function invokeAuthorityCandidateLstatHook(
  candidatePath: string,
  targetPath: string,
  missingSegmentCount: number
): Promise<void> {
  try {
    await workspacePathSafetyHookStorage.getStore()?.afterPhysicalCandidateLstat?.(
      Object.freeze({
        candidatePath,
        targetPath,
        exists: true,
        missingSegmentCount
      })
    );
  } catch (error) {
    throw new AuthorityObservationHookError(error);
  }
}

async function authorityExistingPathCaseObservation(
  path: string,
  evidenceRef: string
): Promise<FilesystemCaseObservation> {
  try {
    return await existingPathCaseObservation(path);
  } catch (error) {
    if (error instanceof AuthorityObservationHookError) throw error;
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) throw error;
    throw new WorkspacePathSafetyError(
      "Workspace path authority identity could not be observed safely.",
      evidenceRef
    );
  }
}

async function physicalCanonicalExactPathObservation(
  targetPath: string,
  evidenceRef: string
): Promise<PhysicalCanonicalExactObservation> {
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
    if (entry) {
      if (missingSegments.length > 0 && !entry.isDirectory()) {
        throw new WorkspacePathSafetyError(
          "Workspace path crosses a non-directory ancestor.",
          evidenceRef
        );
      }
      try {
        const physicalPath = await realpath(candidatePath);
        const orderedMissingSegments = missingSegments.reverse();
        return Object.freeze({
          exact: join(physicalPath, ...orderedMissingSegments),
          physicalAncestor: physicalPath,
          missingSegments: Object.freeze(orderedMissingSegments),
          targetExists: orderedMissingSegments.length === 0
        });
      } catch (error) {
        if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
          throw error;
        }
        throw new WorkspacePathSafetyError(
          "Workspace path cannot be canonicalized safely.",
          evidenceRef
        );
      }
    }
    const parsed = parse(candidatePath);
    if (parsed.dir === candidatePath) {
      throw new WorkspacePathSafetyError(
        "Workspace path has no canonical physical ancestor.",
        evidenceRef
      );
    }
    missingSegments.push(parsed.base);
    candidatePath = parsed.dir;
  }
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
          return await realpath(candidatePath);
        }
        const physicalAncestor = await realpath(candidatePath);
        return join(
          physicalAncestor,
          ...(await canonicalMissingPathIdentitySegments(
            physicalAncestor,
            missingSegments.reverse()
          ))
        );
      } catch (error) {
        if (error instanceof AuthorityObservationHookError) throw error;
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
        const physicalAncestor = await realpath(candidatePath);
        return join(
          physicalAncestor,
          ...(await canonicalMissingPathIdentitySegments(
            physicalAncestor,
            unresolvedSegments.reverse()
          ))
        );
      } catch (error) {
        if (error instanceof AuthorityObservationHookError) throw error;
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
  return unicodeCaseFoldSegment(segment);
}

function unicodeCaseFoldSegment(segment: string): string {
  return segment.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

export function composeDeviceBoundedCaseAlias(deviceRoot: string, path: string): string {
  const exactDeviceRoot = resolve(deviceRoot);
  const exactPath = resolve(path);
  const insideDevice = relative(exactDeviceRoot, exactPath);
  if (
    insideDevice === "" ||
    isAbsolute(insideDevice) ||
    insideDevice === ".." ||
    insideDevice.startsWith(`..${sep}`)
  ) {
    return exactPath;
  }
  return join(
    exactDeviceRoot,
    ...insideDevice.split(sep).filter(Boolean).map(unicodeCaseFoldSegment)
  );
}

async function canonicalMissingPathIdentitySegments(
  physicalAncestor: string,
  segments: readonly string[]
): Promise<string[]> {
  if ((await existingPathCaseObservation(physicalAncestor)).semantics === "case_sensitive") {
    return [...segments];
  }
  return segments.map(conservativeMissingPathIdentitySegment);
}

async function existingPathCaseObservation(path: string): Promise<FilesystemCaseObservation> {
  const expectedPhysicalPath = await realpath(path);
  let injectedSemantics: FilesystemCaseSemantics | undefined;
  try {
    injectedSemantics = workspacePathSafetyHookStorage
      .getStore()
      ?.filesystemCaseSemantics?.(Object.freeze({ existingPath: expectedPhysicalPath }));
  } catch (error) {
    throw new AuthorityObservationHookError(error);
  }
  const targetDevice = (await lstat(expectedPhysicalPath, { bigint: true })).dev;
  let candidatePath = expectedPhysicalPath;
  let observedSemantics = injectedSemantics ?? "unknown";
  let semanticsResolved = injectedSemantics !== undefined;
  for (;;) {
    const parsed = parse(candidatePath);
    const [candidateEntry, parentEntry] = await Promise.all([
      lstat(candidatePath, { bigint: true }),
      lstat(parsed.dir, { bigint: true })
    ]);
    if (!filesystemDeviceIdentityMatches(candidateEntry.dev, targetDevice)) {
      return Object.freeze({ semantics: "unknown", deviceRoot: expectedPhysicalPath });
    }
    if (
      parsed.dir === candidatePath ||
      !filesystemDeviceIdentityMatches(parentEntry.dev, targetDevice)
    ) {
      return Object.freeze({ semantics: observedSemantics, deviceRoot: candidatePath });
    }
    if (!semanticsResolved) {
      const componentSemantics = await existingEntryCaseSemantics(
        parsed.dir,
        parsed.base,
        candidatePath
      );
      if (componentSemantics !== "unknown") {
        observedSemantics = componentSemantics;
        semanticsResolved = true;
      }
    }
    candidatePath = parsed.dir;
  }
}

export function filesystemDeviceIdentityMatches(left: bigint, right: bigint): boolean {
  return left === right;
}

async function existingEntryCaseSemantics(
  parentPath: string,
  base: string,
  expectedPhysicalPath: string
): Promise<FilesystemCaseSemantics> {
  const alternateBase = swapFirstAsciiLetterCase(base);
  if (alternateBase === base) return "unknown";
  const expectedPath = join(parentPath, base);
  const alternatePath = join(parentPath, alternateBase);
  let expectedEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    expectedEntry = await lstat(expectedPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) throw error;
    return "unknown";
  }
  try {
    const [alternateEntry, alternatePhysicalPath] = await Promise.all([
      lstat(alternatePath, { bigint: true }),
      realpath(alternatePath)
    ]);
    if (expectedEntry.isSymbolicLink() || alternateEntry.isSymbolicLink()) return "unknown";
    return expectedEntry.dev === alternateEntry.dev &&
      expectedEntry.ino === alternateEntry.ino &&
      alternatePhysicalPath === expectedPhysicalPath
      ? "case_insensitive"
      : "case_sensitive";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      try {
        await lstat(expectedPath);
      } catch (expectedError) {
        if (
          hasErrorCode(expectedError, "ENOENT") ||
          hasErrorCode(expectedError, "ENOTDIR")
        ) {
          throw expectedError;
        }
        return "unknown";
      }
      return "case_sensitive";
    }
    return "unknown";
  }
}

function swapFirstAsciiLetterCase(segment: string): string {
  const index = segment.search(/[A-Za-z]/);
  if (index < 0) return segment;
  const letter = segment[index]!;
  const replacement = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  return `${segment.slice(0, index)}${replacement}${segment.slice(index + 1)}`;
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

function normalizeDeniedRelativeRoots(
  workspaceRoot: string,
  deniedRelativeRoots: readonly string[],
  evidenceRef: string
): string[] {
  return deniedRelativeRoots.map((deniedRoot) => {
    if (
      typeof deniedRoot !== "string" ||
      deniedRoot.trim().length === 0 ||
      deniedRoot.includes("\u0000") ||
      isAbsolute(deniedRoot) ||
      deniedRoot.startsWith("\\") ||
      /^[A-Za-z]:/u.test(deniedRoot)
    ) {
      throw invalidDeniedRelativeRootsError(evidenceRef);
    }

    const segments = deniedRoot.split(/[\\/]/u);
    if (
      segments.some(
        (segment) => segment.length === 0 || segment === "." || segment === ".."
      )
    ) {
      throw invalidDeniedRelativeRootsError(evidenceRef);
    }

    const normalizedRoot = resolve(workspaceRoot, ...segments);
    if (
      normalizedRoot === workspaceRoot ||
      !isPathInsideBoundary(workspaceRoot, normalizedRoot)
    ) {
      throw invalidDeniedRelativeRootsError(evidenceRef);
    }
    return normalizedRoot;
  });
}

async function targetsDeniedWorkspaceBoundary(
  workspaceRoot: string,
  deniedRoots: readonly string[],
  targetPath: string,
  evidenceRef: string
): Promise<boolean> {
  if (deniedRoots.some((deniedRoot) => isPathInsideBoundary(deniedRoot, targetPath))) {
    return true;
  }
  if (deniedRoots.length === 0) {
    return false;
  }

  const [workspaceIdentity, targetIdentity, ...deniedIdentities] = await Promise.all([
    physicalAuthorityPathIdentityCandidates(workspaceRoot, evidenceRef),
    physicalAuthorityPathIdentityCandidates(targetPath, evidenceRef),
    ...deniedRoots.map((root) =>
      physicalAuthorityPathIdentityCandidates(root, evidenceRef)
    )
  ]);
  const workspaceCandidates = identityCandidatePaths(workspaceIdentity);
  const targetCandidates = identityCandidatePaths(targetIdentity);

  return deniedIdentities.some((deniedIdentity) => {
    const deniedCandidates = identityCandidatePaths(deniedIdentity);
    return targetCandidates.some(
      (targetCandidate) =>
        workspaceCandidates.some((workspaceCandidate) =>
          isPathInsideBoundary(workspaceCandidate, targetCandidate)
        ) &&
        deniedCandidates.some((deniedCandidate) =>
          isPathInsideBoundary(deniedCandidate, targetCandidate)
        )
    );
  });
}

function identityCandidatePaths(
  identity: PhysicalAuthorityPathIdentityCandidates
): string[] {
  return Array.from(new Set([identity.exact, ...identity.aliases]));
}

function invalidDeniedRelativeRootsError(
  evidenceRef: string
): WorkspacePathSafetyError {
  return new WorkspacePathSafetyError(
    "deniedRelativeRoots must contain unambiguous workspace-relative subtrees.",
    evidenceRef
  );
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
