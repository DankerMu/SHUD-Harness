# Spec Delta

## MODIFIED Requirements

### Requirement: Shud job submission
`shud_run` 调用期间注册表 SHALL 同步完成提交，顺序为：分配 `job_id`/`run_id`；创建 `<session cwd>/runs/<run_id>/`，创建前后各以 `lstat` 确认 `runs/` 与 `runs/<run_id>` 均为真实目录（不是符号链接）且 `runs/<run_id>` 由本次非递归 `mkdir` 新建；把输入目录完整复制到 `input/<project>/`（M2 恒为完整复制）；有 `end_days` 时只在副本的 `<project>.cfg.para` 中改写 `END`；提交请求携带 `build_id` 时按「Build-referenced execution」解析并校验 `builds/<build_id>/` 的 BuildRecord 与二进制、把二进制原子复制为 `runs/<run_id>/bin/shud`，并把该 BuildRecord 作为 StackLock 采集的构建源（见 stack-lock），未携带时不读取 `builds/`、不创建 `bin/`；采集 StackLock（会话 cwd 下 `stacks/` 已有指纹相等的 lock 时复用其 `stack_id`、不改写该文件，否则以排他创建写 `stacks/<stack_id>.json`，见 stack-lock「Deterministic capture at shud_run submission」），并在同一步骤由副本生成 DataProvenance、在写 `run-job.json` 之前原子写 `provenance/<data_id>.json`（见 data-provenance；`stacks/` 与 `provenance/` 的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则）；原子写 `run-job.json`（`status: created`，其 `stack_id`、`data_id` 为上一步的 id，`task_id` 为提交请求携带的值或 `null`，`build_id`、`threads` 为提交请求携带的值或 `null`，`binary_sha256` 见「Build-referenced execution」）并加入活动索引；写 `status: submitted`；经父类 `start` 以无 owner、`kind: shud`、label `<run_id>`（有 `label` 时为 `<run_id> <label>`）登记，并把 `stdout.log` 作为输出源——登记前注册表 SHALL 以自身构造时的无作用域上下文经父类 `attachController` 挂载一个全局层控制器，父类 `start` 返回或抛错后立即释放（无 owner 作业只能由全局控制器放行；该控制器 SHALL NOT 常驻），因此登记不依赖 `tool-jobs` 是否挂载或挂在哪一层；包装进程 spawn 后写 `pid`、`pid_started_at` 与 `status: running`。运行目录复核失败、复制失败、构建解析或校验失败、构建二进制复制失败、StackLock 采集或 DataProvenance 生成失败，或父类 `start` 抛错时，注册表 SHALL 删除本次运行目录（含部分副本）、已加入的索引条目与本次写入的 DataProvenance 文件，并以说明原因的错误失败，使 `shud_run` 返回工具错误；此时 SHALL NOT 留下 RunJob、RunRecord、索引条目或本次的 DataProvenance 文件。回滚 SHALL NOT 删除 `stacks/` 中的任何 StackLock 文件：被复用的 lock 属于其它运行，本次新写的 lock 是与运行无关的环境记录，可能已被并发提交复用。SHALL NOT 修改原输入目录。注册表 SHALL 把 `owner_session` 记为调用所属会话 id，`dsh_job_id` 记为本次登记 id 并追加到 `dsh_job_ids`。

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

#### Scenario: build-referenced submission records the build
- **WHEN** 以合法 `build_id`（其 BuildRecord 与二进制均有效）和 `threads: 1` 成功提交
- **THEN** `run-job.json` 在 `status: created` 的首次写入中已含该 `build_id`、`threads: 1` 与等于 BuildRecord `binary_sha256` 的 `binary_sha256`，`runs/<run_id>/bin/shud` 存在，最终 `status` 为 `running`

#### Scenario: build failure rolls back before stack capture
- **WHEN** 提交携带的 `build_id` 在会话 cwd 下没有 `builds/<build_id>/build-record.json`
- **THEN** `shud_run` 返回指出该构建的工具错误，`runs/<run_id>/` 不存在，`active.json` 与 `completed.json` 均无该 `run_id`，`stacks/` 与 `provenance/` 下没有本次新文件，不调用 producer

### Requirement: Detached execution and exit capture
shud 作业 SHALL 由注册表直接启动的 `/bin/sh` 包装进程运行（不经宿主 subprocess 服务）。包装进程 SHALL 先以"写临时文件再 rename"写出 `wrapper.pid`（自身 pid），再在运行目录内执行 `<shud 可执行文件> -o output/<project>.out <project>`，其中可执行文件为配置的 `shudBin`，或提交引用构建时经「Build-referenced execution」复制到运行目录的 `<run_dir>/bin/shud` 绝对路径（SHALL NOT 直接执行 `builds/<build_id>/shud`），stdout/stderr 分别写入 `stdout.log`/`stderr.log`；SHUD 结束后包装进程 SHALL 以"写临时文件再 rename"写出 `exit_code`；包装进程 SHALL NOT 捕获信号，被 kill 时不写 `exit_code`。提交携带 `threads` 时，包装进程（因而 SHUD）的环境 SHALL 在宿主环境之上追加 `OMP_NUM_THREADS=<threads>` 与 `SHUD_RHS_THREADS=<threads>`；未携带时 SHALL NOT 设置这两个变量（继承宿主环境中已有的值）。`run-job.json` SHALL 记录包装进程 `pid` 与其启动时间。宿主进程退出 SHALL NOT 终止包装进程或 SHUD。

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

