---
status: frozen
---

# Park/Resume 设计

**状态：** P0 设计规范  
**适用范围：** 长时间 SHUD 运行、sensitivity batch、AutoSHUD pipeline、HPC/SLURM job、LLM 会话恢复  
**目标：** 让 Agent 在长任务期间停止消耗推理资源，并在 job 完成后可复盘、可幂等地恢复。

M2 运行主链以 [m2-run-chain design D2/D6/D7/D11/D12](../../openspec/changes/m2-run-chain/design.md) 为准，本文 §5、§9 与附录 A 是对应落地契约；TaskCard park/resume、批次聚合、邮件、metrics/report 以及 Docker/HPC 内容为后续里程碑规划，不是 M2 已实现能力。

## 1. 为什么需要 Park/Resume

SHUD 运行可能持续数分钟到数小时，sensitivity 和 calibration 可能提交多个 RunJob。让 LLM 会话持续等待会浪费 token，也会增加状态丢失风险。Park/Resume 的目标是把长运行转换为持久化 job：

```text
Plan → Submit RunJob → Park TaskCard → Watch Job → Collect RunRecord → Resume Coordinator → Report
```

## 1.1 Out-of-band notification after Resume/Report

dsh Web 会话只覆盖浏览器打开时的实时体验。M2 shud 作业的唤醒由工作区运行目录中持久化的 RunJob/RunRecord（或 collect 失败记录）与 `stateDir` 索引驱动，不依赖活动连接；无 owner 作业没有 `job/settled`，由注册表投递 `source.kind: shud-jobs` 消息。下列批次与邮件通知仍属后续规划。

通知触发点应在结果可读之后，而不是进程刚退出时：

```text
Single RunJob task:
  Watch Job → Collect RunRecord → Generate report draft → Notify once

Batch AnalysisPlan:
  all jobs terminal or stop condition reached
  → Generate AnalysisPlan summary / report draft
  → Notify once

Critical failure:
  first critical failure may notify immediately
```

MVP 使用 email notification。收件人解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

通知必须生成 `NotificationRecord`，使用 deterministic `dedupe_key` 避免 watcher retry 或服务重启后重复发送。

Batch 模式不得对每个 RunJob completion 发送邮件；默认只在 analysis summary 或 report draft 可审阅时发送一封。

## 1.2 Park 阈值决策：何时 park、何时留在会话内等

park 不是零成本：resume 是一次冷读重建（provider 提示缓存 TTL ~5min，几小时后必然全冷）。
判据是**预期等待时长与缓存 TTL 的关系**：

| 预期等待 | 决策 | 经济账 |
|---|---|---|
| 短（tiny run、编译；< 阈值，默认 180s） | 留在会话内同步等待（running_local / submitted_job 轮询） | cache 尚热，续跑按缓存价（~1/10）；park+重建反而贵 |
| 灰区（~TTL 边界） | 会话内短等，超时自动升级为 park | 超时兜底，不悬挂 |
| 长（真实流域 run、batch、HPC 排队） | park | cache 必然冷：保留会话 = resume 冷读全量历史（随 park 轮次复利增长）；重建投影 ≤16KB，恒定且便宜 10-30× |

阈值进配置，按 provider cache TTL 校准（另见 [Cost_Inference_Budget §4.1](Cost_Inference_Budget.md) 前缀缓存快照）。
误判偏向 park：错 park 只多付一次 ≤16KB 重建；错不 park，冷读成本随历史长度增长无上界。

## 2. 状态定义

TaskCard.status 使用粗粒度状态机（权威定义见 `03_SPEC/Minimal_Schemas.md`）。
Park/Resume 涉及的阶段映射如下：

| TaskCard.status | runtime_phase | 语义 |
|---|---|---|
| planned | — | 已形成可执行计划 |
| running | `submitted_job` | 已提交一个或多个 RunJob |
| parked | `waiting_for_job` | Agent 已暂停，等待外部 job 完成 |
| running | `collecting` | 正在收集日志、输出、指标和 artifact |
| reporting | — | 正在生成 EvidenceReport |
| awaiting_pi | — | 等待 PI 审阅、批准或补充判断 |
| done / blocked / cancelled | — | 已结束或被阻塞/取消 |

RunJob 状态应与 TaskCard 区分。TaskCard 代表任务生命周期；RunJob 代表一次执行请求。

## 2.1 plan.md 结构契约与修订规则

对抗审查 A02-1/A02-2/A04-5：plan_cursor、幂等 key（[Idempotency §4](Idempotency_Concurrency_Locking_Spec.md) 的 plan_step_id）与
"plan 以磁盘为准"都引用 plan 步骤，但步骤结构、修订权与重算算法此前无任何定义。契约：

