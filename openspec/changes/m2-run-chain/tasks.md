# Tasks

合入顺序按依赖而非组号，见 design.md「Migration Plan」：1 → 2 → 3 → 15 → 4 → 5 → 8 → 6.1 → 6.2 → 6.3 → 7 → 9.1 → 10.1 → 9.2 → 10.2 → 11 → 13 → 12 → 14 → 16。各任务写明的"依赖"是硬前置。

## 1. 限时 spike：回答 design Open Questions（O1–O6）

- [ ] 1.1 在 `../dsh-spike`（不进入本仓库）用一次性插件验证：O1 teardown 与 kill 在 producer `cancel` 中能否区分（含覆写 `kill` 写标记的候选）；O2 `detached: true` 直接 spawn 的包装进程能否活过宿主 SIGTERM 与 SIGKILL；O3 脚本能否重启 Web 模板的 dsh 并经 HTTP 接口恢复同一会话观察唤醒（headless 无 `session-controller`，不作候选；记录可用命令）；O4 工具执行上下文能否取得本次响应的 model id 与 Agent 已配置模型 id；O5 只有 preset 作用域控制器时无 owner `start` 抛错、注册表以自身无作用域上下文瞬时挂载的全局控制器使其成功且不改变有 owner 作业的准入、preset 内 `tool-jobs` 与 Web 作业卡能看到并 kill 无 owner 作业、宿主层 `shud-tools` 行对 preset 内 Agent 可见、`ctx.inject(['sessionController', 'sessions'], 回调)` 在 Web 模板中于 `session-controller` apply 后触发且不成环（每项在宿主源码与 spike 中给出证据）；O6 `Config` 并集能否不运行时 import `@deepseek-ai/schemastery` 声明。以用户可见步骤收尾：在 `dsh --profile shud` 的 Web 里跑 ccw，重启 dsh 后 shud 仍在运行（ADR-0004 K13）。验证：`docs/Migration_Plan_dsh.md` 新增 spike 记录（命令、session log 路径、观察结果），design.md 的 O1–O6 改写为已答结论。停止条件：任一结论推翻 D1/D4/D5/D7/D11，或 O3 否定、O4 两者皆不可得、O5 任一否定（含瞬时全局控制器不可行）、O6 需放宽白名单时，停下回报，由编排方重开设计决策；结论只要求改 spec 时，只改受影响的 requirement，并对其走一轮 Stage 3 式并行复审后才进入第 3 组之后的实现

- Suggested fixture level: none - 只产出记录与 design 结论，不合入代码
- Minimal mergeable slice: atomic: 一份 spike 记录与对应 design 更新，拆开会让结论与依据分离

## 2. 里程碑边界：dsh 升级评估与规范文档对齐

- [ ] 2.1 按 Phased_Plan §6 评估升级：核对 npm `@deepseek-ai/dsh` 的 latest/next 与钉版 `0.2.1-rc.2`，读 `../deepseek-harness/docs/upgrade-guide/` 中 rc.2 之后的条目（若有），重点看 `jobs`、`jobs-local`、`tool-jobs`、`api/session-controller`、`storage` 与 session 恢复；无新版本时记录"跳过及原因"，#233 保持 open 待真正升级时复核。验证：`docs/Migration_Plan_dsh.md` 日志节新增一条带日期的评估记录；`pnpm run docs:check` 通过
- [ ] 2.2 在实现组（第 4 组起）之前对齐与本设计冲突的规范文档：`docs/04_IMPLEMENTATION/Phased_Plan.md` §2 把"经 `ctx.storage` 域持久化"改为工作区 `runs/<run_id>/` 文件加 `stateDir` 索引（design D2），并把"已退→补 `job/settled`"改为 shud 作业的对账、collect 与 `shud-jobs` 唤醒；`docs/03_SPEC/Park_Resume_Design.md` §5（collect 失败产物改为 `collect-error.json`）、§9 与附录 A（唤醒从运行目录读回而非 `ctx.storage`，审查清单去掉队列项、增加对账表与无 owner 登记项）；`docs/adr/implemented/0004-dsh-kernel.md` 开放项"JobRegistry 记录落点"关闭并链接本 change design D2；`CONTEXT.md` Jobs 上下文的对外契约由"`job/settled` 持久化"改为 shud-run-jobs「Recoverability invariant」的五条断言；`docs/03_SPEC/Minimal_Schemas.md` 按 run-records「Generated projection」标注字段处置（`cwd` 由 `run_dir` 取代、`command` 改 argv、`resources.max_memory_mb`/`cost_budget`/`artifacts.metrics_summary`/`artifacts.plots` 标"M3"）；`instructions/agents/shared.md` Observability 节注明 shud 作业以运行目录与 `shud-jobs` 唤醒消息为准（无 owner 作业无 `job/settled`），`pnpm run instructions:render`。验证：`pnpm run docs:check`、`pnpm run check` 通过，生成物无漂移

