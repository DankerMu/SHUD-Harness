# Spec Delta

## MODIFIED Requirements

### Requirement: EvidenceReport record
EvidenceReport SHALL 含：`report_id`、`task_id`（品牌 `TaskId`）、`status`（`draft|reviewed|awaiting_pi|accepted|revision_requested|rejected|archived`）、`summary`（非空字符串）、`observations`、`limitations`、`pi_questions`（元素为非空字符串的数组）、`linked_runs`（`RUN-YYYYMMDDTHHMMSS-xxxx` 格式的 `run_id` 非空数组）、`stack_ids`（品牌 `StackId` 的非空去重数组）、`data_ids`（品牌 `DataId` 的非空去重数组）、`llm_response_models`（非空字符串的非空去重数组）、`change_ids`（品牌 `ChangeId` 的去重数组，可为空）、`verification_ids`（品牌 `VerificationId` 的去重数组，可为空）、`analysis_ids`（品牌 `AnalysisPlanId` 的去重数组，可为空）、`sensitivity_summary`（`{path, sha256}` 或 `null`）、`decision_history`（PiGateDecision 数组）、`created_at`、`updated_at`。`stack_ids`、`data_ids`、`llm_response_models` SHALL 在生成时从每个关联 RunRecord 的 `stack_id`、`data_id`、`llm.response_model` 去重解析（多运行可含多个 lock），SHALL NOT 取自模型参数。`change_ids`、`verification_ids` SHALL 在生成时按卡片顺序取自 closure 求值所用新鲜 TaskCard 的 `linked_changes`、`linked_verifications`（含未批准的 ChangeRequest 与 `failed` 的 VerificationCase），SHALL NOT 取自模型参数；`science_assist` 卡生成的报告两者为 `[]`。缺少这两个键的既有报告文件 SHALL 按 `[]` 解析（schema `default([])`），读取时 SHALL NOT 为补写这两个键而改写文件。`analysis_ids` SHALL 在生成时取自 closure 求值所用新鲜 TaskCard 的 `linked_analyses`，SHALL NOT 取自模型参数；非 `sensitivity` 卡生成的报告为 `[]`。`sensitivity_summary` SHALL 由 `report_generate` 写入：`sensitivity` 报告为 `{path: "reports/<report_id>.sensitivity.json", sha256: <该文件字节的 sha256>}`（见「Sensitivity summary derivation」），其它报告为 `null`；SHALL 有 refine：`analysis_ids` 非空 ⇔ `sensitivity_summary` 非 `null`，且 `path` 中的 id 等于本报告 `report_id`。缺少 `analysis_ids` 或 `sensitivity_summary` 键的既有报告文件 SHALL 分别按 `[]` 与 `null` 解析，读取时 SHALL NOT 为补写而改写文件。

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

#### Scenario: M4 report without analysis references parses
- **WHEN** 解析一份不含 `analysis_ids` 与 `sensitivity_summary` 键、其余字段合法的 M3 或 M4 EvidenceReport
- **THEN** 解析成功，`analysis_ids` 为 `[]`、`sensitivity_summary` 为 `null`，原文件字节不变

#### Scenario: sensitivity report carries plan and summary references
- **WHEN** 对 `linked_analyses` 为 `[PLAN-A]` 的 `sensitivity` 卡成功生成报告 `R`
- **THEN** 报告 `.json` 的 `analysis_ids` 为 `[PLAN-A]`，`sensitivity_summary.path` 为 `reports/R.sensitivity.json`，其 `sha256` 等于该文件字节的摘要，与 `report_generate` 参数无关

#### Scenario: inconsistent analysis references rejected
- **WHEN** 解析 `analysis_ids` 含 `PLAN-0001` 或重复 id，或 `analysis_ids` 非空而 `sensitivity_summary` 为 `null`，或 `analysis_ids` 为空而 `sensitivity_summary` 非 `null` 的 EvidenceReport
- **THEN** schema 解析失败

### Requirement: Report workspace files
EvidenceReport SHALL 持久化为会话 cwd 下的 `reports/<report_id>.json`（报告对象，含 `decision_history`）与 `reports/<report_id>.md`（确定性渲染的 Markdown），两者均以同目录临时文件加 rename 原子写入，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；目录与文件的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则。`sensitivity` 报告另有 `reports/<report_id>.sensitivity.json`（见「Sensitivity summary derivation」），它在报告 `.json` 提交之后 SHALL NOT 被任何工具改写。`.md` 的渲染输入 SHALL 恰为报告 `.json` 与其引用的 StackLock（`stacks/<stack_id>.json`）、DataProvenance（`provenance/<data_id>.json`）与 RunRecord 文件、每个 `artifacts.metrics_summary` 非 `null` 的关联 RunRecord 所指的 `runs/<run_id>/metrics.json`，以及报告 `sensitivity_summary` 非 `null` 时的 `.sensitivity.json`（ChangeRequest、VerificationCase、BuildRecord 另见「Deterministic facts table」）；每次渲染（含重渲染）SHALL 重新读取这些文件，任一引用文件缺失或未通过 schema 校验时渲染 SHALL 失败并返回指出该文件的错误，报告 `.json` SHALL 保持不变。`metrics.json` 与 `.sensitivity.json` SHALL 按工作区文件安全规则读取（`O_NOFOLLOW`、普通文件、不逃逸），其字节 sha256 SHALL 分别等于 RunRecord `metrics_summary.sha256` 与报告 `sensitivity_summary.sha256`，不等即渲染失败并指出该文件。`metrics_summary` 为 `null` 的运行 SHALL NOT 使渲染失败：其指标单元格渲染为 `not_available`。每次状态变化（生成、validate 通过、accepted、rejected、revision_requested）SHALL 刷新 `updated_at` 并重新渲染 `.md`；相同的渲染输入 SHALL 渲染出相同的 `.md`。读取 SHALL 经 core schema 校验，损坏文件 SHALL 报错且 SHALL NOT 被改写。

#### Scenario: markdown re-rendered on status change
- **WHEN** 报告从 `draft` 经 `report_validate` 变为 `reviewed`
- **THEN** `reports/<report_id>.json` 的 `status` 为 `reviewed`，`reports/<report_id>.md` 被重新写入且与由该 `.json` 渲染的结果逐字节相同

#### Scenario: corrupt report fails closed
- **WHEN** `reports/<report_id>.json` 不是合法 JSON 时调用 `report_validate`
- **THEN** 工具返回错误结果，`.json` 与 `.md` 的字节不变

#### Scenario: missing referenced file fails the render
- **WHEN** 报告引用的某个 `stacks/<stack_id>.json` 已被删除后需要重渲染 `.md`
- **THEN** 渲染返回指出该文件的错误，报告 `.json` 的字节不变

#### Scenario: tampered metrics file fails the render
- **WHEN** 报告关联运行的 `runs/<run_id>/metrics.json` 在报告生成后被改写一个字节，或 `sensitivity` 报告的 `.sensitivity.json` 被删除，随后需要重渲染 `.md`
- **THEN** 渲染返回指出该文件的错误，报告 `.json` 与该文件路径上的字节不变