**步骤 ID**：plan.md 的可执行步骤必须带稳定 ID（`step-NNN`，创建时由 harness 按序分配）；
修订可增删步骤，但**不得重编号、不得复用已分配 ID**。plan_cursor.completed_steps 与幂等 key 的
plan_step_id 一律引用该 ID。

**修订权与信任级**：plan.md 仅 Coordinator 可写，且仅在 Plan / Resume 阶段（Execute 期间要改
计划须先让 TaskCard 回 planned，走 Control_Kernel 状态机）；每次修订产生 `plan.revised` 事件，
记录 actor、revision 号与依据 refs——refs 不得为空且不得全为 T4（[Context_Trust §4](Context_Trust_And_Injection_Spec.md) 高影响动作中
机器可查的部分）。PI 要求修订走 TaskCard 回 planned 的既有路径。

**cursor 重算（确定性集合运算，无 LLM 参与）**：resume 发现磁盘 revision > parked revision 时：
`completed' = completed ∩ 新 plan 步骤 ID 集`；被删除的已完成步骤记入 resume warning
（不重跑、不静默消失）；`next_step = 新 plan 中第一个 ∉ completed' 的步骤`。

## 3. parked_state 文件

每次 park 必须落盘：

```yaml
parked_state:
  task_id: TASK-20260424-001
  session_id: SESSION-...
  workspace_id: WS-...
  coordinator_agent_id: agent_...
  reason: waiting_for_job
  parked_at: 2026-04-24T10:15:00-04:00
  resume_policy:
    trigger: all_jobs_completed | any_job_failed | manual
    auto_collect: true
    auto_report: false
  waiting_on:
    run_jobs:
      - RUNJOB-001
      - RUNJOB-002
  context_refs:
    task_card: tasks/TASK-.../task.yaml
    plan: tasks/TASK-.../plan.md
    stack_lock: stacks/STACK-.../stacklock.yaml
    data_provenance: provenance/DATA-<uuid>.json
  plan_cursor:
    completed_steps: [step-1, step-2]
    next_step: step-3
    plan_revision: 2          # plan.md 修订号；恢复时若磁盘上的 plan revision 更新，以磁盘为准并重算 cursor
  last_user_visible_summary: "已提交 ccw tiny run，等待 SHUD 运行完成。"
```

建议路径：

```text
workspace/tasks/<task_id>/parked_state.yaml
```

## 4. Job watcher

Job watcher 是非 LLM 后台进程，负责轮询或订阅 job 状态。它不做科学解释，只做状态转换和事件推送。

实现缝 = dsh `ctx.jobs`（JobRegistry 契约），由本项目自写的 durable backend 承载（[ADR-0004 K8](../adr/implemented/0004-dsh-kernel.md)）。

### 4.1 本地 job

本地 job watcher 监控：

- process pid 是否存在；
- exit code；
- stdout/stderr 文件大小；
- heartbeat 文件；
- timeout；
- output directory 是否出现 expected outputs。

### 4.2 Docker job

Docker job watcher 监控：

- container status；
- exit code；
- mounted workspace；
- resource stats；
- logs。

### 4.3 SLURM/HPC job

SLURM watcher 监控：

- scheduler job id；
- `squeue`/`sacct` 状态；
- stdout/stderr 路径；
- walltime；
- node failure；
- array job 子任务状态。

## 5. Collect 阶段

Collect 必须是幂等的。重复调用 `collect` 不应破坏已完成结果。

M2 collect 从 `<session cwd>/runs/<run_id>/` 读取作业与退出信息：按退出码映射 `exit_class`，扫描 `output/<project>.out/` 得到相对路径/字节数清单，计算 `wall_seconds`，复制模型 id 与来源，经 core schema 校验后写 `run-record.json`，再将 RunJob 置为 `collected`，最后进入唤醒步骤。已有 `run-record.json` 原样返回，内容和修改时间不变；`shud_collect` 复用同一逻辑。

失败写同目录 `collect-error.json`（`attempts`、`last_error`、`at`），作业保持或置为终态；退出码不可读/非整数时为 `failed`，不写占位 RunRecord、不置 `collected`。唯一轮询循环在距上次尝试至少 10 秒后重试，上限 3 次；达到上限以失败原因唤醒，不再自动 collect，手工 `shud_collect` 仍可重试。重启由 R9/R10 接续。

metrics、数值健康计算、ArtifactManifest、TaskCard 更新与报告生成不属于 M2 collect；它们在后续里程碑按相应对象契约接入。

## 6. Resume context

Resume 时不应依赖 LLM 原始上下文窗口。必须从磁盘重建：

