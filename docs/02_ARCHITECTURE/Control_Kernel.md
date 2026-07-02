---
status: frozen
canonical_for: [no-progress-detector]
---

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

是否 park 按预期等待时长决策（阈值策略见 [Park_Resume §1.2](../03_SPEC/Park_Resume_Design.md)）：短等待留在会话内吃热缓存，
长等待 park——park 的经济性来自等待时长超过提示缓存 TTL。

### reporting

生成 Markdown 报告和下一步建议。

### awaiting_pi

等待 PI 决策。

### blocked

硬限制触发（max_retries、no_progress）或 workspace 损坏。需要人工检查。

## 5. Stop conditions 与策略门校验约定

硬编码（不可跳过）：

```text
- max_retry_per_failed_command: 2；
- no_progress_detection: 连续 3 步无进展 → 自动 block（判定语义见 §5.1）；
- max_spawn_depth: 1（结构上仅 coordinator 有 spawn 权限；运行时硬校验兜底，
  防 prompt 越权或实现失误导致委派循环）；
- max_concurrent_subagents: 3（超出排队执行，不并发爆炸）；
- spawn_profile_subset: spawn 传入的 allowed_tools 必须 ⊆ 该角色 canonical 剖面
  （Roles_and_Boundaries §0）；超集即拒绝 spawn。数量限制防爆炸，本项防越权——
  "剖面只能减不能加"由此获得执行点（对抗审查 A03-4）。
```

spawn 上限为运行时校验而非仅靠角色剖面（对标 hermes-agent 吸收）：角色剖面说"不该发生"，
kernel 校验保证"发生了也过不去"。

**校验注入点（对抗审查 A02-6）**：spawn/wait 是工具调用，上述硬校验全部实现在
`ZeroHarnessAdapter.beforeToolCall`（Zero_Reuse_Matrix 的 adapter 接口）——spawn 工具执行前对
depth / 并发数 / allowed_tools 剖面求值，拒绝即返回工具错误，不改 Zero 内核。
"[E] 直接复用"指复用 spawn 机制本身，不指复用其无校验的默认通路。
落地事实（zero@13e25c1）：loop 级 `onToolCallStart` 仅观测、不可否决——该接口在**工具注册层**
以横切包装实现（`ToolBase.beforeExecute` throw 即阻断），见 [Zero_Reuse_Matrix §8](Zero_Reuse_Matrix.md) 与 ADR-0001。

**拒绝载荷约定（harness 评审 G2，2026-07-02）**：策略门与硬校验拒绝时返回的工具错误
必须携带 `ErrorRecord.remediation` 结构（`next_action` + `hint` + `ref`，权威源
[Support_Schema_Contracts §3](../03_SPEC/Support_Schema_Contracts.md)）——拒绝而不导航
制造重试风暴或静默绕行；新颖失败预算（§5.1）是止损底线，不是引导手段。示例：spawn 剖面
超集被拒 → `next_action=adjust_scope, hint="移除 allowed_tools 中超出 worker 剖面的 X/Y", ref=Roles_and_Boundaries §0`。

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

**新颖失败预算（对抗审查 A02-5）**：第 4 类事件单独设限——连续仅靠"新失败签名"维持进展的步数 ≤ 3。
超出后新失败签名不再计为进展事件（签名含 command_digest，换个命令就能刷出新签名；
无限换姿势撞墙 ≠ 接近目标），此时只有 1–3 类事件能清零计数器；窗口在任一 1–3 类进展事件出现时重置。

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

### 5.2 护栏分类与换代减重（harness 评审 G5）

护栏按存在理由分两类，实现时每条硬护栏标注 `guard_class`：

- **authority（权威护栏）**：存在理由是"决策权属于 PI"，与模型能力无关，**永不随模型升级退役**——
  PI gate、科学变更分级、语言护栏（calibration≠validation）、raw data 保护、spawn 剖面超集拒绝。
- **capability（能力护栏）**：存在理由是"当前模型在此不可靠"，是对模型缺陷的工程补偿——
  no-progress 阈值（3 步）、新颖失败预算（≤3）、park 阈值、决策卡密度、重试上限。

减重规则：`StackLock.llm` 升级且行为 eval 全量达标后，触发一次**减重审查**
（流程挂在 [Agent_Behavior_Eval_Spec §4](../04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md)）：
capability 类逐项评估"新模型是否已不需要"，产出一页 memo 供 PI 决定放宽/退役；authority 类不参与。
护栏只增不减是另一种熵——最好的 harness 是刚好够用的那个，每个 guard 都在补偿一个模型缺陷，缺陷消失 guard 就该退场。

### 5.3 工具面治理约定（harness 评审 G6）

工具是给模型看的产品界面；注册进角色剖面的工具面遵守：

- **数量预算**：单角色可见工具 ≤ 20（Zero 原生 + 领域工具合计）；超出先合并/裁剪再注册——
  工具过多时模型在相似工具间误选的概率显著上升；
- **单一职责 + 强 schema**：拒绝瑞士军刀工具；参数 Zod 校验，校验失败按 §5 拒绝载荷约定
  回吐给模型自修，不静默吞掉；
- **描述规范**：每个工具描述写清"何时该用 / 何时不该用 / 成功与失败分别长什么样"；
- **领域动作优先走 Domain CLI**（[Domain_CLI_Spec](../03_SPEC/Domain_CLI_Spec.md) 已是模范面：
  6 命令、YAML 契约、exit code 语义），不为每个动作造新工具。

落点：工具注册层（与策略门同一横切点）；M1（[Phased_Plan](../04_IMPLEMENTATION/Phased_Plan.md) 工具注册层落地）实现时以注册期 lint 强制数量预算与描述完整性。

## 6. 核心原则

```text
Agent 不需要连续“思考”几小时。
Harness 负责保存状态、等待作业、恢复上下文。
```

这是 SHUD-Harness 与普通 coding agent 最大的差异之一。