#### Scenario: run without metrics still renders
- **WHEN** 报告唯一关联运行的 RunRecord `artifacts.metrics_summary` 为 `null`（M5 之前提交的运行）
- **THEN** 渲染成功，该运行的指标单元格为 `not_available`

#### Scenario: symlinked reports directory fails closed
- **WHEN** 会话 cwd 下的 `reports` 是指向其它目录的符号链接时调用 `report_generate`
- **THEN** 工具返回错误结果，链接目标内不新增文件，TaskCard 不变

### Requirement: Report write order and repair
`report_generate`、`report_validate`、`report_submit`、`report_decide` SHALL 共用同一正常写入顺序：(1) 原子写报告 `.json`——这是报告状态提交点，`status` 与 `decision_history` 以它为准；(2) TaskCard 转换（task-cards 状态机，读取—校验—转换—写入之间不 await；`report_validate` 正常路径跳过此步）；(3) 渲染并原子写 `.md`。`report_generate` SHALL 只在 closure 与引用校验通过后执行第 (1) 步。`sensitivity` 报告的 `report_generate` SHALL 在第 (1) 步之前紧接着以不覆盖目标的方式（同目录临时文件写完后排他发布，目标已存在即 EEXIST）写入 `reports/<report_id>.sensitivity.json`，第 (1) 步写入的 `sensitivity_summary.sha256` SHALL 为该文件字节的摘要；该文件写入失败时 SHALL NOT 执行第 (1) 步、SHALL NOT 改卡片，并返回指出 `sensitivity_summary` 步骤的错误；第 (1) 步在该文件写入之后失败时，该文件 SHALL 保留为未被任何报告引用的孤立文件，SHALL NOT 被删除、复用或覆盖。除下述独立提交的初始 TaskCard reconcile/入口修复与该 `.sensitivity.json` 外，第 (1) 步之前的失败 SHALL NOT 写文件；第 (1) 步之后失败 SHALL 返回失败步骤（`task_card` 或 `render`）与 `report_id`，SHALL NOT 回滚已写内容或自动重试。

报告工具 SHALL 恰有两种入口修复，只在下一次以同一 `report_id` 调用工具时、该调用自身的状态前置条件与 validator 之前执行；不接受 report_id 的 `report_generate` 不发现或修复旧报告。(a) 复用规范 repair predicate/mapping：报告未链接，或它是最后一项且卡片状态与报告映射状态不符时，补做链接与转换；已链接的较早报告 SHALL NOT 移动卡片。`draft`/`reviewed` 映射 `reporting`，`accepted` 映射 `done`，`revision_requested` 映射 `planned`，`rejected` 映射 `cancelled`。未链接报告先在内存中补做 reporting 转换，再按已持久化的报告状态补做后续合法转换，最后一次同步发布，SHALL NOT 写出中间态。

修复 SHALL 只复用既有合法 TaskCard 转换；任一所需转换非法时 SHALL 返回 `task_card` 与 `report_id` 的受控错误，卡片字节不变且不继续 Markdown 修复。SHALL NOT 直接赋状态、增加绕过事件或重开 done/cancelled 卡片。`awaiting_pi`/`archived` 不支持工具侧状态投影，SHALL 在写入前拒绝。修复不产生新的 PiGateDecision 或覆盖报告 JSON。

(b) `.md` 真正不存在，或标题下第一行与规范水印不符时，复用规范渲染器重新渲染并安全原子写入；仅 ENOENT 表示不存在，链接/特殊文件/不可读文件 SHALL fail closed。重渲染所需的 `.sensitivity.json` 缺失或 sha256 不符时修复 (b) SHALL 返回 `render` 与 `report_id` 的错误，SHALL NOT 重新派生或改写该文件。SHALL NOT 以正文差异新增修复规则。修复(a)先于(b)；任何修复失败 SHALL 返回其步骤与 report_id，保留先前成功提交。已成功的入口修复独立提交，后续前置条件或 17 项检查失败 SHALL NOT 撤销；本 spec 的失败“文件不变”以成功入口修复之后为基准，报告 JSON 在这些失败中始终不变。卡片与作业之间的对账仍只由「TaskCard reconcile」承担。以上顺序由 PI issuecomment6522484479 明确。

#### Scenario: repair survives a rejected validation
- **WHEN** reviewed 报告的 Markdown 缺失，引用齐全，对它调用 report_validate
- **THEN** 入口补写规范 Markdown，随后因非 draft 拒绝；报告 JSON 字节不变，已补写 Markdown 保留

#### Scenario: old unlinked draft cannot reopen a terminal task
- **WHEN** draft 报告尚未链接，而其任务已 done 或 cancelled，对它调用 report_validate
- **THEN** 返回含 task_card 与 report_id 的错误，卡片与报告文件字节不变，不追加链接、不重新打开任务、不继续 Markdown 修复

#### Scenario: card write failure after the commit point
- **WHEN** `report_submit` 获放行执行，`.json` 已写为 `accepted`，而 TaskCard 写入失败
- **THEN** 工具返回指出 `task_card` 步骤与该 `report_id` 的错误；`.json` 保持 `accepted` 且 `decision_history` 含该条决定，TaskCard 仍为 `reporting`

#### Scenario: next report call repairs the card transition
- **WHEN** 上一场景之后以同一 `report_id` 调用 `report_validate`
- **THEN** 调用开头先把 TaskCard 由 `reporting` 转为 `done`；随后 `report_validate` 因报告不是 `draft` 返回前置条件错误，`.json` 字节不变

#### Scenario: render failure is repaired by the next call
- **WHEN** `report_validate` 已把 `.json` 写为 `reviewed` 而 `.md` 渲染失败，事后引用文件恢复，再以同一 `report_id` 调用 `report_submit` 并获放行
- **THEN** 调用开头不改卡片；若 `.md` 缺失或首部水印行不符则先重渲染；随后按 `report_submit` 正常执行，最终 `.md` 首行为 `Accepted by PI · <decided_at> · <decision_id>`

#### Scenario: sensitivity summary precedes the report commit
- **WHEN** 对 closure 成立的 `sensitivity` 卡调用 `report_generate` 成功
- **THEN** `reports/<report_id>.sensitivity.json` 先于 `reports/<report_id>.json` 存在，报告 `.json` 的 `sensitivity_summary.sha256` 等于该文件字节的摘要

#### Scenario: report commit failure leaves an orphan summary
- **WHEN** `.sensitivity.json` 已写入，而写报告 `.json` 失败
- **THEN** 工具返回错误，`.sensitivity.json` 保留且不被任何报告引用，卡片 `linked_reports` 不含该 `report_id`；后续 `report_generate` 分配新 `report_id`，不覆盖该孤立文件

