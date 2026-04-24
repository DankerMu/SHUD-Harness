# 执行、长任务、RunRecord 与恢复

## 1. 执行模式

MVP 支持三类执行：

```text
local_direct：短命令，直接 bash；
local_job：长命令，后台进程 + pid/status file；
docker_job：可选，用于固定环境。
```

Slurm/HPC 只定义接口，不在 MVP 必做。

## 2. RunJob 状态机

```text
created
  → submitted
  → running
  → succeeded | failed | cancelled | timed_out
  → collected
```

## 3. Park / Resume

长任务提交后，Coordinator 应退出：

```text
submit job
  → save RunJob
  → task status = parked_waiting_for_job
  → no more LLM calls
```

用户或 cron 之后执行：

```bash
shud-harness job collect JOB-0007
shud-harness report TASK-0001
```

## 4. 失败恢复机制

必须支持：

```text
- command retry limit；
- job retry limit；
- git worktree rollback；
- generated file cleanup；
- last-good stack restore；
- no-progress detection。
```

## 5. Worker 产生垃圾怎么办

所有 Worker 写入都限制在：

```text
workspaces/TASK-0001/
  worktrees/
  scratch/
  artifacts/
```

清理命令：

```bash
shud-harness task clean TASK-0001 --mode scratch-only
shud-harness task clean TASK-0001 --mode failed-runs
```

patch 只有显式 bundle 才输出：

```bash
shud-harness patch bundle TASK-0001
```

## 6. Coordinator 死循环防护

硬限制（触发后 task.status = blocked）：

```yaml
max_retries_per_command: 2
max_no_progress_steps: 3       # 连续 3 步无进展 → 自动 block
```

软监控（状态栏提醒 PI，不自动中断）：

```yaml
advisory_agent_turns: 12
advisory_tool_calls: 40
advisory_inference_usd: 1.00   # 超出时状态栏标黄
```

Block 后报告包含：已尝试的操作、失败点、建议 PI 下一步。

## 7. 增量运行

不要每次全量重跑。根据变更影响选择 benchmark：

| 变更类型 | 默认运行 |
|---|---|
| docs/report only | no benchmark |
| scripts/parser | parser smoke + tiny read |
| rSHUD reader | old-output fixture + tiny output read |
| SHUD output format | SHUD tiny + rSHUD roundtrip + compatibility |
| numerical core | tiny + fixed regression + PI 选择是否 batch |
| preprocessing | affected basin/event only |

## 8. RunRecord 是复盘核心

每个 RunRecord 必须绑定：

```text
- task_id
- job_id
- stack_id
- data_id
- command
- logs
- metrics
- artifacts
- numerical_health
- resource usage
```

没有 RunRecord 的结果，不进入 report 的“已验证结果”部分。
