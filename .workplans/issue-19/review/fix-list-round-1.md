# Invariant Closure for PR #46

Failure class: path-safety / evidence-lineage
Selected risk packs: public bash/tool entrypoint; file IO/path safety; schema/error payload; evidence lineage; Zero adapter governance.

Invariant:
- A policy-denied bash write to `data/raw/**` must be stopped before execution and leave synchronized remediation, WS, and audit evidence for the same rule.

Verified findings:
- cand-01 CONFIRMED: bash write detector misses newline command lists, `dd of=`, `truncate`, `bash -c`, and `cp -t` forms.
- cand-02 CONFIRMED: audit helper allows `taskId`/`fileName` traversal outside `workspace/tasks/<task_id>/audit/`.
- cand-03 CONFIRMED: deny return path does not connect the same decision to WS/audit evidence; current tests build artifacts separately.

Required audit surface:
- Shared helper roots: `packages/core/src/tools/data-raw-write-rule.ts`, `policy-gate-audit.ts`, `policy-gate-registry.ts`; `packages/backend/src/ws/policy-gate-events.ts`.
- Public entrypoints: wrapped bash `run()` path.
- Write/delete/overwrite surfaces: command detector, audit append helper.
- Producer/consumer evidence boundaries: denied ToolResult, `tool.failed` payload, audit row.
- Stale-state/idempotency boundaries: no persisted state beyond append-only fixture audit NDJSON.
- Unchanged downstream consumers: generic ErrorRecord schema remains unchanged; policy-gate remediation keeps `ref` required.

Required behavior:
- Deny representative bash raw-data mutation forms before inner tool execution: newline command lists, `dd of=`, `truncate`, `cp -t`/`--target-directory`, and shell `bash|sh|zsh -c` wrappers.
- Preserve read-only compatibility: `cat data/raw/input.csv` and `cp data/raw/input.csv /tmp/out.csv` remain allowed.
- Audit writes must reject path traversal in `taskId` and `fileName` and stay within `workspace/tasks/<task_id>/audit/`.
- Provide a decision-derived deny evidence path so the same `PolicyGateDecision` produces matching tool result payload, `tool.failed` payload, and audit row identity/remediation proof.

Required regression matrix:
- `cat data/raw/input.csv\nrm data/raw/input.csv` -> deny before inner call; existing read-only single/multi-line commands still allow.
- `dd if=/dev/zero of=data/raw/input.csv`, `truncate -s 0 data/raw/input.csv`, `cp -t data/raw /tmp/input.csv`, `bash -c 'printf x > data/raw/input.csv'` -> deny before inner call.
- `appendPolicyGateAuditRow(..., { taskId: '../../outside' })` and path-bearing `fileName` -> stable rejection and no outside file.
- One denial decision -> returned tool payload, WS payload, and audit row share `rule_id`/`rule`, `guard_class`, `tool_id`, and remediation `ref`.

Verification:
- `/Users/danker/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
