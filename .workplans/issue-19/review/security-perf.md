Reviewer agent: review-security-perf
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: The fixture path is covered, but the bash raw-data guard is bypassable by common write forms and symlink aliases; audit path options also need boundary hardening.

Invariant Matrix Coverage:
- write denial before execution: covered - fixture case `printf x > data/raw/input.csv` denies before `RecordingTool.execute` (`packages/core/src/tools/data-raw-write-rule.test.ts:27`).
- WS tool.failed remediation payload: covered - builder/test assert `tool.failed`, seq/event_id, rule identity, guard_class, and remediation (`packages/backend/src/ws/policy-gate-events.test.ts:12`).
- audit minimal row fixture path: covered - helper writes `workspace/tasks/TASK-M1-SPIKE/audit` with event/tool_id/rule/decision/ts (`packages/core/src/tools/data-raw-write-rule.test.ts:71`).
- read-only data/raw command compatibility: covered - `cat data/raw/input.csv` still executes through wrapper (`packages/core/src/tools/data-raw-write-rule.test.ts:56`).

Findings:
- severity: P1
  failure class: path safety / adversarial bypass / data integrity
  violated invariant/contract: A policy-denied bash write to `data/raw/**` must be stopped before execution; adversarial/boundary inputs must not bypass the selected control.
  concrete scenario: `dd if=/dev/zero of=data/raw/input.csv bs=1 count=1`, `python -c 'open("data/raw/input.csv","w").write("x")'`, or `ln -s data/raw scratch/raw && printf x > scratch/raw/input.csv` are not recognized as protected writes. The evaluator returns allow, so the wrapped bash tool would execute and no denial/WS/audit evidence is produced.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:71`, `packages/core/src/tools/data-raw-write-rule.ts:134`, `packages/core/src/tools/data-raw-write-rule.ts:194`
  consequence: Protected raw scientific inputs can be mutated through the public bash entrypoint despite the new rule, breaking the core governance invariant and silently losing the required remediation/evidence trail.
  fix direction: Move from command-name heuristics to conservative enforcement. Either enforce `data/raw` as read-only at the sandbox/filesystem layer, or deny any non-proven-read-only bash command that references a protected path, resolving against `workDir` and symlinks before execution. Keep explicit allow coverage for known read-only commands such as `cat`.
  required test/proof: Add wrapped-tool tests showing `dd of=...`, interpreter file writes, archive/extraction/output-flag writes, and symlink-alias writes are denied with `calls === 0`; keep the existing `cat data/raw/...` allow test.
  sibling surfaces: Zero `BashTool` fuse/sandbox behavior, future `sandbox.exec` alias, upcoming workspace path helper, and any artifact/snapshot writer that relies on raw-data immutability.
  blocking status: Blocking for #19 because the selected raw-data write control is bypassable.

- severity: P2
  failure class: evidence path traversal / file IO boundary
  violated invariant/contract: Audit evidence must stay under the agreed `workspace/tasks/<task_id>/audit/` layout, with the no-TaskCard fixture defaulting to `TASK-M1-SPIKE`.
  concrete scenario: A caller can pass `taskId: "../../../../tmp"` or `fileName: "../../outside.ndjson"` to `appendPolicyGateAuditRow`; `path.join` will normalize those segments and append outside the intended audit directory.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:37`, `packages/core/src/tools/policy-gate-audit.ts:50`
  consequence: Future dynamic task IDs or filenames can create or append evidence outside the workspace audit tree, weakening provenance and potentially writing to unintended paths.
  fix direction: Treat `taskId` and `fileName` as path components, not paths: validate task IDs against the canonical ID pattern, require `fileName` to be a basename, resolve the final path, and assert it remains inside the computed audit directory; reject traversal and symlink escape.
  required test/proof: Add negative tests for `../`, absolute task IDs, path-bearing filenames, and symlink escape; assert no file is created outside the temp workspace.
  sibling surfaces: Future task audit writers, workspace init, artifact registry persistence, and task snapshot persistence should use the same path-boundary helper once #6.6 lands.
  blocking status: Non-blocking for the current fixed fixture default, blocking before dynamic task/file options are wired to runtime callers.

Non-blocking notes:
- Local validation passed: `bun run check` via the pinned runtime and `openspec validate m1-foundation --strict --no-interactive`.
- The WS skeleton intentionally does not implement the full session bus/seq allocator in M1; the current tests cover only envelope construction, which matches the scoped fixture.
