## Context

`docs/03_SPEC/Theory_To_Code_Report_Lineage_Spec.md` defines the complete spec for Theory-to-Code Evidence in EvidenceReport. Phase 3 provides the bundle and verification case schemas upstream; Phase 4 provides baseline run refs for search_result assertions. This changeset implements the report-layer enforcement so that high-risk scientific tasks cannot reach PI review without structured evidence.

## Goals / Non-Goals

**Goals:**

- Render the Theory-to-Code Evidence section for high-risk tasks using a deterministic template.
- Extend ReportAssertion schema with 8 new assertion types and their per-type required refs.
- Enforce lineage requirements at the `draft → reviewed` transition gate.
- Block reports from entering `reviewed` when Theory-to-Code Evidence section is absent on high-risk tasks.
- Add language guard patterns that reject calibration-as-validation and overstatement phrases (both Chinese and English).
- Include Theory-to-Code Evidence summary in standalone HTML export.
- Add a verification status table subsection.

**Non-Goals:**

- Do not implement TheoryToCodeBundle CRUD (Phase 3).
- Do not implement search gate or AnalysisPlan logic (Phase 4).
- Do not modify the report state machine transitions beyond adding the new gate condition.
- Do not implement full NLP language analysis; use regex/heuristic matching only.

## Decisions

- Language guard uses a pattern list (regex + substring match) rather than LLM-based detection. This keeps the guard deterministic and testable. Patterns are stored in a config-like array for easy extension.
- Lineage requirements are defined as a static map from assertion type to required ref fields. Validation runs at gate time, not at assertion creation time, to allow incremental authoring.
- The Theory-to-Code Evidence section is rendered from bundle/verification data via a deterministic template function, not by LLM generation. LLM may add narrative context only in non-evidence subsections.
- HTML export includes a collapsed/expandable Theory-to-Code Evidence summary to keep the main report readable while preserving full traceability.
- Verification status table uses a simple pass/fail/pending per verification case, with links to RunRecord and artifact.

## Risks / Trade-offs

- Regex language guard may produce false positives on legitimate phrasing. Mitigation: maintain an allowlist of acceptable similar phrases; add escape-hatch for PI-overridden reports.
- Strict lineage enforcement may slow report authoring. Mitigation: lineage is checked only at gate transition, not during editing; clear error messages identify missing refs.
- Template rigidity may not fit all scientific contexts. Mitigation: subsections are optional (can be empty with explanation), only the top-level Theory-to-Code Evidence section presence is mandatory.

## Migration Plan

- Add new assertion type enum values to the ReportAssertion schema (backwards-compatible addition).
- Add language guard pattern config and guard function.
- Add lineage guard extension for theory-to-code assertion types.
- Add report section template renderer.
- Add report status transition gate condition.
- Extend HTML export template.
- Add comprehensive test fixtures for valid/invalid assertions and language guard patterns.

## Open Questions

- Whether PI can override a missing Theory-to-Code Evidence section (force-accept) should be confirmed before implementation. Current spec says no — report cannot enter `reviewed` without it.
- Whether language guard patterns should be workspace-configurable or hardcoded. Current design: hardcoded with extension array.
