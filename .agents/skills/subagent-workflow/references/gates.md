# Ordinary-Loop Gates

Single source for the review/fix loop's gate system: the round ledger, the gate table, the Review Failure Retro, failure shapes, and post-gate budgets. Phase 4, 5, and 6.5 consume this file; do not restate its rules there. The two overriding non-negotiables live in `SKILL.md` Core Rules.

## Round Ledger (the round counter)

Every comprehensive cross-review round — initial or post-fix — ends by appending one ledger line to the evidence bundle. The next action (fix synthesis, another round, Phase 7, CI, merge) may only be chosen from that line, never from an impression of how the PR is trending:

```text
Round <N> | <sha> | clean|not-clean | verified findings: <n> | highest severity: <sev> | failure classes: <list> | repeats prior class: no|yes (<class>, also round <M>) | gate: none|three-round|working-day|same-invariant
```

- `N` is the counter every gate below reads. It never resets within a PR — not across commits, CI-only fixes, or sibling surfaces. A fresh counter is legitimate only for a child PR created by a gate-selected PR split, because it is a new PR.
- A round whose only verified findings are minor (P2) and whose every finding is routed at round close (issue-scribe URL or recorded reason; coverage findings excluded — they always fix) is recorded **clean**: routing resolves the findings, so no gate fires on a round the P2-deferral default exits anyway. The deferral counts live in the loop-log `residual_deferred` and the evidence bundle, not the ledger line.
- The Phase 4.5 verification pass and failed no-report invocations get no ledger line — they are not rounds.
- Taking any post-round action without the current round's ledger line is a skip block for the accountability log.

**Preferred mechanics — the packaged gate CLI** (`<skill>/scripts/review_gate.py`): run `open --pr <N> --issue <M>` once when Phase 4 starts (`--issue` enables the cross-PR ceiling memory below), then `record-round --sha <sha> --clean|--not-clean [--verified <n> --highest <sev> --classes <list>]` after each round. It maintains `.review-gate.json` at the project root (precomputed `locked`/`lockReason`), auto-detects failure-class repeats against all prior rounds, appends the ledger line to `<REVIEW_DIR>/round-ledger.log`, exits 2 the moment a gate locks — immediate feedback, not a pre-merge discovery — and refuses any round beyond the 5-round ceiling. Register a persisted retro with `record-retro --path <file> --shape <shape>` (it mechanically enforces `converging` and `depth` eligibility and arms the post-gate budget), manual triggers with `lock --reason <trigger>`, and run `close --outcome merged|superseded-by-split|abandoned|descoped` after merge or abandonment. With the optional `review-gate` hook installed, a locked state mechanically denies implementer/reviewer spawns until `record-retro` runs; independent of the hook, `evidence_check.py` fails on a locked state, so a skipped gate transition is caught at the next spawn/post point instead of surviving out of band. Gitignore `.review-gate.json` (per-PR ephemeral state); **commit `.review-gate-issues.json`** (the cross-PR memory).

## Gate Table

| Gate | Trigger | Immediate action | Post-gate budget |
|---|---|---|---|
| **Three-round hard gate** | Ledger shows `Round <N≥3> ... not-clean` — any actionable findings, same failure class or not | Stop the ordinary loop. No implementer fix, cross-review, Phase 7, CI wait-for-merge, or merge until the retro is persisted and its corrective action chosen | By shape (below) |
| **Round ceiling (terminal)** | The 5th comprehensive round is recorded not clean, or a 6th round is attempted | The ordinary loop is closed for this PR. Corrective action is a **PR split** (children re-enter as new PRs with fresh counters); descope or a user decision are the only alternatives, via `close --outcome`. The CLI refuses further rounds and any non-breadth retro. Append a terminal line (`outcome: ceiling-split\|abandoned\|descoped`) to `docs/review-loop-log.jsonl` and, when the issue came from `stage-change-pipeline`, route the event back as its sizing-retro; split children re-enter that pipeline's Stage 5 implementation-ready contract, never this workflow as bare fixtures | none — no retro extends it |
| **Working-day** | Review/fix activity has consumed more than one working day | Retro before any further review round | By shape |
| **Same-invariant** | The same invariant keeps failing in sibling surfaces | Retro before any further review round | By shape |

Shared rules:

- **Hard ceiling: 5 comprehensive rounds per PR, CLI-enforced.** Retro chaining cannot extend past it — whatever budgets earlier retros granted, round 5 not-clean is terminal. This is the cost governor: each comprehensive round is the most expensive unit in the workflow, and an issue that cannot converge in 5 of them is failing economically; the split/descope/stop decision must reach the human before more money burns, not after.
- A gate is a turn signal, not permission to abandon the issue.
- The retro must **change the next action**: update fixture/matrix, broaden or split scope, strengthen reviewer prompts, or a user-visible scope call only when the decision cannot be derived from issue/OpenSpec evidence.
- **No trend exemption**: a round-over-round decline in finding count is not a reason to skip the retro. `converging` is a shape selected *inside* the persisted retro, never a bypass of it — and any critical/major finding in round 3+ or any failure-class repeat across rounds (ledger `repeats prior class: yes`) disqualifies it outright.
- The retro must be persisted to the evidence directory or PR working notes before any further implementation/review action; summarizing it in chat is not enough. After persisting (and registering via the CLI when in use), the next action must be the retro's chosen corrective action, not a resumed ordinary loop.
- Escalate to the user only for real blockers or a scope/product decision not derivable from the fixture.

