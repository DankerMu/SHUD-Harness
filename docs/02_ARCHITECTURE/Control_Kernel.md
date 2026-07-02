# 极简 Runtime Kernel

## 1. 不再使用长自主循环

v0.5 的 loop 类似：

```text
Observe → Decide → Act → Observe Result → Evaluate → Reflect → Update Memory / Skills → Decide Next
```

v0.6 将其改成 **任务驱动 + 长任务友好** 的 kernel：

```text
Brief
→ Plan
→ Execute | Submit Job
→ Park | Collect
→ Report
→ Ask PI
```

## 2. 为什么这样改

SHUD 科学计算与 coding agent 的时间尺度不同：

```text
coding task: 几分钟到一小时；
SHUD real basin run: 几小时到几天；
batch sensitivity: 多个 jobs；
PI 使用频率: 可能每天 1–2 次。
```

因此 agent 不应在一个长 loop 中等待模型完成。它应提交作业、保存状态、退出，等结果出来再 resume。

## 3. Runtime state machine

TaskCard.status 使用粗粒度状态机（权威定义见 `03_SPEC/Minimal_Schemas.md`）：

```text
created
  → planned
  → running          ← runtime_phase: running_local | submitted_job | collecting
  → parked           ← runtime_phase: waiting_for_job
  → reporting
  → awaiting_pi
  → done | cancelled | blocked
```

`runtime_phase` 是辅助字段，用于前端展示和调试，不是状态机转换条件。
PI 要求修订时，TaskCard 回到 `planned`（不使用 `revised` 状态）。

## 4. 每个状态的职责

### created

TaskCard 已创建，但未生成执行计划。

### planned

Coordinator 生成 plan，并列出：

```text
- 需要哪些 run；
- 是否需要改代码；
- 是否需要敏感性分析；
- 预计 LLM 成本；
- 预计 compute 成本；
- 风险和人工审批点。
```

### running

任务正在执行。通过 `runtime_phase` 区分细节：

- `running_local`：短命令在 sandbox 同步执行
- `submitted_job`：已提交 RunJob，LLM loop 仍活跃
- `collecting`：Job 完成后正在收集日志、指标和 artifacts

### parked

Agent 已暂停，不继续消耗 LLM token。`runtime_phase = waiting_for_job`。

是否 park 按预期等待时长决策（阈值策略见 Park_Resume §1.2）：短等待留在会话内吃热缓存，
长等待 park——park 的经济性来自等待时长超过提示缓存 TTL。

### reporting

生成 Markdown 报告和下一步建议。

### awaiting_pi

等待 PI 决策。

### blocked

硬限制触发（max_retries、no_progress）或 workspace 损坏。需要人工检查。

## 5. Stop conditions

硬编码（不可跳过）：

```text
- max_retry_per_failed_command: 2；
- no_progress_detection: 连续 3 步无进展 → 自动 block（判定语义见 §5.1）；
- max_spawn_depth: 1（结构上仅 coordinator 有 spawn 权限；运行时硬校验兜底，
  防 prompt 越权或实现失误导致委派循环）；
- max_concurrent_subagents: 3（超出排队执行，不并发爆炸）。
```

spawn 上限为运行时校验而非仅靠角色剖面（对标 hermes-agent 吸收）：角色剖面说"不该发生"，
kernel 校验保证"发生了也过不去"。

### 5.1 无进展（no-progress）判定器

“无进展”不是 LLM 的自我感觉，是确定性判定：

**步（step）**：Agent loop 中一次执行了至少一个工具调用的迭代。纯文本迭代不计步。

**进展事件（progress event）**，本步内发生任一即视为有进展：

1. task workspace 内新增或修改了文件（CommandTrace.files_changed 非空）；
2. 领域对象发生状态迁移或新建（TaskCard / RunJob / RunRecord / EvidenceReport / ChangeRequest / MemoryNote）；
3. 提交了新 RunJob 或完成了一次 collect；
4. 出现**新的失败签名**——失败也是进展，前提是它提供了新的诊断信息。

**失败签名（failure signature）**：`sha256(command_digest + exit_code + stderr 错误类别)`。
同一 task 内重复出现相同失败签名的步直接计为无进展步——同一面墙撞第二次不是进展。

**计数规则**：连续无进展步计数器在任一进展事件时清零；达到 3 时 TaskCard → blocked，
生成 partial report 并附最近失败签名列表供人工检查。

**预警档（对标 hermes-agent tool guardrails 吸收）**：计数达到 2 时先向 agent context 注入一条
确定性警告（"连续 2 步无进展；最近失败签名：…；再无进展将 block"），给一次自我纠正机会，
同时发 `agent.no_progress` 事件让前端 StatusBar 计数；达到 3 才 block。警告注入本身不算进展事件。
同理，`max_retry_per_failed_command` 允许的那次重试前，把上次失败签名注入 context——
盲目原样重试撞同一面墙的概率远大于换个姿势。

parked 状态不计步；job 等待时间不参与判定。判定器实现必须是纯函数（输入 CommandTrace + 对象事件流，输出 progress/no-progress），可独立单测。

软监控（状态栏提醒，PI 决定是否中止）：

```text
- advisory_model_calls: 状态栏显示调用次数，超出建议值标黄；
- advisory_usd: 状态栏显示费用，超出建议值标黄；
- wall_time_without_user: 仅记录，不自动中断。
```

## 6. 核心原则

```text
Agent 不需要连续“思考”几小时。
Harness 负责保存状态、等待作业、恢复上下文。
```

这是 SHUD-Harness 与普通 coding agent 最大的差异之一。
