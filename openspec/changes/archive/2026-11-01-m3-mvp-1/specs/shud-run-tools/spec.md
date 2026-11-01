# Spec Delta

## MODIFIED Requirements

### Requirement: shud_run arguments
`shud_run` SHALL 接受参数：`input_dir`（必填，SHUD 项目输入目录的路径，相对路径按有效工作目录解析）、`project`（可选，缺省为 `input_dir` 的末级目录名）、`end_days`（可选，正整数，覆写副本中的 `END`）、`label`（可选，一行描述，持久化为 RunJob 的 `label` 并拼入 dsh 登记 label）、`task_id`（可选，品牌类型 `TaskId`，格式 `TASK-YYYYMMDDTHHMMSS-xxxx`）。提供 `task_id` 时，`shud_run` SHALL 按 task-cards「TaskCard links」的回写顺序执行：(1) 在创建运行目录之前先经品牌 schema 校验 `task_id`，取得关联作业后在同步边界读取有效工作目录下的 `tasks/<task_id>/task.json`，经 TaskCard schema 校验并核对文件内 id；状态不是 `planned` 或 `running` 时直接拒绝而不发布对账，可运行卡才执行并按需发布 task-cards「TaskCard reconcile」。id 格式不符、文件不存在、校验/身份失败或状态不可运行时 SHALL 返回指明原因的工具错误，SHALL NOT 创建运行目录；(2) 完成 M2 作业提交（durable），RunJob 的 `task_id` 记为该值（见 run-records）；(3) 以同步读取—校验—转换—`writeJsonSync` 边界（读与写之间不 await）原子改写该卡片：`linked_jobs` 加入本次 `job_id`，`stack_id`、`data_id` 写为本次提交的 StackLock 与 DataProvenance id，`status` 为 `running`，`runtime_phase` 为 `submitted_job`，`updated_at` 刷新（转换规则见 task-cards）。第 (3) 步失败时 `shud_run` SHALL 返回含本次 `run_id` 与"运行已 durable、任务卡回写失败"的工具错误，SHALL NOT 回滚已提交的运行；第 (2) 步失败不新增该次链接，也不撤销第 (1) 步已提交的旧作业修复。未提供 `task_id` 时 `shud_run` SHALL 照常提交（RunJob `task_id` 为 `null`），SHALL NOT 读写任何 TaskCard——K13 spike 即以此形态运行。`shud_run` SHALL NOT 接受 `workdir` 参数：其有效工作目录 SHALL 定义为调用所属会话的 cwd（session cwd），本 change 各 spec 中的"有效工作目录"均指它。未知参数 SHALL 使调用失败。调用 SHALL 在注册表同步完成提交（含输入复制）后立即返回 `job_id`、`run_id`（持久 id）、`dsh_job_id`（当前 dsh 登记 id，供 `job_output`/`job_kill` 使用）、`run_dir` 与 `status: running`，SHALL NOT 等待 SHUD 结束；提交失败时 SHALL 返回说明原因的工具错误，SHALL NOT 返回其它状态。工具结果文本 SHALL 写明 `job_output`/`job_kill` 需用 `dsh_job_id`，重启后的新 `dsh_job_id` 可经 `job_list`（label 含 `run_id`）或 `shud_collect` 查到。`shud_run` 本身 SHALL NOT 触发 PI 审批门；输入位于 raw 时的 provenance 读审批卡由 raw-data-guard 产生，不属于审批门。

#### Scenario: submit ccw
- **WHEN** 模型调用 `shud_run`，`input_dir` 为 `SHUD/input/ccw` 的绝对路径、`end_days` 为 30
- **THEN** 工具结果含 `job_id`（`JOB-…`）、`run_id`、`dsh_job_id`（`shud-…`）、`run_dir`，状态为 `running`，调用在 SHUD 结束前返回

#### Scenario: unknown argument
- **WHEN** 模型调用 `shud_run` 并传入 `threads: 4` 或 `workdir: "/tmp"`
- **THEN** 工具返回错误结果并指出未知参数，不创建运行目录

#### Scenario: label persisted
- **WHEN** 以 `label: "ccw 30d"` 调用 `shud_run`
- **THEN** `run-job.json` 的 `label` 为 `ccw 30d`，`job_list` 中该登记的 label 为 `<run_id> ccw 30d`

#### Scenario: submit with a planned task card
- **WHEN** 有效工作目录下 `tasks/<task_id>/task.json` 的 `status` 为 `planned`，模型以该 `task_id` 调用 `shud_run` 且提交成功
- **THEN** 工具结果状态为 `running`；该卡片的 `linked_jobs` 含本次 `job_id`，`stack_id`、`data_id` 与 `run-job.json` 中的值相同，`status` 为 `running`、`runtime_phase` 为 `submitted_job`；`run-job.json` 的 `task_id` 为该值

#### Scenario: second run on a running card
- **WHEN** 对 `status` 已为 `running` 的卡片再次以其 `task_id` 调用 `shud_run` 且提交成功
- **THEN** 卡片 `linked_jobs` 同时含两次的 `job_id`（按码点升序），`status` 仍为 `running`

