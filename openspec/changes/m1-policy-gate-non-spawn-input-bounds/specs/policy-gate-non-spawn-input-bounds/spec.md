## ADDED Requirements

### Requirement: Generic non-spawn policy-gate input preparation is bounded

For tools other than `spawn_agent`, the policy-gate wrapper SHALL bound input
preparation before expensive cloning. Inputs that exceed the preparation budget
or require unsafe inspection SHALL fail closed with the existing
`policy_gate_input_preparation_failed` tool result, and the wrapped inner tool
MUST NOT execute.

#### Scenario: cheap array and object budgets reject before descriptor expansion

- **WHEN** a non-spawn tool receives an over-length array or over-wide object
- **THEN** array length and object own-key budgets are checked before array
  own-key / element descriptor enumeration or object per-key descriptor reads
- **AND** preparation fails closed before policy evaluation and before inner
  tool execution

#### Scenario: oversized generic input fails closed

- **WHEN** a non-spawn tool receives an input whose depth, node count, array
  length, or string budget exceeds the generic preparation budget
- **THEN** preparation fails closed before policy evaluation and before inner
  tool execution

#### Scenario: hostile generic input still fails closed

- **WHEN** a non-spawn tool receives accessor-backed, function-backed, symbol,
  bigint, proxy-hostile, symbol-keyed, or prototype-polluting input that cannot
  be safely prepared
- **THEN** preparation fails closed without leaking untrusted getter or trap text
  and without executing the inner tool

### Requirement: Generic evaluator input cannot mutate execution input

For tools other than `spawn_agent`, the policy-gate wrapper SHALL prepare
separate execution and evaluator snapshots after bounded inspection. The
evaluator snapshot SHALL be plain structured data, SHALL be structured-cloneable,
and SHALL use null prototypes recursively for plain objects. Evaluator mutation
attempts MUST NOT change the input later supplied to the inner tool.

#### Scenario: evaluator mutation cannot affect inner execution

- **WHEN** a custom evaluator attempts to mutate top-level or nested fields of
  a prepared non-spawn input
- **THEN** the mutation is isolated from the execution snapshot
- **AND** the inner tool does not execute with mutated input

#### Scenario: honest evaluator preserves normal execution

- **WHEN** a custom evaluator snapshots a valid non-spawn input with
  `structuredClone(call.input)` and returns allow
- **THEN** the inner tool executes with the expected cloned input value

#### Scenario: evaluator prototype mutation paths cannot affect execution

- **WHEN** a custom evaluator attempts to mutate prototypes reachable from
  `Object.getPrototypeOf(call.input)` or `call.input.constructor?.prototype`
- **THEN** the mutation fails closed or is isolated from the execution snapshot
- **AND** no global prototype residue is required for the inner tool to receive
  the original input

### Requirement: Spawn authority preparation remains unchanged

The generic non-spawn preparation change MUST NOT change `spawn_agent`
normalization, profile subset authority checks, or spawn evaluator snapshot
behavior delivered by issue #20.

#### Scenario: spawn profile paths remain stable

- **WHEN** valid and invalid `spawn_agent` profile inputs are evaluated
- **THEN** their allow/deny behavior and normalized execution inputs remain
  consistent with the issue #20 contract
