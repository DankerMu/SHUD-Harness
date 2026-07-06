Pre-merge self-audit for PR #49

Frozen head SHA: `d9fd2f0102e42de845a1b5e89409fff0198d6084`

Acceptance criteria:
- Exact five canonical roles: satisfied by `CANONICAL_HARNESS_ROLES` and exact key test.
- Snapshot drift fails without updating oracle: satisfied by `createRoleToolIdsSnapshot()` vs independent expected snapshot.
- Invariant tests: satisfied for read-only role write exclusion, spawn/wait exclusivity, coordinator no bash/source edit, worker no source edit, coder edit/patch ownership, `permissionNotes` exclusion, raw Zero `memory` denial, and `harness.memory.propose` explicit adapter placeholder.

Selected tasks/scenarios:
- Task 5.1 role->tool_id constant in `packages/core`: satisfied.
- Exact sorted `toolIds` snapshot: satisfied.
- 4+ semantic invariant tests: satisfied with 8+ invariant/negative tests.
- Naming decision: satisfied. Zero native comparable ids exclude raw `memory`; SHUD-Harness uses `harness.memory.propose` for future proposal-only memory adapter placeholder.

Oracle integrity:
- OpenSpec, live Issue #24, implementation, and tests agree on `harness.memory.propose` and raw Zero `memory` exclusion.
- No test/spec/CI gate was weakened to pass. The PR strengthened the oracle after review by adding raw-memory denial assertions.
- `zero` submodule remains clean at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Verification:
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- GitHub checks for final head: `check`, `linux-base`, `macos-seatbelt` passed.

Pre-merge skip blocks:
- 0
