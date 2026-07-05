# Finding Verification - cand-final-e4f00c3-02

Verifier verdict for: cand-e4f00c3-02-unwaited-interpreter-child
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`
Verdict: CONFIRMED

Evidence: `packages/core/src/tools/raw-data-sandbox.ts:4130-4148` only rejects session-escape signals or shell `&` without wait; `:4196-4207` only flags Python process creation when arguments contain `start_new_session=True` or `preexec_fn=os.setsid/setpgrp`; normal completion then calls `completeInvocationProcesses()` at `:1709-1714`, which only stops the tracker and clears `currentPids` at `:2352-2357`; successful results are audited as `event: "tool.completed"` / `decision: "allowed"` at `:654-659`. The waited foreground Popen allow path is explicitly required by `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:39-40` and covered at `packages/core/src/tools/raw-data-sandbox.test.ts:2795-2811`.

Note: No existing regression covers un-awaited Python `Popen` writing workspace after wrapper completion.
