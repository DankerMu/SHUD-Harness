# Proposal

## Why

During #452 PI acceptance, selecting full modification permissions caused report_submit to be rejected without displaying a card. The pinned host couples danger-full-access with approval never, then labels its automatic rejection as a user rejection. PI explicitly made #511 a blocker and requires full filesystem access and business PI approval to coexist (issue comment6558447083).

## Triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded for production permission configuration and approval integrity.
Blast radius: report approval reachability, persisted session policy, headless fail-closed behavior.
Selected risk packs: CLI; Config; Auth/permissions; Concurrency/state; Error handling; Documentation; Dependency compatibility.
Evidence floor: real host permission/approval services with semantic red/green, preserved denial behavior, full check/profile smoke, isolated real Web/full-access first-task evidence, exact-head white-box review/CI and later PI re-verification.

## What Changes

- Override only SHUD bundle's documented approval and permission configuration: global default ask; preserve read-only, workspace-write and danger-full-access filesystem modes, all with ask.
- Preserve the existing full-access selector rather than add a second parallel preset or rewrite host internals.
- Add behavioral regression coverage using real public host services, and operator guidance distinguishing file permissions from business approval and automatic policy rejection from a PI click.
- Keep historical session policies immutable; explain explicit preset reselection after upgrade and verify this transition.

## Capabilities

### Modified Capabilities

- `shud-profile`: add full-filesystem permission with explicit PI approval, default/configuration and existing-session boundaries.

## Impact

Profile configuration, focused policy integration tests and necessary pinned test-only public peer closure, a separate proposed ADR and narrow test-file import authorization with guardrail coverage, existing operator documentation/project profile. No role-tool expansion, policy-gate bypass, report schema/state-machine change, host edit/upgrade or M3 PI-acceptance/ADR promotion. The test-seam decision revisits ADR-0006 without expanding production import permissions. Any test dependency must state why existing mocks cannot cover the actual preset-to-approval path.
