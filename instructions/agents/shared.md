# SHUD-Harness

> 本仓库工程与 agent 操作规则的单一事实源（eng-init 2026-10-20，L3 strict）。bounded contexts 与不变量在 `CONTEXT.md`，领域术语在 `openspec/glossary.md`，阈值与校验镜像在 `constraints.yaml`。

## Code Canonicality

同一逻辑在仓库中只能有一个实现；版本演进属于 git 历史，不属于文件名或标识符。

- 新增函数/类/模块/文件前先 grep 现有实现；有则扩展或重构，确无才新建。
- 文件名、类名、函数名、模块名禁止后缀：`_v1` `_v2` `_new` `_old` `_backup` `_temp` `_copy` `_final` `_real` `_improved` `_refactored` `_fixed` `_legacy` `_deprecated`。已存在的视为待统一的债，不是可延续的模式。
- 原地重构：先提交可工作状态，改原文件，跑测试；坏了就 `git revert`。绝不"以防万一"保留旧版本。
- 没有 `## Source of Truth & Refactor Contract` 书面例外，不允许新旧实现并行过渡。
- 注释掉的代码是 lint 错误不是安全网；未引用导出与死路径是债（knip 阻断）。
- 仓库不是草稿纸：`tmp/` `scratch/` `backup/` `_old/` `wip/` 不得进入提交。

| 规则 | 执行 |
|---|---|
| 禁止后缀 | `.git-hooks/check-naming.sh`（pre-commit + CI `pnpm run naming:check`） |
| 死代码/未用依赖 | `knip.json`（CI `pnpm run deadcode`） |
| 重复代码 ≤3% | `.jscpd.json`（CI `pnpm run dup`） |

## Project Identity

SHUD-Harness is a **PI-led scientific research engineering assistant** for the SHUD hydrological modeling system. It orchestrates SHUD (C++ solver), rSHUD (R toolbox), and AutoSHUD (R automation pipeline) through a Coordinator Agent with Web-first interaction, real-time chat, bash sandbox execution, lightweight memory, and PI-gated governance.

**核心定位**: 不是自治科研平台，而是帮 PI 和工程师节省重复劳动时间的工具，还要提升科研效率、拓展研究员能力边界。成功标准 = 时间节省，不是自治程度。

- 生命周期：年（长期科研基础设施）· 单人维护 · 工具：Claude Code + Codex · 严格度 **L3 strict**（`constraints.yaml`）。
- 产品形态：`dsh --profile shud`（dsh 内核 + `dsh-shud-*` 插件），没有自己的 app；设计账本 [ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)，里程碑 M1–M6 唯一真相源 `docs/04_IMPLEMENTATION/Phased_Plan.md`。
- 首任务：ccw 运行 → RunRecord → EvidenceReport（MVP-1）。任何 spike 不以首任务的一个用户可见步骤收尾就不准开（K13）。

## Stack & Versions

| 层 | 选择 | 钉版 |
|---|---|---|
| 运行时 | Node ≥24（直接运行 `.ts`） / pnpm workspace | `.tool-versions`（24.13.1 / 11.28.5），`package.json#packageManager` |
| 语言 | TypeScript strict，NodeNext，`.ts` 后缀导入 | `tsconfig.base.json`，typescript 5.9.3 |
| 校验/测试 | Zod 4.6.7 · vitest 4.1.12 + coverage-v8 | 根 `package.json` devDependencies |
| 质量闸 | eslint 10 + typescript-eslint（type-aware）· prettier · jscpd · knip · commitlint · gitleaks · semgrep（CI） | 同上；`gitleaks`/`semgrep` 为系统二进制 |
| 宿主 | dsh `dsh-v0.2.1-rc.2`，checkout 在 `../deepseek-harness`，只读 | `profile/shud/package.json` peer |
| 模型 | DeepSeek Flash via DMXAPI（`deepseek-flash-guan`，`DMXAPI_KEY` 仅环境变量） | `profile/shud/cordis.patch.yml` |
| 科学栈 | SHUD C++14 + SUNDIALS（`~/sundials`）· rSHUD 2.5.0 · AutoSHUD | submodule 只读 |

依赖策略：锁文件 `pnpm-lock.yaml` 必须干净（`--frozen-lockfile`）；`autoInstallPeers: false`，绝不从 npm 拉 dsh；Dependabot 每周（`.github/dependabot.yml`），`@deepseek-ai/*` 排除，dsh 升级只走 `chore(dsh-upgrade)` issue。新依赖需在 PR 里写明理由。

## Directory Map

```
SHUD-Harness/
├── packages/dsh-shud-core/      ← 领域层：8 对象 Zod schema、policy-gate-core、role-tool-map（M1 起新增 raw-guard/jobs/tools/records/presets）
├── profile/shud/                ← dsh bundle + cordis.patch.yml（模型路由、出站关闭、插件挂载）
├── scripts/                     ← 确定性脚本：schema/ docs/ adr/ guardrails/ instructions/ runtime/
├── docs/                        ← adr/（四区）· 03_SPEC · 04_IMPLEMENTATION · generated/（勿手编）· 99_ARCHIVE（冻结）
├── openspec/                    ← glossary.md · project-profile.md · changes/
├── instructions/agents/         ← AGENTS.md / CLAUDE.md 的源（shared + codex + claude）
├── .git-hooks/ .github/         ← 本机闸 · CI/release/dependabot
├── .claude/ .codex/ .agents/    ← agent 运行时：settings/hooks 已跟踪，skills/agents 为投影
└── SHUD/ rSHUD/ AutoSHUD/       ← 只读 submodule
```

