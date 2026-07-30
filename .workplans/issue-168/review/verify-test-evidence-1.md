# Verifier — test-evidence-1

Reviewed head SHA: `89eb2aad7895d837617d243a8ce82e3cdc45b211`

- `ev-01`: **CONFIRMED / FIX_NOW** — exact-head CI runs omit the focused
  contracts suite on both Linux and macOS, so the mandatory platform proof is
  absent.
- `ev-02`: **CONFIRMED / FIX_NOW** — observer callbacks, unchanged bytes, and
  partial source regexes cannot independently detect an unreported ambient
  open, replacement read, write, or spawn.
- `ev-03`: **CONFIRMED / FIX_NOW** — the suite exercises depth 13 rejection but
  not legal depth 12; an `>=` regression survives.
- `ev-04`: **CONFIRMED / FIX_NOW** — removing multi-key sorting changes exported
  canonical bytes while every current self-repeat/one-key assertion stays green.
- `ev-05`: **CONFIRMED / FIX_NOW** — the recorded missing-module red run fails
  at loading and does not execute the behavioral assertions against compiling
  semantic mutations.

All five pass reachability, observable-boundary, and OpenSpec-oracle tests. The
overlap between mutation controls does not make the underlying evidence
obligations duplicates.
