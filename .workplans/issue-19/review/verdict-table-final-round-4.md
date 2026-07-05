# Issue #19 Final Review Round 4 Verdict Table

Reviewed head SHA: `4074cf423796f35dce3b38f906d707de2a7161f3`

Final-round verifier status: all six deduplicated finding groups were independently checked after the comprehensive six-view review. Every major group below is CONFIRMED and merge-blocking for PR #46.

| Group | Verdict | Blocking | Scope |
| --- | --- | --- | --- |
| F1 executable/interpreter payload writes | CONFIRMED | Yes | Executable payloads still miss write/delete/copy/open variants such as Ruby `File.delete`, Perl bare `unlink`, Python variable modes and `shutil.rmtree`/`os.replace`, Node `copyFileSync`/`openSync`, Deno eval option ordering, and `/dev/stdin` payloads. |
| F2 pipeline/stdin/dataflow execution | CONFIRMED | Yes | Static segment scanning misses mutation dataflow through `printf ... \| sh`, `find ... \| xargs rm`, `find ... -exec python -c ...`, and heredoc scripts that are staged and executed. |
| F3 dynamic write-target operands and download traversal | CONFIRMED | Yes | Command substitutions/backticks and curl/wget output traversal can construct `data/raw` write targets without a static literal operand, including `--output-dir data/processed -o ../raw/input.csv`. |
| F4 shell dynamic state, budget, and dynamic symlink creation | CONFIRMED | Yes | Shell state construction such as `RAW+=/raw`, over-budget variable setup, dynamic `printf` path fragments, and dynamic symlink aliases remain outside the current regex/state model. |
| F5 pre-existing filesystem aliases | CONFIRMED | Yes | Pre-existing symlink/hardlink aliases and symlinked work directories cannot be proven by the pure pre-exec scanner; they require execution-layer realpath/inode or sandbox enforcement. |
| F6 read compatibility and safety false positives | CONFIRMED | Yes | Read-only uses such as `python scripts/inspect.py data/raw/input.csv`, `Rscript scripts/read_raw.R data/raw/input.csv`, `less data/raw/input.csv`, read-raw/write-workspace flows, and Perl/Ruby module flags are still denied or hard to distinguish under fail-closed static handling. |

Decision:
- PR #46 is NOT mergeable at `4074cf423796f35dce3b38f906d707de2a7161f3`.
- The blocker is no longer an isolated implementation miss. The current static scanner strategy cannot simultaneously satisfy the #19 arbitrary raw-write denial invariant and preserve required read-only compatibility.
- Do not run another ordinary line-item fix pass under the existing strategy.
