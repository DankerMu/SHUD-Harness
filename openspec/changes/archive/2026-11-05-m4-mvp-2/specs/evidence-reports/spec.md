# Spec Delta

## MODIFIED Requirements

### Requirement: EvidenceReport record
EvidenceReport SHALL 含：`report_id`、`task_id`（品牌 `TaskId`）、`status`（`draft|reviewed|awaiting_pi|accepted|revision_requested|rejected|archived`）、`summary`（非空字符串）、`observations`、`limitations`、`pi_questions`（元素为非空字符串的数组）、`linked_runs`（`RUN-YYYYMMDDTHHMMSS-xxxx` 格式的 `run_id` 非空数组）、`stack_ids`（品牌 `StackId` 的非空去重数组）、`data_ids`（品牌 `DataId` 的非空去重数组）、`llm_response_models`（非空字符串的非空去重数组）、`change_ids`（品牌 `ChangeId` 的去重数组，可为空）、`verification_ids`（品牌 `VerificationId` 的去重数组，可为空）、`decision_history`（PiGateDecision 数组）、`created_at`、`updated_at`。`stack_ids`、`data_ids`、`llm_response_models` SHALL 在生成时从每个关联 RunRecord 的 `stack_id`、`data_id`、`llm.response_model` 去重解析（多运行可含多个 lock），SHALL NOT 取自模型参数。`change_ids`、`verification_ids` SHALL 在生成时按卡片顺序取自 closure 求值所用新鲜 TaskCard 的 `linked_changes`、`linked_verifications`（含未批准的 ChangeRequest 与 `failed` 的 VerificationCase），SHALL NOT 取自模型参数；`science_assist` 卡生成的报告两者为 `[]`。缺少这两个键的既有报告文件 SHALL 按 `[]` 解析（schema `default([])`），读取时 SHALL NOT 为补写这两个键而改写文件。

#### Scenario: valid draft report
- **WHEN** 解析 `status: draft`、`decision_history: []`、`stack_ids`/`data_ids` 各含一个品牌 id、`llm_response_models: ["deepseek-flash-guan"]` 的 EvidenceReport
- **THEN** 解析成功

#### Scenario: multi-run report keeps every lock
- **WHEN** 报告关联两个运行，其 RunRecord 的 `stack_id` 不同、`data_id` 不同、`llm.response_model` 相同
- **THEN** `stack_ids` 与 `data_ids` 各含两个 id，`llm_response_models` 只含一个值

#### Scenario: empty or invalid references rejected
- **WHEN** 解析 `stack_ids: []`、`linked_runs: []`、`data_ids` 含 `null` 或重复 id、`llm_response_models` 含空字符串，或 `observations` 含空字符串，或 `status: pi_reviewed` 的 EvidenceReport
- **THEN** schema 解析失败

#### Scenario: M3 report without change references parses
- **WHEN** 解析一份不含 `change_ids` 与 `verification_ids` 键、其余字段合法的 M3 EvidenceReport
- **THEN** 解析成功，两者均为 `[]`，原文件字节不变

#### Scenario: code_change report carries change references
- **WHEN** 对 `linked_changes` 为 `[CHG-A, CHG-B]`、`linked_verifications` 为 `[VC-A]` 的 `code_change` 卡成功生成报告
- **THEN** 报告 `.json` 的 `change_ids` 为 `[CHG-A, CHG-B]`、`verification_ids` 为 `[VC-A]`，与 `report_generate` 参数无关

#### Scenario: invalid change references rejected
- **WHEN** 解析 `change_ids` 含重复 id 或 `CHG-0001`，或 `verification_ids` 含 `null` 的 EvidenceReport
- **THEN** schema 解析失败

### Requirement: report_generate
`report_generate` SHALL 接受 `task_id`、非空 `summary`、`observations`、`limitations`、`pi_questions` 字符串数组，未知参数使调用失败。首先 SHALL 无副作用读取并校验 TaskCard 身份、`running|planned|reporting` 状态及 `type`（`science_assist` 或 `code_change`；其它 `type` 没有 closure 谓词，SHALL 返回指出卡片 `type` 的工具错误），再完成所有 authored 字段的品牌引用存在性校验；这些拒绝 SHALL NOT 创建目录、修改卡片或发起收集。随后取得 listRunJobsByTask，并在新鲜同步卡片读取/身份/状态校验边界内执行唯一 reconcile，仅有变化时发布；成功对账独立提交，后续失败 SHALL NOT 撤销。

