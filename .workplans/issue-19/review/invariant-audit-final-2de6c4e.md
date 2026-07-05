# Phase 6.2 Invariant Audit — PR #48 final follow-up 2de6c4e

Base reviewed SHA: `2de6c4e6f6aa1048fc232eacb21d1f42b9b88190`
Scope: issue #19 raw-data write authority, advisory telemetry, and WS evidence provenance.

## Invariant 1 — Byte Authority

Statement:
- Raw-data write prevention is enforced by the OS seatbelt profile, not by shell/static advisory parsing.
- Any path with write authority must be checked against protected raw/evidence leaf, subpath, and ancestor movement risks.

Owner surfaces:
- `buildRawDataSeatbeltProfile`
- `protectedPathAncestorLiterals`
- `RawDataSandboxedBashTool.run`
- SHUD runtime registry wrapper tests

Audit result:
- Pass after fix.
- `tempRoot` is canonicalized outside protected raw/evidence deny paths, then added to `writeAllowRoots`.
- Protected raw/evidence ancestor literal deny lists are computed from `writeAllowRoots`, so a broad temp root such as `/tmp` cannot authorize project-root ancestor moves.
- Profile metadata and profile hash include the resulting ancestor deny sets.

Regression coverage:
- Broad `allowedWriteRoots=[root]` raw ancestor move remains denied.
- Broad `tempRoot=/tmp` with scoped `allowedWriteRoots=[workspace]` raw ancestor move is denied.
- Legal raw reads and workspace writes remain allowed.

## Invariant 2 — Advisory Scope

Statement:
- Static pre-exec checks are advisory and may deny obvious writes, but uncertainty must not replace OS authority.
- Suppressed, masked, dynamic, and over-budget writes must be byte-blocked by seatbelt without overclaiming advisory telemetry.

Owner surfaces:
- `evaluateRawDataWriteAdvisory`
- `evaluateProcessContainmentPreflight`
- `runSeatbeltSandboxedBash`
- audit append helpers

Audit result:
- Pass.
- Existing tests keep advisory denial narrow and preserve generic lifecycle failures when seatbelt blocks a hidden write without trusted advisory denial evidence.
- Legitimately waited foreground subprocesses remain allowed; unwaited background process-creation risk remains preflighted.

## Invariant 3 — Telemetry Provenance

Statement:
- Reserved raw-data denial `tool.failed` telemetry can only be emitted from sandbox-owned trusted advisory evidence tied to the actual `ToolResult`.
- Callers cannot fabricate, clone, replay across results, or mutate trusted WS evidence.

Owner surfaces:
- `trustRawDataDenialEvidence`
- `rawDataDeniedToolResultToToolFailedEventInput`
- `assertTrustedRawDataToolFailedEventInput`
- `buildRawDataAdvisoryToolFailedWsEvent`
- `buildToolFailedWsEvent`

Audit result:
- Pass after fix.
- Trusted event input is stored as a frozen defensive snapshot.
- Public helper returns a defensive copy and attaches a field-bound proof to that copy.
- Backend advisory WS builder derives input from the provided `ToolResult` and revalidates the proof immediately before emission.
- Mutating a helper-returned copy does not mutate stored sandbox evidence and does not alter emitted WS payload.
- Public generic builder still rejects reserved raw-denial shaped payloads.

Regression coverage:
- Structural caller-authored raw-denial payloads are rejected.
- Cloned trusted inputs and result-shaped clones are rejected.
- Mutated helper-returned input emits the original sandbox-owned evidence.
- Generic non-reserved lifecycle failures still emit normally.

## Residual Accepted Boundary

- Pre-existing hardlink residuals remain outside static/sandbox repair scope; bounded `nlink > 1` scan and DataProvenance checksum follow-up remain the accepted guardrail per ADR-0001 revisit.
- Zero submodule remains read-only and pinned at `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.

Decision:
- Invariant closure is ready for the next six-reviewer comprehensive follow-up on the post-fix commit.
