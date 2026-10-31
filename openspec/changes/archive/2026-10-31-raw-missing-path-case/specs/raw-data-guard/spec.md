## ADDED Requirements

### Requirement: Missing path case identity

Raw path containment SHALL preserve native resolution of existing components, symlinks and parent traversal. When missing components create a plausible protected-path overlap differing only in ASCII case, the guard SHALL use read-only evidence of the nearest existing directory's own namespace to distinguish aliases from distinct paths. It SHALL NOT infer that namespace from the OS name, the directory entry in its parent, or a global case-insensitive path comparison. Existing canonical text and shell-text matching rules remain unchanged.

Confirmed aliases SHALL obey the same raw policy as their ordinary spelling. Confirmed distinct paths SHALL remain distinct. If the plausible overlap cannot be resolved safely, the guard SHALL deny before execution and approval with a controlled unavailable-path diagnostic; it SHALL NOT treat uncertainty as evidence of distinctness. This PI-approved fail-closed rule includes empty or otherwise unprobeable sensitive namespaces. Ordinary exact containment and unrelated component prefixes SHALL retain their existing decisions.

The correction SHALL have one raw-guard owner and apply to its existing path-containment consumers without changing their target sets or writer policy. The guard SHALL NOT create probe files, read raw file contents, retain cross-call sensitivity caches, or leave directory handles open. Additional namespace inspection SHALL be bounded. Shared core path containment and jobs/tools/records writers SHALL NOT gain a duplicate raw policy.

#### Scenario: absent fixed-output aliases on an insensitive namespace

- **WHEN** a case-insensitive namespace is established from its own entries, the configured raw root is absent RUNS, STACKS or PROVENANCE, the corresponding lowercase output is absent, and shud_run input is unrelated
- **THEN** pre-execute returns raw-immutable deny, with zero tool execution or approval and no output creation

#### Scenario: existing aliases and same-case absence stay protected

- **WHEN** an insensitive namespace already contains a lowercase fixed output and raw configuration uses its uppercase alias, or absent raw and output paths use the same spelling
- **THEN** the existing raw-immutable denial remains and no directory or record is changed

#### Scenario: proven sensitive spellings stay distinct

- **WHEN** the nearest existing namespace is proven sensitive, raw RUNS and output runs are distinct, and input is unrelated
- **THEN** the guard delegates; this also holds at a sensitive mount root below an insensitive parent

#### Scenario: uncertain case collision fails closed

- **WHEN** prospective raw and target paths plausibly overlap by ASCII case but the namespace is empty, has no usable bounded entry evidence, is unreadable, or the entry evidence changes during inspection
- **THEN** the guard returns a controlled deny without approval or execution, even if that unproved namespace happens to be case-sensitive

#### Scenario: aliases are not inferred from entry indirection

- **WHEN** alternate-case names are separate symlinks or hardlinks, or lookup evidence cannot distinguish those entries from filesystem case folding
- **THEN** that indirection is not accepted as proof of case folding; unresolved plausible overlap denies rather than passing through

#### Scenario: native traversal and sibling boundaries remain

- **WHEN** cwd or raw paths traverse an existing symlink followed by parent traversal, or a candidate is only a sibling such as runsx
- **THEN** native physical traversal and component containment still determine the decision; a shared lexical prefix alone does not protect the sibling

#### Scenario: shared path consumers retain policy and lexical text

- **WHEN** the same missing alias appears in task_create, report targets, file writes, shud_run input/task targets, or shell workdir/archive containment
- **THEN** the single path owner resolves it under the same rules while preserving each consumer's target set, exact canonical shell text, and the separate shell lexical mention/ancestor contracts

#### Scenario: independent decisions acquire fresh evidence

- **WHEN** one decision has completed and the directory namespace changes before a later decision
- **THEN** the later decision uses current evidence, no prior sensitivity cache, and every opened directory handle is released on success and failure
