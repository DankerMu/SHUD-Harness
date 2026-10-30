# Spec Delta

## MODIFIED Requirements

### Requirement: shud_run is guarded
对 `shud_run` 工具，策略门 SHALL 用 session cwd（`shud_run` 没有 `workdir` 参数）与 `arguments.input_dir`（相对路径按 session cwd 解析）判定，路径解析与「Raw directory configuration」相同（realpath 与最近存在祖先）。所有提交写入根 SHALL 纳入判定：`<session cwd>/runs`、`<session cwd>/stacks`、`<session cwd>/provenance`；运行与证据 id 尚未分配时，SHALL 以各根最近存在祖先的 realpath 拼接余段解析（根已存在时使用其 realpath，含符号链接；否则使用 session cwd 的 realpath）。携带经 core TaskId schema 校验通过的 `task_id` 时，SHALL 额外用同一 canonical/containment 规则保护确定的写入目标 `<session cwd>/tasks/<task_id>/task.json`，包括其受保护祖先；未携带 task_id 时 SHALL NOT 新增 tasks 相关查找或拒绝，非法 task_id 不得用于路径拼接，仍交由工具参数校验拒绝。任一提交写入根或本次任务目标位于任一 raw 目录内或等于它时 SHALL 返回 `deny`，`code` 为 `raw-immutable`，`reason` 含 `immutable`，SHALL NOT 提供写审批路径；否则 `input_dir` 位于任一 raw 目录内或等于它时 SHALL 返回 `ask`，`reason` 为 provenance 文案常量；两者都不触及 raw 时 SHALL 委托下一个监听器。`input_dir` 缺失或不是字符串时 SHALL 仍按上述可确定的输出目标判定，SHALL NOT 抛错。输出拒绝 SHALL 先于输入读取审批，不依赖 rawDirs 的顺序；每条决策照常经「Decision audit」记录。M3 仅扩展既有 raw-guard 决策，不在 tools/jobs/records 中复制 raw 策略；#445 的任务目标扩展经 PI 明确授权，task_create 的独立保护仍属 #481。

#### Scenario: input under raw asks
- **WHEN** 配置 `rawDirs: ["prot"]`，session cwd 为工作区根，调用 `shud_run`，`input_dir` 为 `prot/ccw`，三个写入根均在 raw 之外
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 provenance 常量

#### Scenario: session cwd under raw denied
- **WHEN** 配置 rawDirs 包含工作区 prot 的绝对路径，session cwd 为该 prot/sub，input_dir 为 raw 外的 /tmp/ccw
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: symlinked runs into raw denied
- **WHEN** 配置 rawDirs 为 prot，工作区 runs 为指向 prot/out 的符号链接，input_dir 为 input/ccw
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: raw is the runs directory
- **WHEN** 配置 `rawDirs: ["runs"]`，该目录尚不存在，input_dir 为 input/ccw
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: unrelated paths pass through
- **WHEN** 配置 rawDirs 为 prot，input_dir 为 input/ccw，三个写入根均不在 raw 内
- **THEN** 不作判定，返回 next 的结果

#### Scenario: symlinked input into raw
- **WHEN** input_dir 为工作区内指向 prot/ccw 的符号链接，三个写入根均在 raw 之外
- **THEN** 决策 `kind` 为 `ask`

#### Scenario: capture roots configured as raw are immutable
- **WHEN** rawDirs 配置为 stacks 或 provenance，分别覆盖该写入根已存在与尚不存在的情形，调用真实注册的 shud_run
- **THEN** 工具在执行前被拒绝，不请求审批、不调用 producer，不创建运行目录、证据文件或索引条目，已有受保护内容不变

#### Scenario: capture-root aliases retain raw containment
- **WHEN** 已存在的 stacks 或 provenance 写入根经符号链接或本机大小写别名指向配置的 raw 根，或 session cwd 使用符号链接别名
- **THEN** 仍为 raw-immutable deny；兄弟前缀 stacks-input 或 provenance-input 不被当作同一写入根

#### Scenario: capture write denial precedes raw input approval
- **WHEN** 一个 rawDir 覆盖输入，另一个覆盖 stacks 或 provenance，或 input_dir 缺失/类型错误
- **THEN** 只要写入根受保护就 deny，不因输入审批或参数错误跳过输出保护；rawDirs 顺序不改变结果

