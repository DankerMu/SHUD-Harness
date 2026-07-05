# Gate-Level PR Strategy Review — PR #48 final track at 2de6c4e

Current head SHA: `2de6c4e6f6aa1048fc232eacb21d1f42b9b88190`
Comprehensive review rounds counted: post-gate final track continuing after prior five-round gate package.

Round summaries:
- 8bbfd68 final follow-up: two confirmed findings - raw ancestor rename under broad `allowedWriteRoots`; trusted WS input clone/replay.
- 2de6c4e final follow-up: two confirmed sibling findings - tempRoot write-authority root not included in ancestor denies; trusted WS evidence mutable after proofing.

Repeated or moving failure classes:
- `path-safety`: moved from protected raw leaf/subpath to allowed-root ancestors, then to `tempRoot` as another write-authorized root.
- `contract` / evidence provenance: moved from public structural raw-denial builders to clone/replay, then to mutable trusted evidence returned by helper.

Direction check:
- The PR is still solving the correct #19 problem. The raw-byte authority direction is right: seatbelt enforces bytes; advisory and WS telemetry are narrower observability.

Architecture/refactor check:
- The current implementation shape is acceptable, but fixes must be invariant-level:
  - Seatbelt profile generation must derive deny literals from the complete set of write-authorized roots, not just caller-supplied allowed roots.
  - Trusted WS evidence must be an immutable snapshot/capability, not a mutable structural object shared across public helper and backend builder.

Loop check:
- Findings are moving between sibling surfaces because prior fixes closed cited line items without fully inventorying the invariant owners. The next fix must close helper-level surfaces, not add another command-specific test only.

Functionality root-cause check:
- Raw read/workspace write compatibility remains intact. The missing functionality is complete coverage for all write-authorized roots and immutable telemetry evidence.

Security/safety root-cause check:
- The byte authority invariant is almost closed but must include `tempRoot`. The evidence provenance invariant is not closed until callers cannot mutate stored trusted evidence before emission.

Decision:
- Continue with one more invariant closure, not PR split and not scope deferral. Both findings are within issue #19 / OpenSpec 条 2' acceptance boundary.

Execution plan:
- Implementer fix:
  - Compute protected raw/evidence ancestor literal deny paths against `sortedUnique([tempRoot, ...allowedWriteRoots])` or reject unsafe broad temp roots.
  - Make trusted raw advisory event input immutable/copy-on-read/proof-checked before WS emission.
  - Add direct tests for broad `tempRoot` raw ancestor move and mutable trusted input/nested error mutation.
- Verification:
  - Focused policy/raw/backend WS suite.
  - Full check, OpenSpec validate, diff checks, zero diff/head.
- Review:
  - Phase 6.2 invariant audit, then six-reviewer comprehensive follow-up on the next head.

Invariant Surface Inventory:
- Shared helper roots: `buildRawDataSeatbeltProfile`, `protectedPathAncestorLiterals`, `rawDataDeniedToolResultToToolFailedEventInput`, `assertTrustedRawDataToolFailedEventInput`.
- Public entrypoints: `RawDataSandboxedBashTool.run`, `createShudRuntimeToolRegistry`, `buildRawDataAdvisoryToolFailedWsEvent`, public core raw-data helper exports.
- Read surfaces: raw reads; trusted helper read of `ToolResult` evidence.
- Write/delete/overwrite surfaces: all write-authorized roots (`tempRoot` plus `allowedWriteRoots`), raw/evidence leaf/subpath/ancestor denies, audit append.
- Producer/consumer evidence boundaries: sandbox-owned advisory evidence -> immutable trusted snapshot/capability -> backend `tool.failed`.
- Stale-state/idempotency boundaries: moved raw ancestors; mutated trusted evidence after proofing.
- Unchanged downstream consumers: generic lifecycle WS builder, raw reads/workspace writes, hardlink residual scan, Zero registry wrapper.

Regression Matrix:
- Protected raw under broad `tempRoot`, scoped `allowedWriteRoots=[workspace]`, command moves `data` ancestor -> denied; original raw path and bytes intact.
- Protected raw under broad `allowedWriteRoots=[root]` -> denied; existing regression remains green.
- Trusted `ToolResult` evidence retrieved through public helper, then top-level/nested fields mutated -> WS builder rejects or emits original immutable evidence.
- Structural/cloned trusted input/result-shaped clone -> still rejected.
- Generic lifecycle `tool.failed` and legal raw read/workspace writes -> still allowed.

Post-gate budget:
- After this invariant closure, run one comprehensive six-reviewer follow-up.
- If the same invariant family appears again as a critical/major sibling finding, re-enter this strategy review and choose a stronger corrective action: refactor the profile/evidence helpers into explicit immutable value objects or split the PR if scope cannot be closed in one coherent slice.
