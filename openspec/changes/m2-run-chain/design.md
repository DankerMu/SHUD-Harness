# Design

## Context

动机见 proposal.md「Why」。设计受以下事实约束（均已核查）：

- dsh `ctx.jobs` 只能有一个实现：第二个 `JobRegistry` 服务注册即抛重复错误（`deepseek-harness/packages/jobs/jobs/src/index.ts`）。Web 模板的 `jobs` 行在 `packages/bundle/base/cordis.patch.yml:96-97`（`id: jobs`，`@deepseek-ai/dsh-jobs-local`），profile patch 可按 id 覆盖。
- `LocalJobRegistry`（`dsh-jobs-local`，约 900 行）公开导出、可继承；内部 30 个 private 成员、0 个 protected，子类只能通过公开方法与 `JobSpec.run` 的 producer 钩子介入。宿主退出时它对每个活作业调用 producer 的 `cancel(reason)` 并等待结算（`jobs-local/src/index.ts:674-717`，teardown 理由 `'jobs service disposed'`）。
- `ctx.subprocess`/`ctx.shell` 启动的子进程在宿主退出时被杀（`subprocess-local/src/spawn.ts:74-79`）；要活过重启必须自己 spawn，不登记到 subprocess 服务。
- `tool-jobs` 在 `settled` 时用 `owner.followup` 唤醒空闲 owner，但 owner 无活 Agent 时直接丢弃、没有待投递队列（`tool-jobs/src/index.ts:277-304`）。重启后的唤醒先例在 `schedule` 插件：`sessionController.resolveAgent(sessionId)` → `agent.followup(...)` → `ctx.sessions.flush(...)`（`schedule/src/runtime.ts:101-124`）。会话按需冷恢复，不在启动时全量重建。
- SHUD 调用形如 `cd <ws> && shud -o <ws>/output/<proj>.out <proj>`，读 `<ws>/input/<proj>/`，并向输入目录写回 `.cfg.ic.update`、`.bak`（`docs/03_SPEC/Domain_CLI_Spec.md`，`scripts/runtime/shud-tiny.sh:16-25`）；退出码 0/10/12/13/19/20（`docs/01_CODEBASE/SHUD_IO_Facts.md:96-98`）；ccw 全程约 4m45s。
- Seatbelt 只限制文件与网络访问，不限制 CPU/内存；宿主进程本身不在沙箱内。
- 现行 eslint 白名单只允许 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`（`eslint.config.mjs`）。

Stage 1 压测结论（22 个分支、3 个开放项）是本 design 的输入，逐条落在下面的 Decisions 与 Open Questions。

## Goals / Non-Goals

**Goals:**
- 一句话经 `shud_run` 跑 ccw；dsh 被 SIGTERM 或 SIGKILL 重启后，作业继续或被正确结算，完成后发起会话被唤醒并拿到含退出码与产物清单的 RunRecord。
- 记录与产物对 PI 可见（会话工作区 `runs/<run_id>/`），不依赖宿主内部存储。
- 非 shud 作业行为与替换前逐项一致。

**Non-Goals:**
- 非 shud 作业（`bash run_in_background`、terminal、workflow 等）的持久化与跨重启恢复：保持 `jobs-local` 语义，重启后仍为 `unknown job`。
- `timed_out` 状态、`max_wall_minutes`/`max_compute_minutes` 超时终止，以及 GAP-02（TaskCard 在超时时如何转换）：随 TaskCard 在 M3 决定。
- `numerical_health` 的实际计算（`.dat` 二进制完整性、NaN/负状态扫描、`SUNDIALS_ERROR` 解析）：字段在 M2 可为空。
- TaskCard、StackLock、DataProvenance 对象本身及其与 RunJob/RunRecord 的必填引用（M3）。
- `shud_run` 的 PI 审批、治理动作审批接线（M3）。
- SHUD 子进程的宿主沙箱包装。
- 多 SHUD 并行与批量运行（M5）。
- `docker_job`/`local_direct` 后端。

## Decisions

### D1 继承 `LocalJobRegistry`，按 id 替换 `jobs` 行

`@shud-harness/dsh-shud-jobs` 导出 `ShudJobRegistry extends LocalJobRegistry`，profile patch 用 `- id: jobs` 改指向它。非 shud 的 `start` 原样交给父类；shud 作业也经父类 `start` 登记（因此 `job_list`/`job_output`/`job_kill` 与作用域、事件路由全部复用），持久化、脱离运行、对账与唤醒由子类附加的 shud runner 负责。新增公开方法供工具包调用：提交 shud 作业、按 `job_id`/`run_id` 查记录、幂等 collect。

备选：只继承抽象 `JobRegistry` 从零实现（JobId 跨重启稳定，但需重写约 1000 行作用域/事件契约，与宿主耦合面更大）；保留 `jobs-local` 另写独立 runner（不满足 K8"替换 jobs-local"，且 shud 作业不进 `job_*` 工具面）。均否决。代价：重启接管后的作业在 dsh 里拿到新的 `JobId`，模型侧以 `job_id`（`JOB-…`）/`run_id` 关联，旧 JobId 记入记录的 `dsh_job_ids`。

### D2 运行目录与记录落在会话工作区，活动索引在 `stateDir`

每个 shud 作业在提交时同时分配 `job_id` 与 `run_id`，运行目录为 `<会话工作目录>/runs/<run_id>/`：

```
runs/<run_id>/
  input/<project>/        # 输入目录的完整副本（SHUD 在此写回）
  output/<project>.out/   # shud -o 目标
  stdout.log  stderr.log
  exit_code               # 包装进程写入，见 D4
  run-job.json            # RunJob 当前状态（原子写：临时文件 + rename）
  run-record.json         # collect 后写入，写入后不再改动
