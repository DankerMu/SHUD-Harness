# Review failure retro -- PR #48 observable 215d635

Head SHA: `215d635e8edc6c4e5db3af8b833cf377fdda02cc`

Trigger:
- Follow-up comprehensive review after `067e544` fix still found CONFIRMED evidence/audit false-positive paths on `215d635`.
- The repeated family is observable-denial attribution, not raw-byte authority. Seatbelt authority, process containment, legal read/write boundaries, and CI are green.

Root cause:
- The previous fix still tried to infer execution facts from process output plus syntactic command analysis. Shell/control-flow execution is not statically decidable here, and process output is user-controlled. Target names, basenames, and even path-shaped denial text can be forged or produced by unrelated failures.
- Outer raw-denial evidence composition repeated the same mistake by re-parsing command text against the inner sandbox roots after an outer evaluator had already denied a different root, without carrying matched-root identity.

Strategy change:
- Stop treating target-qualified text as proof that a raw mutation was attempted. Remove weak target/basename attribution paths that can be satisfied by user output.
- Keep raw-byte authority in seatbelt. For telemetry, prefer conservative generic `failed` over false `denied_by_sandbox` whenever attribution is ambiguous.
- Preserve positive telemetry only for low-forgery observable forms that the tests can prove without static control-flow inference. If a form cannot be distinguished from forged user output, it must be generic under M1.
- For outer raw advisory deny, stop upgrading custom evaluator `RAW_DATA_WRITE_RULE_ID` denies into raw-denial evidence unless the wrapper has a trusted same-root evaluator identity. In this PR, the safe route is generic `policy_gate_denied` for custom outer raw denies; matching-root raw-denial evidence can remain in the sandbox tool's own advisory path.

Next action:
- Fix by invariant: narrow sandbox-denial attribution and outer raw-denial composition, then add target-forged/same-basename/mismatched-root sibling regressions.
- Run the full local verification floor and another comprehensive six-reviewer round. Do not treat CI green alone as sufficient because Ubuntu skips seatbelt runtime cases.
