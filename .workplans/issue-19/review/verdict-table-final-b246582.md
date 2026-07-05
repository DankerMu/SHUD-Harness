# Phase 4.5 Verdict Table — final comprehensive follow-up b246582

PR: #48
Reviewed head SHA: `b2465822329f0183987d0a4ff2b5018e835277a0`
Fixture: expanded / high
Review reports:
- `.workplans/issue-19/review/followup-final-b246582-correctness.md`
- `.workplans/issue-19/review/followup-final-b246582-integration.md`
- `.workplans/issue-19/review/followup-final-b246582-security-perf.md`
- `.workplans/issue-19/review/followup-final-b246582-test-evidence.md`
- `.workplans/issue-19/review/followup-final-b246582-spec-compliance.md`
- `.workplans/issue-19/review/followup-final-b246582-invariant-state.md`

| Candidate | Origin | Verdict | Blocking input to Phase 5 | Evidence |
| --- | --- | --- | --- | --- |
| `cand-final-b246582-01-root-pid-reuse-before-first-identity` | review-correctness | CONFIRMED | yes | `.workplans/issue-19/review/verify-cand-final-b246582-01.md` |
| `cand-final-b246582-02-internal-test-helper-export` | review-integration | CONFIRMED | yes | `.workplans/issue-19/review/verify-cand-final-b246582-02.md` |
| `cand-final-b246582-03-audit-row-mutable-toctou` | review-security-perf | CONFIRMED | yes | `.workplans/issue-19/review/verify-cand-final-b246582-03.md` |
| `cand-final-b246582-04-hardlink-scan-prebudget-realpath` | review-security-perf | CONFIRMED | yes | `.workplans/issue-19/review/verify-cand-final-b246582-04.md` |
| `cand-final-b246582-05-public-raw-denial-builders` | review-invariant-state | CONFIRMED | yes | `.workplans/issue-19/review/verify-cand-final-b246582-05.md` |
| `cand-final-b246582-06-lstart-pid-identity-collision` | review-invariant-state | PLAUSIBLE | yes | `.workplans/issue-19/review/verify-cand-final-b246582-06.md` |

Dropped repeated candidate:
- Same actual `ToolResult` replay was already refuted at `bbae63f` and no relevant code changed.

Synthesis:
- Latest comprehensive cross-review is not clean.
- Descendant tracker host-process safety has repeated across multiple rounds and must move to a stronger design: avoid destructive normal-completion cleanup and avoid historical PID identity inference.
- Public telemetry/audit boundary must snapshot inputs before async work and remove reserved-denial construction/test helpers from package root API.
- Hardlink scanner budget must cover root canonicalization.
