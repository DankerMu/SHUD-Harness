Invariant audit: clean

Invariant Surface Inventory coverage:
- Shared helper roots: clean
- Public entrypoints: clean
- Read surfaces: clean
- Write/delete/overwrite surfaces: clean
- Producer/consumer evidence boundaries: clean
- Unchanged downstream consumers: clean

Surfaces inspected:
- `packages/core/src/tools/data-raw-write-rule.ts`: clean
- `packages/core/src/tools/data-raw-write-rule.test.ts`: clean
- `packages/core/src/tools/policy-gate-audit.ts`: clean
- `packages/core/src/tools/policy-gate-registry.ts`: clean
- `packages/backend/src/ws/policy-gate-events.test.ts`: clean
- `packages/backend/src/ws/policy-gate-events.ts`: clean
- `openspec/changes/m1-foundation/design.md` / `specs/policy-gate-spike/spec.md`: clean for the stated M1 detector scope; full shell parser remains explicit non-goal

Remaining findings:
- None.
