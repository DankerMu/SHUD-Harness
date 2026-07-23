# Issue Body Templates

> Moved from SKILL.md. The required-vs-optional field contract stays in SKILL.md — these are the full body skeletons. Bodies that feed an AFK implementation workflow must additionally follow the durability contract in [agent-brief.md](agent-brief.md).

**Epic:**
```markdown
## Overview
<feature description>

## Sub-tasks
- [ ] #101 Task 1
- [ ] #102 Task 2

## Milestones
<phase goals>
```

**Sub-issue:**
```markdown
Part of #<epic_number>

Implementation Ready: yes

**Module / Scope:** <single module, package, service, or directory boundary>

Depends on #<dep1>
Depends on #<dep2>

**OpenSpec change:** <change-name>   <!-- optional; required when driven by stage-change-pipeline -->

## In Scope
- <behavior, files, or deliverables this issue includes>

## Out of Scope
- <adjacent modules or follow-up work explicitly excluded>

## Current behavior
<what happens today — reproducible facts>

## Desired behavior
<the behavioral contract after the change; interfaces and behavior, never file paths/line numbers>

## Key interfaces
<named types / signatures / config shapes the change pivots on; may inline a decision-rich prototype snippet>

## Description
<optional extra context that fits neither behavior field>

## Acceptance Criteria
- [ ] Criterion 1 (independently verifiable: a command, a test, or an observable behavior)
- [ ] Criterion 2

**PR Boundary:** <expected change surface; adjacent modules explicitly not touched>
```