#### Scenario: submit without a task card
- **WHEN** 有效工作目录下没有 `tasks/` 目录，模型不带 `task_id` 调用 `shud_run` 且提交成功
- **THEN** 工具结果状态为 `running`，`run-job.json` 的 `task_id` 为 `null`，会话 cwd 下没有创建 `tasks/`

#### Scenario: card write-back failure is reported with the run id
- **WHEN** 以 `planned` 卡片的 `task_id` 调用 `shud_run`，提交成功而改写 `task.json` 失败
- **THEN** 工具返回错误结果，含本次 `run_id` 与"运行已 durable、任务卡回写失败"，运行目录与活动索引条目保留

#### Scenario: unknown or malformed task_id
- **WHEN** 模型以有效工作目录下不存在卡片的 `task_id`，或以 `task_id: "TASK-0001"` 调用 `shud_run`
- **THEN** 工具返回错误结果并指出 `task_id`，不创建运行目录

#### Scenario: card in a non-runnable state
- **WHEN** 目标卡片 `status` 为 `reporting` 或 `done` 时以其 `task_id` 调用 `shud_run`
- **THEN** 工具返回错误结果并指出卡片当前状态，不创建运行目录，卡片字节不变

### Requirement: shud_run validation
`shud_run` SHALL 在提交前校验并以错误结果拒绝（不创建运行目录）：`input_dir` 不存在或不是目录；`input_dir` 中没有 `<project>.cfg.para`；`end_days` 不是正整数；运行目录根（session cwd 下的 `runs/`）位于 `input_dir` 之内；`input_dir`（自身可为符号链接，按解析后目录处理）内部任一条目为符号链接或不是普通文件/目录（FIFO、设备、套接字等）。最后一条的理由：按链接复制会让 SHUD 的写回穿过链接写到原输入或 raw，解引用复制会在无审批卡的情况下读取链接目标。此外，输入复制完成后、`run-job.json` 首次写入前执行的 StackLock 采集（见 stack-lock「Deterministic capture at shud_run submission」）或 DataProvenance 生成（见 data-provenance）失败时——包括任一 `stackRepos` 路径不是 git 仓库、`stacks/` 中已有文件损坏、输入副本文件不可读、StackLock 或 DataProvenance 写入失败——`shud_run` SHALL 返回说明原因的工具错误，SHALL NOT 提交作业，且 SHALL NOT 留下运行目录或索引条目。错误结果 SHALL 指明失败的检查项（符号链接时含该条目的相对路径）。

#### Scenario: missing cfg.para
- **WHEN** `input_dir` 指向一个没有 `<project>.cfg.para` 的目录
- **THEN** 工具返回错误结果，指出缺少 `<project>.cfg.para`，不提交作业

#### Scenario: run dir inside input
- **WHEN** session cwd 就是 `input_dir` 本身
- **THEN** 工具返回错误结果，说明运行目录不能位于输入目录内

#### Scenario: symlink entry in input
- **WHEN** `input_dir` 内的 `ccw.att` 是指向其它位置的符号链接
- **THEN** 工具返回错误结果并指出 `ccw.att`，不创建运行目录

#### Scenario: stack capture failure leaves no run
- **WHEN** `shud-jobs` 行 `stackRepos.AutoSHUD` 指向未初始化 submodule 的空目录时调用 `shud_run`
- **THEN** 工具返回错误结果并指明该路径，`runs/` 下没有新运行目录，活动索引不含新条目

#### Scenario: provenance failure leaves no run
- **WHEN** DataProvenance 写入 `provenance/` 失败（如该目录不可写）时调用 `shud_run`
- **THEN** 工具返回错误结果，`runs/` 下没有新运行目录，活动索引不含新条目

## ADDED Requirements

### Requirement: Report and task tools are mounted by dsh-shud-tools
`shud-tools` 行（`@shud-harness/dsh-shud-tools`）SHALL 在 `shud_run`、`shud_collect` 之外挂载模型工具 `task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`。五个工具 SHALL 与 `shud_run`/`shud_collect` 共用同一严格工具适配：参数 schema 闭合，未知键或错误根类型 SHALL 使调用返回指出该键的工具错误，且 SHALL NOT 读写任何工作区文件。各工具的参数、状态转换与持久化行为由 task-cards（`task_create`）与 evidence-reports（`report_generate`、`report_validate`、`report_submit`、`report_decide`）定义；`report_submit` 与 `report_decide` 的审批由 policy-gate 定义，本 capability 只约束挂载与参数闭合。

#### Scenario: tools are registered
- **WHEN** 以 `shud` profile 启动宿主并枚举已注册工具
- **THEN** 工具列表含 `shud_run`、`shud_collect`、`task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`

#### Scenario: unknown key rejected
- **WHEN** 模型调用 `report_validate` 并在 `report_id` 之外传入 `force: true`
- **THEN** 工具返回错误结果并指出 `force`，`reports/` 下文件字节不变
