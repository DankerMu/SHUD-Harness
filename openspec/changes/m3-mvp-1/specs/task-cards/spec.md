# Spec Delta

## Purpose
定义 TaskCard（一次 PI 科研辅助任务的任务卡）的品牌 id、字段契约、会话工作区文件持久化及本 change 全部工作区对象共用的文件安全规则、状态机转换表、卡片与作业的唯一对账规则、`science_assist` closure 谓词与 `task_create` 工具契约，使任务卡只能经确定性规则推进与关闭，而不是因 LLM 认为完成而关闭。

## ADDED Requirements

### Requirement: Task identifier
系统 SHALL 为每张 TaskCard 在建卡时分配 `task_id`，格式为 `TASK-YYYYMMDDTHHMMSS-xxxx`：时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数。schema SHALL 拒绝不符合该格式的 id（包括旧格式 `TASK-0001`）。同一 TaskCard 关联的其它对象 id（`STACK-`、`DATA-`、`REPORT-`、`JOB-`、`RUN-`）的随机段 SHALL 各自独立生成，SHALL NOT 要求与 `task_id` 共享随机段。新分配的 `task_id` 在会话 cwd 下已存在同名 `tasks/<task_id>/` 时 SHALL 重新生成。

#### Scenario: branded task id
- **WHEN** 在 UTC 2026-10-27 08:00:05 建卡
- **THEN** `task_id` 形如 `TASK-20261027T080005-3f9c`

#### Scenario: malformed task id rejected
- **WHEN** 以 `task_id: "TASK-0001"`、`task_id: "TASK-20261027T080005-3F9C"`（大写十六进制）或 `task_id: "RUN-20261027T080005-3f9c"` 解析 TaskCard
- **THEN** schema 解析失败并指出 `task_id` 字段

### Requirement: TaskCard record
TaskCard SHALL 含：`task_id`（品牌 `TaskId`）、`type`（`engineering|science_assist|ops`）、`status`（`created|planned|running|parked|reporting|awaiting_pi|done|cancelled|blocked`）、`runtime_phase`（`running_local|submitted_job|waiting_for_job|collecting` 或 `null`）、`title`、`question_or_goal`、`created_by`、`current_owner`、`reviewer`（均为非空字符串）、`stack_id`（品牌 `StackId` 或 `null`）、`data_id`（品牌 `DataId` 或 `null`）、`inference_budget`、`linked_jobs`（`JOB-YYYYMMDDTHHMMSS-xxxx` 格式的 `job_id` 数组）、`linked_reports`（`REPORT-YYYYMMDDTHHMMSS-xxxx` 格式的 `report_id` 数组）、`created_at`、`updated_at`，以及可选的 `theory_bundle_ids`。建卡时 `stack_id` 与 `data_id` SHALL 为 `null`，由 `shud_run` 提交回填。

#### Scenario: fresh card with null references
- **WHEN** 解析一个 `status: planned`、`stack_id: null`、`data_id: null`、`linked_jobs: []`、`linked_reports: []` 的 TaskCard
- **THEN** 解析成功

#### Scenario: invalid linked ids rejected
- **WHEN** 解析 `linked_jobs: ["JOB-0001"]`、`linked_reports: ["REPORT-0001"]` 或 `stack_id: "STACK-0001"` 的 TaskCard
- **THEN** schema 解析失败并指出对应字段

### Requirement: TaskCard workspace file
TaskCard SHALL 持久化为会话 cwd 下的 `tasks/<task_id>/task.json`，每次写入 SHALL 以同目录临时文件加 rename 原子替换，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；查找 SHALL 按 `task_id` 直接定位该文件。读取 SHALL 经 core schema 校验；文件缺失、不可解析或校验失败时 SHALL 返回说明原因的错误，SHALL NOT 改写该文件。

本 requirement 同时是 TaskCard、StackLock、DataProvenance 与 EvidenceReport 四类工作区对象共用的工作区文件安全规则（其它 spec 以一句引用）：(1) 对象 id SHALL 在任何路径拼接之前经对应品牌 schema（`TaskId`、`StackId`、`DataId`、`ReportId`）校验，未通过即返回错误、不访问文件系统；工具与 policy-gate 插件 SHALL NOT 由原始字符串构造工作区路径，只由通过校验的品牌 id 构造。(2) 会话 cwd 下的 `tasks`、`stacks`、`provenance`、`reports` 目录（以及 `tasks/<task_id>/`）不存在时 SHALL 以 `mkdir -p` 创建；已存在时 SHALL 先 `lstat`，凡不是真实目录（符号链接、普通文件、特殊文件）一律 fail-closed 返回指出该路径的错误，SHALL NOT 跟随链接。(3) 目标文件在读或写之前 SHALL 先 `lstat`，符号链接与特殊文件 fail-closed。(4) 写入 SHALL 为同目录临时文件加 `rename`，由 records 包的文件层实现——该实现由 `packages/dsh-shud-jobs/src/state-files.ts` 原地迁入 records、jobs 改为 import，仓库中只有一份；唯一例外是 StackLock 以排他创建写入（见 stack-lock「Deterministic capture at shud_run submission」）。

