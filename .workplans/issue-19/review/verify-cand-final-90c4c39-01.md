# Verifier Verdict - cand-final-90c4c39-01-mutable-root-arrays

Reviewed head SHA: `90c4c397d09d2dee2360b1aa9cc7a4f50db3cd9b`
Verdict: CONFIRMED

Evidence: `raw-data-sandbox.ts` clones only `fuseRules` then stores `{ ...options, fuseRules }`; `resolveRawDataSandboxRuntimeRoots()` resolves `this.options` at run time and maps the root arrays then. `policy-gate-registry.ts` forwards `protectedRawPaths`, `protectedEvidencePaths`, and `allowedWriteRoots` by reference. The profile allows `allowedWriteRoots` and denies only the resolved protected paths.

Note: No guard snapshots or freezes the caller-owned root arrays, so mutating the same array object before `run()` can move the protected root while leaving the original raw path under an allowed write root.
