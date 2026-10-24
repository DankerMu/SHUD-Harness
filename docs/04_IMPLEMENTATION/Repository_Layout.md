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
  packages/
    dsh-shud-core/                  # 领域层（运行时无关）
      src/schemas/                  # 8 对象 Zod schema（移植）
      src/governance/               # 治理常量、policy-gate-core 纯函数（移植）、措辞规则
      src/index.ts
    dsh-shud-raw-guard/             # tools/pre-execute 策略门插件（spike 1.2 TS 化）
    dsh-shud-jobs/                  # durable JobRegistry backend（ctx.jobs 契约）
    dsh-shud-tools/                 # 已挂载 shud_run 与索引式 shud_collect
    dsh-shud-records/               # TaskCard/RunJob/RunRecord/StackLock/EvidenceReport 的 ctx.storage 域
    dsh-shud-presets/               # coordinator / worker / coder / reviewer agent preset 与 system prompt 段
  profile/
    shud/
      package.json                  # dsh bundle 声明（dsh.bundle.patch）
      cordis.patch.yml              # 模型路由、session-log-deepseek 关闭、以 workspace 包说明符挂载插件（bundle 声明 workspace:* 依赖）
      overlays/                     # 可选 --patch 覆盖（本机 / CI）
  skills/                           # SHUD 专用 SKILL.md（run-shud-tiny-case 等，经 dsh skill-filesystem 加载）
  scripts/                          # 确定性脚本（R/bash），非 LLM
  templates/                        # evidence_report.md 模板
  docs/                             # ADR + 计划 + 精简 spec（处置表执行后）
  openspec/                         # glossary + changes
  SHUD/ rSHUD/ AutoSHUD/            # 只读参考 submodule（保留）
