# Design

## Context and invariant

Current SHUD gitlink and checkout are `3aec65755926c478e13ca7d4fea80715e4e90345`; its worktree is clean. Issue counts are historical: the live document has 46 Source rows, 18 dead-path rows and 5 wrong-file state-vector rows. Parent and read-only scouts verified the source map; the issue's ISOIL-style att header claim is contradicted by pinned ccw (`INDEX SOIL GEOL LC FORC MF BC SS ilake`).
Governing invariant: every Source path is openable and machine-discovered under the declared initialized pin, while cited headers/units/numbers match that source; a green existence check is not proof of scientific correctness.
Change surface: SHUD_IO_Facts, constraints doc_gate list, CI docs-gate checkout; a concise existing developer prerequisite note if needed. No checker implementation, dependency, generated schema or scientific source change.

## Decisions

1. Each Source citation uses one backticked repository-relative path followed by unquoted line metadata. The existing checker excludes tokens containing colons; putting path and line inside one token would recreate the blind spot. Harness-local citations remain separate tokens. Historical deleted skill provenance is prose/history, not a live path claim.
2. Re-cite the full current Source inventory, not a frozen count. Correct START/END days converted to minutes, SCR_INTV minutes, parsed ETStep's lack of active consumers; cfg.ic writer's minutes and reader ignoring its third header value; 5256000/1440=3650; actual ccw mesh/att/riv headers; positional att column 1 for SOIL; actual soil infKsatV/macKsatV names; warning before Beta clamp. Preserve the existing byte-sensitive END updater description.
3. State-vector references point to Macros.hpp and Model_Data.cpp, explicitly scoped to the concatenated serial vector where necessary. Output citations point to Model_Control.cpp writer routines; factual header field/type wording must not imply a different timestamp unit than the source. Do not add unrelated facts (unused calibration keys, element fields or slope clamps). Flux/storage tau semantics and NaN propagation are explicitly not re-audited; only their writer citations are repaired, and the baseline note disclaims a whole-document scientific validation.
4. Keep `## 退出码` and 0/10/12/13/19/20 unchanged. Keep the review-checklist block byte-identical. Consolidate dated verification labels into one actual review baseline without implying the entire scientific model was verified. Cite existing stable headings for touched consumer references rather than stale line numbers; no broad documentation cleanup.
5. Extend existing path_claim_files with SHUD_IO_Facts only and set only docs-gate checkout `submodules: true`. This is the issue's preferred pinned-source option, not a new snapshot or parser framework. All three configured public submodules may be fetched by checkout; other CI jobs stay unchanged. Local verification requires initialized submodules. Existing checker skips rooted claims when the root is absent; that limitation is explicit, not called fail-closed. No new absent-root validation or unrelated EXTS cleanup.
6. Optional sibling R provenance is routed separately, as allowed by the issue. Five dead paths coexist with broader verified API drift (getOutlets exists; crs.Albers derives from extent), so do not silently turn this SHUD repair into a whole R/science audit or enroll that unresolved file. Link the independently deduplicated follow-up before merge.

## Required proof and sibling surfaces

- Parent records a pre-edit disposable copy/root counterexample: the default enrollment misses a bad SHUD Source citation, while explicit checker scanning of a backticked path rejects it with initialized SHUD content. Preserve original user-reported failures; no edits to production documents to manufacture RED.
- After implementation, enumerate every Source path and ensure it exists in the checkout/git tree as appropriate, with per-row cited line ranges and highest-risk headers/units/arithmetic checked against actual source. The known-bad path SHUD/src/IO/read_func.cpp planted only in a disposable copy of the enrolled document must fail the real path command; restored good copy must pass. No permanent source-text tests or tautological copy checks.
- Run actual local docs/check and test-guardrails; inspect exact-head CI docs-gate checkout logs for initialized pinned SHUD/rSHUD/AutoSHUD and successful path check. This closes CI environment evidence, not just YAML inspection. Confirm SHUD status remains empty and its gitlink unchanged.
- Siblings: all Source rows, public doc consumers/exit-code anchor, local path CLI, CI docs-gate environment and existing gate self-test; R sibling explicitly routed, other codebase reports not enrolled here.

## Risks, compatibility and non-goals

Submodule checkout adds network/workspace cost to docs-gate; use existing GitHub checkout support rather than a second retrieval script. The path gate detects missing files, not wrong claims in existing files; the pinned source review remains required. Revert the three owned surfaces together to undo this strengthening; no model data migration or user evidence rewrite exists. No source pin bump, physics/default changes, scientific conclusions, future R behavior, new retention/telemetry framework or #293/#318 PI acceptance.
