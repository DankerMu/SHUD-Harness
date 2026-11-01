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
PiGateDecision SHALL 为严格对象，恰含 decision_id（DecisionId）、report_id（ReportId）、approval_ref（授权该终态写入的工具执行上下文 exec.callId，非空字符串）、outcome（accepted/rejected/revision_requested）、comment、decided_at（ISO 8601 UTC）。accepted 当且仅当 comment 为 null，其余 outcome 要求非空 comment；未知字段拒绝。O5 已证实审批 id 不在工具上下文，approval_ref SHALL 固定记 callId，不从日志另造读取订阅者；审计经 approval/asked.callId 关联 asked.id/decided.id。PiGateDecision 不含先前被拒 submit 卡引用，其关联仍经两张卡 reason 中同一 report_id（见 policy-gate「PI comment conversation carrier」）。

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
- **THEN** 工具返回错误结果，报告 `.json` 字节不变；已按「Report write order and repair」成功完成的入口修复保留，前置条件拒绝之后不再改写 `.md` 或卡片

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
`report_generate`、`report_validate`、`report_submit`、`report_decide` SHALL 共用同一正常写入顺序：(1) 原子写报告 `.json`——这是报告状态提交点，`status` 与 `decision_history` 以它为准；(2) TaskCard 转换（task-cards 状态机，读取—校验—转换—写入之间不 await；`report_validate` 正常路径跳过此步）；(3) 渲染并原子写 `.md`。`report_generate` SHALL 只在 closure 与引用校验通过后执行第 (1) 步。除下述独立提交的初始 TaskCard reconcile/入口修复外，第 (1) 步之前的失败 SHALL NOT 写文件；第 (1) 步之后失败 SHALL 返回失败步骤（`task_card` 或 `render`）与 `report_id`，SHALL NOT 回滚已写内容或自动重试。

报告工具 SHALL 恰有两种入口修复，只在下一次以同一 `report_id` 调用工具时、该调用自身的状态前置条件与 validator 之前执行；不接受 report_id 的 `report_generate` 不发现或修复旧报告。(a) 复用规范 repair predicate/mapping：报告未链接，或它是最后一项且卡片状态与报告映射状态不符时，补做链接与转换；已链接的较早报告 SHALL NOT 移动卡片。`draft`/`reviewed` 映射 `reporting`，`accepted` 映射 `done`，`revision_requested` 映射 `planned`，`rejected` 映射 `cancelled`。未链接报告先在内存中补做 reporting 转换，再按已持久化的报告状态补做后续合法转换，最后一次同步发布，SHALL NOT 写出中间态。

修复 SHALL 只复用既有合法 TaskCard 转换；任一所需转换非法时 SHALL 返回 `task_card` 与 `report_id` 的受控错误，卡片字节不变且不继续 Markdown 修复。SHALL NOT 直接赋状态、增加绕过事件或重开 done/cancelled 卡片。`awaiting_pi`/`archived` 不支持工具侧状态投影，SHALL 在写入前拒绝。修复不产生新的 PiGateDecision 或覆盖报告 JSON。

(b) `.md` 真正不存在，或标题下第一行与规范水印不符时，复用规范渲染器重新渲染并安全原子写入；仅 ENOENT 表示不存在，链接/特殊文件/不可读文件 SHALL fail closed。SHALL NOT 以正文差异新增修复规则。修复(a)先于(b)；任何修复失败 SHALL 返回其步骤与 report_id，保留先前成功提交。已成功的入口修复独立提交，后续前置条件或13项检查失败 SHALL NOT 撤销；本 spec 的失败“文件不变”以成功入口修复之后为基准，报告 JSON 在这些失败中始终不变。卡片与作业之间的对账仍只由「TaskCard reconcile」承担。以上顺序由 PI issuecomment6522484479 明确。

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
`report_generate` SHALL 接受 `task_id`、非空 `summary`、`observations`、`limitations`、`pi_questions` 字符串数组，未知参数使调用失败。首先 SHALL 无副作用读取并校验 TaskCard 身份及 `running|planned|reporting` 状态，再完成所有 authored 字段的品牌引用存在性校验；这些拒绝 SHALL NOT 创建目录、修改卡片或发起收集。随后取得 listRunJobsByTask，并在新鲜同步卡片读取/身份/状态校验边界内执行唯一 reconcile，仅有变化时发布；成功对账独立提交，后续失败 SHALL NOT 撤销。

closure SHALL 在 reconcile 后求值。仅已 collected 的关联作业经 collectShud(id, {readonly:true}) 显式只读模式取得已有 RunRecord；其它状态直接作为未收集失败，SHALL NOT 隐式发起收集。只读模式复用规范索引、身份与记录校验，缺失/损坏/不安全/身份不符时拒绝，SHALL NOT 生成记录、失败记账、投影状态、完成回执或通知；原 collectShud 默认行为不变（PI issuecomment6523542892）。收集失败次数 SHALL 另经 jobs 拥有的只读入口复用规范 collect-error.json 解析，即使存在有效成功 RunRecord 仍读取保留的 ledger；真正缺失为0，损坏/不安全/不可读记录明确失败，耗尽次数仍阻断 closure，不重置或绕过。异步证据取得后 SHALL 重读卡片并据其新鲜 linked_jobs 求 closure，缺乏新链接证据时拒绝而非丢弃链接、自动重试或使用旧卡片。

