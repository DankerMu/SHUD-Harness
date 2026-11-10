---
status: proposed
kind: architecture
---

# ADR-0016: Role-surface deny takes precedence over the raw provenance ask

## Context

[#713](https://github.com/DankerMu/SHUD-Harness/issues/713) found that an off-role call carrying a raw `input_dir` reaches the PI as a provenance card ("reading raw data requires PI approval") before the role check runs. Examples are worker/coder/reviewer → `analysis_create` and coordinator → `shud_run`. The cause is the `tools/pre-execute` waterfall order fixed by `profile/shud/cordis.patch.yml` and [Runtime Lifecycle](../../04_IMPLEMENTATION/Runtime_Lifecycle.md): `shud-raw-guard` sits immediately before `shud-policy-gate`. raw-guard resolves `ask` without calling `next()`, so policy-gate's `role-tool-surface` deny never runs.

[PR #732](https://github.com/DankerMu/SHUD-Harness/pull/732) (option A, PI decision 2026-11-09) pinned the current behavior in `packages/dsh-shud-policy-gate/src/offrole-raw-ask.test.ts` and recorded it as a known exception in the policy-gate spec. The pinned behavior:

- one provenance ask, with no `role-tool-surface` audit line;
- `allowed-once` → `UNKNOWN_TOOL` (role-restrict hides the tool);
- the tool body never runs and raw bytes are unchanged.

No raw data is exposed, but the PI receives a card that cannot authorize anything, and the session log does not show that the call was a role violation.

The PI also decided that option B follows A, as this record. B touches Critical Paths #1 (policy gate), #2 (raw protection) and #3 (approval seam). It must be accepted by the PI before any implementation.

## Decision (proposed)

raw-guard consults the role surface before it returns `ask`. Its `deny` decisions are unchanged and stay first.

1. raw-guard computes its decision as today. If the decision is `deny` (raw write, raw ancestor write, governance root write), raw-guard returns it unchanged. No role or preset input is consulted, so a raw write is denied before anything else for every role.
2. If the decision is `ask`, raw-guard resolves the caller role the same way policy-gate does: `presetIdToRole(readCallerPresetId(execution.agent))` from `@shud-harness/dsh-shud-core`. It then checks the tool against the same `ROLE_TOOL_MAP` entry, `inherited ∪ local`, through the existing core helper `isRoleToolIdAllowed`.
   - If the role is known and the tool is outside its surface, raw-guard calls `next()` instead of asking. policy-gate then returns `deny` with `role-tool-surface` and the PI receives no card.
   - If the role is `unknown` (for example a headless profile with presets disabled), or the tool is inside the surface, raw-guard returns the provenance `ask` exactly as today.
3. raw-guard logs the deferral as `next <tool> role-deferred`, without path or arguments, so the audit trail shows that raw-guard saw raw input and handed the call to the role check. policy-gate's existing `deny <tool> role-tool-surface` line follows.
4. Listener order, the profile patch and the "raw-guard immediately before policy-gate" wording stay unchanged. No listener is added and no dsh seam changes.

## Alternatives considered

- **Keep option A only.** Zero risk, but the misleading card and the missing role-deny audit line remain permanently.
- **Move policy-gate (or only its role rule) before raw-guard.** Rejected. An off-role raw write would then be reported as a role deny rather than `raw-immutable`, and the invariant that raw deny comes first would have to be re-argued for every future rule placed ahead of it.
- **Have policy-gate re-check after an approved ask.** Not possible through documented seams: a resolved `ask` ends the waterfall before policy-gate runs.

## Consequences

- **Tests.** `offrole-raw-ask.test.ts` flips its off-role expectations: zero approval requests, `deny role-tool-surface`, and the `role-deferred` line. Its on-role controls and the raw-write deny cases must stay unchanged. A new case must show that an off-role raw *write* is still denied by raw-guard with `raw-immutable` and no role consultation.
- **Specs.** The policy-gate known-exception scenario is removed. "off-role analysis_create is denied" holds for raw input too. The raw-data-guard "Decision audit" requirement gains the `next … role-deferred` line.
- **Dependency.** raw-guard already depends on `@shud-harness/dsh-shud-core`; it starts importing the role helpers policy-gate uses (`readCallerPresetId`, `presetIdToRole`, `isRoleToolIdAllowed`). It is the same source of truth, not a copy, and no package dependency is added.
- **Raw-guard probes.** `pnpm run raw-guard:probes` (T1–T5) run in the headless `shud-probe` profile. If their caller role resolves to `unknown`, they are unaffected; if it resolves to a known role whose surface lacks `bash`, T2/T3 would change from ask to deny. Implementation must establish which, through a probe run, before merge.
- **Review.** Implementation requires a white-box reviewer record and `pnpm run check`, `profile:smoke` and `raw-guard:probes` evidence (Critical Paths #1/#2/#3).

## Open questions for the PI

1. Accept the deferral design above, or keep option A as the final state?
2. Is `next <tool> role-deferred` the right audit wording, or should raw-guard log nothing on deferral?
