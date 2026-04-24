# Z-03 无 ZeRo 独立实现策略（ZeRo 仅作参考加速）

## 模块状态标签
- **独立实现**：本文核心
- **ZeRo 参考实现**：可选
- **[R] 已实现可复用**：若使用 ZeRo，可跳过部分底座工作
- **[M] 需修改后复用**：若使用 ZeRo，需定制适配
- **[N] 必须新增**：即便不使用 ZeRo 也必须实现的科研层

## 1. 目标
本文件回答的问题是：

> 如果完全不依赖 ZeRo，SHUD-Harness 该怎么自己实现？

答案是：按**抽象接口优先**的方式实现，避免系统身份绑在任何上游 runtime 上。

## 2. 独立实现的九个核心抽象
### 2.1 AgentKernel
职责：
- loop
- continuation
- tool call orchestration
- budget / stop conditions
- sub-agent dispatch
- pause / block / escalate

### 2.2 ToolRegistry
职责：
- register
- validate input
- invoke
- trace
- permission policy

### 2.3 Sandbox
职责：
- workspace isolation
- raw data read-only
- worktree / scratch / artifact mounts
- shell execution
- diff capture

### 2.4 Executor
职责：
- `submit / watch / collect / cancel / retry`
- local
- docker
- future slurm / k8s

### 2.5 ObserveStore
职责：
- command trace
- tool trace
- job events
- artifacts
- validation results
- warehouse

### 2.6 MemoryRepository
职责：
- proposal store
- promoted memory store
- retrieval by state
- type partition

### 2.7 SkillRegistry
职责：
- validate `SKILL.md`
- install
- retrieve
- usage scoring
- promotion / deprecation

### 2.8 ResearchObjectStore
职责：
- RCS
- ExperimentSpec
- StackLock
- DatasetManifest
- CalibrationSpec
- JobSpec
- RunManifest
- EvidencePacket
- ChangeSpec
- ValidationReport
- BenchmarkPolicy
- ReleaseGate

### 2.9 Operator API / UI
职责：
- review
- browse
- approve/reject
- inspect traces
- inspect jobs
- inspect evidence / validation / compatibility

## 3. 推荐的独立实现最小接口
### 3.1 AgentKernel
```ts
interface AgentKernel {
  run(input: AgentInput): Promise<KernelResult>;
  pause(reason: string): Promise<void>;
  resume(resumeToken: string): Promise<void>;
}
```

### 3.2 Executor
```ts
interface Executor {
  submit(job: JobSpec): Promise<JobHandle>;
  watch(handle: JobHandle): Promise<JobStatus>;
  collect(handle: JobHandle): Promise<JobCollection>;
  cancel(handle: JobHandle): Promise<void>;
}
```

### 3.3 Memory
```ts
interface MemoryRepository {
  createProposal(input: MemoryProposalInput): Promise<MemoryProposal>;
  reviewProposal(id: string, review: CriticReview): Promise<void>;
  promoteProposal(id: string): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryHit[]>;
}
```

### 3.4 Skill
```ts
interface SkillRegistry {
  validate(dir: string): Promise<ValidationResult>;
  install(dir: string): Promise<SkillRecord>;
  retrieve(query: SkillQuery): Promise<SkillRecord[]>;
  promote(proposalId: string): Promise<void>;
}
```

## 4. 为什么这种抽象对你更安全
### 4.1 防止上游绑定
如果未来不想继续跟 ZeRo 演进节奏走，系统仍能持续。

### 4.2 防止把“参考实现”误当“业务模型”
ZeRo 只提供通用 runtime，不提供 SHUD 科研语义。

### 4.3 方便双路径推进
可以同时维护：
- Greenfield path
- Zero-accelerated path

二者共享同一套文档和抽象契约。

## 5. 双路径推进方式
### 路线 A：完全独立实现
适合：
- 想要完全控制目录、命名、依赖和部署环境
- 不想受 Bun/TypeScript 或 ZeRo 历史包袱影响
- 未来可能接 HPC / on-prem / 私有数据中心

### 路线 B：ZeRo 加速实现
适合：
- 想尽快拿到可运行 loop
- 需要 web / scheduler / sub-agent / trace 底座
- 接受前期先沿用 `.zero` 目录与部分命名

## 6. 共享不变的契约
无论 A 还是 B，以下对象都必须一致：
- RCS
- StackLock
- DatasetManifest
- CalibrationSpec
- JobSpec
- RunManifest
- EvidencePacket
- ChangeSpec
- ValidationReport
- BenchmarkPolicy

换句话说：**实现路径可以不同，科研对象和治理规则不能漂移。**

## 7. 推荐的代码组织策略
### 7.1 先写 schema，再写实现
顺序建议：
1. schema
2. store
3. APIs / CLI
4. runtime integration
5. UI

### 7.2 先写 local executor，再谈 slurm
这样能保证 tiny loop 和 regression loop 先闭环。

### 7.3 先写 proposal-only memory，再写 fancy retrieval
这样能先守住科学治理底线。

## 8. 当采用 ZeRo 时的适配原则
- 以接口包装 ZeRo，不要让业务代码直接散落调用 ZeRo internals
- 所有 SHUD 对象由 `harness-*` / `shud-*` 包承载
- ZeRo 只能做底层依赖，不能做科学语义所有者

## 9. 最终原则
> **SHUD-Harness 的系统身份应当由“科研对象 + 治理规则 + operator workflow”定义，而不是由它是不是从 ZeRo fork 出来定义。**
