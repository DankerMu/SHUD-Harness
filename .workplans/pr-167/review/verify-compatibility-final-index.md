# Phase 4.5 / 6.2 verifier — final index batch

Reviewed head SHA: `72d71e468a8938b92e98be27ed2fd3af257ada06`

- `cand-entry-flags`: CONFIRMED / FIX_NOW. Real index entry flags, pathname length, extended flags, and v2/v3 padding are not fully validated; rehashed malformed bytes can pass later exact-set/blob checks and emit public success.
- `cand-extension-semantics`: CONFIRMED / FIX_NOW. Uppercase optional extensions are falsely rejected while lowercase mandatory `link`/`sdir` are skipped without understanding their authority semantics.

Both pass T1 real public reachability, T2 observable receipt impact, and T3 Git format plus OpenSpec exact-authority/fail-closed anchors. Both are introduced by this PR.
