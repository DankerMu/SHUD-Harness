Reviewer agent: review-correctness
Review round: follow-up round 2 after fixes
Reviewed head SHA: 618bc86f1708513d3bf2666537fde0359019c800

Summary: Phase 6.5 closes candidate-file, synthetic-oracle, and no-partial-output evidence gaps, but a valid Git index representation remains unsupported.

Findings:

- Severity: P1
  - Failure class: compatibility
  - Violated invariant/contract: `--check-current` must validate the current HEAD's valid Git-tracked regular-file set rather than reject a valid Git index representation as schema-invalid.
  - Concrete scenario: in a normal SHA-1 temporary clone, `git config index.version 4 && git update-index --index-version 4` produces `DIRC 00 00 00 04`; the public command returns exit 2, empty stdout, and `CONTRACT_SCHEMA_INVALID` although the manifest, tracked blobs, and worktree have not drifted.
  - Evidence: `spikes/git-status-capability/contracts/lib/current-source.ts:131-132` accepts only index v2/v3; `openspec/changes/m2-capability-observer-spike/specs/git-status-capability-spike/spec.md:345-357` requires exact Git-tracked manifest authority; `openspec/changes/m2-capability-observer-spike/tasks.md:98` includes v4 Git index coverage.
  - Consequence: a legal `index.version=4` worktree cannot pass source authority, blocking downstream source digest/evidence work and falsely reporting a harness-invalid state.
  - Fix direction: parse Git index v4 prefix compression with bounded/checksummed fail-closed behavior, or use an equally no-child restricted v2-v4 parser; retain rejection for unknown/corrupt versions.
  - Required test/proof: create valid normal and linked-worktree v4 indexes and prove two exact public success receipts with no status/file changes and no child launch.
  - Sibling surfaces: `readIndex` is shared by normal and linked-worktree paths.
  - Blocking: yes

Non-blocking notes:

- None.
