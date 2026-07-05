# Fix list -- final review at 789485a

Reviewed head SHA: `789485ad5ad8bc75a560c0df5fdc12eb7137fee3`

## Confirmed findings

- `cand-final-789-security-01`: public core raw-denial builders/converters could mint reserved `denied_by_sandbox` authority.
- `cand-final-789-correctness-01`: outer raw-rule misconfiguration payload used invalid remediation `next_action: "fix_configuration"`.
- Spec/integration review found `docs/Phased_Spec_Activation.md` still preserved the old process-result-visible OS denial telemetry wording.

## Fixes applied

- Public `buildRawDataDeniedPayload`, `buildRawDataDenialEvidence`, and `buildRawDataDeniedToolResult` now build advisory-denial evidence only.
- Public raw-denial audit/WS converters reject reserved `denied_by_sandbox` payloads at runtime.
- Backend WS reserved `denied_by_sandbox` shape test uses a local fixture, not public core authority builders.
- Outer raw-rule misconfiguration remediation now uses canonical `fix_and_retry`, with schema-parse proof in the regression.
- `docs/Phased_Spec_Activation.md` now matches the trusted observable boundary and removes stale process-result OS denial language.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts packages/core/src/tools/raw-data-sandbox.test.ts packages/backend/src/ws/index.test.ts --timeout 30000`: pass, 148 tests.
- `pnpm --package=bun@1.2.19 dlx bun run typecheck`: pass.
- `pnpm --package=bun@1.2.19 dlx bun run check`: pass; policy/raw suite 150 pass, backend WS 2 pass, schemas 6 pass.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check` and `git diff --check origin/main`: pass.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`: pass, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
- Stale-boundary grep for `经进程结果外显`, `post-gate 延伸`, `fix_configuration`, and public builder/converter `denied_by_sandbox` minting patterns returned no matches.
