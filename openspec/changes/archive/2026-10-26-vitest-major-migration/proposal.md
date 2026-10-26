# Proposal

## Why

Issue #289 permits Vitest migration independently of TypeScript 7. The prior Dependabot attempt failed because autoInstallPeers is disabled and Vite was not explicitly installed; TypeScript 7 remains unsupported by typescript-eslint 8.72.0 (`>=4.8.4 <6.1.0`).

## What Changes

Upgrade all workspace Vitest declarations and root coverage-v8 to 5.0.5; explicitly declare root Vite 8.3.4 (already resolved transitively, compatible with Node 24 and Vitest 5). Refresh the lockfile and version documentation; remove only migrated packages' major-update ignores. Keep TypeScript, Node, Node types, host and test/coverage policy unchanged.

## Capabilities

### Modified Capabilities

- `engineering-gates`: frozen installs with automatic peers disabled must provide the declared test runner's required peers and retain coverage enforcement.

## Impact

Root/workspace manifests, lockfile, Dependabot policy and generated agent instructions. No application API changes. Refs #289; does not close its blocked TypeScript portion.

Issue type: release
Fixture level: expanded
Upstream suggested level: absent; dependency migration affects the default shared gate.
Blast radius: every test and CI coverage result.
Selected risk packs: Config / project setup; Release / packaging / dependency compatibility; Documentation / migration notes.
Evidence floor: frozen install, full check, coverage comparison and actual profile smoke; no weakened thresholds or edited test expectations.