closure SHALL 在 reconcile 后求值：`science_assist` 卡求 task-cards「science_assist closure predicate」，`code_change` 卡求 task-cards「code_change closure predicate」；后者读取 `changes/`、`patches/`、`verifications/` 中被卡片引用的对象时 SHALL 遵循 task-cards「TaskCard workspace file」的工作区文件安全规则，无副作用（不创建目录、不写文件），对象缺失、损坏、不安全或文件内 id 不符时谓词不成立。仅已 collected 的关联作业经 collectShud(id, {readonly:true}) 显式只读模式取得已有 RunRecord；其它状态直接作为未收集失败，SHALL NOT 隐式发起收集。只读模式复用规范索引、身份与记录校验，缺失/损坏/不安全/身份不符时拒绝，SHALL NOT 生成记录、失败记账、投影状态、完成回执或通知；原 collectShud 默认行为不变（PI issuecomment6523542892）。收集失败次数 SHALL 另经 jobs 拥有的只读入口复用规范 collect-error.json 解析，即使存在有效成功 RunRecord 仍读取保留的 ledger；真正缺失为0，损坏/不安全/不可读记录明确失败，耗尽次数仍阻断 closure，不重置或绕过。异步证据取得后 SHALL 重读卡片并据其新鲜 linked_jobs 求 closure，缺乏新链接证据时拒绝而非丢弃链接、自动重试或使用旧卡片；`code_change` 卡同样据新鲜卡片的 `linked_changes`、`linked_verifications` 求值。谓词不成立时 SHALL 返回点名未满足子句的工具错误。

成功时 SHALL 写新 draft JSON，随后同步重读/校验/转换 TaskCard 为 reporting 并追加 report_id，最后安全渲染发布 Markdown。linked_runs 按卡片 linked_jobs 顺序来自规范 RunRecord；stack_ids、data_ids、llm_response_models 按首次出现去重；change_ids、verification_ids 按「EvidenceReport record」取自同一新鲜卡片；模型文本保持原样，limitations 末尾追加规范“无指标 artifact”说明。结果返回 report_id 与 status draft。closure 或后续生成失败不写新报告链接，不回滚已提交的初始对账；已有报告 JSON/Markdown（包括只有 Markdown 的 id 碰撞）SHALL NOT 被新分配覆盖（M3 既有规则，M4 不改报告的首次写入方式）。

#### Scenario: rejected citation precedes stale-card reconciliation
- **WHEN** 卡片缺少已索引作业链接，而 summary 含无法解析的品牌引用
- **THEN** 返回该引用错误，卡片字节/mtime 与目录清单不变，不先修复旧作业链接

#### Scenario: later closure failure retains reconciliation
- **WHEN** 初始对账恢复旧作业链接成功，但该作业尚未 collected 或已耗尽收集
- **THEN** 不生成报告，保留已提交的对账，不自动 collect 未收集作业、不撤销链接

#### Scenario: draft generated
- **WHEN** 对 `running`、唯一关联作业已 `collected` 的 TaskCard 调用 `report_generate`，提供 summary 及 observations、limitations、pi_questions 各一条
- **THEN** 工具结果含 `REPORT-…` 格式的 `report_id` 与 `status: draft`，`reports/` 下出现该 id 的 `.json` 与 `.md`，TaskCard 为 `reporting`

#### Scenario: unknown task rejected
- **WHEN** 以会话 cwd 下不存在 `tasks/<task_id>/task.json` 的 `task_id` 调用 `report_generate`
- **THEN** 工具返回错误结果，`reports/` 下不新增文件

#### Scenario: terminal card rejected
- **WHEN** 对 `status: done` 或 `cancelled` 的 TaskCard 调用 `report_generate`
- **THEN** 工具返回指出卡片当前状态的错误，`reports/` 下不新增文件，`task.json` 字节不变

