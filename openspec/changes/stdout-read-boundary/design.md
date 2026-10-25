# Design

## Context

The sole stdoutSource is shared by local submission and R3/R5 takeover. Each read currently opens the path, stats its descriptor, reads appended bytes and closes it in finally. Parent guardSource warns once and stops a failing source. Existing UTF-8/short-read behavior is already tested.

## Goals / Non-Goals

Governing invariant: an output pump read never returns bytes through a final-component symlink or a nonregular descriptor, never blocks waiting for a FIFO writer, and closes every successfully opened descriptor on success or failure.

Must preserve: unchanged JobOutputSource API, cursor/spillPath/UTF-8/short-read/truncation behavior, missing-file errors, existing ring data, normal and recovered job lifecycle and parent warning-and-stop semantics.

Non-goals: writer-side opens, readExit, whole-path race elimination, new output bounds, new watchers, persistent inode identity, raw policy, host changes, #343/#344 semantics and PI acceptance.

## Decisions

Use O_RDONLY | O_NOFOLLOW | O_NONBLOCK followed by the existing descriptor stat, requiring isFile before allocating or reading. Reuse the stat for size; no separate lstat/open race or extra stat. Keep closing inside the existing finally, including type/stat/read errors. Prefer this to lstat then open because the descriptor check owns the actual read target.

Failure is an error, not an empty successful stream or lossy external text. Preserve errno for native failures and use a controlled nonregular-file error without content. Parent integration must observe the actual warning plus absence of sentinel bytes in public registry output.

Sibling surfaces: shud-submissions and shud-poll takeover both use stdoutSource; inspect both, do not add caller-specific guards. readExit and detached writer are explicit separate surfaces excluded by #348.

Seams under test: real filesystem stdoutSource reads; real Cordis/LocalJobRegistry output pump through existing submit fixture. FIFO test runs in a child with a bounded timeout so a regression cannot hang Vitest.

## Risks / Trade-offs

- Hardlinks and same-user replacement by another ordinary file are not distinguished: accepted under the existing single-user residual model, documented in m2-run-chain design risk row. No persisted dev/ino or expanded schema.
- O_NOFOLLOW protects the final component only: established real run-directory checks remain the precondition; concurrent ancestor replacement is not claimed solved.
- Unbounded ordinary log delta allocations remain unchanged and are not represented as solved by this fix.

## Required Evidence

Symlink replacement before/after a normal read throws with no returned target text; parent pump logs failure while preserving prior output and rejecting sentinel. Real FIFO and directory fail without blocking. Descriptor closure on rejection is evidenced without weakening existing UTF-8, short-read, truncation and missing-file assertions. Standalone built-module smoke exercises actual files; profile smoke proves the mounted host remains bootable.

## Migration Plan

No persisted migration. Deploy through existing package build; revert the fix commit if needed. Keep #293/#318 and the m2-run-chain fixture open pending PI acceptance.

## Review Focus

Descriptor-bound validation and cleanup; actual parent warning/output evidence; shared caller coverage; no overclaim for hardlinks, ancestor races or historical runtime evidence.
