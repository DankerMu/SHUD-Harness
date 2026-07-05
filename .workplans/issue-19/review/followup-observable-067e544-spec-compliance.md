# Review report -- PR #48 observable 067e544 spec-compliance

Reviewer agent: review-spec-compliance
Review round: follow-up observable 067e544
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489

Summary:
No candidate P0/P1/P2 spec-compliance findings found. Current head matches the #19 observable-boundary contract: byte authority remains in the seatbelt wrapper, hidden/no-output telemetry is not claimed as complete, and WS/audit surfaces stay at M1 skeleton depth.

Invariant Matrix Coverage:
- Raw byte authority: covered by profile generation and sandboxed execution in `packages/core/src/tools/raw-data-sandbox.ts:161`, with six escape-class tests in `packages/core/src/tools/raw-data-sandbox.test.ts:81`.
- Observable denial only: covered. Current OpenSpec explicitly excludes hidden complete telemetry in `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:27`; tests assert hidden/suppressed writes do not fabricate sandbox-denial telemetry in `packages/core/src/tools/raw-data-sandbox.test.ts:219` and `packages/core/src/tools/raw-data-sandbox.test.ts:2912`.
- Legal raw read, workspace write, waited foreground subprocess: covered in `packages/core/src/tools/raw-data-sandbox.test.ts:998`, `packages/core/src/tools/raw-data-sandbox.test.ts:1378`, and `packages/core/src/tools/raw-data-sandbox.test.ts:1751`.
- Process preflight narrowed: covered. The implementation checks bounded session/background escape signals in `packages/core/src/tools/raw-data-sandbox.ts:3377`, while preserving waited foreground child behavior.
- Hardlink residual and bounded scan: covered. The scanner accepts explicit protected roots and enforces a scan budget in `packages/core/src/tools/raw-data-sandbox.ts:876`, with residual demonstration and budget tests in `packages/core/src/tools/raw-data-sandbox.test.ts:2664` and `packages/core/src/tools/raw-data-sandbox.test.ts:2798`.
- WS event boundary: covered. The registry already contains `tool.failed` in `docs/03_SPEC/WebSocket_Protocol.md:57`, and the PR adds only a `tool.failed` builder in `packages/backend/src/ws/index.ts:36`.
- Zero unchanged: covered. Read-only check observed `zero_diff_exit=0` and `zero` HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Findings:
None.

Non-blocking notes:
Historical `.workplans/issue-19/review/*` files still contain prior finding language, but current issue/OpenSpec/ADR acceptance sources now state the observable-boundary contract and do not require complete hidden-denial telemetry.

Execution Summary: agents=review-spec-compliance; skills=review; tools=git, gh, rg, sed, nl; verification=read-only diff/spec/code/test inspection plus zero clean check, tests not rerun; limits=no edits/commits/push.
