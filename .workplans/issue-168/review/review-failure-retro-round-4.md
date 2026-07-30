# Review Failure Retro

PR: #170, retro trigger head SHA: `cc89c89da7af3d68e0004766b495e5e72988036e`

Failure classes: test-evidence, task-boundary

Rounds affected:

- Round 1 at `89eb2aad7895d837617d243a8ce82e3cdc45b211`
- Round 2 at `f49ac2704619bafa31504691daee2a2360ce3452`
- Round 3 at `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`
- Round 4 at `cc89c89da7af3d68e0004766b495e5e72988036e`

Failure shape: depth

Invariant: after admission, active evidence must reject every production-reachable
ambient filesystem/process authority route independently of module-loader syntax,
API name, and PathLike representation; the source structure must make every
uninterposed loader or authority introduction fail closed.

Recurring findings:
- Round 1 proved that implementation-selected observer events were not independent authority evidence.
- Round 2 proved that test-owned wrappers did not interpose normal production imports.
- Round 3 proved that ordinary module mocks omitted PathLike and promise/property alias surfaces.
- Round 4 proved that computed builtin loaders and unenumerated APIs bypassed both module mocks and regex source checks.

Split rebuttal:
- Issue #168 declares retained descriptor-capability ingress plus its independent no-ambient-authority proof as one minimal mergeable slice; splitting implementation from proof leaves each child unmergeable.
- The omitted `capabilities.ts` owner is the documentation boundary for that same shared authority module, not an independent functional surface that can safely merge before or after a knowingly false fixture.
- A child split would inherit the identical loader/API invariant and reset the round counter without isolating a root cause, which the gate explicitly forbids for depth failures.

Why Phase 5/6 did not close it:

- Fixture scope gap: yes — it did not require a structural loader/global allowlist or interception of the cached builtin object.
- Fix prompt too narrow: yes — module mocks and increasingly exact regex checks remained the primary boundary.
- Reviewer finding contract vague/inconsistent: no — each round supplied a compiling bypass and stable consequence.
- Missing regression evidence: yes — prior mutation matrices enumerated known loaders/APIs rather than proving loader/API-name independence.
- Cause never diagnosed (no red repro before fixes): no — the new diagnosis is that JavaScript module mocks cannot alone own the builtin authority boundary.
- PR too broad / should split: no — the recurring invariant is shared by every proposed child.

Next corrective action:

- Refactor/redesign the test boundary to patch the actual cached builtin FS and
  promise objects used by `process.getBuiltinModule`, `import.meta.require`, and
  `createRequire`, applying one generic post-admission guard to every exported
  function that receives any string/Buffer/file-URL PathLike; descriptor-only
  operations remain available to the retained capability path.
- Replace regex authority discovery with a TypeScript-AST structural allowlist:
  exact production import declarations, no dynamic import/require/createRequire/
  getBuiltinModule/process.binding/eval/Function/global-object escape, and exact
  per-file `process`/`Bun` property use.
- Add a compiling Darwin/Linux mutation matrix spanning all three computed
  loaders, computed specifiers, unenumerated read/open/write/stream APIs, relative
  and absolute PathLike forms. Each route must be stopped before read/write and
  the structural gate must independently reject the source mutation.
- Add `lib/capabilities.ts` to the #168.A explicit OpenSpec owner list and align
  the boundary evidence. This is the final ordinary corrective action before the
  five-round terminal ceiling.
