---
status: living
supersedes: Zero 时代 monorepo 布局（tag archive/zero-v0.8.3）
---

# 仓库结构 v2（dsh profile + 插件）

决策依据 [ADR-0004](../adr/implemented/0004-dsh-kernel.md) K2/K10。SHUD-Harness 不再是独立应用，而是一个 dsh profile 及其插件包。

## 1. 代码仓库

```text
SHUD-Harness/
  package.json                      # pnpm workspace 根；scripts: typecheck / test / build / profile:smoke
  pnpm-workspace.yaml               # packages/*
  tsconfig.base.json
  tsconfig.scripts.json             # 根 scripts/**/*.ts 的独立 noEmit 类型程序（排除测试/夹具）
  packages/
    dsh-shud-core/                  # 领域层（运行时无关）
      src/schemas/                  # 8 对象 Zod schema（移植）
      src/governance/               # 治理常量、policy-gate-core 纯函数（移植）、措辞规则
      src/index.ts
    dsh-shud-raw-guard/             # tools/pre-execute 策略门插件（spike 1.2 TS 化）
    dsh-shud-jobs/                  # durable JobRegistry backend（ctx.jobs 契约）
    dsh-shud-tools/                 # 已挂载 shud_run/shud_collect/task_create/change_create/change_submit/shud_build/report_generate/report_validate/report_submit/report_decide
    dsh-shud-records/               # 已实现四对象文件层、StackLock/provenance 采集、报告渲染/校验/状态机；非 Cordis 插件
      templates/                   # 已用于报告渲染的 Markdown 模板，仅此一个落点
    dsh-shud-policy-gate/           # 已挂载全局 tools/pre-execute，角色 deny + 报告 ask + 变更完整性/级别决策
    dsh-shud-presets/               # 已接入 coordinator/worker prompt + 全局 shud-role-restrict
  profile/
    shud/
      package.json                  # dsh bundle 声明（dsh.bundle.patch）
      cordis.patch.yml              # 模型路由、session-log-deepseek 关闭、以 workspace 包说明符挂载插件（bundle 声明 workspace:* 依赖）
      overlays/                     # 可选 --patch 覆盖（本机 / CI）
  skills/                           # SHUD 专用 SKILL.md（run-shud-tiny-case 等，经 dsh skill-filesystem 加载）
  scripts/                          # 确定性脚本（TypeScript/R/bash），非 LLM
  docs/                             # ADR + 计划 + 精简 spec（处置表执行后）
  openspec/                         # glossary + changes
  SHUD/ rSHUD/ AutoSHUD/            # 只读参考 submodule（保留）
```

每个 `dsh-shud-*` 包：`src/` TS strict，`tsc` 到 `lib/`，`vitest` 测试。jobs/tools 按实际宿主 seam 声明 `peerDependencies`，tools 补齐其运行时 peer 闭包；以相同钉版 `devDependencies` 支持本仓构建/测试（dsh seam `0.2.1-rc.2`、Cordis `4.0.5`）。profile bundle 的宿主 peer 为 `@deepseek-ai/dsh@0.2.1-rc.2`，不为插件另装宿主。Host 侧插件入口 `export const name` + `export function apply(ctx, config)`。不发 npm；profile bundle 声明 jobs/raw-guard/tools 的 `workspace:*` 依赖，以 `insert` 插入各自包说明符；`shud-tools` 注入现有 `tools` 与 SHUD `jobs` 服务，不兼容普通 `jobs-local` 替代。

默认 `pnpm run typecheck` 先构建并检查各包，再显式执行根 `typecheck:scripts`（`tsc -p tsconfig.scripts.json`）；`pnpm run check` 与 CI 复用同一命令。脚本程序继承不变的 strict 基线、使用根直接声明且与包同版的 `@types/node`，只检查生产 `scripts/**/*.ts`，不产出 JS/声明文件；测试、test-harness 与 fixture 入口排除。包内测试、根 `vitest.config.ts` 和 `.mjs` 配置不因此新增到编译器门禁，type-aware lint 也不替代该门禁。

records 包构建在 `tsc` 前执行 `scripts/records/generate-version.ts`，每次从规范根 `package.json` 生成仅含版本的 `packages/dsh-shud-records/lib/harness-version.json`，缺少 `lib/` 时自动创建。采集运行时只读取此包内产物；提供 core 依赖后，复制到仓库外的 records 包不依赖仓库祖先清单或调用方 cwd 的版本。产物不入库；直接运行 emitted-package 边界测试前须先执行 `pnpm run build`，测试本身不重建共享 `lib/`。

