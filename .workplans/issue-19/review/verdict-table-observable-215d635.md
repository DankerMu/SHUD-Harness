# Verifier verdict table -- PR #48 observable 215d635

Reviewed head SHA: `215d635e8edc6c4e5db3af8b833cf377fdda02cc`

| Candidate | Verdict | Blocking input | Failure family | Rationale |
| --- | --- | --- | --- | --- |
| cand-observable-215-01 | CONFIRMED | yes | evidence/audit false positive / observable-denial attribution | User-controlled or unrelated target-qualified denial text can satisfy `lineMentionsTarget()` and upgrade syntactic raw targets to `denied_by_sandbox`. |
| cand-observable-215-02 | CONFIRMED | yes | evidence/audit identity collapse across sibling roots | Outer raw deny carries only `ruleId`; re-running the inner advisory against command text can attach the sandbox profile for a different root when an inner raw sibling target appears in the command. |

Counts:
- CONFIRMED: 2
- PLAUSIBLE: 0
- REFUTED: 0

Gate status: not clean. Return to Phase 5/6. Because this is the same high-risk evidence/audit attribution class repeating after the prior invariant pass, perform a review-failure retro and change strategy before another fix/review round.
