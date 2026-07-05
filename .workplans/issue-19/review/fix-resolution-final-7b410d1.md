# Phase 6 Fix Resolution: Final Follow-up 7b410d1

Base head: 7b410d1745ba82657ac66a5175c568d32d875abc

Fixes applied:
- `cand-7b410d1-01`: `writeRawDataSeatbeltProfileFile` / profile-file creation now reject relative `profileRoot` before directory creation. Tests cover cwd drift and absolute `profileRoot` compatibility.
- `cand-7b410d1-02`: public audit append and generic WS builder reject reserved raw-denial `error_id` prefixes. Lifecycle `raw-data-write:failed:*` remains allowed.
- `cand-7b410d1-03`: raw advisory WS input now carries runtime provenance proof tied to sandbox-owned evidence; hand-authored structural input is rejected, while actual sandbox advisory denial evidence is accepted.
- `cand-7b410d1-04`: affected 3aa3 evidence files had blank EOF lines removed.

Verification:
- Focused raw/registry/WS tests: 167 pass, 0 fail.
- Full `bun run check`: passed; policy/raw 166 pass, backend WS 5 pass, schemas 6 pass.
- OpenSpec strict validation: valid.
- Diff/zero checks: `git diff --check`, scoped full diff-check, and zero clean captured before commit.
