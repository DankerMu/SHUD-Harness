# Issue 171 red proof

## Invocation

```sh
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests/source-ingress.test.ts spikes/git-status-capability/contracts/tests/source-identity.test.ts
```

## Base-source result

The focused, batched new-behavior suite was run after adding fixtures and tests, before adding any `contracts/check.ts` or `contracts/lib/**` implementation source.

Named collection failures:

- `source-ingress.test.ts`: `Cannot find module '../lib/canonical-json'`
- `source-identity.test.ts` through `tests/helpers.ts`: `Cannot find module '../lib/checker'`

Summary: Bun `1.2.19` reported `0 pass`, `2 fail`, `2 errors`, across `2` test files (exit `1`). These are the expected absent-implementation failures for the new direct-ingress and identity public seams; no source stash was created because the base contains no core source files.

## Green rerun

```sh
npx --yes bun@1.2.19 test spikes/git-status-capability/contracts/tests
```

Summary: Bun `1.2.19` reported `24 pass`, `0 fail`, and `513 expect()` calls across the two retained core test files (exit `0`).
