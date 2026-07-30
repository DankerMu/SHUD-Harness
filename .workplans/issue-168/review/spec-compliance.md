# PR #170 Round 1 — spec compliance

Reviewer agent: spec-compliance
Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Summary: Core implementation and scope match, but evidence gates are incomplete.

## Findings

- P1 `test-evidence`: exact-head Linux focused descriptor/replacement/cleanup run is absent; the configured CI command omits the suite.
- P1 `test-evidence`: voluntary operation callbacks are not the independent syscall/open proof required by the fixture.
- P1 `test-evidence`: missing-module red errors do not prove behavioral assertions bite.
- P2 `spec-completeness`: exact legal depth 12 is not tested, only +1 rejection.

The required fixes/proofs are respectively: pinned Linux output at the reviewed SHA; a fault-controlled independent boundary trace; a compiling behavior-level mutation matrix; and exact-depth/public-receipt pairing. #169/#166/#162/runtime/network exclusions remain intact.

Invariant matrix: descriptor implementation, normalized record, tuple/four-SHA binding and receipts covered; Linux/tripwire/red/depth evidence missing.
