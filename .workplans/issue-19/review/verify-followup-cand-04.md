Verifier: followup-cand-04
Head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Verdict: CONFIRMED

Evidence:
- `packages/core/src/tools/data-raw-write-rule.ts:343` uses normalized path checks including `endsWith("/data/raw")` and `includes("/data/raw/")`.
- Therefore nested same-name paths such as `scratch/data/raw/out.csv` and `workspace/tasks/TASK-001/scratch/data/raw/out.csv` are classified as protected raw paths and can be denied through redirect or mutation detection.
- Spec text distinguishes writable workspace scratch/tmp paths from the canonical read-only raw mount.

Blocking Status:
- Not merge-blocking for #19 by itself.
- #19 evidence floor requires canonical `data/raw/input.csv` writes to be denied and read-only raw references to be allowed; it does not require same-name nested directory compatibility.
- This is a real semantic follow-up and can be fixed with the same detector changes if low cost.

Required Proof:
- Add an allow regression for `printf x > workspace/tasks/TASK-001/scratch/data/raw/out.csv` asserting the wrapper executes.
- Keep canonical `printf x > data/raw/input.csv` denied as the contrast case.
