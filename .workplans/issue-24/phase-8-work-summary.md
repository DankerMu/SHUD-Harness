## 工作情况说明（Merge 前）

- 关联 Issue：#24
- PR：#49
- 冻结提交：`d9fd2f0102e42de845a1b5e89409fff0198d6084`

### 背景与目标

- 本 PR 落 M1 5.1：在 `packages/core` 建立 canonical 五角色到 exact `toolIds` 的映射表，作为后续 spawn `allowed_tools` 子集校验基准。
- 边界限定在映射表常量、快照测试、不变式测试和 OpenSpec/issue oracle 澄清；不实现注册期 lint、guard_class、spawn policy 逻辑或 M4 memory adapter。

### 本次具体改动

- 新增 `packages/core/src/tools/role-tool-map.ts`，导出五角色映射、snapshot helper、subset helper。
- 新增 `packages/core/src/tools/role-tool-map.test.ts`，覆盖 exact snapshot、五角色、只读角色无写、spawn/wait 唯一、coordinator 无 bash/source edit、worker 无源码编辑、coder 独占 edit/patch。
- Review 过程中发现 raw Zero `memory` 与 proposal-only memory 语义冲突，已把可比较 id 收窄为 `harness.memory.propose`，并显式排除 raw Zero `memory`。
- 同步 OpenSpec fixture、live Issue #24、workplan evidence，避免后续 #20/#25 按旧 raw `memory` oracle 施工。

### 测试与验证

- 本地：`pnpm --package=bun@1.2.19 dlx bun run check` 通过。
- 本地：`openspec validate m1-foundation --strict --no-interactive` 通过。
- 本地：`git diff --check` 通过。
- 本地：`git -C zero diff --quiet` 通过，Zero HEAD 为 `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`。
- GitHub CI：`check`、`linux-base`、`macos-seatbelt` 均通过。

### Review 与修复闭环

- 6 路交叉 review + final gap sweep 执行完成。
- 已修复并关闭两个 verifier-confirmed finding：
  - raw Zero `memory` 不应进入 M1 comparable `toolIds`。
  - live Issue #24 / fixture-ready 旧证据不应继续保留 raw `memory` oracle。
- 最终综合复审与 Phase 7 gap sweep 均 clean。

### 兼容性、风险与已知限制

- `harness.memory.propose` 是未来 proposal-only memory adapter 注册 id，占位不等于实现；M4 前不会授权 raw Zero `memory`。
- #24 不实现实际 spawn 子集拒绝逻辑；#20/#3.4 会消费本映射表。
- `repo_explorer` 不含 memory proposal id；`reviewer` 只含 `harness.memory.propose`、`read`、`validator.run`。

### 维护者关注点

- 无额外关注点。
