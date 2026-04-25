---
title: 关于建设 SHUD-Harness 科研平台的汇报
subtitle: 将 SHUD 模型研发转化为可复盘、可验证、可协作的科研工程流程
date: 2026-04-25
audience: 博导 / PI / 课题组负责人
status: draft
tags:
  - SHUD
  - research-platform
  - agent-harness
  - proposal
---

# 关于建设 SHUD-Harness 科研平台的汇报

> [!summary] 汇报结论
> 拟建设 **SHUD-Harness**：一套面向 SHUD / rSHUD / AutoSHUD 模型体系的 **PI 主导型科研工程平台**。  
> 平台目标不是让 AI 替代科研判断，而是把模型运行、诊断分析、跨仓库改动验证、证据报告和审批复盘，组织成可追踪、可重复、可协作的标准流程。

![[assets/final-workbench-effect.png]]
_图 1：SHUD-Harness 最终使用效果图，展示任务、运行记录、实验仪表盘、证据报告和 PI 决策面板。_

---

## 1. 建设目标

SHUD-Harness 拟建设为一套围绕 SHUD 模型系统的 **科研工作台 + Agent 执行层 + 证据治理层**。它不是聊天机器人，也不是零散脚本集合，而是面向课题组长期模型研发的工程化科研底座。

核心形态包括：

- **PI / 研究者** 在浏览器中提出研究问题、修订研究计划、选择数据与参数、查看运行过程、介入失败诊断、审阅实现改动、批注证据报告，并对高风险动作作出批准或拒绝。
- **Coordinator Agent** 将研究问题拆解为可执行任务，但不替代 PI 作科学结论。
- **Repo Explorer / Worker / Reviewer** 分别承担仓库上下文探索、编译运行解析绘图、兼容性检查和报告审查。
- **Harness Runtime** 管理版本锁、数据溯源、沙箱执行、长任务 Park/Resume、日志、artifact 和 RunRecord。
- **SHUD / rSHUD / AutoSHUD** 继续作为科学模型栈，由平台稳定编排、验证和复盘。

研究者不是流程末端的“审批者”，而是贯穿完整科研闭环的参与者。平台应提供以下交互入口：

| 阶段 | 研究者交互入口 | 形成的记录 |
|---|---|---|
| 问题定义 | 在 Workbench 输入研究问题、流域、事件、约束和禁止动作 | `TaskCard` |
| 计划形成 | 审阅并修改 Agent 生成的实验计划、参数空间、数据选择和指标集合 | `AnalysisPlan` |
| 执行监控 | 查看 Agent 活动流、运行日志、批任务进度和失败项；必要时暂停、重跑或调整约束 | `RunJob` / `ErrorRecord` |
| 诊断分析 | 在过程线、指标卡、敏感性图和失败诊断中补充研究判断 | `RunRecord` / `Artifact` |
| 实现改动 | 审阅 ChangeRequest、diff、patch bundle 和兼容性检查结果 | `ChangeRequest` |
| 报告决策 | 对 EvidenceReport 加批注，选择下一步动作，批准、拒绝或要求修订 | `PiGateDecision` / `MemoryNote` |

![[assets/system-architecture.png]]
_图 2：SHUD-Harness 的平台边界：PI 负责科学判断，Agent 负责执行闭环，Harness 负责证据链与复现。_

> [!important] 平台定位
> SHUD-Harness 的定位是 **PI-led scientific research engineering assistant**。  
> 成功标准不是提高 AI 自治程度，而是减少重复工程劳动，把 PI 和研究人员的时间集中到提出问题、判断证据和决定研究方向上。

![[assets/pi-evidence-review.png]]
_图 3：PI 与研究工程师围绕 EvidenceReport 审阅结果，而不是围绕零散日志和临时脚本做判断。_

---

## 2. 整个平台建设方案

