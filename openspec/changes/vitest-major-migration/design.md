# Design

## Context

Root and four workspace packages currently declare Vitest 4.1.12. The existing lock graph already resolves Vite 8.3.4. Node remains 24.13.1. See proposal for the independently blocked TS7 scope.

## Goals / Non-Goals

- Change surface: manifests, lockfile, Dependabot and canonical instructions/rendered projections.
- Must preserve: test discovery, 80% lines/statements/functions/branches thresholds, coverage includes/excludes/reporters, all scientific/runtime behavior, frozen installation and no host npm installation.
- Must add/change: synchronized Vitest/coverage-v8 5.0.5 and explicit root Vite 8.3.4 peer.
- Non-goals: TS7, Node/@types major changes, host upgrade, test rewrites or policy relaxation.

## Decisions

- Use existing Vite 8.3.4 rather than introducing another major into the graph; its engine includes Node24 and Vitest5 accepts ^8.
- All workspace Vitest declarations migrate together; no parallel runner versions.
- Preserve autoInstallPeers:false; explicit peer ownership is the solution, not implicit installation.
- Existing failing #208 output is the red evidence; do not rerun the unsupported combination merely to reproduce it. This is a dependency migration, not new application behavior requiring permanent wiring tests.
- The orchestrator owns this expanded fixture; one implementer owns manifests/config/docs per the invoked workflow. No parent implementation shortcut.
- Governing invariant: a frozen install provides a runnable test/coverage CLI without weakening existing behavioral assertions or coverage gates.
- Sibling surfaces: root and workspace manifests, coverage provider peer, lock importers, CI frozen installs, documentation projections and Dependabot ignores.

## Risks / Trade-offs

- Coverage remapping can change counts → compare all four metrics and file/test totals against the latest #233 baseline, explain changes; below-threshold output blocks merge.
- Explicit peer may appear unused → inspect knip's actual dependency handling; no blanket ignore or gate relaxation. Any required exception needs independent decision rather than quiet suppression.
- Lockfile size → retain generated graph and record size-exempt rationale if the existing PR policy requires it.
- Known pre-existing #373/#393 CI races remain separate; do not rewrite test oracles as part of migration.

## Migration Plan

Implement dependency/config/doc changes, regenerate lock/instructions, frozen-install, run full check and real profile smoke. Review exact diff, require green exact-head CI, merge with #289 remaining open for TS7. Rollback through a normal revert PR, not fallback manifests or parallel versions.
