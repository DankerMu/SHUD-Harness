# PR #48 Follow-up Final Review Verifier Verdict Table

Issue: #19
PR: #48
Reviewed head SHA: ee9b32cbe4fab76e6bdc7697980feec7646b46e8
Date: 2026-07-04

## Verdicts

| ID | Reviewer candidate | Verifier verdict | Severity | Disposition |
| --- | --- | --- | --- | --- |
| G-19-01 | Hidden interpreter raw mutations can still return allowed when stderr is suppressed (`os.unlink`, `os.rename`, `shutil.copyfile`, Node `copyFileSync`/`renameSync`/`unlinkSync`, Ruby `FileUtils`, R `file.copy`/`file.rename`/`unlink`). | CONFIRMED | P1 | Blocks merge. Same raw-denial evidence invariant remains open; mutation target recognition is still incomplete. |
| G-19-02 | Legal raw-read plus workspace-write failures or stderr text can be misclassified as `denied_by_sandbox` because visible denial text plus raw path is too broad. | CONFIRMED | P1 | Blocks merge. Denial normalization must be tied to a precise raw mutation target, not generic `Permission denied` text. |
| G-19-03 | TERM-ignoring top-level shell can write before delayed SIGKILL on timeout/abort, so the tool can return after a late write. | CONFIRMED | P1 | Blocks merge. Timeout/abort must force-kill the process group before returning. |
| G-19-04 | Non-denial sandboxed bash calls can lose required audit rows because `appendAudit()` catches identity/path failures and returns success. | CONFIRMED | P1 | Blocks merge. Lifecycle audit append failure must fail closed, matching denial audit behavior. |
| G-19-05 | Audit root is scoped one level too deep when callers pass canonical workspace root; `workspaceRoot` becomes `workspaceRoot/workspace/tasks`. | CONFIRMED | P1 | Blocks merge. Audit path resolution must support canonical workspace roots and retain fixture/project-root compatibility only as an adapter. |
| G-19-06 | Rscript legal raw-read/workspace-write runtime proof is only classifier-tested. | CONFIRMED | P2 / optional | Non-blocking evidence gap. Add conditional runtime proof if practical; do not block merge solely on Rscript absence. |

## Gate Result

Follow-up final review is not clean. Current head `ee9b32cbe4fab76e6bdc7697980feec7646b46e8` MUST NOT be merged.

The confirmed P1 set is still one invariant family: the wrapper must preserve the OS sandbox as write authority while keeping wrapper-side evidence, process, and audit semantics exact. Continue in PR #48 with another root-cause remediation pass; do not split, merge, change `zero/`, or reopen ADR-0001.
