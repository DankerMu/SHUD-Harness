# Issue #91 Round 5 repository-root object identity red proof

## Scope and source binding

- Workflow repair started from exact PR head `0c4dad86fa142420b31da5ac9866b037adc7e0ff`.
- Pre-repair production source blob: `packages/core/src/domain/services/stack-lock-collector.ts` = `0e63fd03109237069d525abb245fe2c04e8c4321`.
- Repaired production source blob: `packages/core/src/domain/services/stack-lock-collector.ts` = `aee948048dec73a25fa55ea377f57a9871ed4a0e`.
- Regression test source blob: `packages/core/src/domain/services/stack-lock-collector.test.ts` = `d8cc8c1fbf443e53fade988c9bfa79af4640564a`.
- Only the production collector source was stashed for the red replay; all six new public/injected-boundary regressions remained present.

## Exact replay

Command:

```text
npx --yes bun@1.2.19 test packages/core/src/domain/services/stack-lock-collector.test.ts --test-name-pattern 'same-path'
```

Against the pre-repair production blob the command exited 1 with `0 pass`, `6 fail`, and `7 expect()` calls. The six failing requirements were:

1. injected same-path replacement during the first root observation;
2. same-path replacement between cheap snapshots;
3. replacement adjacent to package/provider producers;
4. replacement after the first renv producer;
5. replacement after the publication-adjacent second renv producer; and
6. default Git execution after a real root command completed, followed by real directory renames that installed a different `(dev, ino)` at the identical pathname.

Five old-source cases returned a successful replacement-backed collection. The package/provider-adjacent case failed with the old producer-specific `package_json_invalid` race outcome rather than the required stable root-generation `collection_state_changed`; it therefore also failed the new contract assertion.

After immediately restoring the repaired production source, the identical command exited 0 with `6 pass`, `0 fail`, and `28 expect()` calls. The complete focused collector suite then passed `67 pass`, `0 fail`, and `231 expect()` calls.

## Hygiene

- The source-only stash was popped immediately after the red run.
- `git stash list` contained no `issue91-r5-red-proof` or other `red-proof` entry after restoration.
- The replay did not modify GitHub state, submodules, dependency files, or production files outside the assigned collector source.
