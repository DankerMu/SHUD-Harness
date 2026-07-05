Closes #21

## Summary

- Add `policy-gate-spike-verdict.md` with the five-item M1 policy-gate spike evidence matrix.
- Update ADR-0001 execution status: Zero remains Trial and trigger 1 is active after #19 / PR #46 failed the final verifier gate.
- Mark OpenSpec task 3.5 as completed via the not-green/revisit path and record that policy-gate-dependent 3.x/5.x follow-ups are paused until the enforcement boundary is revisited.

## Validation

- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --cached --check`
- `git -C zero diff --quiet`
- `git -C zero rev-parse HEAD` = `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`

## Boundary Notes

- This PR records the #21 verdict only; it does not fix or merge #19.
- PR #46 remains draft spike evidence and is not merge-ready.
- #20 is recorded as stopped, not failed, because #19 already triggered the not-green branch.
