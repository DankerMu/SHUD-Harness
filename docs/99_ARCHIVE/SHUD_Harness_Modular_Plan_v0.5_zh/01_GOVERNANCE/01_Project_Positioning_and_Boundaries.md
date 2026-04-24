# G-01 项目定位与边界

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：可选
- **[R] 已实现可复用**：通用 runtime、工具注册、session / logs / scheduler / web / supervisor
- **[M] 需修改后复用**：角色语义、memory 写入策略、skills 治理方式、Web IA
- **[N] 必须新增**：SHUD 科研对象、证据治理、版本锁、数据 provenance、BenchmarkPolicy、CalibrationSpec

## 1. 一句话定义
**SHUD-Harness 是一个以 Commander Agent 为主控、以受控 bash / executor 为主要动作空间、以技能与证据记忆为长期能力、以 Critic / Validation / Human Gate 为约束的 SHUD 科研运行时系统。**

## 2. 系统不是什麽
### 2.1 不是聊天 UI
它可以有聊天入口，但系统身份不是聊天产品，而是科研 runtime。

### 2.2 不是固定 DAG 工作流平台
它可以生成工作流和 schedule，但主控不是写死流程引擎，而是 Commander Agent。

### 2.3 不是单纯的 CI/CD
CI/CD 只能做代码回归；SHUD-Harness 还必须管理：
- 科研问题
- 实验设计
- 数据 provenance
- 结构诊断与参数校准边界
- claim / evidence / counter-evidence
- 人工审批与 release gate

### 2.4 不是 ZeRo 的插件壳
即使从 ZeRo 起步，最终也要形成 SHUD-Harness 自己的：
- research domain model
- governance layer
- benchmark policy
- version / provenance layer
- operator information architecture

## 3. 系统要解决的问题
### 3.1 科研带宽问题
研究者的时间不应该被下列重复劳动吞掉：
- 组织实验
- 跑 tiny / regression case
- 看日志
- 整理 before/after
- 检查 old-output 是否破坏
- 生成报告初稿

### 3.2 跨仓库联动问题
SHUD、rSHUD、AutoSHUD 不是孤立仓库。  
系统必须支持一次问题驱动多个仓库联动修改。

### 3.3 科学与工程脱节问题
系统必须避免：
- 工程上改了很多，科学上没有证据
- 单个案例分数提升被误当成模型进步
- 数据版本变化被误当成代码改进

## 4. 用户与系统角色
### 4.1 人类角色
- 科研负责人 / PI：定义问题、审批高风险变更、决定证据是否成立
- 研究软件工程师：实现 runtime、工具层、对象层、验证层
- 模型与数据维护者：维护 benchmark、数据目录和 manifests

### 4.2 系统角色
- Commander：主控
- Worker：短期执行
- Critic：审查
- Harness Optimizer：元优化（P2）

## 5. 当前阶段明确不做
- 不做全自动科研
- 不让 Agent 独立决定物理机制是否成立
- 不把 `.claude/` / `.codex/` 集成作为第一阶段重点
- 不先做大规模 HPC 校准平台
- 不让 Agent 直接写 canonical scientific memory
- 不让 Web Console 先退化成普通聊天 UI

## 6. ZeRo 参考边界
### [R] 可直接参考
- monorepo runtime 组织
- apps/server + apps/web + apps/supervisor
- tools / memory / observe / scheduler / supervisor 分层
- WebSocket + HTTP control plane
- `.zero/heartbeat.json` 心跳
- agent loop 与 sub-agent orchestration

### [M] 必须改造
- 角色从 Explorer / Coder / Reviewer 改成 Commander / Worker / Critic / Harness Optimizer
- memory 从“可直接 create verified”改成 proposal-only
- bash 从通用 shell 改成科研 sandbox
- chat/session 信息架构改成 RCS / Experiment / Run / Evidence / Validation / Change

### [N] SHUD-Harness 必须自己拥有
- ResearchChangeSet 与科研对象图谱
- StackLock / DatasetManifest / PreprocessRecipe / OutputContract
- CalibrationSpec / HoldoutPolicy / BenchmarkPolicy
- Human Gate / ReleaseGate / baseline overwrite control

## 7. 独立实现要求
即使完全不用 ZeRo，系统也应可由以下抽象自行实现：
- AgentKernel
- ToolRegistry
- Sandbox
- Executor
- MemoryRepository
- SkillRegistry
- ResearchObjectStore
- ObserveStore
- Operator API / UI

ZeRo 只是把这批抽象里的“通用 runtime 部分”先实现了一部分。
