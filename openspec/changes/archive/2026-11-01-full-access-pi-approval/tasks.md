# Tasks

## 1. Full access with explicit approval

- [x] 1.1 Add one semantic regression using the actual public host permission/approval path and current SHUD configuration; parent observes RED because full access rejects before the answerer, not because setup/import fails. Record necessary pinned test dependency rationale and a separate proposed ADR for the test-only public seam; authorize only required named imports in the focused test file, with positive/negative guardrail cases preserving production and internal-host denials.
- [x] 1.2 Configure only SHUD approval/permission rows, preserving all three filesystem modes with ask and an ask startup default; extend behavior coverage for both report names, held response, allowed/rejected/cancelled/unavailable, old never restoration and explicit reselection. Parent focused tests GREEN; existing decision tests unchanged.
- [x] 1.3 Update existing operator documentation and project-profile risk note with mode matrix, explicit legacy-session reselection and policy-versus-human rejection distinction; no host, role, report-schema or PI-acceptance change.

## 2. Engineering gate and acceptance resumption

- [x] 2.1 Parent full check, test-guardrails, profile:smoke and strict fixture validation PASS; independent real Web/full-access first-task evidence proves actual effective mode and approval round trip, with no writes or approval in the PI workspace. Preserve secrets and clean owned probe resources.
- [x] 2.2 Complete expanded correctness/evidence/invariant white-box review, exact-head CI and normal merge; independently archive this fix only. Rebuild/restart the preserved PI environment and request explicit full-access reselection/A7 re-verification; never mark #452/#423 accepted or archive M3 from engineering evidence.

Engineering closure: PR #512 merged as `10df8dddde27cead4f829989b139aecb985c5b00`; three-seat round 1 CLEAN and exact-head CI `41316081503` passed. The preserved PI environment was rebuilt/reinstalled and restarted; authenticated HTTP returned 200, and report/Markdown/task hashes remained unchanged (reviewed, no decisions, reporting). Explicit full-access reselection and the single A7 prompt were requested. This independent fix archive does not record a PI verdict or close #452/#423; A7 and later manual items remain pending.

## Risk pack mapping

- Selected Public API/CLI: public host permission selection and actual approval/request seam, full-access Web probe (1.1–2.1).
- Selected Config/project setup: both global rows, three modes, environment default and profile smoke (1.2,2.1).
- Selected Auth/permissions/secrets: no automatic approval, unchanged raw/role guards, no-answerer and denied outcomes, secret-screened isolated proof (1.1–2.1).
- Selected Concurrency/shared state/ordering: held approval, immutable old session history and explicit durable reselection; no decision before answer (1.2).
- Selected Error handling/partial outputs: policy auto-rejection distinguished from PI clicks, fail closed with no answerer, no report/task bypass (1.2–1.3).
- Selected Documentation/migration: supported matrix, legacy overrides, user-owned patch preservation and manual acceptance boundary (1.3–2.2).
- Selected Release/dependency compatibility: only pinned public test peers if required, unchanged host and autoInstallPeers; frozen lock/full gate (1.1,2.1).
- Not selected File IO/path safety/overwrite: no production writer changes; existing report/input/installer byte boundaries remain intact and owned probe cleanup is covered by 2.1.
- Not selected Schema/columns/units: no domain schema or report field changes.
- Not selected Resource limits/discovery: no new scheduler, discovery or configurable budget.
- Not selected Legacy compatibility/examples as a separate pack: explicit prior-session policy transition is already covered by Config/Concurrency/Documentation, with no compatibility shim.
