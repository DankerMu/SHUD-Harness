# PR #48 round 4 review failure retro

Reviewed head SHA: `1c18247d9acaac53d751186526ee5f35fb9907b6`

Failure classes:

- denial classification / false success / false denial
- audit/evidence path durability
- runtime registry / central policy-gate integration

Rounds affected:

- Round 1/2 caught raw-denial evidence and audit projection gaps.
- Round 3 caught exit-masked denials, guard-class vocabulary, profile/audit path poisoning, and hardlink scanner bounds.
- Round 4 still found sibling variants of the same denial/evidence invariants plus a registry composition gap.

Why Phase 5/6 did not close it:

- Fixture scope gap: no. 条 2' already says shell semantics are not an authority boundary and audit/tool.failed evidence must stay bound to OS-denied raw-write attempts.
- Fix prompt too narrow: yes. The prior fix chased named shell masks (`|| true`, `; true`) instead of expressing a single fail-closed rule for commands that can hide raw-write failures.
- Reviewer finding contract vague/inconsistent: no. The current findings include concrete commands, evidence paths, and required tests.
- Missing regression evidence: yes. There was no test for `:`, `exit 0`, interpreter-internal `try/catch`, legal raw-read false positives, stale audit reservation failure, public audit helper omitted protection, or central policy-gated SHUD runtime assembly.
- PR too broad / should split: no. These are all inside the #19 wrapper/registry/evidence boundary; splitting would leave the same invariant unclosed.

Next corrective action:

- Invariant closure retry, not line-item patching.
- Treat audit reservation failure as a fail-closed pre-execution error or durable parent-owned fallback; do not execute bash when mandatory audit persistence is impossible.
- Protect the evidence namespace at the correct root (`workspace/tasks` or a parent-owned non-writable path), not just the final `audit` leaf.
- Separate successful-result denial classification from failed-result denial classification so legal raw reads/workspace writes with denial-like output cannot false-deny.
- Expand hidden raw-write pre-denial to cover dynamic/interpreter forms that can swallow OS denial and exit 0.
- Compose SHUD runtime registry through the central policy-gate wrapper after sandboxed bash/spawn rebuild, then assert final registry.

Review after fix:

- Required. This PR has completed four comprehensive review rounds. The next comprehensive round is round 5 and must be treated as a hard convergence check before any Phase 7 final review.
