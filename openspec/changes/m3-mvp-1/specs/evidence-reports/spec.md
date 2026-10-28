# Spec Delta

## Purpose
定义 EvidenceReport（由 RunRecord 等对象确定性填充的 Markdown 证据报告）与 PiGateDecision（PI 对报告的审批决定记录）的品牌 id、字段、7 态状态机、模板与水印、禁止用语常量、确定性 validator，以及 `report_generate`、`report_validate`、`report_submit`、`report_decide` 四个工具的契约，使报告终态只能由 PI 审批卡放行后写入。

## ADDED Requirements

### Requirement: Report and decision identifiers
系统 SHALL 为每份 EvidenceReport 分配 `report_id`，格式为 `REPORT-YYYYMMDDTHHMMSS-xxxx`；为每条 PiGateDecision 分配 `decision_id`，格式为 `DEC-YYYYMMDDTHHMMSS-xxxx`。时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数，随机段独立生成。schema SHALL 拒绝不符合格式的 id（包括 `REPORT-0001`、`DECISION-001`）。新分配的 `report_id` 在会话 cwd 下已存在 `reports/<report_id>.json` 时 SHALL 重新生成。

#### Scenario: branded report and decision ids
- **WHEN** 在 UTC 2026-10-27 09:00:00 生成报告，并于 09:30:12 记录一条审批决定
- **THEN** `report_id` 形如 `REPORT-20261027T090000-5b10`，`decision_id` 形如 `DEC-20261027T093012-c4e7`

#### Scenario: legacy ids rejected
- **WHEN** 以 `report_id: "REPORT-0001"` 解析 EvidenceReport，或以 `decision_id: "DECISION-001"` 解析 PiGateDecision
- **THEN** schema 解析失败并指出 id 字段

### Requirement: EvidenceReport record
EvidenceReport SHALL 含：`report_id`、`task_id`（品牌 `TaskId`）、`status`（`draft|reviewed|awaiting_pi|accepted|revision_requested|rejected|archived`）、`summary`（非空字符串）、`observations`、`limitations`、`pi_questions`（元素为非空字符串的数组）、`linked_runs`（`RUN-YYYYMMDDTHHMMSS-xxxx` 格式的 `run_id` 非空数组）、`stack_ids`（品牌 `StackId` 的非空去重数组）、`data_ids`（品牌 `DataId` 的非空去重数组）、`llm_response_models`（非空字符串的非空去重数组）、`decision_history`（PiGateDecision 数组）、`created_at`、`updated_at`。`stack_ids`、`data_ids`、`llm_response_models` SHALL 在生成时从每个关联 RunRecord 的 `stack_id`、`data_id`、`llm.response_model` 去重解析（多运行可含多个 lock），SHALL NOT 取自模型参数。

#### Scenario: valid draft report
- **WHEN** 解析 `status: draft`、`decision_history: []`、`stack_ids`/`data_ids` 各含一个品牌 id、`llm_response_models: ["deepseek-flash-guan"]` 的 EvidenceReport
- **THEN** 解析成功

#### Scenario: multi-run report keeps every lock
- **WHEN** 报告关联两个运行，其 RunRecord 的 `stack_id` 不同、`data_id` 不同、`llm.response_model` 相同
- **THEN** `stack_ids` 与 `data_ids` 各含两个 id，`llm_response_models` 只含一个值

#### Scenario: empty or invalid references rejected
- **WHEN** 解析 `stack_ids: []`、`linked_runs: []`、`data_ids` 含 `null` 或重复 id、`llm_response_models` 含空字符串，或 `observations` 含空字符串，或 `status: pi_reviewed` 的 EvidenceReport
- **THEN** schema 解析失败

### Requirement: PiGateDecision record
PiGateDecision SHALL 为严格对象，恰含：`decision_id`、`report_id`（品牌 `ReportId`）、`approval_ref`（授权写入本条终态的那张审批卡的 `approval/asked.id`；工具执行上下文取不到时为该次工具调用的 `callId`；非空字符串）、`outcome`（`accepted|rejected|revision_requested`）、`comment`、`decided_at`（ISO 8601 UTC）。`comment` SHALL 当且仅当 `outcome` 为 `accepted` 时为 `null`；`outcome` 为 `rejected` 或 `revision_requested` 时 schema SHALL 要求 `comment` 为非空字符串。PiGateDecision SHALL NOT 含先前被拒 `report_submit` 审批卡的引用字段：审批 id 只出现在 session log 中，模型没有来源；被拒提交卡与本条决定的审计关联经 session log 中两张卡 `reason` 携带的同一 `report_id` 完成（见 policy-gate「PI comment conversation carrier」）。未知字段 SHALL 使解析失败。

#### Scenario: accepted without comment
- **WHEN** 解析 `outcome: accepted`、`comment: null`、`approval_ref` 非空的 PiGateDecision
- **THEN** 解析成功

