# Review report -- PR #48 observable 215d635 integration

Reviewer agent: review-integration
Review round: follow-up observable 215d635
Reviewed head SHA: 215d635e8edc6c4e5db3af8b833cf377fdda02cc

Summary:
No actionable P0/P1/P2 integration findings found; the follow-up closes the prior observable-denial attribution and profile-provenance gaps within the stated M1 boundary.

Invariant Matrix Coverage:
- Return-value contracts: covered - raw denials still emit `raw_data_write_denied` with remediation/audit/WS-compatible payload, while mismatched outer raw roots now return generic `policy_gate_denied` without unrelated `profile_id`.
- Removed-behavior audit: covered - the rewritten observable classifier preserves visible over-budget raw denials, keeps unrelated permission text generic, extends symlinked raw-dir mutation attribution, and preserves symlink-leaf removal as allowed.
- Source-of-truth identity/contract: covered - `buildRawDataDenialEvidence` remains the single producer for payload/audit/WS input, and `canAttributeOuterRawPolicyGateDeny()` prevents sibling raw-root profile identity from being mixed into outer-deny evidence.
- Setup/config variable flow: covered - registry construction passes protected roots/profile/audit options into `RawDataSandboxedBashTool`; spawn is rebuilt against the final registry so scoped subagent registries inherit the sandboxed bash.
- Unchanged consumers compatibility: covered - raw reads, workspace writes, waited foreground subprocesses, generic policy denials, fuse behavior, and Zero wrapper assembly remain represented in tests and static inspection.
- Producer/consumer evidence binding: covered - payload `profile_id`, audit row `profile_id`, and WS event input all derive from the same raw-denial payload; mismatch case deliberately has no audit/profile evidence.
- Wrapper/proxy faithfulness: covered - policy-gated tools unwrap stale wrappers and rewrap with the current evaluator; `spawn_agent` is reconstructed around the final registry rather than retaining stale registry state.
- Altitude/ownership: covered - byte authority stays in `sandbox-exec`/seatbelt inside the bash tool; static advisory remains fail-open and is used only for pre-exec navigation or bounded attribution.
- Hidden/suppressed denial telemetry: out-of-scope - explicitly excluded by ADR/spec; implementation avoids claiming suppressed raw denials as `denied_by_sandbox`.
- Full WS runtime bus and full AuditEvent schema: out-of-scope - current change only provides the M1 skeleton event builder and minimum audit row.
- Test execution: missing - `bun` was not available on PATH in this review environment, so Bun tests were not rerun.

Findings:
None.

Non-blocking notes:
- Static verification passed: `./node_modules/.bin/tsc --noEmit -p tsconfig.json`, `git diff --check origin/main...HEAD`, and `git -C zero diff --quiet` all succeeded.
- Zero remains pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- A manual `sandbox-exec` probe confirmed creating a new hardlink alias from `data/raw` into workspace is denied and does not mutate raw bytes.

Execution Summary: agents=review-integration; skills=review; tools=exec_command, multi_tool_use.parallel, git, rg, sed, tsc, sandbox-exec; verification=diff/context review plus typecheck/diff-check/zero-clean/manual seatbelt hardlink probe; limits=no edits/no commits/no pushes/no nested agents; bun tests not run because bun command was unavailable.