```

插件配置 `stateDir`（必填，缺失或不可写时插件行启动失败）下保存 `active.json`：尚未完成唤醒的作业的运行目录绝对路径与提交顺序，原子写。启动对账只读这一个索引；唤醒完成（或 owner 不可达，见 D7）后从索引移除。备选：全部放 `$DSH_HOME` 下的宿主 storage domain——记录对 PI 不可直接见、与压测结论不符，否决。

### D3 id 规范

`JOB-YYYYMMDDTHHMMSS-xxxx` 与 `RUN-YYYYMMDDTHHMMSS-xxxx`：UTC 时间到秒 + 4 位小写十六进制随机数；同一作业的两个 id 共享时间戳与随机段，便于人工对照。在 `stateDir` 内以 `active.json` 与运行目录存在性去重，碰撞时重抽。替换 Minimal_Schemas 的 `JOB-NNNN`/`RUN-NNNN`（无需全局计数器状态）。core 以品牌类型 `JobRecordId`/`RunId` 暴露，与 dsh 的 `JobId` 区分。

### D4 脱离宿主的包装进程与退出码

shud producer 用 Node `child_process.spawn` 直接启动 `/bin/sh` 包装进程（`detached: true`，stdio 重定向到文件，`unref()`），不经 `ctx.subprocess`，因此宿主退出不会杀它。包装进程在运行目录内执行 `shudBin -o output/<project>.out <project>`，结束后把退出码写入 `exit_code.tmp` 再 rename 为 `exit_code`。`run-job.json` 记录包装进程 pid 与其启动时间（用于识别 pid 复用）。宿主无法 reap 孤儿进程，`exit_code` 文件是退出结果的唯一来源。SHUD 不套沙箱（Seatbelt 不限制算力，单用户工作台前提下由 D8 的路径约束守边界）；`shudBin` 为必填配置，不硬编码。

### D5 生命周期、队列与 teardown

RunJob 状态：`created`（记录已写，尚未入队）→ `submitted`（排队）→ `running` → `succeeded`（退出码 0）| `failed`（非 0 或进程丢失）| `cancelled`（`job_kill`）→ `collected`。全机同一时刻最多一个 `running`；其余按提交顺序 FIFO，队列即 `active.json` 中状态为 `submitted` 的条目，跨重启保留，对账后从队首继续。

- 模型 `job_kill`：对包装进程组发 SIGTERM，宽限后 SIGKILL，状态 `cancelled`；排队中的作业直接出队并置 `cancelled`。
- 宿主 teardown：producer 的 `cancel` 收到 teardown 时**不**杀进程，只让本次登记以 `failed`（detail 说明"宿主退出，shud 继续在后台运行"）结算，`run-job.json` 保持 `running`/`submitted`。dsh 的 `settled` 事件此时带 `cause: teardown`，`tool-jobs` 不会据此唤醒。如何可靠区分 teardown 与模型 kill 见 Open Questions O1。

### D6 结算时自动 collect

作业进入终态（含对账时补结算）即由后端 collect：读 `exit_code`、扫描 `output/<project>.out/` 生成产物清单（相对路径 + 字节数）、计算 `wall_seconds`、按退出码映射 `exit_class`，写 `run-record.json`，状态置 `collected`，然后才唤醒。collect 幂等：`run-record.json` 已存在时直接返回该记录，不重写。`shud_collect` 调用同一逻辑。

### D7 至少一次唤醒

- 宿主在线时结算：producer 的 `done` 以包含 RunRecord 摘要的 outcome 结算，`tool-jobs` 按常规路径 `followup` 空闲 owner。
- 宿主不在线期间结算（对账时发现）：后端以 `sessionController.resolveAgent(owner)` 冷恢复会话，`followup` 一条带 RunRecord 摘要的消息（`source.kind` 为 `shud-jobs`），`flush` 会话后才把记录的 `notify.status` 置 `delivered`。
- 崩溃发生在 followup 与置位之间时，下次启动会再投递一次（at-least-once，消息内含 `run_id` 便于模型识别重复）。owner 会话已不存在或无法恢复时置 `notify.status: unreachable` 并记录原因，不再重试，RunRecord 仍可经 `shud_collect` 查到。

### D8 raw 与路径边界

`shud_run` 的运行目录根是工具调用的有效工作目录；raw-guard 在 `tools/pre-execute` 对 `shud_run` 判定：有效工作目录位于任一 raw 目录内（运行目录会写进 raw）→ `deny`；`input_dir` 位于 raw 内（只读复制）→ `ask`，复用 provenance 文案；其余委托下一个监听器。`shud_run` 自身另做 fail-loud 校验：输入目录存在、含 `<project>.cfg.para`、运行目录不在输入目录内。

### D9 seam 白名单

运行时 import 放宽到 `@deepseek-ai/dsh-jobs`（契约与类型）与 `@deepseek-ai/dsh-jobs-local`（父类）；唤醒所需的 `sessionController`、`sessions`、Agent 等类型只允许 `import type`（eslint `allowTypeImports`），运行时经 `ctx.inject` 取服务。决策记录 `docs/adr/implemented/0006-dsh-jobs-seam-imports.md`；`test-guardrails` 增加正反例。

### D10 RunRecord 的 `llm.response_model`

取发起 `shud_run` 那次工具调用所属响应的 model id，提交时写进 `run-job.json`，collect 时复制到 RunRecord。取值途径由 spike 确认（O4）；不可得时以 profile 的 `agent-default-model` 配置值记录并在字段旁标注来源，不硬编码。

### Sketch seams under test

- `decideRawAccess(call, options)`（raw-guard 纯函数）：`shud_run` 新判定沿用现有最高 seam，与既有 vitest 表同构。
- `ShudJobRegistry` 的公开面（提交、查询、collect、对账入口）在临时目录 + 伪 `shudBin`（写退出码的 shell 脚本）下做集成测试：持久化、队列、teardown、对账四类不变量都经这一 seam 证明，无需真实 SHUD。
- RunJob/RunRecord Zod schema 的 `parse`：字段、id、状态、可空引用的正反例。
- `pnpm run shud:restart`：真实宿主 + 真实 ccw 的端到端 seam，只在本机运行，判据取 session log 与运行目录。

## Risks / Trade-offs

- [继承 `LocalJobRegistry` 依赖其公开方法与 teardown 行为，宿主升级可能改变] → 白名单 ADR 记录耦合面；里程碑边界的 `chore(dsh-upgrade)` 必查 `jobs-local` 变更；集成测试覆盖 teardown 路径。
- [teardown 时让登记以 `failed` 结算，dsh 视图与真实进程状态短暂不一致] → detail 文案说明后台继续；对账后以新登记接管，RunRecord 以运行目录为准。
- [pid 复用导致把别的进程当成仍在运行的 shud] → 同时比对 pid 与记录的进程启动时间；不一致即按"进程丢失"处理。
- [shud 不套沙箱，可写任何其进程有权限的位置] → 运行目录与输入路径由 raw-guard 与 `shud_run` 校验；`-o` 固定在运行目录；单用户工作台前提写入 spec。
- [至少一次投递可能产生重复唤醒] → 消息含 `run_id`，模型与 PI 可识别；窗口仅在 followup 与置位之间。
- [输入整份复制，大输入耗盘耗时] → 复制字节数记入 RunJob；复制失败即作业 `failed`，不部分运行。

## Migration Plan

- 合入顺序按 tasks.md：spike → 边界杂项与白名单 → schema → 注册表骨架（行为不变的替换）→ runner/队列/对账/唤醒 → 工具与 raw-guard → 验收脚本。骨架阶段 profile 已改挂 `dsh-shud-jobs`，但非 shud 行为不变，`profile:smoke` 与 `raw-guard:probes` 必须保持绿。
- 配置：`stateDir`、`shudBin` 是机器路径，bundle patch 不提供；部署期写在用户 profile patch 的 `- id: jobs` 行，`profile:smoke` 与 `raw-guard:probes` 以 `--patch` overlay 注入临时值（shud-profile「Profile composition」）。
- 回滚：profile patch 删除 `- id: jobs` 覆盖行即恢复 `jobs-local`；`runs/` 目录与 `stateDir` 可保留供人工查阅。
- 文档：`Minimal_Schemas.md`（frozen）在 schema 任务中按本 design 修订 id 与状态集，并在文首注明修订来源为本 change。

## Not yet specified

- 用户自有 SHUD 输入目录的生命周期（AutoSHUD 产物如何进入、是否需要 DataProvenance 记录来源）——M3 DataProvenance 与 AutoSHUD 编排推到时再界定。
- 超大输入的复制策略（硬链接、只复制 SHUD 会写回的文件）——等真实流域输入出现后才能说清问题。

## Open Questions

由首个子 issue（限时 spike）回答，结论写回本 design，不改 specs 与任务拆分：

- O1：`LocalJobRegistry` 的 producer `cancel(reason)` 能否可靠区分宿主 teardown 与模型 `job_kill`（理由字符串、调用路径或 `job.settleCause` 的可见性）。
- O2：插件以 `detached: true` 直接 spawn 的包装进程能否活过宿主的 SIGTERM 与 SIGKILL（macOS 进程组与宿主退出钩子）。
- O3：`shud:restart` 能否以脚本方式重启 dsh 并恢复同一会话以观察唤醒（headless `--json` 与会话恢复参数，或 Web 的 HTTP 接口）。
- O4：工具执行上下文能否拿到本次响应的 model id（D10）。
