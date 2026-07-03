Project profile: SHUD-Harness

Living artifact maintained by `subagent-workflow` Phase 0.0/0.5.

Entry surfaces:
- `packages/core|backend|frontend` TypeScript packages and `scripts/` deterministic tooling.
- `openspec/changes/*`, `docs/04_IMPLEMENTATION/*`, `docs/03_SPEC/*` contract sources.
- Runtime workspace layout under `workspace/` / `shud-workspace/`, with task snapshots, readiness notes, artifacts, and audit trails.
- Read-only submodules: `SHUD/`, `rSHUD/`, `AutoSHUD/`, `zero/`.

Contracts:
- OpenSpec change fixtures, issue acceptance criteria, ADR-0001/0002, and Phased_Plan milestone gates.
- Zod schemas, API envelope/idempotency contracts, workspace path conventions, artifact registry, and readiness YAML shape.
- Zero reuse boundary: root submodule pinned to 13e25c1 with `zero/` source diff kept at 0 unless an ADR revisits it.

Risk axes:
- Path/workspace containment, symlink escape, generated runtime assets accidentally entering git.
- Schema/API/error/idempotency drift across frozen docs, generated artifacts, implementation, and issue projections.
- Evidence chain correctness: readiness, audit, review, CI, PR, and issue closure must bind to the exact checked state.
- Scientific governance boundaries: agent cannot make scientific claims; high-risk model/parameter/output changes require PI gate.

Typical evidence:
- `openspec validate <change> --strict --no-interactive`; targeted docs/spec contract reads; `git diff --check`.
- Focused unit/integration tests for touched package/script; shell dry-runs for deterministic scripts.
- Git/submodule status, generated YAML/JSON schema validation, PR CI, and issue/PR evidence links.

Domain risk packs:
- Scientific governance / PI gate / evidence lineage.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility.
- Zero adapter / tool registry / agent role governance.

Domain expanded-triggers:
- `readiness`, `workspace`, `artifact`, `snapshot`, `idempotency`, `lock`, `remediation`, `guard_class`.
- `SHUD`, `rSHUD`, `AutoSHUD`, `Zero`, `ToolBase`, `beforeExecute`, `provider`, `GLM`.
