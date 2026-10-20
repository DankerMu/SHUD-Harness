---
status: frozen
---

# Park/Resume 设计

**状态：** P0 设计规范  
**适用范围：** 长时间 SHUD 运行、sensitivity batch、AutoSHUD pipeline、HPC/SLURM job、LLM 会话恢复  
**目标：** 让 Agent 在长任务期间停止消耗推理资源，并在 job 完成后可复盘、可幂等地恢复。

## 1. 为什么需要 Park/Resume

SHUD 运行可能持续数分钟到数小时，sensitivity 和 calibration 可能提交多个 RunJob。让 LLM 会话持续等待会浪费 token，也会增加状态丢失风险。Park/Resume 的目标是把长运行转换为持久化 job：

```text
Plan → Submit RunJob → Park TaskCard → Watch Job → Collect RunRecord → Resume Coordinator → Report
```

## 1.1 Out-of-band notification after Resume/Report

dsh Web 会话只覆盖浏览器打开时的实时体验。Park/Resume 的核心场景是长任务运行期间 PI 可能关闭浏览器，因此 long job 完成后的唤醒必须由落盘的 `job/settled` 记录驱动（ADR-0004 K8），不能只依赖活动连接。

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

Collect 操作包括：

1. 读取 job metadata；
2. 保存 exit code、resource usage、start/end time；
3. 汇总 stdout/stderr；
4. 扫描 SHUD 输出目录；
5. 调用 rSHUD 或解析器生成 metrics；
6. 生成 artifact manifest；
7. 写入 RunRecord；
8. 更新 TaskCard；
9. 记录 `runrecord.created` 事件（session log），由 dsh 作业卡/完成通知呈现。

如果 collect 失败，应写入 `collect_error.yaml`，而不是覆盖 RunJob 状态。

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

## 9. 服务重启恢复

服务启动时应扫描：

```text
workspace/tasks/*/parked_state.yaml
workspace/jobs/*/job.yaml
```

恢复步骤：

1. 读取 parked task；
2. 检查 waiting jobs；
3. 若 job 仍运行，继续 watch；
4. 若 job 已结束但未 collect，进入 collecting；
5. 若 collect 已完成但未 report，恢复 Coordinator 到 reporting；
6. 若状态冲突，标记 blocked 并要求人工检查。

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
- [ ] 作业记录（id / cmd / cwd / pid / started / log 路径）**先落盘**，再返回工具结果让 turn 结束；不得只存在 `jobs-local` 内存 ring。
- [ ] 子进程 detach（独立进程组），`./shud` 不被 dsh 的 SIGTERM 连带杀死（spike 1.3 反例）。
- [ ] 提交后 agent 没有 pending LLM 调用：turn 以工具结果收尾，唤醒只来自 `job/settled` 完成通知。
- [ ] 子代理在 park 前已结束或其结果已持久化（`ctx.subagents`）。

### Collect 阶段
- [ ] 检查 SHUD 退出码（0 成功，10 NaN，12 文件 IO，13 数据输入，19 CVODE，20 一致性检查；见 `../01_CODEBASE/SHUD_IO_Facts.md`）。
- [ ] 二进制输出完整性：文件大小按 header + N×(NumVar+1)×8 字节对齐；部分写入判 failed 而非 succeeded。
- [ ] NaN 扫描（SHUD 不做 NaN 检查）。
- [ ] collect 幂等：同一 job 重复 collect 产生同一 RunRecord；digest 不用内容 hash（日志追加会改变它，`Spec_Gaps_Register.md` GAP-05 / RACE-03）。
- [ ] 失败 job 写最小 RunRecord + FailureRecord，不伪造成功。

### Resume / 唤醒阶段
- [ ] 唤醒 turn 从 `ctx.storage` 读回 RunJob/RunRecord，而不是依赖上一 turn 的内存。
- [ ] 引用的 artifact 仍存在（retention 可能已清理，GAP-10）。

### 并发安全
- [ ] 同时只有一个 SHUD 进程（OpenMP 全局状态不支持多仿真并行）。
- [ ] RunJob 状态转换原子（timeout 与 cancel 竞态，RACE-01）。
- [ ] stale job 检测：running 超时无心跳 → timed_out（GAP-09）。

### 重启恢复（K8 对账）
- [ ] 启动时扫描作业记录：pid 存活 → 重新接管输出；已退出 → 补 `job/settled` 并投递完成通知；SIGTERM 与 SIGKILL 各一条重启用例（Phased_Plan M2 验收门）。
- [ ] 失败时恢复 last-good StackLock。

### SHUD 运行时特有
- [ ] stdout/stderr 落到 `runs/<run_id>/`，便于事后诊断。
- [ ] SUNDIALS 路径（Makefile 硬编码 `$(HOME)/sundials`）与 OpenMP 线程数可配置，不在工具里再硬编码。