#### Scenario: older report does not move the card
- **WHEN** 报告 A 为 `revision_requested`，随后同卡的 `report_generate` 生成报告 B 使卡为 `reporting`，再以 A 的 `report_id` 调用 `report_validate`
- **THEN** 卡片仍为 `reporting`，`report_validate` 因 A 不是 `draft` 返回前置条件错误

### Requirement: report_generate
`report_generate` SHALL 接受 `task_id`、非空 `summary`、`observations`、`limitations`、`pi_questions` 字符串数组，未知参数使调用失败。首先 SHALL 无副作用读取并校验 TaskCard 身份、`running|planned|reporting` 状态及 `type`（`science_assist`、`code_change` 或 `sensitivity`；其它 `type` 没有 closure 谓词，SHALL 返回指出卡片 `type` 的工具错误），再完成所有 authored 字段的品牌引用存在性校验；这些拒绝 SHALL NOT 创建目录、修改卡片或发起收集。随后取得 listRunJobsByTask，并在新鲜同步卡片读取/身份/状态校验边界内执行唯一 reconcile，仅有变化时发布；成功对账独立提交，后续失败 SHALL NOT 撤销。

closure SHALL 在 reconcile 后求值：`science_assist` 卡求 task-cards「science_assist closure predicate」，`code_change` 卡求 task-cards「code_change closure predicate」，`sensitivity` 卡求 task-cards「sensitivity closure predicate」（plan 与 `metrics.json` 的读取同样无副作用、遵循工作区文件安全规则）；后者读取 `changes/`、`patches/`、`verifications/` 中被卡片引用的对象时 SHALL 遵循 task-cards「TaskCard workspace file」的工作区文件安全规则，无副作用（不创建目录、不写文件），对象缺失、损坏、不安全或文件内 id 不符时谓词不成立。仅已 collected 的关联作业经 collectShud(id, {readonly:true}) 显式只读模式取得已有 RunRecord；其它状态直接作为未收集失败，SHALL NOT 隐式发起收集；例外是 `sensitivity` 卡：未 collected 的终态作业（RunJob `failed`/`cancelled` 或收集已耗尽）SHALL 以其 RunJob 状态与收集失败次数交给 task-cards「sensitivity closure predicate」判定，SHALL NOT 在谓词之前直接判为未收集失败，同样 SHALL NOT 隐式发起收集。只读模式复用规范索引、身份与记录校验，缺失/损坏/不安全/身份不符时拒绝，SHALL NOT 生成记录、失败记账、投影状态、完成回执或通知；原 collectShud 默认行为不变（PI issuecomment6523542892）。收集失败次数 SHALL 另经 jobs 拥有的只读入口复用规范 collect-error.json 解析，即使存在有效成功 RunRecord 仍读取保留的 ledger；真正缺失为0，损坏/不安全/不可读记录明确失败，耗尽次数仍阻断 closure，不重置或绕过。异步证据取得后 SHALL 重读卡片并据其新鲜 linked_jobs 求 closure，缺乏新链接证据时拒绝而非丢弃链接、自动重试或使用旧卡片；`code_change` 卡同样据新鲜卡片的 `linked_changes`、`linked_verifications` 求值。谓词不成立时 SHALL 返回点名未满足子句的工具错误。

成功时（`sensitivity` 卡先按「Report write order and repair」写 `.sensitivity.json`）SHALL 写新 draft JSON，随后同步重读/校验/转换 TaskCard 为 reporting 并追加 report_id，最后安全渲染发布 Markdown。卡片 linked_jobs 按「TaskCard reconcile」为 `job_id` 码点升序；本 spec 所称"linked_jobs 顺序"均指新鲜卡片的这一顺序，凡按作业或运行列出的条目（`linked_runs`、`superseded_runs`、§7 运行条目）SHALL 统一采用它。linked_runs 按 linked_jobs 顺序来自规范 RunRecord，只含有 RunRecord 的作业（`sensitivity` 卡含已被取代且有 RunRecord 的失败运行），stack_ids、data_ids、llm_response_models 同样只取自这些 RunRecord；stack_ids、data_ids、llm_response_models 按首次出现去重；change_ids、verification_ids、analysis_ids 按「EvidenceReport record」取自同一新鲜卡片；模型文本保持原样，limitations 末尾按「Deterministic report limitations」追加确定性 limitation，SHALL NOT 再追加"无指标 artifact"说明。结果返回 report_id 与 status draft。closure 或后续生成失败不写新报告链接，不回滚已提交的初始对账；已有报告 JSON/Markdown/`.sensitivity.json`（包括只有其中一个文件的 id 碰撞）SHALL NOT 被新分配覆盖：新分配的 `report_id` 对应的这三个文件任一已存在时 SHALL 按「Report and decision identifiers」重新生成 id。

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

#### Scenario: sensitivity draft generated
- **WHEN** 对 `running` 的 `sensitivity` 卡调用 `report_generate`，其唯一 plan 的 4 个 pset 各有一个 succeeded 有效 run，`metrics.json` 均为 `status: ok`
- **THEN** 工具结果含 `report_id` 与 `status: draft`，`reports/` 下出现该 id 的 `.sensitivity.json`、`.json` 与 `.md`，报告 `analysis_ids` 等于卡片 `linked_analyses`，`limitations` 末尾含覆盖声明与"agent 建议值"标注，TaskCard 为 `reporting`

#### Scenario: sensitivity closure failure writes nothing
- **WHEN** `sensitivity` 卡的 baseline 有效 run 为 `status: failed`
- **THEN** 工具返回点名 sensitivity closure 第 3 条子句的错误，`reports/` 下不新增任何文件（含 `.sensitivity.json`），卡片除 reconcile 回写外不变

#### Scenario: no-metrics sentence no longer appended
- **WHEN** 对 `science_assist` 卡成功调用 `report_generate`
- **THEN** 报告 `limitations` 为模型传入条目加上「Deterministic report limitations」派生的条目，不含"无指标 artifact"

#### Scenario: card type without closure predicate rejected
- **WHEN** 对 `type: engineering` 的 `running` 卡调用 `report_generate`
- **THEN** 工具返回指出卡片 `type` 的错误，`reports/` 下不新增文件，`task.json` 字节不变

### Requirement: Citation existence check
`report_generate` SHALL 在任何文件或目录写入及 TaskCard reconcile 之前，扫描 summary、observations、limitations、pi_questions 中独立的 TASK-/STACK-/DATA-/RUN-/JOB-/REPORT-/CHG-/VC-/BUILD-/PLAN- 加 YYYYMMDDTHHMMSS-xxxx 品牌令牌，并经 core schema 验证捕获的 id。TASK/STACK/DATA/REPORT SHALL 解析到会话 cwd 下已有、安全、schema 合法且文件内 id 匹配的对应对象；CHG/VC/BUILD SHALL 同样解析到会话 cwd 下已有、安全、schema 合法且文件内 id 匹配的 `changes/<change_id>.json`、`verifications/<vc_id>.json`、`builds/<build_id>/build-record.json`；PLAN SHALL 同样解析到会话 cwd 下已有、安全、通过 AnalysisPlan schema 且文件内 `analysis_plan_id` 匹配的 `analyses/<analysis_plan_id>.json`；RUN/JOB SHALL 解析到 shud-jobs 活动/完成索引条目。重复令牌可复用本次读取，不解析 DEC 或嵌在更长标识符中的子串。读取 SHALL NOT 创建缺失目录；任一令牌无法解析则返回指出该令牌的工具错误，不写 draft、不改卡片、不自动重试。

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

