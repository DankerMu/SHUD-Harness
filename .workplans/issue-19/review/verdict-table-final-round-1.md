# Issue #19 Final Review Round 1 Verdict Table

Reviewed head SHA: `52afa181d1028f32c4fc8c59f104eb972ae21408`

| Candidate | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| F1 effective cwd / relative path bypass | CONFIRMED | Yes | Rule ignores `ToolContext.workDir` and `cd`, allowing `printf x > input.csv` from `data/raw`, `touch raw/input.csv` from `data`, or `cd data && rm raw/input.csv`. |
| F2 unresolved shell expansion path bypass | CONFIRMED | Yes | Path operands such as `data/ra$(printf w)/input.csv`, `${UNSET:-data/raw/input.csv}`, `data/ra[w]/input.csv`, and `data/ra?/input.csv` can resolve to protected raw paths. |
| F3 composed variable assignment bypass | CONFIRMED | Yes | Assignments such as `PATHNAME="$ROOT/$KIND"` are dropped instead of resolved from known literal variables, allowing later `rm "$PATHNAME/input.csv"`. |
| F4 interpreter heredoc/stdin bypass | CONFIRMED | Yes | Interpreter stdin/heredoc scripts such as `python - <<'PY' ... PY` are not inspected before execution. |
| F5 read-only false-positive regression | CONFIRMED | Yes | Read-only raw references such as `stat`, `sha256sum`, read-only `curl` URL paths, and read-only interpreter snippets are denied despite raw reads being non-goal/protected allow path. |
| F6 audit parent-directory TOCTOU | PLAUSIBLE | Yes | `O_NOFOLLOW` protects the final audit file, but not parent directory replacement after validation and before `open`. |

Decision:
- PR #46 remains BLOCKED under high-risk rules.
- Ordinary single finding chase has recurred; next fix must close the invariant class rather than only cited examples.
- Required post-fix proof:
  - Deny tests for cwd/workDir/cd relative mutations, unresolved expansion/glob/default expansion paths, composed variables, and interpreter heredoc writes.
  - Allow tests for read-only raw tools and read-only interpreter/code/URL references that do not mutate.
  - Audit append proof revalidates the parent directory after no-follow file open or otherwise removes the race within this spike's feasible scope.
  - Full project check, strict OpenSpec validation, diff check, zero submodule cleanliness.