成功时 SHALL 写新 draft JSON，随后同步重读/校验/转换 TaskCard 为 reporting 并追加 report_id，最后安全渲染发布 Markdown。linked_runs 按卡片 linked_jobs 顺序来自规范 RunRecord；stack_ids、data_ids、llm_response_models 按首次出现去重；模型文本保持原样，limitations 末尾追加规范“无指标 artifact”说明。结果返回 report_id 与 status draft。closure 或后续生成失败不写新报告链接，不回滚已提交的初始对账；已有报告 JSON/Markdown（包括只有 Markdown 的 id 碰撞）SHALL NOT 被新分配覆盖。

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

### Requirement: Citation existence check
`report_generate` SHALL 在任何文件或目录写入及 TaskCard reconcile 之前，扫描 summary、observations、limitations、pi_questions 中独立的 TASK-/STACK-/DATA-/RUN-/JOB-/REPORT- 加 YYYYMMDDTHHMMSS-xxxx 品牌令牌，并经 core schema 验证捕获的 id。TASK/STACK/DATA/REPORT SHALL 解析到会话 cwd 下已有、安全、schema 合法且文件内 id 匹配的对应对象；RUN/JOB SHALL 解析到 shud-jobs 活动/完成索引条目。重复令牌可复用本次读取，不解析 DEC 或嵌在更长标识符中的子串。读取 SHALL NOT 创建缺失目录；任一令牌无法解析则返回指出该令牌的工具错误，不写 draft、不改卡片、不自动重试。

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

### Requirement: Decision history Markdown projection
每次规范 Markdown 渲染 SHALL 在现有 §10 附录中、各运行的命令/日志/产物块之前，以 `### PI decision history` 子标题呈现报告 JSON 的 decision_history；SHALL NOT 添加第十一个二级标题。非空历史 SHALL 以 decision_id、report_id、outcome、decided_at、approval_ref、comment 六列按持久数组顺序投影，不排序、去重、推断或新增决定。空历史 SHALL 显示 `No PI decision recorded.`，不伪造历史行。
comment SHALL 以 JSON literal 呈现：null 显示为 null，非空字符串保留 JSON 引号与转义，以区分 null 与字符串 "null" 并保留原始空白/换行。所有历史字段 SHALL 经既有结构化 metadata 规则单次转义，不能注入新表格列、物理标题或 HTML 标记，模板样式文本不得递归替换。comment SHALL 与 observations/科学解释分离，不改变模型撰写字段的禁止用语扫描边界；整份渲染 Markdown 的既有密钥检查仍覆盖该附录。
报告 JSON 仍是提交和决定历史的权威源，approval_ref 仍是执行 callId，真实批准由 session log 关联；Markdown 仅是确定性投影，SHALL NOT 成为新审批 authority。所有七态水印、终态历史约束、只读输入及既有发布/修复规则不变；本要求不授权扫描或批量重写旧报告。

#### Scenario: accepted decision displays null without inference
- **WHEN** 从持久 JSON 渲染 accepted 报告，其唯一决定的 comment 为 null
- **THEN** §10 六列与该决定逐项一致、comment 为 null，accepted 水印不变，源 JSON 字节和修改时间不变

#### Scenario: negative outcomes retain PI comments separately
- **WHEN** 渲染 rejected 或 revision_requested 报告，其决定含非空多行 comment，或 comment 恰为字符串 "null"
- **THEN** 六列保留相应 outcome 与原始 comment 的 JSON literal，字符串 "null" 不被当成 null，§6 observations 与模型撰写字段不变

#### Scenario: history metadata cannot inject report structure
- **WHEN** 决定字段含 HTML、管道、反引号、反斜杠、换行或模板样式文本，重复渲染同一持久报告
- **THEN** 结构字符按既有 metadata 规则单次转义，输出逐字相同，不新增二级标题/表格列，不递归插值，不修改输入

#### Scenario: existing history and validation boundaries remain
- **WHEN** 渲染空历史或 archived 报告，或用损坏/不匹配的终态历史渲染；另以含密钥形态 comment 的合法报告调用既有 validator
- **THEN** 空历史不生成决定，archived 继承既有终态水印，非法终态历史仍拒绝；密钥诊断归属 section10 且不回显值，不把 comment 纳入 observations

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
- **THEN** 13 项均通过，报告变为 `reviewed`

