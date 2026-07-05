# PR #48 Follow-up Final Review Strategy Review

Issue: #19
PR: #48
Current head SHA: ee9b32cbe4fab76e6bdc7697980feec7646b46e8
Date: 2026-07-04

## Trigger

The follow-up comprehensive review after commit `ee9b32cbe4fab76e6bdc7697980feec7646b46e8` produced five verifier-confirmed P1 findings and one optional P2 evidence gap:

- hidden interpreter raw mutations still escape wrapper classification when stderr is suppressed;
- legal raw-read/workspace-write failures can still be normalized as raw sandbox denial from broad visible denial text;
- timeout/abort still gives TERM-ignoring descendants enough time to write before final group kill;
- normal non-denial audit append failures are warning-only, losing required audit rows;
- audit root resolution treats canonical workspace roots as if they were project roots;
- Rscript legal-copy runtime proof is absent when Rscript is available.

This does not reopen ADR-0001. The ADR decision remains: OS sandbox authority is the boundary, static/pre-exec analysis is advisory, and wrapper evidence must be precise rather than pretending shell semantics are statically knowable.

## Diagnosis

The latest pass improved individual cases but did not close the governing invariant:

1. Raw mutation recognition is still API-family based and incomplete across interpreter runtimes.
2. Denial normalization still uses coarse text/path signals that cannot distinguish legal workspace failures from raw writes.
3. Timeout cancellation still uses a grace window that lets TERM-ignoring parents or descendants act before the wrapper returns.
4. Audit evidence is treated differently on denial and non-denial paths, so successful commands can erase their required audit trail.
5. The audit root contract is ambiguous between project root and canonical workspace root, while the public option is named `workspaceRoot`.

The corrective action must close the invariant at shared helper boundaries instead of adding more one-off cases.

## Decision

Continue in PR #48 with one serial implementer root-cause remediation pass. Keep the branch, keep the current OpenSpec scope, and keep `zero/` untouched.

Required remediation direction:

- Replace visible-denial fallback with target-aware normalization only: `Permission denied` plus a raw path is not enough; a known raw mutation target must be present, or the result remains an ordinary command failure.
- Expand `hasKnownRawDataWriteTarget` / sibling helpers to cover interpreter mutation families, including delete, rename/move, and copy-to-raw targets for Python, Node, Ruby, and R/Rscript. Treat raw source deletion/rename/move as mutation; treat raw source copy to workspace as legal.
- Ensure suppressed-denial guard and post-exec classification call the same target-aware mutation logic so advisory, suppressed failure, and result normalization cannot diverge.
- On timeout/abort, force-kill the process group before returning. Do not allow a grace window that permits a TERM-ignoring shell or child to write before the tool result is delivered.
- Make lifecycle audit append fail closed when path identity or append fails, with the same `tool.failed` / audit-unavailable behavior used by denial audit failures.
- Resolve audit root explicitly: canonical workspace root writes audit to `tasks/<task_id>/audit/`; test fixtures that pass a project root may adapt to its `workspace/` child only when that layout is detected. Add coverage for both roots.
- Add a conditional Rscript runtime legal-copy proof when `Rscript` is available; keep it skipped when unavailable.

## Required Regression Proof

Add or update focused tests for:

- hidden Python `os.unlink`, Python `os.rename` or `shutil.copyfile` to raw, Node `copyFileSync`/`unlinkSync`, Ruby `FileUtils`/`File.delete`, and R/Rscript `file.copy`/`file.rename`/`unlink` raw mutation forms returning `denied_by_sandbox` when the OS denial is suppressed;
- legal raw read to workspace write/copy failures returning ordinary failed command results, not `denied_by_sandbox`, including `cp data/raw/input.csv workspace/no-write/input.csv` and a raw-reading `grep` that prints `Permission denied` for unrelated reasons;
- legal raw read to workspace write still allowed for shell and interpreter paths with advisory enabled;
- TERM-ignoring timeout and abort cases proving no descendant write exists at or after tool return;
- non-denial audit ancestor sabotage returning a failed tool result instead of successful `allowed` audit loss;
- audit path resolution for both canonical workspace root and current project-root fixture layout;
- existing raw sandbox suite, registry suite, WS suite, full `bun run check`, OpenSpec strict validation, `git diff --check`, and zero clean check.

## Non-Goals

- Do not change `zero/`.
- Do not weaken OpenSpec, tests, or CI to silence the findings.
- Do not remove `profile_path` from raw-denial payloads.
- Do not make Rscript presence mandatory on machines where it is not installed.
