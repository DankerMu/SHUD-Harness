## ADDED Requirements

### Requirement: Registry construction requires resolved cadence

The registry SHALL consume the cadence resolved through its Cordis configuration schema without a separate default lookup. Plugin input SHALL retain optional parent configuration keys and existing defaults. Construction with a missing or non-positive-safe-integer cadence SHALL fail before acquiring state ownership or publishing a jobs service, with a diagnostic requiring parsed configuration. This guard SHALL NOT establish direct construction as a supported configuration path. Submission, execution and polling SHALL continue sharing the same resolved cadence.

#### Scenario: Unresolved direct construction is rejected

- **WHEN** a direct caller omits the cadence or supplies zero or a fractional value
- **THEN** construction fails at the explicit parsed-configuration precondition without publishing jobs or acquiring state ownership, rather than silently synthesizing one parent default

#### Scenario: Plugin configuration remains authoritative

- **WHEN** Cordis constructs the registry using default or explicit valid parent configuration
- **THEN** the parent schema's resolved cadence is consumed unchanged by submission, execution and polling, with no new keys, defaults or required plugin-input fields