SHUD-Harness 的建设不是单点功能开发，而是围绕 **任务、执行、证据、治理、交付** 五条主线逐步成型。根据 `Phased_Spec_Activation.md`，完整项目应按 6 个阶段推进，每一阶段只激活该阶段直接依赖的规范，避免一开始就把 70 多份文档全部压到实现中。

![[assets/platform-construction-plan.png]]
_图 4：SHUD-Harness 整个平台建设方案。6 个阶段建立在 canonical contracts、核心对象、support schema、workspace safety、artifact registry 和 PI-led governance 之上。_

### 2.1 六阶段建设路线

| 阶段 | 建设重点 | 主要交付能力 | 关键事实源 |
|---|---|---|---|
| Phase 1 | 骨架可运行 | Bun/TypeScript monorepo、共享 Zod schema、workspace 初始化、TaskCard CRUD API、四栏 Workbench 壳 | `Phased_Spec_Activation.md`、`Repository_Layout.md`、`Minimal_Schemas.md` |
| Phase 2 | 执行闭环 | RunJob submit、Sandbox 执行、WebSocket 日志流、collect、RunRecord、Park/Resume、服务重启恢复 | `Execution_Jobs_Runs.md`、`Runner_Adapter_Contracts.md`、`WebSocket_Protocol.md` |
| Phase 3 | 科学运行 | SHUD ccw tiny、StackLock/DataProvenance 绑定、Artifact 登记、HydrographChart、首个 SHUD skill | `SHUD_Output_Variables.md`、`Artifact_Registry_Spec.md`、`Visualization_Data_Spec.md` |
| Phase 4 | 分析引擎 | AnalysisPlan、敏感性/校准/benchmark、BatchProgressGrid、ParameterSetTable、SensitivityHeatmap、ChangeRequest | `Sensitivity_Calibration_Benchmark.md`、`Parameter_Set_And_Analysis_Run_Mapping.md` |
| Phase 5 | 报告与治理 | EvidenceReport、Reviewer 检查、PI gate、HTML/Markdown 导出、notification、audit chain | `Report_Generation_Spec.md`、`PI_Decision_Comments_Spec.md`、`Report_Export_Spec.md` |
| Phase 6 | 集成打磨与交付 | 多用户、小团队部署、Playbook E2E、Zero/LLM 集成、CI/CD、运维与发布 | `Deployment_Architecture.md`、`Testing_Strategy.md`、`CICD_Release.md` |

### 2.2 跨阶段不变的建设底座

整个平台必须始终保持六个不变底座：

- **Canonical contracts**：字段以 `Minimal_Schemas.md` 和 `Support_Schema_Contracts.md` 为事实源，实现后由 Zod schema 接管最高事实源。
- **8 个核心对象**：`TaskCard`、`StackLock`、`DataProvenance`、`RunJob`、`RunRecord`、`AnalysisPlan`、`EvidenceReport`、`ChangeRequest` 不随功能扩张而膨胀。
- **Support schema**：Artifact、ErrorRecord、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、AuditEvent 等只做支撑对象，不升级为新的科研核心对象。
- **Workspace safety**：根目录 submodule 是只读参考源，代码修改必须发生在 runtime workspace / task worktree 中。
- **Artifact registry**：进入报告、图表、导出和复盘的文件必须登记 artifact metadata 和 manifest，临时文件不能直接作为证据。
- **PI-led governance**：Agent 可以执行、整理、建议，但不能批准科学结论、覆盖 benchmark baseline、修改默认参数或绕过 PI gate。

### 2.3 建设主线

从工程管理角度，SHUD-Harness 的建设可以拆成五条并行主线：

