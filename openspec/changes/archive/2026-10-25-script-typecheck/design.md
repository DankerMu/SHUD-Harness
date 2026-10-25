# Design

## Context

Root typecheck runs build then recursive workspace typecheck; recursive scripts omit the root. Existing packages own @types/node 24.19.2 but root does not. tsconfig.eslint includes scripts and package tests, so making it the gate would silently expand scope.

## Goals / Non-Goals

Governing invariant: a strict compiler error in a production scripts/**/*.ts file makes the same default local/CI typecheck command fail with the file diagnostic, without weakening existing package checks or emitting script build artifacts.

Must preserve: base strict/skipLibCheck/module/lib settings, package test exclusions, existing build order, dependency pins, autoInstallPeers:false, no npm dsh installation, runtime scripts' direct Node execution, all quality thresholds.

Non-goals: checking package tests, .mjs configs, profile bundle or root vitest config; upgrading TypeScript/Vitest/Node; fixing unrelated errors exposed only by the broad lint-program diagnostic.

## Decisions

Use tsconfig.scripts.json extending tsconfig.base.json with noEmit:true, include scripts/**/*.ts and explicit excludes for test/spec files, test-harness and test/fixture directories. Include all eight existing production scripts; no explicit eight-file allowlist that omits future scripts. Imported production package sources are allowed as compiler dependencies; no rootDir workaround.

Add typecheck:scripts as tsc -p tsconfig.scripts.json and explicitly append it to the root typecheck chain, avoiding recursion. Put @types/node 24.19.2 in root devDependencies and update only the needed lock importer; no typeRoots pointers into a sibling package. Standard frozen pnpm install proves dependency closure.

Sibling surfaces: schema generation/self-test, profile patch/install, restart orchestrator/evidence scripts, root lint-program resolution, package build/typechecks, CI's existing default command. No CI command fork.

Seams under test: actual pnpm run typecheck with a temporary strict-null-error script before and after implementation; tsc --listFilesOnly proves program membership; actual frozen install and full check exercise the closure.

## Risks / Trade-offs

- A new file include can accidentally collect fixtures: explicit exclusions plus actual membership inspection and temporary excluded invalid fixture probes prove boundaries; permanent regression tests of JSON wiring are unnecessary.
- Broad tsconfig.eslint can report unrelated test type diagnostics after Node types resolve: record them without claiming the whole program is clean, acceptance requires absence of TS2688 only.
- Mutation proof must restore/remove only parent-owned probe bytes in finally and never leave intentionally broken files committed.

## Required Evidence

The same temporary null-dereference script is silently accepted before the fix (observed broken gate), rejected afterward with its file/line, and restored tree is accepted. Compiler file list includes all eight production scripts and excludes test/fixture probes. Frozen install succeeds, root Node type resolution works, full check and guardrail self-tests remain green. No runtime behavior changed; the real typecheck command is the changed-surface smoke.

## Migration Plan

Install from the updated frozen lockfile. No persisted/runtime migration. Revert the standalone commit to undo the gate addition; no parallel config or deprecated commands.
