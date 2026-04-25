# SHUD-Harness v0.8 中文设计补充包

**状态：** 设计补充文档包  
**适用版本：** SHUD-Harness v0.8，Web-first，TypeScript 全栈，基于 Zero 扩展  
**文件命名策略：** 文件名和目录名保持英文；文档标题、正文、表格、流程说明均为中文。

## 1. 本包目的

本补充包用于补齐 v0.8 设计中仍需要工程落地的部分，重点覆盖：Agent 架构、Zero 扩展点、Park/Resume、WebSocket 消息契约、前端状态、可视化数据、认证权限、报告生成、错误处理、Sandbox 执行器、SHUD 输出变量、敏感性/校准/benchmark、工作区约定、国际化、成本跟踪、部署、测试和 CI/CD。

本包不替换仓库中已经修正过的 canonical schema，也不重新定义已经统一的状态名。若本包中的对象字段与仓库最新 `Minimal_Schemas.md`、`Schemas_APIs_CLIs.md` 或 Zod schema 存在冲突，应以仓库现行 canonical schema 为准，并将本文对应段落作为实现建议进行合并。

## 2. 放置方式

建议将本包解压到仓库根目录后执行人工合并：

```text
SHUD-Harness/
  docs/
    02_ARCHITECTURE/
    03_SPEC/
    04_IMPLEMENTATION/
  README.md
  MANIFEST.md
```

如果仓库中已经存在同名文件，不建议直接覆盖。更稳妥的做法是：

1. 先将本包解压到临时目录；
2. 使用 `diff` 或 IDE 对照合并；
3. 对新增的 P0 文档优先并入；
4. 对 addendum 类文档选择性合并到原始规范；
5. 合并后运行 markdown lint 和 schema 测试。

## 3. 优先级说明

本包文档分为三类：

| 优先级 | 含义 | 文档示例 |
|---|---|---|
| P0 | 没有它会阻塞前后端并行开发或 Zero 接入 | Agent 架构、Zero 扩展、WebSocket 协议、Park/Resume |
| P1 | MVP 端到端闭环需要，但可以在骨架完成后补齐 | 前端状态、报告生成、错误处理、可视化数据、Sandbox |
| P2 | 面向可维护性、交付、演示和长期治理 | 国际化、CI/CD、部署、成本跟踪、测试策略 |

建议先处理 P0，然后实现一个不接 LLM 的 deterministic skeleton，最后再接入 Zero AgentLoop 和 LLM streaming。

## 4. 建议的最小实现路径

v0.8 的首个可运行闭环应避免一次性实现所有 Agent 能力。推荐顺序如下：

```text
创建 workspace
→ 创建 TaskCard
→ 生成 StackLock 与 DataProvenance
→ 提交 dummy 或 tiny SHUD RunJob
→ WebSocket 推送 job 日志
→ collect 生成 RunRecord
→ 生成 deterministic metrics
→ 前端展示 ExperimentDashboard
→ 生成 EvidenceReport 草稿
→ PI 在 Web UI 中审批或要求修订
```

当这条链路跑通后，再加入 Coordinator 的计划生成、Worker 的工具调用、Reviewer 的报告检查和 Coder 的 patch bundle。

## 5. 设计原则

1. **PI 主导，不做自治科研。** Agent 可以建议下一步，但不能把模型结果解释成科学结论。
2. **RunRecord 是可复盘核心。** 没有绑定 StackLock、DataProvenance、命令、日志、指标和 artifact 的结果，不应进入报告正文。
3. **长任务必须 Park/Resume。** SHUD 运行和 sensitivity 批处理不应让 LLM 会话持续等待。
4. **报告分离 deterministic evidence 与 LLM narrative。** 指标、图表、文件清单、日志摘要由脚本生成；LLM 只负责组织文字并标注限制。
5. **Zero 是 runtime 基础，不是领域模型。** Zero 提供 loop、session、tool、memory、WebSocket 等能力；SHUD-Harness 负责水文建模对象、科研治理和审批。

## 6. 与四个 submodule 的关系

建议运行时将四个关联仓库作为 stack 组成部分记录：

```text
submodules/SHUD      → C/C++ solver，编译与运行对象
submodules/rSHUD     → R 读写、分析、绘图和模型数据接口
submodules/AutoSHUD  → 自动建模脚本流水线
submodules/zero      → Agent runtime 基础
```

StackLock 应记录每个 submodule 的 commit、branch、dirty state、remote URL、构建环境和关键依赖版本。Agent 修改任何 submodule 前必须进入 ChangeRequest 流程，并由 PI 或具备权限的用户审批。

## 7. 包内文档

完整列表见 `MANIFEST.md`。新增文档集中在：

```text
docs/02_ARCHITECTURE/
docs/03_SPEC/
docs/04_IMPLEMENTATION/
```

其中 `*_Addendum.md` 表示建议合并到已有规范；非 addendum 文件则建议作为独立规范保留。
