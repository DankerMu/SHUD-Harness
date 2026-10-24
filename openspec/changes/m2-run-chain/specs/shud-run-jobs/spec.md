# Spec Delta

## Purpose

定义替换 dsh `jobs-local` 的持久化作业注册表：shud 作业如何落盘、以无 owner 方式在 dsh 登记、并行且脱离宿主运行、在 dsh 重启（SIGTERM/SIGKILL）后对账与接管、结算时自动生成 RunRecord 并经唯一路径至少一次唤醒发起会话、可恢复性不变量如何判定，以及证明这些行为的本机验收脚本与 Epic 收口手工验收。本 spec 中"有效工作目录"与"session cwd"均指 `shud_run` 调用所属会话的 cwd（shud-run-tools「shud_run arguments」）。

## ADDED Requirements

### Requirement: Registry replacement
`shud` profile SHALL 只有一个 `ctx.jobs` 实现，由 `@shud-harness/dsh-shud-jobs` 以插入行 `shud-jobs` 提供；Web 模板的 `jobs-local` 行（id `jobs`）SHALL 被禁用（shud-profile「Profile composition」）。对 `kind` 不是 `shud` 的作业，注册表的行为（登记、owner 与作用域、输出读取、`job_list`/`job_output`/`job_kill`、并发上限、事件路由、owner 释放与 teardown 时取消并等待结算）SHALL 与 `jobs-local` 一致，且 SHALL NOT 跨重启保留；重启后对这些作业 id 的查询仍为 `unknown job`。

#### Scenario: bash background job unchanged
- **WHEN** 模型以 `bash` 的 `run_in_background` 启动 `sleep 1; echo ok`
- **THEN** `job_list` 列出该作业，结束后 `job_output` 返回 `ok`，发起会话按 `tool-jobs` 常规路径被唤醒

#### Scenario: non-shud spec through the registry
- **WHEN** 集成测试经 `ShudJobRegistry` 以有 owner 的非 shud `JobSpec` 启动作业，并分别执行输出读取、kill、超出 `maxConcurrentJobsPerOwner` 的第 N+1 次启动与 owner 释放
- **THEN** 各步的返回值、事件序列与异常与直接使用 `LocalJobRegistry` 时相同，且不产生运行目录或索引条目

#### Scenario: non-shud job not durable
- **WHEN** 一个 `bash` 后台作业运行中 dsh 被重启
- **THEN** 重启后 `job_output` 对该作业 id 报 `unknown job`，不产生运行目录或活动索引条目

### Requirement: Registry configuration
插件行配置 SHALL 为 `LocalJobRegistry.Config` 与 {`stateDir`, `shudBin`} 的并集：父类键（`maxConcurrentJobsPerOwner`、`retainBytes`、`settledRetainBytes`、`pumpPollMs`）沿用父类默认值与校验；`stateDir`（绝对路径，可写目录，不存在时创建）与 `shudBin`（可执行文件绝对路径）为必填。任一必填键缺失、为空、不可写或不可执行，或出现并集之外的键时，插件 apply SHALL 抛出指明配置键的错误，SHALL NOT 回退到任何内置默认值。dsh 不把 `shud-jobs` 行视为必需启动项，因此该行激活失败时 dsh 继续启动、在 stderr 打印该行的激活失败诊断（含错误消息）；此时 `ctx.jobs` 不存在，依赖它的插件行（`tool-jobs`、`shud-tools` 等）不激活，`bash run_in_background` 与 Web 作业卡不可用。

#### Scenario: missing shudBin at apply
- **WHEN** vitest 以缺少 `shudBin` 的配置 apply 注册表插件
- **THEN** apply 抛错且错误消息含 `shudBin`，未注册 `ctx.jobs`

#### Scenario: parent keys accepted, unknown key rejected
- **WHEN** 以 `maxConcurrentJobsPerOwner: 2` 加两个必填键 apply，另以多出 `shudbin` 键的配置 apply
- **THEN** 前者成功且第 3 个并发无 owner 作业的启动按父类规则被拒；后者抛错并指出未知键 `shudbin`

#### Scenario: missing shudBin at real boot
- **WHEN** 以 `shud-jobs` 行 `config` 为有效 `stateDir` 加空 `shudBin` 的 overlay（按 id 的 patch 整体替换 `config`）执行 `dsh --profile shud --patch <overlay> --no-open --port <p>`
- **THEN** stderr 含 `did not activate`、`shud-jobs` 与 `shudBin`，`tool-jobs` 行未激活

### Requirement: State directory lock and indexes
注册表 SHALL 在 apply 时于 `stateDir` 取得排他锁文件 `lock`（记录持有者 pid 与进程启动时间）：锁被另一个存活的 dsh 进程持有（pid 存活且启动时间一致）时 apply SHALL 失败并指明 `stateDir` 与持有者 pid；持有者已不存在或 pid 被复用时 SHALL 视为陈旧锁并接管；注册表释放时 SHALL 删除锁。`stateDir` SHALL 含活动索引 `active.json`（尚未完成唤醒的作业的 `run_id`、`job_id`、运行目录绝对路径）与完成索引 `completed.json`（已离开活动索引的作业的 `run_id`、`job_id` 到运行目录绝对路径的映射），二者 SHALL 以临时文件加 rename 原子写；同一注册表实例内对索引的所有修改 SHALL 串行执行。作业离开活动索引时 SHALL 先写入完成索引再从活动索引移除。

