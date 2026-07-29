# Phase 6.2 invariant audit — v4 repair

PR: #167
Audited head SHA: `3a61a5449aae4620189d18112d5c2e9f066b1ec3`
Failure class: `compatibility`

Invariant audit: findings

## Invariant Surface Inventory coverage

- Shared helper roots: finding — `readIndex` accepts malformed trailing index data and only detects duplicates among candidate paths.
- Public entrypoints: clean — `--check-current` remains one receipt with no child/write seam.
- Read surfaces: finding — v2/v3/v4 parse declared entries but do not validate the remaining extension region.
- Write/delete/overwrite surfaces: clean — inspected implementation uses read-only filesystem APIs.
- Staging/publish/rollback surfaces: out-of-scope because #164 has no publish/rollback behavior.
- Producer/consumer evidence boundaries: clean — manifest, filesystem candidate inventory, index candidate set, and worktree blob IDs are cross-checked.
- Stale-state/idempotency boundaries: clean — normal and linked v4 tests assert repeated receipts, stable inventory/status, and zero child launches.
- Unchanged downstream consumers: out-of-scope because #162/#166 are excluded.

## Candidate finding

- P1 | `compatibility` | `readIndex` neither consumes the extension envelope to the checksum boundary nor validates duplicates for non-candidate records. A checksum-rehashed v4 index can insert arbitrary/truncated extension bytes after declared entries, and a duplicate stage-0 non-candidate entry is not rejected. | Evidence: `spikes/git-status-capability/contracts/lib/current-source.ts:133-135,140-193` | malformed/tampered v2/v3/v4 index can emit `current_source_authority` success | parse extension headers and declared lengths exactly to `bytes.length - oidLength`; reject incomplete/truncated data; validate decoded path ordering/duplicates for every entry before candidate filtering | add checksum-rehashed trailing/incomplete/oversized extension and duplicate non-candidate regressions through normal/linked public seams, all fail closed/no-write/no-child.
