# Phase 6.2 verifier verdict

Reviewed head: `4d7fa1664d2fcf718daaa800d8a5d13878a65912`

| Candidate | Verdict | Disposition |
|---|---|---|
| `p62-data-01` semantic pathname reopen | CONFIRMED | FIX_NOW |

T1 passed: each candidate descriptor is read, verified and closed before metadata,
frame, and sidecar are independently reopened by pathname for semantic parsing;
the deterministic hook can replace an already verified semantic source while
later entries are processed.

T2 passed: `--check-current` can issue success using semantic bytes that are not
the descriptor/index/blob-verified filesystem identity.

T3 passed: the Task 1.1a fixture requires descriptor-bound reads, no ambient
pathname reopen, and exact source bytes before a success receipt. Existing tests
cover only replacement between initial `lstat` and the first descriptor open, not
the later semantic-read window.

Transport note: an initial verifier instance was blocked by the platform content
filter on three attempts and produced no verdict. A fresh verifier instance
completed the adjudication above.