#### Scenario: code_change draft generated
- **WHEN** 对 `running` 的 `code_change` 卡调用 `report_generate`，其 `linked_changes` 含一个 `approved` 且 patch sha256 匹配的 ChangeRequest，`linked_verifications` 含一个该 CR 的 `passed` VerificationCase（`reviewer_notes`、`reviewed_by` 非空），两个关联作业均已 `collected`
- **THEN** 工具结果含 `report_id` 与 `status: draft`，报告 `.json` 的 `change_ids`、`verification_ids` 与卡片链接一致，TaskCard 为 `reporting`

#### Scenario: failed verification does not block closure
- **WHEN** 上一场景中唯一的 VerificationCase 为 `status: failed`
- **THEN** 报告照常生成为 `draft`，该 VC 出现在 `verification_ids` 中

#### Scenario: code_change closure failure names the clause
- **WHEN** `code_change` 卡的 `linked_changes` 只含 `proposed` 的 ChangeRequest，或其 approved CR 的 `patches/<change_id>.patch` sha256 不等于 `patch_sha256`，或没有引用该 approved CR 的 VerificationCase
- **THEN** 工具返回点名未满足子句的错误，`reports/` 下不新增文件，卡片除 reconcile 回写外不变

#### Scenario: card type without closure predicate rejected
- **WHEN** 对 `type: engineering` 的 `running` 卡调用 `report_generate`
- **THEN** 工具返回指出卡片 `type` 的错误，`reports/` 下不新增文件，`task.json` 字节不变

### Requirement: Citation existence check
`report_generate` SHALL 在任何文件或目录写入及 TaskCard reconcile 之前，扫描 summary、observations、limitations、pi_questions 中独立的 TASK-/STACK-/DATA-/RUN-/JOB-/REPORT-/CHG-/VC-/BUILD- 加 YYYYMMDDTHHMMSS-xxxx 品牌令牌，并经 core schema 验证捕获的 id。TASK/STACK/DATA/REPORT SHALL 解析到会话 cwd 下已有、安全、schema 合法且文件内 id 匹配的对应对象；CHG/VC/BUILD SHALL 同样解析到会话 cwd 下已有、安全、schema 合法且文件内 id 匹配的 `changes/<change_id>.json`、`verifications/<vc_id>.json`、`builds/<build_id>/build-record.json`；RUN/JOB SHALL 解析到 shud-jobs 活动/完成索引条目。重复令牌可复用本次读取，不解析 DEC 或嵌在更长标识符中的子串。读取 SHALL NOT 创建缺失目录；任一令牌无法解析则返回指出该令牌的工具错误，不写 draft、不改卡片、不自动重试。

#### Scenario: resolvable citations accepted
- **WHEN** `observations` 引用本任务已 collect 的 `run_id` 与已有的 `stack_id`
- **THEN** 引用校验通过，报告正常生成

#### Scenario: fabricated citation rejected
- **WHEN** `summary` 含 `RUN-20991231T235959-ffff`，而两份索引都没有该 id
- **THEN** 工具返回错误结果并指出 `RUN-20991231T235959-ffff`，`reports/` 下不新增文件，TaskCard 保持 `running`

#### Scenario: change, verification and build citations resolved
- **WHEN** `observations` 引用已有且合法的 `CHG-…`、`VC-…` 与 `BUILD-…`
- **THEN** 引用校验通过，报告正常生成

#### Scenario: fabricated change citation rejected
- **WHEN** `summary` 含 `CHG-20991231T235959-ffff`，会话 cwd 下没有 `changes/CHG-20991231T235959-ffff.json`；或 `limitations` 含的 `BUILD-…` 只有目录而无 `build-record.json`
- **THEN** 工具返回错误结果并指出该令牌，`reports/` 下不新增文件，不创建 `changes/` 或 `builds/`，TaskCard 不变

