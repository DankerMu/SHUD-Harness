# Spec Delta

## MODIFIED Requirements

### Requirement: TaskCard record
TaskCard SHALL 含：`task_id`（品牌 `TaskId`）、`type`（`engineering|science_assist|ops|code_change`）、`status`（`created|planned|running|parked|reporting|awaiting_pi|done|cancelled|blocked`）、`runtime_phase`（`running_local|submitted_job|waiting_for_job|collecting` 或 `null`）、`title`、`question_or_goal`、`created_by`、`current_owner`、`reviewer`（均为非空字符串）、`stack_id`（品牌 `StackId` 或 `null`）、`data_id`（品牌 `DataId` 或 `null`）、`inference_budget`、`linked_jobs`（`JOB-YYYYMMDDTHHMMSS-xxxx` 格式的 `job_id` 数组）、`linked_reports`（`REPORT-YYYYMMDDTHHMMSS-xxxx` 格式的 `report_id` 数组）、`linked_changes`（品牌 `ChangeId`，即 `CHG-YYYYMMDDTHHMMSS-xxxx` 格式的 `change_id` 数组）、`linked_verifications`（品牌 `VerificationId`，即 `VC-YYYYMMDDTHHMMSS-xxxx` 格式的 `vc_id` 数组）、`source_base_commit`（40 位小写十六进制 commit 或 `null`）、`created_at`、`updated_at`，以及可选的 `theory_bundle_ids`。建卡时 `stack_id` 与 `data_id` SHALL 为 `null`，由 `shud_run` 提交回填。`linked_changes` 与 `linked_verifications` 在解析结果中 SHALL 恒为数组：输入缺少该键时（M3 写入的卡片）SHALL 按 `[]` 解析，读取 SHALL NOT 因此改写 `task.json`。`linked_changes` 与 `linked_verifications` 的写入内容 SHALL 各为码点升序且无重复，由写入方保证（见「TaskCard links」）。`source_base_commit` 是 `code_change` 卡钉定的源检出 base：输入缺少该键时（M3 写入的卡片）SHALL 按 `null` 解析，读取 SHALL NOT 因此改写 `task.json`；SHALL 有 refine（在默认值之后求值）：`type: code_change` ⇒ `source_base_commit` 非 `null`，其它 `type` ⇒ `source_base_commit` 为 `null`。该值只由 `task_create` 写入（见「task_create」），此后任何工具 SHALL NOT 改写它。

#### Scenario: fresh card with null references
- **WHEN** 解析一个 `type: science_assist`、`status: planned`、`stack_id: null`、`data_id: null`、`linked_jobs: []`、`linked_reports: []`、`linked_changes: []`、`linked_verifications: []`、`source_base_commit: null` 的 TaskCard
- **THEN** 解析成功

#### Scenario: code_change type parses
- **WHEN** 解析一个 `type: code_change`、`source_base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82"`、`linked_changes: ["CHG-20261102T080000-3f9c"]`、`linked_verifications: ["VC-20261102T090000-a1b2"]` 的 TaskCard
- **THEN** 解析成功

#### Scenario: M3 card without change links stays readable
- **WHEN** 解析一个 M3 写入的、不含 `linked_changes`、`linked_verifications` 与 `source_base_commit` 键的 `science_assist` TaskCard
- **THEN** 解析成功，前两者在解析结果中均为 `[]`、`source_base_commit` 为 `null`，`task.json` 的字节与修改时间不变

#### Scenario: source_base_commit bound to card type
- **WHEN** 解析 `type: code_change` 而 `source_base_commit: null`（或缺少该键）的 TaskCard，或 `type: science_assist` 而 `source_base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82"` 的 TaskCard，或 `source_base_commit: "9a422e5"`（短 sha）、`"9A422E5EB708DF7D2F8B4066A3083A031D679A82"`（大写十六进制）的 TaskCard
- **THEN** schema 解析失败并指出 `source_base_commit`

#### Scenario: invalid linked ids rejected
- **WHEN** 解析 `linked_jobs: ["JOB-0001"]`、`linked_reports: ["REPORT-0001"]`、`stack_id: "STACK-0001"`、`linked_changes: ["CHG-0001"]` 或 `linked_verifications: ["VC-20261102T090000-A1B2"]`（大写十六进制）的 TaskCard
- **THEN** schema 解析失败并指出对应字段

#### Scenario: unknown type rejected
- **WHEN** 解析 `type: code_review` 的 TaskCard
- **THEN** schema 解析失败并指出 `type` 字段

### Requirement: TaskCard workspace file
TaskCard SHALL 持久化为会话 cwd 下的 `tasks/<task_id>/task.json`，每次写入 SHALL 以同目录临时文件加 rename 原子替换，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；查找 SHALL 按 `task_id` 直接定位该文件。读取 SHALL 经 core schema 校验；文件缺失、不可解析或校验失败时 SHALL 返回说明原因的错误，SHALL NOT 改写该文件。

