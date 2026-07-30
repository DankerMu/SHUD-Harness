# gh Command Reference

> Moved from SKILL.md. Order matters: bootstrap labels, create the epic, capture its number, create sub-issues that reference it, then backfill the epic checklist.

**1. Bootstrap labels** (idempotent with `--force`):

```bash
gh label create epic           --color 6f42c1 --description "Epic-level task" --force
gh label create sub-task       --color 0e8a16 --description "Sub-task of an epic" --force
gh label create feature        --color a2eeef --description "New feature" --force
gh label create bug            --color d73a4a --description "Bug fix" --force
gh label create priority:high  --color d93f0b --description "Important, do first" --force
gh label create needs-followup --color fbca04 --description "Unresolved items carried in body" --force
# Optional stage/phase passthrough label
[ -n "$STAGE_LABEL" ] && gh label create "$STAGE_LABEL" --color ededed --description "Pipeline stage/phase" --force
```

**2. Create the epic and capture its number.** `gh issue create` prints the new issue URL as its last line; parse the trailing number:

```bash
EPIC_NUM=$(gh issue create \
  --title "[Epic] User Authentication Module" \
  --label epic --label feature \
  --body-file - <<'EOF' | grep -oE '[0-9]+$'
## Overview
<feature description>

## Sub-tasks
- [ ] (backfilled after sub-issues exist)

## Milestones
<phase goals>
EOF
)
```

**3. Create a sub-issue referencing the epic.** Use `<<EOF` (unquoted) so `$EPIC_NUM` and `$STAGE_LABEL` expand:

```bash
SUB_NUM=$(gh issue create \
  --title "Login API implementation" \
  --label sub-task --label priority:high ${STAGE_LABEL:+--label "$STAGE_LABEL"} \
  --body-file - <<EOF | grep -oE '[0-9]+$'
Part of #$EPIC_NUM

Implementation Ready: yes

**Module / Scope:** services/auth

Depends on #101

## In Scope
- POST /login endpoint, credential validation

## Out of Scope
- Token refresh (separate issue)

## Acceptance Criteria
- [ ] Returns 200 + JWT on valid credentials
- [ ] Returns 401 on invalid credentials

**PR Boundary:** services/auth only; no UI changes
EOF
)
```

**4. Confirm the created number** (alternative to parsing `create` output):

```bash
gh issue view "$SUB_NUM" --json number -q .number
```

**5. Backfill the epic's `## Sub-tasks` checklist** with the real sub-issue numbers:

```bash
gh issue edit "$EPIC_NUM" --body-file - <<EOF
## Overview
<feature description>

## Sub-tasks
- [ ] #$SUB_NUM Login API implementation

## Milestones
<phase goals>
EOF
```

**6. Optional — add issues to a GitHub Project:**

```bash
gh project item-add "$PROJECT_NUM" --owner "@me" \
  --url "$(gh issue view "$SUB_NUM" --json url -q .url)"
```
