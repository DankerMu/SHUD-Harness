# Fix list -- final review at 3257f8c

Reviewed head SHA: `3257f8c574b392720d8740f3c29911a54bbd1973`

## Blocking / confirmed

- `cand-final-3257-integration-01`: CONFIRMED. Outer `RAW_DATA_WRITE_RULE_ID` evaluator denials bypass trusted raw-denial evidence.
- Evidence hygiene: latest-head evidence was missing and three `.workplans` files had PR-diff EOF blank lines.

## P2 follow-ups fixed in same patch

- Public `isLikelySandboxDenial` export exposed forgeable process output as a reusable authority surface.
- `hasUnwaitedBackgroundExecution` treated any earlier `wait` segment as proof that later background jobs were waited.

## Fixes applied

- Outer raw-rule evaluator denials now fail closed as `policy_gate_raw_data_rule_misconfigured`; they do not execute bash, do not emit `raw_data_write_denied`, and do not invent profile/audit identity.
- Public output-based sandbox denial classifier removed from the export surface.
- Background preflight now requires a static `wait` after a background operator; `wait; ... & true` and `wait 999; ... & true` are denied.
- Spec/ADR/plan text now states that trusted raw-denial ownership belongs to the sandbox tool inner advisory/static path and that outer raw-rule evaluator denial is configuration misuse.
- EOF blank-line hygiene fixed and latest-head review evidence added.

## Verification

- `pnpm --package=bun@1.2.19 dlx bun run check`: pass; policy/raw suite 149 pass, backend WS 2 pass, schemas 6 pass.
- `openspec validate m1-foundation --strict --no-interactive`: pass.
- `git diff --check`: pass.
- `git diff --check origin/main`: pass.
- `git -C zero diff --quiet && git -C zero rev-parse HEAD`: pass, `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
