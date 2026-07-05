Verifier verdict for: cand-final-2de6c4e-01-tempRoot-ancestor-authority
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190
Verdict: CONFIRMED
Evidence: `protectedRawAncestorLiteralPaths` is computed from `allowedWriteRoots` only at `packages/core/src/tools/raw-data-sandbox.ts:209-212`; `tempRoot` is separately write-authorized via `writeAllowRoots = sortedUnique([tempRoot, ...allowedWriteRoots])` at `:246` and emitted as `(allow file-write* (subpath ...))` at `:256-258`; ancestor denies are emitted only from `protectedRawAncestorLiteralPaths` at `:263-265`. With `allowedWriteRoots=/tmp/project/workspace` and `tempRoot=/tmp`, `protectedPathAncestorLiterals` only pushes ancestors that are inside an allowed write root at `:455-456`, so `/tmp/project/data` and `/tmp/project` are not denied while `/tmp` allows the rename path.
Note: This violates the fixture invariant that bash must not rename/move protected raw bytes (`openspec/changes/m1-foundation/design.md:168`).
