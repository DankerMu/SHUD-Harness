Reviewer agent: review-spec-compliance
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: #19 is partially covered, but the raw-data write guard still misses common bash write forms, so the governing invariant is not fully satisfied.

Task/Requirement Coverage:
- DONE: `printf x > data/raw/input.csv` is denied before wrapped bash executes.
- MISSING: broader "bash attempts to write to `data/raw/**`" coverage; direct write commands such as `dd of=...` are not detected.
- DONE: WS skeleton reuses `tool.failed` with `seq`/`event_id` and remediation payload.
- DONE: audit helper writes the fixture minimal row under `workspace/tasks/TASK-M1-SPIKE/audit/`.
- MISSING: same-denial synchronization is not enforced between tool denial, WS event, and audit row.
- DONE: read-only `cat data/raw/input.csv` remains allowed.
- DONE: data/raw hard guard has legal `guard_class`.

Invariant Matrix Coverage:
- write denial before execution: missing - covered only for redirection fixture at `packages/core/src/tools/data-raw-write-rule.test.ts:33`; detector misses other real write forms.
- WS tool.failed remediation payload: covered - `packages/backend/src/ws/policy-gate-events.ts:83` and test assertions at `packages/backend/src/ws/policy-gate-events.test.ts:40`.
- audit minimal row fixture path: covered - `packages/core/src/tools/policy-gate-audit.ts:50` and test assertion at `packages/core/src/tools/data-raw-write-rule.test.ts:89`.
- read-only data/raw command compatibility: covered - `packages/core/src/tools/data-raw-write-rule.test.ts:56`.

Findings:
- severity: P1
  failure class: spec compliance / file IO path safety
  violated invariant/contract: Policy-denied bash writes to `data/raw/**` must be stopped before execution, not only shell redirections.
  concrete scenario: `bash` input `dd if=/dev/zero of=data/raw/input.csv bs=1 count=1` or `truncate -s 0 data/raw/input.csv` mutates `data/raw/**`, but no redirect token or listed mutation command matches, so the policy allows the wrapped tool to execute.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:10`, `packages/core/src/tools/data-raw-write-rule.ts:12`, `packages/core/src/tools/data-raw-write-rule.ts:134`, `packages/core/src/tools/data-raw-write-rule.ts:142`, `packages/core/src/tools/data-raw-write-rule.ts:154`; fixture only covers redirection at `packages/core/src/tools/data-raw-write-rule.test.ts:33`.
  consequence: protected raw evidence can still be overwritten or truncated through the public bash entrypoint with no denial, WS event, or audit evidence.
  fix direction: make the detector conservative for common write-capable commands and flag forms (`dd of=`, `truncate`, `rsync` destination, `sed --in-place`, wrapper commands with option arguments), or introduce a shell parsing/command classification helper with an explicit covered matrix.
  required test/proof: add deny tests for at least `dd of=data/raw/input.csv`, `truncate -s 0 data/raw/input.csv`, and one wrapped-command form, plus allow tests for read-only raw-data reads and writes to governed workspace paths.
  sibling surfaces: `tee`, `sed -i`, `cp/install/ln/mv`, `sudo/env` wrapper handling, future `sandbox.exec` alias if it becomes the bash surface.
  blocking status: Blocking for #19 acceptance.

- severity: P2
  failure class: evidence lineage / schema contract
  violated invariant/contract: the same denial must preserve one rule identity across denial output, `tool.failed`, and audit evidence.
  concrete scenario: a caller can build a WS event from a denial for rule A, then call `appendPolicyGateAuditRow` with rule B; the helper accepts the mismatch and the current tests would not catch it.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:29`, `packages/core/src/tools/policy-gate-audit.ts:33`, `packages/core/src/tools/data-raw-write-rule.test.ts:75`, `packages/backend/src/ws/policy-gate-events.ts:73`.
  consequence: persisted audit evidence can contradict the tool error and WS event, weakening the reviewable evidence chain for PI/governance decisions.
  fix direction: add a builder or denial handler that derives audit rows from the same `PolicyGateDecision` used for the tool result and WS event.
  required test/proof: one test should evaluate a single denial and assert tool payload `rule_id`, WS payload `rule_id`, audit `rule`, `guard_class`, and remediation `ref` all match.
  sibling surfaces: future spawn-profile denials, depth/concurrency denials, policy-gate denied tool result payload.
  blocking status: Blocks claiming synchronized same-denial evidence; can be deferred only if explicitly scoped as a primitive helper.

- severity: P2
  failure class: path safety / file IO
  violated invariant/contract: audit writes must stay under `workspace/tasks/<task_id>/audit/`, with path normalization and workspace-boundary checks.
  concrete scenario: `appendPolicyGateAuditRow(row, { workspaceRoot, taskId: "../../../outside" })` resolves outside the expected `workspace/tasks/*/audit` tree because `taskId` and `fileName` are joined unchecked.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:38`, `packages/core/src/tools/policy-gate-audit.ts:50`, `docs/03_SPEC/Workspace_Conventions.md:181`.
  consequence: future callers that pass task/file identifiers from runtime state can write audit rows outside the intended evidence directory.
  fix direction: validate `taskId` and `fileName` as safe path segments, resolve the final path, assert it remains under the intended audit directory, and reject symlink escapes where applicable.
  required test/proof: add traversal tests for `taskId` and `fileName`, plus a legal fixture-path test.
  sibling surfaces: future task audit writers, artifact registry writes, task snapshot writers.
  blocking status: Non-blocking for the hardcoded fixture path, blocking before wiring this helper to external/runtime identifiers.

Non-blocking notes:
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` passed.
- `bun run check` could not run in this review environment because `bun` is not installed.
- Zero submodule remains pinned at `13e25c1` and `git -C zero diff --quiet` passed.