#### Scenario: plan citation resolved
- **WHEN** `observations` 引用本卡已有且合法的 `PLAN-…`
- **THEN** 引用校验通过，报告正常生成

#### Scenario: fabricated plan citation rejected
- **WHEN** `summary` 含 `PLAN-20991231T235959-ffff`，会话 cwd 下没有 `analyses/PLAN-20991231T235959-ffff.json`，或该文件为符号链接
- **THEN** 工具返回错误结果并指出该令牌，`reports/` 下不新增文件，不创建 `analyses/`，TaskCard 不变

### Requirement: Deterministic facts table
报告 `.md` SHALL 含由对象确定性生成、不取自模型参数的事实表：`stack_ids` 中每个 StackLock 的 `SHUD`、`rSHUD`、`AutoSHUD` 三仓库各自的 `commit`、`branch`、`dirty`，`dirty` 为真的仓库另列其 `dirty_paths` 作为 dirty 标注行，该 StackLock 的 `build_id` 非 `null` 时另列其 `build_id` 行（为 `null` 时不渲染该行），以及该 StackLock `llm` 的 `base_url`、`request_alias`、`response_model`；每个关联 RunRecord 逐 run 列出其 `run_id`、`stack_id`、`data_id`、`exit_code`、`exit_class`、`status`、`resources.wall_seconds`、`llm.response_model` 及 `llm.response_model_source`，产物清单 `artifacts.files` 的条数与 `size_bytes` 总和，以及 `stdout`/`stderr` 的路径。报告 `change_ids` 非空时，事实表 SHALL 在 §3 含 ChangeRequest 段，按 `change_ids` 顺序逐个列出 `changes/<change_id>.json` 的 `change_id`、`base_commit`、`semantic_level`、`semantic_floor`、`risk`、`files_changed`（逐条）、`floor_categories`（逐项）、`patch_path` 与 `patch_sha256`、`status`、`approval_ref`（为 `null` 时如实列出）；`verification_ids` 非空时 SHALL 在 §3 含 VerificationCase 段，按 `verification_ids` 顺序逐个列出 `verifications/<vc_id>.json` 的 `vc_id`、`case_type`、`expected_result_source`、`pass_criteria`、`base_run_id`、`candidate_run_id`、`base_build_id`、`candidate_build_id`、`observed.base_sha256`、`observed.candidate_sha256`、`status`、`failure_reason`、`reviewed_by`、`compatibility_verdict` 与逐条 `reviewer_notes`；`verification_ids` 非空时 §3 另 SHALL 含 BuildRecord 段，按 `verification_ids` 顺序、对每个 VerificationCase 依次以其 `base_build_id`、`candidate_build_id` 读取 `builds/<build_id>/build-record.json`，逐个列出 `build_id`、`change_id`（base 构建为 `null`，如实列出）、`source_commit`、`rhs_openmp`、`make_argv`（逐项）、`compiler`、`patch_sha256`（base 构建为 `null`，如实列出）与 `binary_sha256`（字段契约见 shud-build「BuildRecord record」），SHALL NOT 内联 `make.stdout.log`/`make.stderr.log` 内容。两者均为空的报告（`science_assist`、`sensitivity`）SHALL NOT 渲染这三段。因此关联 StackLock 的 `build_id` 均为 `null` 且 `change_ids`、`verification_ids` 均为空（无 build）的报告，其 `.md` 除 §5 外的渲染字节 SHALL 与 M3 渲染器对同一报告与引用对象的输出相同。

事实表另 SHALL 在 §5 含逐 run 指标段（所有任务类型）：按 `linked_runs` 顺序对每个关联运行列出 `run_id`、`metrics.json` 的 `status`（`metrics_summary` 为 `null` 时为 `not_available`）、`peak_flow_m3d`、`peak_day`、`total_runoff_m3`、`numerical_health` 四项的值，以及 `water_balance_residual`、`cvode_failures`、`negative_state_count` 三项各自的判定（`pass|warn|fail|not_available`；`max_solver_dt` 只渲染其值、不渲染判定），以及作为 source_ref 的 `runs/<run_id>/metrics.json` 路径与 sha256；值为 `null` 的单元格 SHALL 渲染为固定字面量 `null` 并附 `metrics.json` 中的原因。`sensitivity` 报告的 §5 另 SHALL 含 Δ 汇总段，逐行渲染 `.sensitivity.json` 的 `rows`（字段见「Sensitivity summary derivation」）并注明该文件路径与 sha256；指标与 Δ 数值 SHALL 只取自 `metrics.json` 与 `.sensitivity.json`，SHALL NOT 在渲染时重新计算或取自模型参数；每个数值单元格 SHALL 输出与该值在源 JSON 文件中相同的 JS 最短往返数字串（即 `JSON.stringify` 对该数值的输出），SHALL NOT 舍入、截断、补零、改变指数形式或附加千分位与单位后缀；Δ 汇总段中值为 `null` 的单元格同样渲染为固定字面量 `null` 并附 `delta_reasons` 中的原因。渲染 SHALL NOT 输出敏感性指数、排名或任何对差异的解释。ChangeRequest、VerificationCase 与 BuildRecord 读取 SHALL 遵循工作区文件安全规则并经 schema 与文件内 id 校验，缺失或损坏时渲染失败（同「Report workspace files」对缺失引用文件的处理）；事实表 SHALL NOT 内联 patch 内容。多运行时 SHALL 逐 run 列出，不作跨运行比较；多个 ChangeRequest 或 VerificationCase 时 SHALL 逐个列出，不作跨对象比较或判定。`.md` SHALL NOT 内联日志或产物文件的内容，SHALL NOT 含密钥材料。

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
- **WHEN** 以 M3 首任务形态的报告夹具（单运行、StackLock `build_id: null`、无 `change_ids`、`verification_ids`、`analysis_ids` 与 `sensitivity_summary` 键）渲染 `.md`
- **THEN** 除 §5 外，输出与 M3 渲染器对同一夹具的输出逐字节相同；§5 为逐 run 指标段，该运行若无 `metrics_summary` 则各指标单元格为 `not_available`

#### Scenario: per-run metrics rendered for every type
- **WHEN** 渲染一份 `science_assist` 报告，其唯一运行的 `metrics.json` 为 `status: ok`、`water_balance_residual: 0.03`
- **THEN** §5 的逐 run 指标段列出该 `run_id`、峰值、峰现日、总径流、四项 numerical_health 的值、`water_balance_residual` 的判定 `warn`（`max_solver_dt` 只有值 `null`、没有判定），以及该 `metrics.json` 的路径与 sha256