- Suggested fixture level: compact - 只读评估记录与规范文档对齐，无产品代码
- Minimal mergeable slice: 2.1 首刀（单条评估记录）；2.2 为后继（文档对齐，与 2.1 无依赖，可并行开 PR）

## 3. seam 白名单放宽（ADR-0006）

- [ ] 3.1 修改 `eslint.config.mjs` 的 `no-restricted-imports`：运行时允许 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local`，以及 `@deepseek-ai/dsh-llm` 的具名导入 `createUserMessage`（其它具名运行时导入拒绝）；只在测试文件 glob `**/*.test.ts` 与 `**/test-harness.ts`（跨测试共享的作用域装配文件只能叫 `test-harness.ts`）下额外允许运行时 import `@deepseek-ai/dsh-scope` 的 `createScope`；其它 `@deepseek-ai/*` 只允许 `import type`；`deepseek-harness/**` 路径仍全部拒绝（ADR-0006 决策 1–4）。验证：`pnpm run lint` 0 错 0 警
- [ ] 3.2 `scripts/guardrails/test-guardrails.sh` 增加正反例（ADR-0006 决策 5）：`dsh-jobs`/`dsh-jobs-local` 运行时 import 通过；`import { createUserMessage } from "@deepseek-ai/dsh-llm"` 通过、`dsh-llm` 其它具名运行时导入被拒；`*.test.ts` 与 `test-harness.ts` 中 `import { createScope } from "@deepseek-ai/dsh-scope"` 通过、其它非测试 `.ts`（如 `harness.ts`、`registry.ts`）中同一导入被拒；`@deepseek-ai/dsh-agent` 运行时 import 被拒、`import type { ... } from "@deepseek-ai/dsh-agent"` 通过；`deepseek-harness/` 相对路径 import 被拒；`*.test.ts` 中运行时 import `@deepseek-ai/dsh-agent-loop-testkit` 被拒。验证：`pnpm run test-guardrails` 全绿且新增用例计入总数

- Suggested fixture level: compact - 改共享 lint 闸与其自证，无运行时行为
- Minimal mergeable slice: atomic: 规则与其闸自证必须同 PR，否则 Enforcement Index 声明无证据

## 4. RunJob/RunRecord schema（Critical Path #7）

依赖：15.1（`scripts/schema/generate.ts` 现为 1395 行，`large-file-guard` 阻断触碰 >1000 行文件的提交，而本组必须在其 schema 定义表登记新 schema）。

- [ ] 4.1 在 `packages/dsh-shud-core/src/schemas/` 新增 id 品牌类型与生成函数（`JOB-`/`RUN-` + UTC `YYYYMMDDTHHMMSS` + 4 位小写十六进制，同作业共享随机段）、core 常量（唤醒尝试上限 3、collect 重试上限 3、collect 与唤醒重试间隔 10 秒、kill 宽限 10 秒）与 RunJob Zod schema（run-records spec「Run identifiers」「RunJob record」，含 `running` 必有 `pid` 的约束）；在 `scripts/schema/generate.ts`（拆分后）的 schema 定义表登记 RunJob；`pnpm run schema:generate` 刷新 `docs/generated/`；按 Zod 修订 `docs/03_SPEC/Minimal_Schemas.md` 的 RunJob 段（id 规范、M2 状态集与 `submitted` 新含义、新增字段，文首注明修订来源 `m2-run-chain`）。验证：`core-schemas.test.ts` 对每条 scenario 有正反例；`pnpm run schema:check`、`pnpm run test:coverage` 通过
- [ ] 4.2 新增退出码类别映射与 RunRecord Zod schema（「RunRecord record」，含 `exit_class` 九值、可空 `numerical_health`、必填 `llm.response_model` 与 `llm.response_model_source`、`artifacts.files` 的 `size_bytes` 与 `ArtifactSchema` 同语义）；登记进 schema 定义表；`schema:generate`；按 Zod 修订 Minimal_Schemas 的 RunRecord 段；`openspec/glossary.md` 补 `exit_class`、`run_dir`、`dsh_job_id` 两态术语。验证：同上，覆盖退出码 0/10/12/13/19/20/其它、`cancelled`、`lost`、`configured` 来源各一例

- Suggested fixture level: expanded - Critical Path #7（schema 与生成投影），字段契约为后续所有组的上游
- Minimal mergeable slice: 4.1 首刀（id + 常量 + RunJob 连同其生成投影与文档段，可独立保绿）；4.2 为后继

## 5. 作业注册表骨架：行为不变的替换（Critical Path #4）

- [ ] 5.1 新建 `packages/dsh-shud-jobs`（`@shud-harness/dsh-shud-jobs`）。首刀是测试装配：手写的 `agents`/`sessionController`/`sessions` 替身与最小 cordis 装配（只运行时 import 白名单内的包，作用域经测试专用的 `createScope` 构造），其中控制器只从一个 preset 式作用域上下文挂载（复现 Web 模板）；装配的第一条断言是对父类 `LocalJobRegistry` 的 O5（a）基线：只有作用域控制器时无 owner `start` 抛 `no job controller serves this agent`，从无作用域上下文挂载控制器后成功（瞬时全局控制器的实现与测试属 6.1）。依赖按宿主发布规则（`deepseek-harness/docs/user/develop/basic/publish.md:105`）把 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-timeout`、`@deepseek-ai/dsh-brand`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-workspace`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/cordis` 同列 `peerDependencies` 与 `devDependencies`（后两个为唤醒所需，与宿主 `schedule` 包相同）（钉 `0.2.1-rc.2`，cordis 钉现有版本；`autoInstallPeers: false` 下逐个显式声明），knip workspaces 登记（沿用现有包的 `entry: ["src/**/*.test.ts"]`、`project: ["src/**/*.ts"]`；`test-harness.ts` 只被测试文件引用，经 entry 可达，不算未用文件）；包 `tsconfig.json` 的 `exclude` 增加 `src/**/test-harness.ts`，使其与测试文件一样不进入 `lib/`；`vitest.config.ts` 不改，`test-harness.ts` 计入覆盖率（每个注册表测试都执行它）。然后 `ShudJobRegistry extends LocalJobRegistry`，只做配置校验（`Config` = 父类 `Config` ∪ {`stateDir`, `shudBin`}，按 O6 结论声明；必填键、可写/可执行与并集外键拒绝），非 shud 行为全部委托父类。验证：上述 O5（a）基线断言；shud-run-jobs「Registry configuration」的 apply 级 scenario 各一 vitest；「non-shud spec through the registry」集成测试对同一组操作分别驱动 `ShudJobRegistry` 与 `LocalJobRegistry` 并比对结果（承担「bash background job unchanged」的进程内证据：登记、`job_output`、owner 结算事件一致）；「non-shud job not durable」：释放注册表实例后新实例对原 id 报 `unknown job`，`stateDir` 无活动索引条目、cwd 无运行目录；`pnpm run test:coverage` 通过
- [ ] 5.2 依赖 5.1。profile patch 以 `- id: jobs` + `disabled: true` 禁用 `jobs-local` 行，并以 `- insert:` 插入 `shud-jobs` 行指向新包（不含机器路径，design D1）；`profile:install` 要求 `SHUD_BIN` 并写入/替换用户 patch 的 `- id: shud-jobs` 行（shud-profile「Idempotent profile installation」）；`profile:smoke` 与 `raw-guard:probes` 以临时占位可执行文件为 `SHUD_BIN` 调用 `profile:install`；`profile:smoke` 增加 `jobs` 行禁用、`shud-jobs` 行挂载的断言与真实启动检查（「Local profile smoke」；`shud-tools` 断言随 12.1 加入）；同一 PR 更新 `instructions/agents/shared.md` Runtime Lifecycle（`SHUD_BIN` 前置、`shud-jobs` 行由 install 写入、`stateDir` 位置与锁）并 `pnpm run instructions:render`。验证：`pnpm run profile:smoke` 本机与 CI 通过；`profile:install` 缺 `SHUD_BIN` 负例非 0；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变；`pnpm run check` 通过

