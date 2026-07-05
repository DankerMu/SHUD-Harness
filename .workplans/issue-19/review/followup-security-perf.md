Reviewer agent: review-security-perf
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Summary: Fixture evidence is mostly synchronized, but one remaining bash parser bypass and one audit symlink boundary gap remain.

Invariant Matrix Coverage:
- write denial before execution: missing - covered for prior named cases in `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but `&` command lists and operand-taking wrappers can still hide a later raw-data mutation.
- WS tool.failed remediation payload: covered - `packages/backend/src/ws/policy-gate-events.test.ts:29` asserts `tool.failed`, seq/event_id, rule identity, guard_class, and remediation payload.
- audit minimal row fixture path: covered - normal fixture path and row fields are asserted in `packages/core/src/tools/data-raw-write-rule.test.ts:187`; symlink escape is a separate finding below.
- read-only data/raw command compatibility: covered - read-only raw commands still execute through the wrapper in `packages/core/src/tools/data-raw-write-rule.test.ts:150`.
- prior findings closure: covered - the previously confirmed dd/truncate/cp target/shell wrapper/traversal/evidence-link cases have regression coverage; new adjacent gaps are listed below.

Findings:
- severity: P1
  failure class: path-safety / adversarial parser bypass / data integrity
  violated invariant/contract: Bash writes to `data/raw/**` must be denied before the wrapped command executes.
  concrete scenario: `cat data/raw/input.csv & rm data/raw/input.csv` is a valid bash command list; because single `&` is not treated as a segment separator, the detector sees the segment's command as `cat` and allows the call, so `rm` can execute. Similarly, `sudo -u nobody rm data/raw/input.csv` can be hidden because `sudo` is listed as a wrapper but its operand-taking options are not consumed.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:11`, `packages/core/src/tools/data-raw-write-rule.ts:23`, `packages/core/src/tools/data-raw-write-rule.ts:24`, `packages/core/src/tools/data-raw-write-rule.ts:193`, `packages/core/src/tools/data-raw-write-rule.ts:587`
  consequence: Protected raw inputs can still be mutated through the public bash path with no deny result and therefore no synchronized remediation, WS, or audit evidence.
  fix direction: Parse bash command-list separators conservatively, including background `&`, and either fully handle operand-taking options for declared wrappers or avoid skipping wrappers whose option grammar is not modeled. Add deny-by-default behavior for ambiguous wrapper forms that still reference protected raw paths.
  required test/proof: Add wrapped-tool tests for `cat data/raw/input.csv & rm data/raw/input.csv` and `sudo -u nobody rm data/raw/input.csv`, asserting `success=false` and inner tool call count `0`, while preserving existing read-only allow tests.
  sibling surfaces: Future `sandbox.exec`, Zero `BashTool` wrapper assembly, spawn/tool policy rules that reuse this tokenizer, and audit/WS evidence producers that depend on a captured denial decision.
  blocking status: Blocking for #19 because this bypass reaches the same protected write surface.

- severity: P2
  failure class: file IO boundary / symlink escape / audit integrity
  violated invariant/contract: Audit evidence must stay under `workspace/tasks/<task_id>/audit/`; workspace path safety requires rejecting symlink escape.
  concrete scenario: If `workspace/tasks/TASK-M1-SPIKE/audit` already exists as a symlink to an outside directory, `appendPolicyGateAuditRow()` passes the lexical path check and `appendFile()` follows the symlink, writing `policy-gate-audit.ndjson` outside the workspace while returning a path that appears compliant.
  evidence (file:line): `packages/core/src/tools/policy-gate-audit.ts:48`, `packages/core/src/tools/policy-gate-audit.ts:80`, `packages/core/src/tools/policy-gate-audit.ts:89`, `packages/core/src/tools/policy-gate-audit.ts:117`
  consequence: Audit provenance can be redirected out of the task audit tree, weakening evidence integrity and creating an unintended outside-workspace write.
  fix direction: Resolve and validate real paths for the workspace root and audit directory, reject symlink components, and route this helper through the shared workspace path-safety helper once available.
  required test/proof: In a temp workspace, create an outside directory and a symlinked `workspace/tasks/TASK-M1-SPIKE/audit`; assert append rejects and no outside audit row is created.
  sibling surfaces: Workspace init, artifact registry persistence, task snapshot persistence, and any future task audit writer using task/file path components.
  blocking status: Non-blocking for the current fixed fixture in a trusted empty workspace; blocking before this helper is wired to mutable runtime workspace state.

Non-blocking notes:
- Review was read-only; I did not run tests because the brief prohibited changing state.
