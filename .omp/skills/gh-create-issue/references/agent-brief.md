# Agent Brief Contract

> Durability contract for issue bodies that an AFK implementer agent works from. The issue body is the contract; discussion threads are context. Adapted from `mattpocock/skills` v1.1.0 `triage` AGENT-BRIEF.md.

Issues produced by this skill often sit in a DAG behind other issues. By the time an agent picks one up, earlier issues have already reshaped the codebase. Write the body so it survives that shift.

## Four principles

1. **Durability over precision.** The issue may wait days or weeks; the codebase will change under it. Specify interfaces, types, behavioral contracts, named signatures and config shapes. Never file paths, line numbers, or assumptions that the current structure survives.
   - Good: "`SkillConfig` accepts an optional `schedule` field of type `CronExpression`."
   - Bad: "Open `src/types/skill.ts` and add a `schedule` field on line 42."
2. **Behavioral, not procedural.** The agent explores the codebase fresh and makes its own implementation decisions. Describe what must be true afterwards, not the editing steps to get there.
3. **Complete acceptance criteria.** The agent needs to know when it is done. Each criterion must be independently verifiable — a command, a test, an observable behavior — never "works correctly".
4. **Explicit scope boundaries.** `Out of Scope` prevents gold-plating: name the adjacent modules and behaviors the agent must leave alone.

## Field mapping

The sub-issue skeleton in [issue-templates.md](issue-templates.md) carries the contract in these fields:

| Field | Carries |
| --- | --- |
| `## Current behavior` | What happens today — reproducible facts, not blame |
| `## Desired behavior` | The behavioral contract after the change |
| `## Key interfaces` | Named types / signatures / config shapes the change pivots on |
| `## Acceptance Criteria` | Independently verifiable checkboxes |
| `## Out of Scope` | Explicit exclusions |

For agent-implemented issues, `Current behavior` / `Desired behavior` replace a free-form `## Description`; keep `## Description` only for context that fits neither field. Standalone, manually-tracked issues may keep the free-form description.

## Anti-patterns

- File paths or line numbers as instructions — they rot while the issue waits in the DAG queue.
- Procedural step lists ("open X, add Y, then Z").
- Acceptance criteria that restate the title instead of naming a verifiable outcome.
- Scope left implicit — the agent will either gold-plate or under-deliver.

One exception, shared with the OpenSpec flow: a prototype-produced snippet that encodes a decision more precisely than prose (state machine, reducer, schema, type shape) may be inlined under `## Key interfaces`, trimmed to the decision-rich parts.
