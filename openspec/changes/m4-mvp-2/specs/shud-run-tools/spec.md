# Spec Delta

## MODIFIED Requirements

### Requirement: shud_run arguments
`shud_run` SHALL 接受参数：`input_dir`（必填，SHUD 项目输入目录的路径，相对路径按有效工作目录解析）、`project`（可选，缺省为 `input_dir` 的末级目录名）、`end_days`（可选，正整数，覆写副本中的 `END`）、`label`（可选，一行描述，持久化为 RunJob 的 `label` 并拼入 dsh 登记 label）、`task_id`（可选，品牌类型 `TaskId`，格式 `TASK-YYYYMMDDTHHMMSS-xxxx`）、`build_id`（可选，品牌类型 `BuildId`，格式 `BUILD-YYYYMMDDTHHMMSS-xxxx`）、`threads`（可选，正整数）。`build_id` SHALL 在任何文件系统操作之前经品牌 schema 校验，`threads` SHALL 在提交前校验为正整数；格式不符、非整数、零或负数时 SHALL 返回指出该参数的工具错误，SHALL NOT 创建运行目录。合法 `build_id` 与 `threads` SHALL 原样交给注册表，其解析、二进制替换、线程环境与持久化由 shud-run-jobs「Build-referenced execution」定义；两者缺省时 SHALL 沿用既有提交路径（配置 `shudBin`、不设置线程环境变量），RunJob 的 `build_id`、`threads` 记为 `null`。提供 `task_id` 时，`shud_run` SHALL 按 task-cards「TaskCard links」的回写顺序执行：(1) 在创建运行目录之前先经品牌 schema 校验 `task_id`，取得关联作业后在同步边界读取有效工作目录下的 `tasks/<task_id>/task.json`，经 TaskCard schema 校验并核对文件内 id；状态不是 `planned` 或 `running` 时直接拒绝而不发布对账，可运行卡才执行并按需发布 task-cards「TaskCard reconcile」。id 格式不符、文件不存在、校验/身份失败或状态不可运行时 SHALL 返回指明原因的工具错误，SHALL NOT 创建运行目录；(2) 完成 M2 作业提交（durable），RunJob 的 `task_id` 记为该值（见 run-records）；(3) 以同步读取—校验—转换—`writeJsonSync` 边界（读与写之间不 await）原子改写该卡片：`linked_jobs` 加入本次 `job_id`，`stack_id`、`data_id` 写为本次提交的 StackLock 与 DataProvenance id，`status` 为 `running`，`runtime_phase` 为 `submitted_job`，`updated_at` 刷新（转换规则见 task-cards）。第 (3) 步失败时 `shud_run` SHALL 返回含本次 `run_id` 与"运行已 durable、任务卡回写失败"的工具错误，SHALL NOT 回滚已提交的运行；第 (2) 步失败不新增该次链接，也不撤销第 (1) 步已提交的旧作业修复。未提供 `task_id` 时 `shud_run` SHALL 照常提交（RunJob `task_id` 为 `null`），SHALL NOT 读写任何 TaskCard——K13 spike 即以此形态运行。`shud_run` SHALL NOT 接受 `workdir` 参数：其有效工作目录 SHALL 定义为调用所属会话的 cwd（session cwd），本 change 各 spec 中的"有效工作目录"均指它。未知参数 SHALL 使调用失败。调用 SHALL 在注册表同步完成提交（含输入复制）后立即返回 `job_id`、`run_id`（持久 id）、`dsh_job_id`（当前 dsh 登记 id，供 `job_output`/`job_kill` 使用）、`run_dir` 与 `status: running`，SHALL NOT 等待 SHUD 结束；提交失败时 SHALL 返回说明原因的工具错误，SHALL NOT 返回其它状态。工具结果文本 SHALL 写明 `job_output`/`job_kill` 需用 `dsh_job_id`，重启后的新 `dsh_job_id` 可经 `job_list`（label 含 `run_id`）或 `shud_collect` 查到。`shud_run` 本身 SHALL NOT 触发 PI 审批门；输入位于 raw 时的 provenance 读审批卡由 raw-data-guard 产生，不属于审批门。

#### Scenario: submit ccw
- **WHEN** 模型调用 `shud_run`，`input_dir` 为 `SHUD/input/ccw` 的绝对路径、`end_days` 为 30
- **THEN** 工具结果含 `job_id`（`JOB-…`）、`run_id`、`dsh_job_id`（`shud-…`）、`run_dir`，状态为 `running`，调用在 SHUD 结束前返回

#### Scenario: unknown argument
- **WHEN** 模型调用 `shud_run` 并传入 `workdir: "/tmp"`
- **THEN** 工具返回错误结果并指出未知参数 `workdir`，不创建运行目录

#### Scenario: invalid threads rejected
- **WHEN** 模型调用 `shud_run` 并传入 `threads: 0`、`threads: -1`、`threads: 1.5` 或 `threads: "1"`
- **THEN** 工具返回错误结果并指出 `threads`，不创建运行目录

#### Scenario: malformed build_id rejected
- **WHEN** 模型以 `build_id: "BUILD-0001"` 或 `build_id: "../builds/x"` 调用 `shud_run`
- **THEN** 工具返回错误结果并指出 `build_id`，不创建运行目录，不读取 `builds/` 下任何文件

