# Spec Delta

## MODIFIED Requirements

### Requirement: Shud job submission
`shud_run` 调用期间注册表 SHALL 同步完成提交，顺序为：分配 `job_id`/`run_id`；创建 `<session cwd>/runs/<run_id>/`，创建前后各以 `lstat` 确认 `runs/` 与 `runs/<run_id>` 均为真实目录（不是符号链接）且 `runs/<run_id>` 由本次非递归 `mkdir` 新建；把输入目录完整复制到 `input/<project>/`（M2 恒为完整复制）；绑定 plan 的提交随即按下文「输入摘要核对」核对副本；有 `end_days` 时在副本的 `<project>.cfg.para` 中改写 `END`；随后按下文「副本重写」对副本确保 `DT_YE_IC`、在绑定 plan 时改写 `NUM_OPENMP`，并在提交请求携带 calib 覆盖时改写 `<project>.cfg.calib`；提交请求携带 `build_id` 时按「Build-referenced execution」解析并校验 `builds/<build_id>/` 的 BuildRecord 与二进制、把二进制原子复制为 `runs/<run_id>/bin/shud`，并把该 BuildRecord 作为 StackLock 采集的构建源（见 stack-lock），未携带时不读取 `builds/`、不创建 `bin/`；采集 StackLock（会话 cwd 下 `stacks/` 已有指纹相等的 lock 时复用其 `stack_id`、不改写该文件，否则以排他创建写 `stacks/<stack_id>.json`，见 stack-lock「Deterministic capture at shud_run submission」），并在同一步骤由副本生成 DataProvenance、在写 `run-job.json` 之前原子写 `provenance/<data_id>.json`（见 data-provenance；`stacks/` 与 `provenance/` 的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则）；原子写 `run-job.json`（`status: created`，其 `stack_id`、`data_id` 为上一步的 id，`task_id` 为提交请求携带的值或 `null`，`build_id`、`threads` 为提交请求携带的值或 `null`，`binary_sha256` 见「Build-referenced execution」，`analysis_plan_id`、`parameter_set_id` 为提交请求携带的值或 `null`）并加入活动索引；写 `status: submitted`；经父类 `start` 以无 owner、`kind: shud`、label `<run_id>`（有 `label` 时为 `<run_id> <label>`）登记，并把 `stdout.log` 作为输出源——登记前注册表 SHALL 以自身构造时的无作用域上下文经父类 `attachController` 挂载一个全局层控制器，父类 `start` 返回或抛错后立即释放（无 owner 作业只能由全局控制器放行；该控制器 SHALL NOT 常驻），因此登记不依赖 `tool-jobs` 是否挂载或挂在哪一层；包装进程 spawn 后写 `pid`、`pid_started_at` 与 `status: running`。运行目录复核失败、复制失败、输入摘要核对失败、副本重写失败、构建解析或校验失败、构建二进制复制失败、StackLock 采集或 DataProvenance 生成失败，或父类 `start` 抛错时，注册表 SHALL 删除本次运行目录（含部分副本）、已加入的索引条目与本次写入的 DataProvenance 文件，并以说明原因的错误失败，使 `shud_run` 返回工具错误；此时 SHALL NOT 留下 RunJob、RunRecord、索引条目或本次的 DataProvenance 文件。回滚 SHALL NOT 删除 `stacks/` 中的任何 StackLock 文件：被复用的 lock 属于其它运行，本次新写的 lock 是与运行无关的环境记录，可能已被并发提交复用。SHALL NOT 修改原输入目录。注册表 SHALL 把 `owner_session` 记为调用所属会话 id，`dsh_job_id` 记为本次登记 id 并追加到 `dsh_job_ids`。

副本重写：提交请求 SHALL 可携带内部字段 `analysis_plan_id`、`parameter_set_id`、`calib_overrides` 与 `input_digests`（由 `shud_run` 从不可变 plan 解析后传入，见 shud-run-tools「shud_run arguments」；不是模型参数）。注册表 SHALL 在任何文件系统操作之前再次校验：两个 id 成对且通过品牌/格式校验；`calib_overrides` 为空或恰好一项 `{key, multiplier}`，`key` 属于 core calib 白名单、`multiplier` 为有限数且位于 [0.5, 2.0] 内、不等于 1.0；`calib_overrides` 非空时两个 id SHALL 非 `null`；两个 id 非 `null`（绑定 plan）时 `threads` SHALL 非 `null`（`shud_run` 已按 plan 的 `threads` 解析），否则以指出 `threads` 的错误失败；两个 id 非 `null` 时 `input_digests` SHALL 为非空对象，每个键为相对输入目录的 POSIX 相对路径（非绝对、不含 `..`、`.` 或空段），每个值为 64 位小写十六进制 sha256，否则以指出 `input_digests` 的错误失败；两个 id 为 `null` 时 `input_digests` SHALL 为 `null`。绑定 plan 的提交按「Build-referenced execution」以该 `threads` 设置包装进程线程环境并记录该值，并按下文第 (2) 项把副本的 `NUM_OPENMP` 改写为该值。校验失败 SHALL 以说明原因的错误失败且不创建运行目录。