| 主线 | 目标 | 关键产物 |
|---|---|---|
| Web 工作台 | 让 PI / 研究者在浏览器中提出任务、跟踪运行、审阅证据、作出决策 | Dashboard、Workbench、ReportFullscreen、Ops Dashboard |
| 执行与恢复 | 让 SHUD/rSHUD/AutoSHUD 的运行可提交、可监控、可恢复、可复盘 | RunJob、RunnerAdapter、Park/Resume、RunRecord |
| 数据与证据 | 让每次运行的数据、环境、输出和图表都有来源与留痕 | StackLock、DataProvenance、ArtifactManifest、warehouse |
| 分析与变更 | 让敏感性、校准、benchmark 和跨仓库代码修改进入统一流程 | AnalysisPlan、BatchProgressGrid、ChangeRequest、patch bundle |
| 报告与治理 | 让结果以 EvidenceReport 呈现，并由 Reviewer 和 PI gate 约束科学边界 | EvidenceReport、PiGateDecision、ReportExport、AuditEvent |

---

## 3. 系统架构设计

系统架构采用 TypeScript 全栈，在 Zero agent runtime 基础上扩展 SHUD 领域逻辑。整体不是“一个聊天前端 + 若干脚本”，而是由 Web 工作台、Hono API、共享领域 schema、Zero-based Agent Runtime、Runner/Sandbox、workspace 存储和科学模型栈共同构成。

![[assets/system-architecture-detailed.png]]
_图 5：SHUD-Harness 系统架构图。控制流从 PI / 研究者进入 Web Workbench，证据流从 Scientific Stack 经 RunRecord / Artifact 回到 EvidenceReport 和 PI Decision。_

### 3.1 七层架构

| 层级 | 组成 | 职责 |
|---|---|---|
| React Web Workbench | Dashboard、SideNav、AgentActivityFeed、ExperimentDashboard、ResultsPanel、ReportFullscreen、Ops Dashboard | 提供唯一主交互入口；承载任务创建、实时状态、图表、报告、PI decision 和运维视图 |
| Bun/Hono REST API + WebSocket Session | REST API、`/ws/session/:sessionId`、Auth/Session、API error/idempotency | 提供任务、运行、分析、报告、审批、artifact 和运维接口；通过 WebSocket 推送日志、状态、成本和审批事件 |
| Core Domain Services | Shared Zod schemas、Task/Job/Report 服务、Artifact Registry、Permission/Audit、Snapshot/Recovery | 维护核心对象状态，执行 schema 校验，保证报告引用、权限检查、快照恢复和审计一致 |
| Zero-based Agent Runtime | Coordinator、Repo Explorer、Execution Worker、Analysis Worker、Coder、Reviewer、Memory Curator、TaskCard state machine、PI gate | 复用 Zero 的 AgentLoop、Session、WebSocket、Tool、Skills，并加入 SHUD 的 Park/Resume、科研 closure 和治理规则 |
| Execution Layer | Sandbox Executor、RunnerAdapter、`local_direct`、`local_job`、`docker_job`、未来 `slurm`、Park/Resume watcher | 统一命令审计、路径限制、日志落盘、长任务提交、状态收集和服务重启恢复 |
| Workspace & Storage | workspace filesystem、DuckDB/Parquet warehouse、artifact manifests、event log、reports、locks、notifications、secrets redaction | 保存任务、运行、报告、artifact、事件、指标索引、锁和通知记录；保证复盘与运维可恢复 |
| Scientific Stack | Source submodules：SHUD、rSHUD、AutoSHUD、zero；runtime repos/worktrees；raw data read-only；processed data | 提供水文求解、R 解析分析、自动建模脚本和 Zero runtime 基础；raw data 只读，代码修改在 worktree 中完成 |

### 3.2 控制流与证据流

平台内部有两条必须分开的流：

| 流 | 路径 | 说明 |
|---|---|---|
| 控制流 | PI / 研究者 -> Workbench -> REST/WS -> Coordinator -> Repo Explorer/Worker/Coder/Reviewer -> Runner/Sandbox | 负责任务创建、仓库上下文探索、计划、执行、审批请求、重跑、取消和下一步选择 |
| 证据流 | SHUD/rSHUD/AutoSHUD -> RunRecord -> Artifact Registry -> EvidenceReport -> PI Decision | 负责把命令、日志、指标、图表、patch、报告和决策记录沉淀为可复盘证据 |

