# Finding Verification - cand-final-e4f00c3-03

Verifier verdict for: cand-e4f00c3-03-stale-protected-raw-root-finalization
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict: CONFIRMED

Evidence: `execute()` canonicalizes before the local setup catch: `const protectedRawPaths = await canonicalizePathSet(profileOptions.protectedRawPaths);` at `packages/core/src/tools/raw-data-sandbox.ts:552`, while the profile/audit setup catch starts at `:565`; `canonicalizePathSet()` calls `canonicalizeExistingPath()` (`:4624-4625`), which is `realpath(resolve(path))` (`:4916-4917`), so a stale absolute root throws. The only local terminal metadata path is `finalizeToolResult()` calling `markRunningToolFinished()` (`:766-772`); BaseTool's generic catch returns a failed `ToolResult` without marking the running handle (`zero/packages/core/src/tool/base.ts:81-95`).

Note: Absolute paths pass `resolveRuntimeRoot()` unchanged, so the stale-root scenario is reachable.