输入摘要核对：绑定 plan 的提交在输入复制完成之后、`END` 改写与任何副本重写之前，SHALL 对 `input_digests` 的每一项读取副本 `input/<project>/<path>`（路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则：相对副本目录拼接、规范化后不逃逸副本目录，以 `lstat` 确认为普通文件，符号链接与特殊文件 fail-closed），并要求其内容 sha256 等于该项的值。任一文件缺失、不是普通文件、读取失败或摘要不等时 SHALL 以点名该文件相对路径的错误失败，并按本要求的回滚规则处理（不留运行目录、索引条目或本次 DataProvenance 文件，不启动包装进程）。摘要核对 SHALL NOT 改写副本或原输入；未绑定 plan 的提交 SHALL NOT 执行此核对。

在 `END` 改写之后、构建解析、StackLock 采集与 DataProvenance 生成之前，注册表 SHALL 对副本依次执行以下三项重写，三者都以 latin-1 字节保真方式逐行处理，有效行的判定与 `END` 改写相同（首字节为 `#`、空格或 NUL 的行跳过，键大小写不敏感），SHALL NOT 重新序列化文件的其它字节：(1) 对每次提交（含未绑定 plan 的提交）确保副本 `<project>.cfg.para` 输出 `DT_YE_IC 1440`：存在有效 `DT_YE_IC` 行时把每个有效行的值改为 `1440`，保留键前空白、原分隔符、行内其余字节与行尾；不存在时在文件末尾追加 `DT_YE_IC\t1440` 与一个行尾，该行尾与文件中首个行尾相同（`\r\n` 或 `\n`），文件没有任何行尾时用 `\n`；文件非空且末字节不是行尾时，先补一个同样的行尾再追加。`DT_YE_IC` 只是输出开关，不改变求解。(2) 仅对绑定 plan 的提交，在 (1) 之后把副本 `<project>.cfg.para` 的 `NUM_OPENMP` 设为解析得到的 `threads`（十进制整数，无前导零）：存在有效 `NUM_OPENMP` 行时把每个有效行的值改为该数，保留键前空白、原分隔符、行内其余字节与行尾；不存在时按 (1) 的同一行尾规则在文件末尾追加 `NUM_OPENMP\t<threads>` 与一个行尾。未绑定 plan 的提交 SHALL NOT 改写或追加 `NUM_OPENMP`（无论是否携带 `threads`）。(3) `calib_overrides` 非空时改写副本 `<project>.cfg.calib`：该键 SHALL 恰有一个有效行（0 个或多于 1 个即提交失败并点名该键），其值 `b` SHALL 可解析为有限数，改写为 `b × multiplier` 的 IEEE double 值的最短往返十进制表示（以 `%lf` 读回得到同一 double），保留键、原分隔符与行尾；其它行字节不变。`calib_overrides` 为空时 SHALL NOT 改写 `.cfg.calib`。

参数集重复提交：携带非 `null` `analysis_plan_id` 与 `parameter_set_id` 的提交，注册表 SHALL 在分配并占用 `job_id`/`run_id` 的同步点（首个文件系统 await 之前，与 id 占用不可分割）以本注册表的在途提交与活动、完成索引中已登记的作业为准，检查是否存在同一 `(analysis_plan_id, parameter_set_id)` 的**非失败**作业：在途提交（尚未完成或回滚）一律视为非失败；已登记作业中 RunJob 未处于 `failed` 或 `cancelled`、未收集耗尽，且已 collected 时其 RunRecord 的 `status` 不是 `failed`，即为非失败。存在非失败作业时 SHALL 以指出该 pset 已有非失败运行的错误拒绝，SHALL NOT 占用 id、创建运行目录、读取输入或写入任何文件，使同一 pset 的并发提交至多一个被接受。在途提交回滚后不再占位；同一 pset 之前的作业均为失败（`failed`/`cancelled`、收集耗尽或 RunRecord `status: failed`）时 SHALL 接受新提交，SHALL NOT 改写失败作业的 `run-job.json`、`run-record.json` 或 `collect-error.json`。未绑定 plan 的提交 SHALL NOT 做此检查。DataProvenance 在上述重写之后生成，因而其 `files` 中 `<project>.cfg.para` 与 `<project>.cfg.calib` 的哈希是 SHUD 实际读取的副本字节；StackLock 指纹不含输入内容，只改 calib 的同批提交在环境不变时复用同一 `stack_id`。任一重写失败（含有效行数不符、值不可解析、读写失败）SHALL 按本要求的回滚规则处理，不留运行目录、索引条目或本次 DataProvenance 文件，不启动包装进程。原输入目录 SHALL NOT 因任一重写而改变。

