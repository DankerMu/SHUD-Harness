# Round 1 repair red-before evidence

- Date: 2026-07-19
- Frozen reviewed source: `1a993c89c842b72512768c40b87dd2205562ac05`
- Product source state: frozen source; only the Round 1 dedicated test changes
  were applied for this batched red run.
- Replay patch: `red-before-tests.patch`.
- No `red-proof` stash was created or left behind.

Command:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts
```

Result: exit 1; 0 pass, 2 fail, 2 collection errors.

Observed missing public seams:

```text
packages/core/src/domain/services/failure-occurrence-ledger.test.ts:
SyntaxError: Export named 'runWithPreservedRelease' not found in module
'packages/core/src/domain/services/index.ts'.

packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts:
SyntaxError: Export named 'createTrustedTaskServiceErrorProxy' not found in module
'packages/core/src/index.ts'.
```

The collection failures are the expected red proof: the frozen source could
not provide the reviewed operation-owned carrier/release seam or the trusted
proxy construction capability. The same command must execute every scenario
after the repair; an import-only green is insufficient.