```yaml
resume_context:
  task_card: ...
  original_brief: ...
  plan_summary: ...
  plan_cursor:
    completed_steps: [step-1, step-2]
    next_step: step-3
    plan_revision: 2
  stack_lock_summary: ...
  data_provenance_summary: ...
  run_records:
    - run_id: RUN-001
      status: succeeded
      metrics_ref: artifacts/metrics/RUN-001.yaml
  job_failures: []
  pending_pi_gates: []
```

Coordinator resume prompt 应明确：

- 这是恢复任务，不是新任务；
- 按 `plan_cursor` 从 `next_step` 接续，不重做 `completed_steps`；
- 不要重新提交已完成 job；
- 先检查 RunRecord 和 metrics；
- 只在证据不足时建议下一步。

多个 job 乱序完成时，resume 不逐 job 触发：按 `resume_policy.trigger` 聚合（如 `all_jobs_completed`），
resume_context.run_records 一次性给出全部终态 job 的 RunRecord。

**resume_context 组装规则（AGA-P1-4）**：resume_context 不是自由拼接——允许进入的内容清单与预算上限
（Resume 阶段 ≤ 16KB）由 [Context_Trust_And_Injection_Spec](Context_Trust_And_Injection_Spec.md) §5 统一定义。
其中 `plan_summary` / `stack_lock_summary` / `data_provenance_summary` 由确定性模板生成（字段抽取，非 LLM 压缩）；
run_records 只带 status 与 metrics_ref，不内联日志或输出数据；job stdout/stderr 若需引用，
按同规范 §5 的 tail 截断规则并以 T4 包裹注入。

resume 时 system prompt 复用 session 首轮存盘的字节级快照（见 [Cost_Inference_Budget §4.1](Cost_Inference_Budget.md)），
不重新渲染——重建的是对话上下文，不是前缀。

## 7. 触发策略

| 触发方式 | 使用场景 |
|---|---|
| `all_jobs_completed` | sensitivity batch、benchmark pair、calibration batch |
| `any_job_failed` | debugging、smoke test、CI-like run |
| `manual` | 需要 PI 决定是否继续的长实验 |
| `time_window` | 定期检查远程 HPC job |

MVP 推荐默认：单 job 使用 `any_job_failed_or_completed`；batch 使用 `all_jobs_completed`。

## 8. 幂等与锁

为了避免重复 collect 或重复 report，应使用 lock 文件：

```text
workspace/jobs/<job_id>/locks/collect.lock    # job 级——batch 多 job 并发 collect 互不阻塞（对抗审查 A02-4，与 Idempotency §5 一致）
workspace/tasks/<task_id>/locks/resume.lock   # resume 是 task 级动作，保持 task 级
```

锁内容记录持有者、开始时间、过期时间。服务重启时，如果锁已过期，可以进入 recovery 流程。

M2 不使用上面的后续 TaskCard/job 级锁布局：注册表在配置的 `stateDir` 持有 `lock`（pid + 进程启动时间）；同实例索引修改串行化，同条目同时至多一个轮询步骤在途，已有 RunRecord 不重写。存活持有者使第二实例激活失败，陈旧锁才可接管；详见 design D2/D7。

## 9. 服务重启恢复

M2 注册表 apply 时先取得 `stateDir/lock`，读取 `active.json`，按索引中的绝对运行目录读取 `run-job.json`、`wrapper.pid`、`exit_code` 与结果文件。运行记录不从 `ctx.storage` 读取，也不扫描后续 TaskCard 工作区布局。

按 [design D11 的 R1–R12](../../openspec/changes/m2-run-chain/design.md) 对账：从未启动或进程丢失者结算，仍存活者接管；存活判定同时比对 pid 和进程启动时间，判定不存活后再读一次 `exit_code`。任何一行都不重新 spawn、不重新入队；R9 返回已有 RunRecord 时不改写文件，R10 不把 collect 耗尽者置为 `collected`。

R3/R5 通过瞬时全局控制器无 owner 重新登记并更新 `dsh_job_id`/`dsh_job_ids`，登记失败也不阻止轮询、collect 或唤醒。shud 发起会话 id 仅用于唤醒；owner Agent 释放不取消作业。

所有在线结算、对账补结算与接管结束共用唯一轮询路径：collect 成功或失败达上限 → 服务就绪后 `resolveAgent` → `createUserMessage`（`source.kind: shud-jobs`，含 `run_id`）→ `followup` → `sessions.flush` 成功 → `delivered` → 先写完成索引再移出活动索引。服务未就绪保持 `pending`；会话不存在或暂时失败重试耗尽时为带原因的 `unreachable`。崩溃可能导致重投，语义是至少一次，不宣称 exactly-once。

## 10. 用户体验

前端应清楚显示 task 已 parked，而不是让用户以为 Agent 卡住：

```text
任务已暂停等待运行完成。
当前等待：RUNJOB-001（SHUD ccw tiny 30 days）
最近日志：...
可执行操作：查看日志、取消 job、手动 collect、恢复报告
```

