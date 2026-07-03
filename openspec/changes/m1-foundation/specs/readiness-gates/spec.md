# readiness-gates

就绪收口：P0 Gate 验证与签核、校验脚本入库接 CI、依赖锁定、SHUD/rSHUD 环境复验。权威源：[MVP_Implementation_Readiness_Checklist](../../../../../docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md)、[Phased_Plan M1](../../../../../docs/04_IMPLEMENTATION/Phased_Plan.md)。

## ADDED Requirements

### Requirement: P0 九 Gate 验证与签核

系统 SHALL 在 M1 编码任务开始前，按 Readiness_Checklist「P0 Gate 验证方法」表逐项执行九个 Gate（gitmodules 可解析、submodule checkout、canonical index、core schema、support schema、API registry、error/idempotency、artifact registry、lock/recovery），并将签核结果写入 `workspace/readiness/readiness_gate_v0_8_1.yaml`（含 `checked_at` ISO8601、`checked_by`、`decision: pass | pass_with_notes | block` 与逐 Gate 结论）。

#### Scenario: 九 Gate 全过

- **WHEN** 九个 Gate 检查全部通过
- **THEN** 签核 YAML `decision: pass`，M1 编码任务解除阻塞

#### Scenario: schema/API/path/lock 冲突

- **WHEN** 任一 Gate 发现 schema、API、路径或锁契约冲突
- **THEN** 签核 YAML `decision: block`，不进入编码；仅文档格式问题时允许 `pass_with_notes` 并要求在 M1 CI 内修复

### Requirement: 校验脚本入库并接 CI

link check 脚本与 schema drift 检查 SHALL 入库 `scripts/` 并接入 CI；CI SHALL 在每次 PR 上运行 schema 校验 + link check + 基础单测。

#### Scenario: 文档链接断裂被拦截

- **WHEN** 提交的 PR 引入 docs 内断裂的相对 .md 链接
- **THEN** CI link check 失败并列出断链清单

### Requirement: packageManager 与 lockfile 固定

根 `package.json` SHALL 声明固定的 `packageManager`（Bun 版本），lockfile SHALL 入库；干净环境安装 MUST 可用冻结模式完成。

#### Scenario: 冻结安装

- **WHEN** 在干净 checkout 上执行 `bun install --frozen-lockfile`
- **THEN** 安装成功且不修改 lockfile

### Requirement: 初始 DependencyLock 生成

系统 SHALL 生成初始 DependencyLock 记录：四个 submodule（SHUD/rSHUD/AutoSHUD/zero）的 commit 与关键运行时依赖版本。

#### Scenario: gitmodules 解析

- **WHEN** 执行 `git config --file .gitmodules --get-regexp` 解析检查
- **THEN** 四个 submodule 均返回 path/url，且 DependencyLock 中的 commit 与 `git submodule status` 一致

### Requirement: SHUD make 复验与 rSHUD 在位确认

系统 SHALL 在本机完成一次 SHUD 编译复验（ADR-0002 D2：曾编译跑通，此处为复验）并记录环境快照（OS、编译器、SUNDIALS 版本）；SHALL 确认 rSHUD 2.5.0 在位。结果记入 readiness 签核 notes。

#### Scenario: make 复验通过

- **WHEN** 在本机执行 SHUD 构建（`./configure && make shud` 或仓库实际构建命令）
- **THEN** 退出码 0、可执行产物存在，环境快照与结论写入 readiness notes

#### Scenario: rSHUD 版本确认

- **WHEN** 查询本机 R 环境中 rSHUD 包版本
- **THEN** 版本 ≥ 2.5.0，结论写入 readiness notes
