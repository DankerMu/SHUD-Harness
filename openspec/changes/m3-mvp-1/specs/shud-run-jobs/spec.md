# Spec Delta

## MODIFIED Requirements

### Requirement: Registry configuration
插件行配置 SHALL 为 `LocalJobRegistry.Config` 与 {`stateDir`, `shudBin`, `stackRepos.SHUD`, `stackRepos.rSHUD`, `stackRepos.AutoSHUD`, `sundialsRoot`, `hostVersion`, `llm.base_url`, `llm.request_alias`} 的并集：父类键（`maxConcurrentJobsPerOwner`、`retainBytes`、`settledRetainBytes`、`pumpPollMs`）沿用父类默认值与校验；`stateDir`（绝对路径，可写目录，不存在时创建）与 `shudBin`（可执行文件绝对路径）为必填；StackLock 采集键 `stackRepos.SHUD`、`stackRepos.rSHUD`、`stackRepos.AutoSHUD`（绝对路径）、`hostVersion`、`llm.base_url`、`llm.request_alias`（非空字符串）为必填，`sundialsRoot`（绝对路径）为可选，缺省时 StackLock 的 `runtime.sundials_version` 为 `null`（见 stack-lock「Deterministic capture at shud_run submission」）。任一必填键缺失、为空、不可写或不可执行，或出现并集之外的键时，插件 apply SHALL 抛出指明配置键的错误，SHALL NOT 回退到任何内置默认值。dsh 不把 `shud-jobs` 行视为必需启动项，因此该行激活失败时 dsh 继续启动、在 stderr 打印该行的激活失败诊断（含错误消息）；此时 `ctx.jobs` 不存在，依赖它的插件行（`tool-jobs`、`shud-tools` 等）不激活，`bash run_in_background` 与 Web 作业卡不可用。

#### Scenario: missing shudBin at apply
- **WHEN** vitest 以缺少 `shudBin` 的配置 apply 注册表插件
- **THEN** apply 抛错且错误消息含 `shudBin`，未注册 `ctx.jobs`

#### Scenario: parent keys accepted, unknown key rejected
- **WHEN** 以 `maxConcurrentJobsPerOwner: 2` 加两个必填键 apply，另以多出 `shudbin` 键的配置 apply
- **THEN** 前者成功且第 3 个并发无 owner 作业的启动按父类规则被拒；后者抛错并指出未知键 `shudbin`

#### Scenario: missing capture key at apply
- **WHEN** vitest 以缺少 `stackRepos.AutoSHUD`、`hostVersion` 或 `llm.request_alias` 的配置 apply 注册表插件
- **THEN** apply 抛错且错误消息含缺失的配置键，未注册 `ctx.jobs`

#### Scenario: sundialsRoot is optional
- **WHEN** 以除 `sundialsRoot` 外全部必填键齐全的配置 apply 注册表插件
- **THEN** apply 成功

#### Scenario: missing shudBin at real boot
- **WHEN** 以 `shud-jobs` 行 `config` 为安装时的完整配置（有效 `stateDir` 与全部 StackLock 采集键）、仅把 `shudBin` 置空的 overlay（按 id 的 patch 整体替换 `config`，故 `shudBin` 是唯一缺失项）执行 `dsh --profile shud --patch <overlay> --no-open --port <p>`
- **THEN** stderr 含 `did not activate`、`shud-jobs` 与 `shudBin`，`tool-jobs` 行未激活

### Requirement: Shud job submission
`shud_run` 调用期间注册表 SHALL 同步完成提交，顺序为：分配 `job_id`/`run_id`；创建 `<session cwd>/runs/<run_id>/`，创建前后各以 `lstat` 确认 `runs/` 与 `runs/<run_id>` 均为真实目录（不是符号链接）且 `runs/<run_id>` 由本次非递归 `mkdir` 新建；把输入目录完整复制到 `input/<project>/`（M2 恒为完整复制）；有 `end_days` 时只在副本的 `<project>.cfg.para` 中改写 `END`；采集 StackLock（会话 cwd 下 `stacks/` 已有指纹相等的 lock 时复用其 `stack_id`、不改写该文件，否则以排他创建写 `stacks/<stack_id>.json`，见 stack-lock「Deterministic capture at shud_run submission」），并在同一步骤由副本生成 DataProvenance、在写 `run-job.json` 之前原子写 `provenance/<data_id>.json`（见 data-provenance；`stacks/` 与 `provenance/` 的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则）；原子写 `run-job.json`（`status: created`，其 `stack_id`、`data_id` 为上一步的 id，`task_id` 为提交请求携带的值或 `null`）并加入活动索引；写 `status: submitted`；经父类 `start` 以无 owner、`kind: shud`、label `<run_id>`（有 `label` 时为 `<run_id> <label>`）登记，并把 `stdout.log` 作为输出源——登记前注册表 SHALL 以自身构造时的无作用域上下文经父类 `attachController` 挂载一个全局层控制器，父类 `start` 返回或抛错后立即释放（无 owner 作业只能由全局控制器放行；该控制器 SHALL NOT 常驻），因此登记不依赖 `tool-jobs` 是否挂载或挂在哪一层；包装进程 spawn 后写 `pid`、`pid_started_at` 与 `status: running`。运行目录复核失败、复制失败、StackLock 采集或 DataProvenance 生成失败，或父类 `start` 抛错时，注册表 SHALL 删除本次运行目录（含部分副本）、已加入的索引条目与本次写入的 DataProvenance 文件，并以说明原因的错误失败，使 `shud_run` 返回工具错误；此时 SHALL NOT 留下 RunJob、RunRecord、索引条目或本次的 DataProvenance 文件。回滚 SHALL NOT 删除 `stacks/` 中的任何 StackLock 文件：被复用的 lock 属于其它运行，本次新写的 lock 是与运行无关的环境记录，可能已被并发提交复用。SHALL NOT 修改原输入目录。注册表 SHALL 把 `owner_session` 记为调用所属会话 id，`dsh_job_id` 记为本次登记 id 并追加到 `dsh_job_ids`。

