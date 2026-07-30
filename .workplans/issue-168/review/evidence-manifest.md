# PR #170 review evidence manifest

Issue: #168
Branch: `codex/issue-168-source-ingress-capability`
Base: `origin/main` at `f8b74e724dc978acb889f715a936feabfd69680d`
Fixture: `expanded`; repair intensity: `high`
Round 1 reviewed head: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Round 1: not-clean; 7 verified FIX_NOW; highest major; classes resource,
contract, test-evidence.

Selected packs: correctness, integration, file-I/O/path and resource behavior,
test/evidence coverage, spec compliance, invariant/state/compatibility.

Invariant surfaces: fixture producer bytes; retained descriptor admission/read
helper; normalized source-record and four-SHA validators; the two direct public
entrypoints; failure/cleanup/resource paths; unchanged committed-oracle/live-Git/
publication/production siblings.

Implementation evidence: `.workplans/issue-168/implementation-evidence.md`.
Fix synthesis: `.workplans/issue-168/review/fix-synthesis-round-1.md`.
Plan deviation: only the two existing Linux/macOS CI jobs gained the pinned
focused test command required to make both-platform evidence a merge gate.