#### Scenario: rejection requires comment
- **WHEN** 解析 `outcome: revision_requested` 或 `outcome: rejected`，且 `comment` 为 `null` 或空字符串的 PiGateDecision
- **THEN** schema 解析失败并指出 `comment` 字段

#### Scenario: accepted with a comment rejected
- **WHEN** 解析 `outcome: accepted`、`comment: "ok"` 的 PiGateDecision
- **THEN** schema 解析失败并指出 `comment` 字段

#### Scenario: removed rejected-card field rejected
- **WHEN** 在其它方面合法的 PiGateDecision 上加入已删除的字段 `rejected_approval_ref`
- **THEN** schema 解析失败（多余字段）

### Requirement: Report status machine
报告状态 SHALL 只经以下入口改变：`report_generate` 创建新的 `draft` 报告（每次调用一份新报告，见「Report regeneration」）；`report_validate` 全部检查通过时 `draft` → `reviewed`；`report_submit` 在审批 `allowed-once` 后执行时 `reviewed` → `accepted`；`report_decide` 在审批 `allowed-once` 后执行时 `reviewed` → `rejected` 或 `revision_requested`。终态 `accepted`、`rejected`、`revision_requested` SHALL 只在审批卡 `allowed-once` 分支写入；系统 SHALL NOT 提供不经审批卡写入终态的工具路径。终态 SHALL NOT 被覆盖。`awaiting_pi` SHALL 保留在枚举与水印表中，但在 M3 只是审批卡挂起期间的瞬时态：审批结果在工具执行之前决定，因此 M3 SHALL NOT 把 `awaiting_pi` 写入报告文件；审批卡未放行时报告 SHALL 停在 `reviewed`。M3 SHALL NOT 提供进入 `archived` 的入口（该状态保留在枚举中并参与水印渲染）。在不满足前置状态的报告上调用上述工具 SHALL 返回工具错误，报告文件 SHALL 保持不变。

#### Scenario: happy path to accepted
- **WHEN** 依次对同一报告调用 `report_generate`、`report_validate`（通过）、`report_submit`（PI 选 Allow once）
- **THEN** `reports/<report_id>.json` 的 `status` 依次为 `draft`、`reviewed`、`accepted`，任何时刻都不写入审批挂起态

#### Scenario: rejected submit card leaves report reviewed
- **WHEN** 对 `reviewed` 报告调用 `report_submit`，PI 在审批卡拒绝
- **THEN** 报告 `status` 仍为 `reviewed`，关联 TaskCard 仍为 `reporting`，两者文件字节不变

#### Scenario: wrong precondition rejected
- **WHEN** 对 `status: draft` 的报告调用 `report_submit` 并获放行，或对 `status: reviewed` 的报告再次调用 `report_validate`
- **THEN** 工具返回错误结果，`reports/<report_id>.json` 与 `.md` 的字节不变

### Requirement: Report workspace files
EvidenceReport SHALL 持久化为会话 cwd 下的 `reports/<report_id>.json`（报告对象，含 `decision_history`）与 `reports/<report_id>.md`（确定性渲染的 Markdown），两者均以同目录临时文件加 rename 原子写入，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；目录与文件的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则。`.md` 的渲染输入 SHALL 恰为报告 `.json` 与其引用的 StackLock（`stacks/<stack_id>.json`）、DataProvenance（`provenance/<data_id>.json`）与 RunRecord 文件；每次渲染（含重渲染）SHALL 重新读取这些文件，任一引用文件缺失或未通过 schema 校验时渲染 SHALL 失败并返回指出该文件的错误，报告 `.json` SHALL 保持不变。每次状态变化（生成、validate 通过、accepted、rejected、revision_requested）SHALL 刷新 `updated_at` 并重新渲染 `.md`；相同的渲染输入 SHALL 渲染出相同的 `.md`。读取 SHALL 经 core schema 校验，损坏文件 SHALL 报错且 SHALL NOT 被改写。

#### Scenario: markdown re-rendered on status change
- **WHEN** 报告从 `draft` 经 `report_validate` 变为 `reviewed`
- **THEN** `reports/<report_id>.json` 的 `status` 为 `reviewed`，`reports/<report_id>.md` 被重新写入且与由该 `.json` 渲染的结果逐字节相同

#### Scenario: corrupt report fails closed
- **WHEN** `reports/<report_id>.json` 不是合法 JSON 时调用 `report_validate`
- **THEN** 工具返回错误结果，`.json` 与 `.md` 的字节不变

#### Scenario: missing referenced file fails the render
- **WHEN** 报告引用的某个 `stacks/<stack_id>.json` 已被删除后需要重渲染 `.md`
- **THEN** 渲染返回指出该文件的错误，报告 `.json` 的字节不变

