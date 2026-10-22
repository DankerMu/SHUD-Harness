# Spec Delta

## Purpose

定义模型可调用的 SHUD 运行工具：`shud_run` 提交一次 SHUD 运行作业并立即返回，`shud_collect` 幂等取回 RunRecord。工具只负责参数契约、校验与响应模型捕获，作业的持久化与生命周期由 shud-run-jobs 承担。

## ADDED Requirements

### Requirement: shud_run arguments
`shud_run` SHALL 接受参数：`input_dir`（必填，SHUD 项目输入目录的路径，相对路径按有效工作目录解析）、`project`（可选，缺省为 `input_dir` 的末级目录名）、`end_days`（可选，正整数，覆写副本中的 `END`）、`label`（可选，一行描述，持久化为 RunJob 的 `label` 并拼入 dsh 登记 label）。`shud_run` SHALL NOT 接受 `workdir` 参数：其有效工作目录 SHALL 定义为调用所属会话的 cwd（session cwd），本 change 各 spec 中的"有效工作目录"均指它。未知参数 SHALL 使调用失败。调用 SHALL 在注册表同步完成提交（含输入复制）后立即返回 `job_id`、`run_id`（持久 id）、`dsh_job_id`（当前 dsh 登记 id，供 `job_output`/`job_kill` 使用）、`run_dir` 与 `status: running`，SHALL NOT 等待 SHUD 结束；提交失败时 SHALL 返回说明原因的工具错误，SHALL NOT 返回其它状态。工具结果文本 SHALL 写明 `job_output`/`job_kill` 需用 `dsh_job_id`，重启后的新 `dsh_job_id` 可经 `job_list`（label 含 `run_id`）或 `shud_collect` 查到。`shud_run` 本身 SHALL NOT 触发 PI 审批门；输入位于 raw 时的 provenance 读审批卡由 raw-data-guard 产生，不属于审批门。

#### Scenario: submit ccw
- **WHEN** 模型调用 `shud_run`，`input_dir` 为 `SHUD/input/ccw` 的绝对路径、`end_days` 为 30
- **THEN** 工具结果含 `job_id`（`JOB-…`）、`run_id`、`dsh_job_id`（`shud-…`）、`run_dir`，状态为 `running`，调用在 SHUD 结束前返回

#### Scenario: unknown argument
- **WHEN** 模型调用 `shud_run` 并传入 `threads: 4` 或 `workdir: "/tmp"`
- **THEN** 工具返回错误结果并指出未知参数，不创建运行目录

#### Scenario: label persisted
- **WHEN** 以 `label: "ccw 30d"` 调用 `shud_run`
- **THEN** `run-job.json` 的 `label` 为 `ccw 30d`，`job_list` 中该登记的 label 为 `<run_id> ccw 30d`

### Requirement: Response model capture
`shud_run` SHALL 在执行时取发起本次工具调用的响应体 model id，作为提交参数交给注册表写入 `run-job.json` 的 `llm.response_model`，并记 `llm.response_model_source: response`。工具执行上下文取不到响应体 model 时 SHALL 改记该 Agent 当前生效的已配置模型 id 并记 `response_model_source: configured`；两者都取不到时 SHALL 返回工具错误且不提交。取值 SHALL NOT 硬编码。

#### Scenario: response model unavailable
- **WHEN** 测试替身的工具执行上下文不提供响应体 model，只提供已配置模型 `deepseek-flash-guan`
- **THEN** `run-job.json` 的 `llm.response_model` 为 `deepseek-flash-guan`、`llm.response_model_source` 为 `configured`

#### Scenario: no model at all
- **WHEN** 测试替身的工具执行上下文既无响应体 model 也无已配置模型
- **THEN** 工具返回错误结果，不创建运行目录

### Requirement: shud_run validation
`shud_run` SHALL 在提交前校验并以错误结果拒绝（不创建运行目录）：`input_dir` 不存在或不是目录；`input_dir` 中没有 `<project>.cfg.para`；`end_days` 不是正整数；运行目录根（session cwd 下的 `runs/`）位于 `input_dir` 之内；`input_dir`（自身可为符号链接，按解析后目录处理）内部任一条目为符号链接或不是普通文件/目录（FIFO、设备、套接字等）。最后一条的理由：按链接复制会让 SHUD 的写回穿过链接写到原输入或 raw，解引用复制会在无审批卡的情况下读取链接目标。错误结果 SHALL 指明失败的检查项（符号链接时含该条目的相对路径）。

#### Scenario: missing cfg.para
- **WHEN** `input_dir` 指向一个没有 `<project>.cfg.para` 的目录
- **THEN** 工具返回错误结果，指出缺少 `<project>.cfg.para`，不提交作业

#### Scenario: run dir inside input
- **WHEN** session cwd 就是 `input_dir` 本身
- **THEN** 工具返回错误结果，说明运行目录不能位于输入目录内

#### Scenario: symlink entry in input
- **WHEN** `input_dir` 内的 `ccw.att` 是指向其它位置的符号链接
- **THEN** 工具返回错误结果并指出 `ccw.att`，不创建运行目录

### Requirement: shud_collect
`shud_collect` SHALL 接受 `job_id` 或 `run_id`（二选一），先在活动索引、再在完成索引（shud-run-jobs「State directory lock and indexes」）中查找运行目录，因此对已离开活动索引的作业、从任一会话或工作区调用均可找到。找到后 SHALL 返回该作业的 RunRecord；记录尚未生成而作业已处于终态时 SHALL 先 collect 再返回；collect 失败时 SHALL 返回含 `collect-error.json` 失败原因的错误结果；作业仍为 `created`、`submitted` 或 `running` 时 SHALL 返回说明当前状态与当前 `dsh_job_id` 的错误结果；两份索引都没有该 id 时 SHALL 返回错误结果，SHALL NOT 扫描文件系统。多次调用 SHALL 返回同一份记录。

#### Scenario: collect finished run
- **WHEN** 对已结束的作业调用 `shud_collect`，参数为其 `run_id`
- **THEN** 返回与运行目录中 `run-record.json` 一致的 RunRecord

#### Scenario: collect running job
- **WHEN** 对 `running` 的作业调用 `shud_collect`
- **THEN** 返回错误结果，说明作业仍在运行并给出其当前 `dsh_job_id`

#### Scenario: collect from another session after index removal
- **WHEN** 作业已唤醒并移出活动索引后，在另一个会话（session cwd 为另一工作区）以其 `run_id` 调用 `shud_collect`
- **THEN** 经完成索引找到运行目录，返回与其 `run-record.json` 一致的 RunRecord
