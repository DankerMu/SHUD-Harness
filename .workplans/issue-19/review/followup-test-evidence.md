Reviewer agent: review-test-evidence
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Summary: Required #19 evidence-floor tests are present and validation passes, but the deny matrix still misses common bash write forms inside the implemented detector scope.

Invariant Matrix Coverage:
- write denial before execution: covered - `packages/core/src/tools/data-raw-write-rule.test.ts:27-147` covers the required `printf x > data/raw/input.csv` path plus prior bypass classes, and asserts `bashTool.calls === 0`; residual detector gap in Finding 1.
- WS tool.failed remediation payload: covered - `packages/backend/src/ws/policy-gate-events.test.ts:29-75` asserts `tool.failed`, `seq`, `event_id`, rule identity, `guard_class`, and remediation; `:77-148` links tool payload, WS payload, and audit row from one decision.
- audit minimal row fixture path: covered - `packages/core/src/tools/data-raw-write-rule.test.ts:187-220` asserts `workspace/tasks/TASK-M1-SPIKE/audit` and event/tool_id/rule/decision/ts; traversal regressions are covered at `:223-263`.
- read-only data/raw command compatibility: covered - `packages/core/src/tools/data-raw-write-rule.test.ts:150-184` allows `cat`, copy-out, read-only multiline, quoted operator, quoted backtick, and read-only curl through the wrapped tool.
- prior findings closure: covered - prior newline/dd/truncate/cp target-dir/shell-wrapper gaps are covered at `packages/core/src/tools/data-raw-write-rule.test.ts:80-131`; audit traversal at `:223-263`; synchronized evidence at `packages/backend/src/ws/policy-gate-events.test.ts:77-148`.

Findings:
- severity: P1
  failure class: test/evidence gap with correctness risk
  violated invariant/contract: `data/raw/**` bash write attempts must be denied before wrapped command execution; the implemented detector should cover the shell wrapper/redirection forms it explicitly models.
  concrete scenario: `printf x >& data/raw/input.csv` is a valid bash write redirect, and `sudo -u nobody rm data/raw/input.csv` is a wrapper-mediated raw-data mutation. Both currently return no protected target from `findProtectedDataRawWriteTarget`, so a policy-gated bash tool would proceed to `innerTool.run`.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:10` omits the bash `>&` write operator; `packages/core/src/tools/data-raw-write-rule.ts:24-27` only models operand-consuming wrapper options for `env` and `nice`; `packages/core/src/tools/data-raw-write-rule.ts:202-211` then treats `sudo -u`'s operand as the command; `packages/core/src/tools/data-raw-write-rule.test.ts:27-132` has no denied cases for `>&` or operand-taking `sudo`/`doas`/`time` options.
  consequence: Protected raw scientific inputs can still be mutated through common bash syntax, while the evidence suite reports the high-risk write-denial row as closed.
  fix direction: Add `>&` redirection handling and complete wrapper option operand parsing for supported wrappers, or remove unsupported wrappers from the modeled wrapper set and document them as out-of-scope; add denied-before-execute regressions for `>&`, `>&file`, and operand-taking wrapper options that reach a raw-data mutation.
  required test/proof: Extend `deniedCommands` with `printf x >& data/raw/input.csv`, `printf x >&data/raw/input.csv`, and `sudo -u nobody rm data/raw/input.csv` or equivalent supported wrapper forms, each asserting `success === false`, remediation fields, and `bashTool.calls === 0`.
  sibling surfaces: `policy-gate-registry.ts` deny-before-run path, WS/audit linked evidence test, policy-gate-spike spec evidence floor, future #26 guard lint enforcement.
  blocking status: Blocking candidate for the #19 hard-guard invariant because the missing cases are executable bash write forms, not only arbitrary full-shell-parser edge cases.

Non-blocking notes:
- Validation run during review passed: `pnpm --package=bun@1.2.19 dlx bun run check`, `openspec validate m1-foundation --strict --no-interactive`, `git diff --check`, and `git -C zero diff --quiet && git -C zero rev-parse --short HEAD` returned `13e25c1`.
- The pnpm-based validation emits a workspace warning, but the `bun run check` script still executed current typecheck and 52 tests successfully.
