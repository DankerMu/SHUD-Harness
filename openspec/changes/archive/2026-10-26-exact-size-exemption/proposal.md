# Proposal

## Why

Issue #368 demonstrates that comma serialization loses PR label boundaries. The actual current CLI accepts the single label `x,size-exempt` as an exemption and emits the truthful-exemption log despite no exact member. The parent has saved this failing-before observation, plus true-exemption and empty controls.

## What Changes

Pass GitHub's label-name array as PR_LABELS_JSON using toJSON, and make the existing size script test exact case-sensitive array membership with the already-required jq. Migrate the guardrail self-tests and encoding comment in one clean cutover; no old-format fallback. Preserve threshold, triggers, permissions, aggregate checks, exclusions and bypass message.

## Capabilities

### Modified Capabilities

- `engineering-gates`: size exemption is exact label membership, never a delimiter-induced substring match.

## Impact

Only ci.yml's label environment binding, pr-size.sh's label decoding/comment, and the adjacent guardrail self-proof cases, plus this fixture. No live label creation/probe, package/runtime/host changes or branch-protection edits.

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; shared CLI and CI gate configuration.
Blast radius: whether an oversized PR passes and whether its bypass audit message is true.
Selected risk packs: Public API / CLI / script entry; Config / project setup; Schema / columns / units / field names; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: actual CLI failing-before reproduction, persistent self-test RED then GREEN, exact exit/log/summary boundary probes, full check and test-guardrails, exact-head CI.
