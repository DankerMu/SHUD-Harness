# Sandbox Executor 实现补充

**状态：** P1 设计补充  
**适用范围：** `sandbox.exec`、`shud.build`、`shud.run`、`rshud.*`、`autoshud.*` 工具  
**目标：** 将通用 bash 执行器改造成可审计、可限制、可 streaming 的科研运行执行器。

## 1. 基本要求

Sandbox Executor 必须满足：

- 命令绑定 TaskCard、workspace、agent；
- cwd 限定在 workspace policy 允许范围；
- stdout/stderr 实时 streaming，同时完整落盘；
- 记录 command、env、exit code、start/end time、resource usage；
- 支持 timeout 和取消；
- 长任务转 RunJob，不在 LLM loop 内等待；
- 高风险文件操作拦截。

## 2. 执行请求

```yaml
sandbox_exec_request:
  task_id: TASK-001
  workspace_id: WS-001
  cwd: workspace/repos/SHUD
  command:
    - make
    - shud
  env:
    OMP_NUM_THREADS: "1"
  timeout_seconds: 600
  stream: true
  capture_output: true
  risk_level: low | medium | high
```

## 3. 路径策略

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

## 4. 命令风险分类

| 风险 | 示例 | 策略 |
|---|---|---|
| low | `ls`, `cat`, `make`, `Rscript read_output.R` | 可执行，记录日志 |
| medium | `cp`, `rsync`, `git diff`, `patch --dry-run` | 需要 workspace 内路径检查 |
| high | `rm -rf`, `git reset --hard`, 覆盖 baseline | 需要 PI gate 或拒绝 |
| forbidden | 删除 raw data、写系统路径、泄露 secrets | 拒绝 |

## 5. Streaming

执行器将日志分片推送：

```text
tool.started
tool.stdout/tool.stderr ...
tool.completed 或 tool.failed
```

每个分片同时 append 到：

```text
workspace/artifacts/toolcalls/<toolcall_id>.stdout
workspace/artifacts/toolcalls/<toolcall_id>.stderr
```

## 6. 资源限制

MVP 至少支持：

- timeout；
- 最大 stdout/stderr 内存窗口；
- 最大日志文件大小提醒；
- 并发命令数量限制；
- 可选 CPU/thread env 设置。

Docker 模式可进一步支持 memory/cpu 限制。

## 7. 长任务转换

如果命令预期超过短任务阈值，应生成 RunJob：

```text
sandbox.exec(short) → 直接运行
shud.run(long)      → RunJob + Park/Resume
```

阈值建议：

```yaml
short_task_timeout_seconds: 120
long_task_requires_runjob: true
```

## 8. 命令审计

每次命令生成 `toolcall.json`：

```yaml
toolcall:
  id: TOOLCALL-001
  command: "make shud"
  command_digest: sha256:...
  cwd: workspace/repos/SHUD
  env_redacted:
    OMP_NUM_THREADS: "1"
  started_at: ...
  completed_at: ...
  exit_code: 0
  stdout_ref: artifacts/toolcalls/TOOLCALL-001.stdout
  stderr_ref: artifacts/toolcalls/TOOLCALL-001.stderr
```

env 中的 secrets 必须 redacted。

## 9. 与 SHUD 工具封装关系

不建议让 Coordinator 直接运行复杂命令字符串。应提供高层工具：

```text
shud.build(project, options)
shud.run(project, run_dir, options)
rshud.read_output(run_dir, variables)
autoshud.run_step(step, config)
```

高层工具内部调用 Sandbox Executor，并输出结构化结果。

## 10. 验收标准

- [ ] workspace 外写入被拒绝。
- [ ] stdout/stderr 实时显示并完整落盘。
- [ ] timeout 后进程和子进程被终止。
- [ ] high risk 命令需要 gate 或被拒绝。
- [ ] toolcall artifact 包含 command_digest 和 redacted env。
- [ ] SHUD 长运行转 RunJob 而不是阻塞 LLM loop。