#### Scenario: sensitivity delta rows rendered from the summary file
- **WHEN** 渲染一份 `sensitivity` 报告，其 `.sensitivity.json` 有 4 行，其中一行为失败的非 baseline cell
- **THEN** §5 的 Δ 汇总段按 pset 顺序逐行列出各字段，失败行的指标与 Δ 单元格为 `null` 并列出 `exit_code` 与 `exit_class`，不含任何排名或解释文字

#### Scenario: numbers rendered as stored
- **WHEN** 渲染一份 `sensitivity` 报告，其 `.sensitivity.json` 某行 `delta_peak_flow_pct` 为 `-33.33333333333333`、`delta_total_runoff_pct` 为 `null`（原因 `zero_baseline`），该行运行的 `metrics.json` 中 `water_balance_residual` 为 `0.0008`、`peak_flow_m3d` 为 `123456.789`
- **THEN** §5 逐字含 `-33.33333333333333`、`0.0008` 与 `123456.789`，不含 `-33.33`、`8e-4` 或 `123,456.789`；该 `delta_total_runoff_pct` 单元格为 `null` 并附 `zero_baseline`

#### Scenario: verification facts are independent of change references
- **WHEN** a report has empty change_ids and nonempty verification_ids, and two cited VCs share a build
- **THEN** each VC and its base-then-candidate build facts appear in declared order, including repeated build displays, while §5 renders the per-run metrics section without the code_change wording constant

#### Scenario: unsafe or invalid fact records do not produce a partial report
- **WHEN** a cited ChangeRequest, VerificationCase or BuildRecord is missing, malformed, schema-invalid, has a mismatched embedded id or is a symlink target
- **THEN** rendering fails through the readonly file-layer boundary without creating managed directories, returning partial Markdown or changing any input bytes

#### Scenario: new structured facts participate in existing canonical validation
- **WHEN** a schema-valid new fact contains a secret-shaped token and the canonical report is rendered for `report_validate`
- **THEN** the existing whole-document secret check rejects it with controlled diagnostics; this rendering integration adds no validator check of its own (checks 16/17 belong to the sensitivity requirements) and no cross-object validation

### Requirement: Report template
报告 `.md` SHALL 以 `# EvidenceReport: <title>` 开头，并按序包含以下 10 个二级标题：`## 1. 摘要`、`## 2. 任务与问题`、`## 3. StackLock 与数据来源`、`## 4. 运行记录`、`## 5. 指标与图表`、`## 6. 观测与解释限制`、`## 7. 风险和失败项`、`## 8. 需要 PI 判断的问题`、`## 9. 建议下一步`、`## 10. 附录：命令、日志、artifact manifest`。§5 对所有报告 SHALL 渲染「Deterministic facts table」的逐 run 指标段，SHALL NOT 再含"本里程碑无指标 artifact，见 limitations"；`code_change` 报告（`change_ids` 非空）SHALL 先逐字渲染「code_change report wording constant」的固定句，再接逐 run 指标段；`sensitivity` 报告（`sensitivity_summary` 非 `null`）SHALL 在逐 run 指标段之后再接 Δ 汇总段；§3 对 `code_change` 报告另含「Deterministic facts table」的 ChangeRequest 段与 VerificationCase 段（`verification_ids` 非空时另含 BuildRecord 段）；§6 SHALL 在模型提供的 observations 与 limitations 之后，由模板（而非报告 `.json` 的 `limitations` 字段）逐字渲染 core `GOVERNANCE_INVARIANTS` 的四句不变式，每句一行；§7 SHALL 列出每个 `status` 不为 `succeeded` 的关联运行（`science_assist` 与 `code_change` 的 closure 谓词已排除失败运行，该节通常为空列表；`sensitivity` 报告可含失败的非 baseline cell 与已被重提取代的失败运行，两者都 SHALL 列出；没有 RunRecord 的被取代作业按 `.sensitivity.json` 的 `superseded_runs` 列出其 `job_id`、`run_id` 与 `terminal_state`；§7 的全部运行条目 SHALL 按 linked_jobs 顺序（见「report_generate」）排列），并另列 `verification_ids` 中每个 `status: failed` 的 VerificationCase 的 `vc_id` 与 `failure_reason`（VerificationCase 规范要求 failed 不能从报告中消失）；§10 SHALL 列出各运行的 argv、日志路径与产物清单。`.md` SHALL 含参数提供的 `summary`、`observations`、`limitations`、`pi_questions` 原文。

#### Scenario: ten sections rendered
- **WHEN** 生成一份只关联一个成功运行的报告
- **THEN** `.md` 按序含上述 10 个标题，§5 为该运行的逐 run 指标段且不含"本里程碑无指标 artifact"，§6 逐字含四句治理不变式，§7 不列任何运行，报告 `.json` 的 `limitations` 不含这四句

#### Scenario: failed run listed
- **WHEN** 以关联 RunRecord 为 `status: failed`、`exit_class: cvode` 的夹具调用渲染器
- **THEN** §7 列出该运行的 `run_id` 与 `exit_class`

#### Scenario: code_change report sections
- **WHEN** 生成一份关联 base 与 candidate 两个成功运行、一个 approved ChangeRequest 与一个 `passed` VerificationCase 的 `code_change` 报告
- **THEN** `.md` 按序含上述 10 个标题，§3 含 ChangeRequest 段、VerificationCase 段与 BuildRecord 段，§5 以「code_change report wording constant」的固定句开头、其后为两个运行的逐 run 指标段，不含 "本里程碑无指标 artifact，见 limitations"，§6 逐字含四句治理不变式，§7 不列任何运行或 VerificationCase

#### Scenario: sensitivity report sections
- **WHEN** 生成一份 4 个 pset、其中 `PSET-3` 的有效 run 为失败运行、`PSET-2` 有一个已被取代的失败运行的 `sensitivity` 报告
- **THEN** `.md` 按序含上述 10 个标题，§5 依次为逐 run 指标段与 Δ 汇总段，§7 列出 `PSET-3` 的失败运行与 `PSET-2` 被取代的失败运行各自的 `run_id` 与 `exit_class`，两者的先后与其 `job_id` 在卡片 `linked_jobs` 中的先后相同

#### Scenario: failed verification listed
- **WHEN** 以 `verification_ids` 含一个 `status: failed`（`failure_reason` 为两 sha 不等）与一个 `status: passed` 的 VerificationCase 的夹具调用渲染器
- **THEN** §7 列出 failed 者的 `vc_id` 与其 `failure_reason`，不列出 passed 者

