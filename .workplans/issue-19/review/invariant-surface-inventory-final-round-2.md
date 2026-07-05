# Issue #19 Invariant Surface Inventory

Governing invariant:
- A wrapped bash call must not execute if it can write, delete, overwrite, extract, clone, download, or otherwise materialize bytes under canonical project `data/raw/**`.
- Constructibly read-only references to `data/raw/**` remain allowed.

Shared helper roots:
- `findProtectedDataRawWriteTarget`
- shell tokenizer / segment splitter
- path candidate resolution and `isProtectedDataRawCandidate`
- variable assignment tracking
- cwd/effective path context
- executable-code raw mutation scanner
- audit path append helper

Public entrypoints:
- `DATA_RAW_WRITE_DENY_RULE.evaluate`
- `makeDataRawPolicyGateContext`
- policy-gated registry wrapping Zero bash tool
- WS/audit integration tests that consume deny decisions

Read surfaces:
- `cat`, `grep`, `head`, `tail`, `wc`, `ls`, `find` without mutation action, non-in-place `sed`
- `stat`, `sha256sum`
- read-only URL operands for `curl`/`wget`
- read-only executable snippets such as Python/R read calls
- task-workspace scratch paths containing `data/raw` as a local subpath

Write/delete/overwrite surfaces:
- redirects and fd redirects
- mutation commands: `rm`, `touch`, `truncate`, `mkdir`, permission/ownership mutators
- destination commands: `cp`, `mv`, `rsync`, `install`, `ln`
- downloader/extractor/clone tools with explicit or implicit destinations: `curl`, `wget`, `tar`, `unzip`, `git clone`
- `find` mutation actions
- shell wrappers and recursive `bash|sh|zsh -c`
- executable-code interpreters and heredocs

State surfaces:
- initial `workDir`
- `cd`
- `env -C` / `env --chdir`
- command-scoped assignments
- `export`
- `env NAME=value`
- simple grouped/subshell command forms

Evidence/audit surfaces:
- policy deny JSON payload
- `tool.failed` event skeleton
- audit row append under `workspace/tasks/TASK-M1-SPIKE/audit`
- symlink and special-file safety

Surfaces intentionally out of scope:
- Perfect shell grammar. Unknown write-risk constructs fail closed.
- Full runtime filesystem interposition.
- Network side effects that do not write local raw paths.
