# Phase 6.2 final index audit

Audited head SHA: `72d71e468a8938b92e98be27ed2fd3af257ada06`
Invariant audit: findings

Surface inventory: shared parser/public/read/evidence surfaces have findings; write/delete and stale-state surfaces are clean; staging/publish and #162/#166 downstream behavior are out of scope.

## Candidates

- `cand-entry-flags`: P1 `compatibility` — `readIndex` checks stage but not v2 extended-bit legality, 12-bit pathname length, v3/v4 extended flags, or v2/v3 zero padding. A checksum-rehashed structurally invalid entry can emit public success. Required proof: normal/linked v2/v3/v4 name-length, extended-flag, and padding mutations fail closed/no-write/no-child.
- `cand-extension-semantics`: P1 `compatibility` — fixed extension allowlist reverses Git semantics: uppercase optional extensions should be skippable, while mandatory lowercase `link`/`sdir` cannot be accepted without parsing. Required proof: uppercase optional envelope succeeds; empty/truncated `link` and `sdir` fail closed in normal/linked public seams.

Other inspected surfaces — node/item option 1, candidate set, synthetic oracle, Gitfile/commonDir/config, SHA-1/SHA-256, v2/v3/v4 prefix/order/duplicates, manifest/blob binding, and exact receipts — were clean.
