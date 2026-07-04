# PR #48 round 3 fix list

Reviewed head SHA: `353fd461a6f579a332e2a320a589118f74b123a3`

Fixture level: high-risk M1 policy-gate 条 2' authority enforcement.

Pattern escalation: yes

Failure class: path safety / audit evidence integrity / denial classification.

Invariant: protected `data/raw/**` bytes and policy-gate evidence paths must not be mutated by bash execution, guard setup, or guard audit writes; every raw-write denial must return a remediation-shaped failure with contract-valid guard metadata and durable audit evidence when the audit root is valid.

Trigger: round 3 confirmed multiple path/evidence gaps across profile setup, audit append, audit command-tampering, and hardlink scanning after earlier path-safety fix rounds.

Invariant Surface Inventory:

- Shared helper roots: `raw-data-sandbox.ts` path canonicalization helpers, seatbelt profile builder, audit append helpers, hardlink scanner.
- Public entrypoints: `RawDataSandboxedBashTool`, `appendPolicyGateAuditRow`, `scanProtectedHardlinks`, SHUD tool registry wrapper.
- Read surfaces: raw reads under the seatbelt profile; audit row reads in tests.
- Write/delete/overwrite surfaces: seatbelt profile temp/profile roots, sandbox allowed write roots, protected raw roots, policy-gate audit paths.
- Producer/consumer evidence boundaries: raw denial payload, audit row projection, WS `tool.failed` projection.
- Stale-state/idempotency boundaries: pre-existing profile/audit directories, symlink/hardlink poisoning, command-created workspace path changes during execution.
- Unchanged downstream consumers: Zero source tree remains read-only/pinned; backend WS skeleton consumes denial payload.
- Surfaces intentionally out of scope: live `zero/apps/server` direct runtime wiring, because #19 scope is SHUD-owned adapter with zero diff = 0.

Regression matrix:

- Interpreter raw write and exit-normalized shell raw write -> `raw_data_write_denied`, `decision=denied_by_sandbox`, raw unchanged, audit `tool.failed` row, WS-compatible payload.
- Advisory and sandbox raw denials -> `guard_class` is contract-valid, specifically `authority` for raw-data protection.
- Audit root inside raw or symlinked to raw -> stable denial payload remains, no audit file or directory is created under raw.
- Sandboxed command tries to modify `workspace/tasks` before denied raw write -> raw unchanged and audit row still lands, or the command is pre-denied before audit path sabotage is possible.
- `profileRoot` symlink ancestor into raw with missing leaf -> command/profile setup fails without creating any raw directory or file.
- Hardlink residual scan with small budget and wide directory -> scan budget bounds traversal without eager full-directory materialization.

Phase 6 requested fixes:

1. Denial classification and suppressed failure closure
   - Convert sandbox-denial output even when the wrapped bash result reports success, but only when the original command has raw-write signal so raw reads containing denial-like text remain allowed.
   - Extend raw-write signals to cover interpreter/file APIs such as Python/Perl/Ruby/Node open/write forms and other obvious write forms without `>` (`dd of=`, `install`, `mkdir`, `ln`, `truncate`, metadata writes to raw where applicable).
   - Extend suppressed-failure pre-deny so `2>/dev/null || true`, grouped/subshell/child-shell forms, and interpreter payloads cannot return false success.
   - Add tests for normal interpreter denial, stderr-suppressed interpreter denial, dynamic target `|| true` with visible stderr, and child-shell masking.

2. Guard-class contract closure
   - Change `RawDataGuardClass` to the canonical vocabulary `authority | capability`.
   - Emit `authority` for both advisory and sandbox raw-data denials; keep `decision` as the mechanism discriminator.
   - Update payload, audit, WS, and tests so `"advisory"` no longer appears as a guard class.

3. Audit root and audit sabotage closure
   - Validate audit workspace roots against protected raw paths lexically and canonically before creating directories or files.
   - Reject or safely bypass misconfigured audit roots that are inside raw or resolve through symlinks to raw without mutating raw bytes.
   - Prevent the sandboxed command from tampering with the policy-gate audit subtree before denial append; prefer reserving the audit task subtree before execution and denying writes to that subtree in the seatbelt profile, or another parent-owned evidence path that the sandbox cannot mutate.
   - Add tests for explicit `auditWorkspaceRoot=rawRoot`, default `ctx.workDir=rawRoot`, symlinked audit root, and command-side `workspace/tasks` sabotage.

4. Profile root parent-symlink closure
   - Replace missing-leaf `mkdir -p` behavior for `profileRoot` with component-by-component no-symlink validation/creation, or require an existing safe profile root and fail before any raw mutation.
   - Add a test for a symlink ancestor into raw plus missing `profiles` leaf; assert raw entries are unchanged.

5. Hardlink scan resource-bound closure
   - Replace eager directory `readdir` in `scanProtectedHardlinks` with streaming `opendir` traversal and budget checks around each entry.
   - Keep the scan protected-root-only and add regression evidence for low-budget wide directories.

Required verification after fixes:

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