为保持原输入不变，提交预检 SHALL 在创建运行目录或采集证据之前拒绝 `stacks/` 或 `provenance/` 写入根等于或位于已解析原始输入树内的布局；已存在的写入根 SHALL 使用 native realpath 的实际物理拼写，不能因输入符号链接或大小写别名漏检。输入仅位于写入根的子目录而发布位置不在输入树内时，SHALL NOT 仅据该反向包含关系拒绝；既有 StackLock 文件枚举等独立校验保持不变。

#### Scenario: input copied and END patched
- **WHEN** 以 `SHUD/input/ccw` 为输入、`end_days: 30` 提交
- **THEN** `runs/<run_id>/input/ccw/ccw.cfg.para` 的 `END` 为 30，末尾追加了一行 `DT_YE_IC\t1440`（ccw 原无该行），其余字节与原文件相同；原 `SHUD/input/ccw/ccw.cfg.para` 字节不变，`run-job.json` 存在且 `status` 为 `running`

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

#### Scenario: existing DT_YE_IC line rewritten in place
- **WHEN** 输入的 `<project>.cfg.para` 含有效行 `dt_ye_ic  0\r\n`（小写键、两个空格分隔、CRLF 行尾）与注释行 `# DT_YE_IC 60`，提交不带 `end_days`
- **THEN** 副本中该有效行变为 `dt_ye_ic  1440\r\n`，注释行与其它字节不变，文件末尾不追加新行

#### Scenario: DT_YE_IC appended with the file's line ending
- **WHEN** 输入的 `<project>.cfg.para` 没有有效 `DT_YE_IC` 行、首个行尾为 `\r\n` 且末字节不是行尾
- **THEN** 副本为原字节加 `\r\n`、`DT_YE_IC\t1440` 与 `\r\n`；原输入字节不变

#### Scenario: calib multiplier rewrite before provenance
- **WHEN** 以 `calib_overrides: [{key: "GEOL_KSATH", multiplier: 2}]` 与成对 plan id 提交 ccw（`.cfg.calib` 中 `GEOL_KSATH\t1\n`）
- **THEN** 副本 `ccw.cfg.calib` 的该行为 `GEOL_KSATH\t2\n`，其它行字节不变；本次 DataProvenance `files` 中 `ccw.cfg.calib` 与 `ccw.cfg.para` 的 sha256 等于重写后副本的 sha256；`run-job.json` 在 `status: created` 的首次写入中已含该 `analysis_plan_id` 与 `parameter_set_id`

#### Scenario: calib value uses the shortest round-trip form
- **WHEN** 副本 `.cfg.calib` 中 `LC_ROUGH` 的值为 `0.3`，以 `multiplier: 0.5` 提交
- **THEN** 该行的值为 JS 对 `0.3 * 0.5` 的最短往返表示 `0.15`，原分隔符与行尾保留

#### Scenario: calib key absent or duplicated fails the submission
- **WHEN** 以某个 calib 覆盖提交，而副本 `.cfg.calib` 中该键没有有效行（或只有以 `#` 开头的行），或有两个有效行
- **THEN** 提交失败并点名该键，`runs/<run_id>/` 不存在，活动与完成索引均无该 `run_id`，`provenance/` 下没有本次文件，不启动包装进程，原输入字节不变

