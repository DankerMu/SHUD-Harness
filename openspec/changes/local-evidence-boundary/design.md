# Design

## Context and ownership

PI has selected local-only `.workplans/`; the original failure is user-reported ground truth, not rerun for confirmation. New disposable valid-but-unformatted JSON demonstrates the remaining namespace asymmetry without touching consumed evidence. Deliverable formatting remains blocking.

Change surface: `.gitignore`, the exact local `.git/info/exclude` PR-evidence line, `instructions/agents/shared.md`, `constraints.yaml`, `openspec/project-profile.md`, proposed ADR-0009 and generated instructions. `.prettierignore`, package commands and CI remain unchanged.
Governing invariant: local evidence never needs rewriting to satisfy deliverable formatting, and the same formatter still rejects noncompliant deliverables.
Must preserve: every pre-existing evidence byte, unrelated local exclude rules, root review-gate handling, source check strength and all production behavior.

## Decisions

1. The sole distributed exclusion for all evidence namespaces is root-anchored `/.workplans/` in `.gitignore`, replacing the narrower issue rule. Prettier's default ignore sources already include it; no second rule or changed CLI options.
2. `.workplans/issue-<number>/` holds issue execution/review, `.workplans/pr-<number>/` PR-only review, and `.workplans/<change-name>/` design/pipeline evidence. Names describe ownership, not different format policy. Writers never put production sources/deliverables in this root or force-add its evidence; public PR summaries retain review evidence needed outside the machine.
3. Remove only the existing `.workplans/pr-*/` line from local `.git/info/exclude`, as explicitly requested by issue acceptance. This removal is not a portable tracked change; report its actual local result. Preserve all other lines, including `.review-gate.json`, and keep its existing `.prettierignore` exemption. The root gate file is not covered by the PI's directory rule; do not relocate its producer or silently broaden this decision.
4. ADR-0009 records the approved boundary, alternatives and consequences independently of any passing gate. Shared instructions' verification/enforcement mirrors and constraints explain the same boundary. The active project profile links the policy once for issue-workflow writers through subagent-workflow's documented project-profile seam. Design/stage-pipeline writers reach that same policy via canonical repository instructions, which explicitly direct all local evidence writers to the active profile and forbid rewriting consumed evidence; no undocumented stage-pipeline profile-consumption behavior is assumed. Existing subagent-workflow documentation delegates project-specific contracts to the profile (`references/project-profiles.md`). These owned project routes avoid hand-editing runtime projections or modifying external `my-agents` sources; no generic skill upgrade.
5. Existing evidence may be excluded from Git/format discovery but is not exempted from other tools, confidentiality rules or honest reporting. This issue does not change ESLint discovery, global Markdown exclusions or retention/deletion policy.

## Seams, failure model and proof

Sibling surfaces: issue-, PR- and change-name evidence writers; Git ignore discovery; Prettier inherited ignore discovery; active project profile; generated agent instructions; unchanged source-format and CI entrypoints.
Before configuration edits, parent saves hashes of existing `.workplans` files and runs disposable namespace probes. Valid but unformatted JSON under a change-name path must be seen by Prettier and fail its check before cutover; issue-prefix is the already-ignored control, PR-prefix demonstrates local Git exclusion is not Prettier policy.
After cutover, Git check-ignore must attribute all three probe paths to `.gitignore` and Prettier file-info must mark them ignored. Actual `pnpm run format:check` with all probes present must pass without any write to evidence. Matching unformatted JSON in a disposable nonignored source-tree path must still fail targeted checking, while a separate correctly formatted source control passes. Remove only owned probes, compare all saved pre-existing hashes, and verify no tracked evidence files.
Run full `pnpm run check`, render/check instruction projections, ADR and strict OpenSpec validation. Parent owns all commands and throwaway probe cleanup; implementer changes only candidate configs/docs, never oracle or existing evidence.

## Risks and rollback

Future deliverables accidentally placed in `.workplans/` become invisible to Git/format; policy forbids that placement instead of force-add exceptions. Local `.git/info/exclude` cleanup is verified on this checkout only. Reverting the tracked change restores prior discovery but does not authorize formatting old evidence; the local redundant PR line need not be restored for runtime behavior. Review checks the exact authorized boundary and negative source control, not test-count or a green-only claim.

Non-goals: new runtime functionality, new dependencies, schema generation changes, skill reinstalls, review-gate migration, source/CI gate relaxation, changing user evidence or unrelated local configuration, PI acceptance of #293/#318.
