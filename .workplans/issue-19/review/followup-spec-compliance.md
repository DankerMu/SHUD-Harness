Reviewer agent: review-spec-compliance
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Summary: Prior WS/audit linkage and fixture-path gaps are closed, but the bash raw-data write detector still has spec-relevant bypasses.

#19 Requirement Coverage:
- DONE: representative wrapped `bash` writes are denied before inner execution, including redirect, newline, `dd`, `truncate`, `cp -t`, shell `-c`, curl output, backtick, and env/nice wrapper cases.
- MISSING: the broader `data/raw/**` bash write invariant is not fully covered; see Finding 1.
- DONE: returned denial payload includes remediation `next_action`/`hint`/`ref`.
- DONE: WS skeleton reuses `tool.failed` with `seq`, `event_id`, ErrorRecord-shaped payload, remediation, rule id, and guard class.
- DONE: audit minimal row defaults to `workspace/tasks/TASK-M1-SPIKE/audit/` and includes event/tool_id/rule/decision/ts.
- DONE: read-only raw-data commands remain allowed.
- DONE: data/raw guard has legal `guard_class=authority`.
- DONE: no new WS event type was introduced.

Scope Creep:
- No material scope creep found. Changes stay within `packages/core`, `packages/backend/src/ws`, focused tests, and OpenSpec implementation notes. `zero/` remains clean and pinned.

Selected Risk Packs:
- Selected and exercised: bash/tool entrypoint, file IO/path safety, schema/field names, WS envelope ordering marker, legacy allow-path compatibility, deny-path error handling, documentation/evidence lineage, Zero adapter governance.
- Not selected for this slice: auth/secrets, release packaging, hydrology runtime formats, full WS server/session bus, full AuditEvent schema.

Altitude Lens:
- Issue altitude: acceptance-floor fixtures are mostly covered, but "any bash write under `data/raw/**`" remains too broad for the current detector.
- OpenSpec altitude: `tool.failed`, fixture audit row, remediation, and guard marker align with the M1 spike skeleton.
- Canonical altitude: `data/raw/*` is a read-only authority boundary; command-string classification is still weaker than a deterministic filesystem/sandbox write boundary.

Invariant Matrix Coverage:
- write denial before execution: missing - current tests cover many representative forms at `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but Finding 1 leaves standard write forms that reach inner bash execution.
- WS tool.failed remediation payload: covered - `packages/backend/src/ws/policy-gate-events.ts:68` builds `tool.failed`; `packages/backend/src/ws/policy-gate-events.test.ts:29` asserts seq/event_id/remediation/rule identity.
- audit minimal row fixture path: covered - `packages/core/src/tools/policy-gate-audit.ts:80` resolves the fixture path and `packages/core/src/tools/data-raw-write-rule.test.ts:187` verifies `workspace/tasks/TASK-M1-SPIKE/audit`.
- read-only data/raw command compatibility: covered - `packages/core/src/tools/data-raw-write-rule.test.ts:150` keeps read-only raw-data references allowed.
- prior findings closure: covered - prior dd/truncate/cp/shell/backtick/curl/env/audit-traversal/same-denial linkage items are addressed; adjacent path/write-boundary gaps remain below.

Findings:
- severity: P1
  failure class: spec compliance / write-boundary bypass
  violated invariant/contract: `data/raw/**` bash write attempts must be denied before execution; canonical docs also mark `data/raw/*` read-only (`docs/03_SPEC/Execution_Jobs_Runs.md:188`, `docs/03_SPEC/Execution_Jobs_Runs.md:193`).
  concrete scenario: `sed --in-place 's/a/b/' data/raw/input.csv` is a standard in-place write form, but the detector only treats exact `-i` or `-i*` as sed write mode. Likewise `sudo -u root rm data/raw/input.csv` is hidden by a listed wrapper because `sudo -u`'s operand is not consumed, so `root` is treated as the command and the mutation is missed.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:23`, `packages/core/src/tools/data-raw-write-rule.ts:24`, `packages/core/src/tools/data-raw-write-rule.ts:179`, `packages/core/src/tools/data-raw-write-rule.ts:203`
  consequence: protected raw-data mutation attempts can reach the actual Zero `bash` tool without a policy denial, so no remediation, WS `tool.failed`, or audit row is produced for those attempts.
  fix direction: either make the detector conservative for raw-data references unless the command is proven read-only, or explicitly cover the remaining write modes for commands/wrappers already modeled (`sed --in-place`, `sudo/doas -u`, similar operand-taking wrapper options).
  required test/proof: add wrapped-bash denial tests for `sed --in-place ... data/raw/input.csv` and `sudo -u <user> rm data/raw/input.csv`, asserting `success=false` and inner call count `0`; keep existing read-only allow tests.
  sibling surfaces: future `sandbox.exec` alias, Zero `BashTool`, data/raw path policy, WS/audit denial evidence builders.
  blocking status: Blocking for claiming full #19 `data/raw/**` write-denial coverage; deferrable only if the issue explicitly narrows the detector matrix.

- severity: P2
  failure class: path safety / audit evidence containment
  violated invariant/contract: workspace path handling must reject symlink escape, and audit rows must remain under `workspace/tasks/<task_id>/audit/` (`docs/03_SPEC/Workspace_Conventions.md:181`).
  concrete scenario: if `workspace/tasks/TASK-M1-SPIKE/audit` already exists as a symlink to an external directory, `appendPolicyGateAuditRow` resolves the string path under the workspace but `appendFile` follows the symlink and writes outside the governed audit tree.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:48`, `packages/core/src/tools/policy-gate-audit.ts:49`, `packages/core/src/tools/policy-gate-audit.ts:89`, `packages/core/src/tools/policy-gate-audit.ts:117`
  consequence: fixture audit evidence can be physically written outside the workspace/task audit surface while still appearing path-valid by string containment.
  fix direction: resolve real paths for existing parent components or reuse the planned workspace path-safety helper to reject symlink escapes before append.
  required test/proof: create a temp workspace where the audit directory path is a symlink to an outside directory and assert `appendPolicyGateAuditRow` rejects without writing.
  sibling surfaces: future task audit writers, artifact registry persistence, task snapshot persistence, workspace path helper in task 6.6.
  blocking status: Non-blocking for the current hardcoded happy-path fixture, but blocking before this helper is wired to mutable runtime workspace/task inputs.

Non-blocking notes:
- `openspec validate m1-foundation --strict --no-interactive` passed.
- `git diff --check origin/main...HEAD` passed.
- `git -C zero diff --quiet` passed; `zero` HEAD is `13e25c1`.
- `bun run check` was not run because `bun` is not on PATH in this review shell.
