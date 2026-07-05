Reviewer agent: review-correctness
Review round: follow-up round 2 after fixes
Reviewed head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Summary: Follow-up fixes close the same-denial WS/audit linkage, but the raw-write detector still has P1 bypasses for common bash write forms and wrapper options.

Invariant Matrix Coverage:
- write denial before execution: missing - covered for tested redirects/substitutions/curl/dd/shell wrappers in `packages/core/src/tools/data-raw-write-rule.test.ts:27`, but untested direct writers and wrapper option operands can still reach execution; see findings 1 and 2.
- WS tool.failed remediation payload: covered - `buildPolicyGateToolFailedEvent` emits `tool.failed` with seq/event_id and remediation-bearing ErrorRecord at `packages/backend/src/ws/policy-gate-events.ts:68`, tested at `packages/backend/src/ws/policy-gate-events.test.ts:29`.
- audit minimal row fixture path: missing - normal fixture path and minimal fields are covered at `packages/core/src/tools/policy-gate-audit.ts:38` and tested at `packages/core/src/tools/data-raw-write-rule.test.ts:187`, but symlink escape is not proven; see finding 3.
- read-only data/raw command compatibility: covered - `cat`, copy-out, multiline read-only, quoted operator, and literal backtick cases are allowed at `packages/core/src/tools/data-raw-write-rule.test.ts:150`.
- prior findings closure: covered - named prior fixes for substitutions, audit path-segment traversal, and same-denial identity linkage are represented in tests at `packages/core/src/tools/data-raw-write-rule.test.ts:33`, `packages/core/src/tools/data-raw-write-rule.test.ts:223`, and `packages/backend/src/ws/policy-gate-events.test.ts:77`.

Findings:
- severity: P1
  failure class: correctness / path-safety bypass
  violated invariant/contract: Bash write attempts targeting `data/raw/**` must be denied before the wrapped tool executes (`openspec/changes/m1-foundation/design.md:143`, `openspec/changes/m1-foundation/design.md:165`).
  concrete scenario: A wrapped bash call like `rsync /tmp/input.csv data/raw/input.csv`, `tar -xf archive.tar -C data/raw`, or `unzip archive.zip -d data/raw` has no shell redirection and uses a write-capable command not listed by the detector, so policy evaluation returns allow and the inner BashTool can mutate protected raw data.
  evidence (file:line): `packages/core/src/tools/data-raw-write-rule.ts:12` defines a finite mutation-command set; `packages/core/src/tools/data-raw-write-rule.ts:155` only checks those known commands plus a few special cases; `packages/core/src/tools/data-raw-write-rule.ts:190` returns undefined for all other commands.
  consequence: Protected raw inputs can be overwritten without a deny result, without `tool.failed`, and without an audit row, breaking the governing evidence-lineage invariant.
  fix direction: Either enforce the write ban at the filesystem/sandbox layer for bash execution, or make the detector conservative for protected raw paths plus write-capable tools; at minimum cover common data workflow writers/extractors such as `rsync`, `tar -C`, `unzip -d`, `wget -O`, and similar destination-oriented commands.
  required test/proof: Add wrapped-tool tests proving these commands are denied before inner execution and that the same denial still maps to remediation, WS, and audit evidence.
  sibling surfaces: `wget`, `git clone <url> data/raw/...`, `python`/`Rscript` one-liners, archive extractors, and any future sandbox exec alias.
  blocking status: Blocking candidate.

- severity: P1
  failure class: correctness / wrapper parsing bypass
  violated invariant/contract: Legacy wrapper compatibility must not let a protected raw-data mutation pass execution before policy denial.
  concrete scenario: `sudo -u root rm data/raw/input.csv` is parsed as wrapper `sudo`, option `-u`, then command token `root`; the real `rm data/raw/input.csv` is never evaluated, so the wrapped bash tool is allowed to execute.
  evidence (file:line): wrappers include `sudo`, `doas`, `time`, and `env` at `packages/core/src/tools/data-raw-write-rule.ts:23`, but operand-consuming options are only modeled for `env` and `nice` at `packages/core/src/tools/data-raw-write-rule.ts:24`; wrapper option skipping happens at `packages/core/src/tools/data-raw-write-rule.ts:202`.
  consequence: Common wrapper forms can bypass the guard even for already-supported mutation commands like `rm`, undermining the prior bypass fixes.
  fix direction: Model operand-consuming options for all supported wrappers, or switch to a conservative parse that denies when a known wrapper contains a protected raw path and the command boundary cannot be identified safely.
  required test/proof: Add denial tests for `sudo -u user rm data/raw/input.csv`, `sudo --user user rm ...`, `doas -u user rm ...`, `time -f "%E" rm ...`, and `env --chdir /tmp rm ...`.
  sibling surfaces: `sudo -g/-p/-C`, `doas -u`, GNU/BSD `time` flags, `env -C/--chdir`, and future wrapper additions.
  blocking status: Blocking candidate.

- severity: P2
  failure class: path safety / evidence lineage
  violated invariant/contract: Audit evidence must land under `workspace/tasks/TASK-M1-SPIKE/audit/`, and workspace path safety requires rejecting symlink escape (`docs/03_SPEC/Workspace_Conventions.md:181`).
  concrete scenario: If `workspace/tasks/TASK-M1-SPIKE/audit` already exists as a symlink to an outside directory, `appendPolicyGateAuditRow` resolves a lexical in-workspace path, then `mkdir`/`appendFile` follow the symlink and write the audit row outside the fixture audit directory.
  evidence (file:line): audit path validation is lexical at `packages/core/src/tools/policy-gate-audit.ts:80` and `packages/core/src/tools/policy-gate-audit.ts:92`; the write follows normal filesystem resolution at `packages/core/src/tools/policy-gate-audit.ts:48`.
  consequence: The audit helper can report an in-workspace path while the evidence is actually written elsewhere, weakening replayability and audit provenance.
  fix direction: Validate real paths and symlinks before append: `lstat` parent components, reject symlinked audit directories/files, and use no-follow/open semantics where available.
  required test/proof: Create a temp workspace with `workspace/tasks/TASK-M1-SPIKE/audit` or the audit file as a symlink to an outside temp path; assert append is rejected and no outside file is written.
  sibling surfaces: Future task-specific audit directories, artifact/report export helpers, and any helper that accepts taskId/fileName path segments.
  blocking status: Non-blocking candidate unless adversarial or pre-existing workspace contents are in scope for M1.

Non-blocking notes:
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` passed.
- Full tests were not run; review stayed read-only aside from the no-emit typecheck.
