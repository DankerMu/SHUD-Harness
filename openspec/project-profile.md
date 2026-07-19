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

Command entry points:
- Install/runtime: `bun@1.2.19`; locked invocation `npx --yes bun@1.2.19` when Bun is not on `PATH`.
- Default local/CI check: `npx --yes bun@1.2.19 run check`; types: `... run typecheck`.
- Core/backend: `... run test:core-services`; `... run test:backend-api`; focused `... test <files> [-t <pattern>]`.
- Schemas/perf/docs: `... run schema:check`; `... run test:perf:api`; `scripts/docs/self_test.sh && scripts/docs/check_links.sh`.
- Fixture/hygiene: `npx --yes openspec validate <change> --strict --no-interactive`; `git diff --check`; stash/worktree/submodule checks.

Verification matrix:
- Core service/helper/state/error contract -> focused touched tests + `run test:core-services` + `run typecheck` -> named pass/fail/skip counts and regression rows.
- Backend route/HTTP/WebSocket contract -> focused route tests + `run test:backend-api` (+ `run test:backend-ws` when WS touched) -> exact status/body/event assertions.
- Frontend/schema/tool/policy surface -> matching package script + default `run check` -> zero failures and generated-drift status.
- OpenSpec/evidence/review fixture -> strict validation + evidence linter + SHA/hash binding -> valid fixture and frozen-head evidence.
- Workspace/path/idempotency/lock/release surface -> focused failure/boundary tests + full core/backend rows + resource-diagnostic baselines -> stable authority, cleanup, replay, and error identity.
- Dependency/submodule/CI surface -> lock/schema/perf commands as touched + submodule/tracked-workspace diff -> zero unintended drift and required CI success.

Domain risk packs:
- Scientific governance / PI gate / evidence lineage.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility.
- Zero adapter / tool registry / agent role governance.

Domain expanded-triggers:
- `readiness`, `workspace`, `artifact`, `snapshot`, `idempotency`, `lock`, `remediation`, `guard_class`.
- `SHUD`, `rSHUD`, `AutoSHUD`, `Zero`, `ToolBase`, `beforeExecute`, `provider`, `GLM`.