WebSocket 只承载实时事件和日志展示，不作为 EvidenceReport 的证据源。报告只能引用 `RunRecord`、`Artifact`、`DataProvenance`、`PiGateDecision` 等持久化对象。

### 3.3 与四个仓库的关系

| 仓库 | 在系统中的位置 | 使用方式 |
|---|---|---|
| SHUD | Scientific Stack / runtime repos | C++ 求解器，执行 build/run，产生二进制输出和水文过程数据 |
| rSHUD | Scientific Stack / analysis scripts | 读取 SHUD 输出，计算水量平衡、指标和图表数据 |
| AutoSHUD | Scientific Stack / workflow scripts | 提供自动建模流程脚本，作为可执行脚本链被编排 |
| zero | Zero-based Agent Runtime foundation | 提供 AgentLoop、Session、WebSocket、Tool、Memory、Skills、Hono + React 基础设施 |

根目录 submodule 只作为 source reference 和 StackLock 基线。任何代码修改都必须进入 runtime workspace 的 task worktree，并通过 `ChangeRequest`、compatibility checks 和 patch bundle 输出。

### 3.4 为什么该架构适合科研平台

该架构把“实时协作体验”和“可复盘证据链”解耦：前端可以实时显示 Agent 活动、日志和图表，但正式报告不依赖临时 UI 状态；执行层可以支持本地、Docker 和未来 SLURM，但上层只看到统一的 RunJob/RunRecord；Agent 可以帮助拆解和执行任务，但科学判断最终落在 PI gate 和 EvidenceReport decision history 中。

---

## 4. 建设必要性

SHUD 当前已经不是单一 C++ 程序，而是一个持续演进的模型系统：

| 组成 | 当前作用 | 现实问题 |
|---|---|---|
| SHUD | C++ 水文数值求解核心 | 输出、参数、物理过程改动风险高 |
| rSHUD | R 工具包，负责输入/输出、分析、可视化 | API 和输出格式需要长期兼容 |
| AutoSHUD | 自动建模与流程脚本 | 脚本链长，依赖多，复现成本高 |
| Zero runtime | Agent/Web 基础设施 | 需要改造成科研证据约束的 runtime |

当前瓶颈已经不只是“模型是否能够完成单次运行”，而是：

- 一个科学问题能否快速转化为可执行实验；
- SHUD 改动是否会破坏 rSHUD 和 AutoSHUD 的既有流程；
- 指标改善是否来自模型机制改进，而不是环境、数据、参数或偶然扰动；
- 失败诊断、调参经验和 benchmark 结果能否被课题组复用。

![[assets/why-now-pressure.png]]
_图 6：当前 SHUD 模型栈进入跨仓库、可复现、可治理阶段后的核心压力。_

> [!warning] 不建设平台的主要风险
> 模型越复杂，单靠人工记忆、手工命令和零散脚本越难维护。  
> 长期拖慢科研产出的不只是单次运行时间，而是运行前后的组织成本、复盘成本和可信度成本。

---

## 5. 建成后的直接价值

### 5.1 对 PI / 研究者：更快获得可判断证据

平台会将一次研究任务组织成可审阅的证据包：

1. 问题摘要；
2. 使用的数据、代码和环境版本；
3. 运行命令、日志和资源记录；
4. 指标、图表和 artifact；
5. 当前证据支持什么、不支持什么；
6. 需要 PI 判断或审批的问题；
7. 建议的下一步研究动作。

PI 和研究者看到的不是一句笼统的“模型有所改善”，而是一份有来源、有边界、可追踪的 **EvidenceReport**。

### 5.2 对工程实现：降低跨仓库改动成本

例如要为 SHUD 添加新的 event-scale diagnostics 输出，传统方式通常需要人工完成：

