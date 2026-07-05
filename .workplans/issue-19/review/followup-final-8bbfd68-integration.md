Reviewer agent: review-integration
Review round: final comprehensive follow-up after fixes
Reviewed head SHA: 8bbfd68eb474e9d27386fe13a05fb1b549bb5198

Summary: No integration findings found; implementation, tests, and OpenSpec/docs are aligned with the narrowed seatbelt byte-authority boundary and trusted-only raw-denial telemetry model.

Invariant Matrix Coverage:
- Governing invariant: covered - `RawDataSandboxedBashTool` routes bash execution through a macOS seatbelt profile that permits raw reads but denies writes to protected raw-data roots, with tests covering visible writes, suppressed writes, symlinks, helper interpreters, child processes, and raw-read/workspace-write positives.
- Byte authority vs telemetry authority: covered - execution-time protection is owned by `sandbox-exec`; post-exec stdout/stderr/exit evidence remains generic lifecycle evidence, while raw-denial telemetry is limited to sandbox-owned advisory/static same-root evidence.
- Static preflight fail-open behavior: covered - advisory detection only blocks concrete same-root raw writes and tests verify dynamic/uncertain cases do not become authoritative raw-denial telemetry.
- Trusted raw advisory provenance: covered - WS raw-denial conversion requires private symbol proof, field-bound hash, and WeakMap binding to the actual `ToolResult`; structural caller-authored payloads are rejected.
- Public audit append boundary: covered - public append rejects raw-denial rows and reserved raw-denial `error_id` prefixes while allowing generic lifecycle `failed` rows.
- Generic backend `tool.failed` boundary: covered - generic WS builder rejects raw-denial-shaped decisions and reserved raw-denial error IDs, while allowing `rule=raw-data-write` with generic `failed`.
- Policy gate registry integration: covered - SHUD runtime registry replaces `bash` with the sandboxed wrapper, rebuilds `spawn_agent` against the final registry, unwraps stale policy wrappers, and fails closed on outer raw-rule misuse without emitting raw-denial evidence.
- Profile/audit root identity binding: covered - relative `profileRoot` is rejected, absolute roots are canonicalized, profile cleanup validates identity, and tests cover audit path symlink/hardlink/non-writable failure paths.
- Process/subprocess inheritance and escape classes: covered - tests exercise shell, redirection, symlink, interpreter helper, process, and detached/background classes; legal waited foreground children remain compatible.
- Hardlink residual handling: covered - residual hardlink risk is not claimed as byte authority, and the bounded scanner is covered for protected roots without widening enforcement claims.
- Legacy raw-read compatibility: covered - tests demonstrate raw reads and copying raw bytes into allowed workspace paths still succeed.
- Wrapper/proxy faithfulness to Zero: covered - Zero source diff is clean at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`; wrapper changes are localized to SHUD runtime composition and sandbox execution.
- Evidence lineage and schema shape: covered - audit, tool result, and WS event shapes bind to one trusted identity path and reject sibling-path or caller-forged raw-denial evidence.
- Documentation/OpenSpec alignment: covered - design, spec, ADR, phased plan, and activation notes reflect the narrowed 2026-07-05 boundary.
- Full production audit ingestion/UI consumers: out-of-scope - current M1 fixture validates producer and WS payload behavior; broader persistence/UI integration remains outside this changed surface.

Findings:
- None.

Non-blocking notes:
- None.

Execution Summary: agents=review-integration; skills=review; tools=git/rg/sed/nl; verification=independently checked head SHA, changed-file context, Zero diff cleanliness, whitespace diff checks, implementation/test/doc alignment; limits=read-only review, no edits, no commits, no PR comments, no subagents, full `pnpm`/OpenSpec verification not rerun locally in this review round.