### Requirement: Deterministic facts table
报告 `.md` SHALL 含由对象确定性生成、不取自模型参数的事实表：`stack_ids` 中每个 StackLock 的 `SHUD`、`rSHUD`、`AutoSHUD` 三仓库各自的 `commit`、`branch`、`dirty`，`dirty` 为真的仓库另列其 `dirty_paths` 作为 dirty 标注行，该 StackLock 的 `build_id` 非 `null` 时另列其 `build_id` 行（为 `null` 时不渲染该行），以及该 StackLock `llm` 的 `base_url`、`request_alias`、`response_model`；每个关联 RunRecord 逐 run 列出其 `run_id`、`stack_id`、`data_id`、`exit_code`、`exit_class`、`status`、`resources.wall_seconds`、`llm.response_model` 及 `llm.response_model_source`，产物清单 `artifacts.files` 的条数与 `size_bytes` 总和，以及 `stdout`/`stderr` 的路径。报告 `change_ids` 非空时，事实表 SHALL 在 §3 含 ChangeRequest 段，按 `change_ids` 顺序逐个列出 `changes/<change_id>.json` 的 `change_id`、`base_commit`、`semantic_level`、`semantic_floor`、`risk`、`files_changed`（逐条）、`floor_categories`（逐项）、`patch_path` 与 `patch_sha256`、`status`、`approval_ref`（为 `null` 时如实列出）；`verification_ids` 非空时 SHALL 在 §3 含 VerificationCase 段，按 `verification_ids` 顺序逐个列出 `verifications/<vc_id>.json` 的 `vc_id`、`case_type`、`expected_result_source`、`pass_criteria`、`base_run_id`、`candidate_run_id`、`base_build_id`、`candidate_build_id`、`observed.base_sha256`、`observed.candidate_sha256`、`status`、`failure_reason`、`reviewed_by`、`compatibility_verdict` 与逐条 `reviewer_notes`；`verification_ids` 非空时 §3 另 SHALL 含 BuildRecord 段，按 `verification_ids` 顺序、对每个 VerificationCase 依次以其 `base_build_id`、`candidate_build_id` 读取 `builds/<build_id>/build-record.json`，逐个列出 `build_id`、`change_id`（base 构建为 `null`，如实列出）、`source_commit`、`rhs_openmp`、`make_argv`（逐项）、`compiler`、`patch_sha256`（base 构建为 `null`，如实列出）与 `binary_sha256`（字段契约见 shud-build「BuildRecord record」），SHALL NOT 内联 `make.stdout.log`/`make.stderr.log` 内容。两者均为空的报告（`science_assist`）SHALL NOT 渲染这三段。因此关联 StackLock 的 `build_id` 均为 `null` 且 `change_ids`、`verification_ids` 均为空（无 build）的报告，其 `.md` 渲染字节 SHALL 与 M3 渲染器对同一报告与引用对象的输出相同。ChangeRequest、VerificationCase 与 BuildRecord 读取 SHALL 遵循工作区文件安全规则并经 schema 与文件内 id 校验，缺失或损坏时渲染失败（同「Report workspace files」对缺失引用文件的处理）；事实表 SHALL NOT 内联 patch 内容。多运行时 SHALL 逐 run 列出，不作跨运行比较；多个 ChangeRequest 或 VerificationCase 时 SHALL 逐个列出，不作跨对象比较或判定。`.md` SHALL NOT 内联日志或产物文件的内容，SHALL NOT 含密钥材料。

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

#### Scenario: change and verification facts from objects
- **WHEN** 报告 `change_ids` 含一个 `semantic_level: numerical_implementation`、`semantic_floor: numerical_implementation`、`risk: high`、`status: approved` 的 ChangeRequest，`verification_ids` 含一个 `status: passed` 的 VerificationCase，其 `reviewer_notes` 有两条
- **THEN** `.md` §3 的 ChangeRequest 段列出这些值、`floor_categories` 各项、`files_changed` 各路径、`patch_path` 与 `patch_sha256`；VerificationCase 段列出两个 run id、两个 build id、两个 sha256、`status: passed` 与两条 `reviewer_notes`；`.md` 不含 patch 内容

