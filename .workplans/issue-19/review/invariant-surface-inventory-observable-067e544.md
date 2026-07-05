# Invariant surface inventory -- PR #48 observable 067e544

Head SHA: `067e544368f88ec60922a243f1bcf6597f211489`

Trigger:
- Follow-up comprehensive review on `067e544` found four CONFIRMED candidates in the same high-risk family: observable raw-denial evidence classification and audit/profile identity.
- This is an invariant miss, not four isolated defects.

Governing invariant:
- Raw byte authority stays in the OS sandbox profile. Telemetry is narrower: emit `raw_data_write_denied` / `decision=denied_by_sandbox` only when a visible process result can be attributed to an attempted raw mutation protected by the sandbox. Do not claim hidden/suppressed or user-forged denial text as observed sandbox denial.
- Advisory denies that bypass execution must emit evidence whose rule/profile identity corresponds to the protected root set that caused the deny, or else avoid emitting an unrelated sandbox `profile_id`.

Surface inventory:
- Producers: `RawDataSandboxedBashTool.run`, `PolicyGatedToolAdapter.run`, `denyByOuterRawPolicyGate`.
- Static analyzers: `analyzeRawDataCommand`, `hasStaticRawDataWrite`, `hasKnownRawDataWriteTarget`, `hasDynamicRawDataWriteRisk`.
- Post-exec observable classifier: `isLikelySandboxDenialForCommand`, `isLikelySandboxDenial`, `INTERPRETER_WRITE_DENIAL_PATTERN`, symlink alias resolver.
- Symlink/path alias target collectors: `collectLiteralWriteTargetCandidates`, `resolveLiteralTargetPaths`, `resolvePathFollowingSymlinks`, `isRawDataPathToken`.
- Evidence builders: `buildRawDataDenialEvidence`, `buildRawDataDeniedPayload`, `rawDataDenialPayloadToAuditRow`, `rawDataDenialPayloadToToolFailedEventInput`.
- Registry/evaluator: `createShudRuntimeToolRegistry`, `createRawDataWriteAdvisoryRule`, `wrapToolWithPolicyGate`.
- Downstream consumers: backend `tool.failed` builder and tests, audit row readers, registry tests.
- Negative boundaries: legal raw reads, workspace writes, waited foreground child processes, hidden/suppressed denials, user-controlled output containing `Permission denied` or `sandbox`, over-budget unrelated output.

Required closure:
- Create one shared runtime-attribution gate for post-exec sandbox-denial classification. It must distinguish visible target-attributed OS denial from syntactic raw target plus unrelated text.
- Extend symlink alias target collection to the same mutation classes covered by static raw mutation detection, with command-specific care for operations that only remove a workspace symlink leaf and do not touch raw bytes.
- Preserve visible actual denials even when the command is exit-normalized or command text exceeds full-analysis budget, using bounded prefix/target evidence and target-attributed output.
- Ensure advisory-deny evidence profile identity cannot describe an unrelated sandbox profile when the outer raw rule root differs from sandbox protected roots.
- Add regression tests for each positive and negative edge before another comprehensive review.
