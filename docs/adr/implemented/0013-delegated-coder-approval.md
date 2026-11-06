---
status: accepted
kind: architecture
---

# ADR-0013: Bounded delegated-coder approval initialization

## Authorization and scope

[#614](https://github.com/DankerMu/SHUD-Harness/issues/614) records the PI's [bounded public-seam opt-in decision](https://github.com/DankerMu/SHUD-Harness/issues/614#issuecomment-6647569703). The pinned host remains dsh 0.2.1-rc.2. This decision does not authorize a host upgrade, a grant, generic policy propagation, or replacement of #549's independent PI acceptance.

The separately exported `@shud-harness/dsh-shud-presets/coder-approval` plugin is globally mounted as `shud-coder-approval`. Role restriction, four preset subtrees, headless disabled flags, tool masks, raw immutability, CR/report admission and sandbox configuration remain separate and unchanged.

## Initialization boundary

Only awaited `agent/created` with source `startup` may initialize a child. The public live registry must identify the exact child and parent and confirm exact ownership. The child must currently be coder, have unseeded subagent metadata with matching lineage/depth, no inherited prefix or prior turn, and exactly one own policy event: delegation-origin never. Its current public approval service must still resolve never. Missing capabilities or provenance cannot authorize a write.

The parent's public approval override, otherwise its explicitly configured policy, must resolve ask at the final synchronous write boundary. This is SHUD-authorized publication-time initialization, not an assertion about a pre-await parent approval snapshot that the host did not record. A parent changed to never during creation stays closed. The host permits missing depth metadata for top-level agents: SHUD accepts that as zero only when the parent's origin and parentSession are absent and its runtime options do not deepen or invalidate that depth. The child's explicit depth must still be parent depth plus one; no internal depth helper is imported.

A host-only projection registered through `sessionProjections.register` retains the inherited boundary, saturated policy count, whether a turn began, and latest policy/source/sequence. `stateOf` materializes setup-window events. Production does not scan raw Session history, use experimental `appendPluginRecord`, or introduce a persisted Session event family.

The public initialization setter appends ask without the user-attributed notice produced by `setPolicy`. `createUserMessage` and `Agent.inject` deliver a distinct `shud-coder-approval` notice with child policy sequence and parent identity/current ask observation. It identifies initialization, not an approval, user switch or PI click. If writing or notice publication throws, creation fails. Rollback appends never only while the latest policy sequence is this attempt's ask; an intervening external policy is not overwritten. Original and rollback failures remain observable together.

Initialization is once per live Agent. There is no automatic re-enable on restore, clear, compact, role selection, plugin reload or disposal. Later explicit policy wins. Removing the plugin stops future initialization but does not rewrite persisted policies; existing host policy controls remain the operator's explicit mechanism for changing those sessions. Registrations and listeners are Cordis effects; disposal does not rewrite user history.

## Model-visible runtime context

The PI's [second context-ownership decision](https://github.com/DankerMu/SHUD-Harness/issues/614#issuecomment-6649912974) replaces the initial dynamic-SHUD-provider and literal-never-fallback design with policy-independent delegation guidance. A completed accepted assembly can outlive plugin disposal or remount: an absent provider preserves stale accepted text, while a new provider instance cannot recover another instance's original-text map. The resolution is to remove SHUD's duplicate mutable policy/role assertions and original-text state, not retain registrations, cache assemblies, cancel preparation, or change the host.

For delegated coders only, the public assembly waterfall replaces an accepted `subagent:delegation` entry with the distinct static `shud-coder-approval:delegation` entry, preserving position and metadata. It describes the fixed sandbox and inability to widen it autonomously. Approval guidance is conditional: when the host policy permits asking, an available answerer and allowed-once are required; it never declares the current policy or role, grants an action, or claims a PI click. The host's existing `approval:policy` provider alone supplies the current ask/never value during admission refresh. Thus the same accepted static explanation remains truthful across policy changes, disposal and remount without a SHUD provider or cache. Inactive callbacks, missing host entries and non-coder assemblies return the downstream assembly unchanged; other contexts remain untouched. Tests must retain the same completed assembly across lifecycle changes, and real Web evidence must inspect the admitted canonical runtime-context message. All initialization, explicit/restored-never, business-write and PI-acceptance requirements remain unchanged.

## Exact named import boundaries

This is a narrow extension to [ADR-0006](../implemented/0006-dsh-jobs-seam-imports.md), not a package-wide permission change.

- Only `packages/dsh-shud-presets/src/coder-approval.ts` may import the named runtime `setApprovalPolicy` from `@deepseek-ai/dsh-user-approval`. The already sanctioned `createUserMessage` capability remains unchanged.
- `packages/dsh-shud-policy-gate/src/approval/test-harness.ts` becomes the **sole** canonical location for the constructors previously granted to `full-access-approval.test.ts` by [ADR-0012](0012-full-access-approval-test-seam.md): `PermissionPresetService`, `ApprovalService`, `SessionStore`, `SessionProjectionRegistry`, and `SystemPrompt`, each from its corresponding public package. The old exact-file exception is removed, not retained as a compatibility alias.
- Default, namespace, other named, side-effect and empty imports remain forbidden. Other files, tests, same-basename paths and host internal subpaths receive no constructor/setter permission. Checkout imports remain prohibited even for types. Declaration-level type imports retain the existing rules.

The canonical harness preserves the profile-derived defaults, actual approval request dispatch, ToolRuntime composition, fixture tools, cancellation/watchdog cleanup and existing full-access callers. Its new consumer uses real change_submit and a held real answerer. Agent identity/registry ownership and inbox delivery are external doubles, not a claim of actual manager creation; separate installed Web evidence supplies that lifecycle proof.

Presets directly pins `zod` 4.4.3 solely for its bounded host-only projection schema, matching the exact Zod dependency exposed by the pinned public `dsh-session-projection` API. The workspace/root and core domain schemas remain on 4.6.7; their schema contracts are unchanged. The projection registration supplies explicit key/state generics to bound overloaded schema inference. This package-specific compatibility requirement uses ordinary package resolution, not physical host paths, aliases, casts, suppressions or increased compiler heap limits. It introduces no new host package tree, npm dsh install, automatic peer installation or host pin change. The parent workflow updates the lockfile and runs dependency commands.

## Evidence and operational limits

The first implementation tranche adds one held change_submit tracer: business files remain unchanged before allowed-once, then only the existing CR approval transition writes approved/approval_ref. The existing full-access suite continues using the extracted composition. This ADR records contracts, not unrun GREEN results. The parent owns focused verification, remaining lifecycle/error/context matrices, import guardrail self-tests, profile smoke, build and real Web allowed/rejected evidence under the [expanded fixture](../../../openspec/changes/archive/2026-11-05-delegated-coder-approval/tasks.md).

Ask is permission to request a decision, never permission to execute. Absent/unavailable/cancelled/rejected answerers remain fail-closed. Global mounting does not grant headless approvals. Child approval transport is associated with the child session; HTTP/WS answerer evidence is not browser rendering, a human click, scientific correctness, or #549 PI acceptance. #547 remains dependent on completing #614's full fixture, including real admission-time context and transport evidence.

## Acceptance record

The PI explicitly accepted this record on 2026-11-06 during the post-M4 cleanup; it moved from `proposed/` to `implemented/` (status `accepted`). Acceptance confirms only the decision and boundaries recorded here; it does not ratify any acceptance evidence, widen the stated scope, or replace any Epic's PI functional acceptance.
