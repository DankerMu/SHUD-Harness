# PR #48 Post-Gate Strategy Review

Issue: #19
PR: #48
Current head SHA: 0553fe2f60b2deb209c5201b4003e0b11606c8b6
Date: 2026-07-04

## Trigger

After the five-round gate package and root-cause remediation commit `0553fe2f60b2deb209c5201b4003e0b11606c8b6`, the one allowed post-gate comprehensive review found a confirmed P1:

- V-19-post-01: stderr redirected to an allowed workspace file can hide the OS sandbox denial text from the wrapper, causing a raw write denial to be recorded as generic `failed` rather than `raw_data_write_denied` / `denied_by_sandbox`.

The verifier explicitly classified this as the same raw-denial evidence single-owner invariant recorded in the round-5 strategy package. Therefore the post-gate budget rule applies: stop ordinary narrow-fix looping and re-enter strategy review.

## Diagnosis

The authority boundary itself is still correct: macOS seatbelt denies raw writes at syscall time and preserves raw bytes. The remaining failure is the evidence boundary.

Root cause: post-exec classification still depends on denial text being visible on the parent stdout/stderr streams. Shell redirections can legally move that denial text into an allowed workspace file. This reintroduces a semantic dependency on shell I/O routing, which is the same family as the earlier masked-denial failures.

This is not a reason to revisit ADR-0001 or change the base runtime. It is an implementation invariant gap inside the SHUD-owned bash wrapper.

## Decision

Proceed with one root-cause remediation pass in PR #48. Do not split the PR and do not reopen base-runtime evaluation.

The remediation must close the evidence invariant, not just the single repro string:

- Treat raw-write commands whose sandbox denial text may be redirected away from parent-captured streams as `denied_by_sandbox` before or immediately after execution.
- Keep advisory fail-open for uncertainty and legal raw reads/workspace writes.
- Preserve the absolute `/usr/bin/sandbox-exec` direct spawn boundary.
- Preserve raw-denial evidence ownership inside `RawDataSandboxedBashTool`.

Confirmed P2s should be closed in the same pass because they are adjacent to the wrapper contract and already verifier-confirmed:

- Use canonical WS envelope field `type: "tool.failed"`.
- Reject profile/temp roots inside protected evidence roots.
- Terminate sandboxed process trees on timeout/abort.
- Add tests for the confirmed matrix gaps: child `bash -c cd workspace`, Node/Ruby path join variants, one Python/R file-modifying form, unsuppressed existing-file `: >`/`>>`, and abort behavior.
- Add a final SHA-matched evidence artifact after the fix, marking the `3acdba2...` round-5 package historical/superseded.

## Non-Goals

- Do not remove `profile_path` from raw-denial payloads; verifier refuted that candidate against the current evidence contract.
- Do not change BASH_ENV, hardlink-scan, or non-macOS skip behavior solely from V-19-post-07; verifier did not confirm those as requirement gaps.
- Do not modify `zero/`; `zero` must remain clean at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Post-Remediation Gate

After remediation:

1. Run focused tests for raw sandbox, policy-gate registry, and backend WS.
2. Run `pnpm --package=bun@1.2.19 dlx bun run check`.
3. Run `openspec validate m1-foundation --strict --no-interactive`.
4. Run `git diff --check`.
5. Confirm `git -C zero diff --quiet && git -C zero rev-parse HEAD`.
6. Run one final comprehensive review on the new frozen head. If the same P1 invariant remains, do not continue narrow fixes; escalate to strategy again.
