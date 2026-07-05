# Pre-merge evidence hard-gate - PR #48

Issue: #19
Frozen head SHA: `15af873cf0eb54b6510257b126d55250a071df7f`
Date: 2026-07-05

## Deterministic evidence checks

- Branch head equals remote head: pass.
- PR head equals frozen SHA: pass.
- PR merge state: `CLEAN`.
- CI: `linux-base`, `macos-seatbelt`, and aggregate `check` all `SUCCESS`.
- Phase 4.5 verifier verdict table for final head: `.workplans/issue-19/review/verdict-table-final-15af873.md`.
- Latest comprehensive cross-review: clean on `15af873cf0eb54b6510257b126d55250a071df7f`.
- Phase 7 final review: `.workplans/issue-19/review/final-review-15af873.md`, clean on the same frozen SHA.
- `zero/` cleanliness: `git -C zero diff --quiet`; HEAD `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

## Completion self-audit

- Seatbelt profile assembly and stable profile identity: satisfied by `packages/core/src/tools/raw-data-sandbox.ts` and profile tests.
- Bash execution wrapper via `/usr/bin/sandbox-exec -f`: satisfied by `RawDataSandboxedBashTool` and macOS seatbelt tests.
- Six escape-class negative tests: satisfied; raw bytes are preserved for interpreter payloads, pipeline/stdin, dynamic targets, shell state/children, symlink/`../`, and rename/unlink.
- Positive tests: satisfied for raw reads, workspace writes, and waited foreground subprocess workspace writes.
- Hardlink residual: demonstrated and bounded `nlink>1` protected-root scan implemented; ingest/readiness wiring remains explicitly out of scope.
- Advisory layer: fail-open for uncertainty; only obvious static raw writes are denied with remediation.
- Trusted raw-denial telemetry: restricted to sandbox-owned/advisory evidence; outer raw-rule evaluator ownership fails closed as configuration misuse.
- WS and audit evidence: `tool.failed` skeleton and audit lifecycle/minimal denial rows covered by backend/core tests.
- Hidden-denial full telemetry and arbitrary descendant lifecycle ownership: explicitly out of #19 scope per OpenSpec/ADR; raw byte integrity remains covered.
- No required #19 edge/error path remains unhandled within the accepted条 2' scope.

## Oracle integrity

- OpenSpec changes record the ADR-approved boundary refinement; they do not weaken tests to hide a failing implementation.
- CI was strengthened by splitting `linux-base`, adding required `macos-seatbelt`, and keeping aggregate `check`.
- Tests were expanded substantially for raw byte integrity, telemetry provenance, WS trust boundary, lifecycle finalization, and malformed evaluator decisions.
- No `zero/` source was modified.
- No WS event type was added.

Gate result: pass after PR body Agent Review section and evidence/work-summary comments are posted against the frozen SHA.

## Posted evidence

- Evidence comment: https://github.com/DankerMu/SHUD-Harness/pull/48#issuecomment-4887135445
- Chinese work summary: https://github.com/DankerMu/SHUD-Harness/pull/48#issuecomment-4887136473
- PR body Agent Review section: updated with reviewed head SHA `15af873cf0eb54b6510257b126d55250a071df7f` and the evidence comment URL.

Final gate result: pass.
