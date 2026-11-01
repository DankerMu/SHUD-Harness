## ADDED Requirements

### Requirement: SHUD filesystem permission presets preserve explicit PI approval

The SHUD profile SHALL keep its supported read-only, workspace-write and danger-full-access filesystem modes while configuring each to ask for operations that require approval. The composed default approval policy SHALL also be ask, including startup with full access selected by environment. Selecting full file access SHALL NOT suppress or automatically grant report_submit/report_decide approval. With a Web answerer, the request SHALL reach that answerer and remain undecided until an actual response; only allowed-once permits execution. Rejection, cancellation or absence of an answerer SHALL retain fail-closed behavior. This configuration SHALL NOT broaden role tools, change raw-data rules, alter the host pin or modify non-SHUD profiles.

#### Scenario: Full file access still reaches the PI answerer

- **WHEN** a SHUD Web session selects danger-full-access and a permitted caller invokes report_submit or report_decide
- **THEN** its sandbox mode remains danger-full-access and the required approval reaches the answerer rather than being rejected by a never policy
- **AND** no decision or report acceptance is fabricated while the response is pending
- **AND** only actual allowed-once permits the existing tool execution path

#### Scenario: Other file modes and initial defaults remain usable

- **WHEN** a session selects read-only or workspace-write, or a new SHUD host starts with DSH_PERMISSION_MODE=danger-full-access
- **THEN** its corresponding filesystem mode is preserved with ask, and the configured catalog/default resolve without an unmatched-preset startup failure
- **AND** each supported choice remains available

#### Scenario: Rejected or unavailable approval does not become success

- **WHEN** a required request is rejected or cancelled, or the composition has no answerer
- **THEN** the request is not allowed and the existing report/task/decision write boundary is not bypassed
- **AND** headless execution does not acquire automatic PI approval

#### Scenario: Existing session policy is changed only by explicit selection

- **WHEN** a session with a persisted never policy is restored after the profile update
- **THEN** its historical events and effective override remain intact until the operator explicitly reselects a supported preset
- **AND** selection preserves the selected filesystem mode and records ask through the existing public permission mechanism; repeating the same effective selection is a no-op

#### Scenario: Automatic denial is not manual acceptance evidence

- **WHEN** an explicit legacy/custom never policy automatically rejects a request before UI dispatch
- **THEN** SHUD operator and acceptance guidance identifies it as policy rejection, even if the pinned host's generic text calls it user rejection
- **AND** asked/decided events alone do not prove UI display or a PI click, and that outcome cannot satisfy the manual rejection acceptance scenario
