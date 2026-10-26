# Tasks

## 1. Exact-membership cutover

- [x] 1.1 Exercise the real current --count CLI with comma-bearing, exact and empty legacy-encoded label arrays; retain the observed false bypass and controls without creating GitHub labels.
- [x] 1.2 Update the existing positive self-test to PR_LABELS_JSON and add the comma-name negative before implementation; parent runs test-guardrails to observe the new positive's RED state against the old consumer.
- [x] 1.3 Migrate workflow producer and script/comment together to JSON array membership; add remaining boundary/exit/log cases, prove GREEN with actual CLI probes and complete test-guardrails; preserve all policy and audit wording.
- [x] 1.4 Run full check and verify no old PR_LABELS consumers, threshold/exclusion/trigger/permission/aggregate changes, or package/host edits.

## 2. Delivery

- [ ] 2.1 Complete expanded review and exact-head CI; post red/green evidence distinguishing old-encoding defect reproduction from new-format negative cases.
- [ ] 2.2 Merge and archive only this completed gate change, preserving active M2 acceptance.

## Risk mapping

- Selected Public API / CLI / script entry → 1.1 actual CLI RED; 1.2–1.3 public self-proof/probes.
- Selected Config / project setup → 1.3 producer/consumer cutover, 1.4 policy preservation, 2.1 actual CI.
- Selected Schema / columns / units / field names → 1.3 JSON array/exact names and retired variable, 1.4 caller audit.
- Selected Error handling / rollback / partial outputs → 1.3 malformed/non-array fail-closed and no false log/summary; no new exit-code protocol.
- Selected Documentation / migration notes → 1.3 encoding/case comment; 2.1 evidence and unchanged policy docs.
- File IO / path safety / overwrite, Auth / permissions / secrets, Concurrency / shared state / ordering, Resource limits / large input / discovery, Legacy compatibility / examples, Release / packaging / dependency compatibility not selected: no new paths/permissions/runtime/dependencies, clean internal transport cutover, existing jq prerequisite and policy retained.
- Scientific governance / PI gate / evidence lineage, Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility, dsh seam / profile / outbound-channel governance not selected: engineering label audit only, no scientific/run/model/seam change or PI acceptance.