- 修改 SHUD 输出；
- 确认旧输出格式不被破坏；
- 更新 rSHUD reader；
- 检查 AutoSHUD 后处理；
- 运行 tiny benchmark；
- 整理说明和复盘材料。

SHUD-Harness 将这些动作标准化为任务闭环：baseline run -> 修改 -> after run -> rSHUD roundtrip -> compatibility check -> patch bundle -> evidence report。

### 5.3 对课题组：沉淀可复用科研资产

每一次运行不再是临时行为，而会沉淀为结构化资产：

- `StackLock`：当时的代码、环境和工具版本；
- `DataProvenance`：数据来源、预处理和不确定性；
- `RunRecord`：命令、日志、资源、指标和数值健康；
- `Artifact`：输出、图表、报告和 patch；
- `MemoryNote / Skill`：可复用经验和自动化流程。

![[assets/research-loop.png]]
_图 7：从研究问题到可复用科研资产的闭环。_

> [!success] 核心收益
> 将“人工重复劳动”转化为“可复用平台能力”：小案例验证、失败诊断、输出兼容性检查、敏感性分析、报告生成和审批记录，都可以逐步成为课题组共享资产。

---

## 6. 典型使用场景

假设 PI 提出任务：

> “ccw 暴雨事件洪峰偏低，先做 ksat 和 roughness 的敏感性分析，不要修改物理方程。”

平台执行流程如下：

1. 创建 `TaskCard`，记录研究目标和边界；
2. 锁定 `StackLock`，记录 SHUD / rSHUD / AutoSHUD / Zero 的 commit 和环境版本；
3. 注册 `DataProvenance`，记录 ccw 流域、事件窗口、输入数据和观测数据；
4. 生成 `AnalysisPlan`，定义参数空间、指标和停止条件；
5. 运行 baseline 和参数扫描；
6. 生成过程线、误差表和敏感性图；
7. 生成 EvidenceReport；
8. PI 基于证据决定：继续 holdout、尝试工程改动，或暂缓。

在这个过程中，研究者可以多次介入：在生成 `AnalysisPlan` 时修改参数空间和评价指标；在运行过程中查看失败项并要求重跑、排除或补充实验；在需要修改代码时审阅 `ChangeRequest` 和 diff；在报告阶段对关键观察加批注，并把下一步动作写入 PI decision。

> [!note] 科学责任边界
> Agent 可以报告：“在 ccw 这个事件窗口内，某个参数扰动对洪峰误差有明显影响。”  
> Agent 不能裁定：“模型机制已经被验证”或“该方案普遍有效”。  
> 科学结论仍由 PI 负责。

---

## 7. 为什么不是只写脚本

脚本可以解决“某一次任务如何执行”，但难以解决长期平台问题：

| 问题 | 零散脚本 | SHUD-Harness |
|---|---|---|
| 版本可追踪 | 依赖人工记录 | StackLock 自动记录 |
| 数据溯源 | 容易遗漏 | DataProvenance 结构化 |
| 长任务 | 人等命令结束 | Park/Resume |
| 失败复盘 | 靠个人经验 | ErrorRecord + RunRecord |
| 报告 | 手工整理 | EvidenceReport 模板化 |
| 高风险动作 | 靠口头约定 | PI gate |
| 跨仓库改动 | 容易漏测 | ChangeRequest + compatibility checks |

因此，本项目拟建设的是 **Harness**，不是脚本库。Harness 的价值在于把运行、证据、审批、复现和复盘统一到同一套流程中。

---

## 8. 启动阶段：Phase 1 最小闭环

基于完整建设方案，第一步不建议直接接入真实长任务、完整 AgentLoop 或 SHUD 物理核心改动。Phase 1 的目标是建立平台骨架和契约，验证 Web 工作台、TaskCard、workspace、task API 和质量门禁能够闭环，为后续执行、科学运行、分析引擎、报告治理和部署交付打基础。

