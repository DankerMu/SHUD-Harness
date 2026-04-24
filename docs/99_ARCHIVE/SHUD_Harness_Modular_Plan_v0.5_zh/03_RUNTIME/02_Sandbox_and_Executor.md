# R-02 Bash Sandbox 与 Executor 体系

## 模块状态标签
- **独立实现**：必须支持
- **ZeRo 参考实现**：强参考（bash）+ 弱参考（scheduler）
- **[R] 已实现可复用**：BashTool 基础输入/timeout/fuse list，wait agent
- **[M] 需修改后复用**：bash 环境、trace、权限治理、workspace 组织
- **[N] 必须新增**：JobSpec、Executor backend、job events、Wait/Monitor/Resume

## 1. 为什么 bash-first 仍然成立
SHUD / rSHUD / AutoSHUD 的真实执行空间仍然是：
- C/C++ build
- R scripts
- Python utilities
- shell pipelines
- file-based artifacts

因此第一动作空间仍然应是 **bash-first**，而不是堆很多 typed tools。

## 2. 为什么仅靠 bash 已经不够
一旦引入：
- batch benchmark
- 多 basin / 多 event
- 长时间 calibration
- remote / container backend

就必须把“执行”从单次 shell 提升为**JobSpec + Executor**。

## 3. Sandbox 必须提供的能力
- episode-scoped workspace
- repo worktree
- raw data read-only
- processed data controlled mounts
- scratch writable
- resource limit
- command timeout
- destructive command blocklist
- stdout/stderr capture
- file diff capture
- artifact auto-registration

## 4. Episode 工作目录
```text
episodes/EP-2026-00042/
  context/
  worktrees/
    SHUD/
    rSHUD/
    AutoSHUD/
  scratch/
  scaffolds/
  runs/
  artifacts/
  traces/
    bash_commands.jsonl
    job_events.jsonl
    observations.jsonl
    file_diffs.jsonl
  reports/
```

## 5. BashCommandTrace
```yaml
command_id: CMD-2026-00221
episode_id: EP-2026-00042
command: Rscript scripts/check_roundtrip.R
cwd: episodes/EP-2026-00042/worktrees/rSHUD
timeout_seconds: 120
exit_code: 0
stdout_path: artifacts/CMD-2026-00221.stdout.txt
stderr_path: artifacts/CMD-2026-00221.stderr.txt
created_files: []
modified_files: []
summary: rSHUD roundtrip check passed
```

## 6. JobSpec
JobSpec 用于承载：
- backend
- command / entrypoint
- resources
- retry policy
- expected artifacts
- collection policy

推荐 backend：
- local（V1 必做）
- docker（V1.5 可做）
- slurm（V2）
- k8s（V2）

## 7. Executor 最小接口
```ts
interface Executor {
  submit(job: JobSpec): Promise<JobHandle>;
  watch(handle: JobHandle): Promise<JobStatus>;
  collect(handle: JobHandle): Promise<JobCollection>;
  cancel(handle: JobHandle): Promise<void>;
  retry(handle: JobHandle): Promise<JobHandle>;
}
```

## 8. Wait / Monitor / Resume
这是本轮讨论里最重要的新增点之一。

### 8.1 Wait
当执行条件不在本轮可得时，Commander 不应继续胡乱思考，应进入 wait：
- job running
- waiting for artifacts
- waiting for human gate
- waiting for external dependency

### 8.2 Monitor
系统应能持续看到：
- queued / running / finished / failed
- resource usage
- retries
- partial artifacts

### 8.3 Resume
满足 resume 条件后，重新构造 state briefing，把 job result 作为 observation 输入下一轮。

## 9. ZeRo 映射
### [R] 可参考
- `BashTool` 的输入格式
- `WaitAgentTool`
- scheduler 结构
- fuse list 检查

### [M] 必须改
- BashTool 需要科研 sandbox 包装
- schedule 不能等同于实验 executor
- command result 需要进入 artifact / observation 体系

### [N] 必须新增
- JobSpec
- Executor backends
- job watcher
- job collection
- wait / monitor / resume 与 control kernel 的耦合

## 10. V1 最低要求
- bash sandbox 可运行 tiny case
- local executor 可 submit/watch/collect
- job events 有 trace
- resume 能把 job result 带回 Commander
- raw data 不能被误写
