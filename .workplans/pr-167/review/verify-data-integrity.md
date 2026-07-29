# Phase 4.5 — data-integrity

Reviewed head SHA: `e984729b30db43bdc22af738ddacc23fbbb8a751`

| Candidate | Verdict | Disposition | Evidence |
|---|---|---|---|
| DI-01 complete candidate set | CONFIRMED | FIX_NOW | `isCandidate` names workflow/OpenSpec, but filesystem inventory scans only `spikes/**`. Public reproductions for untracked spec, untracked exact workflow, and synchronized mandatory `proposal.md` plus manifest deletion all falsely succeeded. Spec/design make these admitted lanes mandatory. |
| DI-02 HEAD binding | REFUTED | — | Staged drift succeeds intentionally: the fixture's unborn-repo `git init` + `git add` oracle must succeed. Git/HEAD authority is assigned to #166/Task 5.1; “at its own HEAD” describes committed manifest initialization, not this public precommit seam. |

DI-01 requires rule-driven all-lane inventory, unconditional mandatory-file presence, and public negative tests while excluded evidence paths remain allowed.