边界：插件只触碰文档化 seam（`tools/pre-execute`、`ctx.approval`、`ctx.jobs`、`ctx.sandbox`、`ctx.storage`、agent preset），不 import dsh loop 内部，不改 `../deepseek-harness`。新行为去向：对象字段 → `packages/dsh-shud-core/src/schemas/` 再 `pnpm run schema:generate`；治理规则 → `governance/`；运行时/作业 → 对应 `dsh-shud-*` 包；一次性脚本 → `scripts/`。bounded contexts 见 `CONTEXT.md`。

## Development Workflow

- 克隆后：`pnpm install`（自动执行 `prepare` → `core.hooksPath=.git-hooks`）。本机需 `gitleaks`（brew）；`semgrep` 仅 CI。作业输入安全测试另需系统 POSIX `mkfifo`（Darwin/Linux），用于构造真实 FIFO 并验证提交在读取前拒绝；它不是 npm 依赖，缺失时测试失败而非跳过。
- 日常：`pnpm run check` 是唯一默认闸（typecheck → lint → format → coverage → dup → deadcode → naming → schema drift → docs gate）。改 Zod 后 `pnpm run schema:generate`；改 `instructions/agents/*.md` 后 `pnpm run instructions:render`；两者产物都由 CI 比对。
- 运行时：`pnpm run profile:smoke`（dsh 启动 + 路由断言）、`pnpm run shud:tiny`（ccw 30 天）本机运行；CI 有 npm 版 dsh（`profile-smoke` job），无 SHUD。
- 环境：`DMXAPI_KEY` 只经环境变量；本机跑 dsh/gh 前 `unset ALL_PROXY`；`DSH_HOME` 指向临时目录避免污染真实会话。
- 流程：一个 issue 一个分支/worktree，走 `subagent-workflow`；PR ≤400 行（CI 阻断，`size-exempt` label 记录例外）；提交信息 conventional（commit-msg 钩子）；通常 merge 需 CI `all-checks-passed` + PI 功能验收。**Epic #210 例外**：子 PR 完成规定工程验证与审查后可 merge、关闭实现 issue；PI 在整个 Epic 结束时统一功能验收，Epic 关闭与 OpenSpec 归档仍等 PI 明确通过（[ADR-0005](docs/adr/implemented/0005-epic-210-acceptance.md)）。

## Verification Matrix

| 面 | Command | 通过判据 | 级别 |
|---|---|---|---|
| 全部（默认闸） | `pnpm run check` | 以下全部绿 | block |
| 类型 | `pnpm run typecheck` | tsc 0 错 | block |
| Lint（type-aware、max-lines 1000、import 禁令） | `pnpm run lint` | 0 错 0 警 | block |
| 格式 | `pnpm run format:check` | prettier 无差异 | block |
| 单测 | `pnpm run test` | 全绿 | block |
| 单测 + 覆盖率 | `pnpm run test:coverage` | lines/stmts/funcs/branches ≥80% | block |
| 重复 | `pnpm run dup` | ≤3% | block |
| 死代码 | `pnpm run deadcode` | knip 0 error | block |
| 命名 | `pnpm run naming:check` | 无禁止后缀 | block |
| Schema drift | `pnpm run schema:check` | `docs/generated/` 与 Zod 一致 | block |
| 文档闸 | `pnpm run docs:check` | 链接、路径声明、生成指令、决策记录全绿 | block |
| 密钥 | `pnpm run security:secrets` | gitleaks 0 泄漏 | block |
| SAST（CI） | `pnpm run security:sast` | semgrep 0 finding | block（CI） |
| PR 体积 | `pnpm run pr:size` | ≤400 行或已标 `size-exempt` | block（CI） |
| dsh profile 启动（本机 + CI） | `pnpm run profile:smoke` | 路由 deepseek-flash-guan、DMXAPI、session-log-deepseek disabled、raw-guard mounted | block（本机 + CI） |
| raw-guard 五探针（本机，需 `DMXAPI_KEY`） | `pnpm run raw-guard:probes` | T1–T5 PASS、两份 raw md5 不变、总绿汇总（exit 0）；exit 2 = INCONCLUSIVE（模型偏离、guard 证据干净）须重跑，不计回归；exit 1 = 回归 | block（本机） |
| Web 审批卡往返 | 手工：读 raw → Allow once；写 raw → deny | session log 读审批 allowed-once 后成功；写 immutable 且无新审批；raw md5 不变 | manual |
| SHUD ccw tiny（本机） | `pnpm run shud:tiny` | exit 0 + `.dat` 产出，<2 min | block（本机） |
| 闸自证 | `pnpm run test-guardrails` | 每闸拒违规、收干净输入 | block |

## Runtime Lifecycle

无常驻 dev server。以下命令从本仓库根目录执行；先 `pnpm run build` 产出插件 `lib/`。无全局 `dsh` 时使用现有 checkout 的 Node 入口：

```sh
export DSH_HOME="$(mktemp -d)"
export SHUD_BIN="/absolute/path/to/shud" # 替换为本机已构建、可执行的普通文件
pnpm run profile:install
node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --dump-config
```

