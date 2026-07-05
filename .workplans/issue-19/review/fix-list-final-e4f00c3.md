# Fix List for PR #48 - final follow-up e4f00c3

Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict table: `.workplans/issue-19/review/verdict-table-final-e4f00c3.md`

Pattern escalation: yes
Failure classes:
- `information-disclosure`
- `process-lifecycle`
- `state-transition`
- `telemetry-provenance`
- `wrapper-faithfulness`

Invariant:
- Sandboxed bash must not inherit ambient host secrets; explicit secrets must pass only through registered secret references.
- Normal completion must not report allowed while statically detectable un-awaited interpreter subprocesses can continue mutating workspace.
- Every wrapper-owned pre-exec failure path must finalize running-tool state.
- WS and fuse rule builders must snapshot caller-owned mutable inputs at construction time.

Fix 1: Minimal sandbox child environment (P1)
Required behavior:
- `buildSanitizedToolProcessEnv()` must stop copying all of `process.env`.
- Allowlist only non-secret variables required by the sandbox/tool runtime, plus `ZERO_*` context variables.
- Keep shell prelude variables stripped.
- Explicit `envSecrets` and `stdinSecretRef` must continue to work and be registered with `secretFilter`.
Tests:
- Set fake `GLM_API_KEY`/`SMTP_PASSWORD` in parent `process.env`; command `printf "$GLM_API_KEY"` must not print the secret and `env` must not contain it.
- Explicit `envSecrets` still reaches the child and output is redacted by existing secret filtering.

Fix 2: Reject statically detectable un-awaited interpreter subprocesses (P1)
Required behavior:
- Preflight must reject interpreter payloads that call Python `subprocess.Popen` / relevant process creation APIs without an evident `wait()`/`communicate()` or equivalent.
- Preserve the existing waited foreground `Popen(...).wait()` allow case.
- Include analogous obvious Node/Ruby/R process-spawn forms if already represented by the existing parser, or document remaining dynamic/over-budget cases as out of static scope.
Tests:
- Python un-awaited `Popen` writing workspace after delay returns process-containment failure, does not create the workspace file immediately or after delay, and records `policy_gate_process_containment_unavailable`.
- Existing waited `Popen(...).wait()` and shell wait tests remain green.

Fix 3: Finalize stale protected raw root setup failure (P2/P1)
Required behavior:
- `canonicalizePathSet(profileOptions.protectedRawPaths)` errors must return a structured failed `ToolResult` through `finalizeToolResult()`.
- No audit/profile/command side effects should occur for stale roots.
Tests:
- Missing/deleted absolute protected raw root with `TestRunningToolRegistry` returns structured failure and terminal metadata `{cause:"completed", success:false}`.

Fix 4: Snapshot generic WS error payloads (P2)
Required behavior:
- `buildToolFailedWsEventUnchecked()` must deep-clone/snapshot `ErrorRecord` and nested arrays/remediation before storing it in event payload.
Tests:
- Mutate original `ErrorRecord`, `evidence_refs`, `recommended_next_actions`, and remediation after event creation; event payload remains unchanged.

Fix 5: Snapshot fuse rule objects (P2)
Required behavior:
- Clone fuse rule objects when resolving/passing inline `fuseRules` and inside `RawDataSandboxedBashTool` / `FuseListChecker` construction boundary as needed.
Tests:
- Mutate original `fuseRules[0].pattern` after `createShudSandboxedBashTool()`; original pattern still blocks.

Verification after fixes:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json tsconfig.base.json`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD`
