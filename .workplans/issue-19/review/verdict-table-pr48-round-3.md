# PR #48 round 3 verifier verdict table

Reviewed head SHA: `353fd461a6f579a332e2a320a589118f74b123a3`

| Candidate | Originating concern | Verdict | Blocking input |
| --- | --- | --- | --- |
| cand-19-r3-01 | Exit-normalized and interpreter raw-write sandbox denials can be reported as generic failure or success instead of `raw_data_write_denied`. | CONFIRMED | Yes |
| cand-19-r3-02 | `guard_class` emits non-contract value `"advisory"` for raw-data advisory denials. | CONFIRMED | Yes |
| cand-19-r3-03 | Audit root poisoning can make the guard itself write audit files under protected raw data. | CONFIRMED | Yes |
| cand-19-r3-04 | A sandboxed command can sabotage `workspace/tasks` before a raw denial, causing denial without the required audit row. | CONFIRMED | Yes |
| cand-19-r3-05 | `profileRoot` symlink ancestor plus missing leaf can create a directory inside protected raw before rejecting. | CONFIRMED | Yes |
| cand-19-r3-06 | Hardlink residual scan uses eager `readdir`, so the scan budget does not bound wide directory enumeration. | CONFIRMED | Yes |

Verifier notes:

- cand-19-r3-01: `RawDataSandboxedBashTool` maps sandbox denial only under `!result.success`; Zero `BashTool` treats exit code 0 as success; interpreter `open(..., "w")` is not covered by the current write-signal detectors.
- cand-19-r3-02: `rawDataGuardClassForDecision` returns `"advisory"` for advisory denials, while OpenSpec requires `guard_class` to be `authority` or `capability`, and raw-data protection is an authority guard.
- cand-19-r3-03: audit append trusts `auditWorkspaceRoot ?? ctx.workDir` and creates `workspace/tasks/.../policy-gate.ndjson`; if that root is raw or resolves to raw, the guard writes raw bytes itself.
- cand-19-r3-04: the audit path lives under the sandbox writable workspace, so a command can tamper with `workspace/tasks` before a sandbox denial; append failure is caught as a warning and no audit row lands.
- cand-19-r3-05: missing-leaf `profileRoot` validation swallows `ENOENT`, then `mkdir(..., recursive: true)` can follow a symlink ancestor into raw before the post-mkdir canonical check rejects.
- cand-19-r3-06: `scanProtectedHardlinks` checks the path-count budget before `lstat`, but calls eager `readdir` on a directory before child-level budget checks.

Dropped findings: none.
