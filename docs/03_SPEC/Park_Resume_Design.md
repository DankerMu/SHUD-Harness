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

WebSocket 只覆盖浏览器打开时的实时体验。Park/Resume 的核心场景是长任务运行期间 PI 可能关闭浏览器，因此 long job 完成后的通知不能完全依赖 WebSocket。

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
    data_provenance: data/DATA-.../provenance.yaml
  last_user_visible_summary: "已提交 ccw tiny run，等待 SHUD 运行完成。"
```

建议路径：

```text
workspace/tasks/<task_id>/parked_state.yaml
```

## 4. Job watcher

Job watcher 是非 LLM 后台进程，负责轮询或订阅 job 状态。它不做科学解释，只做状态转换和事件推送。

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
9. 发送 `runrecord.created` WebSocket 事件。

如果 collect 失败，应写入 `collect_error.yaml`，而不是覆盖 RunJob 状态。

## 6. Resume context

Resume 时不应依赖 LLM 原始上下文窗口。必须从磁盘重建：

```yaml
resume_context:
  task_card: ...
  original_brief: ...
  plan_summary: ...
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
- 不要重新提交已完成 job；
- 先检查 RunRecord 和 metrics；
- 只在证据不足时建议下一步。

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
workspace/tasks/<task_id>/locks/collect.lock
workspace/tasks/<task_id>/locks/resume.lock
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
