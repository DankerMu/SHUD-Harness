# Tasks

## 1. Relocation and budget

- [x] 1.1 Moved 30 of 44 non-blank Runtime Lifecycle lines verbatim, with only 4 links rebased, to `docs/04_IMPLEMENTATION/Runtime_Lifecycle.md`. The root keeps 14 lines verbatim plus a mandatory pointer. The relocation oracle found 0 missing and 0 extra lines, and the original 32118 bytes equal kernel + doc after undoing the link rebasing.
- [x] 1.2 Compressed the closed M3/M4 Epic acceptance clauses into one ADR pointer (0005/0010/0014). It keeps the rules that sub-PR merges, automatic Allow once and ADR confirmation do not replace PI acceptance, and that the single M4 case is no claim of parallel correctness, performance or model improvement. Changed the pinned vitest version to 5.1.0. Re-rendered: AGENTS.md is 259 lines / 26191 bytes, down from 317 / 56177.
- [ ] 1.3 Wrote byte-budget self-tests first. Against the HEAD checker, 13 subtests failed, all byte cases, while every line case passed. After extending the checker with `thresholds.agents_md_max_bytes`, fail-closed like the line budget, all 12 tests pass.
- [x] 1.4 Constraints: the new document added to `doc_gate.path_claim_files`; `schema_version` rewritten from the legacy `3.6.1` literal to `1`.
- [ ] 1.5 Constraints: `agents_md_max_bytes: 29000` with its measurement comment, and the Testing_Strategy budget description updated (byte-budget PR).

## 2. Verification and delivery

- [ ] 2.1 `pnpm run check`, `pnpm run test-guardrails` and `openspec validate instruction-hot-path-budget --strict` are green on the PR head.
- [ ] 2.2 Review, then CI `all-checks-passed`, then the PI decides whether to merge. Archive the change after merge.

## Risk pack mapping

- Selected Public CLI: `render.sh --check` and the default instructions/docs commands (1.3, 2.1).
- Selected Config: both thresholds read from constraints, fail-closed, no fallback (1.3, 1.4).
- Selected File IO: canonical sources versus generated outputs, and temporary fixture roots (1.1–1.3).
- Selected Error handling: attributable invalid-config failures and unit-specific diagnostics (1.3).
- Selected Documentation: lossless relocation, mandatory pointer, and path-claim gating of the new document (1.1, 1.4).
- Not selected: schema, auth/secrets, concurrency, release/packaging. No runtime, product or dependency change.
