# Proposal

## Why

Issue #493 records a raw-guard bypass on a case-insensitive filesystem when configured `RUNS` is absent and `shud_run` will create `runs`. Native realpath resolves existing components but the current fallback compares missing suffixes literally; the same defect applies to fixed `stacks` and `provenance` roots.

## What Changes

- Keep missing-path filesystem identity in the single raw-guard path owner, preserving native resolution of existing symlinks and parent traversal.
- Recognize confirmed case aliases for absent components without globally lowercasing paths or assuming sensitivity from the OS name.
- Verify insensitive and sensitive native volumes, the three fixed outputs, existing aliases, component boundaries, and shared canonical consumers without changing their individual writer/approval policies.
- Apply PI comment 6544516557: deny plausible case-alias overlaps when read-only evidence is inconclusive, including empty sensitive directories; confirmed sensitive distinct paths still pass.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `raw-data-guard`: absent-path case identity and fixed-output protection.

## Impact

Raw-guard path comparison, focused public-decision/seam tests, and its specification. No jobs/tools/records writer, shared core containment, schema, host, solver, dependencies, or PI acceptance changes.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because shared path safety and raw immutability are Critical Path #2.
Blast radius: protected output aliases must not pass through; distinct case-sensitive paths must not be conflated.
Selected risk packs: public entry; file IO/path safety; auth/raw protection; fresh lookup ordering; bounded discovery/resource release; legacy compatibility; error handling; documentation.
Evidence floor: semantic RED→GREEN; native case-insensitive and case-sensitive controls; actual pre-execute denial with zero execute/approval; default check, strict OpenSpec, profile smoke, raw five probes, three-seat white-box review.