#### Scenario: symlinked reports directory fails closed
- **WHEN** 会话 cwd 下的 `reports` 是指向其它目录的符号链接时调用 `report_generate`
- **THEN** 工具返回错误结果，链接目标内不新增文件，TaskCard 不变

### Requirement: Report write order and repair
`report_generate`、`report_validate`、`report_submit`、`report_decide` SHALL 共用同一写入顺序：(1) 原子写报告 `.json`——这是提交点，报告的 `status` 与 `decision_history` 以它为准；(2) TaskCard 转换（task-cards 状态机，读取—校验—转换—写入之间不 await 的同步边界；`report_validate` 不改 TaskCard，跳过此步）；(3) 渲染并原子写 `.md`。`report_generate` SHALL 只在 closure 谓词与引用存在性校验都通过之后执行第 (1) 步。第 (1) 步之前的失败 SHALL NOT 写任何文件；第 (1) 步之后任一步失败时，工具 SHALL 返回指出失败步骤（`task_card` 或 `render`）与 `report_id` 的工具错误，SHALL NOT 回滚已写的 `.json` 或卡片。报告工具 SHALL 恰有两种修复，且只在下一次以该 `report_id` 调用四个报告工具中任一个时、于该调用自身的前置条件检查之前执行：(a) 卡片尚未取得报告状态所蕴含的转换时补做该转换——`draft`/`reviewed` 蕴含 `reporting` 且 `linked_reports` 含该 `report_id`，`accepted` 蕴含 `done`，`revision_requested` 蕴含 `planned`，`rejected` 蕴含 `cancelled`；"尚未取得"指该 `report_id` 不在 `linked_reports` 中（补做为追加该 id 并转为 `reporting`），或它是 `linked_reports` 的最后一项而卡片 `status` 不等于蕴含状态；对 `linked_reports` 中较早的报告 SHALL NOT 改动卡片；(b) `.md` 缺失，或其标题下第一行与报告 `status` 应有的水印行不符时，重渲染 `.md`。除此之外报告工具 SHALL NOT 有其它对账行为；卡片与作业之间的对账只由 task-cards「TaskCard reconcile」承担。

#### Scenario: card write failure after the commit point
- **WHEN** `report_submit` 获放行执行，`.json` 已写为 `accepted`，而 TaskCard 写入失败
- **THEN** 工具返回指出 `task_card` 步骤与该 `report_id` 的错误；`.json` 保持 `accepted` 且 `decision_history` 含该条决定，TaskCard 仍为 `reporting`

#### Scenario: next report call repairs the card transition
- **WHEN** 上一场景之后以同一 `report_id` 调用 `report_validate`
- **THEN** 调用开头先把 TaskCard 由 `reporting` 转为 `done`；随后 `report_validate` 因报告不是 `draft` 返回前置条件错误，`.json` 字节不变

#### Scenario: render failure is repaired by the next call
- **WHEN** `report_validate` 已把 `.json` 写为 `reviewed` 而 `.md` 渲染失败，事后引用文件恢复，再以同一 `report_id` 调用 `report_submit` 并获放行
- **THEN** 调用开头不改卡片；若 `.md` 缺失或首部水印行不符则先重渲染；随后按 `report_submit` 正常执行，最终 `.md` 首行为 `Accepted by PI · <decided_at> · <decision_id>`

#### Scenario: older report does not move the card
- **WHEN** 报告 A 为 `revision_requested`，随后同卡的 `report_generate` 生成报告 B 使卡为 `reporting`，再以 A 的 `report_id` 调用 `report_validate`
- **THEN** 卡片仍为 `reporting`，`report_validate` 因 A 不是 `draft` 返回前置条件错误

### Requirement: Report regeneration
每次成功的 `report_generate` SHALL 分配新的 `report_id`，写新的 `reports/<report_id>.json` 与 `.md`，并把它追加到 TaskCard 的 `linked_reports`；同一卡片先前报告的 `.json` 与 `.md` SHALL 保持原字节与修改时间。`report_validate` 失败的 `draft` 报告 SHALL 保持 `draft`；coordinator 可修正输入后对同一卡片再次调用 `report_generate`（得到新 `report_id`，卡片处于 `reporting` 时仍为 `reporting`），或就此搁置该报告。`report_validate` 与 `report_submit` SHALL 只作用于参数给出的 `report_id`，只有 `reviewed` 报告可被提交。`report_decide(revision_requested)` 使卡片回到 `planned` 后：PI 要求重跑时 coordinator 派 worker 以该 `task_id` 调用 `shud_run`（`planned` → `running`）；不要求重跑时可直接从 `planned` 调用 `report_generate`，既有已收集运行仍使 closure 谓词成立。新旧报告之间的延续关系（是否继承 `decision_history`、是否标记被取代）在 M3 不定义：新报告的 `decision_history` 为空，旧报告不被改写。