#### Scenario: two concurrent submissions
- **WHEN** 两个会话几乎同时各提交一个 shud 作业
- **THEN** 两个作业都在 `active.json` 中、各有自己的运行目录，二者都进入 `running`

#### Scenario: second process on the same stateDir
- **WHEN** 一个 dsh 进程持有 `stateDir` 锁时，另一个 dsh 进程以同一 `stateDir` 启动
- **THEN** 后者的 `shud-jobs` 行激活失败，诊断含该 `stateDir` 与持有者 pid；前者不受影响

#### Scenario: stale lock reclaimed
- **WHEN** `lock` 记录的 pid 已不存在（前一个 dsh 被 SIGKILL）时启动注册表
- **THEN** apply 成功，`lock` 改为记录当前进程

#### Scenario: process identity differs
- **WHEN** `lock` 中 pid 仍存在，但操作系统报告的进程启动时间与记录不同，且没有注册表持有内核协调锁
- **THEN** 接管成功并记录当前注册表进程，原索引条目不丢失

#### Scenario: concurrent stale takeover
- **WHEN** 两个进程同时尝试接管同一陈旧锁
- **THEN** 至多一个注册表成功 apply，失败者不删除或改写成功者的锁与索引

#### Scenario: completed index precedes active removal
- **WHEN** 完成索引写入成功后、活动索引移除前进程中断
- **THEN** 重启后该条目仍可从完成或活动索引读出，不出现两份索引都缺失的窗口

#### Scenario: mutation failure does not poison the queue
- **WHEN** 一次索引写入失败后，同实例再次提交一个可成功写入的索引修改
- **THEN** 第一位调用者收到错误，后一次修改成功，已提交条目保持存在

#### Scenario: disposal drains admitted mutations
- **WHEN** 注册表释放时仍有已接收的索引修改未完成
- **THEN** 拒绝新修改，等待已接收索引修改完成后才删除 `lock` 并释放索引排他所有权；非 shud 作业的父类 teardown 仍由整体注册表释放等待，行为不变

### Requirement: Shud job submission
`shud_run` 调用期间注册表 SHALL 同步完成提交，顺序为：分配 `job_id`/`run_id`；创建 `<session cwd>/runs/<run_id>/`，创建前后各以 `lstat` 确认 `runs/` 与 `runs/<run_id>` 均为真实目录（不是符号链接）且 `runs/<run_id>` 由本次非递归 `mkdir` 新建；把输入目录完整复制到 `input/<project>/`（M2 恒为完整复制）；有 `end_days` 时只在副本的 `<project>.cfg.para` 中改写 `END`；原子写 `run-job.json`（`status: created`）并加入活动索引；写 `status: submitted`；经父类 `start` 以无 owner、`kind: shud`、label `<run_id>`（有 `label` 时为 `<run_id> <label>`）登记，并把 `stdout.log` 作为输出源——登记前注册表 SHALL 以自身构造时的无作用域上下文经父类 `attachController` 挂载一个全局层控制器，父类 `start` 返回或抛错后立即释放（无 owner 作业只能由全局控制器放行；该控制器 SHALL NOT 常驻），因此登记不依赖 `tool-jobs` 是否挂载或挂在哪一层；包装进程 spawn 后写 `pid`、`pid_started_at` 与 `status: running`。运行目录复核失败、复制失败或父类 `start` 抛错时，注册表 SHALL 删除本次运行目录（含部分副本）与已加入的索引条目，并以说明原因的错误失败，使 `shud_run` 返回工具错误；此时 SHALL NOT 留下 RunJob、RunRecord 或索引条目。SHALL NOT 修改原输入目录。注册表 SHALL 把 `owner_session` 记为调用所属会话 id，`dsh_job_id` 记为本次登记 id 并追加到 `dsh_job_ids`。

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

### Requirement: Concurrent runs
多个 shud 作业 SHALL 可以同时处于 `running`，各自使用独立运行目录；注册表 SHALL NOT 设 shud 专属并发上限或排队。同时活动的无 owner 作业数受父类 `maxConcurrentJobsPerOwner`（无 owner 桶）约束；超出时 `shud_run` SHALL 返回说明已达上限的工具错误，且按「Shud job submission」清理，不排队、不启动 SHUD。

#### Scenario: parallel runs
- **WHEN** 一个作业 `running` 时再提交第二个作业
- **THEN** 第二个作业的 `shud_run` 结果状态为 `running`，两个包装进程同时存在

#### Scenario: limit reached
- **WHEN** `maxConcurrentJobsPerOwner: 1` 且已有一个 shud 作业 `running` 时再调用 `shud_run`
- **THEN** 工具返回含上限说明的错误，不存在新的运行目录、索引条目或 SHUD 进程

### Requirement: Detached execution and exit capture
shud 作业 SHALL 由注册表直接启动的 `/bin/sh` 包装进程运行（不经宿主 subprocess 服务）。包装进程 SHALL 先以"写临时文件再 rename"写出 `wrapper.pid`（自身 pid），再在运行目录内执行 `<shudBin> -o output/<project>.out <project>`，stdout/stderr 分别写入 `stdout.log`/`stderr.log`；SHUD 结束后包装进程 SHALL 以"写临时文件再 rename"写出 `exit_code`；包装进程 SHALL NOT 捕获信号，被 kill 时不写 `exit_code`。`run-job.json` SHALL 记录包装进程 `pid` 与其启动时间。宿主进程退出 SHALL NOT 终止包装进程或 SHUD。