## Review Failure Retro

```text
Review Failure Retro:
PR: #<N>, current head SHA: <sha>
Failure classes: <names>
Rounds affected: <rounds, with per-round SHA/report paths>
Failure shape: breadth | depth | noise | converging
- breadth: findings spread across independent surfaces with no shared root cause
- depth: the same invariant/failure class recurring across rounds or sibling surfaces
- noise: findings mostly REFUTED or non-actionable per the finding contract
- converging: healthy convergence — no failure class repeats across rounds, and the
  verified-finding count and highest severity are non-increasing round over round
  with at least one strictly decreasing (cite the per-round numbers as evidence)
Depth evidence (required when shape = depth):
- Invariant: <the single safety/correctness rule that keeps failing>
- Recurring findings:
  - <verified finding> (round <N>)
  - <verified finding> (round <M> / sibling surface)
Split rebuttal (required from the second gate entry when shape is depth or noise):
- <why the surfaces are not independently splittable, citing ledger/verdict evidence;
  when the source issue declares a `Minimal mergeable slice`, refute that specific cut -
  why it is not independently mergeable NOW - generic prose does not discharge this>
Why Phase 5/6 did not close it:
- Fixture scope gap: yes|no - <reason>
- Fix prompt too narrow: yes|no - <reason>
- Reviewer finding contract vague/inconsistent: yes|no - <reason>
- Missing regression evidence: yes|no - <reason>
- Cause never diagnosed (no red repro before fixes): yes|no - <reason>
- PR too broad / should split: yes|no - <reason>
Next corrective action:
- <PR split | refactor/redesign | diagnosis task | invariant closure retry | fixture update | user scope decision | reviewer downgrade with rationale | bounded loop extension (converging only)>
```

For a `converging` retro the strategy sections are skipped — the convergence-trend numbers are the whole argument.

## Failure Shapes: Default Actions and Budgets

Deviating from the default requires a recorded reason in the retro.

| Shape | Default corrective action | Post-gate budget | If still not clean |
|---|---|---|---|
| `breadth` | **PR split** along independent surface boundaries within the issue/OpenSpec scope. Each child PR re-enters the workflow as a new PR with a fresh round counter; the parent PR's evidence bundle records the split plan and which findings each child absorbs | 1 comprehensive round | Re-enter the gate with an updated retro and a stronger action — never return to narrow line-item repair; all budgets are bounded by the 5-round ceiling |
| `depth` | Refactor/redesign or a diagnosis task on the recurring invariant. **Splitting a recurring invariant is forbidden** — every child PR inherits the same defect and each burns its own review rounds | 1 comprehensive round | Same as breadth |
| `noise` | Reviewer-pattern downgrade with recorded rationale, plus reviewer-prompt strengthening for the next round | 1 comprehensive round | Same as breadth |
| `converging` | **Bounded loop extension**: continue the ordinary Phase 5-6-6.5 loop | 2 comprehensive rounds, hard; selectable at most once per PR | Round 5 still not clean → **round ceiling (terminal)**: PR split; no further ordinary rounds |

`converging` eligibility (all must hold; the CLI checks them mechanically): no failure-class repeat in any round, no critical/major in a not-clean round ≥ 3, verified count and highest severity non-increasing round over round with at least one strict decrease, not previously used on this PR, current round < 5.

`depth` obligations (CLI-checked at the form level): a depth retro must name the single recurring rule on an `Invariant:` line and map at least two verified findings — across rounds or sibling surfaces — to it under `Recurring findings:`. Ledger class labels are deliberately NOT the eligibility test: labels are orchestrator-authored at `record-round` time, so a hard no-repeat-no-depth rule would be gameable in exactly the direction it claims to block (relabel consistently to manufacture recurrence) and could force the forbidden action (a genuinely recurring invariant whose findings drew different labels would be pushed into a split every child PR inherits). Instead, a depth retro registered while the ledger shows no class repeat gets a `Depth-without-recurrence` warning line appended to the ledger — the discrepancy itself becomes grill/Phase 8 evidence for whether the depth claim or the label granularity is wrong.

Split-default escalation (mechanical on gate entries, which derive from not-clean rounds and cannot be faked away): executing models systematically prefer claiming depth and continuing over splitting — continuing feels like progress, splitting feels like disruption. So from the **second gate entry** on the same PR, a PR split is the default corrective action: a second-or-later retro of shape `depth` or `noise` must carry a non-empty `Split rebuttal:` explaining why the finding surfaces are not independently splittable (citing ledger/verdict evidence), or the CLI refuses it. `breadth` needs no rebuttal — it is the split. `converging` is exempt — its trend numbers are the whole argument.

**Per-issue ceiling memory (cross-PR, CLI-enforced with `open --issue`)**: gate state is per-PR, so without memory a successor PR for the same unsplit issue restarts the split argument from zero — and the rebuttal requirement alone is satisfiable with plausible prose. The CLI therefore keeps `.review-gate-issues.json` across `close`: when an issue already hit the round ceiling on another PR, every later PR for it opens **escalated** — `depth`/`noise` retros are refused unless `record-retro --user-approved "<one-line user decision>"` records an explicit human call (appended to the ledger for audit). `breadth` and `converging` are untouched: the trigger (a prior ceiling) derives from not-clean rounds and cannot be label-gamed, and the user-decision hatch keeps a genuinely recurring invariant from being forced into the forbidden split without a human in the loop — the split/descope/stop decision reaches the human at the *start* of the successor PR, not after its money is burned.
