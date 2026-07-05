# Issue #19 Follow-up Review 2 Verdict Table

Head SHA: `74a8544ae07f158007ac00d4932aca4d30e1528c`

| Candidate | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| followup-cand-01 direct writer/extractor gaps | CONFIRMED | Yes | `sed --in-place`, `find -delete`, `rsync`, `tar -C`, `unzip -d`, `wget -O`, `git clone`, shell expansion examples can reach allow. |
| followup-cand-02 wrapper operand gaps | CONFIRMED | Yes | `sudo -u/--user`, `doas -u`, `time -f`, `env --chdir` can hide mutation command. |
| followup-cand-03 audit symlink escape | CONFIRMED | Yes | Audit dir or file symlink can redirect append outside fixture task audit tree. |
| followup-cand-04 nested same-name `data/raw` overmatch | CONFIRMED | No | Non-canonical writable scratch/workspace paths named `data/raw` can be denied. |
| followup-cand-06 governed workspace over-exemption | CONFIRMED | Yes | `data/raw/workspace/tasks/...` can be misclassified as governed task workspace and allowed. |
| followup-cand-07 conservative raw segment gap | CONFIRMED | Yes | `find data/raw -exec rm` and clustered `sed -Ei` expose the same parser-gap class; fix should stop default-allow for raw-bearing segments. |
| followup-cand-08 option-assignment fallback gap | CONFIRMED | Yes | Conservative fallback misses raw paths embedded in option assignment or short-option attached values such as `--output=data/raw/out.csv`. |

Decision:
- PR #46 remains BLOCKED.
- Send a consolidated fix request to the implementer.
- Required post-fix proof:
  - Table-driven deny regressions for candidates 01 and 02.
  - Symlink escape rejection tests for audit directory and audit file.
  - Optional but low-cost allow regression for `workspace/tasks/TASK-001/scratch/data/raw/out.csv`.
  - Full project check, strict OpenSpec validation, diff check, zero submodule cleanliness.
