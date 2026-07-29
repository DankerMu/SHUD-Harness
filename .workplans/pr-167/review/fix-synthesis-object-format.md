# Phase 5/6 invariant closure — Git object format

Invariant: the common Git configuration is a bounded, section-aware authority for exactly one supported effective `extensions.objectFormat`; absent means SHA-1, explicit `sha1` or `sha256` is accepted only with compatible repository-format semantics, and malformed/unsupported/duplicate-conflicting/ambiguous declarations fail closed. Unrelated section keys cannot influence index/OID parsing.

Required evidence: normal and linked public seams over real SHA-1/SHA-256 repositories, unrelated-section controls, invalid/duplicate/conflicting extensions failures, exact receipts and no-write/no-child behavior. No #166 Git executable/profile authority or network behavior.