- Suggested fixture level: expanded - 替换宿主唯一的作业注册表，影响所有后台作业；Critical Path #4
- Minimal mergeable slice: 5.1 首刀（测试装配、包与配置校验，未挂载时不影响 profile，可独立保绿）；5.2 为后继

## 6. shud 作业提交与脱离运行（Critical Path #4）

依赖：4.1、8.1。

- [ ] 6.1 实现同步提交：分配 id、按 lstat 规则建并复核 `runs/<run_id>/`、完整复制输入、按需改写副本 `END`、原子写 `run-job.json`（`created` → `submitted`）与活动索引（写 `created` 前把 `run_id` 加入进程内提交在途集合，写出 `running` 或回滚后移出），以无 owner、`kind: shud`、label `<run_id>[ <label>]` 经父类登记并把 `stdout.log` 作为输出源——登记经一个辅助函数完成：用构造函数捕获的注册表自身（无作用域）上下文调用父类 `attachController('shud-jobs')`，同步调用父类 `start`，在 `finally` 中释放（10.2 复用同一辅助函数）；记录 `owner_session`、`dsh_job_id`、`label` 与提交参数中的 `llm.response_model`/`response_model_source`；复核失败、复制失败或父类 `start` 抛错（含无 owner 桶上限）时删除运行目录与索引条目并抛错（shud-run-jobs「Shud job submission」「Concurrent runs」）。验证：伪 `shudBin` 集成测试覆盖原输入字节不变、`END` 改写、复制失败后无残留、符号链接 `runs/` 被拒、上限超出后无残留、两作业并行、以 `dsh_job_id` 调 `job_output` 读到增量；提交在途期间轮询不结算该条目（「poll during in-flight submission」，与 6.3 联测）；辅助函数的三个测试：只有 preset 作用域 `tool-jobs` 时提交成功且该 preset 内 `job_list`/`job_output`/`job_kill` 可用（「only preset-scoped tool-jobs」）、提交返回后全局层无残留控制器、随后无控制器组合中的有 owner 非 shud `start` 仍抛错（「no resident global controller」）
- [ ] 6.2 依赖 6.1。实现包装进程：直接 spawn `/bin/sh`（`detached`、stdio 到文件、`unref`），先写 `wrapper.pid`，再执行 `<shudBin> -o output/<project>.out <project>`，结束写 `exit_code.tmp` 后 rename；记录 pid 与进程启动时间并置 `running`（「Detached execution and exit capture」）。验证：伪 `shudBin` 退出 0 与 13 各一测试；测试进程模拟宿主退出（子进程中启动后 SIGKILL 该子进程）后包装进程仍写出 `exit_code`

