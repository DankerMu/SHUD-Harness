export const CORE_SERVICE_NAMESPACE = "core/domain/services" as const;

export type CoreServiceNamespace = typeof CORE_SERVICE_NAMESPACE;

export * from "./artifact-registry-service";
export * from "./idempotency-service";
export * from "./lock-service";
export * from "./task-card-service";
export {
  preserveTaskServiceErrorFailureEntries,
  taskServiceErrorAuthorityTransportFamily,
  taskServiceErrorAtBoundary,
  trustedTaskServiceErrorFromFailureLedger
} from "./task-service-error-compensation";
export {
  FAILURE_GRAPH_MAX_EDGES,
  FAILURE_GRAPH_MAX_NODES,
  FAILURE_GRAPH_MAX_CONTROLLED_OPERATIONS,
  FAILURE_GRAPH_MAX_NUMERIC_KEYS,
  FAILURE_GRAPH_MAX_OBSERVATION_FAILURES,
  FailureGraphObservationIssue,
  FailureOccurrenceProtocolError,
  adoptFailureCarrier,
  captureFailureFoldEntry,
  captureFailureOccurrence,
  createTrustedFailureTransportFamily,
  failureEvents,
  failureFoldEntryValue,
  failureGraphNodes,
  failureLedger,
  failureTerminalPhysicalPhase,
  mergeTrustedFailureOccurrences,
  orderedDistinctCompensationFailures,
  orderedDistinctFailures,
  semanticPrimaryValue
} from "./compensation-error-preservation";
export type {
  FailureGraphEdge,
  FailureGraphNode,
  FailureGraphObservationIssueCode,
  FailureAsyncOutcome,
  FailureCarrierAdoption,
  FailureFoldEntry,
  FailureOccurrence,
  FailureOccurrenceProtocolErrorCode,
  FailurePhase,
  PreservedFailureLedger,
  TrustedFailureTransportFamily
} from "./compensation-error-preservation";
export {
  ensureWorkspaceDirectoryTree,
  ensureWorkspaceRecordRootPhysicalIdentity,
  probeWorkspaceRecordDirectoryWritable,
  runWithExistingWorkspaceRecordDirectoryReproof
} from "./workspace-record-store";
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