为保持原输入不变，提交预检 SHALL 在创建运行目录或采集证据之前拒绝 `stacks/` 或 `provenance/` 写入根等于或位于已解析原始输入树内的布局；已存在的写入根 SHALL 使用 native realpath 的实际物理拼写，不能因输入符号链接或大小写别名漏检。输入仅位于写入根的子目录而发布位置不在输入树内时，SHALL NOT 仅据该反向包含关系拒绝；既有 StackLock 文件枚举等独立校验保持不变。

#### Scenario: input copied and END patched
- **WHEN** 以 `SHUD/input/ccw` 为输入、`end_days: 30` 提交
- **THEN** `runs/<run_id>/input/ccw/ccw.cfg.para` 的 `END` 为 30，原 `SHUD/input/ccw/ccw.cfg.para` 字节不变，`run-job.json` 存在且 `status` 为 `running`

#### Scenario: copy failure leaves nothing
- **WHEN** 复制过程中某个输入文件不可读
- **THEN** `shud_run` 返回指出该文件的工具错误，`runs/<run_id>/` 不存在，`active.json` 与 `completed.json` 均无该 `run_id`

#### Scenario: symlinked runs directory rejected
- **WHEN** `<session cwd>/runs` 是指向任意目录的符号链接时调用 `shud_run`
- **THEN** 工具返回指出 `runs/` 为符号链接的错误，链接目标内没有新建目录

#### Scenario: input root alias without internal links
- **WHEN** `input_dir` 本身为指向有效项目目录的符号链接，解析后的目录内部只有普通文件和目录
- **THEN** 复制解析后的输入内容，原目录和链接目标的字节均不因提交而改变

#### Scenario: unsafe input entry rejected before claiming a run
- **WHEN** 输入树内部含符号链接、FIFO 或其它非普通文件/目录条目
- **THEN** 提交指出该条目的相对路径并失败，不创建运行目录，不读取符号链接目标或特殊文件内容

#### Scenario: accepted submission drains before state ownership release
- **WHEN** 注册表释放时，某个已接收提交正停在复制或记录写入期间
- **THEN** 拒绝新提交，等待该提交完成或回滚后才释放 stateDir 所有权；不得因 submitted 状态的在途 id 尚未进入 running 而永久等待

#### Scenario: registry state directory overlaps original input
- **WHEN** 会话工作区与输入目录分离，但注册表 stateDir 位于输入目录内或与其相同
- **THEN** 提交在创建运行目录或修改索引之前拒绝，指出 stateDir 重叠，原输入及已有索引字节不变

#### Scenario: job output streams log
- **WHEN** 作业运行中模型以 `shud_run` 返回的 `dsh_job_id` 调用 `job_output`
- **THEN** 返回 `stdout.log` 中自上次读取后新增的内容

#### Scenario: only preset-scoped tool-jobs
- **WHEN** 装配中唯一的外部控制器是在某个 preset 作用域内挂载的 `tool-jobs`（Web 模板形态）时提交 shud 作业
- **THEN** 提交成功；该 preset 内的 `job_list` 列出此作业，以其 `dsh_job_id` 调用 `job_output` 与 `job_kill` 成功；提交返回后全局层没有残留控制器

#### Scenario: no resident global controller
- **WHEN** 提交过 shud 作业后，一个所在组合未挂载任何控制器的 Agent 以有 owner 的非 shud `JobSpec` 调用 `start`
- **THEN** 与 `jobs-local` 相同，抛出 `no job controller serves this agent`

#### Scenario: submission records stack and data ids
- **WHEN** 以 `task_id` 成功提交一次 shud 作业
- **THEN** `stacks/<stack_id>.json` 与 `provenance/<data_id>.json` 存在且通过各自 schema，`run-job.json` 的 `stack_id`、`data_id`、`task_id` 与之对应，且这三者在 `status: created` 的首次写入中已出现

