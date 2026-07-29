# Phase 6.2 final invariant audit

PR: #167
Issue: #164
Audited head: `4d7fa1664d2fcf718daaa800d8a5d13878a65912`
Base: `f8b74e724dc978acb889f715a936feabfd69680d`

Result: **not clean**; one P1 candidate requires verifier adjudication.

## p62-data-01: semantic validation reopens verified source paths

- Failure class: `data-integrity`.
- Candidate invariant: bytes consumed by metadata/frame/sidecar semantic validation
  must be the same descriptor-bound, index/blob-verified identity.
- Reachable scenario: after a governed metadata file passes its index/blob check,
  it is replaced before semantic validation by a different inode and different,
  schema-equivalent bytes. A deterministic temporary-repository reproduction using
  the existing test hook returned authority success with `changed=true`.
- Code evidence: `current-source.ts` completes and closes all per-entry descriptor
  checks before it calls `readBoundedFile(path)` again for `CONTRACT_METADATA`,
  `SYNTHETIC_FRAME`, and `SYNTHETIC_SIDECAR`.
- Contract anchor: OpenSpec requires current authority to reject source differing
  from the indexed/source identity and the Task 1.1a risk pack requires
  descriptor-bound reads with no ambient pathname reopen.
- Consequence: the bytes bound to the Git blob can differ from the bytes whose
  contract semantics authorize the success receipt.
- Proposed proof/fix direction: carry the same-handle verified bytes into semantic
  validation and add deterministic late-replacement regressions for metadata,
  frame, and sidecar while preserving no-write/no-child behavior.
- Boundary: aggregate traversal/read ceilings remain #162; Git executable/HEAD/
  profile remains #166; network is excluded.

Other Round 3 closure surfaces were clean: common-config extension/object-format
semantics, complete v2-v4 index entry grammar and modes, exact manifest/filesystem/
index set, CR/LF path domains, normal/linked SHA-1/SHA-256, persisted red proof,
receipts and hygiene.

Independent verification executed by the reviewer: 50 contract tests / 762
assertions, strict OpenSpec, full repository check, all three public commands, and
diff/submodule hygiene passed.

Verifier transport note: the first verifier instance was blocked by the platform
content filter on three consecutive prompt variants and produced no verdict.