本 requirement 同时是 TaskCard、StackLock、DataProvenance、EvidenceReport、ChangeRequest（含其 patch）、VerificationCase 与 BuildRecord 七类工作区对象共用的工作区文件安全规则（其它 spec 以一句引用）：(1) 对象 id SHALL 在任何路径拼接之前经对应品牌 schema（`TaskId`、`StackId`、`DataId`、`ReportId`、`ChangeId`、`VerificationId`、`BuildId`）校验，未通过即返回错误、不访问文件系统；工具与 policy-gate 插件 SHALL NOT 由原始字符串构造工作区路径，只由通过校验的品牌 id 构造。(2) 会话 cwd 下的 `tasks`、`stacks`、`provenance`、`reports`、`changes`、`patches`、`verifications`、`builds` 目录（以及 `tasks/<task_id>/`）不存在时 SHALL 以 `mkdir -p` 创建；已存在时 SHALL 先 `lstat`，凡不是真实目录（符号链接、普通文件、特殊文件）一律 fail-closed 返回指出该路径的错误，SHALL NOT 跟随链接。(3) 目标文件在读或写之前 SHALL 先 `lstat`，符号链接与特殊文件 fail-closed。(4) M4 新增的对象首次落盘 SHALL 以排他创建占有其 id：`builds/.tmp-<build_id>/` 以排他 `mkdir`（非递归、目标已存在即 EEXIST）创建；`changes/<change_id>.json`、`patches/<change_id>.patch`、`verifications/<vc_id>.json` 以 `wx` 语义发布——同目录临时文件写完后以不覆盖目标的方式发布（目标已存在即 EEXIST），SHALL NOT 以 `rename` 覆盖已有对象。id 由该对象首个落盘的文件或目录占有：该首个排他创建返回 EEXIST 时 SHALL 重新分配 id 并重试，同一次调用至多重新分配 3 次，仍冲突即返回指出 id 冲突的错误且不写入；同一 id 的后续伴随文件（`patches/<change_id>.patch`）同样排他创建，EEXIST 时 SHALL 返回含该 id 的错误，SHALL NOT 覆盖已有文件。任何情况下 SHALL NOT 覆盖、截断或改写不属于本次调用的已有对象。M3 既有对象（TaskCard、StackLock、DataProvenance、EvidenceReport）的首次写入规则不变（报告 id 碰撞的处理见 evidence-reports「report_generate」）。已有对象的更新（TaskCard 回写、ChangeRequest/报告状态转换等）SHALL 为同目录临时文件加 `rename`，由 records 包的文件层 `state-files.ts` 实现（M3 已自 jobs 迁入 records，仓库中只有一份；本 change 不再描述该迁移）；另有两项例外：StackLock 以排他创建写入且其 EEXIST 按指纹复用处理、不重新分配 id（见 stack-lock「Deterministic capture at shud_run submission」）；`builds/<build_id>/` 以同一 `builds/` 下的临时目录（`builds/.tmp-<build_id>/`）构建完成后整体 `rename` 发布，是本规则的目录级例外——目录内文件（`build-record.json`、`shud`、日志）SHALL NOT 再单独以临时文件加 rename 写入，发布前 `builds/<build_id>/` SHALL NOT 存在，发布失败时临时目录 SHALL 被删除。

records 包根 SHALL 公开既有 `ensureDirectory(path, label, readonly = false): boolean`，供对象写入前复用同一目录预检实现，不复制目录策略或开放私有模块子路径。已有真实目录返回 `false`；缺失路径在 readonly 模式返回 `false` 且不创建，否则递归创建并返回 `true`。最终路径为符号链接（含悬空链接）、普通文件或特殊文件时两种模式均拒绝；既有错误语义保持。该低层函数不替调用方校验全部祖先或品牌 id、不发布对象、不提供事务或模型诊断脱敏；调用方仍拥有这些边界。

records 的 managed path SHALL 保留可信会话 cwd 的文件系统遍历语义：cwd 含现有符号链接后接 `..` 时，SHALL 在拼接规范对象子路径前确定其物理工作区，SHALL NOT 以词法折叠后的另一个工作区代替。该规则同用于规范对象读写/创建、Markdown、patch、TaskCard、StackLock、build 发布及二进制读取，以及报告关联 RunRecord 查找；managed root 自身仍须先经 lstat 拒绝链接/特殊文件。既有 id/kind/record 前置校验、readonly 不创建、可写路径递归创建与排他/原子发布所有权规则 SHALL 保持。

#### Scenario: physical cwd wins over a same-id lexical decoy
- **WHEN** `R/cwd-alias` 指向 `W/child`，调用 cwd 为 `R/cwd-alias/..`，且 `R` 与 `W` 下分别存在同品牌 id、schema-valid 但内容不同的对象
- **THEN** records 读取与写入仅作用于物理工作区 `W`；`R` 中 decoy 的字节与修改时间不变；`W` 的只读目标缺失时仍报告缺失，不回退 `R`

#### Scenario: physical build producer retains owned publication
- **WHEN** 同一 physical-parent cwd 通过 build publisher 接纳 producer，producer 使用收到的临时目录拼接文件，随后成功或失败
- **THEN** producer 文件与最终目录只位于物理 workspace，成功整体发布、失败仅清理本次仍拥有的临时目录；父目录或临时目录被替换时保持原有拒绝/保留外来对象语义

#### Scenario: public directory preflight reuses the canonical implementation
- **WHEN** 从 records built 包根调用 ensureDirectory，分别检查已有目录、readonly 缺失路径、可写缺失嵌套路径与最终链接/普通文件/FIFO
- **THEN** 返回值、错误与文件系统效果和既有内部 helper 一致；readonly 不创建路径，拒绝项不改变其目标内容，根入口声明提供同一个 boolean 返回 API，既有对象读写行为不变

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