- [ ] 6.3 依赖 6.2。实现唯一的进程内轮询循环与结算步骤（不含 collect 与投递步骤）：循环以父类 `pumpPollMs` 为周期遍历活动索引中未 `delivered`/`unreachable` 且不在提交在途集合中的条目，作为注册表上下文的 effect 运行（释放或重载即停止），同一条目同一时刻至多一个步骤在途；结算步骤在出现 `exit_code` 时按退出码结算、进程不存活再读后无 `exit_code` 则按 `cancel_requested_at` 有无结算为 `cancelled`/`lost`，先原子写 `run-job.json` 终态再以 producer `done` 结束当前 dsh 登记；collect 与投递步骤留空，分别由 7.1、11.1 接入（「Registry poll loop」）。验证：伪 `shudBin` 退出 0 与 13 后 `run-job.json` 终态与 dsh 登记结算顺序正确；外部 SIGKILL 包装进程后得 `lost`；轮询期间 `exit_code` 出现时不误判 `lost`；无 dsh 登记（模拟接管前）时照常结算；注册表释放后循环不再运行、重载后只有新实例的循环；在 `submitted` 写出与 `running` 写出之间强制运行一轮时条目不被判 `lost`（「poll during in-flight submission」）

- Suggested fixture level: expanded - 进程生命周期、结算顺序与持久化文件的原子性，Critical Path #4
- Minimal mergeable slice: 6.1 首刀（提交与落盘，以不 spawn 的测试 producer 停在 `submitted`，可独立保绿）；6.2、6.3 依次为后继

