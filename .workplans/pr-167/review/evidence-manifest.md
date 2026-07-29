# PR #167 evidence manifest

Current implementation commit: `6b474b4f78295cab8df59a785913955729943640`
Current contracts tree: `db1a3a878b1fcef37e0fc90e08e07637adda7e5d`
Evidence carrier: the pushed HEAD containing this manifest; it changes no contracts-tree bytes
Base SHA: `f8b74e724dc978acb889f715a936feabfd69680d`
Issue: #164
Fixture: expanded; repair intensity high
Review state: Phase 6.2 at `5fb069a` not clean; two verified P1 closures implemented; final Phase 6.2 re-audit pending before Round 5

## Current retained scope

- strict bounded source-record and four-SHA source-identity ingress;
- canonical JSON and exact 152-byte three-entry synthetic source oracle;
- fixed manifest plus three mandatory oracle-file reads through stable,
  no-symlink ancestor/final descriptors;
- pure no-write validation of the currently committed oracle files.

Live Git configuration, index/tracked-set, filesystem generation, executable
mode, object-format, and live-manifest exact-equality authority were removed from
this PR and routed to #166. Aggregate collection-wide traversal/read budgets
remain #162 scope; this PR retains bounded per-file reads only. Network security
is excluded.

Exact depth/item payloads pass their respective limit guard and reach schema
validation, where they may return `CONTRACT_SCHEMA_INVALID`; their `+1` forms
must fail the limit. The exact byte-boundary fixture remains schema-valid and
succeeds. This preserves the previously approved node/item option 1.

## Definitive local evidence

- Final retained-slice mutation replay: 14 pass / 14 expected fail / 138
  assertions / exit 1; patch reversal restored the complete contracts tree;
  green replay: 28 pass / 0 fail / 203 assertions. See
  `red-proof-final-retained-slice.md`.
- Focused contracts: 28 pass / 0 fail / 203 assertions.
- Three frozen public commands: exact success receipts.
- Strict OpenSpec validation: valid.
- Full repository check: exit 0.
- Approved fixed-base scope, production/package/workflow/submodule, no-write,
  debug-marker, and diff hygiene: clean.

Earlier live Git/index/filesystem red proofs and clean audits are retained as
history but explicitly superseded; they do not support current PR claims.

## Review history and gate

- Round 1: not clean; node/item option 1 approved and recorded.
- Round 2: not clean; Git index compatibility defects were repaired.
- Round 3: not clean; depth retro registered and comprehensive retry used.
- Phase 6.2 at `3c01193`: superseded by Round 4.
- Round 4 at `64f5483`: six verified CONFIRMED/FIX_NOW findings across
  data-integrity, contract, and test-evidence.
- `review-failure-retro-round-4.md`: breadth failure registered; user approved
  the ownership split above. Gate is unlocked for one final comprehensive Round
  5. If Round 5 is not clean, the retry ceiling is reached and no ordinary
  repair round may continue.
- Phase 6.2 at `5fb069a`: two P1 findings verified CONFIRMED/FIX_NOW. Descriptor-
  bound ingress closure is `6b474b4`; stale/tree-binding evidence is refreshed
  in this carrier. Final retained-slice Phase 6.2 re-audit is pending.

Reviewer lens mix: correctness, integration, resource/path/performance,
test/evidence, spec compliance, invariant/state/compatibility.
