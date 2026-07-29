# Phase 5/6 invariant closure — index parser

PR: #167
Reviewed SHA: `3a61a5449aae4620189d18112d5c2e9f066b1ec3`
Verified finding: `cand-6-2-v4-01` — CONFIRMED / FIX_NOW, P1 `compatibility`.

Invariant: every admitted checksum-valid Git index used as Task 1.1a tracked-set authority is structurally consumed to the checksum boundary and has one unique stage-0 canonical path per entry before candidate filtering; malformed/truncated/duplicate representations never emit public success.

Required closure:

1. Parse index extension envelopes exactly from the end of declared entries to the final object checksum, rejecting incomplete header, declared length overrun, and trailing bytes while retaining legal, bounded extension data.
2. Validate duplicate paths across all decoded stage-0 entries before `isCandidate` filtering; retain v2/v3/v4 and normal/linked worktree support.
3. Add checksum-rehashed public normal/linked malformed extension and duplicate noncandidate regressions with exact `CONTRACT_SCHEMA_INVALID`, no writes, no child launch, and stable status/inventory.
4. Prove new tests red against the previous source and green after the repair; run full focused suite and public root current-source check after staging.

Scope: `current-source.ts` and its public authority tests only. No #162 resource budget, #166 Git/HEAD authority, network security, or production behavior.
