# Phase 5/6 invariant closure — index ordering

PR: #167
Reviewed SHA: `3d0d35a110ed66b80a2b4cca95b1028bfdc09853`
Verified finding: `cand-6-2-order-01` — CONFIRMED / FIX_NOW, P1 `compatibility`.

Invariant: before candidate filtering, every decoded stage-0 index path is valid UTF-8/canonical, globally unique, and strictly ordered by the raw UTF-8 byte ordering required by Git index representation. A rehashed out-of-order index must never become authority merely because downstream candidate output is sorted.

Required closure: add the predecessor check at the parser ownership layer; test normal/linked rehashed v4 reorder failure through the public seam; ensure legal v2/v3 acceptance still holds. Preserve all no-write/no-child, checksum, extension, duplicate, and #162/#166 boundaries.
