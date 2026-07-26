# Stage 2 详细步骤：OpenSpec Artifact 逐个生成

> 由 [stage-flow.md](stage-flow.md) Stage 2 引用。目标与不可协商项（Grill 清单强制输入、seams 必须落 design.md、4/4 complete）在该文件；本文件只承载逐 artifact 的操作细节。

## 命令骨架

```bash
openspec new change "<stage-name>"
openspec status --change "<name>" --json   # 获取构建顺序
# 每个 artifact 撰写前取指令（artifact ∈ proposal | design | specs | tasks）：
openspec instructions <artifact> --change "<name>" --json
```

## 按依赖顺序生成

**proposal.md**（第一个，无依赖）：

- 基于设计文档写 Why / What Changes / Capabilities / Impact
- Capabilities 部分的每个 capability 用 kebab-case 命名，后续会生成对应 spec

**design.md**（依赖 proposal）：

- 写技术决策（选型理由、备选方案）、风险和缓解
- 如果技术决策还没有稳定依据，先用 `future-aware-architecture` 形成架构决策输入
- 领域概念多、术语易漂时，用 `grill-with-docs` 对齐术语并 inline 沉淀到 `openspec/glossary.md`/`docs/adr/`，再定稿 design/specs
- **Sketch seams under test**（自动，不设交互停点）：写下测试将行使的公共边界——优先已有 seam、用最高的 seam、越少越好（理想一个），每个 seam 附一行选择理由，直接记入 design.md。监督走既有回路：Stage 3 三路审核与下游 fixture review 会检查该清单，无需专门向用户确认。清单随 fixture 流入 `subagent-workflow`（fixture 模板的 `Seams under test` 字段），实现期只消费、不再谈判——测试精力据此落在关键路径而非每个边角

**specs/**（依赖 proposal，可与 design 并行）：

- 为 proposal 中列出的每个 capability 创建 `specs/<capability>/spec.md`
- 每个 spec 包含 `## ADDED Requirements`，每个 Requirement 下有 `#### Scenario:` 用 WHEN/THEN 格式
- capability 数量多时（>4），用并行 agent 分批写入

**tasks.md**（依赖 design + specs）：

- 按 capability 分组，每个任务用 `- [ ] X.Y 描述` 格式
- 任务粒度：单个 session 可完成；任务顺序：按依赖关系排列
- 如果任务依赖、验证或回滚路径复杂，先用 `implementation-planning` 产出执行计划，再写 tasks

## 收尾验证

```bash
openspec status --change "<name>"
```

确认 4/4 artifacts complete，然后回 SKILL.md 进入 Stage 3。
