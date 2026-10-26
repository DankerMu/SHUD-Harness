# Design

## Context

The baseline has 35 Source rows and six dated Verified claims. Pin rSHUD at 2b7742e32ea323a57fd0a947dc2cea67bfd0afd1 and AutoSHUD at f421445340f70b8cb160ce58cefb066751628593. SHUD stays at 3aec65755926c478e13ca7d4fea80715e4e90345. These checkout sources are read-only.

## Goals / Non-Goals

- Change surface: the R quirks document and one path_claim_files entry.
- Must preserve: source pins, all R/C++/host code, existing checker semantics, SHUD_IO_Facts and other Codebase_Report documents, checklist question/list structure and path-only consumers.
- Must change: every false premise identified in #391, not merely its five dead paths; checklist pipeline order must match the actual entry too.
- Governing invariant: a reader can trace each corrected API fact to the referenced pinned source, while the normal gate rejects a recognized nonexistent citation under initialized submodules.
- Non-goals: R runtime behavior changes or scientific/physical validation; upstream issue filing; new generic checker hardening; complete Git history in CI.

## Decisions

- Follow SHUD_IO_Facts' citation convention: separate backticked paths, line ranges outside. Historical deleted skill paths are plain history, not live claims; the configuration dotfile example refers to a real tracked sample or plain prose.
- Source-review date/pins replace stale Verified timestamps; never call R source inspection an executed R test or full hydrological validation.
- Distinguish modern read_output and legacy readout signatures and warning/message branches; avoid promising interchangeable argument binding or identical single-column shapes.
- Verify getOutlets definition/export, extent-derived Albers parameters, GetReady conversions instead of detach, read_df bounds/header names vs positional consumers and lake validation, actual function owners/defaults, test scopes, All.R entry steps and dispatch code branches.
- Eliminate unsupported exact test counts or use a reproducible lexical count explicitly labeled as such. Existing R tests prove their presence and authored cases, not a passed R runtime run.
- Use disposable overlay roots for negative/positive gate probes; never mutate consumer evidence or read-only source files. Before enrollment, default4-file checking misses planted nonexistent citation while explicit checking rejects it. After enrollment default5-file checking must reject it and accept the corrected whole document.
- Existing missing-root skip remains explicit: local users initialize submodules first; CI evidence must show actual pinned source checkout before path checking. No fetch-depth/history policy changes.
- Sibling surfaces: R and AutoSHUD callsites, reader implementations/export tables, tests, checklists and risk-profile path consumers; SHUD citation format is reused but its file is not edited.

## Risks / Trade-offs

- Issue/scout facts may themselves be stale → implementer and source-correctness review re-open disputed anchors; preserve uncertainty rather than invent facts.
- Path existence does not prove line bounds or factual truth → parent inventories ranges and reviewer verifies claim/source alignment separately.
- Negative absence claims can overreach → scope them to inspected tests/declarations or remove unsupported external assertions.

## Migration Plan

Audit pinned facts; correct the document and enrollment together; execute default-path negative/positive probe, full check and CI; merge after clean expanded review; archive only this fixture. Revert through a normal PR if necessary, no parallel document version.