当前 Phase 1 已拆分为 1 个 epic 和 6 个 OpenSpec changeset：

| GitHub Issue | Changeset | 目标 |
|---|---|---|
| #1 | Phase 1 epic | Phase 1 总入口 |
| #2 | `phase1-monorepo-foundation` | Bun/TypeScript monorepo 基座 |
| #3 | `phase1-core-schemas` | TaskCard / Artifact / ErrorRecord 等 schema |
| #4 | `phase1-workspace-snapshot` | workspace 初始化和 task snapshot |
| #5 | `phase1-task-api` | workspace/task API |
| #6 | `phase1-web-workbench-shell` | Dashboard + 四栏 Workbench 壳 |
| #7 | `phase1-quality-gates` | typecheck、测试、docs link、health checks |

Phase 1 只验证四件事，不代表完整项目边界：

- 浏览器可以创建任务；
- 后端可以持久化任务；
- 刷新后可以恢复任务状态；
- schema、API、UI、文档检查形成最小质量门禁。

> [!tip] Phase 1 的意义
> 如果没有这个骨架，后续直接接入 SHUD、WebSocket 和 AgentLoop，很容易变成不可复盘的演示系统。  
> Phase 1 的价值是先把“骨架、契约和质量门禁”立住。

---

## 9. 拟请老师确认与支持的事项

### 9.1 方向确认

拟请老师确认三项原则：

- 项目定位为 **PI 主导的科研工程平台**，不做自治科研平台；
- 开发节奏采用 phase gate，按阶段验收，不按自然周硬切；
- 坚持 evidence-first 原则：没有 `RunRecord` / `StackLock` / `DataProvenance` 支撑的结论，不进入正式科研报告。

### 9.2 资源支持

最小团队配置建议如下：

| 角色 | 投入 | 主要职责 |
|---|---:|---|
| PI / 博导 | 低频但关键 | 定方向、审报告、批准高风险决策 |
| 研究生 / 领域研究者 | 高频 | 提出任务、修订计划、跟踪运行、补充诊断、整理科学判断 |
| 研究软件工程师 | 主力 | 实现 Harness、API、UI、runner、验证流程 |
| 数据支持 | 兼职 | benchmark 数据、观测数据、预处理脚本维护 |

### 9.3 试点选择

第一个真实科研闭环建议选择 **ccw tiny / ccw 暴雨事件**：

- 数据和示例相对成熟；
- 运行成本可控；
- 可以快速验证报告、过程线、指标和兼容性检查；
- 适合作为 Phase 2 执行闭环和 Phase 3 科学运行的真实试点。

---

## 10. 风险与控制

| 风险 | 控制方式 |
|---|---|
| AI 夸大科学结论 | 报告语言限制 + PI gate |
| 结果不可复现 | StackLock + DataProvenance + RunRecord |
| 改代码破坏旧输出 | tiny benchmark + rSHUD roundtrip + compatibility check |
| 平台过度设计 | Phase 1 只做 deterministic skeleton |
| 长任务消耗 LLM tokens | Park/Resume，等待期间不消耗推理 |
| 文档和实现漂移 | OpenSpec changeset + schema drift check |

> [!caution] 项目纪律
> SHUD-Harness 不能变成“Agent 自己研究”。  
> 正确边界应始终保持为：**PI 提出问题，平台执行闭环，报告提供证据，PI 作出判断**。

---

## 11. 阶段验收标准

短期验收标准：

- Phase 1 骨架可运行；
- GitHub issues 与 OpenSpec changeset 对齐；
- 可以从 Web 创建任务并恢复状态；
- schema/API/UI/test/docs 有最小质量门禁。

中期验收标准：

- 能完成 RunJob submit、WebSocket 日志流、collect、RunRecord、Park/Resume；
- 能一键执行 ccw tiny，并生成水文过程线与基础指标；
- 能用 rSHUD 解析输出并计算 water balance / hydrograph 数据；
- 能把 RunRecord 和 Artifact 注册为 EvidenceReport 的证据来源。

