# Review report -- security/performance -- observable 37cd38e

Reviewer agent: review-security-perf
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: Raw byte authority and main observable-boundary rows are mostly covered, but bounded-analysis telemetry and runtime resource limits still have candidate gaps.

Invariant Matrix Coverage:
- Six escape classes: missing for incomplete-analysis telemetry; byte protection covered.
- Legal raw read, workspace write, waited foreground subprocess: covered.
- Hardlink residual: covered.
- Static advisory: covered.
- `zero` unchanged: covered.

Findings:
- Severity: P1
  Failure class: error/evidence/audit contract; bounded command analysis
  Contract or invariant: Observable raw-write denials must produce evidence while unrelated failures must not claim raw-data denial.
  Scenario: Over-budget raw read plus unrelated permission error can become raw denial; conversely unsuppressed interpreter raw write after call-list cap can be missed because truncation is discarded.
  Evidence: over-budget branch classifies from output alone; call scanner returns `truncated` but the flag is dropped.
  Consequence: observable boundary inaccurate in both directions.
  Fix direction: preserve incomplete-analysis state; only claim raw sandbox denial on budget overflow with bounded raw-write signal; treat call-count truncation as incomplete rather than no-target.
  Required test/proof: over-budget unrelated permission remains generic; visible raw write after call cap returns `raw_data_write_denied`.
  Sibling surfaces: command-length budget, interpreter payload budget, call-count cap, registry-wrapped bash, advisory-disabled execution.
  Blocks merge: yes, candidate P1.

- Severity: P2
  Failure class: resource limits/performance
  Contract or invariant: Sandbox wrapper should avoid heavy periodic host scans and unbounded I/O buffering.
  Scenario: Long foreground command starts descendant tracker that shells out to `/bin/ps` every 20ms, and stdout/stderr accumulate without a byte cap.
  Evidence: 20ms sampling interval, `/bin/ps` per sample, unbounded output chunks.
  Consequence: long commands can create many `ps` processes and unbounded memory growth.
  Fix direction: remove/coarsen steady-state process-table polling; cap captured stdout/stderr with truncation metadata.
  Required test/proof: resource-bound tests for output truncation and long foreground command not high-frequency scanning.
  Sibling surfaces: abort/timeout cleanup, process preflight, waited foreground subprocesses, registry-created bash.
  Blocks merge: non-blocking P2, fix or explicitly defer.

Non-blocking notes:
- Audit path hardening and protected evidence directory handling are stronger than earlier rounds.
