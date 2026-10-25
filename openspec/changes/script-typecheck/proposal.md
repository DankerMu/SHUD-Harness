# Proposal

## Why

Issue #356 establishes that the default compiler gate omits root TypeScript scripts even though they install profiles, generate schemas and verify restart behavior. Root Node ambient types also lack a direct dependency owner.

## What Changes

- Add a no-emit root script compiler program extending the unchanged base settings, excluding test and fixture roots.
- Add explicit typecheck:scripts to the default typecheck sequence after existing build/package checks.
- Declare root @types/node at the existing package version 24.19.2; synchronize the lockfile without upgrading other packages or installing the dsh host.
- Document the precise gate coverage; prove the command rejects a temporary strict-null error in scripts and accepts restored sources.

## Capabilities

### New Capabilities

- `engineering-gates`: blocking compiler coverage for root script entrypoints.

### Modified Capabilities

None; canonical specs currently cover raw-data-guard, shud-profile, shud-run-jobs and stack-lock, not engineering compiler gates.

## Impact

Root package.json/pnpm-lock.yaml, new tsconfig.scripts.json, existing verification documentation. No production source, package test-typecheck, host version, compiler-option relaxation or permanent mutation fixtures.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for shared verification command and root dependency/config changes.
Blast radius: all local/CI typecheck invocations and root Node type resolution.
Selected risk packs: Public API / CLI / script entry; Config / project setup; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes; Scientific governance / PI gate / evidence lineage.
Evidence floor: real before/after mutation command, eight-script program inventory, frozen install, no TS2688 in eslint-program diagnostic, full check, guardrail self-test and strict fixture validation.
