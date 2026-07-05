# Follow-up Final Review - spec compliance - 90c4c39

Reviewer agent: review-spec-compliance
Review round: follow-up final after e4f00c3 fixes
Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Summary: One P1 candidate remains: the prior ambient-env-secret fix still leaks arbitrary `LC_*` host variables; #19 raw byte authority and trusted telemetry boundary otherwise match the revised spec.

## Invariant Matrix Coverage

- Task 3.3 / Issue #19 acceptance checklist: covered - profile builder, wrapper, six escape classes, legal allow cases, hardlink residual, advisory/audit/WS, out-of-scope markings, and `guard_class` are represented in code/tests.
- Execution-layer raw byte authority: covered - `RawDataSandboxedBashTool` builds a seatbelt profile and launches via absolute `sandbox-exec -f`.
- Six escape classes byte-blocked: covered - interpreter, pipeline/stdin, dynamic target, shell state/child, symlink/`../`, and rename/unlink cases are table-tested.
- Legal raw read, workspace write, waited foreground child: covered - raw copy/workspace writes and waited Python `Popen(...).wait()` are allowed.
- Trusted raw-denial evidence identity: covered - advisory-owned denial emits remediation, `guard_class`, profile id, audit row, and WS input.
- WS `tool.failed` skeleton: covered - trusted raw advisory builder preserves existing `tool.failed` only, with `seq`/`event_id` envelope.
- Post-exec output/exit remains generic lifecycle evidence: covered - post-run audit writes only `allowed|failed`, not `denied_by_sandbox`.
- Hidden denial / arbitrary descendant lifecycle not overclaimed: covered.
- Pre-existing hardlink residual and bounded `nlink>1` scan: covered.
- Stable root binding / no cwd drift: covered.
- Outer `RAW_DATA_WRITE_RULE_ID` ownership: covered - outer evaluator denial fails closed as misconfiguration.
- Zero untouched and pinned: covered.
- Prior e4f00c3 cand-01 ambient env secrets: still failing - arbitrary `LC_*` variables are copied into the child environment.
- Prior e4f00c3 cand-02 un-awaited interpreter child: closed.
- Prior e4f00c3 cand-03 stale protected raw root finalization: closed.
- Prior e4f00c3 cand-04 generic WS error snapshot: closed.
- Prior e4f00c3 cand-05 fuse rule object mutation: closed.

## Findings

- Severity: P1
  Failure class: information-disclosure / wrapper-faithfulness
  Violated invariant/contract: Sandboxed bash must not inherit ambient host secrets; explicit secrets must pass only through registered secret references.
  Concrete scenario: If the parent process has `LC_API_KEY=secret` or `LC_PASSWORD=secret`, any sandboxed bash command can print `$LC_API_KEY` or inspect `env` and receive the secret without using `envSecrets`, so the prior e4f00c3 ambient-secret finding is not fully closed.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` copies parent env entries and admits `isLocaleEnvName(key)`; `isLocaleEnvName()` currently accepts any `LC_[A-Z_]+`.
  Consequence: Host secrets with an `LC_` prefix bypass the explicit secret resolver/filter path and can be exfiltrated through command output or child process behavior.
  Fix direction: Replace the broad `LC_*` regex with an explicit locale allowlist, such as `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, and only other standard locale categories intentionally needed.
  Required verification: Add a regression setting `process.env.LC_API_KEY` or `process.env.LC_PASSWORD`, run sandboxed `env`/`printf "$LC_API_KEY"`, and assert the value/name is absent; keep standard locale variables if intentionally allowed.
  Sibling surfaces: Review all ambient allowlisted keys: `PATH`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `TERM`, `COLORTERM`, explicit `envSecrets`, and `ZERO_*` context variables.
  Blocking status: Blocking candidate; current head still violates prior e4f00c3 cand-01.

## Non-blocking Notes

- Reviewer did not rerun Bun/OpenSpec commands; assessment is from read-only diff, spec, tests, issue, and local git inspection.