长期验收标准：

- 能完成敏感性/校准/benchmark 的 AnalysisPlan batch 和 BatchProgressGrid；
- EvidenceReport 通过 Reviewer 检查、PI gate、HTML/Markdown 导出和 audit chain；
- 关键模型改动都有 ChangeRequest、patch bundle、benchmark 和兼容性证据；
- 小团队部署具备多用户、健康检查、ops dashboard、CI/CD 和可复现交付能力。

---

## 12. 建议决策

> [!quote] 建议结论
> 建设 SHUD-Harness 不是追逐 AI 热点，而是解决 SHUD 模型系统进入持续演进阶段后必然出现的工程化科研问题：效率、复现、证据链、跨仓库一致性和团队经验沉淀。

本次汇报建议确认 **SHUD-Harness 完整项目建设方向**，并授权启动 **Phase 1** 作为第一阶段低风险验证：

- 不触碰 SHUD 物理核心；
- 不运行真实长任务；
- 不接入复杂自治 Agent；
- 只验证最小 Web 工作台、schema、workspace、task API 和质量门禁。

如果 Phase 1 验收通过，再按 Phase 2 到 Phase 6 依次进入执行闭环、科学运行、分析引擎、报告治理和集成交付。这样可以在投入可控的前提下验证完整方向，避免过早建设成不可维护的大型演示系统。

---

## 附：本报告依据

- [[../SPEC_v0.8_Final|SHUD-Harness 实施规格书 v0.8]]
- [[../Phased_Spec_Activation|分阶段开发路线图]]
- [[../00_INDEX/CANONICAL_CONTRACTS|Canonical Contracts Index]]
- [[../00_INDEX/Requirements_Catalog|SHUD-Harness Requirements Catalog]]
- [[../02_ARCHITECTURE/Agent_Architecture|Agent 架构]]
- [[../02_ARCHITECTURE/Control_Kernel|极简 Runtime Kernel]]
- [[../02_ARCHITECTURE/Interaction_Model|Web 科研工作台交互模型]]
- [[../02_ARCHITECTURE/Roles_and_Boundaries|角色边界]]
- [[../02_ARCHITECTURE/Research_Constitution|科研宪法与治理规则]]
- [[../02_ARCHITECTURE/Zero_Reuse_Matrix|Zero 复用与扩展路线]]
- [[../03_SPEC/Minimal_Schemas|8 个核心对象 Schema]]
- [[../03_SPEC/Support_Schema_Contracts|Support schema 契约]]
- [[../03_SPEC/Execution_Jobs_Runs|执行、长任务、RunRecord 与恢复]]
- [[../03_SPEC/Runner_Adapter_Contracts|Runner Adapter 契约]]
- [[../03_SPEC/Workspace_Conventions|Workspace 约定]]
- [[../03_SPEC/Artifact_Registry_Spec|Artifact Registry 规范]]
- [[../03_SPEC/Frontend_State_Design|前端状态设计]]
- [[../03_SPEC/WebSocket_Protocol|WebSocket 协议]]
- [[../03_SPEC/Auth_Permission_Design|认证与权限设计]]
- [[../03_SPEC/Report_Generation_Spec|EvidenceReport 生成规范]]
- [[../03_SPEC/Sensitivity_Calibration_Benchmark|敏感性、校准与 Benchmark]]
- [[../04_IMPLEMENTATION/Repository_Layout|仓库结构]]
- [[../04_IMPLEMENTATION/Schemas_APIs_CLIs|REST API、WebSocket 与 Schemas]]
- [[../04_IMPLEMENTATION/Deployment_Architecture|部署架构]]
- [[../04_IMPLEMENTATION/Phased_Plan|阶段实施任务清单]]
- `openspec/changes/phase1-*`
- GitHub Issues: #1 - #7