### Requirement: report_submit
report_submit SHALL 只接受 report_id。未被角色规则拒绝时先由 policy-gate ask，reason 含 report_id，displayReason 含 id/摘要首行/报告路径。allowed-once 后要求 reviewed 前态，否则错误且不写；满足时按「Report write order and repair」先写 accepted 与 decision_history（decision_id、report_id、approval_ref=本次 exec.callId、outcome accepted、comment null、decided_at），再 TaskCard reporting→done，再重渲染 accepted 水印。拒绝/取消/无审批服务等其它结果不执行，报告维持 reviewed、history 不增、TaskCard reporting，模型得到未放行错误。

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
report_decide SHALL 恰接受 report_id、必填 disposition（rejected/revision_requested，无默认）、必填非空 comment；非法/缺失值或未知键（含旧 rejected_approval_ref）错误且不写。未被角色拒绝时先 ask，reason 含 report_id、displayReason 回显 disposition/comment。allowed-once 后仅 reviewed 前态可写，任何终态不可覆盖；按规范顺序先写 PiGateDecision（outcome=disposition、comment=参数、approval_ref=本次 exec.callId）及 status，再 TaskCard reporting→planned（revision_requested）或 cancelled（rejected），最后重渲染。其它审批结果不执行且报告/卡片不变。

#### Scenario: revision requested with comment
- **WHEN** `report_submit` 被拒后，对仍为 `reviewed` 的报告调用 `report_decide`，`disposition: revision_requested`、`comment: "补一个 holdout 窗口"`，PI 在卡片上看到该 comment 并选 Allow once
- **THEN** 报告为 revision_requested，history 末条 outcome/comment 与参数一致，approval_ref 为本次 report_decide 的 callId，水印 REVISION REQUESTED — not accepted by PI，TaskCard planned；session log 中同 report_id 先有未放行 submit 卡，并能以 decide callId 关联本次审批 id

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
EvidenceReport 与 PiGateDecision 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 EvidenceReport 段 SHALL 与本 spec 一致，并写明 id 格式由 `REPORT-NNNN` 改为品牌格式、`linked_runs` 改为非空品牌 id 数组、新增 `stack_ids`、`data_ids`、`llm_response_models`、`decision_history`、`updated_at`。该文件既有的 PiGateDecision 段 SHALL 被改写（不另增一段）为本 spec 的 `{decision_id, report_id, approval_ref, outcome, comment, decided_at}`，并逐项写明处置：保留 `decision_id`；删除 `gate_id`、`task_id`、`actor_user_id`、`actor_role`、`comment_required`、`next_action`、`evidence_refs`（approval_ref 仅保存本次执行 callId，经 session log 的 asked.callId → asked.id → decided.id 关联审批证据，不直接承载 gate/actor；task 经 `report_id` → TaskCard `linked_reports` 关联）；新增 `report_id`、`approval_ref`；`decision: approved|rejected|request_revision` 改为 `outcome: accepted|rejected|revision_requested`；`comment?` 改为必填且当且仅当 `accepted` 为 `null`；`created_at` 改为 `decided_at`；A01-2 枚举映射删除。字段权威源 `docs/03_SPEC/Support_Schema_Contracts.md` §6 SHALL 同刀改写为同一字段集（其 `idempotency_key` 一并删除），Minimal_Schemas 的投影声明继续指向它。

#### Scenario: drift detected
- **WHEN** 修改 EvidenceReport 或 PiGateDecision 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projections registered
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 EvidenceReport 与 PiGateDecision 的 Markdown 与 JSON Schema 投影

### Requirement: Report tool publication ordering
同一物理工作区与 report_id 的工具操作 SHALL 在单进程内保持完整入口修复—前置条件—JSON/TaskCard—Markdown 的顺序，SHALL NOT 让较早的异步 DRAFT Markdown 发布覆盖较新的终态水印。审批在工具 execute 之前完成，不占用报告操作边界；操作进入边界后重新读取并校验当前报告。report_generate 对新分配 id 的后续卡片/Markdown 发布与 report_validate、report_submit、report_decide SHALL 共用同一顺序所有者，不另建终态专用队列。不同 report_id 独立推进；失败必须向调用方传播且释放后续操作，完成的顺序记录不得永久保留。此规则不宣称跨进程锁或外部 namespace 替换防护。

#### Scenario: competing approved decisions preserve one authoritative outcome
- **WHEN** 同一 reviewed 报告的 Markdown 缺失/过期，两次已 allowed-once 的决定调用重叠，入口或最终 Markdown 发布被暂时阻塞
- **THEN** 恰一条终态决定提交，后续调用读取新终态并拒绝；最终 Markdown 等于持久 JSON 的规范渲染，不残留晚到 DRAFT 水印

#### Scenario: report publication is ordered across sibling tools
- **WHEN** 新报告生成或 validation 的 Markdown 发布尚未完成，同 report_id 的已批准终态调用进入，含物理 cwd 别名
- **THEN** 共用顺序边界，终态调用在已有发布完成后按新鲜状态处理；不存在旧发布覆盖已成功的终态水印

#### Scenario: failed report operation does not block independent work
- **WHEN** 一个报告操作等待 IO 或失败，另一个 report_id 被调用，随后原 report_id 发起修复
- **THEN** 不同报告不被全局串行阻塞；原失败保留其错误与既有提交，后续同报告修复可继续且无遗留队列条目