#### Scenario: exit code file
- **WHEN** 以一个立即 `exit 13` 的伪 `shudBin` 运行作业
- **THEN** 运行目录出现内容为 `13` 的 `exit_code` 文件与 `wrapper.pid`，且不存在残留的临时文件

#### Scenario: survives host exit
- **WHEN** 作业运行中宿主进程收到 SIGKILL
- **THEN** 包装进程与 SHUD 继续运行，最终写出 `exit_code`

#### Scenario: immediate exit retains genuine startup identity
- **WHEN** 伪 SHUD 立即退出 0 或 13
- **THEN** 提交仍记录操作系统报告的包装进程 pid 与启动时间并原子写出 schema 有效的 running；包装进程写出对应 exit_code，不以宿主当前时间伪造进程身份

#### Scenario: running persistence precedes submission admission completion
- **WHEN** 包装进程已启动但 running 记录的原子写入尚未完成
- **THEN** run_id 仍在提交在途集合；只有身份与 running 同次写入成功后才移出并返回 running

#### Scenario: rollback drains detached execution before removing files
- **WHEN** 包装进程启动后身份读取或 running 记录写入失败，且同一进程组的子进程仍持有输出文件
- **THEN** 先终止并确认本次执行组不再有可执行 I/O 的成员，再释放登记资源与删除本次目录/索引；不能仅凭登记 done 或包装 shell 退出判定安全；无法确认时保留路径并报告原始及清理错误

#### Scenario: wrapper arguments are not shell program text
- **WHEN** 配置的 SHUD 路径或合法项目名包含空格、引号或 shell 元字符
- **THEN** 包装进程按原始位置参数调用指定可执行文件，不执行输入字符串中的 shell 语法，输出/输入目录仍受已有路径边界约束

#### Scenario: PID publication fails before command invocation
- **WHEN** 包装进程无法创建 wrapper.pid.tmp 或无法将其 rename 为 wrapper.pid
- **THEN** 不调用 SHUD 可执行文件，也不发布 exit_code；不得绕过 PID 发布失败继续运行模型

#### Scenario: native transitional process state during rollback
- **WHEN** 进程组快照含身份字段有效但状态为操作系统暂态未知值的本组成员
- **THEN** 保守视为仍可能执行 I/O，直到后续快照证明静止才清理；不得将未知状态当作空组，格式损坏或无法读取仍须保留路径并报错

#### Scenario: already quiescent wrapper group during abort
- **WHEN** 包装进程已退出但尚未被宿主回收，进程组只剩僵尸或已为空
- **THEN** 依据静止证据完成回收与回滚，不因无需发送的进程组信号导致错误；仍存活成员的真实权限失败不得被吞掉

### Requirement: Cancellation
对 shud 作业的 kill（模型以 `dsh_job_id` 调用 `job_kill`，或 Web 作业卡的 kill）SHALL 先在 `run-job.json` 写 `cancel_requested_at`，再对包装进程组发送 SIGTERM，宽限期（core 常量）后仍存活则 SIGKILL。结算 SHALL 为 first-wins：结算时 `exit_code` 已存在则按退出码结算，否则作业状态置 `cancelled`。被 kill 的作业 SHALL 照常 collect 并按「At-least-once wake」唤醒发起会话。

#### Scenario: kill running job
- **WHEN** 对 `running` 的作业以其 `dsh_job_id` 调用 `job_kill`
- **THEN** SHUD 进程退出，生成 `exit_class: cancelled` 的 RunRecord，发起会话收到一条 `shud-jobs` 唤醒消息

#### Scenario: natural exit wins
- **WHEN** 包装进程已写出内容为 `0` 的 `exit_code` 后、结算前 kill 到达
- **THEN** RunRecord 的 `exit_class` 为 `ok`，不是 `cancelled`

#### Scenario: synchronous durable cancellation admission
- **WHEN** 对已完成提交的 SHUD 登记调用公开 `kill(id, caller, reason)`，或对该运行重复请求 kill
- **THEN** 调用保持宿主同步返回契约，第一次有效请求在发送进程组信号前原子持久化取消时间；重复请求不延后原宽限期限；理由文本不决定 kill 与 teardown 的分类

#### Scenario: cancellation races a terminal snapshot
- **WHEN** 轮询已读取尚无取消标记的快照，公开 kill 随后持久化取消意图，而进程最终消失且未留下退出码
- **THEN** 终态写入保留新取消标记并结算 cancelled，不得以旧快照覆盖标记或误记 lost；producer done 仍在终态持久化之后

#### Scenario: wrapper exits before a resistant descendant
- **WHEN** kill 的 SIGTERM 使包装进程退出，但同一受控进程组中的子进程仍可运行并忽略 SIGTERM
- **THEN** 不因包装进程单独退出而提前完成取消；原宽限期到达后对仍受控且活跃的进程组发送 SIGKILL，并在组静止后按退出文件 first-wins 结算

#### Scenario: cancellation intent cannot be persisted
- **WHEN** 取消前的 RunJob 校验或原子持久化失败
- **THEN** kill 明确失败，不向进程组发信号、不留下进程内 kill 标记，原有证据保持；未知、无权限、提交仍在进行或已关闭准入的请求同样不得越过各自边界写入或发信号

