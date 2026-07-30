# PR #170 review evidence manifest

Issue: #168
Branch: `codex/issue-168-source-ingress-capability`
Base: `origin/main` at `f8b74e724dc978acb889f715a936feabfd69680d`
Fixture: `expanded`; repair intensity: `high`
Round 1 reviewed head: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Round 1: not-clean; 7 verified FIX_NOW; highest major; classes resource,
contract, test-evidence.
Phase 6.2 audited fix base: `052cb0719b9e10f0cbc18084bda1e41ec74e29cb`.
The invariant audit found two P1 gaps: malformed JSON could lose to pending
item/node ceilings, and authority controls did not execute independently
intercepted OS operations. Both are closed in the post-audit tree.
Round 2 reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`.
Round 2: not-clean; 4 verified FIX_NOW findings covering nonfinite precedence,
production-import interposition, audit availability, and workflow scope. The
current worktree implements the fix synthesis and awaits the next review gate.

Selected packs: correctness, integration, file-I/O/path and resource behavior,
test/evidence coverage, spec compliance, invariant/state/compatibility.

Invariant surfaces: fixture producer bytes; retained descriptor admission/read
helper; normalized source-record and four-SHA validators; the two direct public
entrypoints; failure/cleanup/resource paths; unchanged committed-oracle/live-Git/
publication/production siblings.

Implementation evidence: `.workplans/issue-168/implementation-evidence.md`.
Fix synthesis: `.workplans/issue-168/review/fix-synthesis-round-1.md`.
Round 2 fix synthesis: `.workplans/issue-168/review/fix-synthesis-round-2.md`.
Invariant audit: `.workplans/issue-168/review/phase-6-2-invariant-audit-052cb07.md`.
Compiling Phase 6.2 red proof:
`.workplans/issue-168/red-proof-phase-6-2.md` and
`.workplans/issue-168/red-proof-phase-6-2.patch`.
Compiling Round 2 red proof: `.workplans/issue-168/red-proof-round-2.md` and
`.workplans/issue-168/red-proof-round-2.patch`.
Plan deviation: none. Existing CI workflows match `origin/main`; no isolated
workflow is added in this issue.

Post-Round-2-fix verification: Darwin focused 25 pass / 0 fail / 532 assertions;
Linux Bun 1.2.19 focused 25 pass / 0 fail / 484 assertions; both direct public
commands, typecheck, full repository check, strict OpenSpec, diff/stash/submodule
and scope hygiene all pass. Round 2 final verification is recorded in the
implementation evidence after the synthesized fixes.