## 11. 验收标准

- [ ] 长任务提交后 LLM loop 停止，TaskCard 进入 parked 状态。
- [ ] 服务重启后可恢复 watcher。
- [ ] collect 可重复执行且不破坏结果。
- [ ] RunRecord 生成后 Coordinator 可从磁盘恢复上下文。
- [ ] 前端能展示 parked 状态、job 状态和可执行操作。
- [ ] 失败 job 不会生成伪成功 EvidenceReport。
- [ ] 浏览器关闭后，RunRecord/report/analysis summary 完成仍能触发 notification。
- [ ] Batch analysis 默认只发送一次 summary notification，不逐 job 打扰 PI。
- [ ] NotificationRecord 有 dedupe_key，服务重启或 retry 不重复发送。
- [ ] notification 失败不回滚 RunRecord 或 EvidenceReport。

## 附录 A. 审查清单（durable JobRegistry / `ctx.jobs` 版）

供 M2 实现与 review 使用；原载 `.agents/skills/shud-gov/reviews/park-resume-audit.md`（Zero SessionDB/AgentLoop 版，2026-10-20 按 ADR-0004 K8 重写）。任何可能导致状态丢失的问题标 critical。

### Job 提交阶段
- [ ] `run-job.json` 与活动索引先落盘，再返回含持久 id 和当前 `dsh_job_id` 的工具结果；`created`/`submitted` 是启动状态，不是排队。
- [ ] 运行目录以 lstat 复核，完整复制输入，只改副本 `END`；失败回滚目录和索引，原输入不变。
- [ ] 无 owner 登记经注册表自身无作用域上下文的瞬时全局控制器完成，`finally` 释放；不改变非 shud owner/作用域准入。
- [ ] `/bin/sh` 包装进程 detached、stdio 落文件；先原子写 `wrapper.pid`，自然退出再原子写 `exit_code`；不经宿主 subprocess 服务。
- [ ] 提交在途集合覆盖 `created` 到 `running` 写出的窗口，轮询不误判 `lost`。

### Collect 阶段
- [ ] 退出码 0/10/12/13/19/20/其它及 `cancelled`/`lost` 映射正确，只有 `ok` 对应成功。
- [ ] 同一 RunRecord 重复 collect 原样返回、mtime 不变；schema 校验前不发布结果。
- [ ] 失败写 `collect-error.json`，不伪造 RunRecord；自动重试间隔 10 秒、上限 3 次，耗尽后带失败原因唤醒。
- [ ] 仅记录本次可证的产物与模型 id/来源；数值健康计算与 metrics 留后续里程碑，不伪造结果。

### Resume / 唤醒阶段
- [ ] 从运行目录读取 RunJob/RunRecord 或 collect 失败记录，而非 `ctx.storage` 或上一 turn 的内存。
- [ ] 所有结算共用 `shud-jobs` 消息路径，`followup` 和 flush 成功后才标记 `delivered`；无 owner 作业不依赖 `job/settled`/tool-jobs 通知。
- [ ] 服务就绪由 inject 回调控制，不依赖插件行序；服务缺失保持 `pending`，会话消失或重试耗尽为带原因的 `unreachable`。
- [ ] 至少一次投递允许崩溃窗口重投，消息含 `run_id`；写完成索引先于移出活动索引。

### 并发与取消
- [ ] 不同运行目录允许并行；同一运行目录至多一个 SHUD 进程。只受父类无 owner 桶上限约束，不设 shud 队列。
- [ ] 唯一轮询循环作为注册表 effect 释放；同条目同一时刻至多一个步骤在途；索引修改串行且原子写。
- [ ] kill 先记 `cancel_requested_at` 再 SIGTERM/宽限后 SIGKILL；`exit_code` 已存在时自然退出获胜。
- [ ] teardown 不取消正常后台 SHUD，同步结束本次 dsh 登记但不 collect/唤醒；kill 宽限期 teardown 保留取消意图，交重启对账接续。

### 重启恢复（K8 对账）
- [ ] R1–R12 每行有可判定输入与证据；pid 复用、退出码在探测期间出现、记录已写但状态未置位均有覆盖；不重新 spawn。
- [ ] R3/R5 接管登记立即可用，不等待 tool-jobs；新旧 `dsh_job_id` 可追溯。
- [ ] SIGTERM/SIGKILL 各一用例，断言 CONTEXT.md 的五条可恢复性不变量，不以模型文本或 `job/settled` 代替。

### SHUD 运行时特有
- [ ] stdout/stderr 落到 `runs/<run_id>/`；输入在 scratch workspace 内复制，submodule 不变。
- [ ] `shudBin` 为显式必填绝对可执行路径，不硬编码机器路径；密钥不进记录或日志。
