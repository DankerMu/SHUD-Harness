## 1. Schema Extension

- [ ] 1.1 Add TheoryToCodeAssertionType enum (theory_assumption, equation_statement, derivation_step, numerical_scheme_statement, implementation_mapping_statement, verification_result, search_result, validation_context).
- [ ] 1.2 Extend ReportAssertion schema to accept TheoryToCodeAssertionType values in assertion_type field.
- [ ] 1.3 Add lineage requirements map: assertion type → required ref fields.
- [ ] 1.4 Export updated schema and types from core package.

## 2. Report Section Template

- [ ] 2.1 Implement Theory-to-Code Evidence section renderer (deterministic template from bundle/verification data).
- [ ] 2.2 Implement verification status table subsection (case, type, status, evidence link).
- [ ] 2.3 Implement "What this report does not prove" disclaimer subsection.
- [ ] 2.4 Integrate section renderer into report generation pipeline for high-risk semantic levels.

## 3. Language Guard

- [ ] 3.1 Define language guard pattern config array with forbidden phrases (Chinese and English).
- [ ] 3.2 Implement regex/heuristic matching function against report text.
- [ ] 3.3 Define allowlist of acceptable similar phrases to reduce false positives.
- [ ] 3.4 Integrate language guard into report generation pipeline (run before Reviewer check).

## 4. Lineage Guard Extension

- [ ] 4.1 Implement per-assertion-type lineage validation (check required refs present).
- [ ] 4.2 Integrate lineage guard into draft → reviewed gate transition.
- [ ] 4.3 Return clear error messages identifying which assertions lack required refs.

## 5. Report Gate

- [ ] 5.1 Add gate condition: high-risk task report missing Theory-to-Code Evidence section cannot enter reviewed.
- [ ] 5.2 Define high-risk semantic levels list (physical_equation, model_assumption, numerical_implementation, parameter_default, output_semantics).
- [ ] 5.3 Integrate gate into report status transition logic.

## 6. HTML Export Extension

- [ ] 6.1 Extend standalone HTML export template to include Theory-to-Code Evidence summary.
- [ ] 6.2 Add collapsed/expandable section for full evidence details.
- [ ] 6.3 Include verification status table in HTML export.

## 7. Fixtures And Tests

- [ ] 7.1 Add valid fixture data for each new assertion type with complete lineage refs.
- [ ] 7.2 Add invalid fixture data for assertions missing required refs.
- [ ] 7.3 Add language guard test cases: forbidden phrases rejected, allowed phrases accepted.
- [ ] 7.4 Add report gate test: high-risk report without Theory-to-Code Evidence blocked from reviewed.
- [ ] 7.5 Add report gate test: non-high-risk report passes gate without Theory-to-Code Evidence.
- [ ] 7.6 Add HTML export test: Theory-to-Code Evidence summary present in output.

## 8. Verification

- [ ] 8.1 Run all unit tests (schema, language guard, lineage guard, report gate, export).
- [ ] 8.2 Run root typecheck for updated schema exports.
- [ ] 8.3 Confirm assertion types and lineage map match canonical spec docs.
- [ ] 8.4 Confirm language guard patterns match Theory_To_Code_Report_Lineage_Spec.md §4.
