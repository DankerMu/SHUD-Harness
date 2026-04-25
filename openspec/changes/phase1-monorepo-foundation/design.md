## Context

The repository is currently documentation-first: root-level submodules provide SHUD, rSHUD, AutoSHUD, and Zero source references, while Harness-specific code has not been created. Phase 1 must introduce the smallest shared implementation substrate without pulling scientific execution, LLM agent behavior, or real SHUD runs into the foundation change.

## Goals / Non-Goals

**Goals:**

- Create a Bun/TypeScript monorepo that can host shared schemas, backend APIs, and frontend UI.
- Keep package boundaries simple enough for one engineer to maintain.
- Preserve source submodules as read-only references.
- Provide common scripts for typecheck, test, build, and docs-related checks that later changes can fill in.

**Non-Goals:**

- No real TaskCard schema implementation beyond placeholder exports needed for compilation.
- No Hono endpoints, React screens, WebSocket, Zero adapter, or SHUD execution.
- No package publishing workflow.

## Decisions

- Use root workspaces with `packages/core`, `packages/backend`, and `packages/frontend` as the Phase 1 implementation targets. This follows the current docs while keeping the initial layout smaller than the full future repository map.
- Use a single root package manager declaration and shared TypeScript configuration. Cross-package types must resolve through workspace imports instead of relative path chains.
- Keep Zero as a submodule reference during Phase 1. Any Zero integration or adapter code belongs to a later phase after deterministic skeleton behavior is stable.
- Use placeholder module entrypoints only where required to keep typecheck/build commands meaningful. Placeholders must not fake runtime behavior or scientific results.

## Risks / Trade-offs

- Bun may not be installed on every development machine. Mitigation: document the required version and make the missing-runtime failure explicit in setup instructions.
- Creating too many packages up front increases maintenance overhead. Mitigation: Phase 1 uses only the packages needed by the activated specs.
- Divergence from `Repository_Layout.md` naming can cause confusion. Mitigation: this change should choose one path convention and subsequent changes must reuse it.

## Migration Plan

- Add monorepo files without moving existing docs or submodules.
- Add implementation directories with minimal entrypoints.
- Verify the root scripts can be invoked or fail with actionable missing-runtime messages.

## Open Questions

- Exact Bun version should be pinned during implementation.
- Whether the final folder names should be `packages/core/backend/frontend` or `packages/harness-*` must be fixed before applying this change.
