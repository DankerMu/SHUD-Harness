Round 1 verifier verdict table

Reviewed head SHA: 085185047116d078b47990cb7fe444f2785f6607

| Candidate | Verdict | Merge-blocking under high fixture | Summary |
| --- | --- | --- | --- |
| cand-01 | CONFIRMED | yes | Bash write detector misses constructible `data/raw/**` write forms such as newline command lists, `dd of=`, `truncate`, `bash -c`, and `cp -t`. |
| cand-02 | CONFIRMED | yes | Audit helper accepts unchecked `taskId`/`fileName` path components and can escape the required task audit directory. |
| cand-03 | CONFIRMED | yes | Deny return path does not connect the same decision to WS/audit evidence; current tests build artifacts separately. |