#### Scenario: build and threads recorded
- **WHEN** 会话 cwd 下 `builds/<build_id>/` 为一次成功构建，模型以该 `build_id` 与 `threads: 1` 调用 `shud_run` 且提交成功
- **THEN** 工具结果状态为 `running`，`run-job.json` 的 `build_id` 为该 id、`threads` 为 `1`

#### Scenario: submission without build or threads is unchanged
- **WHEN** 模型不带 `build_id` 与 `threads` 调用 `shud_run` 且提交成功
- **THEN** `run-job.json` 的 `build_id` 与 `threads` 均为 `null`，包装进程使用配置的 `shudBin`，其环境不新增 `OMP_NUM_THREADS` 或 `SHUD_RHS_THREADS`

#### Scenario: invalid build arguments precede task reconciliation
- **WHEN** 调用带有合法 `task_id`，但 `build_id` 品牌非法或 `threads` 为非法值
- **THEN** 工具在关联作业查询、TaskCard 读取/修复及提交前拒绝，不读写工作区文件，不读取 builds、不创建运行目录，卡片字节与修改时间不变

#### Scenario: threads and build selection are independent
- **WHEN** 仅提供合法 `threads` 而不提供 `build_id`；另一次仅提供合法 `build_id` 而不提供 `threads`
- **THEN** 前者使用配置二进制、记录 null build_id/binary_sha256 和指定 threads；后者使用已验证的运行目录二进制副本、记录该 build_id/摘要和 null threads，未指定的线程环境沿用宿主值而非清空

#### Scenario: replay input without END override is preserved
- **WHEN** 以构造的 keliya 布局输入调用 `shud_run`，未提供 `end_days`
- **THEN** 副本 cfg 文件与原文件字节相同，包括 START、END 与 NUM_OPENMP；不因 build_id/threads 参数而重写求解器配置

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

### Requirement: Report and task tools are mounted by dsh-shud-tools
`shud-tools` 行（`@shud-harness/dsh-shud-tools`）SHALL 在 `shud_run`、`shud_collect` 之外挂载模型工具 `task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`change_create`、`change_submit`、`shud_build`、`verification_run`。这九个工具 SHALL 与 `shud_run`/`shud_collect` 共用同一严格工具适配：参数 schema 闭合，未知键或错误根类型 SHALL 使调用返回指出该键的工具错误，且 SHALL NOT 读写任何工作区文件、SHALL NOT 委托给后端操作；参数校验通过的每次调用 SHALL 恰好委托一次给对应 capability 定义的操作，SHALL NOT 自动重试或重复委托。各工具的参数、状态转换与持久化行为由 task-cards（`task_create`，含 `code_change` 卡）、evidence-reports（`report_generate`，含 `code_change` 卡，以及 `report_validate`、`report_submit`、`report_decide`）、change-requests（`change_create`、`change_submit`）、shud-build（`shud_build`）与 verification-cases（`verification_run`）定义；`report_submit`、`report_decide` 与 `change_submit` 的审批由 policy-gate 定义，本 capability 只约束挂载、参数闭合与单次委托。四个新工具 `change_create`、`change_submit`、`shud_build`、`verification_run` 各自随实现其操作的切片落地挂载（各带闭合参数 schema），SHALL NOT 以占位实现先行挂载；`verification_run` 读取运行结果 SHALL 复用注册表 `collectShud(id, {readonly: true})` 只读模式，SHALL NOT 另建收集路径或触发收集。

#### Scenario: tools are registered
- **WHEN** 以 `shud` profile 启动宿主并枚举已注册工具
- **THEN** 工具列表含 `shud_run`、`shud_collect`、`task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`change_create`、`change_submit`、`shud_build`、`verification_run`

#### Scenario: unknown key rejected
- **WHEN** 模型调用 `report_validate` 并在 `report_id` 之外传入 `force: true`
- **THEN** 工具返回错误结果并指出 `force`，`reports/` 下文件字节不变

#### Scenario: unknown key on a new tool rejected
- **WHEN** 模型调用 `shud_build` 并传入 `source_path: "/tmp/SHUD"`，或调用 `change_submit` 并在 `change_id` 之外传入 `approve: true`
- **THEN** 工具返回错误结果并指出该未知键，不委托后端操作；`builds/`、`changes/`、`patches/`、`tasks/` 下文件字节与目录清单不变

#### Scenario: wrong root type rejected
- **WHEN** 模型以数组 `[]` 或字符串作为 `verification_run` 的参数根调用
- **THEN** 工具返回错误结果，不委托后端操作，`verifications/` 与 `tasks/` 下文件字节不变

#### Scenario: verification_run reads runs in readonly mode
- **WHEN** 模型以合法参数调用 `verification_run`，候选运行已终态但尚未 collected
- **THEN** `collectShud(id, {readonly: true})` 因该运行没有已有 RunRecord 而拒绝，工具返回指出该 `run_id` 的错误，该运行目录不新增 `run-record.json` 或 `collect-error.json`

#### Scenario: valid call delegates exactly once
- **WHEN** 模型以合法参数调用 `change_create`，而对应后端操作返回错误
- **THEN** 后端操作被调用恰好一次，工具返回该错误，不自动重试
