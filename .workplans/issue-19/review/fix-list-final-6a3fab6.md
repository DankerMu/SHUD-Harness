# Fix list -- final follow-up at 6a3fab6

Reviewed head SHA: `6a3fab6673b63e1a0609f00deb6b67c662e5901c`
PR: `#48`
Issue: `#19`

## Fix 1: stabilize relative root binding

Failure class: path authority / evidence binding

Problem:
- Relative `auditWorkspaceRoot` is still resolved against process cwd.
- Relative `protectedRawPaths` are currently resolved against each invocation `ctx.workDir`, which can drift under spawn/subagent work dirs.

Required behavior:
- Runtime wrapper relative roots must bind to a stable configured base, not to process cwd and not to every per-invocation `ctx.workDir`.
- Add an explicit `pathResolutionRoot`/equivalent base for relative root options. If any runtime root is relative and no base is provided, fail closed with a clear error rather than guessing.
- Use the stable base consistently for `protectedRawPaths`, `protectedEvidencePaths`, `allowedWriteRoots`, `tempRoot`, `profileRoot`, and `auditWorkspaceRoot`.
- Keep absolute path behavior unchanged.

Required verification:
- Relative `protectedRawPaths: ["data/raw"]` plus `pathResolutionRoot: fixture.root` still protects `fixture.root/data/raw` when `ctx.workDir` is a subdirectory.
- Relative `auditWorkspaceRoot: "workspace"` plus `pathResolutionRoot: fixture.root` writes audit rows under `fixture.root/workspace/tasks/...` even when process cwd differs.
- A runtime wrapper with relative roots and no stable base fails closed before execution.

## Fix 2: make profile cleanup deletion target-bound

Failure class: resource cleanup / path binding

Problem: cleanup catches errors but still recursively removes `dirname(profilePath)` by path. If a sandboxed command swaps a writable profile-root ancestor with a symlink to a victim tree containing the same run-dir basename, cleanup can delete a directory the wrapper did not create.

Required behavior:
- When creating the profile file, capture enough identity for the created run directory to verify cleanup still targets the same directory.
- Before recursive cleanup, verify the run directory path is not a symlink and still resolves to the originally created run directory. If it drifted, warn and skip deletion.
- Keep cleanup failure from masking the tool result.

Required verification:
- Add a regression that replaces the profile root with a symlink to a victim directory containing the same run-dir basename; assert the victim directory remains after cleanup and a warning is logged.
- Preserve the existing cleanup-failure-not-masking-result regression.

## Verification required

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
