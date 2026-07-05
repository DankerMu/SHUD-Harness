Part of #11

Implementation Ready: yes

**Module / Scope:** tool-registry-governance — `packages/core`（role→tool_id 映射表常量 + 快照/不变式测试）

Depends on #16

**OpenSpec change:** `m1-foundation`（`openspec/changes/m1-foundation/`）｜ **Task:** tasks.md 5.1（[GRILL-2] 已定案 2026-07-03，PI 已确认工具面）

## In Scope
- 常量映射表：canonical 五角色（coordinator | repo_explorer | worker | coder | reviewer）→ exact `toolIds` 集合，基准照 spec 附表（PI 确认版 + 2026-07-05 fixture clarification）。
- `toolIds` 是唯一可参与 spawn `allowed_tools` 子集比较的注册名数组；`permissionNotes` 只解释 draft memory、artifact 写入范围、git/search 只读等语义，不进入子集比较。
- 工具 id 命名裁决：
  - Zero 当前原生注册名：`spawn_agent`, `wait_agent`, `read`, `write`, `edit`, `bash`, `memory`。
  - SHUD-Harness 点分注册名：`harness.job.submit`, `harness.job.collect`, `harness.report.generate`, `git.inspect`, `repo.search`, `repo.glob`, `repo.grep`, `artifact.write`, `sandbox.exec`, `shud.build`, `shud.run`, `rshud.read_output`, `rshud.compute_metrics`, `patch.apply`, `validator.run`。
  - `memory(draft)` 在 M1 表内使用 exact id `memory`，draft/proposal-only 语义只写入 `permissionNotes`。
- 快照测试：映射变更必须显式更新快照。
- 语义不变式单测：repo_explorer/reviewer 无写类工具；worker 无仓库源码编辑工具；spawn/wait 唯一归 coordinator；coordinator 无 bash/write/edit/patch；coder 独占 worktree edit+patch。

## Exact snapshot oracle

```json
{
  "coordinator": ["harness.job.collect", "harness.job.submit", "harness.report.generate", "memory", "read", "spawn_agent", "wait_agent"],
  "repo_explorer": ["git.inspect", "read", "repo.glob", "repo.grep", "repo.search"],
  "worker": ["artifact.write", "memory", "read", "rshud.compute_metrics", "rshud.read_output", "sandbox.exec", "shud.build", "shud.run"],
  "coder": ["bash", "edit", "memory", "patch.apply", "read", "write"],
  "reviewer": ["memory", "read", "validator.run"]
}
```

## Out of Scope
- 注册期 lint（→ #25）、guard_class（→ #26）。
- 修改 Roles_and_Boundaries §3 冻结正文（§3 散文修订注走账本例外流程，待办已列 proposal Impact；本表 + §0 + ADR-0002 定案优先于 §3 散文）。

## Task checklist
- [ ] 映射表常量落 `packages/core`（恰好 5 角色）。
- [ ] 快照测试覆盖 exact sorted `toolIds`。
- [ ] 4+ 条不变式单测。
- [ ] 命名裁决落实（无连字符工具注册名混入；`shud-build.ts` 等连字符仅为实现文件名）。

## Required reading
- P0 `openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md` — 前 3 个 Requirement + PI 确认附表 + exact id appendix + 冻结冲突裁决
- P0 `docs/02_ARCHITECTURE/Roles_and_Boundaries.md` — §0 权限类别（唯一具象化落点为本表）
- P0 `docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md` — §10 点分注册名
- P1 `docs/adr/0002-mvp-reality-anchoring.md` — 开工三决②（coordinator 无 bash）
- P1 `openspec/changes/m1-foundation/design.md` — Decision 5

## Acceptance Criteria
- [ ] 加载映射表恰好含 5 个 canonical 角色，无缺失无额外（spec Scenario）
- [ ] 不变式单测全过：只读角色无写 / spawn 权唯一 / coordinator 无 bash（spec 三个 Scenario）
- [ ] 修改角色集合未更新快照 → 测试失败（spec Scenario）

**PR Boundary:** `packages/core`（映射表常量 + 测试）+ OpenSpec fixture clarification；不改 docs 冻结正文、不实现校验逻辑
