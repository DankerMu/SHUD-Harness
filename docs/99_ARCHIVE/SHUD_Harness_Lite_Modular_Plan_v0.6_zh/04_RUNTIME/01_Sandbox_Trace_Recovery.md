# 沙箱、Trace 与恢复

## 1. 沙箱原则

```text
Agent can work, but only in allowed places.
```

允许写入：

```text
workspaces/TASK-*/scratch/
workspaces/TASK-*/artifacts/
workspaces/TASK-*/worktrees/
reports/
```

禁止写入：

```text
data/raw/
benchmarks/baselines/ unless PI approved
main repos outside worktree
canonical memory files without human edit
```

## 2. Bash trace

每次命令记录：

```yaml
command_id: CMD-0001
task_id: TASK-0001
cwd: workspaces/TASK-0001/worktrees/SHUD
command: make -j4
exit_code: 0
started_at: ...
finished_at: ...
stdout_tail: artifacts/CMD-0001.stdout.tail.txt
stderr_tail: artifacts/CMD-0001.stderr.tail.txt
files_changed:
  - path: src/output.c
    diff_summary: added optional event_flux output
risk_flags: []
```

## 3. Diff policy

Agent 只允许通过 worktree 修改代码。

```bash
shud-harness patch diff TASK-0001
shud-harness patch bundle TASK-0001
shud-harness patch revert TASK-0001
```

## 4. 回滚策略

| 场景 | 回滚方式 |
|---|---|
| Worker 改坏代码 | git worktree reset |
| 生成大量临时文件 | task clean |
| job 中断 | mark failed + collect partial logs |
| benchmark 失败 | preserve artifacts + no baseline update |
| Agent 无进展 | block task + report |

## 5. Trace 摘要化

不要把所有日志塞给 LLM。Trace 分三层：

```text
raw logs：存在 artifacts；
tail logs：进入 command trace；
summary：进入 agent context/report。
```

## 6. 最低恢复能力

MVP 必须通过测试：

```text
- kill a running job and collect partial logs；
- rollback a failed patch；
- re-run tiny benchmark from clean worktree；
- resume a parked task after job completion；
- detect no-progress loop and block。
```
