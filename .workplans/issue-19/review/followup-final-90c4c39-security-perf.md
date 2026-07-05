# Follow-up Final Review - security/performance - 90c4c39

Reviewer agent: review-security-perf
Review round: follow-up final after e4f00c3 fixes
Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Summary: Two blocking candidate findings remain in the e4f00c3 fix surface: ambient `LC_*` env leakage and adversarial fake-wait `Popen` lifecycle bypass.

## Invariant Matrix Coverage

- Bash may read `data/raw/**`: covered.
- Bash must not create/modify/delete/rename/truncate protected raw bytes: covered under stable config.
- Evidence identity includes guard/profile id, remediation, `tool.failed`, and `workspace/tasks/TASK-M1-SPIKE/audit/`: covered.
- Legal workspace writes allowed: covered.
- Legal waited foreground child process allowed: covered for the spec example only; see Finding 2.
- Pre-existing hardlink residual demonstrated and bounded `nlink>1` scan detects: covered.
- Obvious advisory raw write may pre-deny with remediation/audit/WS: covered.
- Hidden denial / post-exec sandbox-denial telemetry not claimed: covered.
- Arbitrary descendant ownership out of #19 scope: covered as documented, but selected Python `Popen` preflight still has a bypass in Finding 2.
- `zero` diff stays 0 and pinned: covered.
- Prior e4f00c3 ambient-env finding: still failing in narrowed form - arbitrary ambient `LC_*` variables are copied into the child environment.
- Prior e4f00c3 un-awaited Python `Popen` finding: still failing in adversarial form - any later textual `p.wait()`/`p.communicate()` satisfies the check even if unreachable.
- Prior e4f00c3 stale root finalization, WS snapshot, fuse snapshot findings: covered.

## Findings

- Severity: P1
  Failure class: information disclosure / sandbox environment boundary
  Violated invariant/contract: Sandboxed bash must not inherit ambient host secrets; explicit secrets must pass only through registered secret references.
  Concrete scenario: Parent process has `LC_API_KEY=ambient-lc-secret`; sandboxed command runs `printf "$LC_API_KEY"` or exfiltrates it over the allowed network profile. Because `LC_API_KEY` matches the broad locale regex, it is copied into the child and is not registered with `secretFilter`.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` iterates `process.env`, copies keys matching `isLocaleEnvName`, and `isLocaleEnvName` accepts any `LC_[A-Z_]+`.
  Consequence: Ambient credentials with an `LC_*` name can leak to arbitrary bash commands and command output without redaction, partially reopening `cand-final-e4f00c3-01`.
  Fix direction: Replace the `LC_*` wildcard with a finite set of standard locale keys required by runtime behavior, or provide safe fixed defaults instead of inheriting parent values.
  Required verification: Set `process.env.LC_API_KEY = "ambient-lc-secret"` and assert child `env`/output does not include the key or value; separately assert intended locale keys and explicit `envSecrets` still behave as expected.
  Sibling surfaces: `PATH`, temp, terminal, and `ZERO_*` are the remaining inherited env surfaces.
  Blocking status: Blocking.

- Severity: P1
  Failure class: process lifecycle / containment bypass
  Violated invariant/contract: Normal completion must not report allowed while statically detectable un-awaited interpreter subprocesses can continue mutating workspace; legal waited foreground children must remain allowed.
  Concrete scenario: `python3 -c 'import subprocess; p=subprocess.Popen(["sh","-c","sleep 0.25; printf leaked > workspace/fake-wait.txt"]); if False: p.wait()'` passes the current static wait check because a later `p.wait()` token exists, but Python exits without waiting and the child can write after the wrapper returns `allowed`.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` checks only for an assigned name and accepts any later regex match for `.wait()`/`.communicate()`.
  Consequence: A simple adversarial payload can bypass the e4f00c3 `Popen` fix and create delayed workspace side effects after tool finalization/audit, partially reopening `cand-final-e4f00c3-02`.
  Fix direction: Treat ambiguous waits as unsafe. Only allow direct chained waits or simple top-level, unconditional assignment-then-wait forms before interpreter exit; otherwise fail closed with `policy_gate_process_containment_unavailable`.
  Required verification: Add a Python case with `if False: p.wait()` or a function-defined `p.wait()` after `Popen`; assert process-containment failure, no immediate or delayed workspace file, and audit decision `policy_gate_process_containment_unavailable`. Keep the existing `sys.exit(p.wait())` positive test green.
  Sibling surfaces: Same regex weakness applies to `.communicate()` and future interpreter-specific wait recognition.
  Blocking status: Blocking.

## Non-blocking Notes

- Reviewer did not rerun tests; review used read-only source/diff inspection plus diff-check/zero guard.
