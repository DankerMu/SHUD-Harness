## ADDED Requirements

### Requirement: Bounded fresh delegated coder approval initialization

The SHUD profile SHALL initialize approval policy to ask only for a provably fresh, unseeded, live-owned delegated coder whose current live parent explicitly resolves to ask at the initialization boundary. The child SHALL have no prior execution turn and exactly one child-owned approval policy record: never from delegation. Unknown provenance, missing capabilities, inconsistent ownership or any explicit child policy SHALL prevent automatic initialization. This opt-in SHALL NOT grant an operation, change the parent policy, widen the sandbox or tool surface, or alter approval decision semantics.

The initialization SHALL happen once before the child's first execution through documented pinned-host public seams. It SHALL be identified as SHUD initialization, not a user click or an approval. It SHALL NOT claim to inherit a parent approval snapshot the host did not record. A later explicit policy override SHALL remain authoritative. Restore, clear, compact, fork/seed, role selection and plugin reload SHALL NOT create another automatic initialization.

#### Scenario: Fresh authorized coder can ask but is not granted

- **WHEN** an unseeded coder is newly delegated under an exact live parent whose approval policy is ask, and the child's sole policy is delegation-origin never
- **THEN** the child is initialized to ask before its first turn with truthful SHUD provenance
- **AND** a required approval reaches the real answerer and remains pending without business writes until that answerer responds
- **AND** only allowed-once permits the existing tool execution path

#### Scenario: Parent never or missing authorization remains closed

- **WHEN** the live parent's policy is never, including a change to never while child creation awaited, or its approval service/policy cannot be established
- **THEN** no child policy is changed by this feature and no grant is produced
- **AND** the parent's policy and sandbox are untouched

#### Scenario: Explicit and restored policies are not rewritten

- **WHEN** a child has an explicit policy record, has been restored, or has already begun a turn
- **THEN** this feature does not initialize its policy, even when its current role is coder and its parent is ask
- **AND** explicit or restored never still rejects required asks before answerer dispatch

#### Scenario: Seeded or unowned sessions are ineligible

- **WHEN** a purported coder is seeded/forked, has inconsistent lineage, lacks a live parent, is not owned by the exact live parent, or is not the exact live registry entry
- **THEN** no automatic policy write occurs

#### Scenario: Unrelated roles and later lifecycle events stay unchanged

- **WHEN** a root, worker, reviewer, unknown-role session or later preset/clear/compact lifecycle event is observed
- **THEN** it receives no automatic coder approval initialization
- **AND** repeated creation callbacks cannot repeat a successful initialization or overwrite a later explicit never

#### Scenario: Rejection and unavailable answerer preserve business state

- **WHEN** an eligible coder invokes change_submit and its real answerer rejects, cancels, is absent or cannot answer
- **THEN** the existing fail-closed ToolRuntime path prevents the business transition
- **AND** ChangeRequest, TaskCard, patch and unrelated records remain byte-identical

#### Scenario: Publication failure is not a successful opt-in

- **WHEN** initialization or its provenance notice cannot be established
- **THEN** creation fails rather than continuing as a reported success
- **AND** a policy written by this attempt is restored to never if still owned, without overwriting a subsequent external policy change
- **AND** original and cleanup failures remain observable without an automatic retry or grant

### Requirement: Delegated coder policy evidence matches actual behavior

A delegated coder with current ask policy SHALL receive truthful runtime-context wording that requests still require an answerer and only allowed-once grants one action. It SHALL NOT simultaneously be told that every required approval is automatically rejected. The fixed sandbox boundary SHALL remain stated. Other roles, never-policy contexts and unrelated prompt content SHALL remain unchanged.

Engineering evidence SHALL distinguish policy initialization, answerer delivery and actual decision. Real Web evidence SHALL bind the root/child relationship, child policy history and SHUD provenance, tool callId, approval request/decision ids and final tool result in canonical session logs. A configuration dump or asked/decided pair alone SHALL NOT prove answerer delivery, browser display or a PI click. Engineering approval SHALL NOT satisfy #549 PI acceptance.

#### Scenario: Runtime context reflects coder ask without granting

- **WHEN** the public runtime-context assembly and final model-admission refresh run for a delegated coder whose current policy is ask
- **THEN** its admitted delegation explanation permits asking subject to an actual answerer and preserves the sandbox limit
- **AND** it does not claim automatic approval, a user click or universal rejection; an assembly-only intermediate result is not sufficient evidence

#### Scenario: Policy changes between assembly and admission remain truthful

- **WHEN** a delegated coder's explicit policy changes from ask to never or never to ask after assembly but before model admission
- **THEN** the refreshed context reflects the current policy, rather than restoring stale automatic-rejection wording or retaining stale ask wording
- **AND** the sandbox boundary and unrelated runtime-context facts remain unchanged

#### Scenario: Non-coder and never context remains unchanged

- **WHEN** the caller is not a delegated coder or its current policy is never or unknown
- **THEN** this feature does not alter the delegation explanation or other assembled content

#### Scenario: Real child approval transport is separately demonstrated

- **WHEN** engineering validation invokes actual change_submit from a real delegated coder in the installed Web profile using explicitly constructed inert CR/task/patch records
- **THEN** a bound owner answerer actually receives and answers one allowed request and one rejected request, with matching child canonical audit/result and truthful admitted context evidence
- **AND** rejection preserves CR/task/patch bytes, allowed-once alone permits the existing CR transition, and this fixture validation is not reported as scientific changes or human PI acceptance