#### Scenario: kill after durable settlement before parent completion
- **WHEN** RunJob 已持久化终态，而异步 producer 完成仍在等待、父登记暂时仍显示 running 时 kill 到达
- **THEN** 同步返回 `already-finished`，不改写 RunJob、不设置取消标记、不发信号、不调用父类 kill；仍为 running 且仅退出文件已存在的请求不受此边界影响

### Requirement: Host teardown keeps shud running
宿主 teardown（SIGTERM 等正常退出、注册表重载，即父类调用 producer `cancel` 而该调用不是由 `kill` 覆写发起）时，注册表 SHALL NOT 终止包装进程，SHALL 在 producer `cancel` 内同步以 `failed` 结束该次 dsh 登记（不依赖已随注册表释放而停止的轮询循环，使父类等待结算的 teardown 不会挂起），`run-job.json` 的 `status` SHALL 保持不变，活动索引条目 SHALL 保留。无 `cancel_requested_at` 时 detail SHALL 说明 shud 在后台继续；已有 `cancel_requested_at`（kill 宽限期内 teardown）时 SHALL 先对包装进程组重发 SIGTERM，detail SHALL 说明 kill 进行中，其余终止与 `cancelled` 结算留给下次启动对账（R7/R8）。该结算 SHALL NOT 触发唤醒，也 SHALL NOT 生成 RunRecord。shud 作业无 owner，owner Agent 释放 SHALL NOT 影响它。

#### Scenario: graceful restart
- **WHEN** 作业 `running` 时 dsh 收到 SIGTERM 并退出
- **THEN** SHUD 进程仍在运行，`run-job.json` 仍为 `running`，运行目录中没有 `run-record.json`

#### Scenario: teardown during kill grace period
- **WHEN** 对 `running` 作业 kill 后、宽限期结束前注册表被释放，且 SHUD 尚未退出
- **THEN** 注册表释放在宽限期内完成而不挂起，该次 dsh 登记以 `failed`（detail 含 kill 进行中）结算，`run-job.json` 仍为 `running` 且保留 `cancel_requested_at`，活动索引条目保留，下次启动按 R8 结算为 `cancelled`

#### Scenario: owner session disposed
- **WHEN** 作业运行中发起会话的 Agent 被释放（会话归档或关闭），宿主保持运行
- **THEN** SHUD 继续运行，结束后轮询循环照常 collect 并经冷恢复唤醒该会话

### Requirement: Startup reconciliation
插件 apply 取得锁后 SHALL 读取活动索引，按（`run-job.json` 的 `status`、`pid`、`pid_started_at`、运行目录中的 `exit_code`）逐条对账。"存活"指 pid 对应进程存在且其启动时间与记录一致；任何判定"不存活"之后 SHALL 再读一次 `exit_code`，仍不存在才判 `lost`。对账表：
- R1 `created` → 结算为 `lost`（从未启动），collect，唤醒；
- R2 `submitted` 且有 `exit_code` → 按退出码结算，collect，唤醒；
- R3 `submitted`、无 `exit_code`、`wrapper.pid` 进程存活且启动时间按 OS 秒级精度不早于 `submitted_at` → 补记 `pid`/`pid_started_at`，置 `running` 并按 R5 接管；
- R4 `submitted` 的其余情形 → 再读 `exit_code`，仍无则 `lost`，collect，唤醒；
- R5 `running`、无 `cancel_requested_at`、无 `exit_code`、存活 → 接管（见「Takeover registration」）；
- R6 `running` 且有 `exit_code` → 按退出码结算，collect，唤醒；
- R7 `running`、无 `exit_code`、不存活 → 再读后仍无则结算为 `lost`（有 `cancel_requested_at` 时为 `cancelled`），collect，唤醒；
- R8 `running`、有 `cancel_requested_at`、无 `exit_code`、存活 → 重发 SIGTERM，按原取消时间的宽限期限升级 SIGKILL，组静止后再读 `exit_code`：数值优先，无则结算为 `cancelled`，collect，唤醒；
- R9 `succeeded`/`failed`/`cancelled`，且已有有效同身份 `run-record.json`，或无 `collect-error.json`，或其 `attempts` 未达上限 → collect；有效已提交记录优先原样返回并修复 `collected` 投影，不受 capped/recent/corrupt 历史 ledger 阻挡、不重新生成或消耗预算；否则沿用生成重试间隔，成功置 `collected`，唤醒；
- R10 `succeeded`/`failed`/`cancelled`，无有效已提交 RunRecord，`collect-error.json` 的 `attempts` 已达上限，`notify.status: pending` → 不再 collect，状态保持不变（无 `run-record.json` 时 SHALL NOT 置 `collected`），只补投递含失败原因的唤醒；
- R11 `collected` 且 `notify.status: pending` → 只补投递唤醒；
- R12 `notify.status` 为 `delivered` 或 `unreachable` → 写入完成索引并移出活动索引。
对账 SHALL NOT 重新 spawn 任何作业，SHALL NOT 含重新入队的情形。对账 SHALL 在每个条目上幂等，重复执行不产生第二份 RunRecord。结算、collect、`notify` 状态与接管登记 SHALL 在 apply 时执行，不依赖 `tool-jobs` 或 `sessionController`；唤醒按「At-least-once wake」的就绪规则投递，此前 `notify.status` 保持 `pending`。

