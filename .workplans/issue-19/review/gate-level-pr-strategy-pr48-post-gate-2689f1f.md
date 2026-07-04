# Gate-Level PR Strategy Review — PR #48 post-gate 2689f1f

PR: #48
Issue: #19
Current head SHA: `2689f1f9bb82b23a86acd51418e40f8fafba3d04`
Comprehensive review rounds counted: post-five strategy path, latest post-gate follow-up on `2689f1f`.

## Deep Review Failure Retro

Round SHAs/reports:
- Prior post-gate corrective action: `73d695c53acc63eff7591baa620d840d42a1c679` -> ten V73 verifier-confirmed findings fixed in `2689f1f9bb82b23a86acd51418e40f8fafba3d04`.
- Latest comprehensive follow-up: `2689f1f9bb82b23a86acd51418e40f8fafba3d04` -> six reports persisted as `followup-post-gate-2689f1f-*.md`; not clean.
- Latest verifier table: `.workplans/issue-19/review/verdict-table-pr48-post-gate-2689f1f.md` -> 4 CONFIRMED, 0 PLAUSIBLE, 0 REFUTED.

Repeated or moving failure classes:
- Process lifecycle containment / audit durability: V73 process escape was narrowed to literal session signals plus PPID sampling, but dynamic detached/session children still move into sibling evidence surfaces after terminal success.
- Hidden-denial evidence false success: V73 fixed named interpreter/static targets, but bounded analysis still has unrepresented incomplete states, so swallowed OS denials can be recorded as `allowed`.
- Compatibility false denial: fixes that fail closed on uncertainty reintroduce pre-exec static authority and reject legal workspace writes/raw reads.

Why prior fixes did not close the invariant:
- Fixture scope gap: no - the fixture already says execution-layer authority, legal reads/writes allowed, and denial evidence must align.
- Fix prompt too narrow: yes - the previous pass patched named escape forms instead of representing three separate facts: runtime audit namespace protection, analysis completeness, and advisory-vs-sandbox decision identity.
- Reviewer finding contract vague/inconsistent: no - latest verifier pass independently confirmed concrete repro paths.
- Missing regression evidence: yes - tests covered named V73 examples but not obfuscated detached descendants, analysis truncation, over-budget legal commands, or containment-keyword literals.
- PR too broad / should split: no - all failures sit in `raw-data-sandbox` and its tests; splitting would hide the invariant rather than reduce coupling.

## Gate-Level PR Strategy Review

Direction check:
- The PR still solves the right #19 problem: raw bytes are enforced by macOS seatbelt in the SHUD-owned bash wrapper, and Zero remains clean. The drift is in evidence/lifecycle truth around the wrapper.

Architecture/refactor check:
- The current code shape is fighting the requirement because one `RawDataCommandAnalysis` boolean set is asked to mean static advisory, hidden-denial evidence risk, and runtime sandbox denial. Refactor needed: make analysis completeness/decision identity explicit, and move evidence namespace protection into the seatbelt profile rather than append-time detection only.

Loop check:
- Findings are moving across sibling surfaces under one invariant: raw bytes are protected, but the wrapper can still lie about terminal state or denial source. More regex-only patches are not an acceptable next action.

Functionality root-cause check:
- User-visible feature contract is not green on `2689f1f`: legal large commands can be rejected, and hidden denied attempts can be reported as success.

Security/safety root-cause check:
- Raw-byte safety is materially improved, but evidence/audit safety is not complete because detached children can mutate audit ancestors after success unless the evidence namespace is denied in the sandbox profile.

Decision:
- Continue with invariant-closure refactor inside PR #48. Do not proceed to Phase 7. Do not merge this head.