#### Scenario: threads exported to the wrapper environment
- **WHEN** 宿主环境未设置 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS`，以 `threads: 1` 提交一个把自身环境写入输出文件的伪 SHUD；另以不带 `threads` 的同一伪 SHUD 提交
- **THEN** 前者记录的环境含 `OMP_NUM_THREADS=1` 与 `SHUD_RHS_THREADS=1`；后者记录的环境不含这两个变量

#### Scenario: wrapper executes the run-local binary copy
- **WHEN** 以合法 `build_id` 提交一个把自身 `$0` 写入输出文件的伪 SHUD
- **THEN** 记录的 `$0` 为 `<run_dir>/bin/shud` 的绝对路径，而不是 `builds/<build_id>/shud`

## ADDED Requirements

### Requirement: Build-referenced execution
提交请求 SHALL 可携带可选 `build_id`（品牌 `BuildId`）与可选 `threads`（正整数），二者由 `shud_run` 校验后传入；注册表 SHALL 在任何文件系统操作之前再次以 core 品牌 schema 校验 `build_id`、以正整数校验 `threads`，非法值 SHALL 以说明原因的错误失败且不创建运行目录。携带 `build_id` 时，注册表 SHALL 在输入复制（含 `END` 改写）之后、StackLock 采集之前依次执行：(1) 读取 `<session cwd>/builds/<build_id>/build-record.json`，路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则（`builds/`、`builds/<build_id>/` 与记录文件均以 `lstat` 确认不是符号链接），经 core BuildRecord schema 校验，文件内 `build_id` SHALL 等于请求值；(2) BuildRecord 的 `task_id` SHALL 等于本次请求的 `task_id`，或本次请求未携带 `task_id`；(3) `builds/<build_id>/shud` SHALL 为普通文件（`lstat`，不是符号链接）且对宿主进程可执行，其内容 sha256 SHALL 等于 BuildRecord 的 `binary_sha256`；(4) 把该文件复制为运行目录内的 `<run_dir>/bin/shud`：先在 `<run_dir>/bin/` 写临时文件，再 rename 为 `shud`，最终权限 SHALL 为 `0755`，副本内容 sha256 SHALL 等于 BuildRecord 的 `binary_sha256`；(5) 以该副本的绝对路径替代配置的 `shudBin` 作为包装进程执行的 SHUD 可执行文件（见「Detached execution and exit capture」），提交后 `builds/<build_id>/shud` 的变化 SHALL NOT 影响本次运行；并把已校验的 BuildRecord 交给 StackLock 采集作为构建源（`repos.SHUD` 与 `build_id` 的记录及指纹规则见 stack-lock）。任一步失败（含复制、rename、权限设置或副本校验失败）时 SHALL 按「Shud job submission」的回滚规则以指明失败检查项（含 `build_id`）的错误失败：不留运行目录、索引条目或本次 DataProvenance 文件，SHALL NOT 调用 producer、SHALL NOT 启动包装进程。注册表 SHALL NOT 创建、修改或删除 `builds/` 下的任何文件或目录。携带 `threads` 时包装进程环境追加 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS`（见「Detached execution and exit capture」）。RunJob SHALL 在 `status: created` 的首次写入中记录 `build_id`、`threads`（各为请求值或 `null`）与 `binary_sha256`（`build_id` 非 null 时为 BuildRecord 的 `binary_sha256`，否则为 `null`；非 null 当且仅当 `build_id` 非 null），后续状态写入与 collect SHALL 原样继承（字段契约见 run-records「RunJob record」）。未携带 `build_id` 时 SHALL NOT 读取或访问 `builds/`、SHALL NOT 创建 `<run_dir>/bin/`，执行配置的 `shudBin`；此时与 build/threads 相关的行为（二进制选择、包装进程执行与线程环境）与引入本要求之前相同（执行与二进制选择逐字节不变），但提交路径本身不是逐字节不变：无 `build_id` 的提交同样按 data-provenance「Provenance generation at submission」解析副本中的 `<project>.tsd.forc` 生成 `sources.external_files`（ccw 为 `[]`），`tsd.forc` 缺失或解析失败是新的提交失败点并按「Shud job submission」回滚；未携带 `threads` 时 SHALL NOT 设置上述两个环境变量。

