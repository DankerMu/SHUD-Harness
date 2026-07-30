# Review Failure Retro

PR: #170, current head SHA: `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`

Failure classes: test-evidence

Rounds affected:

- Round 1 at `89eb2aad7895d837617d243a8ce82e3cdc45b211`:
  `.workplans/issue-168/review/verify-test-evidence-1.md`
- Round 2 at `f49ac2704619bafa31504691daee2a2360ce3452`:
  `.workplans/issue-168/review/verify-test-evidence-round-2.md`
- Round 3 at `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`:
  `.workplans/issue-168/review/verify-test-evidence-round-3.md`

Failure shape: depth

Invariant: after admission, active evidence must independently reject every
reachable ambient filesystem/process authority form through the same import and
input surfaces production code can use; implementation-selected observers or
partial wrapper vocabularies are not proof.

Recurring findings:
- Round 1: the operation observer was self-reported and did not intercept unreported production calls.
- Round 2: controls selected test-owned wrappers while normal production module imports remained uninterposed.
- Round 3: module interposition covered string routes but omitted supported PathLike forms and `node:fs/promises`, so production-reachable ambient reads still bypassed on both platforms.

Why Phase 5/6 did not close it:

- Fixture scope gap: yes — the fixture named operation categories but did not
  enumerate the closed module/API/input-type authority surface.
- Fix prompt too narrow: yes — it requested normal-import interposition without
  requiring every supported PathLike and module alias.
- Reviewer finding contract vague/inconsistent: no — each round correctly found
  a concrete reachable bypass.
- Missing regression evidence: yes — mutations followed only the previously
  known route and did not vary module alias and PathLike representation.
- Cause never diagnosed (no red repro before fixes): no — each local route had a
  red reproduction, but the invariant inventory was incomplete.
- PR too broad / should split: no — every possible child retains the same shared
  authority-proof defect; splitting would replicate rather than isolate it.

Next corrective action:

- Refactor/redesign the proof around a closed authority surface: define one
  PathLike normalizer for string/Buffer/file-URL, enumerate and interpose the
  allowed Node FS sync/promise aliases plus Bun/FFI/process routes, make the
  production static audit reject everything outside the closed vocabulary, and
  run a compiling cross-platform mutation matrix spanning representation and
  module/API variants before the next comprehensive review.
