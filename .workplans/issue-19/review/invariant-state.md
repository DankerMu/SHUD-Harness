Reviewer agent: review-invariant-state
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: Direct fixture happy paths are present, but the raw-write detector and audit evidence boundary still leave blocking invariant gaps.

Invariant Matrix Coverage:
- write denial before execution: missing - `printf x > data/raw/input.csv` is covered by `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but sibling bash write forms can still fall through to `innerTool.run` at `packages/core/src/tools/policy-gate-registry.ts:150`; see Finding 1.
- WS tool.failed remediation payload: covered - `buildPolicyGateToolFailedEvent` reuses `tool.failed` and copies rule/remediation into the ErrorRecord at `packages/backend/src/ws/policy-gate-events.ts:83`, with assertions at `packages/backend/src/ws/policy-gate-events.test.ts:40`.
- audit minimal row fixture path: missing - the default fixture path is tested at `packages/core/src/tools/data-raw-write-rule.test.ts:75`, but the exported audit helper can escape the task audit path and is not derived from the same deny decision; see Findings 2 and 3.
- read-only data/raw command compatibility: covered - `cat data/raw/input.csv` executes through the wrapper at `packages/core/src/tools/data-raw-write-rule.test.ts:56`.

Findings:
- severity: P1
  failure class: policy bypass / path-mutation correctness
  violated invariant/contract: Bash writes to `data/raw/**` must be denied before execution; see `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23` and `openspec/changes/m1-foundation/design.md:142`.
  concrete scenario: A tool call with `command: "echo ok\nrm data/raw/input.csv"` is a valid bash mutation because Zero runs commands through `bash -c` (`zero/packages/core/src/tool/bash.ts:350`). The detector tokenizes newline as whitespace rather than a command separator, so it inspects only the first command and returns allow. Similarly, `cp -t data/raw /tmp/input.csv` writes into `data/raw` but `lastNonOptionArgument` returns the source path, so it is allowed.
  evidence: `packages/core/src/tools/data-raw-write-rule.ts:11` only lists `;`, `&&`, `||`, and `|` as segment separators; `packages/core/src/tools/data-raw-write-rule.ts:246` treats all whitespace, including newline, as token whitespace; `packages/core/src/tools/data-raw-write-rule.ts:145` handles `cp/install/ln` by only checking the last non-option argument at `packages/core/src/tools/data-raw-write-rule.ts:185`; allowed decisions execute the inner tool at `packages/core/src/tools/policy-gate-registry.ts:154`.
  consequence: Protected raw data can be deleted or overwritten before the policy gate emits a denial, so no remediation, WS, or audit evidence is produced for the mutation.
  fix direction: Treat shell newlines as command separators, handle destination options such as `cp -t` / `--target-directory`, and add recursive or fail-closed handling for shell wrapper forms such as `bash -c` / `sh -c`. Longer term, pair string detection with filesystem-level read-only enforcement for `data/raw`.
  required test/proof: Add wrapper tests asserting zero inner-tool calls for newline-separated `rm data/raw/input.csv`, `cp -t data/raw /tmp/input.csv`, and `bash -c 'printf x > data/raw/input.csv'`, while preserving read-only `cat` and `cp data/raw/file /tmp/out` allow cases.
  sibling surfaces: `tee`, `sed -i`, `install`, `ln`, `mv`, arbitrary fd redirections, `|&`, and shell/interpreter wrapper commands.
  blocking status: Blocking.

- severity: P1
  failure class: path traversal / audit storage boundary escape
  violated invariant/contract: Audit writes must stay under the task audit layout; see `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`, `openspec/changes/m1-foundation/design.md:191`, and `docs/03_SPEC/Workspace_Conventions.md:181`.
  concrete scenario: A future caller passes a persisted or user-derived `taskId` such as `../../../../tmp/escaped` or a `fileName` containing `../`; `appendPolicyGateAuditRow` normalizes that through `path.join` and appends outside `workspace/tasks/<task_id>/audit/`.
  evidence: `appendPolicyGateAuditRow` builds `auditPath` from unchecked options at `packages/core/src/tools/policy-gate-audit.ts:37` and writes it at `packages/core/src/tools/policy-gate-audit.ts:40`; `getPolicyGateAuditDir` joins `workspace/tasks/${options.taskId}/audit` without validating path separators or enforcing a workspace prefix at `packages/core/src/tools/policy-gate-audit.ts:50`.
  consequence: Audit evidence can be written outside the expected fixture/task audit directory, making readiness evidence non-reproducible and opening an arbitrary append surface within or outside the workspace.
  fix direction: Validate `taskId` as an ID, not a path segment; validate `fileName` as a basename with the expected extension; resolve the final path and reject anything outside `<workspaceRoot>/workspace/tasks/<taskId>/audit/`.
  required test/proof: Add negative tests for `taskId` and `fileName` traversal attempts, plus a positive test proving the default `TASK-M1-SPIKE` path still writes to `workspace/tasks/TASK-M1-SPIKE/audit/`.
  sibling surfaces: Future TaskCard-derived audit writes, readiness/audit NDJSON writers, and any workspace artifact helper that accepts IDs as path segments.
  blocking status: Blocking.

- severity: P2
  failure class: evidence lineage / identity synchronization gap
  violated invariant/contract: Denial output, WS payload, and audit row must carry the same rule identity and remediation; see `openspec/changes/m1-foundation/design.md:143`, `openspec/changes/m1-foundation/design.md:164`, and `openspec/changes/m1-foundation/tasks.md:29`.
  concrete scenario: The deny decision uses `policy-gate-spike.data_raw_write_forbidden`, the WS event is built from that decision, but a caller can append an audit row with `rule: "raw-data-write"` or a missing/invalid `guard_class`; tests still pass because the audit row is manually constructed instead of derived from the same denial object.
  evidence: The audit helper accepts arbitrary `rule` and `guard_class?: string` at `packages/core/src/tools/policy-gate-audit.ts:7`; `appendPolicyGateAuditRow` takes the row as-is at `packages/core/src/tools/policy-gate-audit.ts:29`; the audit test manually supplies constants rather than converting the same deny decision at `packages/core/src/tools/data-raw-write-rule.test.ts:75`.
  consequence: A reviewer or downstream consumer can see a `tool.failed` event and an audit row that appear related but name different rules, weakening the fixture's proof that one policy denial propagated across all evidence surfaces.
  fix direction: Provide a decision-derived audit builder or append helper that takes `Extract<PolicyGateDecision, { decision: "deny" }>` plus `tool_id/event`, derives `rule` and `guard_class`, and is the public path used by this feature.
  required test/proof: Add one regression that starts from a single data/raw deny decision, builds the ToolResult, WS payload, and audit row from it, then asserts identical rule id, guard_class, and remediation ref across all three surfaces.
  sibling surfaces: `tool.failed` payloads, audit rows, future AgentActivityFeed consumers, readiness evidence, and older persisted audit row readers.
  blocking status: Blocking for this high-risk fixture evidence invariant.

Non-blocking notes:
- I could not run `bun run typecheck` or `bun run test:policy-gate` because `bun` is not available in this shell (`command not found: bun`).
- Zero submodule context remained source-clean in this read-only review: `zero` HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
