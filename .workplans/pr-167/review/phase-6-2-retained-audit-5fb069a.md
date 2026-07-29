# Phase 6.2 retained-slice invariant audit

Reviewed head: `5fb069adca07f9e546928a1f281a466d5bc13cdd`
Result: not clean; two P1 blocking candidates.

1. `p62-path-01` (`path-safety`): public retained reads used pathname `lstat`
   admission without a held ancestor descriptor. A repository-root upper
   symlink alias returned the exact success receipt; both direct input kinds had
   the sibling surface. Independently verified CONFIRMED/FIX_NOW.
2. `p62-evidence-01` (`test-evidence`): committed manifest still identified the
   prior head and the final behavior proof did not bind the complete contracts,
   test/helper, fixture, and golden tree. Independently verified
   CONFIRMED/FIX_NOW.

Implementation closure for the first finding is commit
`6b474b4f78295cab8df59a785913955729943640`: shared libc `openat` traversal opens
every component with `O_NOFOLLOW`, pins the final descriptor, and revalidates the
descriptor path around bounded reads. Public regressions cover upper/parent
symlinks and deterministic ancestor replacement for current and both direct
input kinds. The second finding is closed by the SHA/tree-bound final proof and
manifest refresh carried with this audit history.

Independent audit verification before closure: focused 24/24; three public
receipts; strict OpenSpec; full check; fixed-base scope/submodules/hygiene; clean
archive mutation replay 16/8. The upper-symlink reproduction incorrectly exited
0. Final retained-slice re-audit is required on the pushed closure/evidence head.