### Requirement: report_validate
`report_validate` SHALL 接受参数 `report_id`（未知参数使调用失败），是 `draft` → `reviewed` 的唯一入口，并逐项执行以下 17 项确定性检查：(1) `stack_ids` 中每个 id 解析到 `stacks/<stack_id>.json` 且其 `stack_id` 一致；(2) `data_ids` 中每个 id 解析到 `provenance/<data_id>.json`；(3) 每个 `linked_runs` 有 RunRecord；(4) 指标来自确定性 artifact；(5) `limitations` 非空；(6) `pi_questions` 非空；(7) 禁止用语扫描（模型撰写的 `summary`、`observations`、`limitations`、`pi_questions`）无命中；(8) 失败运行及 `verification_ids` 中每个 `status: failed` 的 VerificationCase 已在 §7 列出；(9) 每个 dirty 仓库在 `.md` 中有 dirty 标注行；(10) 每个关键指标有 source_ref；(11) 每个图表观察有 figure/timeseries artifact ref；(12) `GOVERNANCE_INVARIANTS` 四句在 `.md` 中逐字出现，缺任一句即失败；(13) 整份 `.md` 不匹配 `REPORT_SECRET_PATTERN`；(14) `change_ids` 非空的报告，其 `.md` §5 逐字含「code_change report wording constant」的固定句，`change_ids` 为空时该项恒为通过并在结果中标注为不适用；(15) `verification_ids` 中每个 VerificationCase（经工作区文件安全规则、schema 与文件内 id 校验读取）的 `artifact_refs` 两项均解析为会话 cwd 下的普通文件（路径各级组件与目标以 `lstat` 确认，符号链接、目录或特殊文件即失败，不跟随链接），且第一项、第二项内容的 sha256 分别等于该 VerificationCase 的 `observed.base_sha256`、`observed.candidate_sha256`，文件缺失、不安全、不可读或 sha256 不等即失败并指出该 `vc_id` 与路径；`verification_ids` 为空时该项恒为通过并在结果中标注为不适用；(16) `sensitivity_summary` 非 `null` 的报告，其 `.md` 逐字含「Deterministic report limitations」的覆盖声明（只由 `.sensitivity.json` 的 `project`、`end_days` 与 `rows` 的键和倍率实例化，validator 不读取 `analyses/`）与"agent 建议值"标注常量全文，缺任一即失败；`.sensitivity.json` 不可用而无法渲染时该项按渲染不可用失败；(17) `sensitivity_summary` 非 `null` 的报告，其 `path` 解析为会话 cwd 下按工作区文件安全规则可读的普通文件 `reports/<report_id>.sensitivity.json`，且字节 sha256 等于 `sensitivity_summary.sha256`，缺失、不安全或不等即失败并指出该路径。第 (16)、(17) 项在 `sensitivity_summary` 为 `null` 时恒为通过并在结果中标注为不适用。第 (8)、(9)、(12)、(13)、(14)、(16) 项 SHALL 作用于由当前 `.json` 与其引用文件确定性渲染出的 `.md` 内容。第 (4)、(10) 项 SHALL 恒为通过并在结果中标注为由构造保证：报告中的指标只由「Deterministic facts table」从 sha256 锁定的 `metrics.json` 与 `.sensitivity.json` 渲染、每行带 source_ref（渲染时 sha256 不符即渲染失败，见「Report workspace files」）；第 (11) 项因报告无图表 SHALL 恒为通过并标注为恒真项。`docs/03_SPEC/Report_Generation_Spec.md` 的 (D) 项"report 没有引用 tmp 路径"在 M3 SHALL NOT 实现：会话工作区与运行目录可以位于 `$TMPDIR` 下，报告中的这类路径是合法事实。工具结果 SHALL 列出全部 17 项各自的结果。任一项失败时报告 SHALL 保持 `draft`、文件不变，结果列出失败项（禁止用语失败时列出命中短语与字段，密钥形态失败时只指出所在节、不回显匹配内容）；全部通过时 SHALL 按「Report write order and repair」写入 `status: reviewed` 并重新渲染 `.md`。

#### Scenario: all checks pass
- **WHEN** 对一份 StackLock、DataProvenance、RunRecord 齐全且无禁止用语的 `draft` 报告调用 `report_validate`
- **THEN** 工具结果列出 17 项均通过，其中第 (4)、(10) 项标注为由构造保证、第 (11) 项标注为恒真，`science_assist` 报告的第 (14)、(15)、(16)、(17) 项标注为不适用，报告变为 `reviewed`

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
- **THEN** 17 项均通过，报告变为 `reviewed`

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
- **THEN** 结果仍列出全部 17 项，第 (15) 项独立检查该 VC 并指出其 artifact 失败，报告保持 draft，校验不写文件

#### Scenario: verification artifacts intact pass item 15
- **WHEN** `code_change` 报告的每个 VerificationCase 的两个 `artifact_refs` 均为会话 cwd 下的普通文件、sha256 分别等于 `observed.base_sha256` 与 `observed.candidate_sha256`，其余条件齐全时调用 `report_validate`
- **THEN** 第 (15) 项通过（不标注为不适用），17 项均通过，报告变为 `reviewed`

#### Scenario: sensitivity report passes all checks
- **WHEN** 对一份引用齐全、`.sensitivity.json` 未被改动、无禁止用语的 `sensitivity` draft 报告调用 `report_validate`
- **THEN** 17 项均通过，第 (16)、(17) 项不标注为不适用，报告变为 `reviewed`

#### Scenario: missing coverage statement keeps draft
- **WHEN** `sensitivity` 报告渲染出的 `.md` 缺少覆盖声明或"agent 建议值"标注（如报告 `.json` 的 `limitations` 被改写后）时调用 `report_validate`
- **THEN** 第 (16) 项失败并指出缺失的那一句，报告保持 `draft`

#### Scenario: altered summary file keeps draft
- **WHEN** `sensitivity` 报告的 `.sensitivity.json` 被删除、被替换为符号链接或被改写一个字节后调用 `report_validate`
- **THEN** 第 (17) 项失败并指出该路径，报告保持 `draft`，`.json` 与该路径上的文件字节不变

### Requirement: EvidenceReport generated projection
EvidenceReport 与 PiGateDecision 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 EvidenceReport 段 SHALL 与本 spec 一致，并写明 id 格式由 `REPORT-NNNN` 改为品牌格式、`linked_runs` 改为非空品牌 id 数组、新增 `stack_ids`、`data_ids`、`llm_response_models`、`decision_history`、`updated_at`，以及 `change_ids`（品牌 `ChangeId` 去重数组）与 `verification_ids`（品牌 `VerificationId` 去重数组）——二者可为空、缺失时按 `[]` 解析且 M3 报告文件不改写；新增 `analysis_ids`（品牌 `AnalysisPlanId` 去重数组，可为空、缺失时按 `[]` 解析）与 `sensitivity_summary`（`{path, sha256}` 或 `null`，缺失时按 `null` 解析，`analysis_ids` 非空 ⇔ 非 `null`），M3/M4 报告文件不改写；报告字段名为 `verification_ids`，与 `Theory_to_Code` 文档的 `verification_case_ids` 命名差异 SHALL 在该段注明。该文件既有的 PiGateDecision 段 SHALL 被改写（不另增一段）为本 spec 的 `{decision_id, report_id, approval_ref, outcome, comment, decided_at}`，并逐项写明处置：保留 `decision_id`；删除 `gate_id`、`task_id`、`actor_user_id`、`actor_role`、`comment_required`、`next_action`、`evidence_refs`（approval_ref 仅保存本次执行 callId，经 session log 的 asked.callId → asked.id → decided.id 关联审批证据，不直接承载 gate/actor；task 经 `report_id` → TaskCard `linked_reports` 关联）；新增 `report_id`、`approval_ref`；`decision: approved|rejected|request_revision` 改为 `outcome: accepted|rejected|revision_requested`；`comment?` 改为必填且当且仅当 `accepted` 为 `null`；`created_at` 改为 `decided_at`；A01-2 枚举映射删除。字段权威源 `docs/03_SPEC/Support_Schema_Contracts.md` §6 SHALL 同刀改写为同一字段集（其 `idempotency_key` 一并删除），Minimal_Schemas 的投影声明继续指向它。