#### Scenario: malformed M4 object id never reaches the file system
- **WHEN** 以 `change_id: "../tasks/x"`、`vc_id: "VC-0001"` 或 `build_id: "BUILD-20261102T080000-3F9C"` 作为工具参数或链接值读取对应对象
- **THEN** 返回指出该 id 字段的错误，没有任何以该字符串拼接的路径被 `lstat`、读取或创建

#### Scenario: symlinked M4 object directory fails closed
- **WHEN** 会话 cwd 下的 `changes`、`patches`、`verifications` 或 `builds` 是指向其它目录的符号链接时，调用会写入该目录的工具
- **THEN** 工具返回指出该目录的错误，链接目标内不新增文件

#### Scenario: build directory published as a whole
- **WHEN** 一次构建成功发布 `builds/<build_id>/`
- **THEN** 该目录由 `builds/.tmp-<build_id>/` 整体 rename 得到，`builds/` 下不残留该次的临时目录，目录内各文件未单独经临时文件 rename 写入

#### Scenario: failed build leaves no build directory
- **WHEN** 一次构建在发布前失败
- **THEN** `builds/<build_id>/` 不存在，`builds/.tmp-<build_id>/` 已被删除

#### Scenario: id collision reallocates without overwriting
- **WHEN** `change_create`、`shud_build` 或 `verification_run` 新分配的 id 对应的 `changes/<change_id>.json`、`builds/.tmp-<build_id>/` 或 `verifications/<vc_id>.json` 已存在（例如并发调用分配到同一 id）
- **THEN** 排他创建返回 EEXIST，工具重新分配 id 后写入新对象，已有对象的字节与修改时间不变；连续 4 次分配均冲突时工具返回指出 id 冲突的错误，不写入任何文件

### Requirement: TaskCard transitions
TaskCard 状态 SHALL 只按下表转换；每次转换 SHALL 同时写入表中的 `runtime_phase` 并刷新 `updated_at`：

| 事件 | 前态 | 后态 | `runtime_phase` |
|---|---|---|---|
| `task_create` | — | `planned` | `null` |
| `shud_run(task_id)` 提交成功 | `planned` 或 `running` | `running` | `submitted_job` |
| 「TaskCard reconcile」发现未终态的关联作业 | `planned` | `running` | `submitted_job` |
| `change_create(task_id)` 成功（见「code_change state entry」） | `planned` 或 `running` | `running` | `running_local`（前态 `planned`）；前态 `running` 时不变 |
| `report_generate` 且 closure 谓词成立 | `running`、`planned` 或 `reporting` | `reporting` | `null` |
| `report_submit` 获 `allowed-once` 执行 | `reporting` | `done` | `null` |
| `report_decide(revision_requested)` 获 `allowed-once` 执行 | `reporting` | `planned` | `null` |
| `report_decide(rejected)` 获 `allowed-once` 执行 | `reporting` | `cancelled` | `null` |

`change_create` 成功时前态已为 `running` 的卡片 SHALL 保持 `runtime_phase` 不变（只追加链接，见「TaskCard links」）。`shud_build`、`change_submit` 与 `verification_run` SHALL NOT 改变 TaskCard 的 `status` 或 `runtime_phase`。`awaiting_pi` SHALL 保留在 `status` 枚举中，但自 M3 起只是审批卡挂起期间的瞬时态：审批结果在工具执行之前决定，放行即执行、拒绝即不执行，因此 SHALL NOT 把 `awaiting_pi` 写入 `task.json`；审批卡未放行时 TaskCard SHALL 停在审批前的状态（报告审批为 `reporting`）。`created` SHALL 只作为建卡原子写入前的内存态，SHALL NOT 出现在已写入的 `task.json` 中。SHALL NOT 存在进入 `parked` 或 `blocked` 的转换（两者保留在枚举中）。事件在表外的前态上发生时 SHALL 被拒绝并返回错误，`task.json` SHALL 保持不变。

#### Scenario: run submission moves card to running
- **WHEN** 对 `status: planned` 的 TaskCard 以其 `task_id` 成功提交 `shud_run`
- **THEN** `task.json` 的 `status` 为 `running`、`runtime_phase` 为 `submitted_job`，`updated_at` 晚于提交前的值

#### Scenario: change_create moves planned code_change card to running
- **WHEN** 对 `status: planned` 的 `code_change` TaskCard 以其 `task_id` 成功调用 `change_create`
- **THEN** `task.json` 的 `status` 为 `running`、`runtime_phase` 为 `running_local`，`updated_at` 晚于调用前的值

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
- **WHEN** 对 `status: planned`、`linked_jobs: []` 且注册表中没有该 `task_id` 作业的 `science_assist` TaskCard 调用 `report_generate`，或对 `status: done` 的 TaskCard 执行获放行的 `report_decide`
- **THEN** 前者返回指出无关联作业的 closure 错误，后者返回指出卡片状态的错误；两者 `task.json` 的字节与修改时间不变