#### Scenario: regenerate after a failed validate
- **WHEN** 报告 A 的 `report_validate` 因禁止用语失败（A 仍为 `draft`，卡片为 `reporting`），coordinator 改写 observations 后对同卡调用 `report_generate`
- **THEN** 得到不同于 A 的新 `report_id` B，`reports/` 下新增 B 的 `.json` 与 `.md`，A 的两个文件字节与修改时间不变，卡片 `linked_reports` 依次含 A 与 B，卡片仍为 `reporting`

#### Scenario: report after revision without a re-run
- **WHEN** 卡片因 `report_decide(revision_requested)` 回到 `planned`，其已有关联作业均已 `collected`，coordinator 直接调用 `report_generate`
- **THEN** 新报告以 `draft` 生成，卡片由 `planned` 变为 `reporting`，先前报告文件不变

### Requirement: report_generate
`report_generate` SHALL 接受参数：`task_id`、`summary`（非空字符串）、`observations`、`limitations`、`pi_questions`（字符串数组）；未知参数 SHALL 使调用失败。调用 SHALL 读取 TaskCard，先执行 task-cards「TaskCard reconcile」，再求 task-cards 的 closure 谓词，并经与 `shud_collect` 相同的后端收集接口读取每个关联作业的 RunRecord。卡片前态 SHALL 为 `running`、`planned` 或 `reporting`。成功时 SHALL 按「Report write order and repair」的顺序写入 `status: draft` 的新报告：`reports/<report_id>.json`，随后 TaskCard 变为 `reporting` 且 `linked_reports` 追加该 `report_id`，最后渲染 `.md`；`linked_runs` 为关联 RunRecord 的 `run_id`，`stack_ids`、`data_ids`、`llm_response_models` 为从这些 RunRecord 去重解析的值，`limitations` 在参数之后追加含"无指标 artifact"的说明，工具结果返回 `report_id` 与 `status: draft`。closure 谓词不成立、TaskCard 不存在或不可读、或卡片处于上述三态之外时 SHALL 返回工具错误，SHALL NOT 写报告文件，SHALL NOT 改变 TaskCard（reconcile 的回写除外，见 task-cards）。

#### Scenario: draft generated
- **WHEN** 对 `running`、唯一关联作业已 `collected` 的 TaskCard 调用 `report_generate`，提供 summary 及 observations、limitations、pi_questions 各一条
- **THEN** 工具结果含 `REPORT-…` 格式的 `report_id` 与 `status: draft`，`reports/` 下出现该 id 的 `.json` 与 `.md`，TaskCard 为 `reporting`

#### Scenario: unknown task rejected
- **WHEN** 以会话 cwd 下不存在 `tasks/<task_id>/task.json` 的 `task_id` 调用 `report_generate`
- **THEN** 工具返回错误结果，`reports/` 下不新增文件

#### Scenario: terminal card rejected
- **WHEN** 对 `status: done` 或 `cancelled` 的 TaskCard 调用 `report_generate`
- **THEN** 工具返回指出卡片当前状态的错误，`reports/` 下不新增文件，`task.json` 字节不变

### Requirement: Citation existence check
`report_generate` SHALL 在写任何文件之前，扫描 `summary`、`observations`、`limitations`、`pi_questions` 中每个形如 `TASK-`、`STACK-`、`DATA-`、`RUN-`、`JOB-`、`REPORT-` 前缀加 `YYYYMMDDTHHMMSS-xxxx` 的品牌 id 令牌，并要求其解析到会话 cwd 下已有的对象文件（`tasks/<id>/task.json`、`stacks/<id>.json`、`provenance/<id>.json`、`reports/<id>.json`）或 shud-jobs 活动/完成索引中的条目（`RUN-`/`JOB-`）。任一令牌无法解析时 SHALL 返回指出该令牌的工具错误，SHALL NOT 写 draft，SHALL NOT 改变 TaskCard，SHALL NOT 自动重试。

#### Scenario: resolvable citations accepted
- **WHEN** `observations` 引用本任务已 collect 的 `run_id` 与已有的 `stack_id`
- **THEN** 引用校验通过，报告正常生成

#### Scenario: fabricated citation rejected
- **WHEN** `summary` 含 `RUN-20991231T235959-ffff`，而两份索引都没有该 id
- **THEN** 工具返回错误结果并指出 `RUN-20991231T235959-ffff`，`reports/` 下不新增文件，TaskCard 保持 `running`