`profile:install` 要求 `SHUD_BIN` 是绝对路径、可执行普通文件；缺失或无效时在创建/修改 profile 前失败，不回退默认路径。安装器先以 `web` 模板创建 `shud`，再 `link:` 安装本仓库 bundle：禁用旧 `jobs` 行，并插入 `shud-jobs`（不是按 id 改 name）。安装器仅拥有用户 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 的唯一 `shud-jobs` 项，配置 `shudBin` 与 `stateDir: $DSH_HOME/profiles/<name>/shud-jobs`；raw 覆写与其它字节保持不变，相同配置重装不改文件。

`shud-jobs` 在 apply 时取得 `stateDir` 的排他所有权，维护 `active.json`/`completed.json`：索引修改在实例内串行执行，以临时文件 + rename 原子替换，先写 completed 再移出 active。内部 `stateDir/.lock-guard` 是永久协调 inode，不可删除或改名；`lock` 保存 `{pid, pid_started_at}`。唯一组合生命周期 effect 开始释放时同步停止轮询定时器、关闭轮询、collect、托管 SHUD kill 与提交准入，并行等待已接受的启动对账、结算/收集步骤（含排队的直接 collect、异步完成回调）与提交/回滚事务结束，再关闭索引修改准入、等待索引写入完成，最后删除锁元数据并释放内核锁；索引保留。父类 disposer 并发运行，状态解锁不能提前清除仍可能收到父类 cancel 的托管登记分类；正常完成/成功回滚会释放对应关联，关闭实例的剩余关联随实例回收。停止不等待脱离包装进程自然结束，但必须排空已接受的恢复取消；不以提交在途集合清空为条件。第二个持有者被拒绝；已发布持有者的诊断包含 stateDir 与 pid。