#### Scenario: change_create on a closed card rejected
- **WHEN** 对 `status: done` 或 `reporting` 的 `code_change` TaskCard 调用 `change_create`
- **THEN** 工具返回指出卡片状态的错误，`task.json` 的 `status`、`runtime_phase` 与 `linked_changes` 不变

#### Scenario: report regenerated from reporting
- **WHEN** TaskCard 处于 `reporting`，closure 谓词仍成立，再次调用 `report_generate`
- **THEN** 卡片仍为 `reporting`，`linked_reports` 末尾追加新的 `report_id`，`updated_at` 刷新

#### Scenario: transient and unreachable states never written
- **WHEN** 对一张 TaskCard 依次发生表中所有可达事件（含 `change_create` 与获放行或被拒绝的 `change_submit`）
- **THEN** 写入的 `status` 从不为 `awaiting_pi`、`parked`、`blocked` 或 `created`

### Requirement: task_create
`task_create` SHALL 接受必填参数 `type`（`science_assist` 或 `code_change`）、非空 `title`、非空 `question_or_goal`，无 type 缺省值。非法 type（含 `engineering`、`ops`）、缺失/空字段、未知参数或错误根类型 SHALL 返回明确工具错误且不创建文件。`type: code_change` 时 SHALL 在建卡（含创建 `tasks/` 或 `tasks/<task_id>/`）之前观测会话 cwd 下的源检出 `repos/SHUD`：`lstat` 确认其为真实目录（不是符号链接、普通文件或特殊文件），经 core `stack-lock/repository-revision.ts` 导出的单一受控 git runner（env 白名单、不继承 `DMXAPI_KEY`、统一 `-c core.fsmonitor=false`，规则同 change-requests「Source change observation」）确认其为 git 工作树且 `realpath(repos/SHUD) == realpath(git rev-parse --show-toplevel)`（嵌套于外层仓库或指向外来仓库即拒绝），再取 `git rev-parse HEAD`，输出 SHALL 为 40 位小写十六进制，写入卡片 `source_base_commit`。`repos/SHUD` 缺失、不是真实目录、不是 git 工作树、toplevel 不等、git 调用失败或 HEAD 输出不合法时 SHALL 返回指出 `repos/SHUD` 与失败原因的工具错误，SHALL NOT 创建任何文件或目录。该观测只读，SHALL NOT 写入 `repos/` 下任何文件；raw-guard 对 `task_create` 的判定不变（`task_create(code_change)` 只读 HEAD，不经 raw-guard 的 `repos/SHUD` 判定）。`type: science_assist` 时 `source_base_commit` SHALL 为 `null`，SHALL NOT 访问 `repos/`。成功卡片的 `type` SHALL 为参数值，`source_base_commit` 按上文取值，其余固定为 planned、runtime_phase null、reviewer pi、inference_budget `{mode: normal}`、stack_id/data_id null、空 linked_jobs/linked_reports/linked_changes/linked_verifications。created_by/current_owner SHALL 经 policy-gate「Caller role derivation」同一 `readCallerPresetId` 取得当前 preset 投影的非空原值，缺失为 unknown；不能用冻结的创建 header 覆盖当前身份。结果返回 task_id 与 status planned。

调用 SHALL 提供有效会话 cwd；缺少 agent、session 或非空 cwd 时 SHALL 在访问文件系统前返回指出工作区缺失的错误，SHALL NOT 回退宿主进程目录。preset 身份缺失与工作区缺失 SHALL 分别处理。

#### Scenario: create science_assist card
- **WHEN** 模型调用 `task_create`，`type: science_assist`、`title: "ccw 30 天运行"`、`question_or_goal: "跑通 ccw 并生成证据报告"`
- **THEN** 工具结果含 `TASK-…` 格式的 `task_id` 与 `status: planned`，`tasks/<task_id>/task.json` 的 `status` 为 `planned`、`created_by` 与 `current_owner` 为 `coordinator`、`reviewer` 为 `pi`、`inference_budget` 为 `{mode: "normal"}`、`source_base_commit` 为 `null`

#### Scenario: science_assist card does not read the checkout
- **WHEN** 会话 cwd 下 `repos/SHUD` 不存在（或为损坏的符号链接）时以 `type: science_assist` 调用合法的 `task_create`
- **THEN** 建卡成功，`source_base_commit` 为 `null`，`repos/` 未被访问或创建

#### Scenario: create code_change card
- **WHEN** 会话 cwd 下 `repos/SHUD` 为合法 git 检出，模型调用 `task_create`，`type: code_change`、`title: "openMP RHS 切片"`、`question_or_goal: "提交 StrictOMP 切片并经 VerificationCase 判定"`
- **THEN** 工具结果含 `task_id` 与 `status: planned`，`task.json` 的 `type` 为 `code_change`、`runtime_phase` 为 `null`，`linked_jobs`、`linked_reports`、`linked_changes`、`linked_verifications` 均为 `[]`，`source_base_commit` 为 40 位小写十六进制

#### Scenario: code_change card pins the checkout head
- **WHEN** 会话 cwd 下 `repos/SHUD` 为真实目录、是自身 toplevel 的 git 工作树，`git -C repos/SHUD rev-parse HEAD` 为 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，以 `type: code_change` 调用合法的 `task_create`
- **THEN** `task.json` 的 `source_base_commit` 为 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`repos/SHUD` 下文件字节、`git status --porcelain` 输出与 HEAD 均不变

