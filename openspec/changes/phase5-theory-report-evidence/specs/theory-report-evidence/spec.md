## ADDED Requirements

### Requirement: Theory-to-Code Evidence Section Rendering

The report generation pipeline SHALL render a Theory-to-Code Evidence section for tasks with semantic_level in (physical_equation, model_assumption, numerical_implementation, parameter_default, output_semantics).

#### Scenario: High-risk task report includes Theory-to-Code Evidence

- **WHEN** a report is generated for a task with semantic_level = physical_equation
- **THEN** the report SHALL contain a Theory-to-Code Evidence section with subsections: Scientific question, Assumptions and limitations, Equation summary, Derivation status, Numerical scheme summary, Implementation mapping, Verification cases, Benchmark / validation context, What this report does not prove

#### Scenario: Non-high-risk task report omits section

- **WHEN** a report is generated for a task with semantic_level = pure_engineering
- **THEN** the report SHALL NOT require a Theory-to-Code Evidence section

### Requirement: Theory-to-Code Assertion Types

The ReportAssertion schema SHALL accept 8 new assertion types: theory_assumption, equation_statement, derivation_step, numerical_scheme_statement, implementation_mapping_statement, verification_result, search_result, validation_context.

#### Scenario: Valid theory assertion is accepted

- **WHEN** a ReportAssertion payload uses assertion_type = equation_statement with required refs (equation_id, equation_spec_id)
- **THEN** the schema SHALL parse it successfully

#### Scenario: Unknown assertion type is rejected

- **WHEN** a ReportAssertion payload uses assertion_type = invalid_type
- **THEN** the schema SHALL reject the payload with a schema error

### Requirement: Lineage Requirements Enforcement

Each Theory-to-Code assertion type SHALL have required evidence_refs enforced at the draft-to-reviewed gate transition.

#### Scenario: Assertion with missing required refs blocks gate

- **WHEN** a report contains a verification_result assertion without verification_case_id ref
- **THEN** the report SHALL NOT transition from draft to reviewed and SHALL return an error identifying the missing ref

#### Scenario: Assertion with complete refs passes gate

- **WHEN** a report contains a verification_result assertion with verification_case_id and run_record artifact refs
- **THEN** the lineage guard SHALL allow the report to proceed toward reviewed

#### Scenario: search_result assertion requires baseline ref

- **WHEN** a report contains a search_result assertion without baseline run ref
- **THEN** the report SHALL NOT transition from draft to reviewed

### Requirement: Language Guard Additions

The language guard SHALL reject report text containing calibration-as-validation or overstatement phrases.

#### Scenario: Forbidden Chinese phrase is rejected

- **WHEN** report text contains "校准证明模型结构正确"
- **THEN** the language guard SHALL reject the text and identify the offending phrase

#### Scenario: Forbidden English phrase is rejected

- **WHEN** report text contains "verification通过说明物理机制真实"
- **THEN** the language guard SHALL reject the text

#### Scenario: Allowed phrasing passes guard

- **WHEN** report text contains "该 verification case 支持代码实现满足指定公式/用例"
- **THEN** the language guard SHALL accept the text

#### Scenario: Forbidden phrase "参数搜索确认了理论假设" is rejected

- **WHEN** report text contains "参数搜索确认了理论假设"
- **THEN** the language guard SHALL reject the text

#### Scenario: Forbidden phrase "无需 PI 审查即可接受该物理变更" is rejected

- **WHEN** report text contains "无需 PI 审查即可接受该物理变更"
- **THEN** the language guard SHALL reject the text

### Requirement: Report Gate for High-Risk Tasks

A high-risk task report missing the Theory-to-Code Evidence section SHALL NOT enter the reviewed state.

#### Scenario: High-risk report without section is blocked

- **WHEN** a report for semantic_level = model_assumption lacks a Theory-to-Code Evidence section
- **THEN** the report status transition to reviewed SHALL be rejected with a gate error

#### Scenario: High-risk report with section passes gate

- **WHEN** a report for semantic_level = model_assumption includes a Theory-to-Code Evidence section with at least one assertion with valid lineage
- **THEN** the report status transition to reviewed SHALL be allowed

### Requirement: HTML Export Includes Theory-to-Code Evidence

The standalone HTML export SHALL include a Theory-to-Code Evidence summary when the section is present in the report.

#### Scenario: HTML export contains evidence summary

- **WHEN** a report with Theory-to-Code Evidence section is exported to standalone HTML
- **THEN** the HTML output SHALL contain the Theory-to-Code Evidence summary including verification status table

#### Scenario: HTML export without section omits evidence

- **WHEN** a report without Theory-to-Code Evidence section is exported to standalone HTML
- **THEN** the HTML output SHALL NOT contain a Theory-to-Code Evidence section

### Requirement: Verification Status Table

The Theory-to-Code Evidence section SHALL include a verification status table showing each verification case with its type, status, and evidence link.

#### Scenario: Status table renders all cases

- **WHEN** a report references 3 verification cases (2 passed, 1 pending)
- **THEN** the verification status table SHALL display all 3 cases with correct status values and artifact links
