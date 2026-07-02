# Preflight and Mutation Boundary Spec

**状态**：v0.8.3 P1 补充规范  
**目标**：在 RunJob/ChangeRequest/Search 启动前，通过 deterministic preflight 防止越界修改、无 baseline 比较、评价脚本漂移、raw data 变更、secret 泄露等问题。

## 1. Mutation boundary

| 任务类型 | 允许修改 | 禁止修改，除非 PI gate |
|---|---|---|
| sensitivity | parameter override、AnalysisPlan | solver source、raw data、evaluation scripts |
| calibration | allowed parameter set | hidden numerical tolerance、raw observation、baseline |
| pure_engineering | Harness worktree、test code | raw data、accepted report、baseline |
| code_change | ChangeRequest 指定 worktree/file | main repo、benchmark baseline、raw data |
| physical_equation | TheoryToCodeBundle + worktree | 直接 search、未审查公式、accepted baseline |
| output_semantics | mapping + output registry patch | 静默改变 reader/report 语义 |

## 2. PreflightGuard schema

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

## 3. 必须检查项

```text
workspace_allowed_path
worktree_clean_or_expected_patch
files_changed_matches_worktree_diff        # ChangeRequest.files_changed == git diff 观测集（Scientific_Change_Gating §1.1 规则 0/4）
analysis_parameters_within_registry        # AnalysisPlan 参数键全部登记且参数 floor 求值完成（同规范 §1.2）
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

## 4. Runner integration

Runner submit 前应执行：

```text
preflight(task, job/analysis/change_request)
if status == fail:
  reject submit with ErrorRecord
else:
  write preflight artifact
  continue submit
```

**Preflight 是 submit 前的门，不是运行期防线（对抗审查 A03-5）**：job 运行期对 baseline / raw /
collected 的写入由沙箱路径策略拦截——执行器 spawn 的 job 进程继承与 agent 命令相同的路径约束
（Execution_Jobs_Runs §9.2 / §9.2.1；local 后端以权限位/只读目录落实，docker 后端以 ro bind mount 落实）。
分工：preflight 挡计划性错误（提交前可判定的），路径层挡运行期越界（提交后才发生的）。

## 5. 验收标准

- [ ] workspace 外写入被拒绝。
- [ ] 未记录 eval script hash 的 benchmark/search 被拒绝。
- [ ] high-risk change 无 bundle 被拒绝。
- [ ] raw data dirty 被拒绝或要求 PI gate。
- [ ] preflight artifact 进入 RunRecord/Report lineage。
