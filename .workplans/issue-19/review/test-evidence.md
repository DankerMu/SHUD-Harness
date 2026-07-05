Reviewer agent: review-test-evidence
Review round: round 1
Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607
Summary: Evidence floor rows are present, but high-risk path-safety and same-denial lineage coverage still has candidate gaps.

Invariant Matrix Coverage:
- write denial before execution: covered - [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:27) runs through `createPolicyGatedToolRegistry`, denies `printf x > data/raw/input.csv`, and asserts inner tool call count stays `0`.
- WS tool.failed remediation payload: covered - [policy-gate-events.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/backend/src/ws/policy-gate-events.test.ts:12) builds `tool.failed` from a policy denial and asserts `seq`, `event_id`, rule identity, guard class, and remediation payload.
- audit minimal row fixture path: covered - [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:71) appends an NDJSON row under `workspace/tasks/TASK-M1-SPIKE/audit` with event/tool/rule/decision/ts fields; path-boundary and lineage caveats below.
- read-only data/raw command compatibility: covered - [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:56) allows `cat data/raw/input.csv` through the wrapper and asserts the underlying tool executes.

Findings:
- severity: P2
  failure class: evidence-lineage integration gap
  violated invariant/contract: The Issue #19 governing invariant requires one policy-denied bash write to leave synchronized remediation, WS, and audit evidence for the same rule.
  concrete scenario: The wrapped bash denial returns `rule_id=A`, the WS builder is tested from an independently evaluated decision, and the audit test writes a manually constructed row. A future call site could pass the wrong audit `rule` or `decision` while all current tests still pass.
  evidence (file:line): [design.md](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/openspec/changes/m1-foundation/design.md:164) defines synchronized evidence; [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:75) hand-builds the audit row instead of deriving it from the actual denial; [policy-gate-events.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/backend/src/ws/policy-gate-events.test.ts:13) evaluates a separate denial for WS.
  consequence: The tests prove each artifact shape separately, but not the invariant that the same denied tool call produces matching returned error, WS payload, and audit row identity.
  fix direction: Add a focused cross-surface test or small adapter that evaluates one denial once, then builds the returned error/WS event/audit row from that same `PolicyGateDecision`.
  required test/proof: Assert the same `ruleId`, `guard_class`, `tool_id`, `decision`, and remediation `ref` across tool result, `tool.failed` payload, and appended audit row.
  sibling surfaces: `policy-gate-registry.ts`, `policy-gate-events.ts`, `policy-gate-audit.ts`, future AgentActivityFeed/audit consumers.
  blocking status: blocking candidate for the test-evidence pack until fixed or explicitly deferred.

- severity: P2
  failure class: file IO/path-safety boundary coverage gap
  violated invariant/contract: The selected file IO/path-safety risk pack and Workspace_Conventions §9 require path normalization and proof that audit writes stay under the intended workspace audit path.
  concrete scenario: A caller passes `taskId: "../../outside"` or `fileName: "../../audit.ndjson"` to the exported audit helper; current code joins those values directly, and current tests would not catch an escape from `workspace/tasks/TASK-M1-SPIKE/audit`.
  evidence (file:line): [policy-gate-audit.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/policy-gate-audit.ts:38) joins `fileName` directly; [policy-gate-audit.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/policy-gate-audit.ts:50) joins `taskId` directly; [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:71) only tests the default happy path.
  consequence: The PR can claim the fixture audit path is covered, but not that the helper is safe against traversal or future task-specific caller mistakes.
  fix direction: Validate or constrain `taskId` and `fileName`, resolve the final path, and reject paths outside the expected workspace audit directory.
  required test/proof: Add negative tests for `../` task IDs, path-bearing file names, and a positive test for the normalized default fixture path.
  sibling surfaces: future task-scoped audit writes, workspace path helper work in task 6.6, artifact/snapshot persistence helpers.
  blocking status: blocking candidate for path-safety evidence completeness.

- severity: P2
  failure class: bash write-detector boundary coverage gap
  violated invariant/contract: The selected public bash/tool entrypoint and file IO/path-safety risk packs require positive and boundary regression evidence for implemented write-detection branches.
  concrete scenario: The detector supports redirects plus `tee`, `cp`, `install`, `ln`, `mv`, `touch`, `rm`, `mkdir`, `chmod`, `chown`, and `sed -i`, but tests only deny `printf x > data/raw/input.csv` and allow `cat data/raw/input.csv`.
  evidence (file:line): [data-raw-write-rule.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.ts:10) defines multiple write operators; [data-raw-write-rule.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.ts:12) defines mutation command sets; [data-raw-write-rule.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.ts:134) implements those branches; [data-raw-write-rule.test.ts](/Users/danker/Desktop/Hydro-SHUD/SHUD-Harness/packages/core/src/tools/data-raw-write-rule.test.ts:27) covers only one deny form.
  consequence: A regression in common mutation forms could silently re-allow protected raw-data writes while `bun run check` remains green.
  fix direction: Add table-driven tests for every supported mutation branch and representative false-positive boundaries.
  required test/proof: Cover at least append redirects, `tee`, destination `cp/install/ln`, endpoint `mv`, `touch/rm/mkdir`, `sed -i`, quoted or normalized `data/raw` paths, read-only source reads, and near-miss paths like `data/rawness`.
  sibling surfaces: wrapped bash execution, policy remediation payload, WS/audit evidence generated from denied decisions.
  blocking status: non-blocking candidate if the team explicitly scopes Issue #19 to the single evidence-floor command; otherwise should be fixed before relying on broader "bash mutations" coverage.

Non-blocking notes:
- Read-only checks observed: `git diff --check main...HEAD` produced no output; no submodule diff was present; `git -C zero diff --quiet` exited 0 and `zero` HEAD is `13e25c1`.
- Full WebSocket server/session bus coverage is out of scope per the Issue #19 fixture; builder-level coverage is consistent with that non-goal.