### Requirement: Deterministic facts table
报告 `.md` SHALL 含由对象确定性生成、不取自模型参数的事实表：`stack_ids` 中每个 StackLock 的 `SHUD`、`rSHUD`、`AutoSHUD` 三仓库各自的 `commit`、`branch`、`dirty`，`dirty` 为真的仓库另列其 `dirty_paths` 作为 dirty 标注行，以及该 StackLock `llm` 的 `base_url`、`request_alias`、`response_model`；每个关联 RunRecord 逐 run 列出其 `run_id`、`stack_id`、`data_id`、`exit_code`、`exit_class`、`status`、`resources.wall_seconds`、`llm.response_model` 及 `llm.response_model_source`，产物清单 `artifacts.files` 的条数与 `size_bytes` 总和，以及 `stdout`/`stderr` 的路径。多运行时 SHALL 逐 run 列出，不作跨运行比较。`.md` SHALL NOT 内联日志或产物文件的内容，SHALL NOT 含密钥材料。

#### Scenario: facts from objects
- **WHEN** 关联 RunRecord 为 `exit_code: 0`、`exit_class: ok`、`llm.response_model: deepseek-flash-guan`、`llm.response_model_source: configured`，`artifacts.files` 共 12 项、合计 40960 字节
- **THEN** `.md` 事实表列出这些值、`12` 与 `40960`，以及 StackLock 三仓库的 commit/branch/dirty 和 llm 三字段

#### Scenario: multi-run facts listed per run
- **WHEN** 报告关联两个 `stack_id` 不同的运行
- **THEN** 事实表分别列出两个运行各自的 `stack_id`、`data_id`、`llm.response_model`，并列出两个 StackLock 各自的三仓库与 llm 字段

#### Scenario: dirty stack annotated
- **WHEN** StackLock 中 `SHUD` 的 `dirty: true`、`dirty_paths: ["src/Model/shud.cpp"]`
- **THEN** `.md` 含该仓库的 dirty 标注行并列出 `src/Model/shud.cpp`

#### Scenario: logs not inlined
- **WHEN** 关联运行的 `stdout.log` 含若干行求解器输出
- **THEN** `.md` 只含 `stdout.log` 的路径，不含其中任何一行内容

### Requirement: Report template
报告 `.md` SHALL 以 `# EvidenceReport: <title>` 开头，并按序包含以下 10 个二级标题：`## 1. 摘要`、`## 2. 任务与问题`、`## 3. StackLock 与数据来源`、`## 4. 运行记录`、`## 5. 指标与图表`、`## 6. 观测与解释限制`、`## 7. 风险和失败项`、`## 8. 需要 PI 判断的问题`、`## 9. 建议下一步`、`## 10. 附录：命令、日志、artifact manifest`。§5 SHALL 固定写"本里程碑无指标 artifact，见 limitations"；§6 SHALL 在模型提供的 observations 与 limitations 之后，由模板（而非报告 `.json` 的 `limitations` 字段）逐字渲染 core `GOVERNANCE_INVARIANTS` 的四句不变式，每句一行；§7 SHALL 列出每个 `status` 不为 `succeeded` 的关联运行（closure 谓词已排除失败运行，M3 首任务中该节为空列表，渲染器仍覆盖该分支）；§10 SHALL 列出各运行的 argv、日志路径与产物清单。`.md` SHALL 含参数提供的 `summary`、`observations`、`limitations`、`pi_questions` 原文。

#### Scenario: ten sections rendered
- **WHEN** 生成一份只关联一个成功运行的报告
- **THEN** `.md` 按序含上述 10 个标题，§5 为固定的无指标说明，§6 逐字含四句治理不变式，§7 不列任何运行，报告 `.json` 的 `limitations` 不含这四句

#### Scenario: failed run listed
- **WHEN** 以关联 RunRecord 为 `status: failed`、`exit_class: cvode` 的夹具调用渲染器
- **THEN** §7 列出该运行的 `run_id` 与 `exit_class`

### Requirement: Report watermark
报告 `.md` SHALL 按 `status` 在标题下第一行与文末最后一行渲染正文水印（SHALL NOT 仅以样式或注释承载）：

| status                               | 文件内可见标记                                                       |
| ------------------------------------ | -------------------------------------------------------------------- |
| `draft` / `reviewed` / `awaiting_pi` | `DRAFT — not accepted by PI`                                         |
| `accepted`                           | 无水印；标题下首行为 `Accepted by PI · <decided_at> · <decision_id>` |
| `revision_requested`                 | `REVISION REQUESTED — not accepted by PI`                            |
| `rejected`                           | `REJECTED — not accepted by PI`                                      |
| `archived`                           | 按归档前终态显示对应标记，另加 `ARCHIVED`                            |

`accepted` 行的 `<decided_at>` 与 `<decision_id>` SHALL 取自 `decision_history` 中 `outcome: accepted` 的那条记录。渲染 SHALL 覆盖全部 7 态。

#### Scenario: draft watermark
- **WHEN** 渲染 `status: reviewed` 的报告
- **THEN** 标题下第一行与文末最后一行均为 `DRAFT — not accepted by PI`