#### Scenario: created never started
- **WHEN** `run-job.json` 为 `created`（宿主在登记前退出），随后 dsh 启动
- **THEN** 生成 `exit_class: lost` 的 RunRecord，运行目录中从未出现 SHUD 进程

#### Scenario: submitted with live wrapper
- **WHEN** `run-job.json` 为 `submitted`、`pid` 为 `null`，`wrapper.pid` 指向仍在运行且启动时间按 OS 秒级精度不早于 `submitted_at` 的包装进程
- **THEN** 对账后 `run-job.json` 为 `running` 且记录该 pid，未启动第二个 SHUD

#### Scenario: submitted without wrapper
- **WHEN** `run-job.json` 为 `submitted`，无 `wrapper.pid`、无 `exit_code`
- **THEN** 作业以 `exit_class: lost` 结算，未重新 spawn

#### Scenario: exited while host down
- **WHEN** 作业在 dsh 停机期间结束并写出 `exit_code` 为 0，随后 dsh 启动
- **THEN** 启动对账生成 `exit_class: ok` 的 RunRecord，发起会话收到一次唤醒

#### Scenario: exit code appears during liveness check
- **WHEN** `running` 作业的进程探测为不存在，而再读时 `exit_code` 已出现且为 19
- **THEN** RunRecord 的 `exit_class` 为 `cvode`，不是 `lost`

#### Scenario: pid reused
- **WHEN** 记录的 pid 存活但其进程启动时间与记录不一致，且两次读取都无 `exit_code`
- **THEN** 作业以 `exit_class: lost` 结算

#### Scenario: kill interrupted by restart
- **WHEN** `running` 作业已有 `cancel_requested_at`，宿主在宽限期内退出且 SHUD 仍存活，随后 dsh 启动
- **THEN** 对账终止该 SHUD，生成 `exit_class: cancelled` 的 RunRecord

#### Scenario: cancelled but not collected
- **WHEN** `run-job.json` 为 `cancelled` 且无 `run-record.json`
- **THEN** 对账生成 `exit_class: cancelled` 的 RunRecord 并唤醒

#### Scenario: crash after record before status
- **WHEN** `run-record.json` 已写出而 `run-job.json` 仍为 `succeeded` 时宿主被 SIGKILL，随后 dsh 启动
- **THEN** 对账返回已有记录且不改写 `run-record.json`（修改时间不变），`run-job.json` 置 `collected`，发起会话收到一次唤醒

#### Scenario: collect limit reached before restart
- **WHEN** `run-job.json` 为 `failed`、`collect-error.json` 的 `attempts` 为 3、无 `run-record.json`、`notify.status` 为 `pending`，随后 dsh 启动
- **THEN** 对账不再 collect，`run-job.json` 仍为 `failed`（不是 `collected`），发起会话收到一条含失败原因的唤醒

#### Scenario: collected but not woken
- **WHEN** `run-job.json` 为 `collected`、`notify.status` 为 `pending`
- **THEN** 对账不改写 `run-record.json`，经 followup 与 flush 投递一次唤醒后才置 `delivered`

#### Scenario: delivered but still indexed
- **WHEN** `notify.status` 为 `delivered` 而条目仍在 `active.json`
- **THEN** 条目出现在 `completed.json` 并从 `active.json` 移除，不再投递

#### Scenario: same-second wrapper start during submitted recovery
- **WHEN** submitted_at 带毫秒，而在可比较时钟域中的真实包装进程出生观测与其属于同一秒
- **THEN** 允许按 R3 恢复该活跃包装进程；能够确定早于提交所在秒的进程不得被接管或接收信号，不确定的原生观测须明确失败

#### Scenario: Linux process identity epoch is not the submission clock
- **WHEN** 真实新包装进程的 Linux lstart 因原生 epoch/时钟刻度量化而早于 realtime submitted_at 所在秒
- **THEN** 保留 lstart 作为 PID 身份令牌，但以可比较的原生进程出生证据作 R3 新鲜度判定，不得误记 lost、硬加时间容差或改用 wrapper.pid 文件时间冒充进程出生

#### Scenario: committed record repair precedes startup generation budget
- **WHEN** 同身份有效 run-record.json 已提交但 RunJob 尚未置 collected，历史 collect-error.json 已达上限、尚在间隔内或损坏
- **THEN** 启动优先原样返回该记录、修复 collected，记录 bytes/mtime 与历史 ledger 不变，不重读退出码或输出生成第二份记录

#### Scenario: recovered cancellation retains original deadline and group ownership
- **WHEN** R8 恢复时确认包装进程身份匹配，其收到 SIGTERM 后先退出而同组后代仍运行并忽略 SIGTERM
- **THEN** 保留已验证组的升级责任，按首次 cancel_requested_at 的原期限发送 SIGKILL并确认组静止；不因 leader 消失提前结算，不因重启延长期限，最终有效退出码仍优先

#### Scenario: startup reconciliation owns readiness and disposal
- **WHEN** 启动对账仍在进行，非严格上下文已能读取服务，或该实例开始释放
- **THEN** 正常轮询与 SHUD 提交/手工轮询/collect 不得抢跑；释放先关闭准入、等待已接受的对账工作再释放 stateDir 锁，之后不得启动新轮询

