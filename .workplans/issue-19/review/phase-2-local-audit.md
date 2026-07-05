# Issue #19 Phase 2 Local Audit

Branch: `codex/issue-19-seatbelt-raw-deny`

## Acceptance criteria mapping

- Six escape classes DENY with no raw mutation: covered by `raw-data-sandbox.test.ts` cases for interpreter payload, pipeline/stdin, dynamic target, shell dynamic state with child/grandchild, symlink/`../` alias, and rename/unlink.
- Raw read ALLOW: covered by `raw read succeeds under the same profile and is not advisory-denied`.
- Workspace allowed write ALLOW: covered by `workspace allowed write succeeds under the same profile`.
- Hardlink residual demo + bounded `nlink>1` scan: covered by `pre-existing hardlink residual is demonstrated and bounded nlink scan detects it`; scan input is explicit protected roots and assertions require risky paths to stay under that root.
- Advisory fail-open/fail-safe shape: covered by `advisory can deny obvious static writes but fails open for uncertainty`; raw read advisory returns allow.
- Remediation + audit: denied tool results parse to `raw_data_write_denied` with remediation, audit rows include `tool.failed`, rule, decision, and profile id.
- WS skeleton event: covered by `packages/backend/src/ws/index.test.ts`; event type remains exactly `tool.failed`.
- Zero untouched: `git -C zero diff --quiet` passes and HEAD is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Default local check coverage: root `check` now runs policy-gate tests including `raw-data-sandbox.test.ts`, backend WS test, schema tests, and typecheck.

## Verification commands

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts` -> pass, 11 tests.
- `pnpm --package=bun@1.2.19 dlx bun run check` -> pass.
- `openspec validate m1-foundation --strict --no-interactive` -> valid.
- `git diff --check` -> pass.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD` -> pass, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Known limits

- Pre-existing hardlink aliases remain the ADR-recorded residual. This PR provides the bounded scanner helper and test evidence; ingest/readiness wiring is outside #19.
- Seatbelt execution tests run only on macOS with `/usr/bin/sandbox-exec`; on non-macOS future CI they are explicitly skipped rather than falsely failing the repository.
