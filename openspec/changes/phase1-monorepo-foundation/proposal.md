## Why

SHUD-Harness currently has canonical design documents and four source submodules, but no runnable Harness runtime. Phase 1 needs a minimal Bun/TypeScript monorepo foundation before schemas, APIs, UI, and tests can be implemented consistently.

## What Changes

- Add the root monorepo structure for Phase 1 implementation.
- Define package boundaries for shared core code, backend server code, and frontend web code.
- Add root package metadata, TypeScript configuration, and standard development scripts.
- Add a minimal test/build convention that later Phase 1 changes can extend.
- Keep the source submodules (`SHUD/`, `rSHUD/`, `AutoSHUD/`, `zero/`) read-only and separate from Harness runtime code.

## Capabilities

### New Capabilities

- `monorepo-foundation`: Establishes the Phase 1 Bun/TypeScript workspace, package boundaries, and baseline developer commands.

### Modified Capabilities

None.

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/Phased_Spec_Activation.md` | Normative Phase 1 scope: monorepo, Zod schema, workspace directory, CRUD API, and four-panel shell. | Only Phase 1 skeleton scope is active; Phase 2 execution-loop content is out of scope. |
| `docs/04_IMPLEMENTATION/Phased_Plan.md` | Implementation backlog source for former Week 1 tasks. | Used as task inventory, not as a calendar gate. |
| `docs/04_IMPLEMENTATION/Repository_Layout.md` | Normative package-boundary reference for the TypeScript monorepo. | Implement only Phase 1 packages and entrypoints; future runner/agent packages can remain placeholders or absent. |
| `docs/SPEC_v0.8_Final.md` | High-level implementation baseline and runtime assumptions. | Field-level schema details defer to canonical schema docs, not this summary spec. |

## Impact

- Affected paths: `package.json`, `bunfig.toml`, `tsconfig*.json`, `packages/`, `apps/`, `tests/`.
- Enables later changes for schemas, API, workspace persistence, frontend shell, and quality gates.
- Does not modify SHUD, rSHUD, AutoSHUD, or Zero submodules.
