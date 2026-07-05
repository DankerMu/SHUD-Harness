# Issue #19 Gate-Level PR Strategy Review

Head SHA: `0a6739dc79d5b53406cf5805f5195999b3620872`

Gate trigger:
- Repeated high-risk invariant misses across multiple review/fix rounds.
- Failure class remains the same: static shell/path parser does not carry enough execution state to decide pre-exec raw write policy.

Strategy decision:
- Continue PR #46 as a single issue #19 PR.
- Do not split, because all findings hit the same guard/helper surface and splitting would merge a known bypass in the same policy rule.
- Move from example-level patching to a class-level scan model:
  - One scan context flows through all segment evaluation: cwd, variable bindings, whether cwd is known, and bounded scan counters.
  - Cwd-affecting shell surfaces update or constrain that context before writer evaluation.
  - Environment assignment surfaces update child-command context.
  - Explicit and implicit writer destinations are classified by command family.
  - Resolved path is authoritative when cwd is known; unresolved string is a fallback only when cwd is unknown.
  - Read-only carveouts must be explicit and tested.
  - Unknown shell syntax on write-risk surfaces fails closed; unknown syntax in clearly read-only surfaces should not become mutation denial.

Allowed implementation scope:
- `packages/core/src/tools/data-raw-write-rule.ts`
- `packages/core/src/tools/data-raw-write-rule.test.ts`
- `packages/core/src/tools/policy-gate-audit.ts`
- Avoid broader registry/API changes unless needed for current inputs already available.

Non-goals:
- Full POSIX shell interpreter.
- Runtime filesystem sandbox for all writes.
- Broad command catalog beyond evidence-backed writer/read-only families.
- Perfect adversarial race immunity beyond feasible Node/Bun audit file safety.

Merge gate after this strategy:
- Full verification must pass.
- A new full six-view review must run on the final pushed SHA.
- No merge if any CONFIRMED or high-risk PLAUSIBLE finding remains.