#### Scenario: code_change without checkout rejected
- **WHEN** 以 `type: code_change` 调用合法的 `task_create`，而会话 cwd 下 `repos/SHUD` 不存在、是指向某 git 检出的符号链接、是非 git 目录，或是外层仓库内的普通子目录（`git rev-parse --show-toplevel` 的 realpath 不等于它）
- **THEN** 工具返回指出 `repos/SHUD` 与失败原因的错误，会话 cwd 下不新增 `tasks/` 条目，`repos/` 下不新增或改写文件

#### Scenario: missing or non-science_assist type rejected
- **WHEN** 模型以 `type: engineering` 或 `type: ops` 调用 `task_create`，或省略 `type`
- **THEN** 工具返回错误结果，会话 cwd 下不新增 `tasks/` 条目

#### Scenario: creator without a current preset
- **WHEN** 工具执行上下文具有会话 cwd，但没有有效当前 preset 投影时调用合法的 task_create
- **THEN** 建卡成功，`created_by` 与 `current_owner` 均为 `unknown`

#### Scenario: missing calling workspace
- **WHEN** 工具执行上下文缺少 agent、session 或非空 cwd 时调用合法的 `task_create`
- **THEN** 返回指出工作区缺失的工具错误，不创建任何文件，不使用宿主进程目录

#### Scenario: missing goal or unknown argument
- **WHEN** 模型调用 `task_create` 时省略 `question_or_goal`，或传入 `status: done`
- **THEN** 工具返回错误结果并指出缺失或未知的参数，不创建任何文件

### Requirement: TaskCard links
以某 `task_id` 成功提交的 `shud_run` SHALL 把本次 `job_id` 加入该 TaskCard 的 `linked_jobs`，并把本次提交解析得到的 `stack_id` 与 `data_id` 写入 TaskCard。`report_generate` 成功 SHALL 把新报告的 `report_id` 追加到 `linked_reports`。`change_create` 成功 SHALL 把新 ChangeRequest 的 `change_id` 并入 `linked_changes`；`verification_run` 成功 SHALL 把新 VerificationCase 的 `vc_id` 并入 `linked_verifications`；两者的写入结果均 SHALL 为原链接与新 id 的码点升序去重并集（由写入方保证）。任何工具对 `task.json` 的写入 SHALL 刷新 `updated_at`。`shud_build` 与 `change_submit` SHALL NOT 改写任何链接字段。已有条目 SHALL NOT 被删除或改写。未成功的新提交、报告生成、ChangeRequest 生成或 VerificationCase 生成 SHALL NOT 追加该次操作的新链接；已成功发布的旧作业对账是独立提交点，SHALL NOT 因后续新提交失败而撤销。

`shud_run(task_id)` 的卡片回写顺序 SHALL 为：(1) 校验品牌 id，取得关联 RunJob 列表后，在同步读取—校验—转换—发布边界内读取 TaskCard、校验请求 id 与文件内 id 一致，并先确认状态为 `planned` 或 `running`；其它状态直接拒绝，SHALL NOT 对账或改写卡片。可运行卡再执行「TaskCard reconcile」，仅有变化时原子写回；(2) M2 作业提交（durable，RunJob 携带 `task_id`、`stack_id`、`data_id`）；(3) 重新读取 TaskCard、校验身份与可运行状态、按转换表转换并以 `writeJsonSync` 原子写入，读取与写入之间 SHALL NOT 有 await（沿 M2 RunJob 同步校验/转换/发布边界）。第 (3) 步失败（含卡片在 (1) 与 (3) 之间已离开 `planned|running`）时 `shud_run` SHALL 返回含本次 `run_id` 与"运行已 durable、任务卡回写失败"的工具错误，运行 SHALL NOT 回滚；缺失的链接由后续以该 `task_id` 调用 `shud_run` 或 `report_generate` 时的「TaskCard reconcile」补齐。上述状态检查顺序与独立对账提交点由 #445 的 PI 契约澄清明确，records 纯函数本身不改变。

`change_create(task_id)` SHALL 在写入任何文件之前校验卡片：`task.json` 存在且通过 schema 校验、`type` 为 `code_change`、`status` 为 `planned` 或 `running`；任一不满足（含 `science_assist` 卡）SHALL 返回指出原因的工具错误，SHALL NOT 写入 ChangeRequest、patch 或卡片。校验通过后持久化顺序 SHALL 为：ChangeRequest JSON（`status: proposed`）→ `patches/<change_id>.patch` → TaskCard 回写（`linked_changes` 并入本次 `change_id`，并按「TaskCard transitions」转换状态）。ChangeRequest 写入之后的任一步失败时 `change_create` SHALL 返回含本次 `change_id` 的工具错误，已写入的 ChangeRequest 与 patch 文件 SHALL 保留、SHALL NOT 回滚。`verification_run` SHALL 先原子写入 `verifications/<vc_id>.json`，再并入 `linked_verifications`；VerificationCase 写入失败时 SHALL NOT 追加链接；VerificationCase 已写入而卡片回写失败时 SHALL 返回含本次 `vc_id` 的工具错误，已写入的 VerificationCase SHALL 保留、SHALL NOT 回滚。「TaskCard reconcile」只修复作业链接，系统 SHALL NOT 提供 `linked_changes` 或 `linked_verifications` 的自动修复路径（closure 不扫描目录），回写失败后缺失的链接保持缺失，只能由调用方据错误中的 id 处置。