#### Scenario: accepted header
- **WHEN** 渲染 `status: accepted`、`decision_history` 含 `decision_id: DEC-20261027T093012-c4e7`、`decided_at: 2026-10-27T09:30:12Z` 的报告
- **THEN** 标题下首行为 `Accepted by PI · 2026-10-27T09:30:12Z · DEC-20261027T093012-c4e7`，全文不含 `not accepted by PI`

#### Scenario: archived inherits terminal marker
- **WHEN** 渲染归档前终态为 `rejected` 的 `archived` 报告
- **THEN** 水印含 `REJECTED — not accepted by PI` 与 `ARCHIVED`，不含 `Accepted by PI`

### Requirement: Forbidden report phrases
禁止用语清单 SHALL 是 core 导出的常量，恰为以下 10 条（`docs/03_SPEC/Report_Generation_Spec.md` §5 与 §5.1 原文）：`模型机制已验证`、`普遍改进`、`校准证明结构正确`、`该参数就是真实物理原因`、`无需 PI 审查`、`校准证明模型结构正确`、`verification 通过说明物理机制真实`、`该公式已经被模型结果证明`、`参数搜索确认了理论假设`、`无需 PI 审查即可接受该物理变更`。清单 SHALL NOT 可经 profile 配置覆写或放宽。扫描 SHALL 对报告的 `summary`、`observations`、`limitations`、`pi_questions` 做子串匹配，并对每个命中报告短语与所在字段。该检查只是枚举短语的确定性 lint，通过它 SHALL NOT 被表述为措辞合规的充分条件。core `governance/wording.ts` 另 SHALL 导出 `GOVERNANCE_INVARIANTS`，恰为四句治理不变式文案：`单流域/单事件指标提升不等于模型改进`、`校准结果不等于结构验证`、`不得宣称模型机制已验证`、`不得宣称普遍改进`；它们由报告模板在 §6 逐字渲染、由 `report_validate` 第 (12) 项检查其逐字出现、由 preset 指令引用，SHALL NOT 作为扫描短语参与禁止用语检查（扫描只覆盖模型撰写的四个字段，模板渲染的不变式不在其中）。同一模块 SHALL 在禁止用语旁导出密钥形态正则常量 `REPORT_SECRET_PATTERN`，即 `/\bsk-[A-Za-z0-9_-]{8,}/`，供 `report_validate` 第 (13) 项使用。门禁措辞"措辞过四条不变式"的机器判据 SHALL 恰为：四句不变式在 `.md` 中逐字出现，且模型撰写的四个字段无禁止用语命中；语义层面的合规不做机器检查，仍由 PI 审阅。

#### Scenario: phrase hit reported with field
- **WHEN** 报告 `observations` 含"该结果表明普遍改进"
- **THEN** 扫描结果命中短语 `普遍改进`，字段为 `observations`

#### Scenario: overlapping phrases both reported
- **WHEN** `summary` 含"无需 PI 审查即可接受该物理变更"
- **THEN** 扫描结果同时命中 `无需 PI 审查` 与 `无需 PI 审查即可接受该物理变更`，字段均为 `summary`

#### Scenario: invariants are not scan phrases
- **WHEN** 报告 `observations` 含"校准结果不等于结构验证"
- **THEN** 扫描无命中（不变式常量不参与扫描）

#### Scenario: recommended wording passes
- **WHEN** 四个字段只含"在该 basin/event/window 下该指标改善"与"该解释需要 PI 结合水文背景判断"
- **THEN** 扫描无命中

### Requirement: report_validate
`report_validate` SHALL 接受参数 `report_id`（未知参数使调用失败），是 `draft` → `reviewed` 的唯一入口，并逐项执行以下 13 项确定性检查：(1) `stack_ids` 中每个 id 解析到 `stacks/<stack_id>.json` 且其 `stack_id` 一致；(2) `data_ids` 中每个 id 解析到 `provenance/<data_id>.json`；(3) 每个 `linked_runs` 有 RunRecord；(4) 指标来自确定性 artifact；(5) `limitations` 非空；(6) `pi_questions` 非空；(7) 禁止用语扫描（模型撰写的 `summary`、`observations`、`limitations`、`pi_questions`）无命中；(8) 失败运行已在 §7 列出；(9) 每个 dirty 仓库在 `.md` 中有 dirty 标注行；(10) 每个关键指标有 source_ref；(11) 每个图表观察有 figure/timeseries artifact ref；(12) `GOVERNANCE_INVARIANTS` 四句在 `.md` 中逐字出现，缺任一句即失败；(13) 整份 `.md` 不匹配 `REPORT_SECRET_PATTERN`。第 (8)、(9)、(12)、(13) 项 SHALL 作用于由当前 `.json` 与其引用文件确定性渲染出的 `.md` 内容。第 (4)、(10)、(11) 项在 M3 SHALL 以"无指标、无图表"恒为通过，并在结果中明确标注为恒真项。`docs/03_SPEC/Report_Generation_Spec.md` 的 (D) 项"report 没有引用 tmp 路径"在 M3 SHALL NOT 实现：会话工作区与运行目录可以位于 `$TMPDIR` 下，报告中的这类路径是合法事实。工具结果 SHALL 列出全部 13 项各自的结果。任一项失败时报告 SHALL 保持 `draft`、文件不变，结果列出失败项（禁止用语失败时列出命中短语与字段，密钥形态失败时只指出所在节、不回显匹配内容）；全部通过时 SHALL 按「Report write order and repair」写入 `status: reviewed` 并重新渲染 `.md`。

