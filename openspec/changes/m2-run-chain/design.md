# Design

## Context

动机见 proposal.md「Why」。设计受以下事实约束（均已在钉版 `dsh-v0.2.1-rc.2` checkout 核查，路径相对 `deepseek-harness/packages/`）：

- dsh `ctx.jobs` 只能有一个实现：第二个 `JobRegistry` 服务注册即抛重复错误（`jobs/jobs/src/index.ts`）。Web 模板的 `jobs` 行在 `bundle/base/cordis.patch.yml:96-97`（`id: jobs`，`@deepseek-ai/dsh-jobs-local`），profile patch 可按 id 覆盖；`tool-jobs` 行在其后（`:289`）。
- `LocalJobRegistry`（`jobs/jobs-local/src/index.ts`，717 行）公开导出、可继承；私有成员多、无 protected，子类只能经公开方法（`start`、`kill`、`attachController`、`list`、`get` 等）与 `JobSpec.run` 的 producer 钩子介入。其 `Config`（`:131-150`）为 schemastery 对象，`maxConcurrentJobsPerOwner`（默认 10，`:34`、`:48`）、`retainBytes`、`settledRetainBytes`、`pumpPollMs` 均有默认值。
- 无 owner 登记：`start` 对 `owner` 未定义的作业计入共享的无 owner 桶，超过 `maxConcurrentJobsPerOwner` 时抛错（`:216-221`）；无 owner 作业对所有调用方可见（`assertAccess`，`:410-414`）；不受 owner Agent 释放影响（`disposeOwned` 只处理有 owner 的作业，`:655-660`）；dsh **不**为其写 `job/registered`/`job/settled` 会话事件（`recordSessionEvent` 在无 owner 时直接返回，`:448-449`）；`tool-jobs` 对无 owner 结算不唤醒（`tool-jobs/src/index.ts:279`）。
- `start` 要求有控制器服务该 owner（`servesOwner`，`:208-210`、`:382-385`）：全局层（无作用域上下文挂载）的控制器服务所有 owner，作用域层的控制器只服务其作用域链上的 Agent；无 owner 作业没有作用域链，**只能**由全局控制器服务（`jobs-local/tests/jobs.spec.ts:199-201`、`:204-214`）。控制器只在 `start` 的准入检查中被读取（`:209`、`:351`、`:382-385`）。`tool-jobs` 在 apply 时 `attachController('tool-jobs')`（`tool-jobs/src/index.ts:248`），但 Web 模板在宿主层禁用 `tool-jobs`（`bundle/web-app/cordis.patch.yml:496-497`）、改在 preset 内挂载（`bundle/web-app/presets/standard.patch.yml:33-34`），其控制器在作用域层，服务不了无 owner 作业。读取与 kill 不受控制器影响：`list` 返回调用方自己的与全部无 owner 作业（`:310-314`），`get`/`read`/`kill` 的访问栅栏放行无 owner 作业（`assertAccess`，`:410-414`）；Web 作业卡的列表同样含全部无 owner 作业，kill 经同一栅栏（`api/job-controller/src/index.ts:68`、`:110-126`）。dsh JobId 形如 `<kind>-<16 位十六进制>`（`:231`），重启后不保留。
- 宿主退出或注册表重载时，父类对每个活作业以理由 `'jobs service disposed'` 调用 producer `cancel` 并等待结算（`disposeAll`/`cancelForTeardown`，`:674-717`，`settleCause: 'teardown'`）。模型 `job_kill` 经公开 `kill(id, caller, reason)`（`:332`），Web 作业卡的 kill 理由为 `'cancelled by the user'`（`api/job-controller/src/index.ts:125`）。
- `ctx.subprocess`/`ctx.shell` 启动的子进程在宿主退出时被杀（`subprocess-local/src/spawn.ts:74-79`）；要活过重启必须自己 spawn。
- 插件可用 `ctx.inject([服务...], 回调)` 在可选服务出现后才运行回调，与行的 apply 顺序无关（宿主先例 `schedule/tool-schedule/src/index.ts:444`）。宿主没有可供插件订阅的"启动完成"信号（loader、include、app-boot 只 emit `loader/entry-init`、`loader/partial-dispose`、`loader/config-update`、`app-boot/config-reload`）。
- 重启后的唤醒先例在 `schedule` 插件：`sessionController.resolveAgent(sessionId)` → `agent.followup(...)` → `ctx.sessions.flush(...)`（`schedule/schedule/src/runtime.ts:101-124`）。`sessionController` 只由 web-app bundle 挂载（`bundle/web-app/cordis.patch.yml:121`），headless 模板没有；其 `inject` 列表不含 `jobs`（`api/session-controller/src/index.ts:120-132`）。会话按需冷恢复。
- 启动：`--dump-config` 只合成 patch、不启动插件（`apps/cli/src/dump-config.ts:1-7`）。真实启动时 `jobs` 不在必需项列表（`boot/app-boot/src/index.ts:951-960`）：该行激活失败只在 stderr 打印 `did not activate` 诊断（含错误消息），其余插件继续运行（`:1152-1166`）。
- SHUD 调用形如 `cd <ws> && shud -o <ws>/output/<proj>.out <proj>`，读 `<ws>/input/<proj>/`，并向输入目录写回 `.cfg.ic.update`、`.bak`（`docs/03_SPEC/Domain_CLI_Spec.md`，`scripts/runtime/shud-tiny.sh:16-25`）；退出码 0/10/12/13/19/20（`docs/01_CODEBASE/SHUD_IO_Facts.md:96-98`）；ccw 全程约 4m45s。
- Seatbelt 只限制文件与网络访问，不限制 CPU/内存；宿主进程本身不在沙箱内。
- 现行 eslint 白名单只允许 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`（`eslint.config.mjs`）。

Stage 1 压测与 Stage 4 修订结论（27 个分支、3 个原开放项）是本 design 的输入，逐条落在下面的 Decisions 与 Open Questions。

## Goals / Non-Goals

**Goals:**
- 一句话经 `shud_run` 跑 ccw；dsh 被 SIGTERM 或 SIGKILL 重启后，作业继续或被正确结算，完成后发起会话被唤醒并拿到含退出码与产物清单的 RunRecord。
- 记录与产物对 PI 可见（会话工作区 `runs/<run_id>/`），不依赖宿主内部存储。
- 非 shud 作业行为与替换前逐项一致。

**Non-Goals:**
- 非 shud 作业（`bash run_in_background`、terminal、workflow 等）的持久化与跨重启恢复：保持 `jobs-local` 语义，重启后仍为 `unknown job`。
- `timed_out` 状态、`max_wall_minutes`/`max_compute_minutes` 超时终止，以及 GAP-02（TaskCard 在超时时如何转换）：随 TaskCard 在 M3 决定。
- Minimal_Schemas 中 RunJob 的 `cwd`（由 `run_dir` 取代）、`resources.max_memory_mb`、`cost_budget`，以及 RunRecord 的 `artifacts.metrics_summary`、`artifacts.plots`：推迟 M3，Minimal_Schemas 对应字段标注"M3"。
- `numerical_health` 的实际计算（`.dat` 二进制完整性、NaN/负状态扫描、`SUNDIALS_ERROR` 解析）：字段在 M2 可为空。
- TaskCard、StackLock、DataProvenance 对象本身及其与 RunJob/RunRecord 的必填引用（M3）。
- `shud_run` 本身的 PI 审批门与治理动作审批接线（M3）。输入目录位于 raw 时的 provenance 读审批卡（D8）是 raw 保护，不是审批门，M2 照常弹出。
- SHUD 子进程的宿主沙箱包装。
- shud 专属并发上限、批量运行与调度（M5）；M2 只受 dsh 无 owner 桶上限约束（D5）。
- `docker_job`/`local_direct` 后端。

## Decisions

### D1 继承 `LocalJobRegistry`，按 id 替换 `jobs` 行；shud 作业无 owner 登记

`@shud-harness/dsh-shud-jobs` 导出 `ShudJobRegistry extends LocalJobRegistry`，profile patch 用 `- id: jobs` 改指向它。非 shud 的 `start` 原样交给父类。shud 作业也经父类 `start` 登记，但**不带 owner**：`job_list`/`job_output`/`job_kill` 与 Web 作业卡照常可用且对所有会话可见；`tool-jobs` 跳过无 owner 结算，因此永不与注册表自己的唤醒（D7）重复；owner Agent 释放不会取消它。发起会话 id 只写进 `run-job.json` 的 `owner_session`，仅用于唤醒投递。持久化、脱离运行、对账与唤醒由子类附加的 shud runner 负责。新增公开方法供工具包调用：提交 shud 作业、按 `job_id`/`run_id` 查记录、幂等 collect。

控制器：无 owner 的 `start` 只能由全局控制器放行，而 Web 模板的 `tool-jobs` 只在 preset 作用域内挂载，因此注册表自带控制器——每次以无 owner 登记 shud 作业时，用自身构造时的（无作用域）上下文经父类 `attachController('shud-jobs')` 挂到全局层，紧接着同步调用父类 `start`，随即在 `finally` 中释放。控制器只在 `start` 准入时被读取，瞬时挂载即足够；不常驻，是因为常驻的全局控制器会服务所有 owner，使没有 `tool-jobs` 的组合也能启动有 owner 的非 shud 作业，违反「非 shud 行为与 `jobs-local` 一致」。因此 shud 登记（提交与对账接管）不依赖 `tool-jobs` 是否挂载、挂在哪一层；preset 内的 `job_list`/`job_output`/`job_kill` 与 Web 作业卡照常能看到并 kill 这些作业（见 Context）。可行性由 O5 确认。

两个 id 空间：`job_id`（`JOB-…`）/`run_id`（`RUN-…`）是持久 id；`dsh_job_id`（`shud-<16 位十六进制>`）是本次宿主进程中的 dsh 登记 id。`shud_run` 同时返回三者；`job_output`/`job_kill` 只接受 `dsh_job_id`。dsh 登记的 label 为 `<run_id>`（有 `label` 参数时为 `<run_id> <label>`），因此重启接管后新的 `dsh_job_id` 可经 `job_list` 按 `run_id` 找到，也可经 `shud_collect` 的错误结果或 `run-job.json` 的 `dsh_job_id` 字段取得；历次登记 id 追加在 `dsh_job_ids`。

配置：注册表 `Config` = `LocalJobRegistry.Config` ∪ {`stateDir`, `shudBin`}（后二者必填），"未知键"指此并集之外的键；父类四个键沿用其默认值与校验。

备选：只继承抽象 `JobRegistry` 从零实现（JobId 跨重启稳定，但需重写约 700 行作用域/事件契约）；保留 `jobs-local` 另写独立 runner（不满足 K8"替换 jobs-local"，且 shud 作业不进 `job_*` 工具面）；有 owner 登记（重启后 owner 无活 Agent 时 `start` 抛错，`jobs-local/src/index.ts:361-372`，且 owner 释放会取消作业）。均否决。

### D2 运行目录与记录落在会话工作区，索引与锁在 `stateDir`

每个 shud 作业在提交时同时分配 `job_id` 与 `run_id`，运行目录为 `<session cwd>/runs/<run_id>/`（有效工作目录的唯一定义见 D8）：

```
runs/<run_id>/
  input/<project>/        # 输入目录的完整副本（SHUD 在此写回）
  output/<project>.out/   # shud -o 目标
  stdout.log  stderr.log
  wrapper.pid             # 包装进程自写，见 D4
  exit_code               # 包装进程写入，见 D4
  run-job.json            # RunJob 当前状态（原子写：临时文件 + rename）
  run-record.json         # collect 后写入，写入后不再改动
  collect-error.json      # 仅 collect 失败时出现，见 D6