#### Scenario: baseline submission leaves cfg.calib unchanged
- **WHEN** 以 baseline pset 的成对 plan id 与空 `calib_overrides` 提交
- **THEN** 副本 `.cfg.calib` 与原文件字节相同，副本 `.cfg.para` 只在 `END`、`DT_YE_IC` 与 `NUM_OPENMP` 处不同（`NUM_OPENMP` 的值为请求的 `threads`），`run-job.json` 记录该 plan 与 pset id 与请求的 `threads`（如 `1`），包装进程环境的 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS` 为该值

#### Scenario: plan threads rewrite NUM_OPENMP in the copy
- **WHEN** 以 ccw（原 `ccw.cfg.para` 含有效行 `NUM_OPENMP\t8\n`）、成对 plan id 与 `threads: 1` 提交
- **THEN** 副本 `ccw.cfg.para` 中该行变为 `NUM_OPENMP\t1\n`，其它行字节除 `END` 与 `DT_YE_IC` 外不变；原 `SHUD/input/ccw/ccw.cfg.para` 字节不变；本次 DataProvenance `files` 中 `ccw.cfg.para` 的 sha256 等于改写后副本的 sha256

#### Scenario: absent NUM_OPENMP appended for plan-bound runs
- **WHEN** 输入的 `<project>.cfg.para` 没有有效 `NUM_OPENMP` 行（只有 `# NUM_OPENMP 4` 注释行）、也没有有效 `DT_YE_IC` 行、首个行尾为 `\n` 且末字节为行尾，以成对 plan id 与 `threads: 2` 提交
- **THEN** 副本除 `END` 改写外，在文件末尾依次追加 `DT_YE_IC\t1440\n` 与 `NUM_OPENMP\t2\n`，注释行不变；原输入字节不变

