# Issue #19 Review Failure Retro

Failure class: static bash/path policy parsing misses shell execution semantics.

Rounds affected:
- Earlier follow-up rounds: direct writer/extractor, wrapper operands, symlink escape, fallback option assignment, command substitution, variable expansion, read-only over-deny.
- Final round 1: cwd/workDir/cd, unresolved expansion/globs/defaults, composed variables, heredoc/stdin writes, read-only false positives, audit parent race.
- Final round 2: inline/env child-shell variables, env chdir/group cwd, implicit cwd output writers, executable-code writer patterns, Mac path aliases, audit special files, parser resource bounds, workspace/read-only false denials.

Why Phase 5/6 did not close it:
- Fixture scope gap: partial. The fixture stated the governing invariant but did not enumerate shell execution surfaces: effective cwd, command-scoped env, default output destinations, grouped commands, and Mac filesystem aliases.
- Fix prompt too narrow: yes. Earlier prompts closed named bypasses but did not require a single scan context carrying cwd/env/path authority and bounded parsing across all writer families.
- Reviewer finding contract vague/inconsistent: no. Recent findings were concrete and verifier-confirmed.
- Missing regression evidence: yes. Regression tests grew case-by-case, but did not yet enforce class-level surfaces such as command-scoped env or implicit cwd output.
- PR too broad / should split: no for issue #19, because the acceptance invariant is explicitly about pre-exec denial and the affected code remains one rule/helper surface. Split would leave a known bypass in the same guard.

Next corrective action:
- Perform an invariant closure retry with a class-level implementation brief.
- Update the effective scan model instead of adding another list of single bypasses:
  - State: `{ cwd, variables, sourceTrust }` flows through every segment and recursive shell/code scan.
  - Path authority: when cwd is known, resolved local path decides `data/raw` vs governed `workspace/tasks`; unresolved literal is used only when cwd is unknown.
  - Cwd-changing surfaces: `cd`, `env -C/--chdir`, simple grouped/subshell `cd` forms; unmodeled cwd structures on write-risk paths fail closed.
  - Env surfaces: prefix assignments and `env NAME=value` are included for the wrapped command/child shell.
  - Writer families: explicit destination options plus implicit cwd output defaults.
  - Read-only carveout: allow known read-only tools and known read-only executable snippets; deny unknown executable snippets with raw paths only when write intent or unsafe uncertainty is present.
  - Safety bounds: cap executable-code scan size/target count and reject non-regular audit files.

Regression matrix:
- cwd/env: `env -C data rm raw/x`, `(cd data && rm raw/x)`, `RAW=data/raw bash -c 'rm "$RAW/x"'` -> deny before execute.
- implicit outputs: raw cwd + `curl -O`, `wget URL`, `git clone URL`, `tar -xf archive.tar` -> deny before execute.
- path aliases: `DATA/RAW/x`, `data/ra[[:lower:]]/x` on write surfaces -> deny before execute.
- read-only: `cd data/raw && cat x`, task-scratch `touch data/raw/out.csv`, read-only R/Python raw reads -> allow.
- executable writers: R `writeLines`/`write.csv`/`saveRDS` raw targets -> deny; `read.csv` raw target -> allow.
- audit: preexisting FIFO/special audit file -> reject quickly; ordinary audit append still succeeds.
- bounds: large raw-literal executable code input -> bounded deny/allow decision without per-target unbounded regex churn.
