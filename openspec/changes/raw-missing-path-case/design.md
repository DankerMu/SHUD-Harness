# Design

## Context

See proposal and #493. Existing native realpath preserves symlink/parent traversal, then appends missing components literally. Shared canonical text also feeds shell mention and ancestor matching; changing its spelling would change those policies. The core containsPath helper is not the raw-policy owner.

## Goals / Non-Goals

Governing invariant: a plausible protected missing-path case alias cannot reach execute without filesystem evidence proving it is distinct; established raw writes still deny without approval.

Preserve existing canonical text, component boundaries, same-case behavior, primary non-ENOENT errors, cwd handling, output-before-input priority, input provenance wording, task/report writer target sets, and all shell lexical rules. No global lowercase, OS-name inference, product probe writes, dependencies/native addon, persistent cache, writer changes, or PI acceptance.

## Decisions

1. Keep the correction inside raw-guard's single canonical/containment owner. Retain native canonical text for shell syntax and derive missing-anchor identity only for path containment. Use ordinary exact containment first; extra work is restricted to a possible overlap differing in ASCII case in missing components. Unrelated prefixes are not grounds to deny.
2. Inspect the actual nearest existing directory namespace, not its own name in its parent. Parent native evidence shows a sensitive APFSX mount under insensitive /private/tmp has caseInsensitiveRoot(mount)=true. Never infer contents behavior across that boundary or from same-device alone; Linux may have per-directory casefold.
3. Use bounded read-only directory-entry/lookup evidence, with deterministic closure of any directory handle. An existing non-link entry and its alternate ASCII-case lookup can establish aliasing or distinctness. Symlink/hardlink coincidences, removal races, read failures, no usable entry, or evidence beyond the bounded inspection remain unknown, not evidence of sensitivity. Do not read raw file contents, enumerate an unbounded tree, or create marker files. Preserve spelling outside ASCII; no new Unicode-equivalence promise.
4. PI comment 6544516557 chose fail-closed for unknown plausible collisions. Return controlled deny with no raw contents/arbitrary error payload, no approval/execute; do not silently downgrade unknown to sensitive. This includes an empty sensitive directory: the approved conservative rejection qualifies the original sensitive-control acceptance. Proven sensitive distinct paths still pass. An input-side uncertain overlap also denies rather than offering provenance approval on an unproved identity.
5. Preserve the separate exported caseInsensitiveRoot shell-text contract and documented lexical gaps. Shared consumers use the same path-identity correction: task_create, report namespace/exact report+task targets, shud_run output/task/input, file writes, shell workdir and archive target containment. Do not copy policy into jobs/tools/records.

## Evidence and Review

- Native insensitive and APFSX sensitive volumes: absent RUNS/STACKS/PROVENANCE against lowercase outputs, existing aliases, same-case absent, sibling prefix, symlink and physical parent traversal. Parent controls already produce three semantic RED and three sensitive PASS.
- Fresh empty and unusable-entry namespaces: plausible alias must deny; ordinary unrelated/same-case paths retain behavior. Sensitive mount root under insensitive parent is a mandatory negative control; no fallback to the mountpoint spelling.
- Public pre-execute/ToolRuntime proves no execution, approval, state publication or filesystem changes for refused outputs. Pure decisions are not claimed as solver writes. Unknown/fault cases and repeated decisions cover released handles and fresh evidence.
- Old tests stay frozen unless an incidental wiring assertion must be removed with explicit explanation; semantic shell gaps, all writer policy controls and source/raw bytes must stay intact.
- Parent runs build, focused regressions, full check, strict OpenSpec, profile smoke and real raw T1–T5; expanded correctness, test-evidence/spec and security/path-safety review.

## Risks / Trade-offs

Unknown collision denial may reject an otherwise unrelated operation on an empty sensitive namespace; this is the PI-approved safety cost. Bounded probing may remain unknown in large/unusable namespaces. No TOCTOU-free filesystem enforcement is claimed: the existing advisory raw guard and OS sandbox boundary remain.

## Migration Plan

No persisted/config/API migration. Ship one raw-owner implementation, tests and specification; archive this independent change after its own merge without archiving m3-mvp-1. Do not overwrite the unarchived M3 three-output requirement during spec synchronization.