Execution plan:
- Delegate one serial implementer fix pass. Do not parallelize because all fixes touch `packages/core/src/tools/raw-data-sandbox.ts` and its tests.
- Root action 1: evidence namespace protection. Add the reserved audit directory to `protectedEvidencePaths` so `workspace/tasks/<task>/audit` and ancestor renames that contain it are denied by seatbelt while sibling `scratch`/`artifacts` writes remain allowed. Keep append-handle identity checks as defense-in-depth. Add delayed detached audit-subtree move regression.
- Root action 2: analysis completeness and decision identity. Pre-exec denials must use `denied_by_advisory`; only actual post-exec sandbox denials use `denied_by_sandbox`. Top-level command/payload/segment budget overflow must not reject legal raw reads or workspace writes solely because the analyzer is uncertain.
- Root action 3: hidden-denial closure. Make interpreter call-count truncation an explicit incomplete-analysis state. Hidden-sensitive, write-capable truncated interpreter forms must fail closed as advisory before execution; bounded complete forms should continue to use recognized raw targets. Add regressions for `>512` benign writes followed by swallowed raw write and for the confirmed `chr(100)+"ata/raw/..."` path construction.
- Root action 4: containment preflight precision. Replace raw-string keyword matching with token/payload-aware process containment checks that do not reject `printf setsid > workspace/setsid.txt` or keyword filenames. Keep unquoted background-without-wait and real process/session escape APIs rejected.
- Root action 5: verification. Run focused sandbox tests, registry/WS tests, `openspec validate m1-foundation --strict --no-interactive`, `git diff --check`, `git -C zero diff --quiet && git -C zero rev-parse HEAD`, and `pnpm --package=bun@1.2.19 dlx bun run check`.

## Invariant Surface Inventory

- Shared helper roots: `packages/core/src/tools/raw-data-sandbox.ts` command analysis, process preflight, sandbox runner, audit reservation, profile builder.
- Public entrypoints: `RawDataSandboxedBashTool.run()` and `createShudSandboxedBashTool()` registry replacement.
- Read surfaces: raw reads under sandbox, process table sampling, audit identity checks.
- Write/delete/overwrite surfaces: raw write/delete/rename/truncate, workspace allowed writes, `workspace/tasks/<task>/audit` evidence writes, temp profile writes.
- Staging/publish/rollback surfaces: temp profile file creation/cleanup; no publish surface in M1.
- Producer/consumer evidence boundaries: ToolResult -> raw denial payload -> `tool.failed` skeleton input -> audit row -> running metadata.
- Stale-state/idempotency boundaries: delayed descendant writes after terminal state; moved/replaced audit ancestors; final wrapper metadata.
- Unchanged downstream consumers: policy-gate pure evaluator, Zero tool registry wrapper, backend WS skeleton builder.

## Regression Matrix

- Over-budget legal raw read / workspace write -> executes under OS sandbox and records `tool.completed/allowed`.
- Over-budget or truncated hidden-sensitive interpreter raw write -> fails closed as `denied_by_advisory` or normalizes visible OS denial; no raw mutation; no false `allowed`.
- `printf setsid > workspace/setsid.txt` and keyword filenames -> succeed as legal workspace writes.
- Literal/session/process creation escape forms and unquoted `&` without wait -> fail closed with `policy_gate_process_containment_unavailable`.
- Detached child attempts to move `workspace/tasks` or `workspace/tasks/<task>/audit` after return -> mutation denied or containment failure; canonical audit row remains readable after settle.
- Task `scratch`/`artifacts` sibling writes under `workspace/tasks/<task>/` -> still allowed.
- `git -C zero diff --quiet` and HEAD `13e25c1` -> unchanged.

## Post-Gate Budget

- After this corrective action, run exactly one full comprehensive cross-review on the new head before Phase 7.
- If any P1/P0 finding in process lifecycle, hidden-denial evidence, or compatibility false-denial remains, do not run another narrow fix round. Re-enter this strategy review and choose a stronger action: OpenSpec scope revision for unobservable swallowed-denial telemetry, executor redesign, or PR split only if a real ownership boundary appears.
