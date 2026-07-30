# PR #170 Round 2 fix synthesis

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`
Round result: not clean; four CONFIRMED / FIX_NOW findings.

## Fix checklist

1. `contract-02`: preserve the first pending item/node capacity failure over a
   later semantic non-finite-number rejection. Syntax, duplicate-key and depth
   errors remain immediate. Standalone `1e9999` remains schema-invalid. Cover
   both public kinds and an independently relaxed item profile.
2. `ev-06`: replace voluntary global wrappers with preload-time module
   interposition for the normal `node:fs`, `node:child_process`, and `bun:ffi`
   import paths, while retaining Bun-global interception. Controls must use
   normal imports. Add a compiling production-path authority mutation to the red
   proof and demonstrate the independent boundary turns it red without side
   effects on Darwin and Linux.
3. `ev-07`: force-add the referenced
   `phase-6-2-invariant-audit-052cb07.md` so it is available from the exact Git
   tree; verify with `git cat-file` and evidence hygiene.
4. `boundary-01`: remove the two focused-suite additions from the existing
   `.github/workflows/ci.yml`. Correct PR/evidence claims: existing required CI
   remains unchanged; the exact-tree Darwin run and read-only Linux Bun 1.2.19
   container supply the focused cross-platform evidence. Do not add the
   separately owned isolated spike workflow in this issue.

## Required verification

- Compiling red proof for parser and production-import authority behavior,
  followed by exact restoration and green focused suite.
- Darwin focused suite, direct commands, typecheck, full repository check,
  strict OpenSpec, evidence hygiene, diff/stash/submodule/scope checks.
- Read-only Linux Bun 1.2.19 focused suite with the same tree.
- `git diff origin/main -- .github/workflows/ci.yml` is empty.
- No implementation of #169 current oracle, #166 live Git, #162 publication,
  production/runtime, isolated-workflow ownership, or network security.
