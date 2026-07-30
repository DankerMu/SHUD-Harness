# PR #170 Round 1 — test and evidence coverage

Reviewer agent: test-evidence
Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`
Summary: Four blocking evidence candidates remain.

## Findings

### P1 test-evidence — mandatory Darwin/Linux focused suite is not CI-gated

`linux-base` runs `bun run check` and `macos-seatbelt` runs policy-gate tests; neither command includes the new contracts suite. Required proof is exact-head Ubuntu and macOS execution of the pinned focused command with descriptor stress.

### P1 test-evidence — boundary tripwires are self-reported

The open observer sees only explicit implementation callbacks; unchanged replacement bytes do not prove they were unread; no-write checks only input files; no-child/no-write uses source regex. An unreported absolute open/read/write/spawn can remain green. Required proof is independent OS-boundary interception with fault controls for each prohibited action across both kinds/scenarios.

### P1 test-evidence — canonical JSON lacks a fixed byte oracle

`admitSourceInput` is compared with itself and the only literal uses one key. Removing multi-key sorting can remain green. Add a public representative noncanonical-input fixture with exact committed canonical bytes and a mutation proving the assertion bites.

### P1 test-evidence — red proof fails at module loading, not behavior

The recorded run removed all implementation modules, yielding `0 pass, 2 fail, 2 errors`. It cannot show the 19 behavioral tests detect semantic regressions. Use compiling source-only mutations and record named failures for each requirement group, then restore the identical green tree.

Invariant matrix: receipt/schema/capacity/four-SHA rows covered locally; Linux, independent path/write/process evidence, canonical byte oracle, and behavioral red proof missing.
