## Why

#364 records13 fixture type diagnostics in7 test files from the existing optional full-tree TypeScript program. Production types are correct; fixture literals, branded IDs and unknown values are imprecise. The retained #356 exit2 log is accepted historical RED evidence, not a newly measured current-head count. Current Vitest5 declarations still require a mutable array for arrayContaining.

Issue type: test
Fixture level: compact
Upstream suggested level: absent (test-only alignment across existing contracts, no production/config changes)
Blast radius: policy/job fixture fidelity and the optional diagnostic compiler result.
Selected risk packs: Legacy compatibility / examples; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: retained historical counterexample; post-fix full-tree tsc exit0; touched test files and default check green; production/config/assertion preservation; independent CP1/4 white-box review and exact-head CI.

## What Changes

Annotate the policy context using its existing exported type; keep intentionally hostile remediation as hostile runtime data with a documented local type boundary. Use the public JobId constructor at existing nullable-string narrowing points (one construction may serve several calls), preserve the JobKind literal union, pass a mutable copy to arrayContaining, and narrow parsed unknown values to nonnull objects before reflection. No design.md is required at compact level.

## Capabilities

### Modified Capabilities

- `engineering-gates`: optional full-tree diagnostic compilation of test fixtures without expanding blocking typecheck policy.

## Impact

Only the7 test files named by #364 plus this fixture. No production signatures, runtime behavior, test discovery/oracles, compiler/lint options, CI, dependency or Repository_Layout policy change. Any additional diagnostic discovered by the post-fix compiler is evaluated against the issue's explicit same-criterion allowance, not hidden by exclusions; a material scope conflict is reported before expanding edits.
