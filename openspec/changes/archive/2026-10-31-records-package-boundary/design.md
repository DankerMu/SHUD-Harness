# Design

## Context

Change surface: records/src/capture-stack-lock.ts import, records/package.json build script, new scripts/records/generate-version.ts, boundary test and Repository_Layout docs.
Current source and emitted JS import ../../../package.json; workspace tests exercise a reachable root, so they miss external module-link failure.
Parent compiler trial proved TS5.9.3 accepts src importing ../lib/harness-version.json with rootDir=src/outDir=lib; no compiler-option change needed.

## Goals / Non-Goals

Governing invariant: runtime version comes from the root manifest captured during the build, never a package ancestor or caller cwd at execution time.
Must preserve: captureStackLock signature, StackCaptureConfig, canonical root version semantics, immutable capture/reuse/fingerprint/error behavior and existing consumers.
Must preserve: tsc build, package private status, existing lib/templates files list, dependency pins, schema/host/solver behavior.
Non-goals: public npm publishing, standalone app, template changes, runtime version override/config, broader bundler/build redesign, M3/PI archival.

## Decisions

A small Node TypeScript build script reads the canonical root package.json relative to its own import.meta.url and writes only {version} to packages/dsh-shud-records/lib/harness-version.json.
Run generation BEFORE tsc in the existing package build command; create lib when absent and refresh the artifact on every build.
Source capture imports ../lib/harness-version.json; emitted lib import remains package-local and lib is already shipped/ignored. Do not copy the full manifest or create a tracked second version source.
No runtime fallback or retained ancestor import, no expanded capture API, no emitted-JS search/replace or new bundler dependency.
Root default check/typecheck and CI already build packages before tests. Boundary test reads fresh emitted output after that normal build, never triggers a concurrent shared build inside vitest; document build-before-test prerequisite for this emitted-artifact test.
Sibling surfaces: core barrel/records public index, jobs/shud-submissions capture caller, existing capture tests, package exports/files, script typecheck/knip, root build/CI, report templates. Keep their existing behavior.

## Required Evidence

Before implementation, add a physical-copy emitted-package test and observe ERR_MODULE_NOT_FOUND for the missing ancestor manifest during public import; no fake import result or source-text check.
After build, same external Node import succeeds and captureStackLock produces a schema-valid persisted lock whose harness.version equals canonical root version despite conflicting cwd/package versions.
Explicitly provide core dependency; copy records lib/templates/manifest rather than symlinking records back to checkout. Fresh process and owned temporary cwd; clean up owned files.
Parent clean-output build plus repeat build prove generated version is recreated/refreshed; isolated root-version generation probe uses a different canonical version to rule out a hardcoded/package-version copy.
Keep existing workspace capture tests; parent external runtime smoke supplements regression; run full check/profile smoke/strict fixture.

## Risks / Migration

[Stale emitted artifacts hide changes] → default build-first verification; parent RED uses pre-fix build and GREEN follows changed build, no test-side shared rebuild.
[Source import needs generated file] → normal package build generates first, root typecheck/check already builds; fail loudly when build output is absent, no runtime root fallback.
[Build script undiscovered by tooling] → existing scripts typecheck includes it; register genuine entry in knip only if automatic package-script discovery needs it.
[Source placement overlaps ignored build directories] → keep the script under scripts/records, not the existing global build/ ignore; no ignore-rule relaxation or force-add.
No persisted migration or dependency change. Rebuild the package to deploy; normal git revert plus rebuild rolls back.
Review focus: root source-of-truth, physically external import, clean/repeated generation, no runtime escape, unchanged capture API and build ordering.
