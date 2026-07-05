Invariant audit: findings

Invariant Surface Inventory coverage:
- Shared helper roots: finding because `data-raw-write-rule` has command-parser false negatives and a quoted-token false positive.
- Public entrypoints: finding because matched denies stop before `innerTool.run()`, but unrecognized bash write patterns still reach execution.
- Read surfaces: finding because quoted redirect literals in read-only commands can be misclassified as write redirects.
- Write/delete/overwrite surfaces: finding because command substitution and unlisted writer commands can mutate `data/raw/**`.
- Staging/publish/rollback surfaces: out-of-scope because PR #46 only adds policy rule, fixture audit append, and WS skeleton builder.
- Producer/consumer evidence boundaries: clean because tool payload, WS payload, and audit row builders copy `tool_id`, rule id, `guard_class`, and remediation ref from one deny decision.
- Stale-state/idempotency boundaries: out-of-scope because seq allocation, event persistence, dedupe, and full WS bus are deferred outside this M1 skeleton.
- Unchanged downstream consumers: clean because no active backend/frontend consumer exists yet; Zero remains pinned and unchanged.

Surfaces inspected:
- `packages/core/src/tools/data-raw-write-rule.ts`: finding because parser only handles top-level known commands and loses quote context.
- `packages/core/src/tools/policy-gate-registry.ts`: clean because deny returns before `innerTool.run()` and payload includes `rule_id`, `guard_class`, and remediation.
- `packages/core/src/tools/policy-gate-core.ts`: clean because remediation and legal `guard_class` are validated before deny result return.
- `packages/core/src/tools/policy-gate-audit.ts`: clean because `taskId`/`fileName` traversal is rejected before `mkdir`/`appendFile`, and deny-row builder copies rule/remediation ref.
- `packages/backend/src/ws/policy-gate-events.ts`: clean because `tool.failed` envelope carries seq/event_id and ErrorRecord-shaped remediation payload.
- `packages/core/src/tools/data-raw-write-rule.test.ts`: finding because requested matrix rows are covered, but bypass and quoted-read boundaries are missing.
- `packages/backend/src/ws/policy-gate-events.test.ts`: clean because one captured deny decision is linked across tool payload, WS payload, and audit row.
- `packages/core/src/tools/policy-gate-registry.test.ts`: clean because wrapper assembly and pre-execution denial are covered.
- `package.json`: clean because `test:policy-gate` includes the new rule and WS tests.
- `openspec/changes/m1-foundation/*`: clean because M1 skeleton and full-protocol non-goals are documented.
- `zero/packages/core/src/tool/bash.ts`: clean because Zero's bash input uses `command`, which `extractBashCommand()` reads.
- `zero/apps/server/src/runtime/tools.ts`: out-of-scope because Zero runtime is a pinned reference surface and not wired by this PR.

Remaining findings:
- P1 `findMutationCommandTarget` only evaluates the top-level command and a finite allowlist/denylist (`packages/core/src/tools/data-raw-write-rule.ts:136`, `:144`, `:167`) | A bash command such as `echo $(rm data/raw/input.csv)` or `curl -o data/raw/input.csv ...` can pass the gate, execute, and mutate protected evidence without synchronized remediation/WS/audit evidence | Add fail-closed handling for shell command substitutions containing protected paths and cover common output-writer flags, or add a filesystem-level raw-path guard; add wrapped-tool tests asserting `calls=0` and linked payload/WS/audit evidence for these bypass cases.
- P2 quoted tokens are later treated as real redirect operators (`packages/core/src/tools/data-raw-write-rule.ts:98`, `:288`) | A read-only command like `grep '>' data/raw/input.csv` can be denied even though it only reads raw data, weakening the allowed read surface | Preserve quote/operator provenance or only classify redirect operators observed outside quotes; add an allowed regression for quoted redirect literals plus a denied regression for a real redirect into `data/raw/**`.
