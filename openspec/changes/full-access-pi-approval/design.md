# Design

## Context and invariant

Source and canonical-session evidence confirm the cause; do not rerun PI's failed operation to establish it. Existing SHUD policy-gate correctly returns ask. Host approval never rejects before UI dispatch, although it writes asked/decided and uses a generic user-rejected diagnostic. Source evidence and PI decision are in #511/comment6558447083.

Change surface: profile/shud/cordis.patch.yml; focused policy integration test(s), pinned test-only dependency closure if needed; narrowly scoped ESLint test imports and their guardrail cases with a separate proposed ADR revisiting ADR-0006; existing Repository_Layout operator guidance and project-profile risk note.
Governing invariant: filesystem permission never becomes authority to accept or reject a scientific report on PI's behalf.
Must preserve: actual sandbox mode per preset, raw immutability/provenance asks, role-tool maps, report ask and only allowed-once execution, report/task/decision ordering, no-answerer fail closed, user-patch ownership, exact host pin and existing CI gates.
Sibling surfaces: host approval default, composed permission catalog, environment-selected startup default, current session projection and durable overrides, restored old sessions, Web answerer and headless absence, report_submit/report_decide.
Non-goals: dsh code/diagnostic modification, auto-review, automatic approvals, generic retries, runtime role expansion, historical-log rewriting or M3 PI closure.

## Decisions

Patch the existing global rows by their real ids: approval and permission. Set approval.config.policy to ask; explicitly retain the actual base catalog's three presets (read-only/workspace-write/danger-full-access), pairing each unchanged sandbox value with ask. The whole config is replaced by an id patch, so a partial presets object would incorrectly remove choices. The global default override is required as well: base approval derives never from DSH_PERMISSION_MODE=danger-full-access; keeping it would make the inferred default unmatched against an all-ask catalog.

No new preset alias or SHUD listener changes. The same full-access selection now requests business approval. Scope is this SHUD bundle only; explicit user overrides remain user-owned. Existing never overrides are not silently changed: restore preserves history and may display custom; selecting the supported preset through the public permission seam appends the changed policy. This is an explicit transition, not a migration that fabricates PI events.

Regression tests must consume the actual SHUD configuration and real public PermissionPresetService, Session/Projection and ApprovalService behavior. A held approval/request answerer proves dispatch and pending state rather than merely asked logging. Both report tool identities must reach it under full access; allowed-once, rejected/cancelled and unavailable outcomes retain their established meanings. Existing report-decision runtime tests remain unchanged and continue proving no writes without permission. Do not add mock approval.request echoes or source-text checks as the sole proof.

Use existing package/test conventions. Real public permission/approval/session/projection imports currently fall outside ADR-0006. Record the new test-only seam in a separate proposed ADR; authorize only the required named capabilities in the focused test file, retain production and host-internal import denials, and add positive/negative test-guardrails cases. Minimal pinned public test dependency closure is allowed; no npm dsh host dependency or autoInstallPeers change. Do not expand the 999-line profile-smoke script for unrelated cleanup; existing smoke plus focused behavior coverage and the isolated full-access Web run form the gate.

## Verification and migration

Parent observes one new semantic regression RED before configuration change, then GREEN with full-access still the selected sandbox and a real pending answerer. Cover all three mode switches, environment-selected full-access startup, old durable never preserved until explicit reselection, repeated selection behavior, rejection/cancellation and no-answerer fail closed. Keep original error capture immutable.

Run pnpm check, test-guardrails and profile:smoke on the final change. Run shud:first-task in an independent scratch workspace/home with DSH_PERMISSION_MODE=danger-full-access; inspect actual permission/approval events and successful report decision, not only process exit or dump-config. If the existing probe overwrites the mode, use its existing public driver with a small disposable verification procedure; do not weaken its oracle. Automated approval is engineering evidence only and must never touch the live PI report.

Stop the old PI host before rebuilding/restarting its environment, preserving input/report/task/session bytes and recording cancellation of any pending request as system teardown, not PI rejection. After engineering merge, reinstall/restart the same PI home and workspace, have PI explicitly select the fixed full-access preset, and repeat A7/A8. A1–A6 remain recorded; #423/#452 and M3 archive remain blocked until PI actually completes acceptance.

## Risks and containment

A user may deliberately retain/override never; document its automatic denial and generic host message without calling it a PI click. Headless has no human answerer and must not gain automatic approval. New configuration does not change raw/role policy priority. On failure leave reviewed report/history untouched and keep the acceptance gate blocked; no fallback to automatic allow or readonly-host patching.