#### Scenario: build facts from objects
- **WHEN** 报告 `verification_ids` 含一个 VerificationCase，其 base BuildRecord 为 `change_id: null`、`rhs_openmp: false`、`patch_sha256: null`，候选 BuildRecord 为 `change_id` 等于报告中 approved CR、`rhs_openmp: true`、`make_argv` 含 `SHUD_ENABLE_OPENMP_RHS=1`、`patch_sha256` 等于该 CR 的 `patch_sha256`
- **THEN** `.md` §3 的 BuildRecord 段先列 base 再列候选，两者各自的 `build_id`、`change_id`、`source_commit`、`rhs_openmp`、`make_argv` 各项、`compiler`、`patch_sha256` 与 `binary_sha256` 与对应 `build-record.json` 的值逐一相同，base 的 `change_id` 与 `patch_sha256` 列为 `null`；`.md` 不含 `make.stdout.log` 的任何一行内容

#### Scenario: every linked change is listed
- **WHEN** 报告 `change_ids` 含一个 `proposed`（被拒后保留）与一个 `approved` 的 ChangeRequest
- **THEN** ChangeRequest 段分别列出两者及各自 `status`，`proposed` 者的 `approval_ref` 为 `null`

#### Scenario: StackLock build_id listed per lock
- **WHEN** 报告关联 base 与 candidate 两个运行，其 StackLock 的 `build_id` 分别为两个不同的 `BUILD-…`
- **THEN** 事实表在两个 StackLock 下分别列出各自的 `build_id`

#### Scenario: science_assist report has no change sections
- **WHEN** 生成一份 `science_assist` 报告，其 StackLock `build_id` 为 `null`
- **THEN** `.md` 不含 ChangeRequest 段、VerificationCase 段、BuildRecord 段与 `build_id` 行

#### Scenario: report without builds renders M3 bytes
- **WHEN** 以 M3 首任务形态的报告夹具（单运行、StackLock `build_id: null`、无 `change_ids` 与 `verification_ids` 键）渲染 `.md`
- **THEN** 输出与 M3 渲染器对同一夹具的输出逐字节相同

#### Scenario: verification facts are independent of change references
- **WHEN** a report has empty change_ids and nonempty verification_ids, and two cited VCs share a build
- **THEN** each VC and its base-then-candidate build facts appear in declared order, including repeated build displays, while §5 retains the old no-metrics sentence

#### Scenario: unsafe or invalid fact records do not produce a partial report
- **WHEN** a cited ChangeRequest, VerificationCase or BuildRecord is missing, malformed, schema-invalid, has a mismatched embedded id or is a symlink target
- **THEN** rendering fails through the readonly file-layer boundary without creating managed directories, returning partial Markdown or changing any input bytes

#### Scenario: new structured facts participate in existing canonical validation
- **WHEN** a schema-valid new fact contains a secret-shaped token and the canonical report is rendered for the existing thirteen-check validator
- **THEN** the existing whole-document secret check rejects it with controlled diagnostics; this rendering integration does not add checks 14/15 or cross-object validation

### Requirement: Report template
报告 `.md` SHALL 以 `# EvidenceReport: <title>` 开头，并按序包含以下 10 个二级标题：`## 1. 摘要`、`## 2. 任务与问题`、`## 3. StackLock 与数据来源`、`## 4. 运行记录`、`## 5. 指标与图表`、`## 6. 观测与解释限制`、`## 7. 风险和失败项`、`## 8. 需要 PI 判断的问题`、`## 9. 建议下一步`、`## 10. 附录：命令、日志、artifact manifest`。§5 对 `science_assist` 报告 SHALL 固定写"本里程碑无指标 artifact，见 limitations"，对 `code_change` 报告（`change_ids` 非空）SHALL 逐字渲染「code_change report wording constant」的固定句；§3 对 `code_change` 报告另含「Deterministic facts table」的 ChangeRequest 段与 VerificationCase 段（`verification_ids` 非空时另含 BuildRecord 段）；§6 SHALL 在模型提供的 observations 与 limitations 之后，由模板（而非报告 `.json` 的 `limitations` 字段）逐字渲染 core `GOVERNANCE_INVARIANTS` 的四句不变式，每句一行；§7 SHALL 列出每个 `status` 不为 `succeeded` 的关联运行（closure 谓词已排除失败运行，M3 首任务中该节为空列表，渲染器仍覆盖该分支），并另列 `verification_ids` 中每个 `status: failed` 的 VerificationCase 的 `vc_id` 与 `failure_reason`（VerificationCase 规范要求 failed 不能从报告中消失）；§10 SHALL 列出各运行的 argv、日志路径与产物清单。`.md` SHALL 含参数提供的 `summary`、`observations`、`limitations`、`pi_questions` 原文。

