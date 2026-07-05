# Review report -- PR #48 observable 067e544 security-perf

Reviewer agent: review-security-perf
Review round: follow-up observable 067e544
Reviewed head SHA: 067e544368f88ec60922a243f1bcf6597f211489

Summary:
One blocking candidate remains in the evidence-security layer. Raw-byte authority still appears preserved, and the bounded output/preflight/symlink-scan fixes are present, but `denied_by_sandbox` can still be produced from synthetic denial text rather than an observable OS raw-write denial.

Invariant Matrix Coverage:
- Path safety: no candidate finding; symlink literal classification is target/component/symlink bounded and filtered to `workDir`.
- Evidence security: candidate P1 below.
- Resource bounds: no additional candidate finding; output cap, preflight length cap, and hardlink scan budget are present.
- Raw-byte authority: no candidate finding; reviewed paths still rely on seatbelt for raw byte protection.

Findings:

1. Severity: P1
   Failure class: Evidence security / false denial telemetry.
   Violated invariant/contract: `denied_by_sandbox` audit/tool failure evidence must describe an observable OS-layer raw write denial, and hidden/no-output or unrelated permission text must not be presented as detected raw denial.
   Concrete scenario: With advisory disabled, `d=data; r=raw; p="$d/$r/dead.txt"; if false; then printf x > "$p"; fi; printf "Permission denied\n"` executes no raw write and exits successfully, but the wrapper returns `success=false` with `error=raw_data_write_denied`, `decision=denied_by_sandbox`, and writes the same decision to audit. The reviewer reproduced this in a temp directory using `pnpm --package=bun@1.2.19 dlx bun --eval`; no raw target existed afterward.
   Evidence: `packages/core/src/tools/raw-data-sandbox.ts:3570` treats any denial-like output as sufficient, and `packages/core/src/tools/raw-data-sandbox.ts:3577` then upgrades any static/dynamic known raw target signal to `denied_by_sandbox` without proving the write branch executed or the text came from seatbelt.
   Consequence: A successful command can be converted into a false policy failure, and audit/WS evidence can claim an OS sandbox raw denial that did not happen.
   Fix direction: Do not classify solely from `Permission denied|sandbox` plus a static/dynamic raw target signal. Require the observed denial to be tied to an executed concrete raw target, or leave ambiguous/successful denial-like output as the original generic command result. Preserve the explicit `|| true` visible-denial case with a narrower proof, such as denial output referencing the resolved protected path.
   Required test/proof: Add a seatbelt regression where a dynamic raw target appears only in a non-executed branch and stdout/stderr contains `Permission denied`; assert no `raw_data_write_denied`, no `denied_by_sandbox` audit row, and no raw mutation. Keep a separate test proving actual visible masked OS denial still maps to `denied_by_sandbox`.
   Sibling surfaces: `rawDataDenialPayloadToAuditRow`, `rawDataDenialPayloadToToolFailedEventInput`, backend `tool.failed` event builder, and any UI/audit consumer that trusts `decision=denied_by_sandbox`.
   Blocking status: Blocking candidate.

Non-blocking notes:
No additional security/perf candidate findings found in this pass.

Execution Summary: agents=review-security-perf leaf only; skills=review protocol; tools=git, gh, rg, sed, pnpm-bun temp repro; verification=read-only diff/source review plus temp reproduction; limits=no repo edits/commits/pushes, no nested agents.
