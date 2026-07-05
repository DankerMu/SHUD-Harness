# Issue #19 Final Review Round 2 Verdict Table

Reviewed head SHA: `0a6739dc79d5b53406cf5805f5195999b3620872`

| Candidate | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| G1 inline/env assignment child shell bypass | CONFIRMED | Yes | `RAW=data/raw bash -c ...`, `env RAW=data/raw sh -c ...`, and `env KIND=raw sh -c 'rm data/$KIND/...'` do not propagate command-scoped env into recursive shell scans. |
| G2 cwd-changing wrapper and command group bypass | CONFIRMED | Yes | `env -C/--chdir` updates runtime cwd but not scan cwd; grouped/subshell `cd` forms such as `(cd data && rm raw/...)` are not modeled. |
| G3 implicit cwd output writer bypass | CONFIRMED | Yes | `curl -O/-OJ`, default `wget`, default `git clone`, and archive extraction can write into protected raw cwd without an explicit raw path operand. |
| G4 executable code writer under-modeled | CONFIRMED | Yes | Supported `Rscript -e` code strings can write raw paths via `writeLines`, `write.csv`, or `saveRDS` without matching current writer intent patterns. |
| G5 Mac case / alias path resolution | CONFIRMED | Yes | Case-insensitive Mac path aliases such as `DATA/RAW/...` and POSIX glob classes such as `[[:lower:]]` can resolve to protected raw paths. |
| G6 audit special-file safety | CONFIRMED | Yes | Audit append rejects symlinks but not preexisting FIFO/device/special files at the audit file path. |
| G7 executable code scan resource bound | CONFIRMED | Yes | Executable-code scanning collects unbounded raw targets and runs multiple full-string regexes per target before policy decision. |
| G8 read-only / workspace false denials | CONFIRMED | Yes | `cd data/raw && cat input.csv` and task-workspace-relative `touch data/raw/out.csv` can be denied despite read-only/raw-scratch exemptions. |

Decision:
- PR #46 remains BLOCKED.
- Same failure class has recurred across multiple comprehensive reviews after invariant closure. Proceed with a Review Failure Retro and class-level strategy fix, not isolated example chasing.
- The next implementer task must:
  - Make cwd/env/effective-path state explicit in the scan context.
  - Use resolved local paths as authoritative when cwd is known, preserving task-workspace exemptions.
  - Fail closed for unmodeled shell structures only on write-risk surfaces.
  - Keep read-only raw references allowed where intent is constructibly read-only.
  - Bound text/code scans.
  - Reject non-regular audit files.