#### Scenario: card written atomically
- **WHEN** `task_create` 成功返回 `task_id`
- **THEN** 会话 cwd 下存在 `tasks/<task_id>/task.json`，内容通过 TaskCard schema 校验，且该目录不残留临时文件

#### Scenario: corrupt card fails closed
- **WHEN** `tasks/<task_id>/task.json` 被改写为非法 JSON 后，以该 `task_id` 调用 `report_generate`
- **THEN** 工具返回错误结果，`task.json` 的字节保持不变

#### Scenario: malformed id never reaches the file system
- **WHEN** 以 `task_id: "../reports/x"` 调用 `report_generate` 或 `shud_run`
- **THEN** 工具返回指出 `task_id` 的错误，没有任何以该字符串拼接的路径被 `lstat`、读取或创建

#### Scenario: symlinked object directory fails closed
- **WHEN** 会话 cwd 下的 `tasks` 是指向其它目录的符号链接时调用 `task_create`
- **THEN** 工具返回指出 `tasks` 的错误，链接目标内不新增文件

#### Scenario: symlinked target file fails closed
- **WHEN** `tasks/<task_id>/task.json` 是指向其它文件的符号链接时以该 `task_id` 调用 `report_generate`
- **THEN** 工具返回错误结果，链接本身与其目标的字节均不变

### Requirement: TaskCard transitions
TaskCard 状态 SHALL 只按下表转换；每次转换 SHALL 同时写入表中的 `runtime_phase` 并刷新 `updated_at`：

| 事件 | 前态 | 后态 | `runtime_phase` |
|---|---|---|---|
| `task_create` | — | `planned` | `null` |
| `shud_run(task_id)` 提交成功 | `planned` 或 `running` | `running` | `submitted_job` |
| 「TaskCard reconcile」发现未终态的关联作业 | `planned` | `running` | `submitted_job` |
| `report_generate` 且 closure 谓词成立 | `running`、`planned` 或 `reporting` | `reporting` | `null` |
| `report_submit` 获 `allowed-once` 执行 | `reporting` | `done` | `null` |
| `report_decide(revision_requested)` 获 `allowed-once` 执行 | `reporting` | `planned` | `null` |
| `report_decide(rejected)` 获 `allowed-once` 执行 | `reporting` | `cancelled` | `null` |

`awaiting_pi` SHALL 保留在 `status` 枚举中，但在 M3 只是审批卡挂起期间的瞬时态：审批结果在工具执行之前决定，放行即执行、拒绝即不执行，因此 M3 SHALL NOT 把 `awaiting_pi` 写入 `task.json`；审批卡未放行时 TaskCard SHALL 停在 `reporting`。`created` SHALL 只作为建卡原子写入前的内存态，SHALL NOT 出现在已写入的 `task.json` 中。M3 中 SHALL NOT 存在进入 `parked` 或 `blocked` 的转换（两者保留在枚举中）。事件在表外的前态上发生时 SHALL 被拒绝并返回错误，`task.json` SHALL 保持不变。

#### Scenario: run submission moves card to running
- **WHEN** 对 `status: planned` 的 TaskCard 以其 `task_id` 成功提交 `shud_run`
- **THEN** `task.json` 的 `status` 为 `running`、`runtime_phase` 为 `submitted_job`，`updated_at` 晚于提交前的值

#### Scenario: approved submit closes the card
- **WHEN** TaskCard 处于 `reporting`，其报告的 `report_submit` 获 `allowed-once` 执行
- **THEN** `task.json` 的 `status` 直接由 `reporting` 变为 `done`，中间不写入任何审批挂起态

#### Scenario: decide transitions from reporting
- **WHEN** TaskCard 处于 `reporting`，`report_decide` 以 `disposition: revision_requested`（或 `rejected`）获 `allowed-once` 执行
- **THEN** `task.json` 的 `status` 变为 `planned`（或 `cancelled`），`runtime_phase` 为 `null`

