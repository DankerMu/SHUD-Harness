Verifier: followup-cand-02
Head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Verdict: CONFIRMED

Evidence:
- `packages/core/src/tools/data-raw-write-rule.ts:23` includes wrappers `sudo`, `doas`, `time`, and `env`.
- `packages/core/src/tools/data-raw-write-rule.ts:24-27` only models operand-consuming options for `env -u/--unset` and `nice -n/--adjustment`.
- The loop at `packages/core/src/tools/data-raw-write-rule.ts:203-212` skips option tokens without consuming operands unless listed.
- Therefore:
  - `sudo -u root rm data/raw/input.csv` and `sudo --user root rm data/raw/input.csv` treat `root` as the command.
  - `doas -u root rm data/raw/input.csv` treats `root` as the command.
  - `time -f '%E' rm data/raw/input.csv` treats `%E` as the command.
  - `env --chdir /tmp rm data/raw/input.csv` treats `/tmp` as the command.
- None match mutation commands, so the rule allows and the wrapped tool executes.

Blocking Status:
- Merge-blocking.
- OpenSpec requires `data/raw/**` bash writes to be denied before execution; these wrappers bypass the hard guard.

Required Proof:
- Add table-driven denied cases for:
  - `sudo -u root rm data/raw/input.csv`
  - `sudo --user root rm data/raw/input.csv`
  - `doas -u root rm data/raw/input.csv`
  - `time -f '%E' rm data/raw/input.csv`
  - `env --chdir /tmp rm data/raw/input.csv`
- Assert `result.success === false`, `bashTool.calls === 0`, rule id, `guard_class`, and remediation fields.
