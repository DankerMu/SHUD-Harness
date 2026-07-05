Reviewer agent: review-spec-compliance
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 2de6c4e6f6aa1048fc232eacb21d1f42b9b88190

Summary: No candidate spec-compliance findings; #19’s narrowed raw-byte authority, trusted telemetry boundary, previous 8bbfd68 closures, and OpenSpec/docs alignment are covered.

Invariant Matrix Coverage:
- Task 3.3 / spike 条 2': covered - sandboxed bash applies `sandbox-exec -f <profile>` and separates advisory denial telemetry from post-exec lifecycle facts (`packages/core/src/tools/raw-data-sandbox.ts:588`, `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:21`).
- Raw byte authority: covered - profile denies protected raw literal/subpath plus raw ancestor literals under broad allowed roots, closing the ancestor displacement gap from 8bbfd68 (`packages/core/src/tools/raw-data-sandbox.ts:209`, `packages/core/src/tools/raw-data-sandbox.ts:259`, `packages/core/src/tools/raw-data-sandbox.test.ts:3405`, `packages/core/src/tools/policy-gate-registry.test.ts:198`).
- Six escape classes: covered - interpreter payload, pipeline/stdin, dynamic target, shell state/child, symlink/`../`, rename/unlink are represented as byte-blocking regressions (`packages/core/src/tools/raw-data-sandbox.test.ts:465`).
- Raw read / workspace write compatibility: covered - raw reads, raw-to-workspace copies, dynamic workspace `data/raw` paths, and workspace writes remain allowed (`packages/core/src/tools/raw-data-sandbox.test.ts:1415`, `packages/core/src/tools/raw-data-sandbox.test.ts:2582`, `packages/core/src/tools/raw-data-sandbox.test.ts:1884`, `packages/core/src/tools/raw-data-sandbox.test.ts:1913`).
- Stable root binding / cwd drift: covered - relative raw, audit, temp/profile roots require or use `pathResolutionRoot` rather than process cwd or `ctx.workDir` drift (`packages/core/src/tools/raw-data-sandbox.test.ts:240`, `packages/core/src/tools/raw-data-sandbox.test.ts:276`, `packages/core/src/tools/raw-data-sandbox.test.ts:311`).
- Trusted telemetry only: covered - advisory/static same-root raw writes build payload, audit row, trusted `ToolResult`, and `tool.failed` input inside the sandbox tool (`packages/core/src/tools/raw-data-sandbox.ts:551`, `packages/core/src/tools/raw-data-sandbox.ts:937`, `packages/core/src/tools/raw-data-sandbox.ts:963`).
- WS clone/replay closure from 8bbfd68: covered - backend builder consumes the actual trusted `ToolResult`; caller-authored structures and cloned result-shaped objects are rejected (`packages/backend/src/ws/index.ts:54`, `packages/backend/src/ws/index.ts:98`, `packages/backend/src/ws/index.test.ts:55`, `packages/backend/src/ws/index.test.ts:67`).
- Outer `RAW_DATA_WRITE_RULE_ID` evaluator misuse: covered - wrapper fails closed as explicit configuration misuse, does not emit generic policy denial or raw-denial evidence (`packages/core/src/tools/policy-gate-registry.ts:253`, `packages/core/src/tools/policy-gate-registry.ts:268`, `packages/core/src/tools/policy-gate-registry.test.ts:402`).
- Post-exec process output not upgraded to sandbox denial: covered - forged/suppressed permission text and ordinary failures stay generic lifecycle `failed` (`packages/core/src/tools/raw-data-sandbox.ts:611`, `packages/core/src/tools/raw-data-sandbox.test.ts:1493`, `packages/core/src/tools/raw-data-sandbox.test.ts:1556`).
- Hidden denial / descendant ownership boundary: covered - spec marks full hidden-denial telemetry and arbitrary descendant lifecycle ownership out of #19; implementation preserves raw bytes without claiming `denied_by_sandbox` (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:28`, `packages/core/src/tools/raw-data-sandbox.test.ts:2467`).
- Legal waited foreground child process: covered - waited `Popen` workspace write remains allowed (`packages/core/src/tools/raw-data-sandbox.test.ts:2413`).
- Hardlink residual and bounded scan: covered - pre-existing hardlink residual is demonstrated honestly; scanner accepts explicit protected roots and scans metadata under those roots with a budget (`packages/core/src/tools/raw-data-sandbox.ts:1110`, `packages/core/src/tools/raw-data-sandbox.test.ts:3427`).
- Audit evidence storage: covered - audit append uses reserved handle checks, nofollow/hardlink guards, canonical identity checks, and profile-id lifecycle rows (`packages/core/src/tools/raw-data-sandbox.ts:633`, `packages/core/src/tools/raw-data-sandbox.ts:656`, `packages/core/src/tools/raw-data-sandbox.ts:4203`).
- Public routes / frontend consumers: out-of-scope - PR adds only M1 WS skeleton builders, no backend route or frontend feed implementation (`packages/backend/src/ws/index.ts:49`, `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:26`).
- Zero source cleanliness: covered - verified `git -C zero diff --quiet` exit 0 and zero HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- OpenSpec validation: covered - `openspec validate m1-foundation --strict` passed.
- Scope creep / selected risk packs: covered - implementation stays within #19’s selected file IO/path safety, subprocess, telemetry schema, audit evidence, bounded hardlink scan, and Zero adapter surfaces; hidden-denial full telemetry, Linux backend, full WS route, full AuditEvent schema, and ingest wiring remain out of scope.

Findings:
- None.

Non-blocking notes:
- I could not rerun `bun run check` because `bun` is not installed/on PATH in this reviewer shell. I did independently run `./node_modules/.bin/tsc --noEmit -p tsconfig.json`, `openspec validate m1-foundation --strict`, `git -C zero diff --quiet`, and `git -C zero rev-parse HEAD`; all passed.

Execution Summary: agents=review-spec-compliance; skills=review; tools=git,rg,sed,nl,tsc,openspec; verification=typecheck/openSpec/zero checks passed, bun unavailable locally; limits=read-only,no-edits,no-PR-comments,no-nested-agents.
