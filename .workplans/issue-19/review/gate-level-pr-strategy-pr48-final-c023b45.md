# PR #48 Final Review Strategy Review

Issue: #19
PR: #48
Current head SHA: c023b45334c963a46c4a67ced5d35c99c63bf62d
Date: 2026-07-04

## Trigger

The final comprehensive review after commit `c023b45334c963a46c4a67ced5d35c99c63bf62d` produced multiple verifier-confirmed P1 findings:

- raw-denial evidence remains incomplete for hidden-stderr in-place mutations and unrecognized writer families;
- legal raw-read plus workspace-write flows can be advisory-denied;
- ordinary legal raw-read/workspace-write failures can be misclassified as `denied_by_sandbox`;
- timeout/abort can leave TERM-ignoring descendants alive;
- audit evidence protection denies the whole `workspace/tasks/**` tree, including canonical task scratch/artifact writes.

This is not a base-runtime decision and does not reopen ADR-0001. The OS sandbox authority still protects raw bytes. The remaining failures are wrapper-side classification, process-control, and evidence-path scoping invariants.

## Diagnosis

The previous remediation still let the wrapper infer too much from shell text:

- broad output redirection plus any `data/raw` mention was treated as a raw write risk;
- interpreter classifiers were path-presence based rather than target-aware;
- in-place/raw writer families were split across different detectors, so suppression and post-exec classification disagreed;
- protected audit evidence used an ancestor directory as the sandbox-denied path, making task scratch/artifact writes collateral damage.

The same theme repeats: one layer is trying to preserve evidence by over-approximating behavior, then accidentally breaks legal workspace workflows. The next pass must separate three concepts explicitly:

1. **Known raw write target**: safe to deny/advisory-deny or normalize as `denied_by_sandbox`.
2. **Known legal raw read / workspace write**: must not become raw-denial evidence.
3. **Unknown shell semantics**: advisory fails open; OS sandbox remains authority, but evidence normalization can only happen when there is a precise target signal or visible OS denial.

## Decision

Continue in PR #48 with one root-cause remediation pass. Do not split, merge, or change base runtime.

Required remediation direction:

- Replace broad raw-write literal fallback with target-aware signals only.
- Fold in-place mutation detection into the suppressed-denial guard.
- Add explicit interpreter writer target recognition for Node/Python/Ruby and R/Rscript where tests require it; legal raw-read/workspace-write transforms must pass with advisory enabled.
- For no-denial-output failures, normalize to `denied_by_sandbox` only when there is a precise raw-write target or an already-known suppressed raw write form; otherwise keep generic command failure.
- Fix process-tree termination so TERM-ignoring descendants cannot write after timeout/abort returns. Keep a process-group SIGKILL fallback active or issue final group SIGKILL before return.
- Narrow evidence protection: protect the actual audit file/dir needed for evidence integrity without denying all `workspace/tasks/**`; task scratch/artifacts/worktrees must remain writable.
- Change WS skeleton timestamp field to canonical `timestamp`.

## Required Regression Proof

Add focused tests for:

- suppressed `sed -i` / `perl -pi` raw mutation returning `denied_by_sandbox`;
- legal raw read to workspace write in Node/Python/Ruby and dynamic `workspace/data/raw` shell paths with advisory enabled;
- `grep NOT_PRESENT data/raw/input.csv > workspace/out.txt 2>workspace/err.log` returning generic failed, not raw denial;
- TERM-ignoring timeout and abort descendants not writing after tool return;
- writes to `workspace/tasks/<task>/scratch` and `workspace/tasks/<task>/artifacts` succeeding while audit sabotage tests still pass;
- WS `tool.failed` envelope using `type` and `timestamp`;
- current issue-19 raw sandbox suite, registry/WS suite, full `check`, OpenSpec strict validation, diff check, and zero clean check.

## Non-Goals

- Do not remove `profile_path` from raw-denial payloads; prior verifier refuted that as a finding under the current contract.
- Do not weaken the OS sandbox authority or change `zero/`.
- Do not add a final SHA-matched pass artifact until the next fixed head is actually frozen and review-clean.
