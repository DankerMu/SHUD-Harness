Closure record for followup-cand-01

Issue: #24
PR: #49
Fixed on branch head before commit: `8e028e5ea1c93e3852aebc2e2714d32834583099`

Finding:
- `CONFIRMED` evidence/contract drift: live Issue #24 and the old fixture-ready report still authorized raw Zero `memory` after Phase 6 moved the M1 comparable role id to `harness.memory.propose`.

Fix:
- Updated live GitHub Issue #24 from `.workplans/issue-24/issue-body-with-toolids.md`.
- Marked `.workplans/issue-24/review/fixture-review-followup-ready.md` as superseded for the old exact-id memory note.
- The current oracle is: `harness.memory.propose` is the future proposal-only adapter placeholder; raw Zero `memory` is explicitly excluded from M1 comparable `toolIds`.

Verification:
- `gh issue view 24 --json body --jq .body` shows `harness.memory.propose` in the exact snapshot and states raw Zero `memory` is excluded.
- `rg 'pin.*memory\(draft\).*exact id `memory`|"reviewer": \["memory"|memory\(draft\).*exact id `memory`' .workplans/issue-24 openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md packages/core/src/tools/role-tool-map.test.ts packages/core/src/tools/role-tool-map.ts` returns only historical review/verifier records, not active fixture/source oracle text.
- `openspec validate m1-foundation --strict --no-interactive`
- `git diff --check`
- `git -C zero diff --quiet`
- `pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/role-tool-map.test.ts`
