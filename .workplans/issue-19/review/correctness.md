Reviewer agent: review-correctness
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: Simple fixture coverage is present, but the runtime deny path does not yet synchronize WS/audit evidence, and the command detector has a wrapper bypass.

Invariant Matrix Coverage:
- write denial before execution: covered - simple `printf x > data/raw/input.csv` denial is tested at `packages/core/src/tools/data-raw-write-rule.test.ts:27`; wrapper bypass remains in Finding 2.
- WS tool.failed remediation payload: covered - standalone builder/test cover `tool.failed`, `seq`, `event_id`, rule identity, and remediation at `packages/backend/src/ws/policy-gate-events.test.ts:12`; runtime linkage remains in Finding 1.
- audit minimal row fixture path: covered - default fixture path is tested at `packages/core/src/tools/data-raw-write-rule.test.ts:71`; path hardening remains in Finding 3.
- read-only data/raw command compatibility: covered - `cat data/raw/input.csv` allow path is tested at `packages/core/src/tools/data-raw-write-rule.test.ts:56`.

Findings:
- severity: P1
  failure class: Integration correctness / evidence synchronization
  violated invariant/contract: A denied `data/raw/**` bash write must leave synchronized tool error, WS `tool.failed`, and audit evidence for the same rule.
  concrete scenario: A caller executes the wrapped `bash` tool with `printf x > data/raw/input.csv`. The wrapper returns a denied `ToolResult`, but no code on that deny branch emits/builds a WS event or appends the audit row.
  evidence (file:line): `packages/core/src/tools/policy-gate-registry.ts:150` returns `buildPolicyGateDeniedResult(...)` immediately; `packages/backend/src/ws/policy-gate-events.ts:68` and `packages/core/src/tools/policy-gate-audit.ts:29` are standalone helpers with no call path from the deny branch.
  consequence: The command is stopped, but the governing evidence invariant is only demonstrated by disconnected tests; real denied calls can complete without WS/audit evidence.
  fix direction: Add a higher-layer deny handler or wrapper callback that derives the tool error, `tool.failed` event, and audit row from the same `PolicyGateDecision` without making `core` depend on `backend`.
  required test/proof: One wrapped bash denial fixture with a mock event sink and temp workspace must assert inner calls stay zero, one `tool.failed` event is produced, and one audit row is appended with the same rule id/remediation source.
  sibling surfaces: `policy-gate-registry`, `policy-gate-events`, `policy-gate-audit`, future WS session bus, future audit persistence.
  blocking status: Blocking candidate for issue #19's synchronized-evidence invariant.

- severity: P1
  failure class: Policy bypass / shell wrapper parsing
  violated invariant/contract: Bash write attempts targeting `data/raw/**` must be denied before execution, including wrapper-compatible command forms.
  concrete scenario: `env FOO=1 touch data/raw/input.csv` reaches `findCommandTokenIndex`, skips `env`, then treats `FOO=1` as the command token, so `touch data/raw/input.csv` is never evaluated as a mutation and the wrapped tool is allowed to execute.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:170` handles wrapper commands by skipping only dash-prefixed options; `packages/core/src/tools/data-raw-write-rule.ts:142` only checks the selected command token against mutation command sets.
  consequence: A common shell wrapper form can mutate protected raw data while satisfying the current tests.
  fix direction: For `env`, skip `NAME=value` assignments after env options before selecting the real command; add targeted support for nested shell `sh|bash|zsh -c` if that is an accepted bash invocation form.
  required test/proof: Add wrapped-tool tests for `env FOO=1 touch data/raw/input.csv` and at least one shell `-c` write form, asserting deny result and inner call count `0`.
  sibling surfaces: command tokenizer, wrapper command handling, mutation command detection, read-only compatibility tests.
  blocking status: Blocking candidate because it violates the pre-execution raw-data write denial.

- severity: P2
  failure class: File IO path safety
  violated invariant/contract: Audit rows must land under `workspace/tasks/<task_id>/audit/` and workspace path handling must reject traversal.
  concrete scenario: A future caller passes `taskId: "../../../../tmp/escape"` or `fileName: "../x.ndjson"` to `appendPolicyGateAuditRow`; `path.join` normalizes those segments and can place the audit file outside the intended task audit directory.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:37` builds paths directly from options; `packages/core/src/tools/policy-gate-audit.ts:50` joins `taskId` without segment validation.
  consequence: Once non-default task ids or filenames are wired in, audit evidence can be written to the wrong location or outside the workspace boundary.
  fix direction: Validate `taskId` as a single safe task-id segment, keep `fileName` fixed or basename-only, resolve the final path, and assert it remains inside the expected audit directory.
  required test/proof: Add negative tests for traversal in `taskId` and `fileName` proving no outside file is created and the helper rejects with a stable error.
  sibling surfaces: task context plumbing, audit persistence, workspace path safety helpers planned for later M1 work.
  blocking status: Non-blocking for the current default fixture path, but should be fixed before accepting runtime-supplied task/file inputs.

Non-blocking notes:
- Read-only review only; I did not run the test suite.