#### Scenario: all checks pass
- **WHEN** 对一份 StackLock、DataProvenance、RunRecord 齐全且无禁止用语的 `draft` 报告调用 `report_validate`
- **THEN** 工具结果列出 13 项均通过，其中第 (4)、(10)、(11) 项标注为 M3 恒真，报告变为 `reviewed`

#### Scenario: forbidden phrase keeps draft
- **WHEN** 报告 `limitations` 含"校准证明结构正确"时调用 `report_validate`
- **THEN** 工具结果中第 (7) 项失败并列出 `校准证明结构正确` 与 `limitations`，报告保持 `draft`，`.json` 与 `.md` 字节不变

#### Scenario: missing provenance keeps draft
- **WHEN** 报告 `data_ids` 中某个 id 的 `provenance/<data_id>.json` 已不存在时调用 `report_validate`
- **THEN** 第 (2) 项失败，报告保持 `draft`

#### Scenario: missing invariant keeps draft
- **WHEN** 渲染出的 `.md` 缺少四句治理不变式中的任一句（如模板被改动后）时调用 `report_validate`
- **THEN** 第 (12) 项失败并指出缺失的那一句，报告保持 `draft`

#### Scenario: secret-shaped token keeps draft
- **WHEN** 报告 `observations` 含 `sk-abcdefgh12345678` 时调用 `report_validate`
- **THEN** 第 (13) 项失败，工具结果不含该令牌原文，报告保持 `draft`，`.json` 与 `.md` 字节不变

#### Scenario: workspace under TMPDIR is not a failure
- **WHEN** 会话工作区位于 `$TMPDIR` 下，关联运行的 `stdout` 路径因而位于 `$TMPDIR` 下，其余条件齐全时调用 `report_validate`
- **THEN** 13 项均通过，报告变为 `reviewed`

### Requirement: report_submit
`report_submit` SHALL 接受参数 `report_id`（未知参数使调用失败）。每次未被角色规则拒绝的调用 SHALL 先经 PI 审批卡（policy-gate 返回 ask），卡片 `reason` 含 `report_id`，卡片说明 SHALL 含 `report_id`、`summary` 首行与报告 `.md` 文件路径。审批结果为 `allowed-once` 时工具执行：报告须处于 `reviewed`，否则返回工具错误、不写文件；满足时 SHALL 按「Report write order and repair」的顺序，先在 `.json` 中向 `decision_history` 追加一条 `{decision_id, report_id, approval_ref, outcome: accepted, comment: null, decided_at}`（`approval_ref` 为本次放行的审批卡）并写入 `status: accepted`，再使 TaskCard 由 `reporting` 变为 `done`，最后重新渲染 `.md`（含 accepted 首行）。审批结果为其它任何 outcome（拒绝、取消、无审批服务等）时工具 SHALL NOT 执行，报告 SHALL 保持 `reviewed` 且不新增 `decision_history` 条目，TaskCard SHALL 保持 `reporting`，模型收到说明 PI 未放行的工具错误。

#### Scenario: allow once accepts report
- **WHEN** 对 `reviewed` 报告调用 `report_submit`，PI 在审批卡选 Allow once
- **THEN** 报告 `status` 为 `accepted`，`decision_history` 末条 `outcome` 为 `accepted`、`comment` 为 `null`、`approval_ref` 非空，`.md` 首行为 `Accepted by PI · <decided_at> · <decision_id>`，TaskCard 为 `done`

#### Scenario: denial leaves report reviewed
- **WHEN** 对 `reviewed` 报告调用 `report_submit`，PI 在审批卡拒绝
- **THEN** 工具未执行，模型收到工具错误，报告仍为 `reviewed`，`decision_history` 不变，`.md` 水印仍为 `DRAFT — not accepted by PI`，TaskCard 仍为 `reporting`

#### Scenario: no approval service fails closed
- **WHEN** 宿主没有可用的审批服务时调用 `report_submit`
- **THEN** 工具未执行，报告与 TaskCard 均不变

