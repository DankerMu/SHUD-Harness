# Review report -- correctness -- observable 37cd38e

Reviewer agent: review-correctness
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: Raw-byte seatbelt authority is largely intact, but candidate evidence-boundary gaps remain for visible symlink-alias denials and raw policy-gate deny delegation under stale/mismatched registry inputs.

Invariant Matrix Coverage:
- Six escape classes raw-byte protection: covered.
- Observable denial telemetry for six escape classes: missing for visible symlink-only raw alias denial; see finding 1.
- Hidden/suppressed OS denials: out-of-scope and covered by no-false-telemetry tests.
- Legal raw read, workspace write, waited foreground subprocess: covered.
- Pre-existing hardlink residual: covered.
- Obvious static raw write advisory: missing for outer `raw-data-write` policy denial delegation; see finding 2.
- `zero` source unchanged at `13e25c1`: covered.

Findings:
- Severity: P1
  Failure class: observable denial evidence / symlink-alias classification gap
  Contract or invariant: Six escape classes targeting `data/raw/**` must preserve raw bytes, and observable OS denials must produce remediation-shaped tool failure plus `tool.failed`/audit denial evidence.
  Evidence: post-exec classification requires `analysis.hasKnownRawWriteTarget`; lexical analysis covers `data/raw` targets but not literal workspace symlink targets. Existing symlink test combines symlink write with a `../data/raw` write, so it does not prove symlink-only telemetry.
  Scenario: Pre-create `workspace/link-to-raw.txt -> data/raw/symlink-visible.txt`, then run `printf x > workspace/link-to-raw.txt` with visible stderr. Seatbelt rejects the syscall, raw bytes stay unchanged, but command text has no lexical raw target and may record generic failed evidence.
  Consequence: Observable denial surface can be misclassified even though bytes are protected.
  Fix direction: Add bounded symlink-aware target resolution for literal write operands before post-exec classification, or explicitly revise boundary for unresolvable symlink aliases.
  Required test/proof: symlink-only visible denial regression asserting `raw_data_write_denied`, `decision=denied_by_sandbox`, profile/audit identity, and no raw mutation.
  Sibling surfaces: redirections, `tee`, `cp`/`mv`/`install` destinations through symlinks, command-created symlinks, protected evidence aliases.
  Blocks merge: yes, candidate P1.

- Severity: P1
  Failure class: policy-gate deny bypass / stale boundary mismatch
  Contract or invariant: A central policy-gate `deny` must not execute the underlying tool, and stale/mismatched boundary inputs must not violate invariants.
  Evidence: `policy-gate-registry.ts` detects deny but delegates `raw-data-write` denials back into `this.innerTool.run()`. Inner advisory can be disabled and inner `protectedRawPaths` can differ from the outer evaluator.
  Scenario: Outer evaluator returns `ruleId: "raw-data-write"` deny for raw root A while inner sandbox protects raw root B or has advisory disabled; adapter ignores outer deny and executes.
  Consequence: Explicit deny can be dropped; stale-root cases can become raw-byte mutation.
  Fix direction: Do not execute after an outer deny. Convert the already-computed deny into raw denial evidence or guarantee a single shared raw-root/advisory source.
  Required test/proof: registry tests for explicit outer raw deny with disabled/stale inner advisory asserting no side effect and denial evidence.
  Sibling surfaces: runtime registry, sandboxed bash factory, custom policy evaluators, future role/profile rules.
  Blocks merge: yes, candidate P1.

Non-blocking notes:
- None.
