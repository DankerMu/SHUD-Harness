# Design

## Context

See proposal: the top-level read currently calls trim(), conflating output framing with path content.
Change surface: collectRepositoryRevision in core/stack-lock/repository-revision.ts; existing repository-revision.test.ts; Minimal_Schemas.md.
Public consumer: records/capture-stack-lock.ts; core index exports the same function without signature changes.

## Goals / Non-Goals

Governing invariant: the physical configured repository root equals git's reported pathname after removing only its one final LF; a descendant must never collect its ancestor's revision.
Must preserve: realpathSync.native equality, four git argument arrays, no shell, fsmonitor=false, optional locks disabled, locator-variable stripping, commit/ref trimming and status decoding/dirty paths.
Must preserve: existing errors/cause behavior, clean/dirty fields, index bytes and no extra git operations.
Non-goals: CRLF/non-POSIX handling, invalid UTF-8 root bytes, alternate inode comparison, schema/fingerprint changes, M3 archival/PI acceptance.

## Decisions

Use endsWith("\n") and slice(0,-1) on top-level output only; unchanged output if no terminator is present.
Reject trim/trimEnd or removing all LF characters because they destroy legal content.
Reject extra stat/dev/ino comparison because it broadens identity semantics and introduces unnecessary work.
Sibling surfaces: HEAD/ref trim calls operate on whitespace-forbidden identifiers; diagnostic trim formats error text; leave them unchanged. Status NUL decoder has a separate contract and stays unchanged.
No second implementation or new helper/export is needed.
Seams under test: real git repos through public collector; built core public index smoke outside vitest.

## Required Evidence

Real committed root with trailing space: RED against current source, then exact clean revision and dirty-path projection after the fix.
Trailing-LF root: preserve that LF, distinguish it from git's appended LF with the same real-git coverage.
Empty descendant inside a whitespace-ended root: throws non-root instead of returning parent's commit; existing ordinary descendant test remains.
Existing argument/environment/index tests remain unchanged and pass; four calls stay four.
Smoke builds core, imports its public entry, collects a real whitespace-ended committed repo and rejects its descendant; remove owned scratch afterward.
Run pnpm run check and openspec validate repository-root-whitespace --strict --no-interactive.

## Risks / Migration

[Whitespace could be normalized in fixtures] → pass paths as argv, inspect physical paths, never trim root stdout in the oracle.
[Independent archive could overwrite pending M3 schema work] → additive narrow requirement; no edits or archive of m3-mvp-1.
No persisted format migration; ordinary deployment rebuilds core. Rollback is the normal git revert, no compatibility shim.
Review focus: exact delimiter handling, ancestor rejection, unchanged call/environment contract and independently observed RED/GREEN.
