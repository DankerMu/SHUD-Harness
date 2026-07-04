# PR #48 round 4 fix list

Reviewed head SHA: `1c18247d9acaac53d751186526ee5f35fb9907b6`

Fixture level: high-risk M1 policy-gate 条 2' authority enforcement.

Pattern escalation: yes

Failure class: denial classification / audit evidence durability / registry policy-gate integration.

Invariant: protected `data/raw/**` bytes and policy-gate evidence paths must not be mutated by bash execution, guard setup, or guard audit writes; every raw-write denial must either persist durable audit evidence and return remediation-shaped denial, or fail closed before executing bash when mandatory evidence persistence is impossible; legal raw reads and workspace writes must not be false-denied.

Invariant Surface Inventory:

- Shared helper roots: `RawDataSandboxedBashTool`, raw-write command classifiers, seatbelt profile builder, audit append helpers, policy-gate registry factories.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `createShudSandboxedBashTool`, `createShudRuntimeToolRegistry`, `appendPolicyGateAuditRow`, `buildToolFailedWsEvent`.
- Write surfaces: protected raw roots, protected evidence roots, audit workspace/task subtree, profile/temp roots, allowed workspace writes.
- Evidence/consumer surfaces: raw denial `ToolResult`, audit row, WS `tool.failed` input, allowed-call audit rows, registry policy-gated tool markers.
- Sibling/stale surfaces: command-side `workspace/tasks` mutation, pre-existing symlink/hardlink audit components, copied Zero tools, rebuilt `spawn_agent`, interpreter-internal swallowed errors.
- Out of scope: editing `zero/`; live `zero/apps/server` direct wiring.

Regression matrix:

- Dynamic shell raw write with stderr suppression plus `:`, `exit 0`, and varied redirection ordering -> pre-denied or normalized as `denied_by_sandbox`; raw unchanged; audit row persists.
- Interpreter write APIs using raw path fragments/join and internal `try/catch` -> `raw_data_write_denied`; raw unchanged; audit row persists.
- Legal raw read to workspace plus `Permission denied`/`sandbox` output -> allowed; workspace output present; allowed audit row includes profile identity.
- Stale symlink/hardlink audit state before execution -> fail closed before bash execution, or durable fallback audit row; no command side effect.
- Command attempts to move/replace audit ancestor paths -> denied or canonical audit history remains intact.
- Public `appendPolicyGateAuditRow` with missing/mismatched protected roots and `workspaceRoot` under raw -> rejects without raw mutation.
- SHUD runtime registry with bash/edit/spawn -> every returned tool is policy-gated; scoped spawn registry inherits policy-gated sandboxed bash; policy evaluator denial blocks wrapped tools.
- Wrapper allowed-call summary/observability -> no profile path in returned `outputSummary`; lifecycle is not double-counted where testable without modifying Zero.
- WS/ErrorRecord remediation -> full `{next_action,hint,ref}` asserted.

Phase 6 requested fixes:

1. Denial classification closure
   - Split successful-result and failed-result sandbox-denial classification.
   - For successful results, do not use broad `>` + `data/raw` co-occurrence; require a raw-write target signal or pre-deny hidden raw-write risk.
   - Extend hidden-denial pre-deny to cover `:`, `exit 0`, `|| exit 0`, stderr redirection ordering (`2>/dev/null > "$p"`), and interpreter payloads that build `data/raw` from fragments and can swallow errors.
   - Preserve legal raw reads and workspace writes, including denial-like stdout/stderr content.

2. Audit/evidence durability closure
   - Make audit reservation failure fail closed before bash execution, or write to a parent-owned fallback outside sandbox-writable state.
   - Protect the audit evidence namespace at the ancestor level required to stop command-side moves/replacements, while preserving ordinary workspace writes outside evidence paths.
   - Make exported raw-policy audit append safe by requiring `protectedRawPaths` or by splitting an unsafe internal helper from a safe public API.
   - Add wrapper-level stale audit symlink/hardlink tests, not only direct append tests.

3. Registry integration closure
   - Forward `protectedEvidencePaths` through `createShudSandboxedBashTool`.
   - Compose `createShudRuntimeToolRegistry` through the central policy-gate wrapper after replacing bash and rebuilding spawn.
   - Ensure the rebuilt `spawn_agent` captures a final registry whose scoped tools remain policy-gated and whose `bash` is the sandboxed bash.
   - Add tests that `assertPolicyGatedToolRegistry(createShudRuntimeToolRegistry(...))` passes and policy evaluator denial blocks bash/edit/spawn paths.

4. Evidence/observability test hardening
   - Assert allowed-call audit rows include `profile_id` and `profile_path`.
   - Assert raw denial `error_record.remediation` and WS `tool.failed.payload.error.remediation` include the full triplet.
   - Normalize allowed `RawDataSandboxedBashTool` output summaries to the original command or prove no profile path leaks.
   - Add observability/logger tests if feasible without touching `zero/`; otherwise explicitly record the residual if Zero lifecycle cannot be avoided within #19.

Required verification after fixes:

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
