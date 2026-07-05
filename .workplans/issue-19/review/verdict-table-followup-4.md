# Phase 4.5 Verdict Table - Follow-up Round 4

- PR: #46
- Reviewed head SHA: `ed74f39bad555cfd887099c96595c69bf342a359`
- Fixture level/risk: high

| Candidate | Verdict | Merge-blocking? | Rationale |
| --- | --- | --- | --- |
| C1-shell-positional | CONFIRMED | yes | `$0`, `$@`, `$*`, and implicit positional loops are not modeled for nested shell `-c`, allowing protected raw path operands to be consumed by mutating shell bodies. |
| C2-executable-code-apis | CONFIRMED | yes | Supported executable-code runtimes omit common write APIs and variable-target writes while OpenSpec requires bash-invoked raw writes to be denied. |
| C3-embedded-shell-dsls | CONFIRMED | yes | AWK/Sed payloads, `trap`, and `find -exec sh -c` raw mutations are not scanned as executable write targets. |
| C4-parameter-transforms | CONFIRMED | yes | Unsupported `${VAR%...}` / `${VAR#...}` / substitution-style expansions can resolve to `data/raw` but are wildcarded into patterns that no longer match adjacent `data/raw`. |
| C5-non-bash-tools | REFUTED | no | #19/OpenSpec accepted boundary is wrapped bash only; write/edit tool coverage belongs to a later issue. |
| C6-pure-evaluator-fs | CONFIRMED | yes | `existsSync`/`realpathSync` in the data/raw rule violates the pure evaluator contract and makes policy output depend on ambient FS state. |
| C7-shell-builtins | CONFIRMED | yes | Assignment-bearing builtins (`readonly`, `declare`, `typeset`) are not propagated, allowing hidden protected raw targets. |
| C8-same-command-symlink | CONFIRMED | yes | Same-command symlink creation to raw ancestors is not modeled before later segments write through the alias. |
| C9-read-overdeny | CONFIRMED | yes for closure | Raw read prohibition is a non-goal, but common read-only commands/builtins are denied by fallback. |
| C10-budget-and-alias-perf | CONFIRMED | yes for closure | Oversize non-mutating commands can be denied as raw mutation; per-token ambient alias checks add unbounded synchronous FS work. |

## Fix Synthesis

Pattern escalation remains active. Close these at invariant level:

1. Pure scanner state: remove ambient filesystem probing from policy evaluation; model only deterministic command-local state.
2. Shell state completeness: bind shell positional parameters including `$0`, `$@`, `$*`, implicit `$p` loop usage, declaration builtins, and supported parameter transforms.
3. Embedded payload closure: fail closed for protected raw path text combined with executable-code or DSL write intent in shell/interpreter payloads.
4. Alias safety: track same-command symlink aliases that target protected ancestors and deny later writes through those aliases.
5. Read compatibility: explicitly allow common read-only raw inspection forms and input redirects.
6. Bounded behavior: apply command scan budget after non-executable heredoc stripping and only fail closed on oversize commands containing raw-path text.