#### Scenario: rejected submit card leaves card reporting
- **WHEN** TaskCard 处于 `reporting`，其报告的 `report_submit` 审批卡被 PI 拒绝
- **THEN** `task.json` 的 `status` 仍为 `reporting`，字节与修改时间不变

#### Scenario: illegal transition rejected without write
- **WHEN** 对 `status: planned`、`linked_jobs: []` 且注册表中没有该 `task_id` 作业的 TaskCard 调用 `report_generate`，或对 `status: done` 的 TaskCard 执行获放行的 `report_decide`
- **THEN** 前者返回指出无关联作业的 closure 错误，后者返回指出卡片状态的错误；两者 `task.json` 的字节与修改时间不变

#### Scenario: report regenerated from reporting
- **WHEN** TaskCard 处于 `reporting`，closure 谓词仍成立，再次调用 `report_generate`
- **THEN** 卡片仍为 `reporting`，`linked_reports` 末尾追加新的 `report_id`，`updated_at` 刷新

#### Scenario: transient and unreachable states never written
- **WHEN** 对一张 TaskCard 依次发生表中所有可达事件
- **THEN** 写入的 `status` 从不为 `awaiting_pi`、`parked`、`blocked` 或 `created`

### Requirement: task_create
`task_create` SHALL 接受参数：`type`（必填，取值只能为 `science_assist`，无缺省值）、`title`（必填，非空字符串）、`question_or_goal`（必填，非空字符串）。`type` 缺失或为 `engineering`、`ops`，其它必填参数缺失或为空，或出现未知参数时，调用 SHALL 返回指出原因的工具错误且 SHALL NOT 创建 `tasks/` 下任何文件。成功时 SHALL 确定性写入 TaskCard：`status: planned`、`runtime_phase: null`、`created_by` 与 `current_owner` 为调用 Agent 的 preset id——经 policy-gate「Caller role derivation」的同一读取路径 `exec.agent?.session.header.agentPreset` 取得的非空字符串原值，读取路径中任一环节缺失时为 `unknown`（首任务中为 `coordinator`）——、`reviewer: pi`、`inference_budget: {mode: "normal"}`、`stack_id: null`、`data_id: null`、`linked_jobs: []`、`linked_reports: []`，并在结果中返回 `task_id` 与 `status: planned`。

调用 SHALL 提供有效会话 cwd；缺少 agent、session 或非空 cwd 时 SHALL 在访问文件系统前返回指出工作区缺失的错误，SHALL NOT 回退宿主进程目录。preset 身份缺失与工作区缺失 SHALL 分别处理。

#### Scenario: create science_assist card
- **WHEN** 模型调用 `task_create`，`type: science_assist`、`title: "ccw 30 天运行"`、`question_or_goal: "跑通 ccw 并生成证据报告"`
- **THEN** 工具结果含 `TASK-…` 格式的 `task_id` 与 `status: planned`，`tasks/<task_id>/task.json` 的 `status` 为 `planned`、`created_by` 与 `current_owner` 为 `coordinator`、`reviewer` 为 `pi`、`inference_budget` 为 `{mode: "normal"}`

#### Scenario: missing or non-science_assist type rejected
- **WHEN** 模型以 `type: engineering` 或 `type: ops` 调用 `task_create`，或省略 `type`
- **THEN** 工具返回错误结果，会话 cwd 下不新增 `tasks/` 条目

#### Scenario: creator without a preset header
- **WHEN** 工具执行上下文具有会话 cwd，但会话 header 没有 `agentPreset` 时调用合法的 `task_create`
- **THEN** 建卡成功，`created_by` 与 `current_owner` 均为 `unknown`

#### Scenario: missing calling workspace
- **WHEN** 工具执行上下文缺少 agent、session 或非空 cwd 时调用合法的 `task_create`
- **THEN** 返回指出工作区缺失的工具错误，不创建任何文件，不使用宿主进程目录

#### Scenario: missing goal or unknown argument
- **WHEN** 模型调用 `task_create` 时省略 `question_or_goal`，或传入 `status: done`
- **THEN** 工具返回错误结果并指出缺失或未知的参数，不创建任何文件