#### Scenario: build binary replaces configured shudBin
- **WHEN** 配置 `shudBin` 为一个立即 `exit 13` 的伪 SHUD，`builds/<build_id>/shud` 为一个立即 `exit 0` 的可执行文件且其 sha256 与 BuildRecord 的 `binary_sha256` 相同，以该 `build_id` 提交
- **THEN** 运行目录的 `exit_code` 为 `0`，`<run_dir>/bin/shud` 为权限 `0755`、sha256 等于 `binary_sha256` 的普通文件，不存在残留临时文件，`run-job.json` 的 `build_id` 为该 id、`binary_sha256` 为 BuildRecord 的值

#### Scenario: binary hash mismatch rolls back
- **WHEN** `builds/<build_id>/shud` 在构建后被改写，其 sha256 不等于 BuildRecord 的 `binary_sha256` 时以该 `build_id` 提交
- **THEN** 提交失败并指出 sha256 不匹配，`runs/<run_id>/` 不存在，活动与完成索引均无该 `run_id`，不启动包装进程，`builds/<build_id>/` 字节不变

#### Scenario: unsafe or non-executable binary rejected
- **WHEN** `builds/<build_id>/shud` 为指向有效可执行文件的符号链接、目录，或无执行权限的普通文件时以该 `build_id` 提交
- **THEN** 提交失败并指出 `builds/<build_id>/shud` 的失败检查项，不留运行目录或索引条目，不读取符号链接目标

#### Scenario: invalid build record rejected
- **WHEN** `build-record.json` 无法通过 BuildRecord schema、文件内 `build_id` 与目录名不同，或 `builds/<build_id>` 为符号链接时以该 `build_id` 提交
- **THEN** 提交失败并指出 `build_id` 与失败原因，不留运行目录、索引条目或本次 DataProvenance 文件，`stacks/` 下无新文件

#### Scenario: build belongs to another task
- **WHEN** BuildRecord 的 `task_id` 为 `TASK-A`，提交请求携带 `task_id: TASK-B` 与该 `build_id`
- **THEN** 提交失败并指出 `task_id` 不相容，不留运行目录或索引条目

#### Scenario: unlinked submission may reference a task build
- **WHEN** BuildRecord 的 `task_id` 为 `TASK-A`，提交请求不带 `task_id` 而携带该 `build_id`，其余校验均通过
- **THEN** 提交成功，`run-job.json` 的 `task_id` 为 `null`、`build_id` 为该 id

#### Scenario: no build_id never touches builds
- **WHEN** 会话 cwd 下 `builds/` 为损坏的符号链接或不存在，提交请求不带 `build_id`
- **THEN** 提交照常成功，执行配置的 `shudBin`，`run-job.json` 的 `build_id` 与 `binary_sha256` 均为 `null`，运行目录内没有 `bin/`，`builds/` 未被创建或访问

#### Scenario: no-build submission still parses tsd.forc
- **WHEN** 不带 `build_id` 与 `threads` 提交一个输入副本缺少 `<project>.tsd.forc` 的项目
- **THEN** 提交失败并指出 `tsd.forc`，`runs/<run_id>/` 不存在，活动与完成索引均无该 `run_id`，不启动包装进程；同一项目补齐合法 `tsd.forc` 后提交成功，执行配置的 `shudBin` 且环境不新增 `OMP_NUM_THREADS` 或 `SHUD_RHS_THREADS`

#### Scenario: binary copy failure rolls back
- **WHEN** BuildRecord 与 `builds/<build_id>/shud` 校验均通过，但写入 `<run_dir>/bin/` 临时文件或 rename 为 `bin/shud` 失败
- **THEN** 提交失败并指出复制失败，`runs/<run_id>/`（含 `bin/`）不存在，活动与完成索引均无该 `run_id`，`stacks/` 与 `provenance/` 下无本次新文件，不启动包装进程，`builds/<build_id>/` 字节不变

#### Scenario: later change to the build binary does not affect a submitted run
- **WHEN** 以合法 `build_id` 提交成功后，`builds/<build_id>/shud` 被改写或删除
- **THEN** 本次运行仍执行 `<run_dir>/bin/shud`，其 sha256 仍等于 `run-job.json` 的 `binary_sha256`

#### Scenario: thread selection is independent of build selection
- **WHEN** a submission omits build_id but supplies threads 2 while the host has different OMP_NUM_THREADS and SHUD_RHS_THREADS values
- **THEN** it executes configured shudBin without accessing builds or creating bin, records build_id/binary_sha256 as null and threads as 2, and the wrapper receives both thread variables as "2"; unrelated host variables and the parent environment remain unchanged

#### Scenario: omitted threads preserve inherited values
- **WHEN** a submission omits threads and the host already defines the two thread environment variables
- **THEN** the wrapper inherits those values without overriding them, while RunJob and RunRecord record threads as null

#### Scenario: accepted binary preparation drains before ownership release
- **WHEN** registry disposal begins while an admitted build binary copy or its rollback is still in progress
- **THEN** new admission is closed and stateDir ownership is not released until the accepted preparation and safe rollback or publication have completed
