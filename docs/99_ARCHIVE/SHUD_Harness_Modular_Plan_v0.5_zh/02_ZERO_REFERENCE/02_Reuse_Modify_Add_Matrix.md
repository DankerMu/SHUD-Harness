# Z-02 系统级 Reuse / Modify / Add 矩阵

## 目的
本文件是这套方案里最重要的执行矩阵之一。  
它把“考虑 ZeRo 实现”这件事，从口头判断变成**逐模块行动表**。

> 状态标签说明  
> **[R] 已实现可复用**：ZeRo 当前已有对应能力，可直接复用或小幅包装。  
> **[M] 需修改后复用**：ZeRo 当前有相邻能力，但不满足 SHUD-Harness 的科研语义、治理要求或对象模型，需要改造。  
> **[N] 必须新增**：ZeRo 当前没有这层能力，SHUD-Harness 必须新增实现。  
> **独立实现要求**：本方案的所有模块都要求在**不依赖 ZeRo** 的情况下可实现；ZeRo 仅作为参考实现和加速来源，不是硬前置。

## 1. 执行原则
- 先复用：能稳定复用的不重复造轮子
- 再改造：语义不够但结构已存在的做 targeted refactor
- 最后新增：不存在的科研能力单独建层

## 2. 模块矩阵
| 模块 | SHUD-Harness 独立契约 | ZeRo 当前状态 | 行动 | 说明 |
|---|---|---:|---|---|
| Runtime bootstrap | CLI / main / startup graph | 已有 | [R] | 可直接参考 `apps/server/src/main.ts` |
| Agent loop kernel | 可 hook 的 while-loop | 已有 | [R] | 直接借骨架 |
| Task closure | finish/continue/block | 已有 | [R] | 需换科研 prompt |
| Session / trace | session, logs, traces | 已有 | [R] | 可直接借结构 |
| Tool registry | 注册 / discover / invoke | 已有 | [R] | 可直接借 |
| Read / Write / Edit | 文件工具 | 已有 | [R] | 可直接借 |
| Bash | 通用 shell 调用 | 已有 | [M] | 要升级为科研 sandbox |
| Spawn / Wait agent | 子 agent 编排 | 已有 | [R] | Worker/Critic 可直接映射 |
| Scheduler | cron-style jobs | 已有 | [R] | 但不等于实验 executor |
| Supervisor / heartbeat | 进程守护 | 已有 | [R] | 可直接借 |
| Roles loader | `.zero/roles` | 已有 | [M] | 角色语义需换 |
| Skills loader | `.zero/skills/` + `SKILL.md` | 已有 | [M] | 增加 validator / lifecycle |
| Memory store | memory repository | 已有 | [M] | 语义必须改 |
| Memory create defaults | verified + confidence 默认写入 | 已有但错误方向 | [M] | 改成 proposal-only |
| Web control plane | operator web | 已有 | [M] | IA 需改成科研对象导航 |
| Benchmarks dir | benchmarks 目录框架 | 已有 | [M] | 需重写 SHUD benchmark policy |
| ResearchChangeSet | 科研主对象 | 无 | [N] | 必须新增 |
| ExperimentSpec | 实验对象 | 无 | [N] | 必须新增 |
| JobSpec | 长任务/批任务对象 | 无 | [N] | scheduler 不能替代 |
| Executor backend | local/docker/slurm/k8s | 无 | [N] | 必须新增 |
| RunManifest | 运行对象 | 部分相邻 | [N] | 需按 SHUD 语义新增 |
| EvidencePacket | claim/evidence 对象 | 无 | [N] | 必须新增 |
| ValidationReport | 评价对象 | 无完整语义 | [N] | 必须新增 |
| StackLock / EnvLock | 版本锁 | 无 | [N] | 必须新增 |
| DatasetManifest | 数据 manifest | 无 | [N] | 必须新增 |
| ObservationManifest | 观测 manifest | 无 | [N] | 必须新增 |
| PreprocessRecipe | 预处理 recipe | 无 | [N] | 必须新增 |
| CalibrationSpec | 校准对象 | 无 | [N] | 必须新增 |
| HoldoutPolicy | anti-leakage / promote 规则 | 无 | [N] | 必须新增 |
| OutputContract | 输出契约 | 无 | [N] | 必须新增 |
| CompatibilitySuite | old-output 兼容验证对象 | 无 | [N] | 必须新增 |
| BenchmarkPolicy | smoke/regression/scientific 分层 | 无 | [N] | 必须新增 |
| Human Gate | 科研审批对象 | 无 | [N] | 必须新增 |
| ReleaseGate | baseline/release promotion gate | 无 | [N] | 必须新增 |
| Provenance completeness checks | evidence 入库前检查 | 无 | [N] | 必须新增 |
| Benchmark warehouse | 指标仓 | observe 相邻 | [N] | 独立新增更稳 |
| Operator research pages | RCS/Run/Evidence/Validation/Change | 无 | [N] | 在现有 web 上新增 |
| `.claude` / `.codex` integration | 外部 AI 编码客户端 | 已有部分目录 | [R] | 当前阶段仍不优先使用 |

## 3. 强结论
### 3.1 可以直接复用的只有“通用 runtime 层”
真正可直接借的是：
- loop
- registry
- web shell
- trace
- sub-agent
- scheduler
- supervisor

### 3.2 需要改的主要是“通用语义”
必须改的地方主要集中在：
- bash
- memory
- roles
- skills
- web 信息架构
- task closure policy

### 3.3 科研系统最关键的部分几乎都得新增
新增项集中在：
- domain model
- version / provenance / contract
- calibration / holdout / benchmark governance
- gates
- evidence promotion

## 4. 优先级建议
### P0（先做）
- Agent loop kernel
- bash sandbox
- roles
- memory proposal-only
- skills validator
- RCS / Run / Evidence / Validation 基础对象

### P1（再做）
- JobSpec / local executor
- StackLock / DatasetManifest / PreprocessRecipe
- OutputContract / CompatibilitySuite
- BenchmarkPolicy smoke + regression

### P2（最后做）
- Harness Optimizer
- docker/slurm/k8s executor
- scientific-tier benchmark
- release gate automation

## 5. 这份矩阵怎么用
- 做架构评审时：看哪些模块标成 [N]
- 做工期评估时：把 [M]/[N] 当成真实工作量
- 做 ZeRo fork 时：优先从 [R] 处复制，再对 [M] 做 targeted refactor
- 做 greenfield 时：先按独立契约落接口，不看 ZeRo 细节也能实现
