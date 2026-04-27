# Runner Adapter Contracts

**状态：** v0.8.1 P1 补充规范  
**适用范围：** `local_direct`、`local_job`、`docker_job`、未来 `slurm`，RunJob watcher，Sandbox Executor。  
**目标：** 统一不同执行后端的 submit/status/cancel/collect 接口，使 Park/Resume 不依赖具体运行环境。

## 1. Runner interface

```ts
interface RunnerAdapter {
  kind: "local_direct" | "local_job" | "docker_job" | "slurm";
  submit(req: RunnerSubmitRequest): Promise<RunnerSubmitResult>;
  status(handle: RunnerHandle): Promise<RunnerStatus>;
  cancel(handle: RunnerHandle): Promise<RunnerCancelResult>;
  collect(handle: RunnerHandle): Promise<RunnerCollectResult>;
}
```

## 2. Submit request

```ts
interface RunnerSubmitRequest {
  task_id: string;
  job_id: string;
  cwd: string;
  command: string[];
  env?: Record<string, string>;
  timeout_seconds?: number;
  stdout_path: string;
  stderr_path: string;
  resources?: {
    max_wall_minutes?: number;
    max_memory_mb?: number;
    omp_num_threads?: number;
  };
  risk_level: "low" | "medium" | "high";
}
```

### 2.1 Preflight guard

Runner submit 前应执行 preflight 检查：

```ts
interface PreflightGuardResult {
  guard_id: string;
  task_id: string;
  job_id?: string;
  change_request_id?: string;
  analysis_plan_id?: string;

  checks: PreflightCheck[];
  status: "pass" | "fail" | "warning";
  blocking_reasons: string[];
  artifact_id: string;
}

interface PreflightCheck {
  check_id: string;
  name: string;
  status: "pass" | "fail" | "warning" | "not_applicable";
  details: string;
}
```

必须检查项：

```text
workspace_allowed_path
worktree_clean_or_expected_patch
theory_bundle_required_if_high_risk
theory_bundle_status_allows_search
baseline_required_for_improvement_claim
evaluation_script_hash_recorded
input_data_checksum_verified
raw_data_not_modified
benchmark_baseline_not_modified_without_gate
disk_free_threshold_passed
memory_thread_budget_declared
secret_redaction_enabled
output_directory_run_scoped
```

Preflight 执行流程：

```text
preflight(task, job/analysis/change_request)
if status == fail:
  reject submit with ErrorRecord
else:
  write preflight artifact
  continue submit
```

完整 Preflight 和 Mutation Boundary 规范见 [Preflight_And_Mutation_Boundary_Spec.md](Preflight_And_Mutation_Boundary_Spec.md)。

## 3. Status mapping

不同后端状态必须映射到 RunJob.status：

| Runner raw | RunJob.status |
|---|---|
| process started / container running / slurm RUNNING | running |
| exit_code=0 | succeeded |
| exit_code!=0 | failed |
| killed by user | cancelled |
| walltime exceeded | timed_out |
| collected outputs | collected |

## 4. Collect result

```ts
interface RunnerCollectResult {
  job_id: string;
  exit_code?: number;
  started_at?: string;
  finished_at?: string;
  wall_seconds?: number;
  peak_memory_mb?: number;
  stdout_path: string;
  stderr_path: string;
  output_paths: string[];
  error_id?: string;
}
```

## 5. local_direct

- 只用于短命令；
- 不进入 Park/Resume；
- 仍需 toolcall artifact；
- 超过 `short_task_timeout_seconds` 应拒绝或转为 `local_job`。

## 6. local_job

- 创建 pid/status file；
- watcher 监控 pid、exit code、heartbeat、stdout/stderr；
- 支持 service restart recovery。

## 7. docker_job

- workspace 以 volume 挂载；
- container id 作为 runner handle；
- collect 时复制/读取 mounted output；
- Docker env secrets 不写入 artifact。

## 8. slurm

MVP 不实现完整 SLURM，但接口应兼容：

```text
slurm.submit
slurm.status
slurm.cancel
slurm.collect_logs
```

SLURM array job 每个 array item 应映射到独立 parameter_set 或 child job。

## 9. 验收标准

- [ ] 所有 runner 都能输出统一 RunnerCollectResult。
- [ ] RunJob.status 不暴露后端特有状态。
- [ ] local_job 服务重启可恢复 watcher。
- [ ] docker/slurm 缺失依赖时错误进入 ErrorRecord。
- [ ] long SHUD run 不通过 local_direct 阻塞 LLM loop。
- [ ] Runner submit 前执行 preflight。
- [ ] preflight fail 返回 ErrorRecord，不创建 running job。
- [ ] preflight artifact 进入 RunRecord lineage。
