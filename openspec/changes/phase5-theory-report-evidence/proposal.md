## Why

Phase 5 closes the report governance gap: high-risk scientific changes (physical_equation, model_assumption, numerical_implementation, parameter_default, output_semantics) can reach PI review without structured theory-to-code evidence, and the current language guard cannot detect calibration-as-validation rhetoric. Without this change, EvidenceReport lacks the enforcement needed to prevent Agent-generated reports from overstating scientific conclusions.

## What Changes

- Implement the Theory-to-Code Evidence report section template rendering for high-risk TaskCard semantic levels.
- Add 8 new TheoryToCodeAssertionType values to the ReportAssertion schema and report renderer.
- Enforce lineage requirements per assertion type (each type must carry required refs or the report cannot advance to `reviewed`).
- Add language guard regex/heuristic patterns that reject calibration-as-validation and overstatement phrases.
- Add a report gate: high-risk task report missing Theory-to-Code Evidence section cannot transition to `reviewed`.
- Extend HTML standalone export to include Theory-to-Code Evidence summary.
- Add a verification status table subsection within the report template.

## Capabilities

### New Capabilities

- `theory-report-evidence`: Theory-to-Code Evidence section rendering, assertion types, lineage enforcement, language guard additions, and report gate for high-risk tasks.

### Modified Capabilities

None directly. Depends on upstream capabilities from Phase 3 (TheoryToCodeBundle CRUD) and Phase 4 (search gate baseline refs).

## Upstream References

| Document | Use | Boundary |
|---|---|---|
| `docs/03_SPEC/Theory_To_Code_Report_Lineage_Spec.md` | Normative source for report section template, assertion types, lineage requirements, and language guard additions. | Full spec is implemented in this changeset. |
| `docs/03_SPEC/Report_Generation_Spec.md` | Normative report template and export rules; §4.1 defines Theory-to-Code Evidence section requirement. | Only the Theory-to-Code Evidence rendering and HTML export extension are added; base report generation already exists. |
| `docs/03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md` | Normative assertion schema and lineage guard; §2.1–2.2 define new assertion types and lineage requirements. | Only the new Theory-to-Code assertion types and their lineage constraints are added. |
| `docs/04_IMPLEMENTATION/Scientific_Change_Playbooks.md` | Reference operational guidance for report generation in scientific change workflows. | No code implementation of playbooks; only report section rendering and guard logic. |
| `docs/02_ARCHITECTURE/Control_Kernel.md` | Normative state-machine context for report status transitions (draft → reviewed gate). | Gate enforcement only; no changes to state machine itself. |

## Impact

- Affected paths: `packages/core/src/domain/schemas/report-assertion.*`, `packages/report/src/sections/theory-to-code-evidence.*`, `packages/report/src/guards/language-guard.*`, `packages/report/src/guards/lineage-guard.*`, `packages/report/src/export/html.*`, report unit tests and fixtures.
- Depends on `phase3-theory-to-code-bundle` (bundle schema, verification case refs) and `phase4-search-gate` (search_result assertions needing baseline refs).
- Enables PI to review high-risk scientific changes with structured, traceable evidence before acceptance.
