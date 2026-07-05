Reviewer agent: review-integration
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Summary: One integration blocker remains: configured wrapper options can still hide the real `data/raw/**` mutation from the deny detector.

Invariant Matrix Coverage:
- write denial before execution: missing - covered for many fixtures in `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but `sudo -u root rm data/raw/input.csv` still reaches allow due wrapper operand parsing; see Finding 1.
- WS tool.failed remediation payload: covered - `buildPolicyGateToolFailedEvent` preserves `tool.failed`, `seq`, `event_id`, rule identity, guard class, and ErrorRecord remediation at `packages/backend/src/ws/policy-gate-events.ts:68`.
- audit minimal row fixture path: covered - default audit path and traversal rejection are covered by `packages/core/src/tools/policy-gate-audit.ts:76` and tests at `packages/core/src/tools/data-raw-write-rule.test.ts:187`.
- read-only data/raw command compatibility: covered - read-only raw commands still execute through the wrapper at `packages/core/src/tools/data-raw-write-rule.test.ts:150`.
- prior findings closure: missing - main prior fixes are present, but the round-3 wrapper operand class remains incomplete for configured wrappers beyond `env`/`nice`; see Finding 1.

Findings:
- severity: P1
  failure class: policy-bypass / path-safety
  violated invariant/contract: A bash write or mutation targeting `data/raw/**` must be denied before the wrapped tool executes and leave synchronized remediation/WS/audit evidence for that rule.
  concrete scenario: A tool call with `command: "sudo -u root rm data/raw/input.csv"` is tokenized as `sudo`, `-u`, `root`, `rm`, `data/raw/input.csv`. The detector skips only the `-u` option, treats `root` as the command, returns allow, and the wrapped bash tool can execute the raw-data delete.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:23` includes `sudo`/`doas` as wrappers; `packages/core/src/tools/data-raw-write-rule.ts:24` only declares operand-consuming options for `env` and `nice`; `packages/core/src/tools/data-raw-write-rule.ts:203` skips wrapper options using that incomplete map; allowed decisions execute the inner tool at `packages/core/src/tools/policy-gate-registry.ts:168`.
  consequence: Protected raw input can be mutated without policy denial, so the tool result, `tool.failed` remediation payload, and audit row are never produced for the same rule.
  fix direction: Consume operand-taking options for every configured wrapper, at minimum `sudo -u/--user`, `sudo -g/--group`, and `doas -u`; consider fail-closed handling for unknown wrapper options that can hide the real command.
  required test/proof: Add wrapped-bash denial tests asserting `calls === 0` and rule/remediation payload for `sudo -u root rm data/raw/input.csv`, `sudo --user root rm data/raw/input.csv`, and `doas -u root rm data/raw/input.csv`, while preserving existing read-only allow cases.
  sibling surfaces: `sudo`, `doas`, `time`, other wrapper commands with operand-bearing flags, data/raw mutation detector, future WS/audit evidence producers.
  blocking status: blocking

Non-blocking notes:
- Read-only review only; I did not run the Bun test suite. `git diff --check` was clean.
