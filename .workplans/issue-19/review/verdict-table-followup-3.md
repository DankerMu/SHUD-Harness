# Issue #19 Follow-up Review 3 Verdict Table

Head SHA: `74a8544ae07f158007ac00d4932aca4d30e1528c`

| Candidate | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| C1 eval/interpreter code-string bypass | CONFIRMED | Yes | `eval 'rm data/raw/input.csv'`, `eval "printf x > data/raw/input.csv"`, and interpreter code strings such as `python -c 'open("data/raw/x","w")...'` are not parsed as executable mutation surfaces. |
| C2 shell variable expansion bypass | CONFIRMED | Yes | Simple same-command assignments such as `RAW=data/raw; rm "$RAW/input.csv"` and `export RAW=data/raw; touch "$RAW/input.csv"` can construct a protected target at execution time. |
| C3 read-only raw command over-deny | CONFIRMED | Yes | Read-only raw inspection commands such as `find data/raw -maxdepth 1 -type f`, `ls data/raw`, `wc -l data/raw/input.csv`, and non-in-place `sed` are denied despite the #19 evidence floor requiring read-only raw references to remain allowed. |
| C4 audit symlink TOCTOU | PLAUSIBLE | Yes | Audit path validation and append are separate path-based operations; high-risk bias treats this as blocking until append uses a checked/no-follow file handle or equivalent proof. |

Decision:
- PR #46 remains BLOCKED under high-risk rules.
- Send a consolidated Phase 6 fix request to implementer.
- Required post-fix proof:
  - Deny regressions for `eval`, interpreter code strings, and simple variable-expanded raw targets.
  - Allow regressions for common read-only raw inspection commands while preserving existing deny regressions for mutating `find` and `sed -i`.
  - Audit append proof rejects symlink escape at the write/open boundary.
  - Full project check, strict OpenSpec validation, diff check, zero submodule cleanliness.
