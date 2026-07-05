# Follow-up Final Review - test evidence - 90c4c39

Reviewer agent: review-test-evidence
Review round: follow-up final after e4f00c3 fixes
Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`

Summary: Most issue #19 evidence is covered, but two candidate gaps remain around Popen reachability and ambient `LC_*` environment inheritance.

## Invariant Matrix Coverage

- Six escape classes byte-blocked: covered.
- Legal raw reads allowed: covered.
- Workspace writes allowed: covered.
- Waited foreground child process allowed: covered for the simple reachable case; see Finding 1 for unreachable/dead wait bypass.
- Obvious advisory raw write may pre-deny with remediation/audit/WS: covered.
- Post-exec process output/exit code remains generic lifecycle evidence: covered.
- Hidden denial telemetry and arbitrary descendant ownership not claimed: covered/out-of-scope.
- Pre-existing hardlink residual demonstrated and bounded `nlink>1` scan detects: covered.
- Evidence identity includes guard/profile id, `ErrorRecord.remediation`, `tool.failed`, and audit path: covered.
- Prior e4f00c3 ambient secret finding: partially covered; see Finding 2 for remaining `LC_*` wildcard.
- Prior e4f00c3 stale protected raw root finalization: covered.
- Prior e4f00c3 generic WS error snapshot: covered.
- Prior e4f00c3 fuse rule snapshot: covered.
- `zero` diff stays 0 and pinned: covered by supplied verification.

## Findings

- Severity: P1
  Failure class: process-lifecycle containment / test-evidence gap
  Violated invariant/contract: Prior e4f00c3 `cand-final-e4f00c3-02` and issue #19 lifecycle invariant require normal completion not to report allowed while a statically detectable un-awaited interpreter subprocess can keep mutating workspace state; only actually waited foreground children are allowed.
  Concrete scenario: A command such as `python3 -c 'import subprocess, sys; p=subprocess.Popen(["sh","-c","sleep 0.25; printf leaked > workspace/unreachable-wait.txt"]); sys.exit(0); p.wait()'` contains textual `p.wait()` after `Popen`, but the wait is unreachable. The preflight treats it as waited, the tool can complete as allowed, and the delayed child can write after completion.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` treats later `.wait()`/`.communicate()` text as static proof; tests cover only simple waited and simple no-wait cases.
  Consequence: The previous Popen fix is only partially closed; lifecycle/audit evidence may claim an allowed completed command while a reachable child side effect occurs after the wrapper returns.
  Fix direction: Make assigned `Popen` allowlisting control-flow conservative.
  Required verification: Add a `pythonSeatbeltTest` with unreachable or dead-branch wait, assert process-containment failure and no delayed workspace file, while preserving the positive waited foreground-child test.
  Sibling surfaces: `communicate()`, bare `from subprocess import Popen`, `asyncio.create_subprocess_*`, and other interpreter process-creation helpers.
  Blocking status: Blocking candidate.

- Severity: P2
  Failure class: information disclosure / environment sanitization evidence gap
  Violated invariant/contract: The sandboxed bash child must not inherit ambient host secrets unless explicitly passed through audited secret refs and redacted.
  Concrete scenario: If the host process has `LC_API_KEY=secret`, `buildSanitizedToolProcessEnv` will pass it through because every `LC_*` name is treated as locale-safe.
  Evidence: `packages/core/src/tools/raw-data-sandbox.ts` accepts any `LC_[A-Z_]+`; current sentinel test omits `LC_*` secret-shaped variables.
  Consequence: The ambient secret fix is narrower than the invariant and can leak secret-like host values through stdout, stderr, audit, or WS snapshots.
  Fix direction: Replace the broad `LC_*` regex with an explicit locale variable allowlist, or reject unrecognized `LC_*` names unless deliberately configured.
  Required verification: Add a sentinel such as `LC_SHUD_SECRET=raw-secret-value`, assert it is absent from the sandbox environment/output, and keep explicit `envSecrets` redaction coverage.
  Sibling surfaces: Other environment allowlist wildcards, audit row payloads, backend WS error snapshots, and any future tool-process env builder.
  Blocking status: Non-blocking candidate.

## Non-blocking Notes

- Local verification was not rerun in this read-only review; reviewer relied on supplied verification summary plus direct source/diff inspection.
