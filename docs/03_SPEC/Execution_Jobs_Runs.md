# 执行、长任务、RunRecord 与恢复

## 1. 执行模式

MVP 支持三类执行（字段定义以 `03_SPEC/Minimal_Schemas.md` 为准）：

```text
local_direct — 短命令，同步 bash 执行
local_job    — 长命令，后台进程 + pid/status file + Park/Resume
docker_job   — 可选，固定环境容器执行
```

Slurm/HPC 仅定义接口，不在 MVP 实现。

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

没有 RunRecord 的结果，不进入 report 的”已验证结果”部分。

## 9. Sandbox 执行器

Sandbox Executor 是所有命令执行的统一入口，覆盖 `sandbox.exec`、`shud.build`、`shud.run`、`rshud.*`、`autoshud.*` 工具。
目标是将通用 bash 执行器改造成可审计、可限制、可 streaming 的科研运行执行器。

### 9.1 执行请求 Schema

每次执行必须绑定 TaskCard、workspace 和 agent：

```yaml
sandbox_exec_request:
  task_id: TASK-001
  workspace_id: WS-001
  cwd: workspace/repos/SHUD
  command:
    - make
    - shud
  env:
    OMP_NUM_THREADS: “1”
  timeout_seconds: 600
  stream: true
  capture_output: true
  risk_level: low | medium | high
```

### 9.2 路径策略

允许路径：

```text
workspace/repos/*
workspace/runs/*
workspace/artifacts/*
workspace/tasks/*
workspace/tmp/*
```

默认禁止：

```text
~/.ssh
system root paths
raw data overwrite paths
outside workspace writes
.git directory destructive operations
```

如需读取 raw data，应通过 registered DataProvenance path，以只读方式挂载或引用。

### 9.3 命令风险分类（四级）

| 风险 | 示例 | 策略 |
|---|---|---|
| low | `ls`, `cat`, `make`, `Rscript read_output.R` | 可执行，记录日志 |
| medium | `cp`, `rsync`, `git diff`, `patch --dry-run` | 需要 workspace 内路径检查 |
| high | `rm -rf`, `git reset --hard`, 覆盖 baseline | 需要 PI gate 或拒绝 |
| forbidden | 删除 raw data、写系统路径、泄露 secrets | 拒绝 |

### 9.4 Streaming 策略

执行器将日志分片推送至 WebSocket：

```text
tool.started
tool.stdout / tool.stderr ...
tool.completed 或 tool.failed
```

每个分片同时 append 到本地文件：

```text
workspace/artifacts/toolcalls/<toolcall_id>.stdout
workspace/artifacts/toolcalls/<toolcall_id>.stderr
```

### 9.5 资源限制

MVP 至少支持：

- timeout（超时后进程和子进程被终止）；
- 最大 stdout/stderr 内存窗口；
- 最大日志文件大小提醒；
- 并发命令数量限制；
- 可选 CPU/thread env 设置（如 `OMP_NUM_THREADS`）。

Docker 模式可进一步支持 memory/cpu 限制（对应第 1 节 `docker_job`）。

### 9.6 命令审计记录

每次命令执行生成 `toolcall.json`：

```yaml
toolcall:
  id: TOOLCALL-001
  command: “make shud”
  command_digest: sha256:...
  cwd: workspace/repos/SHUD
  env_redacted:
    OMP_NUM_THREADS: “1”
  started_at: ...
  completed_at: ...
  exit_code: 0
  stdout_ref: artifacts/toolcalls/TOOLCALL-001.stdout
  stderr_ref: artifacts/toolcalls/TOOLCALL-001.stderr
```

env 中的 secrets 必须 redacted，不得明文写入审计记录。

### 9.7 SHUD 工具封装关系

不建议让 Coordinator 直接运行复杂命令字符串。应提供高层工具封装：

```text
shud.build(project, options)
shud.run(project, run_dir, options)
rshud.read_output(run_dir, variables)
autoshud.run_step(step, config)
```

高层工具内部调用 Sandbox Executor，并输出结构化结果。
这些高层工具与第 1 节执行模式对应：`shud.build` 通常走 `local_direct`，`shud.run` 走 `local_job` + Park/Resume。

## 10. 长任务自动转换

### 10.1 转换规则

短命令直接在 LLM loop 内同步执行；超过阈值的命令必须自动转为 RunJob，触发 Park/Resume 流程（见第 3 节）：

```text
sandbox.exec(short) → 直接运行（local_direct）
shud.run(long)      → RunJob + Park/Resume（local_job）
```

### 10.2 阈值配置

```yaml
short_task_timeout_seconds: 120    # 超过 120s 预期时长的命令 → RunJob
long_task_requires_runjob: true    # 长任务强制走 RunJob，不可绕过
```

已知长任务（如 `shud.run`）应在工具定义中标记为 `always_runjob: true`，无需等待 timeout 触发。

### 10.3 验收标准

- [ ] workspace 外写入被拒绝
- [ ] stdout/stderr 实时显示并完整落盘
- [ ] timeout 后进程和子进程被终止
- [ ] high/forbidden 命令需要 PI gate 或被拒绝
- [ ] toolcall artifact 包含 command_digest 和 redacted env
- [ ] SHUD 长运行转 RunJob 而不是阻塞 LLM loop
