# Design

## Authority and invariant

Issue #343 PI comments 6397949594/6399764892 choose diagnostics without unsafe recovery and explicitly waive durable RunRecord distinction. A cancelled/lost result alone does not prove the historical group is quiescent; no signal authority can be inferred from a persisted pid/pgid.

## Diagnostic boundary

Keep the R1–R12 classifier unchanged. Use the final decision after the existing R7 exit reread: an exit discovered there becomes R6 and must not warn. Before settlement capture whether this instance already retains recovered group control. After settle returns, read the existing terminal result and warn only for final R7, no retained control, and an actual terminal state, before existing collect. Do not warn on failed or deferred terminal publication.

The retained-control distinction is load-bearing: R8 can establish ownership, then fail an inspection/signal, lose its leader and be classified R7 on retry. Existing cancellation advance still gates terminal publication on group quiescence and may send owned signals. Such a successful settlement must not claim unverified quiescence or no signals. Add only a read-only hasRecoveredControl query over the existing recovered map; capture before settle releases that entry. Do not alter recover/advance/release, add ownership state, or infer control from kind/id strings.

Use a required `(message: string) => void` warning callback supplied by registry from a dedicated `ctx.logger("shud-recovery")` facade, alongside the unchanged existing error callback. There is one ShudPoll construction site. No no-op fallback, warning Set, timer or extra OS group probe. Existing errors remain on their existing route. Terminal publication naturally prevents repeated R7 warnings on later ticks/reloads; a subsequent collect failure must not repeat the warning.

Warning facts: R7, run_id, recorded pid/start identity; recorded wrapper identity is no longer live/matching; historical group quiescence is unverified; no signal is sent to an unowned historical group; descendants may remain and cancelled/lost is not proof of group stop. Do not assert the numeric pid is absent in a reused-identity case, or that an orphan definitely exists. The message describes the reconciliation observation, not an eternal claim that exit evidence can never appear later.

## Operator-visible route

The stock host has no operator-visible runtime logger sink: Cordis defaults to INFO and drops WARN (`vendor/cordis/src/logger.ts:154–156,213–221`); app-boot captures startup warnings but only exposes them on startup failure (`packages/boot/app-boot/src/index.ts:1207–1264`). Neither a test exporter nor merely raising the facade level satisfies actual diagnostic delivery.

Mount one small exporter through public `ctx.logger.exporter()` in the registry, before reconciliation. It writes only the dedicated recovery facade's messages to existing stderr through asynchronous `node:fs.write(process.stderr.fd, line, callback)`, using the publicly exported `Logger.format`; no console calls, new dependency, file, session message or host edit. Register at WARN threshold (2, the public Cordis WARN level); filter by explicit facade name AND its public `LoggerOptions.meta.fiber` identity, not a guessed Loader/class-derived name or private symbols. Other instances/facades and all existing error callbacks remain untouched. The metadata WeakRef belongs to the captured facade and is copied unchanged into its messages by Cordis; this permits an exact identity filter without private context plumbing.

The exporter is an effect removed with its plugin fiber (`LoggerService.exporter`, lines 227–237). Verify real output, isolation and disposal behavior, not exporter-map wiring. Format a single controlled timestamped WARN line containing only the validated run/process identifiers and fixed diagnosis. No arbitrary exceptions, raw contents or credentials flow to this new route. Do not add run paths merely for convenience.

Each diagnostic gets one asynchronous fd-write attempt. Its callback owns that write's failure; a closed pipe/descriptor loses the diagnostic without an unhandled stream error or host termination. No global stderr error listener, synchronous blocking write, retry, fallback channel, timer or circuit-breaker state. Short/failed writes share the accepted log-loss boundary; they do not change durable state or interrupt collection. A later eligible diagnostic can still attempt its own write.

Rejected alternatives: process-wide forwarding widens log egress and risks exposing arbitrary plugin payloads; vendor logger-console writes stdout and requires another dependency; changing severity does not create a reader; emission-only weakens the PI-approved actual-log criterion. This is a sink for the chosen public Cordis logging seam, not a second job-event/notification path. Other existing host logs remain outside this issue.

## Known diagnostic limits

No new durable marker or evidence file. A crash after terminal publication but before warning, unavailable stderr, or later log loss can erase this distinction; a subsequent terminal-record recovery cannot reconstruct it. RunRecord and notification payloads remain unchanged and cannot distinguish R7 from proven-group cancellation permanently. PI explicitly accepts this tradeoff. The documented operator route is the host process's stderr, not a Web log panel. Do not call the warning a leak fix or claim full OS/Web restart proof from same-host registry replacement.

## Tests and runtime proof

Extend existing R7 dead/reused identity cases with and without cancellation: observe actual stderr output, assert contextual facts and existing no-signal/classification/evidence checks. Prove unrelated logger payloads and another facade's same-name message are not forwarded; after disposal the old sink emits nothing, and a replacement emits exactly one matching diagnostic. On later ticks/reload/collect retry the warning does not repeat. Add or extend R6 second-read control to prove no warning when exit wins; R3/R5 and genuine R8 controls retain no orphan warning. Reuse existing retained-R8 fault/leader-loss case to verify no false warning while quiescence is still enforced.

Retain a real child-process regression with a readiness handshake before closing the parent stderr reader or child descriptor: healthy emission delivers a warning and survives; closed-pipe emission and closed-descriptor emission survive without uncaught errors; closed-pipe/no-emission is the negative control. The first implementation's process.stderr.write route empirically crashes with EPIPE, so a successful-write spy is not sufficient evidence.

Extend the existing Darwin resistant-descendant registry-replacement case: old recorded wrapper gone, descendant remains live, stderr warning present, no new recovery signals, unchanged cancelled RunRecord; owned test cleanup still terminates its group. Linux same test remains R8 with proven quiescence and no warning. Parent also runs a standalone native same-host replacement/stderr smoke, full check, profile smoke and shud:restart; distinguish the real Web restart gate from the targeted R7 smoke, neither is PI acceptance. No permanent notification-wording or wiring tests; unchanged notification code plus existing state/transport tests are the compatibility evidence.

## Documentation and scope

M2 D11/R7/spec and Park_Resume_Design explicitly record accepted residual/log-only limits and safe operator investigation (verify identities before intervention, never bare historical pgid signals). Update current instruction references that call #343 undecided and render projections. Preserve checked historical task lines; append dated follow-up evidence if needed. Post the semantic boundary to #293/#318 acceptance tracking without marking PI passed. No R1–R12 action, R8 control, RunJob/RunRecord schema, notification-state/text, solver or host changes.
