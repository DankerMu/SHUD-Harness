Verifier verdict for: cand-4717-01
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a
Verdict: CONFIRMED
Evidence: `spec.md:29-32` requires symlink alias raw writes to return remediation failure + `tool.failed` audit. `raw-data-sandbox.ts:423-438` only maps sandbox denial when `isLikelySandboxDenialForCommand` is true; `3784-3808` requires a known raw target, but `3816-3820`, `1964-1975`, and `2122-2131` only recognize lexical/static targets, not a workspace symlink destination. With `|| true`, `1248-1260` marks exit 0 as success, then `453-455` records `tool.completed` / `allowed`.
Note: The protected raw subpath is denied by the seatbelt profile at `217-220`, but this symlink-hidden path can bypass denial classification.