## 7. 结算时自动 collect

依赖：4.2、6.3。

- [ ] 7.1 实现 collect：读 `exit_code`、按映射得 `exit_class`、扫描 `output/<project>.out/` 生成相对路径与字节数清单、算 `wall_seconds`、从 `run-job.json` 复制 `llm.response_model` 与 `llm.response_model_source`，写 `run-record.json` 并置 `collected`；已存在则原样返回；失败时写 `collect-error.json`、置终态；作为轮询循环的 collect 步骤接入，collect 重试由循环在 `attempts` 未达上限时逐轮驱动（「Automatic collect」「Registry poll loop」与 run-records「RunRecord record」）。验证：七个退出码、`cancelled` 与 `lost` 的集成测试；重复 collect 文件 mtime 不变；输出 RunRecord 经 core schema 解析通过；`run-job.json` 缺 `llm.response_model` 时 collect 失败并写 `collect-error.json`（不写占位值）；`exit_code` 非整数时三次重试后停止且 `attempts` 为 3、`run-job.json` 不为 `collected`；暂时不可读的产物目录在重试间隔后重试成功（「in-process retries」的 collect 部分），重试间隔内不重复尝试

- Suggested fixture level: expanded - 产出不可变结果记录，幂等性属 Critical Path #4
- Minimal mergeable slice: atomic: collect 成功与失败是同一函数的两个出口，拆开无法单独验证"恰有其一的结果文件"与幂等

## 8. `stateDir` 锁与索引（Critical Path #4）

依赖：5.1；先于 6.1。

- [ ] 8.1 实现 `stateDir/lock`（pid + 进程启动时间；存活持有者使 apply 失败并指明 `stateDir` 与 pid；陈旧锁接管；释放时删除），`active.json` 与 `completed.json` 的原子写，以及同一实例内索引修改的串行化（先写完成索引再移出活动索引）（shud-run-jobs「State directory lock and indexes」）。验证：两个并发提交都进入 `active.json`；第二个注册表实例以同一 `stateDir` apply 失败且诊断含持有者 pid；持有者 pid 已退出时接管成功；移出活动索引前崩溃（模拟）后条目仍可经完成或活动索引找到

