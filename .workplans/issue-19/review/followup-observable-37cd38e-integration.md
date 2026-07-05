# Review report -- integration -- observable 37cd38e

Reviewer agent: review-integration
Review round: observable-boundary comprehensive round
Reviewed head SHA: `37cd38e0817df73a07bc08ce79b3e3750a2e1436`

Summary: Not clean; raw-byte authority and narrowed hidden-telemetry boundary are mostly aligned, but one observable false-denial path remains plus one wrapper-faithfulness API gap.

Invariant Matrix Coverage:
- Six escape classes: covered for visible/observable denials and hidden no-false-telemetry cases.
- Legal raw read, workspace write, waited foreground subprocess: covered.
- Hardlink residual: covered.
- Static advisory: covered.
- `zero` unchanged: covered.

Findings:
- Severity: P1
  Failure class: error/evidence/audit contract; false observable raw-denial classification under resource-limit fallback
  Contract or invariant: Observable `raw_data_write_denied` telemetry must only be emitted for advisory-caught raw writes or OS denials tied to a raw write target.
  Scenario: An over-budget command that reads `data/raw` but fails on unrelated `workspace/no-read.txt` can emit `Permission denied`. Because analysis is over budget, classifier can turn denial text alone into `denied_by_sandbox`.
  Evidence: budget overflow discards target evidence; post-exec classifier classifies over-budget denial output; under-budget unrelated permission failures are tested as generic, but no over-budget negative exists.
  Consequence: legal raw-read/unrelated workspace permission failure can be reported as raw-data policy denial.
  Fix direction: do not classify from denial text alone in budget-exceeded branch; require bounded raw-write target signal or keep generic failure.
  Required test/proof: over-budget raw-read plus unrelated permission regression asserting generic failed result/audit and no `raw_data_write_denied`.
  Sibling surfaces: interpreter write denial pattern, backend `tool.failed` builder input, audit rows, generated long commands.
  Blocks merge: yes, candidate P1.

- Severity: P2
  Failure class: wrapper/proxy faithfulness; public API contract ambiguity
  Contract or invariant: A wrapper/proxy surface must not silently drop existing BashTool lifecycle/fuse behavior or present an `innerTool` contract that is only metadata.
  Scenario: Caller passes `innerTool: new BashTool([...fuse...])`; constructor accepts it, but wrapper does not preserve inner fuse rules and runs sandboxed bash directly.
  Evidence: `innerTool` is used as metadata; wrapper fuse checker is empty for that branch; explicit `fuseRules` branch is tested but `innerTool` branch is not.
  Consequence: future adapter users can unintentionally disable fuses/custom pre-execution behavior.
  Fix direction: remove/rename `innerTool` option or preserve/compose inner fuse/lifecycle contract.
  Required test/proof: regression with inner tool fuse rejection or compile-time removal of option.
  Sibling surfaces: sandboxed bash factory, future Zero `BashTool` upgrades, custom adapters.
  Blocks merge: non-blocking P2, but should fix or explicitly defer before treating `innerTool` as public API.

Non-blocking notes:
- Raw denial payload, audit row, and WS event input share one payload source.