### Requirement: Takeover registration
对账中接管的作业（R3、R5）SHALL 立即由「Registry poll loop」继续监视，并在 apply 时以「Shud job submission」相同的瞬时全局控制器、无 owner、相同 label 经父类 `start` 重新登记，把新 `dsh_job_id` 写入 `run-job.json` 并追加到 `dsh_job_ids`；SHALL NOT 等待 `tool-jobs` 挂载。登记失败 SHALL NOT 影响轮询循环、collect 与唤醒：`dsh_job_id` 保持 `null`，失败原因经宿主 logger 记录。

#### Scenario: still running after restart
- **WHEN** dsh 重启时作业仍在运行
- **THEN** `job_list` 列出一个新的 `kind: shud` 登记且其 label 含该 `run_id`，`run-job.json` 的 `dsh_job_id` 为该新 id，其结束后照常 collect 与唤醒

### Requirement: Automatic collect
作业进入 `succeeded`、`failed` 或 `cancelled` 时注册表 SHALL 立即 collect：按 run-records spec 生成 RunRecord（含从 `run-job.json` 复制的 `llm.response_model` 与 `llm.response_model_source`）写入 `run-record.json`，作业状态置 `collected`，之后才唤醒。`run-record.json` 已存在时 collect SHALL 返回已有记录而不改写。collect 失败（`exit_code` 不可读或非整数、产物目录不可读、RunRecord 未通过 schema 校验、写文件失败）时 SHALL 写 `collect-error.json`（`attempts`、`last_error`、`at`），作业保持或置为终态（`exit_code` 不可读时为 `failed`），SHALL NOT 写 `run-record.json`；`attempts` 未达 core 常量上限时 SHALL 由「Registry poll loop」在重试间隔后重试（重启后由对账 R9 继续），达到上限后 SHALL 停止自动重试并以失败原因唤醒发起会话。

#### Scenario: collect is idempotent
- **WHEN** 对同一已 collect 的作业再次 collect
- **THEN** 返回与 `run-record.json` 相同的记录，文件修改时间不变

#### Scenario: collect failure is terminal and woken
- **WHEN** `exit_code` 文件内容为 `abc`，三次 collect 均失败
- **THEN** 运行目录有 `collect-error.json` 且 `attempts` 为 3，无 `run-record.json`，`run-job.json` 为 `failed`，发起会话收到一条含失败原因的 `shud-jobs` 唤醒消息，此后不再自动重试

#### Scenario: successful retry retains its error history
- **WHEN** 第一次 collect 失败，重试间隔后第二次成功
- **THEN** run-record.json 存在且符合 core schema，RunJob 为 collected；已有 collect-error.json 的 attempts 仍为 1，内容和修改时间不因成功而改变

#### Scenario: immutable record survives a collected-state write failure
- **WHEN** run-record.json 已原子发布，而紧接着写 RunJob collected 状态失败
- **THEN** 已发布记录保持不变，下一次处理只补状态投影，不改写记录、重新扫描产物或增加生成失败次数

#### Scenario: never-started lost run has no output directory
- **WHEN** 已结算为 lost 的作业从未启动，退出码和求解器产物目录均不存在
- **THEN** collect 生成 exit_code 为 null、exit_class 为 lost 的 RunRecord，产物清单为空，未观测的运行时长和数值指标为 null

#### Scenario: corrupted retry ledger does not reopen the attempt budget
- **WHEN** collect-error.json 的 JSON、字段、attempts 或 at 不合法
- **THEN** 保留该文件内容和修改时间并明确报告错误，不重置计数或启动新的自动 collect 尝试

### Requirement: Registry poll loop
注册表 SHALL 运行**一个**进程内轮询循环，以父类 `pumpPollMs` 为周期遍历活动索引中 `notify.status` 尚未为 `delivered`/`unreachable` 的条目，条目离开活动索引前一直处理，与是否存在 dsh 登记无关。本进程提交在途的条目（`run_id` 在进程内在途集合中：写 `created` 前加入，写出 `running` 或回滚后移出；父类 `start` 同步返回 hooks 后 `pid`、`pid_started_at` 与 `running` 才异步写入）SHALL 被跳过，SHALL NOT 被结算；前一进程遗留的此类条目由「Startup reconciliation」处理。每一轮对每个其余条目按状态推进一步：未终态 → 结算检查（见下）；终态未 collect 且 collect `attempts` 未达上限 → collect（「Automatic collect」的失败重试由此驱动）；已 collect 或 collect 达上限且 `notify.status: pending` → 投递（「At-least-once wake」的暂时性失败重试由此驱动）。collect 与投递的重试 SHALL 在距上次尝试（`collect-error.json` 或 `notify` 的 `at`）不少于 core 常量重试间隔（10 秒，与 `pumpPollMs` 无关）后才进行。同一条目同一时刻 SHALL 至多一个步骤在途。循环与其定时器 SHALL 是注册表上下文的 effect：注册表释放或重载时停止，重载后的新实例先对账再启动自己的循环，SHALL NOT 出现两个循环对同一条目投递。结算检查：出现 `exit_code` 时 SHALL 按退出码结算（`succeeded`/`failed`）；进程不存活时 SHALL 再读一次 `exit_code`，仍无则有 `cancel_requested_at` 时结算为 `cancelled`、否则为 `lost`（`failed`）；kill 与自然退出 first-wins（「Cancellation」）。结算 SHALL 先原子写 `run-job.json` 的终态与 `finished_at`、`exit_code`，再以 producer `done` 结束当前 dsh 登记（如有），再交给「Automatic collect」。