#### Scenario: ten sections rendered
- **WHEN** 生成一份只关联一个成功运行的报告
- **THEN** `.md` 按序含上述 10 个标题，§5 为固定的无指标说明，§6 逐字含四句治理不变式，§7 不列任何运行，报告 `.json` 的 `limitations` 不含这四句

#### Scenario: failed run listed
- **WHEN** 以关联 RunRecord 为 `status: failed`、`exit_class: cvode` 的夹具调用渲染器
- **THEN** §7 列出该运行的 `run_id` 与 `exit_class`

#### Scenario: code_change report sections
- **WHEN** 生成一份关联 base 与 candidate 两个成功运行、一个 approved ChangeRequest 与一个 `passed` VerificationCase 的 `code_change` 报告
- **THEN** `.md` 按序含上述 10 个标题，§3 含 ChangeRequest 段、VerificationCase 段与 BuildRecord 段，§5 恰为「code_change report wording constant」的固定句而非 "本里程碑无指标 artifact，见 limitations"，§6 逐字含四句治理不变式，§7 不列任何运行或 VerificationCase

#### Scenario: failed verification listed
- **WHEN** 以 `verification_ids` 含一个 `status: failed`（`failure_reason` 为两 sha 不等）与一个 `status: passed` 的 VerificationCase 的夹具调用渲染器
- **THEN** §7 列出 failed 者的 `vc_id` 与其 `failure_reason`，不列出 passed 者

### Requirement: report_validate
`report_validate` SHALL 接受参数 `report_id`（未知参数使调用失败），是 `draft` → `reviewed` 的唯一入口，并逐项执行以下 15 项确定性检查：(1) `stack_ids` 中每个 id 解析到 `stacks/<stack_id>.json` 且其 `stack_id` 一致；(2) `data_ids` 中每个 id 解析到 `provenance/<data_id>.json`；(3) 每个 `linked_runs` 有 RunRecord；(4) 指标来自确定性 artifact；(5) `limitations` 非空；(6) `pi_questions` 非空；(7) 禁止用语扫描（模型撰写的 `summary`、`observations`、`limitations`、`pi_questions`）无命中；(8) 失败运行及 `verification_ids` 中每个 `status: failed` 的 VerificationCase 已在 §7 列出；(9) 每个 dirty 仓库在 `.md` 中有 dirty 标注行；(10) 每个关键指标有 source_ref；(11) 每个图表观察有 figure/timeseries artifact ref；(12) `GOVERNANCE_INVARIANTS` 四句在 `.md` 中逐字出现，缺任一句即失败；(13) 整份 `.md` 不匹配 `REPORT_SECRET_PATTERN`；(14) `change_ids` 非空的报告，其 `.md` §5 逐字含「code_change report wording constant」的固定句，`change_ids` 为空时该项恒为通过并在结果中标注为不适用；(15) `verification_ids` 中每个 VerificationCase（经工作区文件安全规则、schema 与文件内 id 校验读取）的 `artifact_refs` 两项均解析为会话 cwd 下的普通文件（路径各级组件与目标以 `lstat` 确认，符号链接、目录或特殊文件即失败，不跟随链接），且第一项、第二项内容的 sha256 分别等于该 VerificationCase 的 `observed.base_sha256`、`observed.candidate_sha256`，文件缺失、不安全、不可读或 sha256 不等即失败并指出该 `vc_id` 与路径；`verification_ids` 为空时该项恒为通过并在结果中标注为不适用。第 (8)、(9)、(12)、(13)、(14) 项 SHALL 作用于由当前 `.json` 与其引用文件确定性渲染出的 `.md` 内容。第 (4)、(10)、(11) 项在 M3 SHALL 以"无指标、无图表"恒为通过，并在结果中明确标注为恒真项。`docs/03_SPEC/Report_Generation_Spec.md` 的 (D) 项"report 没有引用 tmp 路径"在 M3 SHALL NOT 实现：会话工作区与运行目录可以位于 `$TMPDIR` 下，报告中的这类路径是合法事实。工具结果 SHALL 列出全部 15 项各自的结果。任一项失败时报告 SHALL 保持 `draft`、文件不变，结果列出失败项（禁止用语失败时列出命中短语与字段，密钥形态失败时只指出所在节、不回显匹配内容）；全部通过时 SHALL 按「Report write order and repair」写入 `status: reviewed` 并重新渲染 `.md`。

