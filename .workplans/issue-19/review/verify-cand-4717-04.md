Verifier verdict for: cand-4717-04
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Verdict: CONFIRMED
Evidence: `packages/core/src/tools/raw-data-sandbox.ts:395-410` returns `policy_gate_process_containment_unavailable` when preflight denies; `:3516-3531` checks interpreter payloads; `:3552-3553` routes Python to `hasPythonProgrammaticProcessCreationSignal`; `:3587-3590` denies any `subprocess.Popen(`. The OpenSpec contract says workspace allowed-directory writes must not be affected (`openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23,34-37`), and tests only cover ordinary workspace write allowed plus escaping `Popen(... start_new_session=True)` rejected.
Note: The claimed waited foreground `Popen` command is legal under the workspace-write invariant but is preflight-denied solely because it contains `subprocess.Popen(`.