- Suggested fixture level: expanded - 跨进程互斥与索引一致性，Critical Path #4
- Minimal mergeable slice: atomic: 锁与索引写共用同一互斥假设，拆开会出现无锁的索引写窗口

## 9. 取消与宿主 teardown

依赖：6.3（kill 的 first-wins 结算由轮询循环的结算步骤完成）；9.2 另依赖 10.1（其验证断言新实例对账按 R8 得 `cancelled`）。

- [ ] 9.1 实现 kill：覆写公开 `kill`，对 shud 作业先写 `cancel_requested_at` 再交父类；producer `cancel` 见标记即对包装进程组 SIGTERM，宽限后 SIGKILL；结算 first-wins（「Cancellation」）。验证：以 `dsh_job_id` kill 运行中作业得 `cancelled`；`exit_code` 已写出后 kill 得按退出码结算；Web 作业卡路径（以 `'cancelled by the user'` 理由调用 `kill`）与模型路径结果相同
- [ ] 9.2 实现 teardown 放手：按 spike O1 结论识别宿主 teardown（producer `cancel` 未消费到 `kill` 覆写设的一次性标记），不杀包装进程，在 `cancel` 内同步以 `failed` 结束本次登记的 producer `done`；已有 `cancel_requested_at` 时先重发 SIGTERM、detail 写 kill 进行中；`run-job.json` 与索引保持（「Host teardown keeps shud running」）。验证：释放注册表实例后包装进程存活、无 `run-record.json`、无唤醒；kill 后宽限期内释放注册表的集成测试中释放在宽限期内返回、登记 detail 含 kill 进行中、`cancel_requested_at` 保留，新实例对账按 R8 得 `cancelled`（「teardown during kill grace period」）；释放发起会话 Agent 的替身后作业照常结束并被 collect

- Suggested fixture level: expanded - 区分 kill 与宿主退出是持久化正确性的核心，Critical Path #4
- Minimal mergeable slice: 9.1 首刀（kill 独立于 teardown，可独立保绿）；9.2 为后继

## 10. 启动对账与接管（Critical Path #4）

- [ ] 10.1 依赖 6.3、7.1、8.1、9.1。实现纯判定函数 `reconcileEntry` 与文件级对账：D11 表 R1–R12 的结算、collect（R9 含"记录已写、状态未置位"，R10 为 collect 已达上限且状态不变）与索引迁移，"不存活"后再读 `exit_code`，`notify.status` 一律留 `pending`（投递属第 11 组）；R3/R5 只交给轮询循环、不做 dsh 登记（「Startup reconciliation」）。验证：`reconcileEntry` 每行一个正例、相邻行互为反例（含 R5 与 R8 以 `cancel_requested_at` 区分、R9 与 R10 以 collect `attempts` 区分）；每个对账 scenario 一个集成测试（新注册表实例读取同一 `stateDir`）；重复对账不产生第二份 RunRecord；任何行都不重新 spawn
- [ ] 10.2 依赖 1.1 的 O5 结论、10.1。实现接管登记：apply 时把 R3/R5 作业经 6.1 的登记辅助函数（瞬时全局控制器）以无 owner、相同 label 登记，写 `dsh_job_id` 并追加 `dsh_job_ids`；登记失败不影响轮询循环（「Takeover registration」）。验证：只有 preset 作用域控制器（或尚无任何外部控制器）的装配中，apply 后 `job_list` 出现带 `run_id` 的新登记；登记失败注入测试中轮询循环仍完成结算与 collect

- Suggested fixture level: expanded - park-resume 对账，Critical Path #4
- Minimal mergeable slice: 10.1 首刀（文件级对账，唤醒留 pending，可独立保绿）；10.2 为后继（依赖 O5 与瞬时全局控制器）

## 11. 至少一次唤醒（Critical Path #4）