#### Scenario: capture failure rolls back without touching locks
- **WHEN** `stacks/` 中已有一个指纹与本次环境相等的 lock，而 DataProvenance 写入失败
- **THEN** `shud_run` 返回工具错误，`runs/<run_id>/` 不存在，`active.json` 与 `completed.json` 均无该 `run_id`，`provenance/` 下没有本次文件，已有 lock 的字节与修改时间不变

#### Scenario: start failure removes provenance but keeps the lock
- **WHEN** 采集与生成成功后父类 `start` 抛错
- **THEN** 运行目录、索引条目与本次 `provenance/<data_id>.json` 被删除，`stacks/` 中的 lock 文件保留

#### Scenario: capture destination overlaps original input
- **WHEN** 有效项目输入根为工作区 stacks 或 provenance，直接传入或经输入链接/文件系统大小写别名传入
- **THEN** 在提交副作用前拒绝，原输入成员与字节、工作区、索引和 state 文件不变，不调用 producer

#### Scenario: disjoint or nested input is not an overlap
- **WHEN** 输入为 stacks-input、provenance-input 或 provenance 的子目录，而写入根不在原输入树内
- **THEN** 不因 capture-root/input 包含判据拒绝，沿既有复制、采集与提交契约执行；不绕过其它既有路径/记录校验

## ADDED Requirements

### Requirement: Run jobs by task query
注册表 SHALL 公开后端 API `listRunJobsByTask(task_id: TaskId): Promise<RunJob[]>`，供 `shud-tools` 的 task-cards「TaskCard reconcile」使用：入参 SHALL 先经 `TaskId` 品牌 schema 校验，未通过即拒绝且不读盘；随后遍历活动索引与完成索引的全部条目，按与 `collectShud` 相同的运行路径与身份校验读取每个条目的 `run-job.json` 并经 core RunJob schema 校验，返回其中 `task_id` 等于入参的 RunJob，按 `job_id` 码点升序排列；没有匹配时返回空数组。任一条目的运行路径或身份校验失败、`run-job.json` 不可读或未通过 schema 校验时，SHALL 以指出该 `run_id` 的错误拒绝（fail-closed），SHALL NOT 跳过该条目或改写任何文件。它只读、不经逐条目队列写入、不改变索引；与 `collectShud` 相同，在启动对账完成并就绪之前及关闭准入之后 SHALL 明确拒绝。会话 cwd 不参与查找，未进入索引的磁盘记录不被返回。

查询 SHALL 保持现有 drain-before-unlock 生命周期：已接纳的异步只读查询在 stateDir 所有权释放前结束或失败，关闭后的新查询立即拒绝；查询失败 SHALL NOT 使清理跳过释放步骤。completed 先发布、active 尚未移除的合法窗口内，同一运行身份可能同时存在两份索引快照中；查询 SHALL 按 active 优先处理同一身份并仅返回一次，不改变索引迁移顺序或掩盖不一致身份。

#### Scenario: jobs of one task are listed from both indexes
- **WHEN** 同一 `task_id` 有一个已 `collected`（完成索引）与一个 `running`（活动索引）的作业，另有一个 `task_id: null` 的作业
- **THEN** `listRunJobsByTask(task_id)` 恰返回前两个 RunJob，按 `job_id` 码点升序

#### Scenario: unknown task yields an empty list
- **WHEN** 以没有任何作业的合法 `task_id` 调用
- **THEN** 返回空数组，不写任何文件

#### Scenario: malformed task id is rejected
- **WHEN** 以 `"TASK-0001"` 调用
- **THEN** 调用以指出 `task_id` 的错误拒绝，不读取任何 `run-job.json`

#### Scenario: corrupt indexed record fails closed
- **WHEN** 某个已索引条目的 `run-job.json` 不是合法 JSON 时调用
- **THEN** 调用以指出该 `run_id` 的错误拒绝，该文件字节不变

#### Scenario: not ready before startup reconciliation
- **WHEN** 注册表的启动对账尚未完成时调用
- **THEN** 调用被明确拒绝，与此时的 `collectShud` 相同

#### Scenario: duplicate index migration returns one run
- **WHEN** 同一运行的 completed 条目已发布、active 移除尚在等待，查询该任务
- **THEN** 同一 run_id/job_id/run_dir 只返回一份经校验的 RunJob，查询不修改任一索引

#### Scenario: corrupt unrelated run also rejects
- **WHEN** 已索引的其它任务记录损坏，目标任务本身有有效记录或没有匹配记录
- **THEN** 查询整体拒绝并指出损坏条目的 run_id，不返回部分结果或跳过该条目，原文件不变

#### Scenario: accepted readonly query drains before unlock
- **WHEN** 已接纳查询停在记录读取，注册表开始关闭，且该读取稍后成功或失败
- **THEN** 新查询立即拒绝，stateDir 所有权保持至已接纳读取结束；读取失败不阻止正常清理释放，查询不加入逐条目写队列
