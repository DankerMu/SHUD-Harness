# Round 3 candidate synthesis

Reviewed SHA: `a04f5c379a290ade2fe43a408e613bd95fc88088`
Reviewers: correctness (full scope), integration, test/evidence, spec compliance, invariant/compatibility.

Spec compliance was clean. Deduplicated candidates:

- `r3-compat-01` P1 compatibility: unknown top-level repository extension is ignored, allowing a Git-invalid repository to receive source-authority success.
- `r3-contract-01` P1 contract: invalid noncandidate index mode is not validated before candidate filtering.
- `r3-contract-02` P1 contract: final fixture/risk-pack/evidence manifest is stale after config/parser work and #162 routing.
- `r3-contract-03` P1 contract: quoted trailing whitespace in objectFormat is erased by `trimEnd()`, converting unsupported authority into sha1/sha256.
- `r3-data-01` P1 data-integrity: `verifyWorktreeEntry` lstat/readFile TOCTOU can follow a replacement symlink with matching bytes.
- `r3-data-02` P1 data-integrity: direct source path validators accept CR/LF identities that strict LF manifest cannot represent.
- `r3-evidence-01` P1 test-evidence: mandatory batched source-only red proof is reported by implementers but not persisted in a SHA-matched auditable artifact.

Explicit downstream routing remains unchanged: aggregate traversal/read budgets belong to #162; Git executable/HEAD/profile authority belongs to #166; network security is not in scope.