依赖：6.3、7.1、10.1。

- [ ] 11.1 只实现轮询循环的投递步骤（循环与结算属 6.3，collect 属 7.1）：`ctx.inject(['sessionController', 'sessions'], 回调)` 触发后投递步骤才生效；对已 collect（或 collect 失败达上限）且 `notify.status: pending` 的条目 `resolveAgent(owner_session)` → 以 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造消息并扩充 `MessageSourceMap` 声明 `shud-jobs` 来源 → `followup` → `ctx.sessions.flush` 成功后置 `delivered` → 写完成索引并移出活动索引；在线结算、对账补结算、R10/R11 补投递与接管作业结束都走此路径；无豁免；服务未就绪时保持 `pending`，`owner_session` 为空或会话不存在立即 `unreachable`，暂时性失败计入 `notify.attempts` 并由循环逐轮重试至上限（「At-least-once wake」）。验证：替身注入的集成测试覆盖在线结算唤醒且无 `tool-jobs` 通知、重启后唤醒、`sessionController` 晚于注册表注入时仍 `delivered`、kill 后唤醒、崩溃窗口重投、会话删除 `unreachable`、无 `sessionController` 时 `shud-jobs` 行仍激活且保持 `pending`、flush 失败三次后 `unreachable`；flush 失败一次后在重试间隔后 `delivered`（「in-process retries」的投递部分）；flush 连续失败约 1 秒后恢复仍 `delivered`（「transient failure outlasting several polls」）；重载后无重复唤醒（「no duplicate wake after reload」）；「Recoverability invariant」五条断言在 SIGKILL 模拟后成立；除 `createUserMessage` 外宿主类型只经 `import type`（ADR-0006）

- Suggested fixture level: expanded - 唤醒投递语义与会话恢复，Critical Path #4
- Minimal mergeable slice: atomic: 所有结算路径共用轮询循环中同一个投递步骤与 `notify` 状态机，拆开会出现某条路径无人投递或双投的窗口

## 12. 模型工具包 `dsh-shud-tools`

依赖：13.1（未识别 `shud_run` 的 raw-guard 会对其返回 NEXT，挂载在前会开出 raw 写窗口）、11.1。

- [ ] 12.1 新建 `packages/dsh-shud-tools` 并实现 `shud_run`（参数契约、无 `workdir`、未知参数拒绝、校验项含输入内符号链接拒绝、响应模型捕获（rc.2 恒记 `configured`：先 `requestHeader()?.config.model` 后 `options.model`，含 `source.model` 不得记为 `response` 的反例测试，design O4）、立即返回 `job_id`/`run_id`/`dsh_job_id`/`run_dir`/`running` 或工具错误；经 `ctx.jobs` 提交），profile patch 插入 `shud-tools` 行，`profile:smoke` 增加该行断言（shud-run-tools spec「shud_run arguments」「Response model capture」「shud_run validation」，shud-profile「Profile composition」）。验证：每条 scenario 一测试；`pnpm run profile:smoke` 通过
- [ ] 12.2 实现 `shud_collect`（`job_id`/`run_id` 二选一、活动索引再完成索引查找、终态未 collect 先 collect、collect 失败返回原因、非终态返回当前 `dsh_job_id`、不存在报错、多次调用同一记录）。验证：每条 scenario 一测试，含移出活动索引后从另一会话查找

- Suggested fixture level: compact - 工具层参数契约与委托，持久化逻辑在 dsh-shud-jobs
- Minimal mergeable slice: 12.1 首刀（`shud_run` 与挂载可独立保绿）；12.2 为后继

## 13. raw-guard 识别 `shud_run`（Critical Path #1/#2）

先于 12.1 合入。

