# Issue #19 Final Review Round 3 Verdict Table

Reviewed head SHA: `a62b510ab2816f545df9f0b5eb45514c2269b6a6`

| Candidate | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| H1 brace-group cwd side effect | CONFIRMED | Yes | `{ cd data; }; rm raw/input.csv` does not propagate brace-group cwd to the following segment. |
| H2 rsync remove-source-files | CONFIRMED | Yes | `rsync --remove-source-files data/raw/input.csv /tmp/out.csv` is treated like read-only copy-out. |
| H3 negated shell glob bracket | CONFIRMED | Yes | `data/ra[!x]/...` can match raw in shell but not in current JS regex conversion. |
| H4 child shell positional read false denial | CONFIRMED | Yes | `bash -c 'cat "$1"' -- data/raw/input.csv` is read-only but denied; `rm "$1"` still needs deny. |
| H5 parameter slicing and symlink alias | CONFIRMED | Yes | `${RAW:0:8}` expansion can form `data/raw`; path symlink aliases can target canonical raw without literal raw segments. |
| H6 audit internal symlink misplacement | CONFIRMED | Yes | Audit directory symlink inside workspace can redirect evidence away from canonical task audit path. |
| H7 global command scan budget | CONFIRMED | Yes | Large non-executable heredoc/command paths can allocate before any budget applies. |
| H8 heredoc workspace overdeny + branch coverage | CONFIRMED | Yes | Heredoc body written to governed workspace is scanned as executed; `tee/mv/install/ln` branches lack direct deny tests. |

Decision:
- PR #46 remains BLOCKED.
- Apply a focused fix pass. This round is smaller than previous strategy pass but still blocks merge because all candidates are verified.
- Symlink alias detection may require filesystem realpath information. If the current synchronous policy surface cannot safely inspect it without broad contract changes, the fix must fail closed for risky literal workspace symlink-like paths or report a precise follow-up boundary instead of claiming full coverage.