### Requirement: TaskCard links
以某 `task_id` 成功提交的 `shud_run` SHALL 把本次 `job_id` 加入该 TaskCard 的 `linked_jobs`，并把本次提交解析得到的 `stack_id` 与 `data_id` 写入 TaskCard。`report_generate` 成功 SHALL 把新报告的 `report_id` 追加到 `linked_reports`。已有条目 SHALL NOT 被删除或改写。未成功的提交或报告生成 SHALL NOT 改动 `linked_jobs`/`linked_reports`。`shud_run(task_id)` 的卡片回写顺序 SHALL 为：(1) 执行「TaskCard reconcile」后读取并校验 TaskCard（品牌 id、`planned` 或 `running`）；(2) M2 作业提交（durable，RunJob 携带 `task_id`、`stack_id`、`data_id`）；(3) 重新读取 TaskCard、校验、按转换表转换并以 `writeJsonSync` 原子写入，读取与写入之间 SHALL NOT 有 await（沿 M2 RunJob 同步校验/转换/发布边界）。第 (3) 步失败（含卡片在 (1) 与 (3) 之间已离开 `planned|running`）时 `shud_run` SHALL 返回含本次 `run_id` 与"运行已 durable、任务卡回写失败"的工具错误，运行 SHALL NOT 回滚；缺失的链接由后续以该 `task_id` 调用 `shud_run` 或 `report_generate` 时的「TaskCard reconcile」补齐。

#### Scenario: card write-back failure keeps the run
- **WHEN** 以 `task_id` 调用 `shud_run`，作业已提交而第 (3) 步写 `task.json` 失败
- **THEN** 工具返回含 `run_id` 与"运行已 durable、任务卡回写失败"的错误，`runs/<run_id>/run-job.json` 存在且其 `task_id` 为该值，活动索引含该作业，卡片 `linked_jobs` 尚不含本次 `job_id`

#### Scenario: job and report linked
- **WHEN** 以 `task_id` 提交一次 `shud_run` 得到 `job_id: JOB-20261027T081000-a1b2`，随后对该卡 `report_generate` 成功得到 `report_id`
- **THEN** `task.json` 的 `linked_jobs` 含该 `job_id`，`stack_id`/`data_id` 为该次 RunJob 中的值，`linked_reports` 含该 `report_id`

#### Scenario: failed submission leaves links unchanged
- **WHEN** 以 `task_id` 调用 `shud_run` 而提交失败（例如 `input_dir` 缺少 `<project>.cfg.para`）
- **THEN** 该 TaskCard 的 `linked_jobs`、`stack_id`、`data_id` 与 `status` 不变

### Requirement: TaskCard reconcile
records 包 SHALL 提供纯函数 `reconcileTaskCard(card, runJobsForTask)`，它是卡片与作业之间唯一的对账规则：`runJobsForTask` 为 shud-run-jobs「Run jobs by task query」以该 `task_id` 返回的 RunJob 列表；结果卡片的 `linked_jobs` SHALL 为原 `linked_jobs` 与这些 RunJob 的 `job_id` 的并集，按码点升序排列；`stack_id` 或 `data_id` 为 `null` 时 SHALL 以这些 RunJob 中 `submitted_at` 最新者（相同时取 `job_id` 码点序最大者）的非 `null` 值填补，非 `null` 的既有值 SHALL NOT 被改写；卡片为 `planned` 且任一关联 RunJob 的 `status` 不在 `succeeded|failed|cancelled|collected` 中时，SHALL 按转换表转为 `running`。结果与原卡片相同时 SHALL NOT 写文件；不同时 SHALL 以与第 (3) 步相同的同步读取—校验—转换—`writeJsonSync` 边界写回并刷新 `updated_at`，写回失败使调用它的工具返回说明原因的错误。`shud_run(task_id)` 与 `report_generate` SHALL 在各自开头调用它；其它工具 SHALL NOT 对账卡片与作业。M3 为单进程、同步边界写入，同一卡片的两次写入不会交错。

#### Scenario: reconcile restores a missing job link
- **WHEN** 某次 `shud_run(task_id)` 的卡片回写失败后（卡片 `linked_jobs` 不含该 `job_id`、`stack_id` 为 `null`），对该卡调用 `report_generate`
- **THEN** `report_generate` 先把该 `job_id` 并入 `linked_jobs` 并填补 `stack_id`/`data_id`，再求 closure 谓词

#### Scenario: reconcile moves a planned card with a live job
- **WHEN** 卡片为 `planned`，注册表中有一个该 `task_id` 的 `running` RunJob 不在 `linked_jobs` 中，以该 `task_id` 调用 `shud_run`
- **THEN** 提交前卡片已写为 `running`、`runtime_phase: submitted_job` 且 `linked_jobs` 含该作业；本次提交成功后 `linked_jobs` 同时含两次的 `job_id`

#### Scenario: no-op reconcile does not write
- **WHEN** 卡片的 `linked_jobs`、`stack_id`、`data_id` 与 `status` 已与注册表一致时调用 `report_generate`
- **THEN** reconcile 不写 `task.json`；若 closure 谓词随后不成立，`task.json` 的字节与修改时间不变