#### Scenario: card write-back failure keeps the run
- **WHEN** 以 `task_id` 调用 `shud_run`，作业已提交而第 (3) 步写 `task.json` 失败
- **THEN** 工具返回含 `run_id` 与"运行已 durable、任务卡回写失败"的错误，`runs/<run_id>/run-job.json` 存在且其 `task_id` 为该值，活动索引含该作业，卡片 `linked_jobs` 尚不含本次 `job_id`

#### Scenario: job and report linked
- **WHEN** 以 `task_id` 提交一次 `shud_run` 得到 `job_id: JOB-20261027T081000-a1b2`，随后对该卡 `report_generate` 成功得到 `report_id`
- **THEN** `task.json` 的 `linked_jobs` 含该 `job_id`，`stack_id`/`data_id` 为该次 RunJob 中的值，`linked_reports` 含该 `report_id`

#### Scenario: failed submission leaves links unchanged
- **WHEN** 以 `task_id` 调用 `shud_run`，初始对账已完成或为 no-op，而新提交失败（例如 `input_dir` 缺少 `<project>.cfg.para`）
- **THEN** 相对于初始对账完成后的卡片，该次失败提交不改变 `linked_jobs`、`stack_id`、`data_id` 与 `status`，不撤销已成功发布的旧作业修复

#### Scenario: change linked in code point order
- **WHEN** 卡片 `linked_changes` 为 `["CHG-20261102T080000-3f9c"]`，再次 `change_create` 成功得到 `change_id: CHG-20261102T090000-0a1b`
- **THEN** `task.json` 的 `linked_changes` 为 `["CHG-20261102T080000-3f9c", "CHG-20261102T090000-0a1b"]`，无重复条目，原条目未被改写，`updated_at` 晚于调用前的值

#### Scenario: change_create write-back failure keeps the change request
- **WHEN** `change_create` 已写入 `changes/<change_id>.json` 与 `patches/<change_id>.patch`，而写 `task.json` 失败
- **THEN** 工具返回含该 `change_id` 的错误，两个文件仍存在且未被删除，卡片 `linked_changes` 尚不含该 `change_id`；此后任何工具都不会自动把该 `change_id` 补入 `linked_changes`

#### Scenario: change_create on a non-code_change card writes nothing
- **WHEN** 以一张 `science_assist` 卡（或不存在的 `task_id`）调用 `change_create`
- **THEN** 工具返回指出卡片类型（或卡片缺失）的错误，`changes/` 与 `patches/` 不新增文件，`task.json` 字节不变

#### Scenario: failed change_create adds no link
- **WHEN** `change_create` 在写入 ChangeRequest 之前失败（例如工作区源目录没有任何改动）
- **THEN** `task.json` 的 `linked_changes`、`status` 与字节均不变

#### Scenario: verification linked
- **WHEN** 对 `code_change` 卡 `verification_run` 成功得到 `vc_id`
- **THEN** `verifications/<vc_id>.json` 存在，`task.json` 的 `linked_verifications` 为原链接与该 `vc_id` 的码点升序去重并集，`updated_at` 刷新，`status` 与 `runtime_phase` 不变

#### Scenario: verification write-back failure keeps the case
- **WHEN** `verification_run` 已写入 `verifications/<vc_id>.json`，而写 `task.json` 失败
- **THEN** 工具返回含该 `vc_id` 的错误，该文件保留，卡片 `linked_verifications` 不含该 `vc_id` 且不会被自动补齐

#### Scenario: failed verification adds no link
- **WHEN** `verification_run` 因交叉校验失败或 rivqdown 文件缺失而返回工具错误
- **THEN** 不写 `verifications/` 文件，`task.json` 的 `linked_verifications` 与字节不变

#### Scenario: build and submit leave links unchanged
- **WHEN** 对 `code_change` 卡依次成功调用 `shud_build` 与获 `allowed-once` 执行的 `change_submit`
- **THEN** `task.json` 的字节与修改时间不变

### Requirement: TaskCard generated projection
TaskCard 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 TaskCard 段 SHALL 与本 spec 一致，并写明处置：`task_id` 格式由 `TASK-NNNN` 改为品牌格式；`stack_id`/`data_id` 改为品牌 id 或 `null`；`linked_jobs`/`linked_reports` 改为品牌 id 数组；`type` 增加 `code_change`；新增 `linked_changes`（`ChangeId` 数组）与 `linked_verifications`（`VerificationId` 数组），二者缺失时按 `[]` 解析、M3 卡片文件不改写；新增 `source_base_commit`（40 位小写十六进制或 `null`，缺失时按 `null` 解析、M3 卡片文件不改写，`type: code_change` ⇔ 非 `null`）。

#### Scenario: drift detected
- **WHEN** 修改 TaskCard 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projection regenerated
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下 TaskCard 投影的 `task_id` 模式拒绝 `TASK-0001`，`type` 枚举含 `code_change`，且含 `linked_changes` 与 `linked_verifications` 两个品牌 id 数组字段，以及模式为 40 位小写十六进制、可为 `null` 的 `source_base_commit` 字段

## ADDED Requirements

