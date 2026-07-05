Verifier: followup-cand-05
Head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c plus current uncommitted fixes
Verdict: CONFIRMED

Evidence:
- Current code still lacks `>&` in `REDIRECT_WRITE_OPERATORS` and `readShellOperator()`.
- Current code lacks single `&` in `SEGMENT_SEPARATORS` and `readShellOperator()`.
- The verifier proved `findProtectedDataRawWriteTarget()` returns `undefined` for:
  - `printf x >& data/raw/input.csv`
  - `printf x >&data/raw/input.csv`
  - `cat data/raw/input.csv & rm data/raw/input.csv`
- Baseline checks still return targets for `printf x > data/raw/input.csv` and newline-separated remove, confirming the candidate is specific to these operators.
- An allow decision reaches `innerTool.run(...)` through the policy-gated registry.

Blocking Status:
- Merge-blocking for #19.
- These are valid bash write/delete forms targeting `data/raw/**`; the hard guard must stop them before execution.

Required Proof:
- Add denied regressions for:
  - `printf x >& data/raw/input.csv`
  - `printf x >&data/raw/input.csv`
  - `cat data/raw/input.csv & rm data/raw/input.csv`
- Assert `success=false`, `bashTool.calls === 0`, rule id, `guard_class`, and remediation.
- Add `>&` to redirect write operators and operator tokenizer.
- Add single `&` to segment separators and operator tokenizer, preserving longest-match order for `&>`, `&>>`, and `&&`.