#### Scenario: natural exit settles online
- **WHEN** 宿主在线时伪 `shudBin` 以退出码 13 结束
- **THEN** `run-job.json` 先变为 `failed` 且 `exit_code` 为 13，当前 dsh 登记随之结算，随后进入 collect

#### Scenario: process vanished without exit code
- **WHEN** 宿主在线时包装进程被外部 SIGKILL（未写 `exit_code`），且无 `cancel_requested_at`
- **THEN** 下一次轮询后作业以 `exit_class: lost` 结算并 collect

#### Scenario: in-process retries
- **WHEN** 宿主在线时第一次 collect 因产物目录暂不可读失败、重试间隔内恢复可读，随后第一次投递因 flush 返回失败、重试间隔内恢复
- **THEN** 不经重启即得到 `run-record.json`（`collect-error.json` 的 `attempts` 为 1）与 `notify.status: delivered`（`notify.attempts` 为 1），发起会话恰收到一条唤醒

#### Scenario: poll during in-flight submission
- **WHEN** 提交已写出 `submitted` 与活动索引条目、包装进程已 spawn 但 `pid` 与 `running` 尚未写入时，轮询循环恰好运行一轮
- **THEN** 该条目被跳过，不被结算为 `lost`；随后 `run-job.json` 为 `running`，作业正常结束并 collect

#### Scenario: terminal persistence precedes producer completion
- **WHEN** 在线结算的终态原子写入暂时失败
- **THEN** producer done 尚未结束、原记录保持不变；下一轮成功写入终态后才结束当前登记，其他条目的结算不受影响

#### Scenario: completion retry preserves durable terminal evidence
- **WHEN** 终态已持久化但当前 producer 的完成回调失败
- **THEN** 下一轮重试该完成动作，不改写已有终态的 finished_at 或文件修改时间

#### Scenario: exit publication races liveness inspection
- **WHEN** 首次读取 exit_code 不存在，而确认包装进程不再执行期间退出码文件原子发布
- **THEN** 重新读取到的退出码决定结果，不把作业误判为 lost 或 cancelled

#### Scenario: dispose drains an accepted settlement
- **WHEN** 注册表释放时已有结算步骤处于文件写入中
- **THEN** 立即停止新步骤与定时器，等待该步骤和已接受提交结束后才释放 stateDir 所有权，新实例不能与旧步骤并发写入

#### Scenario: transient failure outlasting several polls
- **WHEN** 投递的 flush 连续失败约 1 秒（远多于 3 个 `pumpPollMs`）后恢复
- **THEN** `notify.attempts` 只增加 1，重试间隔后的下一次尝试成功，`notify.status` 为 `delivered`，不变为 `unreachable`

#### Scenario: no duplicate wake after reload
- **WHEN** 作业已 collect、投递尚未完成时注册表插件被重载
- **THEN** 旧循环停止，新实例对账后投递，发起会话恰收到一条唤醒

### Requirement: At-least-once wake
所有结算路径（宿主在线时自然退出或被 kill、对账补结算、接管作业结束）SHALL 经同一路径唤醒：「Registry poll loop」结算 → collect → `sessionController.resolveAgent(owner_session)` → `agent.followup`（以 `createUserMessage` 构造的用户消息，`source.kind: shud-jobs`，含 `run_id`、`exit_class` 与产物数量，或 collect 失败原因）→ `ctx.sessions.flush` 成功后才把 `notify.status` 置 `delivered` → 写入完成索引并移出活动索引。每个 collect 完成或 collect 失败达上限的作业 SHALL 唤醒一次，没有豁免（含模型 `job_kill` 的作业与 `job_output` 已读到结果的作业）。就绪：投递 SHALL 只在 `sessionController` 与 `sessions` 均可用后开始，注册表以 `ctx.inject(['sessionController', 'sessions'], 回调)` 启动投递，二者 SHALL NOT 成为插件行的启动依赖，投递 SHALL NOT 依赖 `shud-jobs` 行与 `session-controller` 行的相对顺序；注册表 apply 时 `sessionController` 尚不可用期间产生的待投递条目在回调触发后投递。服务缺失本身 SHALL NOT 使条目变为 `unreachable`（宿主无启动完成信号，无法区分"尚未 apply"与"profile 无该行"）：不挂 `session-controller` 的 profile（headless）中条目保持 `notify.status: pending` 并在 `detail` 写明等待会话控制服务。投递开始后，`owner_session` 为 `null` 或会话已不存在时 SHALL 立即置 `notify.status: unreachable` 并记录原因；恢复或 flush 失败等暂时性错误 SHALL 计入 `notify.attempts`，由轮询循环在不少于 core 常量重试间隔后重试（重启后由对账继续），达到 core 常量上限后置 `unreachable`；`unreachable` 后 SHALL NOT 再重试。

#### Scenario: wake while host online
- **WHEN** 宿主在线、发起会话空闲时作业以退出码 0 结束
- **THEN** 发起会话的 session log 恰出现一条来源为 `shud-jobs` 的用户消息（无 `tool-jobs` 完成通知），`notify.status` 为 `delivered`