### Requirement: report_decide
`report_decide` SHALL 恰接受参数 `report_id`、`disposition`（必填，`rejected` 或 `revision_requested`，无缺省值）、`comment`（必填，非空字符串）；`disposition` 缺失或取其它值、`comment` 缺失或为空、或出现未知参数（包括已删除的 `rejected_approval_ref`）时 SHALL 返回工具错误且不写文件。每次未被角色规则拒绝的调用 SHALL 先经 PI 审批卡，卡片 `reason` 含 `report_id`，卡片说明 SHALL 回显 `disposition` 与 `comment` 全文。审批结果为 `allowed-once` 时工具执行：报告须处于 `reviewed`；处于 `accepted` 或其它终态时 SHALL 返回工具错误且不覆盖；满足时 SHALL 按「Report write order and repair」的顺序，先在 `.json` 中向 `decision_history` 追加一条 PiGateDecision（`outcome` 等于 `disposition`，`comment` 为该参数，`approval_ref` 为本次放行的 `report_decide` 审批卡）并写入 `status` 为 `disposition`，再使 TaskCard 由 `reporting` 在 `revision_requested` 时变为 `planned`、在 `rejected` 时变为 `cancelled`，最后重新渲染 `.md` 水印。审批结果为其它任何 outcome 时工具 SHALL NOT 执行，报告与 TaskCard SHALL 保持不变。

#### Scenario: revision requested with comment
- **WHEN** `report_submit` 被拒后，对仍为 `reviewed` 的报告调用 `report_decide`，`disposition: revision_requested`、`comment: "补一个 holdout 窗口"`，PI 在卡片上看到该 comment 并选 Allow once
- **THEN** 报告 `status` 为 `revision_requested`，`decision_history` 末条 `outcome` 为 `revision_requested`、`comment` 为 `补一个 holdout 窗口`、`approval_ref` 为本次 decide 卡，`.md` 水印为 `REVISION REQUESTED — not accepted by PI`，TaskCard 为 `planned`；session log 中该 `report_id` 先有一张非 `allowed-once` 的 `report_submit` 卡

#### Scenario: rejection cancels the task
- **WHEN** 对 `reviewed` 报告以 `disposition: rejected` 与非空 comment 调用 `report_decide` 并获 Allow once
- **THEN** 报告 `status` 为 `rejected`，水印为 `REJECTED — not accepted by PI`，TaskCard 为 `cancelled`

#### Scenario: accepted report cannot be overridden
- **WHEN** 对 `accepted` 报告调用 `report_decide` 并获 Allow once
- **THEN** 工具返回错误结果，报告仍为 `accepted`，`decision_history` 与 `.md` 不变

#### Scenario: invalid decide arguments rejected
- **WHEN** 以 `comment: ""`、`disposition: accepted`、省略 `disposition`，或额外传入 `rejected_approval_ref` 调用 `report_decide`
- **THEN** 工具返回错误结果，报告不变

#### Scenario: PI does not confirm the relayed comment
- **WHEN** PI 在回显 comment 的审批卡上拒绝
- **THEN** 工具未执行，报告保持 `reviewed`，不新增 `decision_history` 条目

### Requirement: EvidenceReport generated projection
EvidenceReport 与 PiGateDecision 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 EvidenceReport 段 SHALL 与本 spec 一致，并写明 id 格式由 `REPORT-NNNN` 改为品牌格式、`linked_runs` 改为非空品牌 id 数组、新增 `stack_ids`、`data_ids`、`llm_response_models`、`decision_history`、`updated_at`。该文件既有的 PiGateDecision 段 SHALL 被改写（不另增一段）为本 spec 的 `{decision_id, report_id, approval_ref, outcome, comment, decided_at}`，并逐项写明处置：保留 `decision_id`；删除 `gate_id`、`task_id`、`actor_user_id`、`actor_role`、`comment_required`、`next_action`、`evidence_refs`（gate 与 actor 由审批卡引用 `approval_ref` 承载，task 经 `report_id` → TaskCard `linked_reports` 关联）；新增 `report_id`、`approval_ref`；`decision: approved|rejected|request_revision` 改为 `outcome: accepted|rejected|revision_requested`；`comment?` 改为必填且当且仅当 `accepted` 为 `null`；`created_at` 改为 `decided_at`；A01-2 枚举映射删除。字段权威源 `docs/03_SPEC/Support_Schema_Contracts.md` §6 SHALL 同刀改写为同一字段集（其 `idempotency_key` 一并删除），Minimal_Schemas 的投影声明继续指向它。

#### Scenario: drift detected
- **WHEN** 修改 EvidenceReport 或 PiGateDecision 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projections registered
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 EvidenceReport 与 PiGateDecision 的 Markdown 与 JSON Schema 投影
