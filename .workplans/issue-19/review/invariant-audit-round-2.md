Invariant audit: findings

Invariant Surface Inventory coverage:
- Shared helper roots: finding
- Public entrypoints: finding
- Read surfaces: clean
- Write/delete/overwrite surfaces: finding
- Producer/consumer evidence boundaries: clean
- Unchanged downstream consumers: clean

Surfaces inspected:
- `packages/core/src/tools/data-raw-write-rule.ts`: finding because `$()` substitution and plain `curl -o/--output` are covered, but backtick substitution and clustered curl short options still bypass.
- `packages/core/src/tools/data-raw-write-rule.test.ts`: finding because tests cover `$()` and simple curl output forms, but not backticks or `curl -Lo/-fsSLo`.
- `packages/core/src/tools/policy-gate-audit.ts`: clean because traversal task IDs/file names are rejected and audit rows preserve rule/guard/ref.
- `packages/core/src/tools/policy-gate-registry.ts`: clean because deny returns before inner tool execution and tool payload is built from the same decision.
- `packages/backend/src/ws/policy-gate-events.ts/test.ts`: clean because `tool.failed` payload and audit row are linked to the captured denial decision.
- `package.json test script`: clean because `test:policy-gate` includes the raw write rule and WS evidence tests.
- `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md`: clean as the invariant source; implementation gaps remain below.

Remaining findings:
- P1 Backtick command substitution remains a parser false negative (`data-raw-write-rule.ts:437`, `data-raw-write-rule.test.ts:32`) | `echo \`rm data/raw/input.csv\`` executes the raw-data delete before `echo`, but the scanner only recognizes `$(` substitutions and then treats the backtick text as ordinary `echo` arguments | Add backtick command-substitution parsing with quote/escape handling and tests for backtick `rm`/redirect denial plus quoted-literal allowance.
- P1 Clustered curl short output options remain a parser false negative (`data-raw-write-rule.ts:263`) | common forms like `curl -Lo data/raw/input.csv URL` or `curl -fsSLo data/raw/input.csv URL` write into `data/raw/**`, but the detector only handles exact `-o`, `--output`, `--output=`, and tokens starting with `-o` | Parse short-option clusters containing `o` and add deny tests for `-Lo`, `-fsSLo`, and attached clustered output while preserving read-only curl usage.
