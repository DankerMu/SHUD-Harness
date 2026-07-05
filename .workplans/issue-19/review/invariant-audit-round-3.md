Invariant audit: findings

Invariant Surface Inventory coverage:
- Shared helper roots: finding because wrapper option parsing only consumes operands for `nice`, leaving other configured wrappers with operand-taking options able to hide the real mutating command.
- Public entrypoints: clean
- Read surfaces: clean
- Write/delete/overwrite surfaces: finding because the requested closures are covered, but an adjacent wrapper delete form can still reach execution.
- Producer/consumer evidence boundaries: clean
- Unchanged downstream consumers: clean

Surfaces inspected:
- `packages/core/src/tools/data-raw-write-rule.ts`: finding
- `packages/core/src/tools/data-raw-write-rule.test.ts`: clean
- `packages/core/src/tools/policy-gate-audit.ts`: clean
- `packages/core/src/tools/policy-gate-registry.ts`: clean
- `packages/backend/src/ws/policy-gate-events.test.ts`: clean
- `packages/backend/src/ws/policy-gate-events.ts`: clean
- `packages/core/src/tools/policy-gate-core.ts`: clean
- `packages/core/src/tools/index.ts`: clean

Remaining findings:
- P1 wrapper option operands still allow a raw-data delete bypass | `env -u FOO rm data/raw/input.csv` is tokenized as `env`, `-u`, `FOO`, `rm`, `data/raw/input.csv`; `findCommandTokenIndex` skips `env` and `-u` but not `-u`'s operand, so it treats `FOO` as the command and returns allow, letting the inner bash tool execute | Extend wrapper operand handling beyond `nice`, at minimum for `env -u/--unset` and sibling operand-taking wrapper options, and add a denial-before-execute test asserting inner call count `0` for `env -u FOO rm data/raw/input.csv`.
