Reviewer agent: phase-7-final-gap-sweep
Reviewed head SHA: `bb40d927edff9ddd479500f5d36349144a2c29d5`
Summary: One P1 candidate gap: the map authorizes exact `memory` while the documented boundary says draft/proposal-only, but Zero's current `memory` tool can create verified memory and mutate/delete entries.

Coverage check:
- Issue acceptance criteria: covered - exact five roles, snapshot oracle, and invariant tests are present in `packages/core/src/tools/role-tool-map.test.ts:59`, `:63`, `:79`, `:84`, `:88`, `:93`, `:97`; script wiring is in `package.json:12` and `:15`.
- OpenSpec tasks/scenarios: missing - task 5.1's explicit role/snapshot/invariant scenarios are covered, but the OpenSpec permission boundary that `memory` is proposal-only/draft is not re-established for the exact `memory` id; see finding.
- Prior review findings: none - Phase 4.5 recorded zero candidate findings and no verifier needed in `.workplans/issue-24/review/phase-4-5-verdict-table.md:9`.

Findings:
- Severity: P1
  Failure class: contract
  Violated contract/invariant: The role->tool map is the canonical spawn `allowed_tools` subset baseline, and `memory` is documented as "draft/proposal-only" and not a write-class escalation path. `Roles_and_Boundaries` also says memory writes are proposal-only for all roles.
  Evidence: `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md:11`, `:15`, `:17`, `:18`, `:19`, `:44`; `docs/02_ARCHITECTURE/Roles_and_Boundaries.md:40`; `packages/core/src/tools/role-tool-map.ts:59`, `:73`, `:88`, `:95`; `packages/core/src/tools/role-tool-map.test.ts:105`; `zero/packages/core/src/tool/memory.ts:142`, `:143`, `:144`, `:179`, `:197`.
  Concrete scenario: When the next spawn-profile subset check uses this map, `isRoleToolIdSubset("reviewer", ["memory"])` is allowed by the current test. If the runtime registry exposes Zero's current `MemoryTool` under exact id `memory`, a reviewer/coordinator/worker child can call `memory.create` and get `status: "verified"` / `confidence: 0.85`, or call update/delete paths, despite the map note saying draft/proposal-only.
  Consequence: A read-only or governance-limited role can be granted a verified-memory mutation surface through an allowlist that is supposed to be the capability boundary. That bypasses PI-gated memory promotion semantics and turns explanatory `permissionNotes` into unenforced safety claims.
  Fix direction: Do not authorize raw Zero `memory` as the canonical role tool unless the registered `memory` id is replaced/wrapped by a SHUD proposal-only adapter. Either use a distinct exact id for draft proposals, or keep `memory` out of role toolIds until an adapter denies verified create, status escalation, and delete/update operations outside the approved proposal path.
  Required verification: Add a focused runtime proof around the actual registered `memory` id used with the role map: create under reviewer/coordinator yields draft/proposal only, status escalation/update/delete is denied or stripped, and the spawn subset check cannot grant raw Zero `MemoryTool` behavior to non-PI agent roles.
  Sibling surfaces: Future task 3.4 spawn subset enforcement, task 5.2 registry lint, M4 memory governance, Zero adapter registry assembly, all roles currently listing `memory`.
  Blocking status: Blocking candidate; should be fixed or explicitly proven safe before this canonical map becomes the downstream allowed-tools baseline.

Non-blocking notes:
- None.