#### Scenario: drift detected
- **WHEN** 修改 EvidenceReport 或 PiGateDecision 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projections registered
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 EvidenceReport 与 PiGateDecision 的 Markdown 与 JSON Schema 投影

#### Scenario: change reference fields projected
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下 EvidenceReport 投影含 `change_ids` 与 `verification_ids` 两个数组字段，元素模式分别拒绝 `CHG-0001` 与 `VC-0001`

#### Scenario: analysis reference fields projected
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下 EvidenceReport 投影含元素模式拒绝 `PLAN-0001` 的 `analysis_ids` 数组字段与可为 `null` 的 `sensitivity_summary` 对象字段

#### Scenario: change reference drift detected
- **WHEN** 在 EvidenceReport 的 Zod schema 中增删或改名 `change_ids`、`verification_ids` 而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

### Requirement: code_change report wording constant
core `governance/wording.ts` SHALL 导出一个字符串常量，其值恰为：`验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。`。报告模板 SHALL 在 `code_change` 报告的 §5 逐字渲染该常量作为该节第一段，`report_validate` 第 (14) 项检查其逐字出现；该常量 SHALL NOT 写入报告 `.json` 的 `limitations` 或其它字段，SHALL NOT 可经 profile 配置覆写或放宽，修改只能经代码变更与审查。模型撰写的 `summary`、`observations`、`limitations`、`pi_questions` SHALL NOT 改写、替换或删去该句：它们按原文渲染在各自节中，与 §5 的固定句互不影响。该常量与 `GOVERNANCE_INVARIANTS` 同为模板渲染文本，SHALL NOT 作为扫描短语参与禁止用语检查（扫描只覆盖模型撰写的四个字段）。M5 起该常量删去了原开头分句"本里程碑无指标 artifact；"（与其后的指标段矛盾），其余逐字不变。`science_assist` 与 `sensitivity` 报告的 §5 SHALL NOT 渲染该常量。`code_change` 报告 §5 在该常量之后 SHALL 接「Deterministic facts table」的逐 run 指标段，该常量是 §5 的第一段而非全文。

#### Scenario: fixed sentence rendered verbatim
- **WHEN** 生成一份 `code_change` 报告
- **THEN** `.md` 的 §5 第一段与该常量逐字节相同，其后为逐 run 指标段，报告 `.json` 的任何字段都不含该句

#### Scenario: model text cannot alter the fixed sentence
- **WHEN** 生成 `code_change` 报告时 `limitations` 参数含"bitwise 一致证明并行实现正确"，`summary` 含该常量的改写版本
- **THEN** §5 第一段仍逐字为该常量，模型文本原样出现在 §1 与 §6，§5 不含模型文本

#### Scenario: science_assist section 5 unchanged
- **WHEN** 生成一份 `science_assist` 或 `sensitivity` 报告
- **THEN** §5 为逐 run 指标段（`sensitivity` 另接 Δ 汇总段），不含"本里程碑无指标 artifact，见 limitations"，`.md` 不含该常量

#### Scenario: constant is not a scan phrase
- **WHEN** 报告 `observations` 含该常量全文
- **THEN** 禁止用语扫描无命中（该句不含任何禁止短语，且模板渲染文本本就不在扫描范围）

## ADDED Requirements

### Requirement: Sensitivity summary derivation
`sensitivity` 卡的 `report_generate` SHALL 在 closure 成立后，由卡片唯一 plan（`analyses/<analysis_plan_id>.json`）与 task-cards「sensitivity closure predicate」选出的各 pset 有效 run 的 `metrics.json` 确定性派生敏感性汇总，写入 `reports/<report_id>.sensitivity.json`（写入顺序与失败处理见「Report write order and repair」）。系统 SHALL NOT 为此提供独立工具或独立 `sensitivity_table` artifact，SHALL NOT 调用 LLM。文件 SHALL 为固定键序的 JSON 对象，含：`method_version`（core 常量）、`analysis_plan_id`、`plan_sha256`（plan 文件字节的 sha256）、`task_id`、`project`、`end_days`、`rows`、`superseded_runs`、`inputs`。
- `rows` SHALL 按 plan 中 pset 顺序每个 pset 恰一行，字段为：`parameter_set_id`、`label`、`baseline`、`key` 与 `multiplier`（baseline 行为 `null`）、有效 run 的 `job_id`、`run_id`、`status`、`exit_code`、`exit_class`，取自其 `metrics.json` 的 `peak_flow_m3d`、`peak_day`、`total_runoff_m3`、`water_balance_residual` 及 `water_balance_residual` 判定，以及 `delta_peak_flow_pct`、`delta_peak_day`、`delta_total_runoff_pct` 与 `delta_reasons`。
- 非 baseline 的 succeeded 行：`delta_peak_flow_pct = (peak_flow_m3d − 基线值) / 基线值 × 100`，`delta_total_runoff_pct` 同理，`delta_peak_day = peak_day − 基线值`（天，非百分比）。两个 `_pct` 字段的分母为 baseline 行的对应值，分母为 0 时该 `_pct` 字段为 `null`，原因 `zero_baseline`；`zero_baseline` 规则 SHALL 只适用于 `delta_peak_flow_pct` 与 `delta_total_runoff_pct`。`delta_peak_day` 是差值而非比值，两侧 `peak_day` 均非 `null` 时 SHALL 恒可计算（含 baseline `peak_day` 为 0）。任一操作数为 `null` 时该 Δ 为 `null`，原因 `metric_null`。baseline 行的 Δ 为 `null`，原因 `baseline_row`。
- 失败行（非 baseline 的失败有效 run）的指标与 Δ 列 SHALL 为 `null`，原因 `run_failed`，并保留其 `exit_code` 与 `exit_class`。
- `superseded_runs` SHALL 按 linked_jobs 顺序（见「report_generate」）列出未被选为有效 run 的作业（`parameter_set_id`、`job_id`、取自 RunJob 的 `run_id`、`terminal_state`（`collected`、`failed`、`cancelled` 或 `collect_exhausted`）与 `exit_class`（无 RunRecord 时为 `null`）），它们 SHALL NOT 进入 `rows`。
- `inputs` SHALL 按 `rows` 顺序列出每个 succeeded 有效 run 的 `{run_id, metrics_sha256}`。