### Requirement: code_change state entry
`code_change` TaskCard 建卡后 SHALL 为 `planned`。它 SHALL 经以下两个事件之一（先到者）进入 `running`：`change_create(task_id)` 成功（`runtime_phase: running_local`），或既有 `shud_run(task_id)` 提交成功/「TaskCard reconcile」（`runtime_phase: submitted_job`）。进入 `running` 后，后到的另一事件按「TaskCard transitions」处理：`shud_run` 提交成功写 `runtime_phase: submitted_job`，`change_create` 成功不改 `status` 与 `runtime_phase`。`change_create` SHALL 只接受 `type: code_change` 且处于 `planned` 或 `running` 的卡片，并在写入任何文件之前校验（见「TaskCard links」）；`science_assist` 卡调用 `change_create` SHALL 被拒绝。`shud_build`、`change_submit` 与 `verification_run` SHALL NOT 使卡片进入或离开任何状态。`code_change` 卡离开 `running` 的途径 SHALL 与 `science_assist` 相同（`report_generate` 且「code_change closure predicate」成立）。

#### Scenario: change_create enters running first
- **WHEN** `planned` 的 `code_change` 卡先成功调用 `change_create`
- **THEN** 卡片为 `running`、`runtime_phase: running_local`

#### Scenario: shud_run enters running first
- **WHEN** `planned` 的 `code_change` 卡先以其 `task_id` 成功提交 `shud_run`（例如 base 运行），之后再成功调用 `change_create`
- **THEN** `shud_run` 后卡片为 `running`、`runtime_phase: submitted_job`；`change_create` 后 `status` 与 `runtime_phase` 不变，`linked_changes` 含新 `change_id`

#### Scenario: science_assist card cannot enter via change_create
- **WHEN** 对 `planned` 的 `science_assist` 卡调用 `change_create`
- **THEN** 工具返回指出卡片类型的错误，卡片仍为 `planned`，`task.json` 字节不变，不写入任何 ChangeRequest 或 patch

#### Scenario: build does not enter running
- **WHEN** `planned` 的 `code_change` 卡成功执行一次无 `change_id` 的 `shud_build`（base 构建）
- **THEN** 卡片仍为 `planned`，`task.json` 的字节与修改时间不变

#### Scenario: verification does not move the card
- **WHEN** `running` 的 `code_change` 卡成功执行 `verification_run`
- **THEN** 卡片仍为 `running`，`runtime_phase` 不变，只有 `linked_verifications` 追加

### Requirement: code_change closure predicate
`code_change` TaskCard 的 closure 谓词 SHALL 在 `report_generate` 中、「TaskCard reconcile」之后、写任何报告文件之前求值，SHALL 只经卡片的 `linked_changes` 与 `linked_verifications` 按品牌 id 定位 ChangeRequest 与 VerificationCase 文件（SHALL NOT 扫描 `changes/` 或 `verifications/` 目录），且仅当以下各条全部成立时成立：
0. `linked_jobs` 非空，且本次 `report_generate` 参数提供的 `observations`、`limitations`、`pi_questions` 各至少一条（`limitations` 按模型传入的条目计数，同「science_assist closure predicate」）；
1. `linked_changes` 中至少一个 ChangeRequest 为 `status: approved`，且其 `patches/<change_id>.patch` 存在、字节的 sha256 等于该 ChangeRequest 的 `patch_sha256`；
2. `linked_verifications` 中至少一个 VerificationCase 的 `change_id` 为满足第 1 条的 ChangeRequest，且其 `status` 为 `passed` 或 `failed`（`failed` 不阻塞 closure：报告必须呈现该失败；`not_run`、`running`、`inconclusive`、`waived_by_pi` 均不满足本条），且该 VerificationCase 的 `base_run_id`/`candidate_run_id` 对应的 RunJob 均在 `linked_jobs` 中：对两者各自，本次 closure 所用的 listRunJobsByTask 结果中 SHALL 存在 `run_id` 等于它的 RunJob，且该 RunJob 的 `job_id` 属于新鲜卡片的 `linked_jobs`（不存在或不属于即本条不成立，错误点名该 `vc_id` 与 `run_id`）；
3. 满足第 2 条的该 VerificationCase 的 `reviewer_notes` 非空且 `reviewed_by` 非空（schema 已保证——不满足的文件按下文文件读取规则视为不可读；列出以对应 Agent_Architecture §7 措辞）；
4. 该 ChangeRequest 的 `semantic_level` 已填（schema 已保证——schema 必填，恒真，列出以对应 Agent_Architecture §7 措辞）；
5. 「science_assist closure predicate」中的运行子句对 `linked_jobs` 同样求值：每个关联作业的 RunJob 处于 `collected` 且有 RunRecord，每个关联 RunRecord 的 `stack_id` 与 `data_id` 非 `null`；关联 RunJob 处于 `failed` 或 `cancelled`、其 RunRecord 的 `status` 为 `failed`（含 `exit_class` 为 `cancelled` 或 `lost`）或其收集已耗尽时不成立，错误子句点名该 `job_id` 与原因。

