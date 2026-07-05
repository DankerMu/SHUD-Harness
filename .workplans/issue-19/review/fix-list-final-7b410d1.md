# Phase 5 Fix List: Final Follow-up 7b410d1

PR: #48
Issue: #19
Head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc

Pattern escalation: yes
Failure classes:
- public helper root drift
- trusted telemetry metadata/provenance boundary
- verification evidence / diff-check oracle integrity

Invariant: public helper roots must not bind to process cwd, and raw-denial telemetry must only be accepted from sandbox-owned trusted evidence. Evidence files must keep the documented diff-check reproducible.

## Fix 1: profile-file helper root binding

Reject relative `profileRoot` in `writeRawDataSeatbeltProfileFile` / profile-file creation. Add cwd-drift regression and absolute-root positive coverage.

## Fix 2: reserved raw-denial metadata

Reject reserved raw-denial `error_id` prefixes from generic WS and public audit append paths while allowing lifecycle `raw-data-write:failed:*` IDs.

## Fix 3: raw advisory WS provenance

Require runtime provenance proof for raw advisory WS input. Hand-authored structural payloads must fail; actual sandbox advisory denial evidence must pass.

## Fix 4: evidence EOF whitespace

Remove blank EOF lines from affected `.workplans/issue-19/review/*3aa3*` evidence files so full diff-check is reproducible.

## Verification

Required after implementation:
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/raw-data-sandbox.test.ts packages/core/src/tools/policy-gate-registry.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`
- `pnpm --package=bun@1.2.19 dlx bun run check`
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git diff --check origin/main...HEAD -- packages docs openspec package.json`
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`
