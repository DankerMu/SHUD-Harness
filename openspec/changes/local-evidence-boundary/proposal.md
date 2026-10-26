# Proposal

## Why

Issue #322 shows local, consumed agent evidence under `.workplans/<change-name>/` can fail the repository format gate, inviting prohibited oracle rewrites. PI [comment 6397950402](https://github.com/DankerMu/SHUD-Harness/issues/322#issuecomment-6397950402) explicitly approves the entire root as local-only evidence, with one distributed Git ignore source and unchanged deliverable checks.

## What Changes

- Replace issue-only ignore with root `/.workplans/`; Prettier inherits the same Git rule. Remove only the obsolete local `.git/info/exclude` `.workplans/pr-*/` line explicitly named by issue acceptance; preserve unrelated local rules and all existing evidence bytes.
- Record directory ownership/names and no-oracle-rewrite policy in independent ADR-0009, canonical instruction mirrors and project profile. Existing workflow skill's project-local profile seam supplies the single reference; no installed projection or external skill repository edits.
- Preserve the separate root `.review-gate.json` exclusion and its producer: it is outside `.workplans/`, and removing it without replacement would regress gate operation. No new formatter ignore, changed check command, CI exclusion or forced evidence commit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `engineering-gates`: local evidence boundary versus deliverable formatting enforcement.

## Impact and triage

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because shared format entry/config and local evidence ownership are affected.
Blast radius: local Git/Prettier discovery and agent evidence integrity; runtime/scientific behavior unchanged.
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Legacy compatibility / examples; Documentation / migration notes.
Evidence floor: observed before/after public Git/Prettier probes across three namespaces, unchanged evidence hashes, source-tree rejection control, full check, docs/instruction/ADR checks and exact-head CI.
