## ADDED Requirements

### Requirement: Generic non-spawn policy-gate input preparation is bounded

For tools other than `spawn_agent`, the policy-gate wrapper SHALL bound input
preparation before expensive cloning. Inputs that exceed the preparation budget
or require unsafe inspection SHALL fail closed with the existing
`policy_gate_input_preparation_failed` tool result, and the wrapped inner tool
MUST NOT execute.

#### Scenario: oversized generic input fails closed

- **WHEN** a non-spawn tool receives an input whose depth, node count, array
  length, or string budget exceeds the generic preparation budget
- **THEN** preparation fails closed before policy evaluation and before inner
  tool execution

#### Scenario: hostile generic input still fails closed

- **WHEN** a non-spawn tool receives accessor-backed, function-backed, symbol,
  proxy-hostile, or prototype-polluting input that cannot be safely prepared
- **THEN** preparation fails closed without leaking untrusted getter text and
  without executing the inner tool

### Requirement: Generic evaluator input cannot mutate execution input

For tools other than `spawn_agent`, the policy-gate wrapper SHALL prepare one
execution snapshot and SHALL provide policy evaluators an isolated or read-only
view. Evaluator mutation attempts MUST NOT change the input later supplied to
the inner tool.

#### Scenario: evaluator mutation cannot affect inner execution

- **WHEN** a custom evaluator attempts to mutate top-level or nested fields of
  a prepared non-spawn input
- **THEN** the mutation fails closed or is otherwise isolated, and the inner
  tool does not execute with mutated input

#### Scenario: honest evaluator preserves normal execution

- **WHEN** a custom evaluator only reads a valid non-spawn input and returns
  allow
- **THEN** the inner tool executes with the expected cloned input value

### Requirement: Spawn authority preparation remains unchanged

The generic non-spawn preparation change MUST NOT change `spawn_agent`
normalization, profile subset authority checks, or spawn evaluator snapshot
behavior delivered by issue #20.

#### Scenario: spawn profile paths remain stable

- **WHEN** valid and invalid `spawn_agent` profile inputs are evaluated
- **THEN** their allow/deny behavior and normalized execution inputs remain
  consistent with the issue #20 contract