#### Scenario: all checks pass
- **WHEN** 对一份 StackLock、DataProvenance、RunRecord 齐全且无禁止用语的 `draft` 报告调用 `report_validate`
- **THEN** 工具结果列出 15 项均通过，其中第 (4)、(10)、(11) 项标注为 M3 恒真，`science_assist` 报告的第 (14)、(15) 项标注为不适用，报告变为 `reviewed`

#### Scenario: forbidden phrase keeps draft
- **WHEN** 报告 `limitations` 含"校准证明结构正确"时调用 `report_validate`
- **THEN** 工具结果中第 (7) 项失败并列出 `校准证明结构正确` 与 `limitations`，报告保持 draft 且 JSON 字节不变；相对于成功入口修复后的基准不再写 Markdown 或卡片

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
- **THEN** 15 项均通过，报告变为 `reviewed`

#### Scenario: missing code_change fixed sentence keeps draft
- **WHEN** `code_change` 报告渲染出的 `.md` §5 缺少或改写了「code_change report wording constant」的固定句（如模板被改动后）时调用 `report_validate`
- **THEN** 第 (14) 项失败，报告保持 `draft`

#### Scenario: failed verification missing from section 7 keeps draft
- **WHEN** 报告 `verification_ids` 含一个 `status: failed` 的 VerificationCase，而渲染出的 `.md` §7 未列出其 `vc_id`（如模板被改动后）时调用 `report_validate`
- **THEN** 第 (8) 项失败并指出该 `vc_id`，报告保持 `draft`

#### Scenario: verification artifact missing or changed keeps draft
- **WHEN** 报告 `verification_ids` 含一个 VerificationCase，其 `artifact_refs` 中候选 rivqdown 文件在 `verification_run` 之后被删除、被替换为符号链接，或被改写一个字节使 sha256 不等于 `observed.candidate_sha256` 时调用 `report_validate`
- **THEN** 第 (15) 项失败并指出该 `vc_id` 与该路径，报告保持 `draft`，`.json`、`.md` 与该 rivqdown 路径上的文件字节不变

#### Scenario: artifact diagnostics preserve identity without disclosing secret matches
- **WHEN** 第 (15) 项失败的 schema-valid 相对 artifact 路径含一个或多个 `REPORT_SECRET_PATTERN` 命中，或会话 cwd 本身含此类内容
- **THEN** 诊断保留 `vc_id`、artifact 下标与相对路径的非密钥部分，替换全部命中内容，不回显解析后的绝对路径或底层异常；无命中的相对路径保持原文，第 (13) 项仍只指出所在节

#### Scenario: unrelated reference failure does not suppress artifact validation
- **WHEN** 一份 schema-valid 报告的 StackLock 或 DataProvenance 引用不可用，同时其关联 VC 的候选 artifact 已被改写
- **THEN** 结果仍列出全部 15 项，第 (15) 项独立检查该 VC 并指出其 artifact 失败，报告保持 draft，校验不写文件

#### Scenario: verification artifacts intact pass item 15
- **WHEN** `code_change` 报告的每个 VerificationCase 的两个 `artifact_refs` 均为会话 cwd 下的普通文件、sha256 分别等于 `observed.base_sha256` 与 `observed.candidate_sha256`，其余条件齐全时调用 `report_validate`
- **THEN** 第 (15) 项通过（不标注为不适用），15 项均通过，报告变为 `reviewed`