#### Scenario: unbound submission never touches NUM_OPENMP
- **WHEN** 不带 plan id、以 `threads: 2` 提交 ccw
- **THEN** 副本 `ccw.cfg.para` 的 `NUM_OPENMP\t8\n` 行与原文件相同，文件末尾不追加 `NUM_OPENMP` 行；包装进程环境的 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS` 为 `2`

#### Scenario: input digest mismatch fails before any rewrite
- **WHEN** 以成对 plan id 提交，而 `input_digests` 中 `ccw.cfg.calib` 的值不等于副本 `ccw.cfg.calib` 的 sha256（plan 创建后原输入被改动），或 `input_digests` 所列的 `ccw.para.lc` 在副本中不存在
- **THEN** 提交失败并点名该文件相对路径，`runs/<run_id>/` 不存在，活动与完成索引均无该 `run_id`，`provenance/` 下没有本次文件，不启动包装进程，原输入字节不变

#### Scenario: matching input digests allow the submission
- **WHEN** 以成对 plan id 提交，`input_digests` 每项等于副本对应文件在任何重写之前的 sha256
- **THEN** 摘要核对通过，提交按 `END`、`DT_YE_IC`、`NUM_OPENMP` 与 calib 重写继续并成功

#### Scenario: invalid internal overrides rejected before any file system work
- **WHEN** 提交请求的 `calib_overrides` 含两项、含白名单外键 `SOIL_BETA`、倍率为 `1` 或 `3`，`calib_overrides` 非空而 plan id 为 `null`，绑定 plan 而 `threads` 为 `null`，绑定 plan 而 `input_digests` 为 `null`、`{}` 或含键 `../ccw.cfg.calib`，或未绑定 plan 而 `input_digests` 非 `null`
- **THEN** 注册表以说明原因的错误失败，不创建运行目录，不读取输入

#### Scenario: concurrent submissions of one parameter set
- **WHEN** 两个 `shud_run` 调用以同一 `task_id`、`analysis_plan_id` 与 `parameter_set_id: "PSET-2"` 并发提交，此前该 pset 没有作业
- **THEN** 恰好一个提交成功；另一个返回指出该 pset 已有非失败运行的工具错误，没有为它创建运行目录或索引条目，`provenance/` 下没有它的文件

#### Scenario: non-failed parameter set rejected
- **WHEN** 同一 pset 已有一个 `running` 作业，或一个已 collected 且 RunRecord `status: succeeded` 的作业，再以同一 pset 提交
- **THEN** 提交被拒绝并指出该 pset，`runs/` 下没有新运行目录，已有作业的文件字节不变

#### Scenario: resubmission after failure accepted
- **WHEN** 同一 pset 之前的唯一作业已 collected 且 RunRecord `status: failed`（或为 `cancelled`，或收集耗尽），或之前的在途提交已回滚，再以同一 pset 提交
- **THEN** 提交成功并写入新的 `run-job.json`，失败作业的 `run-job.json`、`run-record.json` 与 `collect-error.json` 字节不变

#### Scenario: same-environment calib-only batch shares one stack
- **WHEN** 在同一会话 cwd、同一环境下依次提交同一 plan 的 baseline 与三个扰动 pset
- **THEN** 四个 `run-job.json` 的 `stack_id` 相同，`stacks/` 只有一个对应 lock 文件，四份 DataProvenance 的 `ccw.cfg.calib` 哈希中扰动 pset 与 baseline 不同

### Requirement: Automatic collect
作业进入 `succeeded`、`failed` 或 `cancelled` 时注册表 SHALL 立即 collect：按 run-records spec 生成 RunRecord（含从 `run-job.json` 复制的 `llm.response_model` 与 `llm.response_model_source`）写入 `run-record.json`，作业状态置 `collected`，之后才唤醒。`run-record.json` 已存在时 collect SHALL 返回已有记录而不改写。collect 失败（`exit_code` 不可读或非整数、产物目录不可读、RunRecord 未通过 schema 校验、写 `run-record.json` 失败；指标计算与 `metrics.json` 写入的失败不属于 collect 失败，见下文「collect 内指标」）时 SHALL 写 `collect-error.json`（`attempts`、`last_error`、`at`），作业保持或置为终态（`exit_code` 不可读时为 `failed`），SHALL NOT 写 `run-record.json`；`attempts` 未达 core 常量上限时 SHALL 由「Registry poll loop」在重试间隔后重试（重启后由对账 R9 继续），达到上限后 SHALL 停止自动重试并以失败原因唤醒发起会话。

自动与直接 collect SHALL 共用相同的原始宿主观测条件及既有时间区间校验；仅有完整磁盘时间戳或接管登记 SHALL NOT 授权新数值。完成回执释放后，同实例生成重试 SHALL 保留原始已观测端点；实例更替或进程崩溃后，未提交结果的时长 SHALL 为 null。有效已提交记录优先原样返回，SHALL NOT 因缺少新实例观测而重算或改写。

collect 内指标：自动 collect 与 `shud_collect` 触发的 collect SHALL 在同一次 collect 尝试内、RunRecord 发布之前计算 run 指标，规则相同。只有当本次 `exit_class` 为 `ok` 时才计算：按 run-metrics 的定义读取运行目录与 `shud_output` 中的文件，原子写 `runs/<run_id>/metrics.json`，并把该文件内容的 sha256 写入 RunRecord 的 `artifacts.metrics_summary = {path: "metrics.json", sha256}`，`numerical_health` 四项取自同一次计算的结果（各项来源、公式与不可用原因由 run-metrics 定义，本要求不重述）。失败隔离 SHALL 为：(a) 当且仅当 run-metrics 报告指标不可用时，`metrics.json` 的 `status` 为 `unavailable` 并带 `reason`、各指标值为 `null`——哪些文件缺失、不可读或布局错误使整份指标不可用、哪些只使单项为 `null`，只由 run-metrics「Metrics file shape and determinism」与「Metrics computed at collect」定义，本要求 SHALL NOT 另设所需文件判据；此时仍写 `metrics.json`，RunRecord 的 `numerical_health` 四项为 `null`，`metrics_summary` 指向该文件；(b) 写 `metrics.json` 本身失败时，RunRecord 的 `metrics_summary` 与 `numerical_health` 四项为 `null`，collect 继续发布 RunRecord，collect 回执给出可见的错误类别（不含路径以外的内容）；(c) `exit_class` 不是 `ok` 的 run SHALL NOT 写 `metrics.json`，`metrics_summary` 与 `numerical_health` 四项为 `null`。上述三种情形 SHALL NOT 写 `collect-error.json`、SHALL NOT 增加 collect 尝试次数、SHALL NOT 改变 RunRecord 的 `status` 与 `exit_class`，也 SHALL NOT 阻止作业置为 `collected` 与随后的唤醒；指标计算 SHALL NOT 抛出使 collect 尝试失败的错误。指标计算 SHALL 只读：SHALL NOT 改写运行目录中的任何求解器输出、`stdout.log`、`stderr.log` 或输入副本。`run-record.json` 已存在时 collect SHALL 照旧原样返回已有记录，SHALL NOT 重算或改写 `metrics.json`；之前失败的 collect 尝试残留的 `metrics.json` 在下一次尝试中被同一组输入文件产生的逐字节相同内容覆盖。只读模式 `collectShud(id, {readonly: true})` SHALL NOT 计算指标或写 `metrics.json`。M5 之前已提交的 RunRecord SHALL NOT 被回填。

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

#### Scenario: duration observation is not reconstructed after a crash
- **WHEN** 原始宿主发布终态后、RunRecord 提交前崩溃，随后另一个进程收集该运行
- **THEN** 保留已有 finished_at 结算观测时刻，新 RunRecord 的 wall_seconds 为 null；若 RunRecord 已提交则原样返回其数值与字节，不重新生成

#### Scenario: corrupted retry ledger does not reopen the attempt budget
- **WHEN** collect-error.json 的 JSON、字段、attempts 或 at 不合法
- **THEN** 保留该文件内容和修改时间并明确报告错误，不重置计数或启动新的自动 collect 尝试

#### Scenario: succeeded run gets metrics
- **WHEN** 一个退出码为 0 的作业结束，run-metrics 读取的输出文件与 `stderr.log` 均存在且布局有效
- **THEN** 运行目录存在 `metrics.json`，`run-record.json` 的 `status` 为 `succeeded`，`artifacts.metrics_summary` 为 `{path: "metrics.json", sha256}` 且 `sha256` 等于该文件内容的 sha256，`numerical_health` 与 `metrics.json` 中的对应值相同；没有 `collect-error.json`

#### Scenario: unavailable metrics do not fail the collect
- **WHEN** 一个退出码为 0 的作业结束，而某个已存在的 `.dat` 文件被截断（长度不满足布局校验），或 `<project>.rivqdown.dat` 缺失
- **THEN** `metrics.json` 存在且 `status` 为 `unavailable`、带指出该文件的 `reason`（缺失 `rivqdown.dat` 时为 `missing_variable:rivqdown`）；RunRecord 的 `status` 为 `succeeded`、`exit_class` 为 `ok`，`metrics_summary` 指向该文件，`numerical_health` 四项为 `null`；运行目录没有 `collect-error.json`，作业置为 `collected` 并照常唤醒

#### Scenario: residual-only gaps keep metrics ok
- **WHEN** 一个退出码为 0 的作业结束，其余输出完整，而输出目录缺少 `<project>.eleyic.dat`，或副本 `<project>.cfg.calib` 不可安全读取
- **THEN** `metrics.json` 的 `status` 为 `ok`，只有 `water_balance_residual` 为 `null`（原因 `missing_variable:eleyic` 或 `unreadable_input:input/<project>/<project>.cfg.calib`），峰值类指标照常计算；RunRecord 的 `numerical_health` 中 `water_balance_residual` 为 `null`，`cvode_failures`、`negative_state_count` 与 `max_solver_dt` 等于 `metrics.json` 中的对应值；`metrics_summary` 指向该文件，没有 `collect-error.json`

#### Scenario: metrics.json write failure still publishes the record
- **WHEN** 一个退出码为 0 的作业结束，而写 `metrics.json` 失败（如运行目录下该路径已被一个目录占用）
- **THEN** `run-record.json` 存在，`metrics_summary` 与 `numerical_health` 四项为 `null`，`status` 为 `succeeded`；没有 `collect-error.json`，collect 尝试次数不增加，collect 回执含指标写入失败的错误类别

#### Scenario: non-ok run writes no metrics
- **WHEN** 一个退出码为 19 的作业结束，或作业被取消
- **THEN** 运行目录没有 `metrics.json`，RunRecord 的 `metrics_summary` 与 `numerical_health` 四项为 `null`，`status` 为 `failed`

#### Scenario: existing record is not recomputed
- **WHEN** 对一个已有 `run-record.json` 与 `metrics.json` 的作业再次 collect（自动或经 `shud_collect`），即使其 `.dat` 文件在此期间被改写
- **THEN** 返回与 `run-record.json` 相同的记录，`metrics.json` 与 `run-record.json` 的字节与修改时间均不变

#### Scenario: retried collect rewrites identical metrics
- **WHEN** 第一次 collect 尝试已写出 `metrics.json` 而写 `run-record.json` 失败，重试间隔后第二次尝试成功
- **THEN** `collect-error.json` 的 `attempts` 为 1；`metrics.json` 的字节与第一次尝试写出的相同，`metrics_summary.sha256` 等于其 sha256

#### Scenario: readonly collection computes nothing
- **WHEN** `verification_run` 或报告生成以 `collectShud(id, {readonly: true})` 读取一个已 collected 的作业
- **THEN** 不计算指标、不写或改写 `metrics.json`，返回已有 RunRecord
