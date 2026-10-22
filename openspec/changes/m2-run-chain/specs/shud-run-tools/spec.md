# Spec Delta

## Purpose

定义模型可调用的 SHUD 运行工具：`shud_run` 提交一次 SHUD 运行作业并立即返回，`shud_collect` 幂等取回 RunRecord。工具只负责参数契约与校验，作业的持久化与生命周期由 shud-run-jobs 承担。

## ADDED Requirements

### Requirement: shud_run arguments
`shud_run` SHALL 接受参数：`input_dir`（必填，SHUD 项目输入目录的路径，相对路径按有效工作目录解析）、`project`（可选，缺省为 `input_dir` 的末级目录名）、`end_days`（可选，正整数，覆写副本中的 `END`）、`label`（可选，一行描述）。未知参数 SHALL 使调用失败。调用 SHALL 立即返回 `job_id`、`run_id`、运行目录路径与当前状态（`running` 或 `submitted`），SHALL NOT 等待 SHUD 结束。`shud_run` 本身 SHALL NOT 触发 PI 审批（raw 相关判定见 raw-data-guard）。

#### Scenario: submit ccw
- **WHEN** 模型调用 `shud_run`，`input_dir` 为 `SHUD/input/ccw` 的绝对路径、`end_days` 为 30
- **THEN** 工具结果含 `job_id`、`run_id`、`run_dir`，状态为 `running` 或 `submitted`，调用在 SHUD 结束前返回

#### Scenario: unknown argument
- **WHEN** 模型调用 `shud_run` 并传入 `threads: 4`
- **THEN** 工具返回错误结果并指出未知参数 `threads`，不创建运行目录

### Requirement: shud_run validation
`shud_run` SHALL 在提交前校验并以错误结果拒绝（不创建运行目录）：`input_dir` 不存在或不是目录；`input_dir` 中没有 `<project>.cfg.para`；`end_days` 不是正整数；运行目录根（有效工作目录下的 `runs/`）位于 `input_dir` 之内。错误结果 SHALL 指明失败的检查项。

#### Scenario: missing cfg.para
- **WHEN** `input_dir` 指向一个没有 `<project>.cfg.para` 的目录
- **THEN** 工具返回错误结果，指出缺少 `<project>.cfg.para`，不提交作业

#### Scenario: run dir inside input
- **WHEN** 有效工作目录就是 `input_dir` 本身
- **THEN** 工具返回错误结果，说明运行目录不能位于输入目录内

### Requirement: shud_collect
`shud_collect` SHALL 接受 `job_id` 或 `run_id`（二选一），返回该作业的 RunRecord；记录尚未生成而作业已处于终态时 SHALL 先 collect 再返回；作业仍为 `created`、`submitted` 或 `running` 时 SHALL 返回说明当前状态的错误结果；id 不存在时 SHALL 返回错误结果。多次调用 SHALL 返回同一份记录。

#### Scenario: collect finished run
- **WHEN** 对已结束的作业调用 `shud_collect`，参数为其 `run_id`
- **THEN** 返回与运行目录中 `run-record.json` 一致的 RunRecord

#### Scenario: collect running job
- **WHEN** 对 `running` 的作业调用 `shud_collect`
- **THEN** 返回错误结果，说明作业仍在运行
