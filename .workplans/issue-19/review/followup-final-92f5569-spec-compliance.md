Reviewer agent: review-spec-compliance
Review round: final comprehensive follow-up 92f5569
Reviewed head SHA: 92f556915416a57015dcaa32ca97e044c9fc3353
Summary: Clean for spec compliance; task 3.3 条 2' and follow-up fixes are covered with no actionable findings.

Invariant Matrix Coverage:
- Task 3.3 条 2' scope/boundary: covered - docs/spec now encode execution-layer seatbelt authority, advisory-only preflight, trusted telemetry limits, and moved-out hidden telemetry/process ownership boundaries (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`, `:26`, `:28`; `docs/adr/0001-agent-runtime-and-topology.md:138`).
- Seatbelt execution authority: covered - profile denies `file-write*` on canonical protected raw paths and wrapper launches `/usr/bin/sandbox-exec -f <profile> /bin/bash -c <command>` (`packages/core/src/tools/raw-data-sandbox.ts:270`, `:282`, `:1713`).
- Six escape classes byte preservation: covered - interpreter payload, pipeline/stdin, dynamic target, shell state/child, symlink/`../`, rename/unlink all asserted with advisory disabled and raw bytes absent/preserved (`packages/core/src/tools/raw-data-sandbox.test.ts:933`, `:984`).
- Raw reads remain legal: covered - advisory allows `cat data/raw/input.csv`, sandboxed command succeeds, audit lifecycle row is `allowed` (`packages/core/src/tools/raw-data-sandbox.test.ts:1986`).
- Workspace writes remain legal: covered - allowed workspace write succeeds under same profile with profile-id audit row (`packages/core/src/tools/raw-data-sandbox.test.ts:2484`).
- Waited foreground child process remains legal: covered - Python `subprocess.Popen(...); sys.exit(p.wait())` writes workspace and is not preflight-rejected (`packages/core/src/tools/raw-data-sandbox.test.ts:3029`).
- Advisory denial remediation/audit: covered - inner sandbox advisory builds trusted denial evidence, failed tool result, remediation, and audit denial row (`packages/core/src/tools/raw-data-sandbox.ts:641`, `:1178`, `:1231`; test `packages/core/src/tools/raw-data-sandbox.test.ts:3300`).
- Hidden/post-exec refusal not falsely upgraded: covered - post-exec failures are lifecycle `failed|allowed`, `denied_by_sandbox` converters are reserved/rejected, and forged permission text stays generic (`packages/core/src/tools/raw-data-sandbox.ts:1399`; tests `packages/core/src/tools/raw-data-sandbox.test.ts:2101`, `:4134`).
- Outer `RAW_DATA_WRITE_RULE_ID` evaluator ownership: covered - outer raw-rule denials return config-misuse ToolResult without executing inner tool or forging raw profile/audit evidence (`packages/core/src/tools/policy-gate-registry.ts:271`; tests `packages/core/src/tools/policy-gate-registry.test.ts:744`, `:773`).
- Policy evaluator/remediation follow-up fix: covered - evaluator exceptions and invalid remediation now fail closed as failed `ToolResult`, skip inner execution, and finish running handles (`packages/core/src/tools/policy-gate-registry.ts:241`; tests `packages/core/src/tools/policy-gate-registry.test.ts:95`, `:135`).
- Ruby raw-source move follow-up fix: covered - oracle now requires raw bytes preserved and treats optional workspace copy as allowed raw-read side effect (`packages/core/src/tools/raw-data-sandbox.test.ts:1767`).
- Hardlink residual and bounded scan: covered - residual is demonstrated honestly; `scanProtectedHardlinks` scans explicit roots with budget and flags `nlink > 1` raw source risk (`packages/core/src/tools/raw-data-sandbox.ts:1407`; test `packages/core/src/tools/raw-data-sandbox.test.ts:4443`).
- Audit layout and lifecycle rows: covered - audit reserves `workspace/tasks/TASK-M1-SPIKE/audit/policy-gate.ndjson`, protects audit path from symlink/hardlink drift, and all sandbox-applied paths append lifecycle/denial facts with profile identity (`packages/core/src/tools/raw-data-sandbox.ts:4909`, `:5057`; tests `:4330`, `:4635`).
- WebSocket event contract/no new event type: covered - backend skeleton only emits existing `tool.failed`, snapshots ErrorRecord remediation, and rejects generic forged raw-denial events (`packages/backend/src/ws/index.ts:34`, `:55`, `:87`; tests `packages/backend/src/ws/index.test.ts:26`, `:165`).
- Stable root resolution/fail-closed relative config: covered - relative roots require `pathResolutionRoot`, default audit workspace is anchored there, and cwd drift tests cover root stability (`packages/core/src/tools/raw-data-sandbox.ts:374`, `:441`; tests `packages/core/src/tools/raw-data-sandbox.test.ts:636`, `:672`).
- Zero ownership and pin: covered - `zero/` has no diff and submodule status is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- CI evidence: covered - GitHub check rollup for this SHA reports `linux-base`, `macos-seatbelt`, and aggregate `check` as success.

Findings:
None.

Non-blocking notes:
None.