数值 SHALL 以 JS 最短往返表示序列化；文件 SHALL NOT 含 `report_id`、时间戳、绝对路径或主机信息，使同一 plan 字节与同一组 `metrics.json` 字节 SHALL 产生逐字节相同的文件（验收脚本据此独立复算）。系统 SHALL NOT 计算敏感性指数、弹性系数、排名或任何机制解释；Δ 只陈述单流域、单窗口、相对 baseline 的变化。

#### Scenario: delta relative to baseline
- **WHEN** baseline 行 `peak_flow_m3d = 200`、`peak_day = 44`，`GEOL_KSATH`×2 行 `peak_flow_m3d = 150`、`peak_day = 46`
- **THEN** 该行 `delta_peak_flow_pct` 为 `-25`，`delta_peak_day` 为 `2`

#### Scenario: zero baseline denominator
- **WHEN** baseline 行 `total_runoff_m3 = 0`
- **THEN** 每个非 baseline succeeded 行的 `delta_total_runoff_pct` 为 `null`，原因 `zero_baseline`，其它 Δ 照常计算

#### Scenario: zero baseline peak day still differenced
- **WHEN** baseline 行 `peak_day = 0`，某 succeeded 行 `peak_day = 3`
- **THEN** 该行 `delta_peak_day` 为 `3`，`delta_reasons` 中该字段没有 `zero_baseline`

#### Scenario: failed cell row kept
- **WHEN** `PSET-3` 的有效 run 为 `exit_code: 19`、`exit_class: cvode` 的失败运行
- **THEN** `PSET-3` 行存在，指标与 Δ 列为 `null`、原因 `run_failed`，`exit_code` 与 `exit_class` 为 `19` 与 `cvode`，`inputs` 不含该运行

#### Scenario: superseded failure excluded from rows
- **WHEN** `PSET-2` 有一个失败运行与一个之后重提的 succeeded 运行
- **THEN** `PSET-2` 行引用 succeeded 运行，失败运行只出现在 `superseded_runs`；`superseded_runs` 有多项时其顺序与各 `job_id` 在卡片 `linked_jobs` 中的顺序相同

#### Scenario: summary is reproducible
- **WHEN** 以同一 plan 文件与同一组 `metrics.json` 两次派生汇总（不同 `report_id`、不同工作区绝对路径）
- **THEN** 两份 `.sensitivity.json` 逐字节相同

### Requirement: Deterministic report limitations
`report_generate` SHALL 在模型提供的 `limitations` 之后按以下顺序追加确定性 limitation，模板全部为 core `governance/wording.ts` 导出的常量（SHALL NOT 经 profile 覆写），这些条目 SHALL NOT 计入 closure 谓词的 `limitations` 计数，SHALL NOT 作为禁止用语扫描短语：
1. `sensitivity` 报告恰一条覆盖声明，常量模板为 `仅在 <project> 单流域、<end_days> 天窗口、相对 baseline 测试了 <KEY×m, …>；未覆盖其它参数、取值与窗口`：`<project>`、`<end_days>` 取自 plan，`<KEY×m, …>` 按 plan pset 顺序列出每个非 baseline pset 的键与倍率（倍率为最短往返表示），以 `, ` 连接。
2. `sensitivity` 报告恰一条固定标注 `参数范围为 agent 建议值，未经 PI 确认`（M5 中 plan 的 `parameter_space_rationale.confirmed_by` 恒为 `null`）。
3. 每份报告（所有任务类型）恰一条固定 limitation 常量 `max_solver_dt 在钉版 SHUD 中不可观测（PrintFinalStats 未被调用），各运行该项恒为 null，不作判定`；系统 SHALL NOT 为 `max_solver_dt` 逐 run 生成 limitation。
4. 按 `linked_runs` 顺序，对每个有 `metrics.json` 且 `status: ok` 的关联运行，按 `water_balance_residual`、`cvode_failures`、`negative_state_count` 顺序，凡判定为 `warn`、`fail` 或 `not_available` 的各一条，点名 `run_id`、指标、判定及其值或原因；`status: succeeded` 但 `metrics_summary` 为 `null` 或 `metrics.json` 为 `status: unavailable` 的运行各一条，点名 `run_id` 与原因。
5. `sensitivity` 报告中按 `rows` 顺序，每个失败的有效 run（失败 cell）各一条，点名 `parameter_set_id`、`run_id`、`exit_code` 与 `exit_class`，说明该 cell 不参与相对 baseline 的比较。

非 `sensitivity` 报告 SHALL NOT 含第 1、2、5 类条目。这些条目与模型文本一起写入报告 `.json` 的 `limitations`，由 §6 原样渲染。

#### Scenario: coverage statement instantiated
- **WHEN** plan 为 `project: ccw`、`end_days: 90`，非 baseline pset 依次为 `GEOL_KSATH`×0.5、`GEOL_KSATH`×2、`LC_ROUGH`×2
- **THEN** 报告 `limitations` 含 `仅在 ccw 单流域、90 天窗口、相对 baseline 测试了 GEOL_KSATH×0.5, GEOL_KSATH×2, LC_ROUGH×2；未覆盖其它参数、取值与窗口` 与 `参数范围为 agent 建议值，未经 PI 确认`，两者位于模型条目之后

#### Scenario: threshold verdict limitations
- **WHEN** 报告唯一运行的 `water_balance_residual` 判定为 `warn`，`cvode_failures` 与 `negative_state_count` 为 `pass`
- **THEN** 追加一条点名该 `run_id` 与 `water_balance_residual`/`warn` 的 limitation，以及一条 `max_solver_dt` 不可观测的固定 limitation；不为 `pass` 项生成条目，不存在点名该运行 `max_solver_dt` 的条目

#### Scenario: negative state fail does not block generation
- **WHEN** `science_assist` 报告唯一运行的 `negative_state_count` 为 `11`（判定 `fail`），其余 closure 条件成立
- **THEN** 报告生成成功，`limitations` 追加一条点名该 `run_id`、`negative_state_count`、`fail` 与值 `11` 的条目；值为 `10` 时同一位置的条目判定为 `warn`

#### Scenario: one max_solver_dt limitation per report
- **WHEN** 生成一份关联 4 个运行的 `sensitivity` 报告或一份 `code_change` 报告
- **THEN** `limitations` 中 `max_solver_dt` 不可观测的固定条目恰出现一次

#### Scenario: failed cell limitation
- **WHEN** `sensitivity` 报告中 `PSET-3` 的有效 run 为 `exit_class: cvode` 的失败运行
- **THEN** 追加一条点名 `PSET-3`、该 `run_id`、`exit_code` 与 `cvode` 的 limitation

#### Scenario: science_assist report has no coverage statement
- **WHEN** 生成一份 `science_assist` 报告
- **THEN** `limitations` 不含覆盖声明与"agent 建议值"标注
