# Design

## Context and invariant

Cordis invokes the existing ShudJobRegistry.Config validator before construction. That validator delegates the caller's parent fields to the parent schema and returns its resolved values. The extra constructor fallback validates an empty parent config, fills only one local value and leaves the actual parent constructor input unresolved. It has no supported consumer.

## Decision

Remove resolvePumpPollMs entirely. At its current constructor callsite, after existing SHUD/path preflight and before StateIndexStore/super, bind `config.pumpPollMs` once and assert `typeof value === number`, `Number.isSafeInteger(value)` and value >= 1. The diagnostic names pumpPollMs and requires ShudJobRegistry.Config/Cordis-resolved configuration. Keep a short accurate precondition comment, not a promise of direct-construction support. No replacement lookup helper, default literal, whole-config revalidation, required Config property or cast that bypasses narrowing.

## Must preserve

The static Config wrapper still performs the sole parent validation with caller fields. Parent input keys remain optional and all parent schema defaults/unknown-key validation remain unchanged. The same local cadence goes to ShudSubmissions and ShudPoll; execution receives it through the existing third producer argument. All downstream signatures, timers, pollOnce joining, cleanup waiting and parent limits stay untouched. Unsupported direct construction with other incomplete parent fields is not newly supported by supplying only pumpPollMs.

## Evidence

Add one table-driven constructor negative for omitted cadence, zero and a fractional value: the new precondition is diagnostic rejection, not a later parent/runtime failure. It must occur before jobs publication/ownership artifacts; the fixture must clean up the old implementation if it unexpectedly constructs during RED. Existing plugin defaults/configured cadence tests and actual native polling tests stay unchanged and pass. Parent retains semantic RED, then runs focused registry/poll lifecycle and full check. A built-module negative smoke and real profile startup exercise the changed rejection and supported path.

## Sibling surfaces and scope

Only registry.ts owns the partial lookup. Audit constructor consumers and downstream cadence owners; no direct construction exists except the new deliberate misuse test/smoke. Current instruction source, docs/04_IMPLEMENTATION/Repository_Layout.md and openspec/project-profile.md attribute resolution to the registry: update these three current descriptions to consuming Cordis-resolved cadence and render instruction projections. Audit matching sibling wording for consistency. Pending M2 already says already-resolved; no history rewrite. No new validation API, timing config/default, host edit or scientific decision. Archive only this independent requirement; M2/#293/#318 remain pending acceptance.