经链接读取的 ChangeRequest、patch 或 VerificationCase 文件 SHALL 遵循「TaskCard workspace file」的读取规则：缺失、不可解析或校验失败时 `report_generate` SHALL 返回指出该 id 的错误（阻塞 closure），SHALL NOT 改写该文件。ChangeRequest 与 VerificationCase 的 `task_id` SHALL 等于本卡 `task_id`；不等时该文件视为不合格，不能满足第 1–3 条，错误 SHALL 点名该 id。谓词不成立时 `report_generate` SHALL 返回点名未满足子句的工具错误，SHALL NOT 写报告文件，SHALL NOT 改变 TaskCard（reconcile 的回写除外）。系统 SHALL NOT 以 LLM 判断作为 closure 依据。`engineering` 类型的 closure 谓词不在本 requirement 内（该类型仍无生产者）。

#### Scenario: passed verification satisfies closure
- **WHEN** `running` 的 `code_change` 卡链接一个 `approved` ChangeRequest（patch sha256 匹配）、一个 `change_id` 为它且 `status: passed`、`reviewer_notes` 与 `reviewed_by` 非空的 VerificationCase（二者 `task_id` 均为本卡），其两个关联作业均已 `collected` 且 RunRecord 的 `stack_id`/`data_id` 非空，`report_generate` 提供 observations、limitations、pi_questions 各一条
- **THEN** 谓词成立，报告生成成功，卡片变为 `reporting`

#### Scenario: failed verification does not block closure
- **WHEN** 其它条件同上，但该 VerificationCase 为 `status: failed` 且 `failure_reason` 非空
- **THEN** 谓词成立，报告生成成功

#### Scenario: missing job or report inputs block closure
- **WHEN** 其它条件同「passed verification satisfies closure」，但 `linked_jobs` 为空，或 `report_generate` 的 `observations`、`limitations`、`pi_questions` 之一为空数组
- **THEN** `report_generate` 返回点名第 0 条子句的错误，不写报告，TaskCard 不变

#### Scenario: object from another task does not qualify
- **WHEN** 卡片唯一 `approved` ChangeRequest 或唯一相关 VerificationCase 的 `task_id` 为另一张卡的 `task_id`
- **THEN** `report_generate` 返回点名该 `change_id` 或 `vc_id` 不属于本卡的错误，不写报告，该文件字节不变

#### Scenario: no approved change blocks closure
- **WHEN** `linked_changes` 中的 ChangeRequest 全部为 `status: proposed`（例如审批卡被拒绝），或 `linked_changes` 为空
- **THEN** `report_generate` 返回点名第 1 条子句的错误，不写报告，TaskCard 不变

#### Scenario: patch digest mismatch blocks closure
- **WHEN** 唯一 `approved` ChangeRequest 的 `patches/<change_id>.patch` 缺失，或其字节被改动使 sha256 不等于 `patch_sha256`
- **THEN** `report_generate` 返回点名第 1 条子句与该 `change_id` 的错误，不写报告，patch 文件不被改写

#### Scenario: verification for another change blocks closure
- **WHEN** `linked_verifications` 中唯一的 VerificationCase 的 `change_id` 指向一个 `proposed` ChangeRequest 而非 `approved` 的那一个，或 `linked_verifications` 为空
- **THEN** `report_generate` 返回点名第 2 条子句的错误，不写报告

#### Scenario: non-terminal verification blocks closure
- **WHEN** 唯一相关 VerificationCase 的 `status` 为 `inconclusive` 或 `not_run`
- **THEN** `report_generate` 返回点名第 2 条子句的错误，不写报告

#### Scenario: missing reviewer fields block closure
- **WHEN** 唯一相关 VerificationCase 文件 `verifications/<vc_id>.json` 被改写为 `reviewer_notes: []` 或 `reviewed_by: ""`，因而不通过 `VerificationCaseSchema`
- **THEN** `report_generate` 按经链接读取的文件规则返回指出该 `vc_id` 不可读（schema 校验失败）的错误，不写报告，该文件字节不变；错误来自文件读取规则而非第 3 条子句

#### Scenario: verification runs outside linked_jobs block closure
- **WHEN** 其它条件同「passed verification satisfies closure」，但唯一相关 VerificationCase 的 `candidate_run_id`（或 `base_run_id`）对应 RunJob 的 `job_id` 不在卡片 `linked_jobs` 中（例如该运行以另一 `task_id` 或不带 `task_id` 提交）
- **THEN** `report_generate` 返回点名第 2 条子句、该 `vc_id` 与该 `run_id` 的错误，不写报告，TaskCard 除 reconcile 回写外不变

#### Scenario: failed or uncollected run blocks closure
- **WHEN** 卡片某个关联作业仍为 `running`，或其 RunRecord 为 `status: failed`，或其收集已耗尽
- **THEN** `report_generate` 返回点名该 `job_id` 与原因的错误，不写报告，TaskCard 保持原状态

#### Scenario: unreadable linked change fails closed
- **WHEN** `linked_changes` 中某个 `change_id` 对应的 `changes/<change_id>.json` 不可解析
- **THEN** `report_generate` 返回指出该 `change_id` 的错误，不写报告，该文件字节不变

#### Scenario: unlinked files are not discovered
- **WHEN** `verifications/` 目录中存在一个满足第 2、3 条的 VerificationCase 文件，但其 `vc_id` 不在卡片 `linked_verifications` 中
- **THEN** 该文件不参与谓词求值，谓词按卡片链接求值
