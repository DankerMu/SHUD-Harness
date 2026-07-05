# Finding Verification - cand-final-da20028-04

Verifier verdict for: cand-da20028-04-pid-reuse-cleanup
Reviewed head SHA: `da20028bc40c1e5f90b1aa3d245acf5181e6add6`
Verdict: CONFIRMED

Evidence: Timeout/abort and final non-completed cleanup call `terminateInvocationProcesses(..., { signalRootProcessGroup: true })` at `raw-data-sandbox.ts:1519`, `1528`, and `1543`; that function samples the tracker then calls `tryKillProcess(proc, "SIGKILL", signalProcess)` at `2114` and `2122-2123`. `tryKillProcess()` signals `-pid` before using the process handle at `1933-1937`. The tracker seeds any current `ps` record with the stored root PID via `const rootRecord = input.table.get(input.rootPid); if (rootRecord) currentProcesses.set(rootRecord.pid, rootRecord);` at `2214-2217`, with no identity/liveness guard, and `killCurrentInvocationPids()` signals both `-pid` and `pid` at `2194-2203`.

Note: The `identity` parsed from `ps -axo ... lstart` is stored at `2256-2260` but is not used to prevent re-owning a reused root PID.
