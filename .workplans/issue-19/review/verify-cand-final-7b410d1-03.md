# Finding Verification: cand-7b410d1-03-public-raw-advisory-constructor-provenance

Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc
Verdict: CONFIRMED

Evidence: Public package barrels re-export raw-denial payload construction and WS input conversion. Backend raw advisory builder checked only `rule === raw-data-write` and `decision === denied_by_advisory`, allowing public callers to construct and emit advisory events outside the sandbox-owned reservation path.

Note: Fixture requires raw-denial telemetry only from the sandbox tool inner advisory/static layer.