- [ ] 13.1 在 `decideRawAccess` 增加 `shud_run` 判定：目标 `<session cwd>/runs/<run_id>` 按最近存在祖先解析后在 raw 内 deny，`input_dir` 在 raw 内 ask，二者都不触及时 next，`input_dir` 缺失或类型不符不抛错；测试放新文件 `decide-shud-run.test.ts`（`decide.test.ts` 已近 1000 行）（raw-data-guard「shud_run is guarded」）。验证：每条 scenario 含符号链接 `runs/`、`rawDirs: ["runs"]` 与 macOS `/var` 别名各有正反例；改动前对 origin/main 的 `decide.ts` 新 deny/ask 行为红；`pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变

- Suggested fixture level: expanded - 策略门决策与 raw 保护，Critical Path #1/#2
- Minimal mergeable slice: atomic: 单一判定分支与其测试表

## 14. 重启验收脚本与不变量进矩阵

依赖：10.2、11.1、12.1。

- [ ] 14.1 新增 `scripts/runtime/shud-restart.sh` 与 `pnpm run shud:restart`：按 spike O3 结论驱动 Web 模板的 dsh，在临时 `DSH_HOME` 与工作区以真实 ccw 跑 SIGTERM、SIGKILL 两个用例，判据取 session log（`shud_run` 的 `tool/result` 与 `shud-jobs` 唤醒消息）、运行目录与 `stateDir`，逐条断言「Recoverability invariant」（「Restart acceptance script」）；缺 SHUD、dsh 或 `DMXAPI_KEY` 时先行非 0 退出。验证：本机两次完整运行均 PASS，PR 附 session log 路径与运行目录摘录；缺二进制负例非 0
- [ ] 14.2 控制面登记：`instructions/agents/` 源的 Verification Matrix 与 Enforcement Index 增加 `shud:restart`（本机，block），`pnpm run instructions:render`；`constraints.yaml` verification 镜像增加该命令并移除 "runtime invariant companions" 的 review_only 条目；`CONTEXT.md` Jobs 上下文的不变量（2.2 已改写）指向 `shud:restart` 与第 6–11 组的集成测试。验证：`pnpm run docs:check`、`pnpm run check` 通过，生成物无漂移

- Suggested fixture level: compact - 本机脚本与控制面文档，无产品代码
- Minimal mergeable slice: 14.1 首刀（脚本可独立运行与评审）；14.2 为后继（矩阵登记必须指向已存在的命令）

## 15. `scripts/schema/generate.ts` 拆分

先于第 4 组合入。

- [ ] 15.1 把 renderer 等可分离部分抽到同目录模块，使 `generate.ts` 及每个新文件 ≤1000 行，schema 定义表留在可独立增行的模块中，并修掉其 3 处 eslint 类型安全基线；`constraints.yaml` 删除该文件的 `max_file_lines` 与 `eslint_type_safety` 基线条目，同步 `.large-file-guard.json`（若有对应排除）。验证：拆分前后 `pnpm run schema:generate` 产物逐字节相同；`pnpm run schema:check`、`pnpm run lint`、`pnpm run check` 通过

- Suggested fixture level: compact - 机械重构，生成物逐字节不变即为证明
- Minimal mergeable slice: atomic: 拆分与基线移除必须同 PR，否则基线条目指向已不成立的事实

## 16. Epic 收口 PI 功能验收（ADR-0007）

- [ ] 16.1 第 1–15 组全部合并后，PI 在 `dsh --profile shud` Web 里一句话让 agent 用 `shud_run` 跑 ccw，运行中重启 dsh，完成后会话被唤醒并给出 RunRecord；编排方从 session log 摘录 `tool/call shud_run`、重启后的 `shud-jobs` 唤醒消息与运行目录 `run-record.json`，记入 `docs/Migration_Plan_dsh.md`（「Epic-close manual acceptance」）。验证：PI 明确给出验收结论；记录 PR 的 `docs:check` 通过

- Suggested fixture level: none - 人工验收与证据记录
- Minimal mergeable slice: atomic: 单次验收记录