### Requirement: EvidenceReport generated projection
EvidenceReport 与 PiGateDecision 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 EvidenceReport 段 SHALL 与本 spec 一致，并写明 id 格式由 `REPORT-NNNN` 改为品牌格式、`linked_runs` 改为非空品牌 id 数组、新增 `stack_ids`、`data_ids`、`llm_response_models`、`decision_history`、`updated_at`，以及 `change_ids`（品牌 `ChangeId` 去重数组）与 `verification_ids`（品牌 `VerificationId` 去重数组）——二者可为空、缺失时按 `[]` 解析且 M3 报告文件不改写；报告字段名为 `verification_ids`，与 `Theory_to_Code` 文档的 `verification_case_ids` 命名差异 SHALL 在该段注明。该文件既有的 PiGateDecision 段 SHALL 被改写（不另增一段）为本 spec 的 `{decision_id, report_id, approval_ref, outcome, comment, decided_at}`，并逐项写明处置：保留 `decision_id`；删除 `gate_id`、`task_id`、`actor_user_id`、`actor_role`、`comment_required`、`next_action`、`evidence_refs`（approval_ref 仅保存本次执行 callId，经 session log 的 asked.callId → asked.id → decided.id 关联审批证据，不直接承载 gate/actor；task 经 `report_id` → TaskCard `linked_reports` 关联）；新增 `report_id`、`approval_ref`；`decision: approved|rejected|request_revision` 改为 `outcome: accepted|rejected|revision_requested`；`comment?` 改为必填且当且仅当 `accepted` 为 `null`；`created_at` 改为 `decided_at`；A01-2 枚举映射删除。字段权威源 `docs/03_SPEC/Support_Schema_Contracts.md` §6 SHALL 同刀改写为同一字段集（其 `idempotency_key` 一并删除），Minimal_Schemas 的投影声明继续指向它。

#### Scenario: drift detected
- **WHEN** 修改 EvidenceReport 或 PiGateDecision 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projections registered
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 EvidenceReport 与 PiGateDecision 的 Markdown 与 JSON Schema 投影

#### Scenario: change reference fields projected
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下 EvidenceReport 投影含 `change_ids` 与 `verification_ids` 两个数组字段，元素模式分别拒绝 `CHG-0001` 与 `VC-0001`

#### Scenario: change reference drift detected
- **WHEN** 在 EvidenceReport 的 Zod schema 中增删或改名 `change_ids`、`verification_ids` 而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

## ADDED Requirements

### Requirement: code_change report wording constant
core `governance/wording.ts` SHALL 导出一个字符串常量，其值恰为：`本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。`。报告模板 SHALL 在 `code_change` 报告的 §5 逐字渲染该常量作为该节全文，`report_validate` 第 (14) 项检查其逐字出现；该常量 SHALL NOT 写入报告 `.json` 的 `limitations` 或其它字段，SHALL NOT 可经 profile 配置覆写或放宽，修改只能经代码变更与审查。模型撰写的 `summary`、`observations`、`limitations`、`pi_questions` SHALL NOT 改写、替换或删去该句：它们按原文渲染在各自节中，与 §5 的固定句互不影响。该常量与 `GOVERNANCE_INVARIANTS` 同为模板渲染文本，SHALL NOT 作为扫描短语参与禁止用语检查（扫描只覆盖模型撰写的四个字段）。`science_assist` 报告的 §5 SHALL NOT 渲染该常量。

#### Scenario: fixed sentence rendered verbatim
- **WHEN** 生成一份 `code_change` 报告
- **THEN** `.md` 的 §5 正文与该常量逐字节相同，报告 `.json` 的任何字段都不含该句

#### Scenario: model text cannot alter the fixed sentence
- **WHEN** 生成 `code_change` 报告时 `limitations` 参数含"bitwise 一致证明并行实现正确"，`summary` 含该常量的改写版本
- **THEN** §5 仍逐字为该常量，模型文本原样出现在 §1 与 §6，§5 不含模型文本

#### Scenario: science_assist section 5 unchanged
- **WHEN** 生成一份 `science_assist` 报告
- **THEN** §5 为"本里程碑无指标 artifact，见 limitations"，`.md` 不含该常量

#### Scenario: constant is not a scan phrase
- **WHEN** 报告 `observations` 含该常量全文
- **THEN** 禁止用语扫描无命中（该句不含任何禁止短语，且模板渲染文本本就不在扫描范围）
