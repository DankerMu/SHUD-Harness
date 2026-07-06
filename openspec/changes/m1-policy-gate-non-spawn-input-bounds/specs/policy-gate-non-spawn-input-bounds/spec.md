## ADDED Requirements

### Requirement: Generic non-spawn policy-gate input preparation is bounded

For tools other than `spawn_agent`, the policy-gate wrapper SHALL bound input
preparation before evaluator execution and before inner tool execution. Inputs
that exceed the preparation budget or require unsafe/stability-unbounded
inspection SHALL fail closed with the existing
`policy_gate_input_preparation_failed` tool result, and the wrapped inner tool
MUST NOT execute. Proxy-shaped and non-ordinary live inputs SHALL be rejected
instead of treated as safely bounded structured data.

#### Scenario: ordinary array and object budgets reject before value expansion

- **WHEN** a non-spawn tool receives an over-length array or over-wide object
- **THEN** ordinary array length is checked before array own-key / element
  descriptor enumeration
- **AND** ordinary object own-key count is checked after own-key enumeration and
  before per-key descriptor/value reads
- **AND** preparation fails closed before policy evaluation and before inner
  tool execution

#### Scenario: proxy key discovery fails closed

- **WHEN** a non-spawn tool receives proxy-shaped input whose key discovery or
  descriptor stability cannot be bounded
- **THEN** preparation fails closed before policy evaluation and before inner
  tool execution
- **AND** untrusted trap text is not leaked in the failure result

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

For tools other than `spawn_agent`, the policy-gate wrapper SHALL materialize
accepted input once into a stable bounded canonical structured-data graph, then
prepare separate execution and evaluator snapshots from that canonical graph.
The evaluator snapshot SHALL be plain structured data, SHALL be
structured-cloneable, SHALL use null prototypes recursively for plain objects,
and SHALL preserve ordinary array read APIs including iteration, spread,
`.includes()`, and `.map()`. Evaluator mutation attempts MUST NOT change the
input later supplied to the inner tool or global prototypes through
input-derived prototype paths.

#### Scenario: evaluator mutation cannot affect inner execution

- **WHEN** a custom evaluator attempts to mutate top-level or nested fields of
  a prepared non-spawn input
- **THEN** the mutation is isolated from the execution snapshot
- **AND** the inner tool does not execute with mutated input

#### Scenario: honest evaluator preserves normal execution

- **WHEN** a custom evaluator snapshots a valid non-spawn input with
  `structuredClone(call.input)`, reads array fields with `for...of`, spread,
  `.includes()`, and `.map()`, and returns allow
- **THEN** the inner tool executes with the expected cloned input value

#### Scenario: evaluator prototype mutation paths cannot affect execution

- **WHEN** a custom evaluator attempts to mutate prototypes reachable from
  `Object.getPrototypeOf(call.input)` or `call.input.constructor?.prototype`
- **THEN** the mutation fails closed or is isolated from the execution snapshot
- **AND** input-derived prototype mutation paths do not leave global prototype
  residue

### Requirement: Spawn authority preparation remains unchanged

The generic non-spawn preparation change MUST NOT change `spawn_agent`
normalization, profile subset authority checks, or spawn evaluator snapshot
behavior delivered by issue #20.

#### Scenario: spawn profile paths remain stable

- **WHEN** valid and invalid `spawn_agent` profile inputs are evaluated
- **THEN** their allow/deny behavior and normalized execution inputs remain
  consistent with the issue #20 contract
