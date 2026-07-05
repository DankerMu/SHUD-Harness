# Follow-up Round 4 Candidate Summary

- PR: #46
- Reviewed head SHA: `ed74f39bad555cfd887099c96595c69bf342a359`
- Reviewer set: Correctness, Integration, Security/Performance, Test & Evidence, Spec Compliance, Invariant/State-Machine/Compatibility
- Risk: high

## Deduplicated Candidates for Phase 4.5

1. `C1-shell-positional`: nested `bash|sh|zsh -c` misses `$0`, `$@`, `$*`, and implicit positional loops.
2. `C2-executable-code-apis`: executable-code scanners miss common write APIs / variable-target writes for Python, Node, R, Bun, Ruby, PHP, Perl, etc.
3. `C3-embedded-shell-dsls`: shell payload DSLs such as AWK/Sed scripts, `trap`, and `find -exec sh -c` can mutate `data/raw` without detection.
4. `C4-parameter-transforms`: braced parameter transforms such as `${VAR%/*}`, `${VAR#prefix}`, and `${VAR/pat/repl}` can hide protected raw targets.
5. `C5-non-bash-tools`: non-bash mutating tools such as `write`/`edit` bypass because the rule currently gates only `bash`.
6. `C6-pure-evaluator-fs`: policy evaluation performs synchronous ambient filesystem reads for symlink aliases, conflicting with the pure evaluator contract.
7. `C7-shell-builtins`: shell variable declaration builtins such as `readonly`, `declare`, and `typeset` are not propagated into later expansion.
8. `C8-same-command-symlink`: a single command can create a symlink alias to `data` then mutate `link/raw/...` before ambient alias resolution observes it.
9. `C9-read-overdeny`: fallback behavior denies read-only raw inspection commands/builtins outside the write/mutation scope.
10. `C10-budget-and-alias-perf`: scan-budget fallback and per-token alias realpath checks can over-deny or stall large non-mutating commands.
