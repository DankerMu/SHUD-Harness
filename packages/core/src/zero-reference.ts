export const ZERO_REFERENCE = {
  status: "finalized-by-issue-17",
  selectedShape: "workspace-package-reference",
  submodulePath: "zero",
  pinnedCommit: "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6",
  rootWorkspacePatterns: ["packages/*", "zero/packages/*"],
  dependencyPackages: ["@zero-os/core", "@zero-os/shared"],
  designReference: "openspec/changes/m1-foundation/design.md#decisions",
  designDecision: 3,
  finalizationIssue: 17,
  finalizationTask: "3.1"
} as const;

export const ZERO_PROVISIONAL_REFERENCE = ZERO_REFERENCE;

export type ZeroReference = typeof ZERO_REFERENCE;
export type ZeroProvisionalReference = ZeroReference;
