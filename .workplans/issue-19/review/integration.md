Reviewer agent: review-integration
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: Blocking integration gaps remain: multi-line bash mutations can bypass the raw-data deny rule, and the audit helper can write outside the governed task audit path.

Invariant Matrix Coverage:
- write denial before execution: missing - single-line `printf x > data/raw/input.csv` is covered by `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but newline-separated bash mutations are allowed by the tokenizer path in finding 1.
- WS tool.failed remediation payload: covered - `buildPolicyGateToolFailedEvent` carries `tool.failed`, seq/event_id, rule_id, guard_class, and ErrorRecord remediation at `packages/backend/src/ws/policy-gate-events.ts:68`.
- audit minimal row fixture path: missing - the default fixture path is tested at `packages/core/src/tools/data-raw-write-rule.test.ts:71`, but the exported helper accepts escaping `taskId`/`fileName` values as described in finding 2.
- read-only data/raw command compatibility: covered - wrapped `cat data/raw/input.csv` allow path is asserted at `packages/core/src/tools/data-raw-write-rule.test.ts:56`.

Findings:
- severity: P1
  failure class: Correctness / policy bypass
  violated invariant/contract: `data/raw/**` bash write attempts must be denied before execution; spec requires any bash write under `data/raw/` to leave the command unexecuted (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`, `:27`).
  concrete scenario: A bash input such as `cat data/raw/input.csv\nrm data/raw/input.csv` is executed by Zero via `bash -c`, but the policy tokenizer collapses the newline as whitespace, so the whole token stream is treated as one segment beginning with `cat`; `rm data/raw/input.csv` is never evaluated as a mutation command.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:11`, `packages/core/src/tools/data-raw-write-rule.ts:71`, `packages/core/src/tools/data-raw-write-rule.ts:78`, `packages/core/src/tools/data-raw-write-rule.ts:246`, `zero/packages/core/src/tool/bash.ts:350`
  consequence: A normal multi-line bash command can delete or mutate protected raw data after the policy gate returns allow, breaking the core #19 invariant.
  fix direction: Treat newline and bare command separators such as `&` as segment separators outside quotes, or otherwise parse command lists before checking each command segment. Keep quoted newlines as data.
  required test/proof: Add a wrapped-bash regression where `cat data/raw/input.csv\nrm data/raw/input.csv` is denied and the inner tool call count remains zero; add a read-only multi-line case to prove compatibility is preserved.
  sibling surfaces: `tee`, `sed -i`, `mv`, `cp`, shell grouping/subshells, and future `sandbox.exec` bash wrappers should share the same command-list parsing behavior.
  blocking status: Blocking for this PR because it allows raw-data mutation before execution denial.

- severity: P1
  failure class: File IO / path safety
  violated invariant/contract: Audit evidence for this spike must land under `workspace/tasks/TASK-M1-SPIKE/audit/` or `workspace/tasks/<task_id>/audit/`, and workspace paths must be normalized and bounded (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`; `docs/03_SPEC/Workspace_Conventions.md:181`).
  concrete scenario: A future caller passing `taskId: "../../../../tmp/pwn"` or `fileName: "../../pwn.ndjson"` to the exported audit helper causes `path.join` to normalize outside the intended task audit directory before `mkdir`/`appendFile` run.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:37`, `packages/core/src/tools/policy-gate-audit.ts:38`, `packages/core/src/tools/policy-gate-audit.ts:40`, `packages/core/src/tools/policy-gate-audit.ts:50`
  consequence: Once wired to real task/session input, policy-gate audit logging can create or append files outside the governed workspace/task audit surface.
  fix direction: Validate `taskId` as an opaque task id, reject path separators in `fileName`, resolve the final path, and assert it remains under the resolved `workspace/tasks/<task_id>/audit` directory before writing.
  required test/proof: Add negative tests for escaping `taskId` and `fileName`, plus a positive test for the default `TASK-M1-SPIKE` fixture path.
  sibling surfaces: Future Task API route params, WebSocket/session `task_id`, Artifact registry writes, and any AuditEvent writer should reuse the same bounded path helper.
  blocking status: Blocking because the changed public helper is itself a write surface selected by the PR's path-safety risk pack.

Non-blocking notes:
- Tests were not run; review was static/read-only to respect the no state-change instruction.
- `zero` is clean and still pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
