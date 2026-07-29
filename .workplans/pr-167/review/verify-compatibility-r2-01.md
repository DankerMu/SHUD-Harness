Verifier verdicts for batch: compatibility-r2-01 (1 candidate)
Reviewed head SHA: 618bc86f1708513d3bf2666537fde0359019c800

Candidate: cand-r2-01
Verdict: CONFIRMED
Disposition: FIX_NOW
Evidence: `current-source.ts:131-132` rejects every `DIRC` version except v2/v3 before manifest/worktree verification. Normal and linked layouts both reach `readIndex(gitDirs.worktree, algorithm)` (`current-source.ts:94-120`, `:252-264`), so a valid v4 per-worktree index fails at the public seam, whose catch maps it to exit 2 / `CONTRACT_SCHEMA_INVALID` (`checker.ts:51-63`). The fixture requires exact current Git-tracked regular-file authority with no v4 exclusion (`spec.md:345-357`), declares the public success receipt (`spec.md:216-222`), and names v2/v4 coverage (`tasks.md:98`). Existing repeat/no-write/no-child tests use only the default index.
Note: T1 reachability, T2 public impact, and T3 OpenSpec task/spec anchor all pass; the gap was introduced by this PR relative to `f8b74e7`.
