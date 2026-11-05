# Proposal

## Issue fixture

Issue: [#614](https://github.com/DankerMu/SHUD-Harness/issues/614), prerequisite of M4 #547; issue type: feature.
Fixture level: expanded; upstream level absent; permissions, persisted policy and host lifecycle require expanded evidence.
Blast radius: accidentally making a non-authorized child ask-capable, false approval provenance, lost fail-closed behavior, or misleading model context.
Selected risk packs: Public API; Config; Internal projection/source schema; Auth; Ordering/shared state; Compatibility; Error handling; Packaging; Documentation.
Evidence floor: real ApprovalService/ToolRuntime RED/GREEN, real Web delegated-child allowed/rejected evidence, focused lifecycle cases, default check/profile smoke/guardrails, strict fixture validation and three-seat review.
PI selected bounded public-seam opt-in in [comment 6647569703](https://github.com/DankerMu/SHUD-Harness/issues/614#issuecomment-6647569703) and explicitly authorized policy-neutral delegation wording in [comment 6649912974](https://github.com/DankerMu/SHUD-Harness/issues/614#issuecomment-6649912974); neither decision authorizes a host upgrade, cancellation or grant.

## Why

Pinned dsh gives every delegated child a durable `never` policy, so a coder's required ask is rejected before any Web answerer. The original raw-read probe established that boundary; the subsequent #614 real Web tracer also observed actual `change_submit` being rejected before its ready answerer, leaving constructed inert CR/task/patch bytes unchanged. Neither probe represents scientific changes or PI acceptance. M4's coder approval needs the explicitly authorized, bounded opt-in before #547 can be implemented.

## What Changes

- Add a separately named, globally mounted SHUD coder-approval plugin in the existing presets package. At the awaited creation boundary only, initialize a provably fresh, unseeded, owned coder child from its sole delegation-origin `never` to `ask` when its live parent explicitly resolves to `ask`.
- Read policy provenance and freshness from a registered host-only projection, not deprecated synchronous historical readers. Read the parent's public approval override/config at the opt-in boundary; do not claim to inherit an unrecorded pre-await parent approval snapshot.
- Use the public initialization setter and a SHUD-sourced notice, never a fabricated user switch or approval. Reconcile the coder's current ask policy with the host's otherwise unconditional automatic-rejection runtime-context text through the public assembly seam.
- Keep this a one-time initialization rule, not policy synchronization: no automatic opt-in on restore, fork/seed, preset switch, clear/compact or plugin reload. Do not rewrite explicit policy overrides or unrelated roles, parent policy, sandbox modes, tool masks or grants.
- Reuse the existing real approval integration harness through one canonical extraction, add consumer-visible approval/lifecycle regression cases, and mechanically constrain the necessary named import exceptions. Record the policy/import decision and operator evidence boundaries.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-presets`: add bounded fresh delegated-coder approval initialization and its evidence/preservation contract. Existing M4 role composition and M3 first-task requirements are unchanged.

## Impact

Production: `packages/dsh-shud-presets/` plugin, projection, export and dependency declarations as needed; `profile/shud/cordis.patch.yml` global mount; existing profile-smoke assembly assertion.
Verification: canonical real-service harness extracted from `packages/dsh-shud-policy-gate/src/full-access-approval.test.ts`, delegated-coder tests, exact-path `eslint.config.mjs` import rules and guardrail self-tests.
Documentation: proposed ADR-0013 for this authorized policy and narrow import boundary, affected existing profile/operator docs, and this fixture. No host checkout imports/edits or new host runtime dependency tree; retain rc.2 pin and frozen-lockfile behavior.
Non-goals: #547 replay driver, #548 gate registration, #549 PI acceptance, solver execution, changing CR/report admission rules, automatic grants, approval retries, or general child permission inheritance.