#### Scenario: task-linked submission protects its exact task target
- **WHEN** shud_run 携带合法 task_id，rawDirs 覆盖 tasks、该任务目录、目标 task.json 或其祖先，分别覆盖路径存在与不存在
- **THEN** 在执行、TaskCard 对账与输入读审批之前返回 raw-immutable deny，不创建或修改任务/运行/证据/索引内容，不请求 approval

#### Scenario: unlinked submission retains its existing path
- **WHEN** rawDirs 为 tasks，不带 task_id 调用 shud_run，输入与三个既有输出根不在 raw 内
- **THEN** 不因 tasks 保护而拒绝或新增任务路径查找，工具沿原路径提交，tasks 不被读写

#### Scenario: task target identity and aliases remain bounded
- **WHEN** session cwd、tasks 或任务目录使用符号链接/本机大小写别名，或 rawDirs 只覆盖另一任务/兄弟前缀；另以非法 task_id 调用
- **THEN** 同一物理受保护任务目标仍拒绝，非重叠任务目标不误拒绝；非法 task_id 不参与任务路径拼接或查询，既有三个输出根与输入规则不变

## ADDED Requirements

### Requirement: Report generation and validation protect write targets
report_generate 与 report_validate SHALL 在工具执行前经 raw-guard 保护其写入目标，使用既有 session cwd、canonical/最近存在祖先与 raw containment 判定，命中返回 raw-immutable deny，SHALL NOT 提供写审批路径。report_generate 的 id 尚未分配，SHALL 保护整个待分配 reports 命名空间与经 core TaskId 校验的确切 task.json；reports 命名空间与任一受保护路径重叠时拒绝。report_validate SHALL 保护合法 report_id 的 JSON/Markdown 对与由安全、无副作用、schema/id 绑定读取取得的关联 task.json，不因其它任务或其它报告被保护而误拒绝。非法 id 不拼接路径；无法安全确定目标时 fail closed。保护覆盖存在/缺失路径、受保护祖先与物理别名；判定不得创建目录或改写文件。此条不改变其它工具的既有行为。

#### Scenario: report generation denies protected output before reconciliation
- **WHEN** reports 待分配命名空间或本 task.json 位于 raw，分别覆盖存在与缺失路径
- **THEN** 实际 ToolRuntime 不执行工具、不请求 approval、不发布 reconcile 或报告，工作区和 raw 快照不变

#### Scenario: report validation protects repair targets
- **WHEN** 报告 JSON/Markdown 或其关联 task.json 受 raw 保护，调用 report_validate
- **THEN** 在入口修复前拒绝，受保护内容及全部工作区字节不变，零工具执行/审批

#### Scenario: report target aliases and unrelated objects
- **WHEN** 目标经 session/目录/文件别名指向 raw，或 raw 仅覆盖不相关任务/报告及兄弟前缀
- **THEN** 同一受保护物理目标仍拒绝；report_validate 的不相关目标不误拒绝，合法 disjoint 调用继续到工具

### Requirement: Report terminal tools protect write targets
report_submit 与 report_decide SHALL 复用 report_validate 的确切报告 JSON/Markdown 与关联 TaskCard 目标保护，不建立第二套读取或路径规则。raw-guard 位于 policy-gate 之前：任一实际写入目标受 raw 保护时 SHALL raw-immutable deny，零工具执行、零 PI 审批；PI allowed-once 不得授权 raw 写入。合法且不重叠的目标继续到既有 policy ask。无法安全解析报告身份/关联任务时 fail closed；判断与引用读取不得创建目录或改写内容。此扩展由 PI issuecomment6525339104 批准，不改变其它工具。

#### Scenario: terminal report write denial precedes approval
- **WHEN** report_submit 或 report_decide 的报告 JSON、Markdown 或关联 task.json（含祖先/物理别名）受 raw 保护，approval 服务即使配置为 allowed-once
- **THEN** raw-immutable 拒绝，approval 不被调用、execute 不运行，所有报告/卡片/raw 字节与修改时间不变

#### Scenario: unrelated protected reports do not deny a decision
- **WHEN** raw 仅保护另一报告或另一任务，本 report_id 的所有写目标不重叠
- **THEN** 不误拒绝；既有 policy 仍 ask，只有 host allowed-once 才执行本次决定
