Verifier: followup-cand-03
Head SHA: 74a8544ae07f158007ac00d4932aca4d30e1528c
Verdict: CONFIRMED

Evidence:
- `packages/core/src/tools/policy-gate-audit.ts:89-92` builds `auditDir` and `auditPath` with `path.resolve` and validates lexical containment only.
- `packages/core/src/tools/policy-gate-audit.ts:48-49` calls `mkdir(auditDir, { recursive: true })` and `appendFile(auditPath, ...)` without `realpath`, `lstat`, or no-follow protection.
- If `workspace/tasks/TASK-M1-SPIKE/audit` is a symlink to an external directory, or `policy-gate-audit.ndjson` is a symlink to an external file, the lexical containment check passes but append follows the symlink target.
- Existing tests cover `../` traversal and path-bearing file names only; they do not cover symlink escape.

Blocking Status:
- Merge-blocking for #19.
- The #19 fixture selects file IO/path safety/overwrite risk and identifies the audit append helper as a write surface. The audit write helper is introduced in this PR, so its fixture-path invariant must hold here rather than being deferred entirely to later generic workspace helpers.

Required Proof:
- Add a test that creates `workspace/tasks/TASK-M1-SPIKE/audit` as a symlink to an external temp directory, calls `appendPolicyGateAuditRow`, and asserts the helper rejects without writing the external audit file.
- Add a companion case for a real audit directory whose `policy-gate-audit.ndjson` leaf is a symlink to an external file.
