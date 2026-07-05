Verifier: followup-cand-01
Head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Verdict: CONFIRMED

Evidence:
- `packages/core/src/tools/data-raw-write-rule.ts:45` allows when `findProtectedDataRawWriteTarget()` returns no target.
- `packages/core/src/tools/policy-gate-registry.ts:164` then executes the inner wrapped tool on allow.
- The detector handles listed command families and special `dd`/`tee`/`sed -i`/`curl`/shell-wrapper cases only.
- `find data/raw -delete`, `rsync /tmp/input.csv data/raw/input.csv`, `tar -xf archive.tar -C data/raw`, `unzip -d data/raw`, `wget -O data/raw/input.csv ...`, and `git clone ... data/raw/repo` fall through to allow.
- `sed --in-place ... data/raw/input.csv` falls through because the `sed` branch only checks `-i` / `-i*`, not `--in-place`.

Blocking Status:
- Merge-blocking hard guard violation.
- OpenSpec says `data/raw/**` writes SHALL be rejected before real bash execution and the scenario says any bash write under `data/raw/` must not execute.

Required Proof:
- Add table-driven denied cases in `packages/core/src/tools/data-raw-write-rule.test.ts`, minimally:
  - `sed --in-place 's/a/b/' data/raw/input.csv`
  - `find data/raw -delete`
  - `wget -O data/raw/input.csv https://example.invalid/input.csv`
- Assert `success === false`, `bashTool.calls === 0`, rule id, guard class, and remediation.
- Add `touch data/{raw,processed}/x` if shell expansion handling is included in the fix.