默认 `rawDirs: ["data/raw"]` 仅用于开发与探针；部署期真实 `<data_root>/raw` 必须在 workspace root 之外，由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 中以 `- id: shud-raw-guard` + `config: { rawDirs: ["<workspace 外的绝对路径>", ...] }` 覆写。`profile:install` 要求 `SHUD_BIN` 为绝对路径、可执行普通文件，仅新增/更新安装器拥有的唯一 `shud-jobs` 项（`shudBin` 与 `stateDir: $DSH_HOME/profiles/<name>/shud-jobs`），其余用户 patch 字节不变；已有 raw-only patch 升级后再次安装保持整文件 hash 不变。覆写结果可用 `--profile shud --dump-config` 查看。`shud-jobs` 已实现 stateDir 排他所有权及原子串行索引；永久 `.lock-guard`、可移除 `lock` 与平台工具前提见 [Runtime Lifecycle](../../instructions/agents/shared.md#runtime-lifecycle)。

注册表现提供 `submitShud(request, producer)`，完成输入复制、提交记录/索引持久化、瞬时无 owner 登记与真实包装进程启动，原子写入 pid/启动时间后返回 `running` RunJob。必需的 `producer(prepared, handle, pumpPollMs)` 返回 `ShudExecution`；已导出的 `startDetachedShud(prepared, hooks, pumpPollMs)` 要求显式 `ShudLifecycle`（JobHooks、正常终态的同步/异步 `settle` 与必需同步 `detach(detail)`，共用实际 producer done），并沿用注册表消费的、由 Cordis 按父类 schema 已解析的轮询间隔。本地提交与接管共用最小受控组/完成能力，但原生 child 启动、回收及回滚 abort 仍只属于实际本地执行，不为接管伪造。detached 包装进程原子发布 `wrapper.pid`/`exit_code`；唯一调度器与公开 `pollOnce()` 共享逐条目排他状态，正常结算先原子持久化终态再完成登记，完成回调失败可重试而不改写终态。同步公开 kill 作用于本实例实际关联的提交或 R3/R5 接管登记，先持久化取消意图并在父类调用前保留本地期限镜像，再向受控进程组 SIGTERM；既有 cadence 在 core 10 秒期限到达后按需 SIGKILL，组静止后按退出证据 first-wins 结算，不因 leader 单独退出提前完成 durable 结果，本地执行还须完成真实子进程回收。取消、结算及 collect 状态投影共用新鲜 RunJob 的非让出式原子发布，避免旧快照覆盖取消标记。后续 tick 自动收集，后端 `collectShud(RunId | JobRecordId)` 共用同一条目队列与收集实现：原子发布不可变 RunRecord 后投影 `collected`，生成失败持久化重试记录，自动间隔 10 秒、最多 3 次，直接调用可重试。组合生命周期先停止轮询/收集/kill/提交准入，等待已接受及排队工作（含启动对账与接管登记清理）结束再释放索引锁；父类并发释放期间仍保留必要的托管登记分类。本地提交回滚先证明执行组静止并回收本地子进程，再清理登记与自有文件。未标记的托管 cancel 则同步 detach 为 failed：无意图不发信号，有意图先重发受控 TERM，检查/信号错误经受控日志报告而仍完成登记；不读写 durable 状态、不等待进程或发 KILL。接管登记沿用此 teardown 语义，无 owner 的登记也不因发起 Agent 释放而取消。唤醒及工具入口已接入，分别见下文初始化后投递与已挂载工具说明；详细顺序、资源契约及 Darwin R7/Linux R8 验证边界见 Runtime Lifecycle 与下文 Park/Resume 链接，不以独立 `shud:tiny` 的执行成功代替注册表运行证据，也不宣称完整宿主/Web 恢复或 PI 验收。

R1–R12 启动对账已接入 `[Service.init]`：先排空启动 pass 再开放 SHUD submit/poll/collect 并启动正常 cadence，恢复取消可能等待原始宽限的剩余时间，原有启动锁与 drain 边界不变。#310 原始切片只做文件级对账；#312 现为 R3/R5 建立真实无 owner 接管登记，复用原 label/stdout、不重新 spawn，先清空旧 current id，再不让出地发布新 id/追加历史和完成回执，每个实例只登记一次。发布前 registered 事件中的重入 kill 拒绝，不写意图或发信号；发布后沿用托管 kill。登记/新 id 发布失败保留已清空的 null id 与旧历史，受控报告并排空/移除父类登记后释放关联，不 abort 物理执行、不删除运行文件/索引，后续文件级 poll/collect 不重试登记；存储不能清空旧 id 时仍明确失败。R8 保持无接管登记的恢复取消。R9 优先修复已提交 RunRecord 的状态，pending notify 不变，R12 仅修复已验证通知终态的完成索引。#313 已在初始化后的正常 cadence 投递：成功 `sessions.flush` 后才发布 `delivered`，已校验的通知终态（`delivered` 或 `unreachable`）随后先写 completed 再移出 active；崩溃窗口允许重放，不保证 exactly-once。钉版宿主的 Web worker 子会话仍受 `session/agent-busy` 恢复边界限制，不能据此声称所有会话均可唤醒。Linux R3 以原生 proc/getconf 证据判新鲜度，lstart 身份不变，不确定证据 fail closed。完整恢复、投递顺序、worker 子会话边界及 #343/#344 已知限制集中在 [Park/Resume §9](../03_SPEC/Park_Resume_Design.md#9-服务重启恢复)。

### 文件权限与 PI 审批

SHUD bundle 在现有 `approval` 行设置全局 `policy: ask`，并在 `permission` 行保留完整三项 catalog。文件访问范围不代表 PI 的报告或高风险变更审批权：

| 权限预设 | sandbox 模式 | 需要审批的操作 |
| --- | --- | --- |
| `read-only` | `read-only` | `ask` |
| `workspace-write` | `workspace-write` | `ask` |
| `danger-full-access` | `danger-full-access` | `ask` |

即使启动环境设置 `DSH_PERMISSION_MODE=danger-full-access`，SHUD 的默认 approval 仍为 ask；不把 full access 降为 workspace-write，也不自动批准。`report_submit` / `report_decide` 与策略判为 ask 的 `change_submit` 仍须经过 policy-gate 和宿主 answerer，只有本次 `allowed-once` 才能执行；拒绝、取消及无 answerer 均 fail closed。匹配 patch 的 `pure_engineering` / `io_format` 变更无需审批卡，详见下文 `change_submit`。headless 不因这个配置获得自动 PI 权限。raw 不可变/provenance 审批、角色工具面和报告/TaskCard 写入顺序不变。

**旧会话需要显式重选。** 安装更新、重启宿主不会改写已有会话的 durable `approval/policy: never` 事件；旧 full-access 会话可显示为 `custom`。保留原会话/报告/任务历史，在更新后的 SHUD Web 权限选择器中明确重选所需预设（包括 full access），由宿主公开权限机制追加 ask；重复选择相同有效预设不追加事件。不要手改日志或报告来“恢复审批”。已有用户 patch 仍由用户拥有；若它显式覆写 approval 或 permission 为 never，bundle 不偷偷覆盖，需检查有效配置并由操作者决定调整。

钉版宿主的 never 会在 `approval/request` 之前自动拒绝，通用错误仍可能写成 “the user rejected”。这不是 PI 点了拒绝；`approval/asked`（甚至随后出现 `approval/decided: rejected`）也不能单独证明卡片已展示或 PI 已操作。工程验证必须证明真实 answerer 往返；自动测试/探针不替代 PI 对原验收流程的显式操作，不据此关闭 M3 验收。

### 已挂载的 `shud_run`

构建后沿用同一导出的 `DSH_HOME` 与有效 `SHUD_BIN` 执行 `pnpm run profile:install`；`pnpm run profile:smoke` 检查 Web/headless profile 中的 `shud-tools` 组合与可导入性。运行前在 scratch 工作区复制输入，不改只读 SHUD submodule。模型工具调用示例（不是 shell 命令）：

```json
{"input_dir":"input/ccw","end_days":30,"label":"ccw END=30"}
```

当前 M3 接受 `input_dir`、可选 `project`、`end_days`、`label` 与品牌 `task_id`；未知参数（包括 `workdir`）拒绝。有效工作目录只取调用会话 cwd，输入路径原样交给注册表按物理路径处理；project 默认取所给路径末级目录名（忽略末尾分隔符），别名异名或 `.`/`..` 路径应显式给 project。`end_days` 是副本中正整数 END 日的绝对覆写，不是运行时长；label 必须为一行。输入复制与 cfg、内部链接/特殊文件、目录重叠检查仍由注册表负责。raw 输入先走 provenance 读审批，raw 输出目标拒绝；工具本身不新增 PI 审批门。

**M4 扩参契约（待 #534/#539 交付）**：新增可选品牌 `build_id` 与正整数 `threads`；零、负数、小数、字符串或非法品牌在文件系统操作前拒绝。未知参数的负例保留 workdir，不再以合法整数 threads 作未知键。注册表解析本工作区 `builds/<build_id>/build-record.json`，校验普通可执行二进制及 SHA256，复制到 `runs/<run_id>/bin/shud` 并执行副本；RunJob/RunRecord 原样记录 build_id、threads、binary_sha256，StackLock 记录构建来源。threads 提供时设置 OMP_NUM_THREADS/SHUD_RHS_THREADS，缺省不新增环境变量；无 build 沿用配置 shudBin。M4 对所有提交新增 tsd.forc 解析与外部 forcing 只读哈希，缺失或解析失败拒绝，不把无 build 路径称为完全无行为变化。详见 [shud_run arguments](../../openspec/changes/m4-mvp-2/specs/shud-run-tools/spec.md#requirement-shud_run-arguments)。

回放传 `input_dir: input/keliya`、task_id、build_id、`threads: 1`，不传 end_days，保留准备后的 START/END；N=1 是 VerificationCase 的准入条件，不把工具正整数 schema 收窄为只接受 1（D15(3)，M4 范围裁剪、非放宽 baseline）。

工具要求会话 id/cwd 与已配置模型：先取 `agent.session.requestHeader()?.config.model`，缺失再取 `agent.options.model`；恒记 `response_model_source: configured`，不把 assistant `source.model` 当响应体模型。它通过导出的 `produceDetachedShud` 提交实际执行，沿用 jobs 内与接管共用的登记完成工厂；`submitShud(request, producer)` 的显式 producer 参数仍必需。

提交完成即返回 `status: running`、持久 `job_id`/`run_id`、当前 `dsh_job_id` 与 `run_dir`，不等求解器结束。`job_output`/`job_kill` 只使用当前 `dsh_job_id`；重启接管后用 `job_list` 中含 `run_id` 的 label 或 `shud_collect` 的非终态错误找新 id。headless 未提供会话恢复服务时，通知可保持 `pending`、`attempts: 0`、`Waiting for session services`，不妨碍文件级结算或经 `shud_collect` 读取记录；这不等于完整 Web 跨重启或 PI 验收。

### 已挂载的 `shud_collect`

同一 `shud-tools` 插件已挂载收集工具；无需新增 profile 行。模型调用只传持久 id 之一，例如 `{"run_id":"RUN-20261024T200036-a20d"}`，或传该运行实际返回的 `job_id`。两者必须且只能提供一个，按 core 品牌 id 校验；未知键、错误类型/品牌和非对象参数均拒绝。`dsh_job_id` 不是收集参数。

工具只委托一次注册表 `collectShud()`：先查活动索引再查完成索引，不扫描工作区，不从调用会话 cwd 推断运行目录。终态尚无记录时执行现有收集；成功直接返回完整规范 RunRecord JSON，不添加科学结论。已提交记录重复读取时字节与 mtime 不变，包括通知完成、移出活动索引后由另一会话/工作区通过任一持久 id 读取。磁盘上有记录但未被索引的 id 仍返回 `UNKNOWN_ID`。

`created`/`submitted`/`running` 返回 `NOT_TERMINAL`，提交仍在途返回 `SUBMISSION_IN_FLIGHT`；受控错误包含当前状态和经校验的当前 `dsh_job_id`（未登记为 `null`，不是历史 id）。此类请求不生成结果或重试记录，提交在途请求也不会在排队期间转为收集。普通收集失败返回写入 `collect-error.json` 的受控原因；记账发布也失败时，错误同时保留原生成原因与受控发布错误，不泄露任意异常或元数据。

2026-10-24 实测边界：built ToolRuntime 的真实 ccw30 运行先拒绝运行中收集，退出 0 后经会话控制服务 seam 完成一次唤醒并移至完成索引，另一会话/cwd 通过两种 id 重复取得不可变记录。已安装 headless profile 的实际模型在两个新会话/不同 cwd 分别用两种 id 调用，canonical request/header/tool/call/tool/result 与落盘记录一致；该路径使用活动索引，通知仍为 pending/0、等待会话服务。两次运行各 45 个源/副本输入 hash 不变；不据此宣称 Web/PI 验收（#316–318）。

### 已挂载的 `task_create` / `change_create`

同一 `shud-tools` 插件已支持代码变更建卡与提案发布；无需新增 profile 行。以下是模型工具参数示例，不是 shell 命令。先调用 `task_create`：

```json
{"type":"code_change","title":"调整已跟踪源码","question_or_goal":"生成绑定当前源码基线的变更证据"}
```

`type` 只接受 `science_assist` / `code_change`，`title` 与 `question_or_goal` 必须非空；未知参数拒绝。工作区只取调用会话 cwd，源检出固定为 `repos/SHUD`，不接受路径参数、不代建或修改源仓库。`code_change` 在创建任务目录前验证真实目录、物理 Git 根与完整 40 位小写十六进制 HEAD，将其钉定为 `source_base_commit`；成功返回 `task_id` 与 `status: planned`，卡片初始链接为空。`science_assist` 保持空 pin，完全不访问 `repos/`。

修改该独立检出内的已跟踪文件后调用 `change_create`；下例 `task_id` 须替换为实际建卡返回值：

```json
{"task_id":"TASK-20261103T080005-a001","semantic_level":"pure_engineering","description":"记录已跟踪源码的改动"}
```

`task_id` 必填；`semantic_level` 为可选七档声明，`description` 为可选一行文本，未知参数拒绝。工具只接受 `planned` / `running` 的 `code_change` 卡；先只读校验卡片，再经 core 受控 Git runner 核对 HEAD 与 pin，一致后才观测 status/diff。空观测、新增、删除、重命名及其它不支持的状态拒绝，不发布变更对象。源文件、index 与 HEAD 不被工具改写。

工具复用 records 根入口的 `observeSourceChanges`、`deriveChangeRequest`、`ensureDirectory`、`createChangeRequest`、`writeChangePatch` 及卡片读写/状态机：观测后只派生一次 floor、categories、risk 与精确 patch 摘要，再预检 changes、patches、tasks 父目录及确切任务目录。低于 floor 的声明自动抬升并在结果说明；缺省取 floor，高于 floor 的声明保留。预检失败不公开或占有内存候选 id，也不写 CR、patch 或卡片。

发布顺序为排他 CR JSON → 精确 patch → 新鲜 TaskCard，发布段不让出执行；CR 始终为 `proposed`、审批字段为空。碰撞后以 records 返回的实际 `change_id` 驱动 patch 路径、结果与卡片链接。新鲜卡仍须符合类型、状态与原 pin；保留其它字段及全部既有链接，`linked_changes` 合并排序去重，`planned` 进入 `running/running_local`，已 `running` 的 phase 保持。CR 提交后的失败保留已提交证据，受控错误携带实际 id（含 publisher 已提交但清理失败的 id）；不回滚，也不伪造成功链接。

raw-guard 在执行前只按元数据检查 changes、patches、确切 task.json（非法/缺失 id 回退 tasks）及 `repos/SHUD`：目标落入 raw 即拒绝，不读取卡片内容；`task_create` 仍只检查 tasks。两工具不调用 LLM、不发起审批、不自行批准变更，也不承诺外部 Git 并发写入者之间的快照隔离。

工具注册不等于完整 M4 角色链路已交付：当前 profile 仍挂载 coordinator/worker，coder/reviewer 的角色工具映射不代表其 presets 已挂载；`change_submit` 与 `shud_build` 已挂载（见下文），M4 coder/reviewer presets 仍未交付。详细契约见 [change_create](../../openspec/changes/m4-mvp-2/specs/change-requests/spec.md#requirement-change_create)。

### 已挂载的 `change_submit`

同一 `shud-tools` 插件已提供变更批准入口，无需新增 profile 行。唯一参数为经 core 品牌校验的 `change_id`；未知参数拒绝。下例是模型工具参数，不是 shell 命令，id 须替换为实际 `change_create` 返回值：

```json
{"change_id":"CHG-20261103T080100-b002"}
```

- **策略固定顺序**：先执行既有 core deny（当前角色取 committed preset 投影，非创建 header）；只有未被拒绝的调用继续。随后用规范 readonly reader 读取 CR；id 缺失/非法、参数根类型不符、CR 缺失/损坏/身份不符/不安全或无会话 cwd 时 ask，且不读 patch。CR 可读才只读读取并哈希对应 patch；可读但 SHA-256 不符时，无论级别或 CR 状态均 deny，要求重新 `change_create`；patch 缺失、不可读、链接或特殊文件时均 ask。全部匹配后，`output_semantics`、`numerical_implementation`、`parameter_default`、`physical_equation`、`model_assumption` 五档 ask；`pure_engineering`（low）与 `io_format`（medium）恰好委托一次，不发审批卡。unknown 角色沿用同一证据/级别表，不自动放行高风险。
- **宿主批准与审计**：ask 由宿主处理，仅 `allowed-once` 进入真实工具；`rejected`、`cancelled`、`unavailable` 不执行、不改 CR，不产生 rejected 状态或额外决定对象。审批 `reason` 仅为固定前缀加合法 id 或受控无效标记；`displayReason.en/zh` 展示 id、语义级别/下限、全部 floor categories、risk、完整文件列表、patch 路径及 description，不可得字段明确标记无法读取。展示文本不落 session log，不能充当审计证据。policy ask 日志为 `change-approval` 加合法 id/已校验级别，patch mismatch 日志为 `change-patch-mismatch` 加合法 id；均不记录原始参数、路径、摘要哈希、文件列表、description、patch 内容或原始异常，委托不记决策日志。
- **执行与持久化**：工具只取调用 session cwd，要求非空执行 callId；在宿主放行之后重新读取新鲜 `proposed` CR、其 `running` TaskCard 及精确 patch，并重算 SHA-256。TaskCard 不额外要求 `code_change` 类型或 base 一致性；这些不是本工具新增的批准条件。校验到规范 `rewriteChangeRequest` 发布之间不 await、不排队，只改 `status: approved`、`approval_ref`、`approved_at`、`updated_at` 四字段；返回 `change_id`、`status`、`approval_ref`。`approval_ref` 精确取 `exec.callId`，通过 session log 的 `asked.callId → asked.id → decided.id` 关联，不取审批 request id。
- **失败与重复调用**：CR/卡不合法、patch 缺失/不可读/不匹配均零改写；审批展示后 patch 被改动也由执行时复核拒绝。文件层错误只返回受控阶段，不透传异常载荷。已 approved 的 CR 没有策略捷径：匹配 patch 的高风险重复调用仍 ask，allowed-once 后由工具拒绝非 proposed；非高风险重复调用委托后同样拒绝，保留原批准字段。可读 patch 不匹配仍先于这两种情况 deny。并发获准的同一 CR 调用只会有一次成功批准写入。
- **raw 与不变量边界**：raw-guard 先于 policy/approval，仅按路径元数据保护合法 id 对应的确切 `changes/<id>.json`；id 缺失/非法或参数根不合法时回退 `changes`。复用物理路径/已有祖先识别，覆盖链接别名和尚未创建的目标，不读取 CR、卡或 patch 内容来选目标。合法 id 不扩大为整个 changes，也不额外保护其它 CR、patches、tasks 或源检出。工具本身不改 TaskCard 状态/phase/链接，不改 patch，不读取源检出或引用链；不要求、采集或保存 comment，也不新增 `change_decide`。报告终态的 comment 契约不变。

当前 profile 仍只挂载 coordinator/worker；角色映射与工具注册不等于 coder/reviewer presets 已交付。本次也不扩展 `shud_run` 的 `build_id` 参数面（另属 #539）。真实 ToolRuntime、宿主 ApprovalService 与 canonical 文件读写的自动答复测试，以及 built-plugin smoke，只证明工程审批边界；不声称真实 Web 操作、PI 功能验收或科学有效性。

伴生测试入口：`packages/dsh-shud-policy-gate/src/full-access-approval.test.ts`、`change-approval.test.ts`，`packages/dsh-shud-tools/src/change-submit.test.ts` 与 `packages/dsh-shud-raw-guard/src/decide-change-target.test.ts`。完整契约见 [change_submit](../../openspec/changes/m4-mvp-2/specs/change-requests/spec.md#requirement-change_submit) 与 [高风险变更审批策略](../../openspec/changes/m4-mvp-2/specs/policy-gate/spec.md#requirement-change_submit-asks-for-high-risk-change-requests)。

### 已挂载的 `shud_build`

同一 `shud-tools` 插件提供同步构建工具，无需新增 profile 行。以下是模型工具参数，不是 shell 命令；id 须替换为实际记录的返回值。base 构建：

```json
{"task_id":"TASK-20261103T080005-a001"}
```

候选构建须已有同任务、同 base 的 approved CR；`shud_build` 不批准 `proposed` CR，也不替代上节 `change_submit` 的策略/宿主审批链路：

```json
{"task_id":"TASK-20261103T080005-a001","change_id":"CHG-20261103T080100-b002","rhs_openmp":true}
```

- **配置与准入**：只接受必填 `task_id`、可选 `change_id` 和布尔 `rhs_openmp`（缺省 `false`），未知键拒绝。工作区取调用 session cwd，源固定为 `repos/SHUD`，卡须为 `planned` / `running` 的 `code_change`。`sundialsRoot` 只取实际挂载的 `shud-jobs` provider 配置；缺失在任何写入前失败，不从工具参数、环境变量或默认目录猜测。源须为真实独立 Git 检出且 HEAD 等于卡的 pin。base 要求工作树观测为空；候选要求 CR 已批准、task/base 一致、观测路径集合精确匹配，且观测 diff 与普通持久 patch 文件的 SHA-256 均等于 CR 摘要。
- **构建输入**：在排他的 `builds/.tmp-<build_id>/src/` 内解包钉定 commit 的 archive，核对条目路径、类型及 blob 身份与 `ls-tree` 一致；不复制工作树，忽略文件和陈旧 `shud` 不进入输入，未跟踪修改在准入时拒绝。候选只应用准入时已校验并保留的 patch 字节；受控 Git ceiling 防止发现外层仓库，并验证每个变更文件实际生效。同步运行 `make -C builds/.tmp-<build_id>/src shud SUNDIALS_DIR=<sundialsRoot>`，OpenMP 为真时追加 `SHUD_ENABLE_OPENMP_RHS=1`；环境只传 `PATH`、`HOME`、`SUNDIALS_DIR`，构建不静默，stdout 保留回显命令。独立的 CXX 探测记录实际编译器 `--version` 首行。
- **结果与失败**：两份主 make 日志在创建时从描述符记录文件身份，主 make 结束后确认路径仍指向原文件，才以有界读取计算内容摘要；主 make 自身的正常 stdout/stderr 写入被保留，之后的编译器探测不得原地覆盖、追加或用同名普通文件替换日志。编译器选择与版本探测全部结束、临时源码及探测文件清理后，工具 producer 要求仅剩普通文件 `shud`、`make.stdout.log`、`make.stderr.log`，复核两份日志的身份及主 make 后摘要，并复核二进制的有效执行权限及其摘要仍等于最初复制后记录的摘要；额外、缺失或错误类型的条目、被替换或篡改的证据均拒绝，不以新摘要承认变更。这是工具 producer 的校验，不是通用 records publisher 的职责；publisher 随后写入 `build-record.json` 并整目录 rename 为 `builds/<build_id>/`，成功目录恰含上述四个文件。公开结果含 `build_id`、nullable `change_id` / `patch_sha256`、`source_commit`、`rhs_openmp`、`binary_sha256` 与 `duration_seconds`。发布前失败不生成成功 BuildRecord；受控错误保留阶段、已观测的退出事实及最多 40 行日志尾部，脱敏环境值和已删除临时路径。诊断日志以 `O_NONBLOCK` 打开并确认普通文件，避免日志被替换为 FIFO 后错误处理挂起。规范 publisher 清理自有临时目录；清理失败或目录所有权不确定时保留证据并报告清理失败，不冒称已全部删除。发布完成后不回滚已提交目录。
- **只读与权限边界**：`shud_build` 不改写 `repos/SHUD` 的文件、Git index/HEAD，也不改变 TaskCard 的状态、phase 或链接。raw-guard 在执行前按物理路径保护固定的 `builds` 与 `repos/SHUD`；policy-gate 允许 coder，拒绝 worker/reviewer/coordinator，不由构建处理器自行审批。工具注册不使当前 profile 自动具备 coder/reviewer presets，也不扩展 `shud_run` 的 `build_id` 参数面（另属 #539）。
- **可信命名空间边界**：临时目录排他分配、等待后的目录身份复核与规范清理保护协作构建；所有权变化时拒绝继续写入或删除外来目录。这不是对任意敌对外部写入者的原子快照或 rename-no-replace 保证。工程集成使用真实 ToolRuntime/Git/tar/make/编译器探测及假 Makefile 生成的脚本可执行文件，不据此宣称真实 SHUD 求解器已编译、真实 Web 链路已验收或 PI 已批准。

伴生测试入口：`packages/dsh-shud-tools/src/shud-build.test.ts`；完整契约见 [shud_build](../../openspec/changes/m4-mvp-2/specs/shud-build/spec.md#requirement-shud_build)。

### 本机 Web 重启验收

在已安装 workspace 依赖、Node 24+ 与 pnpm 的本机，环境中提供非空 `DMXAPI_KEY` 后执行：

```sh
pnpm run shud:restart
```

`SHUD_BIN` 可覆盖默认的仓库 `SHUD/shud`，必须是绝对路径、可执行普通文件；`DSH_ROOT` 沿用安装器的钉版 checkout/npm 宿主解析规则，相对路径按启动命令的 cwd 解析为物理绝对路径后传给 scratch 工作区中的安装器与宿主。完整 `SHUD/input/ccw`、原生 `ps` 启动身份与 cwd 检查、Darwin `/usr/sbin/lsof` 和 `/usr/bin/lockf`，或 Linux procfs 与 `/usr/bin/flock`，均在任何宿主启动（包括 profile 创建）前检查。命令构建当前插件，使用既有 `profile:install` 创建两个独立 Web profile，不使用用户现有 `DSH_HOME`，也不提供跳过构建或离线 PASS 模式。

两个用例依次对已返回规范 `shud_run` 结果、仍运行的宿主发送 SIGTERM 与 SIGKILL，再在同一用例的 home/cwd 中启动新 Web 宿主。每次启动重新认证，认证 URL、token、cookie 只在内存中。只提交一次完整 ccw，不传 `end_days`、不发重启后提示、不用手动 `shud_collect` 补偿；原始与工作区输入文件清单及 SHA-256 前后相同，求解器另持运行目录内的输入副本（允许其正常生成 `.bak` 等文件）。

判据为 RunJob 单调状态、原始包装进程和求解器 PID/出生身份跨重启连续存活、含数值退出码与实际非空产物的规范 RunRecord、原 owner session 中来源 `shud-jobs` 且包含 run_id 的唤醒及 `notify.status: delivered`、准确唯一 completed 项且 active 为空。非零数值退出码可证明运行生命周期，不代表科学结果正确；模型总结不作判据。进程候选按运行 cwd 检查，不仅按原 PGID；这是有限采样，结合 jobs 所有者的单一提交 spawn／对账不重启进程契约，不宣称连续穷尽追踪。

每个用例输出并保留 `$HOME/.shud-restart-SIGTERM-*` 或 `$HOME/.shud-restart-SIGKILL-*`：`home/`（原始 host-owned session log）、`work/runs/<run_id>/`（RunJob、RunRecord、退出码和产物）、`evidence/`（规范 HTTP history 的完整前缀投影、原日志路径、进程与状态样本、输入 hash、清理记录、最终判定）。HTTP export HEAD 仅作 host 读盘/flush 屏障，不替代事件证据；脚本不另实现 zstd 解码器，不改写原始日志。脚本写出的内容先过密钥屏蔽检查。成功与失败均不删除证据，用户确认不再需要后自行移除。

HTTP 请求限时 15 秒，Web 启动 60 秒，首次工具提交 3 分钟，重启后的自动完成 15 分钟；构建/安装限时 10 分钟，单轮关闭及退出后的输出排空等待各限时 15 秒。失败或中断先关闭出生身份验证过的脚本宿主，再仅清理已证明归属的执行组；无法证明归属或完成清理时明确报告 unsafe cleanup、可能仍存活的 PID 与保留路径，仅释放脚本自己的子进程及管道句柄，使命令有界地非零退出，不把释放句柄记作进程已停止，也不向未验证的 PID 发信号。相关进程可能继续运行，需按保留的身份与证据人工核实处理，不按名称或复用 PID 广泛杀进程；正常退出先排空输出再保存证据。仅两个用例的五项断言及清理均成功才输出总 PASS、退出 0；缺前提、超时、证据不完整或无法安全清理均非零。此命令说明不是实际两轮 PASS 记录，也不代替 PI 的 Web 手工验收。

## 2. 运行时资产（不进代码仓）

```text
$DSH_HOME/                          # dsh 家目录（本机 ~/.dsh 或显式指定）
  profiles/shud/                    # 由 profile/shud 初始化的 profile
  sessions/                         # 宿主 session.v4.jsonl.zstd（审计/回放证据）
  storages/                         # dsh 自有 storage-json 后端，不存 SHUD 领域对象
  profiles/shud/shud-jobs/          # 注册表 stateDir：active/completed 索引与排他锁
<workspace>/                        # session cwd = workspace root；可容纳多张 TaskCard
  tasks/<task_id>/task.json         # M3 TaskCard，工具推进状态
  stacks/<stack_id>.json            # M3 StackLock
  provenance/<data_id>.json         # M3 DataProvenance
  reports/<report_id>.json          # M3 规范 EvidenceReport 对象
  reports/<report_id>.md            # 同名 JSON 的确定性 Markdown 投影
  runs/<run_id>/                    # M2 运行记录、输入副本、日志、pid/退出码与 output 产物
  repos/SHUD/                      # 调用方准备的 scratch 独立检出；code_change 建卡钉定 HEAD
  changes/<change_id>.json          # change_create 提案；change_submit 只将批准字段推进为 approved
  patches/<change_id>.patch         # change_create 已发布的精确 patch
  verifications/<vc_id>.json        # M4 目标：VerificationCase
  builds/<build_id>/                # shud_build 整目录发布：build-record.json、shud、make.stdout.log、make.stderr.log
<data_root>/raw/                    # 原始数据，必须在 workspace root 之外（Seatbelt 只读）
```

M4 新目录由 [m4-mvp-2](../../openspec/changes/m4-mvp-2/design.md) 分项实现；本文不预先链接未生成的 schema 或未创建的测试。M4 回放源码 clone 钉定 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，根 submodule 不写；通用 `task_create(code_change)` 钉定的是调用方检出的当前有效 HEAD。九个治理根仅领域工具可写，模型 edit/write/shell 受 raw-guard 限制；启发式边界见 [Workspace 约定](../03_SPEC/Workspace_Conventions.md#9-路径安全)。

## 3. 与 dsh 的边界

- dsh checkout（`../deepseek-harness`，钉 tag）只作只读运行宿主，不改源码、不作为构建宿主；类型来自插件包的 devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2`（工具 seam）与 `@deepseek-ai/cordis@4.0.5`（`Context`），不从 checkout 引入。
- 本仓库永不 import dsh loop 内部；只挂 `docs/architecture.md` "Where new behavior goes" 列出的 seam。
- UI 若日后要做：client 插件走手写 JS（`dsh.client` 声明 + `window.__ModuleLoader__.load`），不引入 React 构建链。