#### Scenario: wake after restart
- **WHEN** 作业在 dsh 停机期间结束，dsh 启动后对账完成
- **THEN** 发起会话的 session log 出现一条来源为 `shud-jobs` 的用户消息并开启新一轮，`notify.status` 为 `delivered`

#### Scenario: crash before delivered is marked
- **WHEN** followup 与 flush 已完成但 `notify.status` 置位前宿主被 SIGKILL，随后 dsh 启动
- **THEN** 发起会话再收到一条含相同 `run_id` 的唤醒消息，`notify.status` 为 `delivered`

#### Scenario: owner gone
- **WHEN** 发起会话已被删除后对账遇到该作业
- **THEN** `notify.status` 为 `unreachable`，`run-record.json` 存在，下次启动不再尝试唤醒

#### Scenario: session controller not yet available at reconcile
- **WHEN** Web 模板中 dsh 重启，`shud-jobs` 行 apply 时 `sessionController` 尚不可用，对账发现一个停机期间已结束的作业
- **THEN** 该作业 `notify.status` 先为 `pending`，`session-controller` 可用后投递，最终为 `delivered`，发起会话 session log 有一条 `shud-jobs` 消息

#### Scenario: no session controller
- **WHEN** 在不挂载 `session-controller` 的 headless profile 中作业结束
- **THEN** `shud-jobs` 行保持激活，RunRecord 已生成，`notify.status` 保持 `pending` 且 `detail` 指出等待会话控制服务，不变为 `unreachable`

### Requirement: Recoverability invariant
运行时不变量"shud 作业可恢复（SIGTERM/SIGKILL）"SHALL 以以下可观察断言判定，SHALL NOT 以 `job/settled` 事件判定（dsh 不为无 owner 作业写该事件）：对任一在宿主收到 SIGTERM 或 SIGKILL 前已由 `shud_run` 返回 `job_id` 的作业，重启后（1）`run-job.json` 存在且状态只沿「RunJob record」状态机前进；（2）最终存在 `run-record.json` 或 `collect-error.json`；（3）同一运行目录在任一时刻至多一个 SHUD 进程；（4）在挂载 `session-controller` 的 profile 中，`notify.status` 最终为 `delivered`（发起会话 session log 有一条 `source.kind: shud-jobs` 且含该 `run_id` 的用户消息）或带原因的 `unreachable`；（5）在同一前提下，该作业最终出现在 `completed.json` 且不在 `active.json`。注册表集成测试与 `shud:restart` SHALL 断言这五条。

#### Scenario: invariant after SIGKILL
- **WHEN** 作业运行中宿主被 SIGKILL，重启后作业结束
- **THEN** 五条断言全部成立

### Requirement: Restart acceptance script
系统 SHALL 提供本机命令 `pnpm run shud:restart`：在临时 `DSH_HOME` 与临时工作区中，以真实 SHUD 与 ccw 输入依次执行两个用例——作业运行中对 dsh 发送 SIGTERM 后重启、作业运行中对 dsh 发送 SIGKILL 后重启——每个用例 SHALL 判定：重启前后 SHUD 进程连续存活、「Recoverability invariant」五条断言成立且其中第（4）条必须为 `delivered`（脚本控制发起会话的存在，`unreachable` 判 FAIL）、RunRecord 含退出码与非空产物清单。脚本 SHALL 驱动 Web 模板的 dsh（headless 模板不挂 `session-controller`，无法投递唤醒）。判据 SHALL 取自 session log（`tool/result` 中的 `shud_run` 结果与 `shud-jobs` 唤醒消息）与运行目录及 `stateDir` 文件，SHALL NOT 取自模型文本；缺少 SHUD 二进制、dsh 或 `DMXAPI_KEY` 时 SHALL 在开始前非 0 退出。该命令 SHALL 登记进 Verification Matrix（本机，block），运行时不变量的伴生测试 SHALL 进入矩阵，`constraints.yaml` 的对应 review_only 条目 SHALL 移除。

#### Scenario: SIGTERM case
- **WHEN** 执行 `pnpm run shud:restart` 的 SIGTERM 用例
- **THEN** 输出该用例 PASS，运行目录含 `run-record.json`，session log 含重启后的唤醒消息

#### Scenario: missing SHUD binary
- **WHEN** 配置的 SHUD 二进制不存在时执行 `pnpm run shud:restart`
- **THEN** 命令在启动 dsh 前以非 0 退出并指明缺失项

### Requirement: Epic-close manual acceptance
M2 Epic 收口时 PI SHALL 在 `dsh --profile shud` 的 Web 界面亲自完成一次：一句话让 agent 用 `shud_run` 跑 ccw，运行中重启 dsh，完成后会话被唤醒并给出 RunRecord；证据（session log 路径、事件序列摘录、运行目录）记入 `docs/Migration_Plan_dsh.md`。合并子 PR 与关闭实现 issue SHALL NOT 视为该验收通过（`docs/adr/implemented/0007-m2-epic-acceptance.md`）。

#### Scenario: acceptance recorded
- **WHEN** PI 完成该次 Web 验收
- **THEN** `docs/Migration_Plan_dsh.md` 含该会话的 session log 路径、`shud_run` 调用、重启后的唤醒消息与 RunRecord 路径
