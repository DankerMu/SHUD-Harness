# PR #48 Post-Gate Strategy Review

Issue: #19
PR: #48
Current head SHA: 73d695c53acc63eff7591baa620d840d42a1c679
Date: 2026-07-04

## Trigger

The post-gate comprehensive review on `73d695c53acc63eff7591baa620d840d42a1c679` produced seven verifier-confirmed P1 findings and three confirmed P2 findings. These are not new product scope and do not reopen ADR-0001; they show the wrapper implementation is still chasing shell/interpreter cases instead of owning a single evidence/lifecycle invariant.

## Diagnosis

The remaining failures group into three root causes:

1. **Target resolution is not a shared cwd-aware abstraction.** Advisory, suppressed-denial guard, post-exec normalization, interpreter payload parsing, and parent-relative shell handling each own partial logic. This misses `env`/assignment wrappers, receiver-style APIs, named arguments, cwd-relative interpreter payloads, and stderr-file success masks; it also over-denies legal workspace-local `data/raw` writes.
2. **Lifecycle containment stops at the initial process group.** Timeout/abort and successful calls can return while descendants outside the original process group or delayed background children still mutate allowed workspace/evidence paths.
3. **Final evidence state is split across layers.** The inner runner freezes running-tool metadata before outer denial/audit normalization, audit rows can be moved after success, and project-root audit layout is inferred from whether `workspace/` already exists.

## Decision

Continue in PR #48 with one stronger root-cause remediation pass. Do not split the PR, do not change `zero/`, and do not weaken the OpenSpec fixture.

Required implementation direction:

- Introduce or refactor to one target-resolution path used by advisory, suppressed-denial guard, and post-exec normalization. It must understand effective command prefixes (`NAME=value`, `env`), tracked cwd for static `cd`/`pushd` segments, interpreter payloads, receiver-style path APIs, named write-mode arguments, and parent-relative raw aliases. Unknown cwd/interpreter semantics must fail open unless there is a precise raw mutation target.
- Treat target-aware raw mutations with stderr redirected away from the parent as denial-evidence candidates even when the final shell status is success. Keep this target-aware so legal raw reads and workspace writes remain allowed.
- Fix lifecycle containment as a first-class executor boundary. Timeout/abort and normal-success returns must not leave invocation-owned descendants able to mutate workspace/audit paths. Either track/enumerate descendants and kill/poll them before return, or reject daemonizing/session-escape forms with stable evidence if containment cannot be proven.
- Make audit durability true at return and after descendant settle. Delayed background audit-subtree moves must either be impossible, fail closed, or be caught before the tool reports success.
- Move running-tool finalization so terminal metadata reflects the wrapper's final ToolResult (`denied_by_sandbox`, `policy_gate_audit_unavailable`, timeout/abort, or success), not the pre-normalized subprocess exit.
- Resolve audit roots from layout semantics, not existence of `workspace/`: project roots containing protected `data/raw` should use/create `workspace/tasks/...`; canonical workspace roots should use `tasks/...` without double nesting.
- Add a bounded pre-exec scan budget for command/payload analysis. On budget exhaustion, choose a documented safe behavior that preserves the ADR split: advisory uncertainty fails open where OS sandbox remains authority, but do not perform unbounded CPU work before subprocess timeout starts.

## Required Regression Matrix

- Env/assignment-wrapped Python/Node/Ruby/Rscript raw mutations with hidden stderr -> `denied_by_sandbox`, raw unchanged, matching audit.
- Receiver/named-mode Python path APIs (`Path.unlink`, `Path.open("w")`, `open(..., mode="w")`, `Path.rename`) -> `denied_by_sandbox` when targeting protected raw; legal workspace-local variants after `cd workspace` remain allowed.
- Dynamic target with `2>workspace/err.log` plus trailing success -> `denied_by_sandbox`.
- Timeout and abort with a descendant that calls `setsid()`/`setpgrp()` before delayed workspace write -> no write at return and after settle, or stable fail-closed/reject evidence if containment is intentionally denied.
- Successful command with delayed background `mv workspace/tasks ...` -> either fail closed or audit row remains at canonical path after settle.
- Running-tool metadata tests for visible raw denial, audit-unavailable failure, timeout/abort, and successful allowed command.
- Fresh project root with `data/raw` and no `workspace/` -> audit path created under `workspace/tasks/...`; canonical workspace root still no double nesting.
- Node `renameSync` runtime sandbox proof.
- Large benign/adversarial command payloads complete within the scan budget with documented allow/deny behavior.

## Non-Goals

- Do not implement a full shell parser.
- Do not change `zero/`.
- Do not make Rscript or other optional interpreters mandatory when absent.
- Do not block legal raw reads or legal workspace writes because the wrapper cannot prove a static target.