```

插件配置 `stateDir`（必填，缺失或不可写时插件行激活失败）下保存三个文件：`active.json`（尚未完成唤醒的作业：`run_id`、`job_id`、运行目录绝对路径）、`completed.json`（已离开活动索引的作业：`run_id`、`job_id` → 运行目录绝对路径，供 `shud_collect` 跨会话查找）与 `lock`（持有者 pid 与进程启动时间）。两份索引都以临时文件 + rename 原子写，且同一注册表实例内的所有索引修改串行执行（单一 promise 链），并发提交不会丢条目。条目先写入 `completed.json` 再从 `active.json` 移除。`lock` 在插件 apply 时取得：已被另一个存活的 dsh 进程持有（pid 存活且启动时间一致）时插件行激活失败并指明 `stateDir` 与持有者 pid；持有者已不存在或 pid 被复用时视为陈旧锁并接管；注册表释放时删除。部署期 `stateDir` 默认为 `$DSH_HOME/profiles/<name>/shud-jobs`（由 `profile:install` 写入，见 shud-profile delta）。备选：全部放 `$DSH_HOME` 下的宿主 storage domain——记录对 PI 不可直接见、与压测结论不符，否决。

### D3 id 规范

`JOB-YYYYMMDDTHHMMSS-xxxx` 与 `RUN-YYYYMMDDTHHMMSS-xxxx`：UTC 时间到秒 + 4 位小写十六进制随机数；同一作业的两个 id 共享时间戳与随机段，便于人工对照。以 `active.json`、`completed.json` 与运行目录存在性去重，碰撞时重抽。替换 Minimal_Schemas 的 `JOB-NNNN`/`RUN-NNNN`（无需全局计数器状态）。core 以品牌类型 `JobRecordId`/`RunId` 暴露，与 dsh 的 `JobId` 区分。

### D4 脱离宿主的包装进程与退出码

shud producer 用 Node `child_process.spawn` 直接启动 `/bin/sh` 包装进程（`detached: true`，stdio 重定向到文件，`unref()`），不经 `ctx.subprocess`，因此宿主退出不会杀它。包装进程启动后先以临时文件 + rename 写出 `wrapper.pid`（自身 pid），再在运行目录内执行 `shudBin -o output/<project>.out <project>`，结束后把退出码写入 `exit_code.tmp` 再 rename 为 `exit_code`。包装进程不捕获信号：被 kill 时不写 `exit_code`。宿主在 spawn 返回后把 pid 与该进程启动时间写进 `run-job.json`（用于识别 pid 复用）。宿主无法 reap 孤儿进程，`exit_code` 文件是退出结果的唯一来源。SHUD 不套沙箱（Seatbelt 不限制算力，单用户工作台前提下由 D8 的路径约束守边界）；`shudBin` 为必填配置，不硬编码。

### D5 生命周期、并发、取消与 teardown

RunJob 状态：`created`（输入已复制、记录与活动索引已写）→ `submitted`（启动意图已持久化，紧接着登记并 spawn，pid 尚未记录）→ `running`（pid 与启动时间已记录）→ `succeeded`（退出码 0）| `failed`（非 0、进程丢失或 collect 无法读取退出码）| `cancelled`（kill）→ `collected`。`submitted` 保留在压测确定的状态集中，含义由"排队"改为"启动意图"，使对账能区分"从未尝试启动"与"可能已 spawn"。

- 并发：允许多个 SHUD 并行，不设 shud 专属上限；dsh 无 owner 桶的 `maxConcurrentJobsPerOwner` 是唯一上限，父类 `start` 超限抛错时 `shud_run` 返回工具错误，并删除本次运行目录与索引条目（不留 RunJob）。
- kill（模型 `job_kill` 或 Web 作业卡）：子类覆写公开 `kill`，对 shud 作业先在 `run-job.json` 写 `cancel_requested_at`，再交父类；producer 的 `cancel` 见到该标记即对包装进程组 SIGTERM，宽限期（core 常量 10 秒）后仍存活则 SIGKILL。结算 first-wins：结算时 `exit_code` 已存在则按退出码结算（自然退出先到），否则为 `cancelled`。被 kill 的作业同样 collect 并唤醒（D7）。
- 宿主 teardown：producer 的 `cancel` 在无 `cancel_requested_at` 标记时（父类 `disposeAll`，理由 `'jobs service disposed'`，宿主退出或注册表重载）**不**杀进程，只让本次登记以 `failed`（detail 说明"宿主退出，shud 继续在后台运行"）结算，`run-job.json` 状态与索引不变，不生成 RunRecord、不唤醒。shud 作业无 owner，"owner Agent 释放"不适用。区分是否可靠见 O1。

### D6 结算时自动 collect

作业进入终态（含对账时补结算）即由后端 collect：读 `exit_code`、扫描 `output/<project>.out/` 生成产物清单（相对路径 + 字节数）、计算 `wall_seconds`、按退出码映射 `exit_class`、复制 `llm.response_model` 与 `llm.response_model_source`，写 `run-record.json`，状态置 `collected`，然后才唤醒。collect 幂等：`run-record.json` 已存在时直接返回该记录，不重写。`shud_collect` 调用同一逻辑。

collect 失败（`exit_code` 不可读或非整数、产物目录不可读、RunRecord 未通过 core schema、写文件失败）时：在运行目录写 `collect-error.json`（`attempts`、`last_error`、`at`），作业保持或置为终态（`exit_code` 不可读时为 `failed`），不写 `run-record.json`；`attempts` 未达 core 常量上限（3）时由轮询循环（D7）在下一轮重试，重启后由对账（D11 R9）继续；达到上限后不再自动重试，以失败原因唤醒发起会话（D7），之后的 `shud_collect` 仍可手动再试。

### D7 至少一次唤醒：唯一路径

所有结算路径——宿主在线时自然退出或被 kill、对账时补结算、重启后接管的作业结束——都经注册表自己的同一路径，由**一个**进程内轮询循环驱动：循环以父类 `pumpPollMs` 为周期遍历 `active.json` 中 `notify.status` 尚未为 `delivered`/`unreachable` 的条目，条目离开活动索引才退出循环，与 dsh 登记无关（没有 dsh 登记时同样处理）。每一轮对每个条目按状态推进一步：未终态 → 检查 `exit_code` 与包装进程存活并结算（先原子写 `run-job.json` 终态，有 dsh 登记时再以 producer `done` 结束它；kill 与自然退出 first-wins）；终态未 collect 且 collect `attempts` 未达上限 → collect（D6，含失败重试）；已 collect 或 collect 达上限且 `notify.status: pending` 且投递就绪 → `sessionController.resolveAgent(owner_session)` → `agent.followup(...)`（`source.kind: shud-jobs`，消息含 `run_id`、`exit_class`、产物数量或 collect 失败原因）→ `ctx.sessions.flush(...)` 返回成功后才把 `notify.status` 置 `delivered` → 条目写入 `completed.json` 并移出 `active.json`。

- 无豁免：每个 collect 过（或 collect 失败）的作业都唤醒一次，包括模型自己 `job_kill` 的作业与 `job_output` 已读到结果的作业。`tool-jobs` 对无 owner 作业不唤醒，故不会双投。
- 循环与其定时器是注册表上下文的 effect：注册表释放或重载时随之停止，重载后的新实例先对账再启动自己的循环，因此同一进程内不会有两个循环对同一条目投递；同一条目同一时刻至多一次投递在途。
- 崩溃发生在 followup 与置位之间时，重启后的对账（D11）再投递一次（at-least-once，消息内含 `run_id` 便于识别重复）。
- 消息用 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造（ADR-0006 决策 2），`shud-jobs` 来源经扩充 `MessageSourceMap` 声明类型（宿主先例 `schedule/schedule/src/runtime.ts:2-8`）。
- 就绪：投递只在 `sessionController` 与 `sessions` 都可用后开始——注册表以 `ctx.inject(['sessionController', 'sessions'], 回调)` 使轮询循环的投递步骤生效，二者不是插件行的启动依赖。Web 模板中 `jobs` 行先于 `session-controller` 行 apply（`bundle/base/cordis.patch.yml:96` 对 `bundle/web-app/cordis.patch.yml:121`），apply 时对账产生的待投递条目在回调触发后投递。服务缺失本身**从不**导致 `unreachable`：宿主没有启动完成信号，注册表无法区分"尚未 apply"与"本 profile 没有该行"，因此 headless profile 中条目保持 `notify.status: pending`（`detail` 写明等待会话控制服务），RunRecord 仍可经 `shud_collect` 取得。
- 不可达：投递开始后，`owner_session` 为 `null` 或 `resolveAgent` 报告会话不存在 → 立即 `unreachable`；恢复或 flush 失败等暂时性错误计入 `notify.attempts`，由轮询循环在下一轮重试（重启后由对账继续），达 core 常量上限（3）后置 `unreachable`。`unreachable` 后不再重试，RunRecord 仍可经 `shud_collect` 查到。

### D8 raw 与路径边界

`shud_run` 没有 `workdir` 参数，其有效工作目录**定义为调用所属会话的 cwd**（本 change 各处的"有效工作目录"、"session cwd"均指它）。

- raw-guard 在 `tools/pre-execute` 对 `shud_run` 判定：目标 `<session cwd>/runs/<run_id>` 按「Raw directory configuration」的最近存在祖先规则解析（判定时 `run_id` 未分配；`runs/` 存在时以其 realpath 为祖先，含指向 raw 的符号链接，否则以 session cwd 的 realpath 为祖先），位于任一 raw 目录内 → `deny`；否则 `input_dir` 位于 raw 内（只读复制）→ `ask`，复用 provenance 文案；其余委托下一个监听器。
- 注册表在创建运行目录前后各以 `lstat` 确认 `runs/` 与 `runs/<run_id>` 是真实目录（不是符号链接），且 `runs/<run_id>` 由本次非递归 `mkdir` 新建；任一不满足即删除本次新建的目录并以工具错误失败（fail-closed）。注册表不读 raw-guard 配置：排除符号链接分量后，运行目录的 realpath 必为 `realpath(session cwd)/runs/<run_id>`，正是 raw-guard 已判定的路径。残余竞态（两次 `lstat` 之间有人把 `runs/` 换成符号链接）在单用户工作台前提下接受并记入 Risks。
- 输入复制：`input_dir` 本身可为符号链接（解析后复制）；其内部任一条目为符号链接或非普通文件/目录（FIFO、设备等）时 `shud_run` 拒绝并指出该条目。理由：按链接复制会让 SHUD 的写回（`.cfg.ic.update`、`.bak`）穿过链接写到原输入或 raw；解引用复制会在没有审批卡的情况下读取链接目标（可能在 raw 内）；拒绝是唯一同时避开两种风险、又不需要读 raw-guard 配置的语义。
- `shud_run` 自身另做 fail-loud 校验：输入目录存在、含 `<project>.cfg.para`、运行目录根不在输入目录内。

### D9 seam 白名单与依赖

运行时 import 放宽到 `@deepseek-ai/dsh-jobs`（契约与类型）、`@deepseek-ai/dsh-jobs-local`（父类）与 `@deepseek-ai/dsh-llm` 的具名导入 `createUserMessage`（唤醒消息）；唤醒所需的 `sessionController`（`import type {} from '@deepseek-ai/dsh-api-session-controller'`）、`sessions`、Agent 等类型只允许 `import type`（eslint `allowTypeImports`），运行时经 `ctx.inject` 取服务（含 D7 的可选服务回调形式）。测试文件（eslint 按测试文件 glob 限定）额外允许运行时 import `@deepseek-ai/dsh-scope` 的 `createScope`，以复现 Web 模板中 `tool-jobs` 只在 preset 作用域挂载的形态；生产代码仍禁止。注册表测试其余部分用手写的 `agents`/`sessionController`/`sessions` 替身，不运行时 import 宿主测试包（如 `dsh-agent-loop-testkit`）。决策记录 `docs/adr/implemented/0006-dsh-jobs-seam-imports.md`（含对 `attachController` 绑定调用方上下文与 `servesOwner` 只在 `start` 时读取这两处实现细节的耦合）；`test-guardrails` 增加正反例。

`@shud-harness/dsh-shud-jobs` 按宿主发布规则（`deepseek-harness/docs/user/develop/basic/publish.md:105`：需与宿主共享实例的包同列 `peerDependencies` 与 `devDependencies`）声明 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local` 及其 peer 并集 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-timeout`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-workspace`、`@deepseek-ai/cordis`（`jobs-local/package.json`、`jobs/package.json` 的 peer 列表），以及唤醒所需的 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-api-session-controller`（与宿主 `schedule` 包相同，二者同列 peer 与 dev），全部钉 `0.2.1-rc.2`（cordis 钉现有版本）；仓库 `autoInstallPeers: false`，缺一即在测试或启动时暴露。扩展父类 `Config` 是否需要运行时 import `@deepseek-ai/schemastery`（`jobs-local` 的运行时依赖，不在白名单）由 O6 回答。

### D10 RunRecord 的 `llm.response_model`

由 `shud_run` 工具在执行时取发起该次工具调用的响应体 model id，经提交参数交注册表写进 `run-job.json`，collect 时复制到 RunRecord，并记 `llm.response_model_source: response`。工具执行上下文拿不到响应体 model 时，记录该 Agent 当前生效的已配置模型 id 并标 `response_model_source: configured`；两者都拿不到时 `shud_run` 返回工具错误，不硬编码。取值途径由 O4 确认。

### D11 启动对账与接管

插件 apply 时取得 `stateDir` 锁后读 `active.json`，按（`run-job.json` 的 `status`、`pid`、`pid_started_at`、`exit_code` 文件）逐条对账。"存活"指 pid 对应进程存在且其启动时间与记录一致；凡判定"不存活"后，先**再读一次** `exit_code`（包装进程可能刚写出），仍无才判 `lost`。

| # | `status` | 条件 | 动作 |
|---|---|---|---|
| R1 | `created` | — | 从未尝试启动：结算为 `lost`（detail：宿主在启动 SHUD 前退出），collect，唤醒 |
| R2 | `submitted` | `exit_code` 存在 | 按退出码结算，collect，唤醒 |
| R3 | `submitted` | 无 `exit_code`，`wrapper.pid` 存在且进程存活、启动时间不早于 `submitted_at` | 补记 `pid`/`pid_started_at`，置 `running`，按 R5 接管 |
| R4 | `submitted` | 其余 | 再读 `exit_code`，仍无 → `lost`，collect，唤醒；不重新 spawn |
| R5 | `running` 且无 `cancel_requested_at` | 无 `exit_code`，存活 | 接管：交给轮询循环继续监视，并以瞬时全局控制器无 owner 重新登记（见下） |
| R6 | `running` | `exit_code` 存在 | 按退出码结算，collect，唤醒 |
| R7 | `running` | 无 `exit_code`，不存活 | 再读 `exit_code`，有 → R6；仍无 → `lost`（有 `cancel_requested_at` 时为 `cancelled`），collect，唤醒 |
| R8 | `running` 且有 `cancel_requested_at` | 无 `exit_code`，存活 | 宿主在 kill 宽限期内退出：重发 SIGTERM/SIGKILL，结算为 `cancelled` |
| R9 | `succeeded`/`failed`/`cancelled`（终态且不是 `collected`） | 无 `collect-error.json`，或其 `attempts` 未达上限 | collect（`run-record.json` 已存在时原样返回该记录，覆盖"记录已写、状态未置位"的崩溃窗口），成功则置 `collected`，唤醒 |
| R10 | `succeeded`/`failed`/`cancelled` | `collect-error.json` 的 `attempts` 已达上限，`notify.status: pending` | 不再 collect、状态不变（无 `run-record.json` 时绝不置 `collected`），只补投递含失败原因的唤醒 |
| R11 | `collected` | `notify.status: pending` | 只补投递唤醒（followup → flush 后才置 `delivered`） |
| R12 | 任一 | `notify.status` 为 `delivered`/`unreachable` | 补写 `completed.json` 并移出 `active.json` |

`running` 总与 `pid`/`pid_started_at` 同次写入（schema 强制），故不存在 pid 为 `null` 的 `running`；pid 未知的窗口由 `submitted` 加 `wrapper.pid` 覆盖。对账不含任何重新入队行：没有排队状态，`created`/`submitted` 从不重新 spawn（防止同一运行目录出现第二个 SHUD）。对账在每个条目上幂等，重复执行不产生第二份 RunRecord。结算、collect、`notify` 状态与接管登记都在 apply 时执行；投递按 D7 的就绪规则在 `sessionController` 与 `sessions` 可用后开始，此前 `notify.status` 保持 `pending`。

接管的 dsh 重新登记：R3/R5 作业在 apply 时即以 D1 的瞬时全局控制器、无 owner、相同 label 经父类 `start` 登记，新 `dsh_job_id` 写入 `run-job.json` 并追加到 `dsh_job_ids`；不等待 `tool-jobs`。登记失败不影响轮询循环、collect 与唤醒。

### D12 可恢复性不变量

无 owner 作业不产生 `job/settled`，因此 `CONTEXT.md` 中"`job/settled` 持久化"对 shud 作业改为以下可观察断言（shud-run-jobs「Recoverability invariant」）：对任一在 SIGTERM 或 SIGKILL 前已返回 `job_id` 的 shud 作业，重启后（1）`run-job.json` 存在且状态只沿 D5 状态机前进；（2）最终存在 `run-record.json` 或 `collect-error.json`；（3）同一运行目录至多出现一个 SHUD 进程；（4）在挂载 `session-controller` 的 profile 中，`notify.status` 最终为 `delivered`（发起会话的 session log 有一条 `source.kind: shud-jobs`、含该 `run_id` 的用户消息）或 `unreachable`（带原因）；（5）同一前提下，该作业最终出现在 `completed.json` 且不在 `active.json`。非 shud 作业仍按 dsh 语义写 `job/settled`。

### Sketch seams under test

- `decideRawAccess(call, options)`（raw-guard 纯函数）：`shud_run` 新判定沿用现有最高 seam，与既有 vitest 表同构。
- `reconcileEntry(snapshot)`（dsh-shud-jobs 纯判定函数）：输入 `run-job.json`、`exit_code`、`wrapper.pid` 与进程探测结果，输出 D11 表的行号与动作；每行一个正例，相邻行互为反例。
- `ShudJobRegistry` 的公开面（提交、查询、collect、kill、对账入口）在临时目录 + 伪 `shudBin`（写退出码的 shell 脚本）+ 手写 `agents`/`sessionController`/`sessions` 替身 + 经 `createScope`（测试专用导入）只在作用域内挂载的控制器下做集成测试：持久化、并发与锁、teardown、对账、唤醒五类不变量都经这一 seam 证明，无需真实 SHUD。
- RunJob/RunRecord Zod schema 的 `parse`：字段、id、状态、可空引用的正反例。
- `pnpm run shud:restart`：真实宿主 + 真实 ccw 的端到端 seam，只在本机运行，判据取 session log 与运行目录。

## Risks / Trade-offs

- [继承 `LocalJobRegistry` 依赖其公开方法、teardown 行为、`attachController` 绑定调用方上下文与 `servesOwner` 只在 `start` 时读取，宿主升级可能改变] → 白名单 ADR 记录耦合面；里程碑边界的 `chore(dsh-upgrade)` 必查 `jobs-local` 变更；集成测试覆盖 teardown 路径。
- [teardown 时让登记以 `failed` 结算，dsh 视图与真实进程状态短暂不一致] → detail 文案说明后台继续；对账后以新登记接管，RunRecord 以运行目录为准。
- [无 owner 登记使 shud 作业对所有会话可见、可被任一会话 kill] → 单用户工作台前提下接受；kill 仍经 collect 与唤醒留下记录。
- [pid 复用导致把别的进程当成仍在运行的 shud] → 同时比对 pid 与记录的进程启动时间；不一致即按"不存活"处理。
- [shud 不套沙箱，可写任何其进程有权限的位置] → 运行目录与输入路径由 raw-guard 与注册表校验；`-o` 固定在运行目录；单用户工作台前提写入 spec。
- [`lstat` 复核与 `mkdir` 之间的符号链接替换竞态] → 需要并发的恶意改动，单用户前提下接受；复核失败即删除并报错。
- [并行 SHUD 争用 CPU/内存] → M2 上限为 dsh 无 owner 桶；调度留 M5。
- [至少一次投递可能产生重复唤醒] → 消息含 `run_id`，模型与 PI 可识别；窗口仅在 followup 与置位之间。
- [输入整份复制，大输入耗盘耗时] → 复制字节数记入 RunJob；复制在 `shud_run` 内同步完成，失败即工具错误、清理部分目录，不部分运行。
- [headless profile 无 `session-controller`，shud 作业的唤醒永远停在 `pending`] → 验收与日常使用都走 Web 模板；headless 中经 `shud_collect` 取记录；宿主若日后提供启动完成信号，再经 spec 复审改为终态 `unreachable`。
- [`completed.json` 只增不减] → M2 单用户量级可接受；清理策略随 M3 记录归档再定。

## Migration Plan

- 合入顺序（按依赖，不按组号）：1 spike → 2 升级评估与规范文档对齐 → 3 白名单 → 15 `generate.ts` 拆分 → 4 schema → 5 注册表骨架（行为不变的替换）→ 8 `stateDir` 锁与索引 → 6.1/6.2 提交（含瞬时全局控制器）与脱离运行 → 6.3 轮询循环与结算 → 7 collect → 9 取消与 teardown → 10.1 文件级对账 → 10.2 接管登记 → 11 唤醒投递 → 13 raw-guard → 12 工具与挂载 → 14 验收脚本与矩阵 → 16 Epic 验收。骨架阶段 profile 已改挂 `dsh-shud-jobs`，但非 shud 行为不变，`profile:smoke` 与 `raw-guard:probes` 必须保持绿。
- 配置：`stateDir`、`shudBin` 是机器路径，bundle patch 不提供；`profile:install` 要求环境变量 `SHUD_BIN`，并在用户 profile patch 写入 `- id: jobs` 行（`shudBin: $SHUD_BIN`、`stateDir: $DSH_HOME/profiles/<name>/shud-jobs`）。`profile:smoke` 与 `raw-guard:probes` 以临时占位可执行文件作为 `SHUD_BIN` 调用 `profile:install`。Runtime Lifecycle 文档在挂载该行的同一 PR（5.2）更新。
- 回滚：profile patch 删除 `- id: jobs` 覆盖行即恢复 `jobs-local`；`runs/` 目录与 `stateDir` 可保留供人工查阅。
- 文档：与本设计冲突的规范文档在实现组之前（2.2）对齐；`Minimal_Schemas.md`（frozen）在 2.2 标注字段处置、在 schema 任务中按 Zod 修订 id 与状态集，并在文首注明修订来源为本 change。

## Not yet specified

- 用户自有 SHUD 输入目录的生命周期（AutoSHUD 产物如何进入、是否需要 DataProvenance 记录来源）——M3 DataProvenance 与 AutoSHUD 编排推到时再界定。
- 超大输入的复制优化（硬链接、只复制 SHUD 会写回的文件）——M2 恒为完整复制（shud-run-jobs「Shud job submission」）；优化等真实流域输入出现后才能说清问题。
- `completed.json` 的清理与运行目录的归档策略——随 M3 记录归档界定。

## Open Questions

由首个子 issue（限时 spike）回答，结论写回本 design。结论若要求修改 specs，只改受影响的 requirement，并对被改的 requirement 走一轮 Stage 3 式的并行复审后才进入实现；推翻 D1/D4/D5/D7/D11 或下列标明"停下"的情形时停下回报，由编排方重开设计决策。

- O1：`LocalJobRegistry` 的 producer `cancel(reason)` 能否可靠区分宿主 teardown 与 kill（候选：子类覆写公开 `kill` 写 `cancel_requested_at` 标记，`jobs-local/src/index.ts:332`；或理由字符串 `'jobs service disposed'`）。
- O2：插件以 `detached: true` 直接 spawn 的包装进程能否活过宿主的 SIGTERM 与 SIGKILL（macOS 进程组与宿主退出钩子）。
- O3：`shud:restart` 能否以脚本方式重启 Web 模板的 dsh（`--no-open --port`）并经其 HTTP 接口发起会话、恢复同一会话以观察唤醒。headless 模板不挂 `session-controller`，按 D7 唤醒停在 `pending`，不能证明投递，故不作候选。否定时停下。
- O4：工具执行上下文能否拿到本次响应的 model id，以及该 Agent 当前生效的已配置模型 id（D10）。两者都拿不到时停下。
- O5：在宿主中确认并记录证据：（a）只有作用域控制器（preset 内的 `tool-jobs`）时无 owner `start` 抛 `no job controller serves this agent`；注册表以自身无作用域上下文瞬时挂载的控制器落在全局层，使无 owner `start` 成功，释放后有 owner 作业的准入与 `jobs-local` 相同；（b）preset 内 `tool-jobs` 的 `job_list`/`job_output`/`job_kill` 与 Web 作业卡能看到并 kill 无 owner 作业；（c）宿主层插入的 `shud-tools` 行对 preset 内的 Agent 可见；（d）`ctx.inject(['sessionController', 'sessions'], 回调)` 在 Web 模板中于 `session-controller` 行 apply 后触发、不成环（`SessionController.inject` 不含 `jobs`，需确认传递依赖）。（a）中瞬时挂载不可行时停下：常驻全局控制器会改变非 shud 作业的准入，须重开决策；其余任一否定时同样停下。
- O6：`Config` 并集能否在 ADR-0006 白名单内声明（不运行时 import `@deepseek-ai/schemastery`，例如复用 `LocalJobRegistry.Config` 实例自身的组合能力）。需要放宽白名单时停下（白名单修订属 PI 决策）。