```

每个 `dsh-shud-*` 包：`src/` TS strict，`tsc` 到 `lib/`，`vitest` 测试。jobs/tools 按实际宿主 seam 声明 `peerDependencies`，tools 补齐其运行时 peer 闭包；以相同钉版 `devDependencies` 支持本仓构建/测试（dsh seam `0.2.1-rc.2`、Cordis `4.0.5`）。profile bundle 的宿主 peer 为 `@deepseek-ai/dsh@0.2.1-rc.2`，不为插件另装宿主。Host 侧插件入口 `export const name` + `export function apply(ctx, config)`。不发 npm；profile bundle 声明 jobs/raw-guard/tools 的 `workspace:*` 依赖，以 `insert` 插入各自包说明符；`shud-tools` 注入现有 `tools` 与 SHUD `jobs` 服务，不兼容普通 `jobs-local` 替代。

默认 `rawDirs: ["data/raw"]` 仅用于开发与探针；部署期真实 `<data_root>/raw` 必须在 workspace root 之外，由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 中以 `- id: shud-raw-guard` + `config: { rawDirs: ["<workspace 外的绝对路径>", ...] }` 覆写。`profile:install` 要求 `SHUD_BIN` 为绝对路径、可执行普通文件，仅新增/更新安装器拥有的唯一 `shud-jobs` 项（`shudBin` 与 `stateDir: $DSH_HOME/profiles/<name>/shud-jobs`），其余用户 patch 字节不变；已有 raw-only patch 升级后再次安装保持整文件 hash 不变。覆写结果可用 `--profile shud --dump-config` 查看。`shud-jobs` 已实现 stateDir 排他所有权及原子串行索引；永久 `.lock-guard`、可移除 `lock` 与平台工具前提见 [Runtime Lifecycle](../../instructions/agents/shared.md#runtime-lifecycle)。

注册表现提供 `submitShud(request, producer)`，完成输入复制、提交记录/索引持久化、瞬时无 owner 登记与真实包装进程启动，原子写入 pid/启动时间后返回 `running` RunJob。必需的 `producer(prepared, handle, pumpPollMs)` 返回 `ShudExecution`；已导出的 `startDetachedShud(prepared, hooks, pumpPollMs)` 要求显式 `ShudLifecycle`（JobHooks、正常终态的同步/异步 `settle` 与必需同步 `detach(detail)`，共用实际 producer done），并沿用注册表统一解析的父类轮询间隔。本地提交与接管共用最小受控组/完成能力，但原生 child 启动、回收及回滚 abort 仍只属于实际本地执行，不为接管伪造。detached 包装进程原子发布 `wrapper.pid`/`exit_code`；唯一调度器与公开 `pollOnce()` 共享逐条目排他状态，正常结算先原子持久化终态再完成登记，完成回调失败可重试而不改写终态。同步公开 kill 作用于本实例实际关联的提交或 R3/R5 接管登记，先持久化取消意图并在父类调用前保留本地期限镜像，再向受控进程组 SIGTERM；既有 cadence 在 core 10 秒期限到达后按需 SIGKILL，组静止后按退出证据 first-wins 结算，不因 leader 单独退出提前完成 durable 结果，本地执行还须完成真实子进程回收。取消、结算及 collect 状态投影共用新鲜 RunJob 的非让出式原子发布，避免旧快照覆盖取消标记。后续 tick 自动收集，后端 `collectShud(RunId | JobRecordId)` 共用同一条目队列与收集实现：原子发布不可变 RunRecord 后投影 `collected`，生成失败持久化重试记录，自动间隔 10 秒、最多 3 次，直接调用可重试。组合生命周期先停止轮询/收集/kill/提交准入，等待已接受及排队工作（含启动对账与接管登记清理）结束再释放索引锁；父类并发释放期间仍保留必要的托管登记分类。本地提交回滚先证明执行组静止并回收本地子进程，再清理登记与自有文件。未标记的托管 cancel 则同步 detach 为 failed：无意图不发信号，有意图先重发受控 TERM，检查/信号错误经受控日志报告而仍完成登记；不读写 durable 状态、不等待进程或发 KILL。接管登记沿用此 teardown 语义，无 owner 的登记也不因发起 Agent 释放而取消。唤醒及工具入口尚未接入；详细顺序、资源契约及 Darwin R7/Linux R8 验证边界见 Runtime Lifecycle 与下文 Park/Resume 链接，不以独立 `shud:tiny` 的执行成功代替注册表运行证据，也不宣称完整宿主/Web 恢复或 PI 验收。

R1–R12 启动对账已接入 `[Service.init]`：先排空启动 pass 再开放 SHUD submit/poll/collect 并启动正常 cadence，恢复取消可能等待原始宽限的剩余时间，原有启动锁与 drain 边界不变。#310 原始切片只做文件级对账；#312 现为 R3/R5 建立真实无 owner 接管登记，复用原 label/stdout、不重新 spawn，先清空旧 current id，再不让出地发布新 id/追加历史和完成回执，每个实例只登记一次。发布前 registered 事件中的重入 kill 拒绝，不写意图或发信号；发布后沿用托管 kill。登记/新 id 发布失败保留已清空的 null id 与旧历史，受控报告并排空/移除父类登记后释放关联，不 abort 物理执行、不删除运行文件/索引，后续文件级 poll/collect 不重试登记；存储不能清空旧 id 时仍明确失败。R8 保持无接管登记的恢复取消。R9 优先修复已提交 RunRecord 的状态，pending notify 不变，R12 仅修复已验证通知终态的完成索引；#313 唤醒/正常完成索引迁移仍未接入。Linux R3 以原生 proc/getconf 证据判新鲜度，lstart 身份不变，不确定证据 fail closed。完整恢复、接管失败清理及 #343/#344 已知限制集中在 [Park/Resume §9](../03_SPEC/Park_Resume_Design.md#9-服务重启恢复)。

### 已挂载的 `shud_run`

构建后沿用同一导出的 `DSH_HOME` 与有效 `SHUD_BIN` 执行 `pnpm run profile:install`；`pnpm run profile:smoke` 检查 Web/headless profile 中的 `shud-tools` 组合与可导入性。运行前在 scratch 工作区复制输入，不改只读 SHUD submodule。模型工具调用示例（不是 shell 命令）：

```json
{"input_dir":"input/ccw","end_days":30,"label":"ccw END=30"}
```

仅接受 `input_dir`、可选 `project`、`end_days`、`label`；未知参数（包括 `workdir`/`threads`）拒绝。有效工作目录只取调用会话 cwd，输入路径原样交给注册表按物理路径处理；project 默认取所给路径末级目录名（忽略末尾分隔符），别名异名或 `.`/`..` 路径应显式给 project。`end_days` 是副本中正整数 END 日的绝对覆写，不是运行时长；label 必须为一行。输入复制与 cfg、内部链接/特殊文件、目录重叠检查仍由注册表负责。raw 输入先走 provenance 读审批，raw 输出目标拒绝；工具本身不新增 PI 审批门。

工具要求会话 id/cwd 与已配置模型：先取 `agent.session.requestHeader()?.config.model`，缺失再取 `agent.options.model`；恒记 `response_model_source: configured`，不把 assistant `source.model` 当响应体模型。它通过导出的 `produceDetachedShud` 提交实际执行，沿用 jobs 内与接管共用的登记完成工厂；`submitShud(request, producer)` 的显式 producer 参数仍必需。

提交完成即返回 `status: running`、持久 `job_id`/`run_id`、当前 `dsh_job_id` 与 `run_dir`，不等求解器结束。`job_output`/`job_kill` 只使用当前 `dsh_job_id`；重启接管后用 `job_list` 中含 `run_id` 的 label 或 `shud_collect` 的非终态错误找新 id。headless 未提供会话恢复服务时，通知可保持 `pending`、`attempts: 0`、`Waiting for session services`，不妨碍文件级结算或经 `shud_collect` 读取记录；这不等于完整 Web 跨重启或 PI 验收。

### 已挂载的 `shud_collect`

同一 `shud-tools` 插件已挂载收集工具；无需新增 profile 行。模型调用只传持久 id 之一，例如 `{"run_id":"RUN-20261024T200036-a20d"}`，或传该运行实际返回的 `job_id`。两者必须且只能提供一个，按 core 品牌 id 校验；未知键、错误类型/品牌和非对象参数均拒绝。`dsh_job_id` 不是收集参数。

工具只委托一次注册表 `collectShud()`：先查活动索引再查完成索引，不扫描工作区，不从调用会话 cwd 推断运行目录。终态尚无记录时执行现有收集；成功直接返回完整规范 RunRecord JSON，不添加科学结论。已提交记录重复读取时字节与 mtime 不变，包括通知完成、移出活动索引后由另一会话/工作区通过任一持久 id 读取。磁盘上有记录但未被索引的 id 仍返回 `UNKNOWN_ID`。

`created`/`submitted`/`running` 返回 `NOT_TERMINAL`，提交仍在途返回 `SUBMISSION_IN_FLIGHT`；受控错误包含当前状态和经校验的当前 `dsh_job_id`（未登记为 `null`，不是历史 id）。此类请求不生成结果或重试记录，提交在途请求也不会在排队期间转为收集。普通收集失败返回写入 `collect-error.json` 的受控原因；记账发布也失败时，错误同时保留原生成原因与受控发布错误，不泄露任意异常或元数据。

2026-10-24 实测边界：built ToolRuntime 的真实 ccw30 运行先拒绝运行中收集，退出 0 后经会话控制服务 seam 完成一次唤醒并移至完成索引，另一会话/cwd 通过两种 id 重复取得不可变记录。已安装 headless profile 的实际模型在两个新会话/不同 cwd 分别用两种 id 调用，canonical request/header/tool/call/tool/result 与落盘记录一致；该路径使用活动索引，通知仍为 pending/0、等待会话服务。两次运行各 45 个源/副本输入 hash 不变；不据此宣称 Web/PI 验收（#316–318）。

## 2. 运行时资产（不进代码仓）

```text
$DSH_HOME/                          # dsh 家目录（本机 ~/.dsh 或显式指定）
  profiles/shud/                    # 由 profile/shud 初始化的 profile
  sessions/                         # session.v4.jsonl（回放 fixture 来源）
  storages/                         # ctx.storage 域（RunRecord 等）
<workspace>/                        # 每个研究任务的工作区（session cwd = workspace root）
  shud/                             # SHUD 二进制 + input/ + output/
  runs/<run_id>/                    # 作业日志、pid 记录、产物清单
  reports/                          # EvidenceReport Markdown
<data_root>/raw/                    # 原始数据，必须在 workspace root 之外（Seatbelt 只读）
```

## 3. 与 dsh 的边界

- dsh checkout（`../deepseek-harness`，钉 tag）只作只读运行宿主，不改源码、不作为构建宿主；类型来自插件包的 devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2`（工具 seam）与 `@deepseek-ai/cordis@4.0.5`（`Context`），不从 checkout 引入。
- 本仓库永不 import dsh loop 内部；只挂 `docs/architecture.md` "Where new behavior goes" 列出的 seam。
- UI 若日后要做：client 插件走手写 JS（`dsh.client` 声明 + `window.__ModuleLoader__.load`），不引入 React 构建链。
