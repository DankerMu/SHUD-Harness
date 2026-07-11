export const CORE_SERVICE_NAMESPACE = "core/domain/services" as const;

export type CoreServiceNamespace = typeof CORE_SERVICE_NAMESPACE;

export * from "./artifact-registry-service";
export * from "./idempotency-service";
export * from "./lock-service";
export * from "./task-card-service";
export {
  WorkspacePathSafetyError,
  assertPathInsideWorkspace,
  filesystemDeviceIdentityMatches,
  isPathInsideBoundary,
  isSafeExistingDirectoryPath,
  physicalAuthorityPathIdentity,
  physicalAuthorityPathIdentityCandidates,
  physicalCanonicalPath,
  resolveWorkspacePath
} from "./workspace-path-safety";
export type {
  FilesystemCaseSemantics,
  PhysicalAuthorityPathIdentityCandidates,
  ResolveWorkspacePathInput,
  WorkspacePathAccess,
  WorkspacePathBoundary,
  WorkspacePathResolution
} from "./workspace-path-safety";