#### Scenario: existing references are not overwritten
- **WHEN** 卡片 `stack_id` 已为非 `null` 值，而最新关联 RunJob 的 `stack_id` 不同
- **THEN** reconcile 保留卡片原 `stack_id`

### Requirement: science_assist closure predicate
`science_assist` TaskCard 的 closure 谓词 SHALL 在 `report_generate` 中、「TaskCard reconcile」之后、写任何报告文件之前求值，且仅当以下各条全部成立时成立：`linked_jobs` 非空；`linked_jobs` 中每个作业的 RunJob 处于 `collected` 且有 RunRecord；每个关联 RunRecord 的 `stack_id` 与 `data_id` 非 `null`；本次 `report_generate` 参数提供的 `observations`、`limitations`、`pi_questions` 各至少一条（`limitations` 按模型传入的条目计数，自动追加的说明不计入）；每个 metric_fact 有 evidence_refs——M3 报告不含 metric_fact，该子句恒真，且报告的 `limitations` SHALL 自动追加一条含"无指标 artifact"的说明。关联 RunJob 处于 `failed` 或 `cancelled`、其 RunRecord 的 `status` 为 `failed`（含 `exit_class` 为 `cancelled` 或 `lost`），或其收集已耗尽（运行目录存在 `collect-error.json` 且 `attempts` ≥ core `MAX_COLLECT_ATTEMPTS`）时，谓词 SHALL 不成立，错误子句 SHALL 点名该 `job_id` 与原因；卡片保持原状态（通常为 `running`）。M3 没有 TaskCard 取消工具：PI 可对仍在运行的作业使用 `job_kill`，或保留该卡。谓词不成立时 `report_generate` SHALL 返回指出未满足子句的工具错误，SHALL NOT 写报告文件，SHALL NOT 改变 TaskCard（reconcile 的回写除外）。系统 SHALL NOT 以 LLM 判断作为 closure 依据。

#### Scenario: predicate satisfied
- **WHEN** TaskCard 处于 `running`，其唯一关联作业已 `collected` 且 RunRecord 的 `stack_id`/`data_id` 非空，`report_generate` 提供 observations、limitations、pi_questions 各一条
- **THEN** 报告生成成功，TaskCard 变为 `reporting`，报告 `limitations` 含"无指标 artifact"说明

#### Scenario: uncollected job blocks closure
- **WHEN** TaskCard 的某个关联作业仍为 `running`
- **THEN** `report_generate` 返回错误，指出该作业未 `collected`，不写 `reports/` 文件，TaskCard 保持 `running`

#### Scenario: empty pi_questions blocks closure
- **WHEN** `report_generate` 的 `pi_questions` 为空数组
- **THEN** 工具返回错误，不写报告，TaskCard 不变

#### Scenario: no linked job blocks closure
- **WHEN** 对 `linked_jobs` 为空的 TaskCard 调用 `report_generate`
- **THEN** 工具返回错误，不写报告，TaskCard 不变

#### Scenario: empty model-supplied limitations blocks closure
- **WHEN** `report_generate` 的 `limitations` 为空数组，observations 与 pi_questions 各一条
- **THEN** 工具返回错误（自动追加的"无指标 artifact"说明不满足该子句），不写报告

#### Scenario: failed run blocks closure
- **WHEN** TaskCard 的某个关联作业已 `collected`，其 RunRecord 为 `status: failed`、`exit_class: cvode`
- **THEN** `report_generate` 返回错误并点名该 `job_id` 与失败原因，不写报告，TaskCard 保持 `running`

#### Scenario: exhausted collect blocks closure
- **WHEN** TaskCard 的某个关联作业已终态但收集耗尽（`collect-error.json` 的 `attempts` 为 3）
- **THEN** `report_generate` 返回错误并点名该 `job_id` 与收集耗尽，不写报告，TaskCard 保持 `running`

#### Scenario: null stack reference blocks closure
- **WHEN** 关联作业的 RunRecord `stack_id` 为 `null`（例如 M2 时期提交的运行）
- **THEN** `report_generate` 返回错误，不写报告

### Requirement: TaskCard generated projection
TaskCard 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 TaskCard 段 SHALL 与本 spec 一致，并写明处置：`task_id` 格式由 `TASK-NNNN` 改为品牌格式；`stack_id`/`data_id` 改为品牌 id 或 `null`；`linked_jobs`/`linked_reports` 改为品牌 id 数组。

#### Scenario: drift detected
- **WHEN** 修改 TaskCard 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projection regenerated
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下 TaskCard 投影的 `task_id` 模式拒绝 `TASK-0001`
