export const ZERO_PROVISIONAL_REFERENCE = {
  status: "provisional-pending-issue-17",
  selectedShape: "runtime-entrypoint-reference",
  submodulePath: "zero",
  pinnedCommit: "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6",
  runtimeEntrypoint: "zero/apps/server/src/cli.ts",
  designReference: "openspec/changes/m1-foundation/design.md#decisions",
  designDecision: 3,
  finalizationIssue: 17,
  finalizationTask: "3.1"
} as const;

export type ZeroProvisionalReference = typeof ZERO_PROVISIONAL_REFERENCE;
