# Issue #19 Follow-up Round 5 Verdicts

Head: 51b9bbd81fb1659de7d723abb1446b4183c2527d

| Candidate | Verdict | Blocking | Notes |
| --- | --- | --- | --- |
| R5-C1 dynamic/unbraced shell variables | CONFIRMED | yes | Unknown `$VAR` and dynamic assignments can resolve to `data/raw/**` in mutation contexts. |
| R5-C2 bash case-transform parameters | CONFIRMED | yes | `${RAW,,}` / `${RAW^^}` unsupported and fallback loses adjacent `data/raw`. |
| R5-C3 read-write redirect `<>` | REFUTED | no | Tokenizer emits `>` write operator and denies raw target already. |
| R5-C4 curl `--output-dir` | CONFIRMED | yes | `--output-dir` / `--remote-name-all` not parsed. |
| R5-C5 executable payload constructors and in-place modes | CONFIRMED | yes | Split string / path constructors and Perl/Ruby in-place edits bypass. |
| R5-C6 oversized dynamic raw fallback | CONFIRMED | yes | Over-budget fallback only checks contiguous `data/raw`. |

Post-gate disposition: the confirmed issues are the same raw-write invariant family after a prior gate corrective action. Next action must be a stronger root-cause pass: fail closed for unresolved dynamic path patterns in mutation contexts, expand interpreter/path-constructor coverage, and harden command-specific output directory parsing before another comprehensive review.
| R5-C7 read-only echo/printf | CONFIRMED | yes | Read-only/display raw paths are denied; allow no-redirection echo/printf. |
| R5-C8 cross-call symlink alias | CONFIRMED | yes | Pure evaluator has no persistent alias facts; current PR will deny raw-exposing symlink creation and record execution-layer realpath as residual if needed. |
| R5-C9 Deno writeTextFile APIs | CONFIRMED | yes | Deno writeTextFile/writeTextFileSync missing from executable write markers. |
| R5-C10 missing workDir purity | CONFIRMED | yes | Missing workDir falls back to process.cwd(); change to unknown cwd for pure evaluation. |
| R5-C11 command -p read wrapper | CONFIRMED | yes | `command -p` treated uncertain and blocks read-only `cat`; parse safe no-operand options. |
| R5-C12 find read-only exec | CONFIRMED | yes | Any `find -exec` currently treated as mutation; only deny delete or mutating exec payload. |
| R5-C13 audit hardlink escape | CONFIRMED | yes | Preexisting hardlinked audit file can append outside content; reject `nlink > 1` before and after open. |
