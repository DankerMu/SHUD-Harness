## Red-before evidence

- Date: 2026-07-18
- Base source: `5a450a97f2a474af2f4db26bd9ee198adb7395ec`
- Product source state: unchanged from base; only the new OpenSpec fixture and
  the two dedicated test files were present.
- Replay patch: `evidence/red-before-tests.patch` (applies the exact dedicated
  core/backend tests to the base source).

Command:

```sh
npx --yes bun@1.2.19 test ./packages/core/src/domain/services/failure-occurrence-ledger.test.ts ./packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts
```

Result: exit 1; 0 pass, 2 fail, 2 collection errors.

Observed failures:

```text
packages/core/src/domain/services/failure-occurrence-ledger.test.ts:
SyntaxError: Export named 'failureGraphNodes' not found in module
'packages/core/src/domain/services/index.ts'.

packages/backend/src/routes/failure-occurrence-ledger-routes.test.ts:
SyntaxError: Export named 'taskServiceErrorAtBoundary' not found in module
'packages/core/src/index.ts'.
```

The collection failures are the expected red oracle for a new public ledger
module/API: neither dedicated file can execute against the base implementation.
The green run must execute every scenario in both files after implementation;
an import-only green is insufficient.

## Round 2 behavioral red against parent source

- Parent source: `b6c7977efd811aefacc80c3165f6ebf8630ad9ef`
- Detached proof worktree: `/tmp/issue108-round2-b6c.Xox4CK/worktree`
- `git rev-parse HEAD` result:
  `b6c7977efd811aefacc80c3165f6ebf8630ad9ef`
- Replay patch:
  `evidence/diagnosis/round2-b6c-diagnosis.patch`
- Patch preflight: `git apply --check <replay-patch>` -> exit 0.

Command:

```sh
npx --yes bun@1.2.19 test ./openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts
```

Result: exit 1; 0 pass, 2 fail, 2 assertions reached.

Exact failure output:

```text
bun test v1.2.19 (aad3abea)

openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts:
28 |     );
29 |
30 |     const currentNestedNode = failureGraphNodes(folded).find(
31 |       (node) => node.value === nestedPrimary
32 |     );
33 |     expect(currentNestedNode).toBeDefined();
                                   ^
error: expect(received).toBeDefined()

Received: undefined

      at <anonymous> (/private/tmp/issue108-round2-b6c.Xox4CK/worktree/openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts:33:31)
(fail) Round 2 occurrence-ledger diagnosis > independent nested fold rereads the current mutable cause [0.85ms]
47 |       folded = mergeTrustedFailureOccurrences(
48 |         captureFailureOccurrence("body", primary),
49 |         [],
50 |         "Round 2 deep cause chain"
51 |       );
52 |     }).not.toThrow();
                ^
error: expect(received).not.toThrow()

Error name: "RangeError"
Error message: "Maximum call stack size exceeded."

      at <anonymous> (/private/tmp/issue108-round2-b6c.Xox4CK/worktree/openspec/changes/m1-failure-occurrence-ledger/evidence/diagnosis/occurrence-ledger-round2-diagnosis.test.ts:52:12)
(fail) Round 2 occurrence-ledger diagnosis > 25K cause chain is iterative, bounded, and retains its primary ledger [42.36ms]

 0 pass
 2 fail
 2 expect() calls
Ran 2 tests across 1 file. [61.00ms]
```

This closes the behavioral red gap left by the base collection failure: the
parent implementation reuses stale nested observations and recursively
overflows on the 25K chain before the Child A implementation is applied.
