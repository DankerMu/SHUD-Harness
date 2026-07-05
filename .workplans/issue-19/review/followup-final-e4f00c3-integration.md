# Follow-up Comprehensive Review - integration/API at e4f00c3

Reviewer agent: review-integration
Review round: final comprehensive follow-up after da20028 boundary/runtime fixes
Reviewed head SHA: `e4f00c39aebc0fa6bfbc609a973ec9ff3d8c5c6a`

Summary: One duplicate terminal-state gap plus two P2 immutability/snapshot candidates.

Invariant Matrix Coverage:
- Raw byte authority and advisory split: covered.
- Public root/subpath API boundary: covered; package exports only root and wildcard alias is absent.
- Fuse-list source identity and downstream registry construction: missing object snapshot for inline `fuseRules`.
- Backend WS `tool.failed` evidence compatibility: missing snapshot for generic `ErrorRecord`.
- Process timeout/abort caller contract: covered, except duplicate stale raw-root finalization gap.

Findings:
- P1 `process lifecycle / terminal-state contract`: duplicate stale/deleted `protectedRawPaths` pre-finalize gap at `packages/core/src/tools/raw-data-sandbox.ts:552`.
- P2 `telemetry/evidence mutable aliasing`: generic `buildToolFailedWsEventUnchecked()` embeds caller-owned `ErrorRecord` by reference, so queued events can drift if caller mutates nested fields before send. Required proof: mutate input error/remediation/arrays after build and assert payload is unchanged.
- P2 `mutable config / wrapper faithfulness`: inline `fuseRules` are copied as an array but rule objects are shared; caller mutation after construction can change enforcement. Required proof: mutate original rule object after tool construction and assert original pattern still blocks.

Non-blocking notes:
- Reviewer typecheck/diff/zero checks passed; Bun unavailable in reviewer environment.
