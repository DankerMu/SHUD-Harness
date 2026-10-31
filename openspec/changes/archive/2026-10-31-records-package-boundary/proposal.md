# Records package runtime boundary

## Why

Issue #474: emitted records imports the repository-root package.json during module linking, so moving its package outside the checkout breaks the public entry before any API can run. Keep the root manifest as the canonical harness-version source, but capture that version at build time inside the package.

## What Changes

- Generate only the root harness version into the records lib output before TypeScript compilation; runtime imports that package-local artifact.
- Verify physically relocated emitted lib/templates/manifest with explicit core dependency from an external cwd, including captureStackLock version correctness.
- Document normal build prerequisites and the private-package boundary; no new configuration API.

## Capabilities

### Modified Capabilities
- `stack-lock`: emitted records retains canonical build provenance without a runtime ancestor-manifest dependency.

## Impact

Capture module import, records build command, one small deterministic build script, package-boundary regression and existing package-layout docs. No dependency, schema, template/files-list or public npm/application change.

## Risk triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (public entry, build/runtime dependency boundary and provenance)
Blast radius: records public import and captured harness version across installed/relocated packages
Selected risk packs: Public API; Config/project setup; File IO; Release/packaging; Documentation
Evidence floor: module-link semantic RED/GREEN outside checkout; exact canonical version capture; clean/repeated build; built external-cwd smoke; default check/profile smoke/strict fixture
