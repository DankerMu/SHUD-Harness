# Phase 5/6 invariant closure — final index semantics

Reviewed SHA: `72d71e468a8938b92e98be27ed2fd3af257ada06`
Verified set: two P1 `compatibility` findings, both FIX_NOW.

Invariant: Task 1.1a may derive tracked-set authority only from a completely decoded ordinary v2/v3/v4 index whose entry flags, pathname-length, extended flags, zero padding, ordering, uniqueness, checksum and optional extension envelopes are valid. Any mandatory lowercase extension whose semantics are not implemented must fail closed.

Closure: validate all entry flag/padding contracts for v2/v3/v4; accept bounded uppercase optional extension envelopes; reject `link`, `sdir`, and every other lowercase mandatory extension unless its full authority semantics are implemented. Add normal/linked public red-green regressions for each malformed class and optional/mandatory controls. Preserve no-write/no-child behavior and #162/#166 boundaries.
