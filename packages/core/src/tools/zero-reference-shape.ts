export const ZERO_REFERENCE_SHAPE_DECISION = {
  selectedShape: "workspace-package-reference",
  selectedAt: "2026-07-03",
  rootWorkspacePatterns: ["packages/*", "zero/packages/*"],
  packageDependencies: ["@zero-os/core", "@zero-os/shared"],
  zeroPinnedCommit: "13e25c116c62411e6ee8a0ad67a6c53dc7c376c6",
  evidence: [
    {
      shape: "workspace-package-reference",
      result: "pass",
      command:
        "temporary Bun workspace with workspaces=['packages/*','zero/packages/*'] and @zero-os/core@workspace:* installed successfully"
    },
    {
      shape: "file-dependency",
      result: "fail",
      reason:
        "direct file:@zero/packages/core cannot resolve zero's transitive workspace:* dependencies such as @zero-os/shared, @zero-os/model, @zero-os/observe, and @zero-os/secrets"
    },
    {
      shape: "runtime-entrypoint-loading",
      result: "fail",
      reason:
        "direct import of zero/apps/server/src/cli/dispatch.ts first requires zero packages and then app-level server dependencies such as qrcode-terminal; this would broaden M1 beyond the package adapter surface"
    }
  ]
} as const;

export type ZeroReferenceShapeDecision = typeof ZERO_REFERENCE_SHAPE_DECISION;
