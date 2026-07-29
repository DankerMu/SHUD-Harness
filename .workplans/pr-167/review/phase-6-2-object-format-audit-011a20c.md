# Phase 6.2 closure audit — object format

Audited head SHA: `011a20c7569a71d152341edfe7145b2ac8a14bca`
Invariant audit: findings

- P1 `contract`: `objectFormat()` searches the entire common Git config for any `objectFormat = sha256` line and treats all other states as SHA-1. An unsupported `[extensions] objectFormat = bogus` can be accepted as SHA-1, while `[custom] objectFormat = sha256` can falsely switch a valid SHA-1 repository. Required closure: bounded section-aware common config parsing; accept effective supported states, default only when genuinely absent, reject malformed/conflicting/unsupported authority; public normal/linked real SHA-1/SHA-256 and hostile config proofs.

All other Phase 6.2 surfaces were clean: read-only/no-child behavior, node/item option 1, candidate/oracle/index parser invariants, repeated receipts, and #162/#166 boundaries.
