Review Failure Retro:
PR: #167, current head SHA: a04f5c379a290ade2fe43a408e613bd95fc88088
Failure classes: compatibility, contract, data-integrity, test-evidence
Rounds affected: Round 1 e984729b30db43bdc22af738ddacc23fbbb8a751; Round 2 618bc86f1708513d3bf2666537fde0359019c800; Round 3 a04f5c379a290ade2fe43a408e613bd95fc88088
Failure shape: depth
Depth evidence:
- Invariant: Task 1.1a may emit source authority only after every representation of the same source identity — config, index, manifest, paths, worktree descriptors and evidence — is parsed completely and bound to one fail-closed domain.
- Recurring findings:
  - incomplete governed candidate set and public evidence gaps (Round 1)
  - legal v4 index rejected, followed by sibling index structural gaps (Round 2 / Phase 6.2)
  - config, global mode, pathname identity, source path domain and evidence binding gaps (Round 3 sibling surfaces)
Why Phase 5/6 did not close it:
- Fixture scope gap: yes - config authority and the exact cross-representation path/read invariant were not selected precisely enough in the initial risk table.
- Fix prompt too narrow: yes - successive prompts closed individual index grammar rows rather than one full source-authority grammar and descriptor boundary.
- Reviewer finding contract vague/inconsistent: no - all verified findings included concrete public scenarios and proofs.
- Missing regression evidence: yes - red-proof summaries were not persisted as a SHA/source-bound replay artifact.
- Cause never diagnosed (no red repro before fixes): no - every source fix had a red-capable public reproduction; the remaining failures have direct reproductions.
- PR too broad / should split: no - config/index/path/manifest/evidence are mutually dependent representations behind the single minimal mergeable `--check-current` / source-ingress slice; splitting would leave no child with independently valid source authority and would duplicate the same invariant.
Next corrective action:
- invariant closure retry: centralize the exact path domain and descriptor-based worktree admission, complete common-config/index grammar validation, correct the fixture/evidence mapping, and persist one batched red-proof replay. This deviates from the generic depth default of diagnosis/refactor because causes are already reproduced; the needed refactor is invariant ownership, not further diagnosis.