运行前提：Darwin 的 `/usr/bin/lockf` 或 Linux 的 `/usr/bin/flock`，以及用于进程身份检查的 `ps`（Linux slim 环境需安装 `procps`）；Linux submitted 恢复还需可读 `/proc/<pid>/stat`、`/proc/uptime` 与有效 `getconf CLK_TCK`。检查固定 locale/时区；不支持的平台、缺失工具或无法确定的进程检查均明确失败，不作不安全回退。锁与 RunJob 身份仍使用秒级 `ps lstart`（RunJob 转为 ISO UTC）；R3 新鲜度另用可比较的出生时间证据，不改锁或 R5/R7 身份判据。时钟不确定性与 PID/组代次限制见 [重启恢复](docs/03_SPEC/Park_Resume_Design.md#9-服务重启恢复)。

注册表已提供 `submitShud(request, producer)`：请求显式携带会话 cwd、输入路径、project、owner_session 与模型元数据。必需的 `producer(prepared, handle, pumpPollMs)` 返回 `ShudExecution`；可调用已导出的 `startDetachedShud(prepared, hooks, pumpPollMs)`，其中 hooks 是调用方显式提供的 `ShudLifecycle` 登记生命周期依赖，没有默认空实现。`pumpPollMs` 由注册表统一解析父类配置并同时供给提交、执行组件与轮询，不新增默认值。提交按物理路径解析 cwd/输入根（保留符号链接与 `..` 的实际遍历语义）；已存在的 runs 根先以 lstat 拒绝链接/非目录，再以 native realpath 解析实际拼写（包括文件系统大小写别名），用于包含关系检查和运行目录记录；尚不存在的根仍从物理 cwd 派生。完整复制普通文件/目录，只在副本改写可选的 END；拒绝内部链接/特殊文件、符号链接运行目录，以及运行根或 stateDir 位于输入树内的布局。持久化顺序为 created → 活动索引 → submitted（dsh id 为 null）→ 瞬时全局控制器下的无 owner 登记 → 写回 dsh id/历史 → 等待真实启动身份 → 原子写 running、pid、pid_started_at、started_at，随后登记本地完成回执，最后清除进程内在途标记并返回校验过的 `running` RunJob。真实登记回调在调用 producer 前关联 dsh id 与运行，再附加实际执行能力；启动失败时直到进程、登记与自有文件/索引回滚成功，才同步释放该关联并清除 D7，失败回滚仍拒绝 kill。stdout.log 经父类输出控制提供增量内容，控制器不常驻。

实际执行使用 detached `/bin/sh` 包装进程，以位置参数 `"$@"` 传递命令，stdout/stderr 追加到运行目录日志，宿主关闭自身日志描述符并 unref 子进程。包装进程须先成功原子发布 `wrapper.pid` 才能启动 SHUD；自然结束后原子发布 `exit_code`，包括非零退出码。包装进程可在宿主 SIGKILL 后继续运行；`exit_code` 是求解器退出证据，子进程事件不直接结算 RunJob。

`ShudExecution` 包含 `hooks`、真实身份的 `started` promise、受控组能力 `isGroupActive()` / `signalGroup("SIGTERM" | "SIGKILL")` / `waitForExit()` 与回滚专用 `abort()`；显式取消和回滚共用所有权检查。`ShudLifecycle` 在 `JobHooks` 上要求两个幂等完成入口：正常终态的 `settle(JobOutcome): void | Promise<void>` 与登记级退出的同步 `detach(detail): void`。两者释放实际登记资源并完成同一个 producer-owned `done`，不另造完成 promise；detach 以 failed 结束登记，不改 durable 运行结果。原 supplied `cancel` 仅供提交回滚，不代替正常结算或宿主 teardown。回滚先证明执行组已不能继续 I/O 并完成本地子进程回收，再取消/等待登记资源、移除父类登记与自有索引/目录，并移除本地完成回执；`hooks.done` 本身不是进程终止证据。尚未回收的原生子进程仍占有其 pid，即使启动时的身份查询失败也可据此回滚，不重复依赖失败的启动戳查询。原生未知非 Z 状态仍按可能 I/O 处理，无法确定的组检查拒绝继续；权限拒绝仅在重新检查明确静止后才可继续，否则保留运行路径与错误原因。已回收的原包装进程 PID 再次出现时拒绝向该组发信号，但不声称能识别替代组的 leader 也已退出的全部历史代次；非 SHUD 父类生命周期不改动。

注册表在 Cordis `[Service.init]` 等待文件级 R1–R12 启动对账后才启动正常 cadence 并就绪；此前 `submitShud()`、`pollOnce()`、`collectShud()`（含 root/non-strict 访问）明确拒绝。恢复取消可使就绪等待首次取消请求的剩余 10 秒宽限期，不从重启重计。对账与正常轮询共用逐条目排他队列，不同条目独立推进；单条目失败保留证据并由既有 cadence 重试，不阻塞其它条目。按父类 `pumpPollMs` 运行唯一调度器，手动 tick 等待已在途步骤，定时器不重复排队；关闭准入后不再读取记录。正常 tick 跳过本进程提交在途、已通知终结、collected、created/submitted 条目；无 dsh 登记的 running 仍可结算，结算/回执后续 tick 才 collect。启动分支及边界详见 [重启恢复](docs/03_SPEC/Park_Resume_Design.md#9-服务重启恢复)。

结算先读 `exit_code`：完整且处于安全整数范围内的十进制整数决定 succeeded（0）或 failed（非零）；已有取消请求也不覆盖退出码。空白、部分数字、小数、不安全整数或不可读文件导致 failed、null exit_code 与明确诊断，原文件保留给后续 collect。仅 ENOENT 表示不存在；此时检查包装进程身份与状态，以时间戳数值比较而非 ISO 字面值比较。观察到消失、身份不同或 Z 状态后必须重读退出码；仍无才按 cancel_requested_at 判 cancelled，否则 failed 并给出 lost 诊断。无法确定的检查或损坏/不一致记录记录错误且不改持久状态、不结束登记，其他条目继续处理。

正常执行结算先原子写 `run-job.json` 的终态、finished_at、exit_code，再调用本地 `settle` 并等待 `done`；succeeded/cancelled/failed 分别映射到父类 completed/killed/failed。持久化失败不经此路径完成登记；完成回调失败保留回执，在后续正常 tick 重试，不改写既有终态、finished_at 或文件修改时间。回执完成前不收集；后续 collect 可以将终态投影为 `collected`。结算与 collect 均不迁移活动索引，也不产生唤醒产物；宿主 teardown 的登记级 detach 与此 durable 结算路径分开。

公开 `kill(id, caller, reason)` 保持同步返回 `requested | already-finished`，仅覆写本实例实际提交并关联的 SHUD 登记，不靠 `kind: shud` 字符串或扫描目录认领作业。先经父类公开 get 做访问与终结状态检查：未知、无权限、已完成或非托管登记保持父类语义；托管活作业在 D7 在途或关闭准入后明确拒绝，不写取消标记、不发信号。首次有效请求以同步原子写持久化 `cancel_requested_at`，随后在调用父类前镜像原始期限到本地 `requestedAt` 并设置一次性标记；适配后的 producer cancel 消费该标记，对本次 spawn 拥有的负 pgid 发 SIGTERM。重复请求保留首次时间和期限，不重复发 SIGTERM；持久化失败不设镜像/标记、不发信号，父类抛错/返回 already-finished 清除未消费的临时标记，但保留已持久化意图及本地镜像。Web 固定理由、模型任意理由乃至 `"jobs service disposed"` 都不决定调用来源；无一次性标记的托管 cancel 走宿主 teardown。

父类公开视图可在异步 `settle`/`done` 完成前滞后于持久终态；kill 以非让出式转换内新鲜且已通过身份/路径校验的 RunJob 为准。若状态已为 `succeeded`、`failed`、`cancelled` 或 `collected`，同步返回 `already-finished`，不写元数据、不设取消标记、不检查进程组、不发信号，也不调用父类 kill。仍为 `running` 时即使已有数值 `exit_code` 文件也照常接受取消请求，后续结算仍保留自然退出证据的优先级。

宿主在线的取消结算由既有轮询 cadence 升级，不新增定时器：按 core `KILL_GRACE_PERIOD_MS = 10000` 从首次请求计时，时钟回退不加速，到期且受控组仍可 I/O 才发 SIGKILL，每次信号前复核所有权。包装进程先退出而抗 SIGTERM 后代仍活着时不能提前结算 durable 结果，必须继续跟踪该组至静止。静止后按严格退出文件 first-wins 结算：有效数值文件仍决定自然成功/失败，无文件且有最新取消意图才是 cancelled，非法/不可读文件仍是 failed；正常执行的持久化终态和本地回收先于 producer 完成。

宿主 teardown 在同步 cancel 回调内调用 `detach`：无取消意图时不发信号，以受控 detail 说明 SHUD 继续后台运行；有本地持久意图镜像时先经原所有权证明重发 SIGTERM，再以 kill-in-progress detail 结束登记。信号/检查失败记录受控阶段和错误码，`finally` 仍完成同一个 done 为 failed，不冒充进程已终止。此路径不读写 RunJob/索引、不 collect/唤醒、不 SIGKILL、不等待进程或重置期限；已接受的启动 R8/正常异步工作仍按原 drain 规则排空后放锁。SHUD 登记无 owner，发起 Agent 释放不影响其继续运行和正常收集；Darwin R7/Linux R8 原生验证及 #343 边界见 [重启恢复](docs/03_SPEC/Park_Resume_Design.md#9-服务重启恢复)。

取消写入、轮询终态及 collect 状态投影共用新鲜 RunJob 的同步校验/转换/原子发布边界：读取、身份/路径校验、字段转换与 `writeJsonSync` 之间不 await，保留本次转换不拥有的最新字段，不以旧快照覆盖取消意图或回退新终态；cancelled 与 lost 的选择也读取该边界内的新标记。提交期元数据仍由 D7 隔离；RunRecord 与重试记录保持原有异步发布、不可变结果及重试提交边界。

注册表公开后端 API `collectShud(id: RunId | JobRecordId): Promise<RunRecord>`，可查活动或完成索引；它与自动 collect 使用同一实现和逐条目队列。直接调用等待该条目已接受的工作及未完成回执；失败调用不阻塞后续请求。未知 id、非终态与本进程提交在途条目拒绝且不创建收集产物。当前没有挂载 `shud_collect` 工具。

收集先验证运行路径与身份，再校验终态完整字段。缓存的数值 exit_code 必须有相同的有效退出文件；缓存为 null 时，有效文件可恢复退出分类，仅文件真正缺失才按取消状态/标记判 cancelled，否则 lost。不可读、非法或不一致的退出证据明确失败，不降级为 lost；退出证据失败将 RunJob 置为 `failed`，包括原 succeeded/cancelled，保留 exit_code、取消标记、身份与时间等其它字段。其它收集失败保留终态；无法合法重写的损坏记录保留原字节。日志只记录路径，输出仅扫描 `output/<project>.out/` 的元数据，生成排序的 POSIX 相对路径及实际字节数，不读取日志/产物内容；初始输出目录真正不存在可为空清单，链接、特殊文件、不可读目录或扫描中消失均失败。RunRecord 保留引用、argv 与模型来源；时间齐全时计算 wall_seconds，否则为 null，负时长拒绝；数值健康四项与 peak_memory_mb 保持 null。

经 core schema 校验后原子发布 `run-record.json`，再原子投影 RunJob 为 `collected`。有效且身份匹配的已有 RunRecord 优先原样返回，字节与 mtime 不变；结果发布是提交边界，后续状态投影失败只重试投影，不重新扫描、改写结果或增加生成失败次数。生成失败写本地 `collect-error.json`（严格的 `attempts`、`last_error`、`at`）；诊断仅含受控阶段、字段路径或 errno，不持久化/记录原始异常载荷。损坏的重试记录保留且不重置，并阻止新的生成尝试。自动路径首次及时尝试，之后沿用 core 常量 `COLLECT_RETRY_INTERVAL_MS = 10000` 与 `MAX_COLLECT_ATTEMPTS = 3`，按持久时间间隔重试，时钟回退不加速；直接 collect 可越过间隔/次数上限，但不能绕过损坏记录重新生成结果。成功重试保留既有错误记录字节与 mtime。

启动对账只恢复文件与已验证的取消控制，不创建 dsh 登记或唤醒；pending notify 保持原样，仅已验证 delivered/unreachable 的 R12 修复完成索引。接管登记（#312）、唤醒投递（#313）及工具入口尚未接入，不声称完整跨重启恢复或 PI Web 验收。R7 孤儿组边界（#343）与 `wall_seconds` 测量语义（#344）仍待裁决，见上述恢复说明。`pnpm run shud:tiny` 仍是独立真实求解器 smoke，与提交共用 `packages/dsh-shud-jobs/src/shud-end.ts` 的 END 更新器；`SHUD_TINY_DAYS` 默认仍为 30 天，其结果不能替代注册表运行证据。

安装与启动必须沿用同一导出的 `DSH_HOME`。需要审批卡/作业卡时，在同一环境执行 `node ../deepseek-harness/apps/cli/lib/bin.js --profile shud --no-open --port <p>`（profile 已选择 Web 应用，不再传 `web` 位置参数）。headless 任务改用同一 bundle 的独立 profile，并同样保留 `SHUD_BIN`：

```sh
PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless pnpm run profile:install
node ../deepseek-harness/apps/cli/lib/bin.js --profile shud-probe --json "<task>"
```

headless 任务同样沿用上述 `DSH_HOME`，真实 LLM 调用需环境变量 `DMXAPI_KEY`。切换到研究 workspace 时须使用宿主入口的绝对路径，并保持该 `DSH_HOME`；可选 `--patch <overlay>` 必须在 `--no-open`、`--json` 等应用参数之前，不能代替 bundle 安装。部署期在用户 `$DSH_HOME/profiles/shud/cordis.patch.yml` 覆写 `shud-raw-guard.config.rawDirs`，覆盖 workspace 外的真实 raw 目录；默认 `data/raw` 仅供开发/探针。证据取自 session log（`approval/asked|decided`、`job/settled`、`tool/result`），不取自终端回忆。SHUD 运行一律在 scratch workspace 复制 `input/ccw` 后进行，submodule 永不改动。

## Conventions

- 命名：文件 kebab-case（`policy-gate-core.ts`），类型 PascalCase，常量 UPPER_SNAKE；schema 字段 snake_case（`Minimal_Schemas.md`）。
- 债标记：`TODO(#issue)` 必须带 issue 号；无号 TODO 在 review 中打回。
- 偏离带理由：任何对 `constraints.yaml`/baseline 的放宽都是独立决策并写进 `docs/adr/proposed/`，不得夹带在功能 PR。
- 提交：`type(scope): subject`，types feat/fix/docs/build/chore/ci/refactor/test；`Co-Authored-By` 行保留。
- PR：模板 `.github/pull_request_template.md`；描述末尾 `🤖 Generated with Claude Code` 行保留。
- 分支：`main` 受保护，功能分支 `type/short-slug`，merge 走 PR。
- 覆盖率：80% block；新代码不得靶向性排除；`index.ts` 与测试文件排除。

## Code Review Self-Check

提交 PR 前逐项自查，并把证据贴进 PR：

- [ ] `pnpm run check` 本机绿；触及 seam/运行时还跑了 `profile:smoke` 或 `shud:tiny`
- [ ] 测试先于实现（TDD）；每个新谓词/不变量有正反例
- [ ] 没新增 `_v2`、注释代码、无号 TODO、未用导出
- [ ] 触及 `## Critical Paths` 时：reviewer 子代理白盒审查记录 + 测试证据在 PR 内
- [ ] Zod 改动已 `schema:generate`；指令源改动已 `instructions:render`
- [ ] 文档随代码改（命令/路径/行为）；非平凡变更有决策记录
- [ ] 报告措辞：无"模型机制已验证"、无"普遍改进"、calibration 标注为 calibration
- [ ] 无密钥、无 `data/raw` 写入、无 dsh 源码改动

## Architecture Discipline

- **TDD**：红 → 绿 → 重构；行为先由失败测试定义，覆盖率 80% block。
- **Seam-only**：能力经 dsh 文档化 seam 注入，缺 seam 是"报告偏差"不是 fork。
- **Model-visible ⟺ logged**：模型看到的每个工具结果/审批/作业事件都进 session log；未记录的东西不是证据。
- **Capability seams + registrations as effects**：插件注册是显式副作用，启动时可枚举（`--dump-config`）。
- **显式默认、无硬编码可调项**：阈值/路径/模型 id 来自 `constraints.yaml`、`profile/shud/cordis.patch.yml`、schema 常量；配置缺失即 fail-loud，不静默回退。
- **Runtime invariant companions**：每条 `CONTEXT.md` 不变量在代码里有对应断言或测试；M2 起作业持久化不变量进入矩阵。
- **Branded ids**：TaskCard/RunJob/RunRecord 等 id 用品牌类型，不用裸 string。
- **Waterfall delegation**：`tools/pre-execute` 决策按 allow→deny→cancel→ask 瀑布，第一条命中即终止，fail-closed。
- **Closure 判据代码化**：TaskCard 不能仅因 LLM 认为完成而关闭（`docs/02_ARCHITECTURE/Agent_Architecture.md` §7）。

## Critical Paths

以下七类改动必须白盒审查（reviewer 子代理逐行 + 测试证据），人工只做功能审查与测试验收，不审代码：

1. 策略门决策（`packages/dsh-shud-core/src/governance/`：allow/deny/ask 表、保留规则 id）
2. 原始数据保护（`data/raw` 只读、sandbox 边界、symlink 解析）
3. 审批 seam（`ctx.approval` 结果处理、fail-closed）
4. 作业持久化 / park-resume（`ctx.jobs` 后端、SIGTERM/SIGKILL 对账）
5. 密钥处理（`DMXAPI_KEY` 流向、RunRecord/报告/日志脱敏）
6. 报告语言护栏与水印（EvidenceReport 措辞常量、7 态水印）
7. Schema 与生成投影（`packages/dsh-shud-core/src/schemas/`、`docs/generated/`）

## Observability

- 结构化日志 = dsh session log（`session.v4.jsonl.zstd`）；插件事件走 dsh 事件而非 `console.log`。
- 禁止记录：`DMXAPI_KEY`、任何 `sk-` 形态 token、`data/raw` 内容。`profile:smoke` 断言 dump-config 无密钥。
- 非 shud 作业状态以宿主 `job/settled` 为准；M2 shud 无 owner 作业不产生该事件，以运行目录 `run-job.json`、`run-record.json` 或 `collect-error.json`、索引与 session log 中的 `shud-jobs` 唤醒消息为证。RunRecord 记录退出码及类别与 artifact 路径，不以终端回忆或模型文本代替。
- 无 tracing/metrics（单机单用户，不装空壳）。

## Agent Operating Rules

**可以**：读全仓库与 submodule；在 worktree 内改 `packages/ scripts/ profile/ docs/ openspec/ instructions/`；运行矩阵内任何命令；派 `implementer`/`reviewer`/`verifier`/`explorer` 子代理；开 issue（`issue-scribe`）。

**越界（no-bypass hook 阻断）**：跳过钩子的 no-verify 标志 · force-push `main` · 改 `../deepseek-harness` · 写/删 `data/raw` · 启用 `session-log-deepseek` · 密钥写进文件/日志/RunRecord · 删 `archive/zero-v0.8.3` tag · 手编 `AGENTS.md`/`CLAUDE.md`/`docs/generated/`/`docs/adr/archived/`。

**不得**：下科学结论（单流域提升 ≠ 模型改进；calibration ≠ 结构验证）· 自行批准 PI gate · 改物理方程/默认参数/benchmark baseline 而不经 `ask` · 放宽任何闸以让自己的改动通过 · dsh 升级绕开 `chore(dsh-upgrade)` issue。

**升级**：阻塞于需 PI 判断的问题时，写明问题与证据后停下；PI 功能验收时点按 Development Workflow（Epic #210 为整 Epic 验收，合并子 PR 不等于验收通过）。决策记录四区见 `docs/adr/README.md`。

## Enforcement Index

| 规则 | 位置 | 校验 | 级别 |
|---|---|---|---|
| 禁止并行版本后缀 | `.git-hooks/check-naming.sh`，`constraints.yaml` naming | pre-commit；CI `pnpm run naming:check` | block |
| 文件 ≤1000 行（3 文件冻结基线，M2/M3 棘轮） | `eslint.config.mjs`，`constraints.yaml` baseline | pre-commit lint-staged；CI `pnpm run lint` | block |
| type-aware lint，禁 import dsh 内部路径 | `eslint.config.mjs`，`tsconfig.eslint.json` | pre-commit；CI `pnpm run lint` | block |
| 格式 | `.prettierrc.json`，`.editorconfig` | pre-commit；CI `pnpm run format:check` | block |
| 类型 | `tsconfig.base.json` | CI `pnpm run typecheck` | block |
| 测试 + 覆盖率 ≥80% | `vitest.config.ts` | CI `pnpm run test:coverage` | block |
| 重复 ≤3% | `.jscpd.json` | CI `pnpm run dup` | block |
| 死代码/未用依赖（duplicates 为 warn，M3 转 error） | `knip.json` | CI `pnpm run deadcode` | block |
| Schema 生成物无漂移 | `scripts/schema/check.sh` | CI `pnpm run schema:check` | block |
| 文档链接 + 路径声明 + 生成指令 + 决策记录 | `scripts/docs/`，`scripts/instructions/render.sh`，`scripts/adr/verify.sh` | CI `pnpm run docs:check` | block |
| 密钥 | gitleaks | pre-commit；CI `pnpm run security:secrets` | block |
| SAST | semgrep | CI `pnpm run security:sast` | block |
| PR ≤400 行（label `size-exempt` 记录） | `scripts/guardrails/pr-size.sh` | CI `pnpm run pr:size` | block |
| Conventional commits | `commitlint.config.mjs` | commit-msg | block |
| 锁文件干净、不拉 dsh | `pnpm-workspace.yaml` | CI lint/test jobs install with frozen lockfile | block |
| 单一必需检查 | `.github/workflows/ci.yml` all-checks-passed | GitHub rulesets（branch protection） | block |
| 越界动作（no-verify、force-push、dsh/raw 写、生成物手编） | `scripts/guardrails/no-bypass.sh`（`.claude/settings.json` 与 `.codex/hooks.json` 共用） | pre-commit 等价：agent PreToolUse hook | block |
| 本次触碰 >1000 行文件 | `.claude/hooks/large-file-guard/large-file-guard.sh` | pre-commit 等价：agent hook on git commit | block |
| 闸自证 | `scripts/guardrails/test-guardrails.sh` | 本机 `pnpm run test-guardrails` | block |
| dsh profile 路由 / 出站关闭 | `scripts/runtime/profile-smoke.sh` | 本机 + CI `pnpm run profile:smoke` | block |
| raw-guard 五探针 / raw 字节不变 | `scripts/runtime/raw-guard-probes.sh` | 本机 `pnpm run raw-guard:probes`（需 `DMXAPI_KEY`；exit 2 = 模型偏离须重跑） | block |
| ccw tiny 闭环 | `scripts/runtime/shud-tiny.sh` | 本机 `pnpm run shud:tiny` | block |
| 物理方程/默认参数/baseline 改动需 PI | policy gate `ask` | 运行时审批卡 + 决策表测试 `pnpm run test` | gate |
| PI 功能验收（Epic #210 在 Epic 收口，其余在 merge 前） | GitHub PR / Epic | GitHub rulesets（PR required）+ PI 验收记录；工程门禁不变 | gate |
| 不 import dsh loop 内部（seam 白名单，M1 起） | `eslint.config.mjs` | `pnpm run lint`（`no-restricted-imports` 白名单） | block |
| docs 随代码改 | PR 模板 | review-only | review-only |
| 科学措辞规则（M3 转测试常量） | 报告生成 | review-only until M3 | review-only |
| 运行时不变量伴生（M2 起入矩阵） | reviewer 清单 | review-only until M2 | review-only |
| dsh 升级只走 issue | 流程 | review-only | review-only |

## Agent Roles

Canonical 角色枚举 (唯一权威源: `docs/02_ARCHITECTURE/Roles_and_Boundaries.md` §0):
`coordinator | repo_explorer | worker | coder | reviewer`

| 角色 | 职责 | 科学决策权 |
|------|------|-----------|
| PI/研究者 | 在 Web 界面提问、审批、判断证据 | ✅ |
| Coordinator | 建 TaskCard、执行计划、监控消耗、生成报告 | ❌ |
| Repo Explorer | 只读探索仓库、定位入口/调用链/影响面 | ❌ |
| Worker | 跑模型、解析日志、写脚本、生成图表 | ❌ |
| Coder | 在 worktree 改代码、生成 patch/ChangeRequest | ❌ |
| Reviewer | 检查工程完整性和兼容性 (不判断科学结论) | ❌ |

## Governance Rules

- 改物理方程 / 默认参数 / benchmark baseline → PI 审批（`tools/pre-execute` 返回 `ask`，dsh Web 审批卡片）
- 改输出格式 (breaking) → PI 审批
- 删除原始数据 → 禁止或 PI 审批；`data/raw` 必须位于 workspace root 之外（Seatbelt 只读）
- 单流域指标提升 ≠ 模型改进 → Agent 不允许这样表述
- 校准结果 ≠ 结构验证 → Agent 必须标注为 calibration
- 设计决策 K1–K13 与三仓库事实：[ADR-0004](docs/adr/implemented/0004-dsh-kernel.md)、`docs/01_CODEBASE/SHUD_IO_Facts.md`、`docs/01_CODEBASE/rSHUD_AutoSHUD_Quirks.md`；迁移账 `docs/Migration_Plan_dsh.md`；Zero 时代历史在 tag `archive/zero-v0.8.3`。

## 已装能力

**Packs**：`agentic-issue-delivery`、`codebase-stewardship`

**Skills**（Codex 投影在 `.agents/skills/`，Claude 投影在本机 .claude/skills，gitignored）：

- 核心工作流：`subagent-workflow`（issue 实现全流程）· `stage-change-pipeline`（设计到 issue 全流水线）· `risk-adaptive-cross-review`（审核语义源）
- 执行编排：由 native 子代理（`implementer`/`reviewer`/`verifier`）执行，编排见 `subagent-workflow`
- 设计与澄清：`clarify` · `grill-me` · `grill-with-docs` · `brainstorming` · `future-aware-architecture` · `implementation-planning` · `blind-spot-pass`（开工前陌生区域盲区侦察，从 git 历史/相似实现/隐形约定挖 unknown unknowns）
- 代码质量：`review` · `entropy-review` · `repo-entropy-audit` · `improve-codebase-architecture` · `control-plane-auditor`
- 工具：`gh-create-issue` · `git-worktree-workflows` · `project-documentation` · `eng-init`（本控制面的生成器，incremental 模式更新）

**Agents**（Codex 投影在 `.codex/agents/`，Claude 投影在本机 .claude/agents，gitignored）：`implementer` · `reviewer` · `verifier` · `explorer` · `monitor`（CI 等 harness 外长等待交它看护，主线不空转）· `issue-scribe`（主线发现 follow-up 事项时调用：只读取证→按关键词和证据路径查重→落一条结构化 issue，绝不顺手修）

**Hooks**（脚本在 `.claude/hooks/` 与 `.codex/hooks/`，条目在 `.claude/settings.json` 与 `.codex/hooks.json`，均已跟踪）：

- `worktree-guard` — 并行 worktree 写围栏；仅当项目根存在 worktree-guard 配置文件（.worktree-guard.json，按需创建）时激活，由 `subagent-workflow` 进出并行委派时自动写入/清除。
- `large-file-guard` — `git commit` 前拦截本次触碰的 >1000 行文本文件（增量棘轮，存量不追溯）；`.large-file-guard.json` 可调阈值/排除/停用。
- `no-bypass` — 越界动作阻断（见 `## Agent Operating Rules`）；单一脚本 `scripts/guardrails/no-bypass.sh`，两运行时的 hook 条目都指向它；规则清单在 `constraints.yaml` no_bypass。

## 项目本地适配（living 文件，按需创建）

- `openspec/project-profile.md` — workflow 适配（入口/契约/风险轴）；`subagent-workflow` 首次运行可自动 bootstrap。
- `openspec/glossary.md` — 领域 ubiquitous language 单一来源（已创建：中英术语映射，grep 前先查两态关键词）；由 `grill-with-docs` / `improve-codebase-architecture` 维护。
- `docs/adr/` — 决策记录四区（`proposed/ implemented/ rejected/ archived/`），新记录写入 `docs/adr/proposed/`（命名 `NNNN-slug.md`）；规则见 `docs/adr/README.md`，`pnpm run adr:check` 校验。
- `.large-file-guard.json` — 大文件闸配置（阈值/排除/开关），仅在默认 1000 行不合适时创建。

## 反熵约定

根指令保持精简。包/能力的操作细节下沉到各自 `SKILL.md` / pack README / CHANGELOG，不在本文件展开；子树需细化时就近新增 scoped 指令文件。

## Observable Completion

完工附一行 `Execution Summary: agents=...; skills=...; tools=...; verification=...; limits=...`；保持事实、不展开隐藏推理。
