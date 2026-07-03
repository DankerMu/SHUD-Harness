# monorepo-skeleton

Bun workspace 三包结构与 zero submodule 引用姿势。权威源：[Repository_Layout §1](../../../../../docs/04_IMPLEMENTATION/Repository_Layout.md)、[CANONICAL_CONTRACTS §1](../../../../../docs/00_INDEX/CANONICAL_CONTRACTS.md)、[Zero_Reuse_Matrix §7/§8](../../../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)。

## ADDED Requirements

### Requirement: Bun workspace 三包结构

仓库根 SHALL 定义 Bun workspace，包含 `packages/core`、`packages/backend`、`packages/frontend` 三包（命名遵 CANONICAL_CONTRACTS §1 / Repository_Layout；不使用早期草案的 harness-\*/apps/\* 命名）。三包 MUST 可互相解析引用（core 为共享领域层，backend/frontend 依赖 core）。

#### Scenario: 三包互引解析

- **WHEN** 执行 `bun install` 后从 backend 与 frontend 导入 core 的导出
- **THEN** 模块解析成功，类型检查通过

### Requirement: zero submodule 引用姿势

zero SHALL 保持为根目录 submodule 并钉在 13e25c1，M1 不 fork（[GRILL-1] 已定案 2026-07-03）；packages/* 对 zero 的引用 MUST NOT 修改 zero 源码（与 policy-gate-spike 的 diff=0 约束共享）。引用技术形态（workspace 纳入 vs `file:` 依赖 vs 运行时入口加载）在 spike 条 1（tasks 3.1）实现时实测确认并回写 design.md Decision 3；monorepo 初始化（tasks 2.1）先以标注 provisional 的形态落地，仅保证三包与 zero 可解析引用。

#### Scenario: zero 零改动

- **WHEN** monorepo 骨架与全部 M1 交付完成后检查 zero 子仓
- **THEN** `git -C zero diff --quiet` 为真且 `git -C zero rev-parse HEAD` 为 13e25c1

#### Scenario: 运行时入口可加载

- **WHEN** backend 按定案的引用形态加载 zero 运行时入口
- **THEN** 加载成功，无需改动 zero 内部文件

### Requirement: 包内目录规范

三包内部结构 SHALL 遵循 Repository_Layout §1 的目录约定（core: `src/domain/schemas | domain/services | tools | agent`；backend: `src/routes | ws | middleware`；frontend: `src/pages | layouts | components`）。

#### Scenario: 新文件落位检查

- **WHEN** M1 交付的源码文件归位完成
- **THEN** 目录结构与 Repository_Layout §1 一致（评审核对，偏差需在 PR 说明）
