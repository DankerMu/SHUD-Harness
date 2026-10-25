---
status: frozen
---

# Park/Resume 设计

**状态：** P0 设计规范  
**适用范围：** 长时间 SHUD 运行、sensitivity batch、AutoSHUD pipeline、HPC/SLURM job、LLM 会话恢复  
**目标：** 让 Agent 在长任务期间停止消耗推理资源，并在 job 完成后可复盘、可幂等地恢复。

M2 运行主链以 [m2-run-chain design D2/D6/D7/D11/D12](../../openspec/changes/m2-run-chain/design.md) 为准，本文 §5、§9 与附录 A 是对应落地契约；TaskCard park/resume、批次聚合、邮件、metrics/report 以及 Docker/HPC 内容为后续里程碑规划，不是 M2 已实现能力。

## 1. 为什么需要 Park/Resume

SHUD 运行可能持续数分钟到数小时，sensitivity 和 calibration 可能提交多个 RunJob。让 LLM 会话持续等待会浪费 token，也会增加状态丢失风险。Park/Resume 的目标是把长运行转换为持久化 job：

```text
Plan → Submit RunJob → Park TaskCard → Watch Job → Collect RunRecord → Resume Coordinator → Report
```

## 1.1 Out-of-band notification after Resume/Report

dsh Web 会话只覆盖浏览器打开时的实时体验。M2 shud 作业的唤醒由工作区运行目录中持久化的 RunJob/RunRecord（或 collect 失败记录）与 `stateDir` 索引驱动，不依赖活动连接；无 owner 作业没有 `job/settled`，由注册表投递 `source.kind: shud-jobs` 消息。下列批次与邮件通知仍属后续规划。

通知触发点应在结果可读之后，而不是进程刚退出时：

```text
Single RunJob task:
  Watch Job → Collect RunRecord → Generate report draft → Notify once

Batch AnalysisPlan:
  all jobs terminal or stop condition reached
  → Generate AnalysisPlan summary / report draft
  → Notify once

Critical failure:
  first critical failure may notify immediately
```

MVP 使用 email notification。收件人解析顺序：

```text
task.notification_recipients[]
→ task.pi_owner_email
→ task.reviewer_email
→ HARNESS_DEFAULT_NOTIFY_EMAIL
```

通知必须生成 `NotificationRecord`，使用 deterministic `dedupe_key` 避免 watcher retry 或服务重启后重复发送。

Batch 模式不得对每个 RunJob completion 发送邮件；默认只在 analysis summary 或 report draft 可审阅时发送一封。

## 1.2 Park 阈值决策：何时 park、何时留在会话内等

park 不是零成本：resume 是一次冷读重建（provider 提示缓存 TTL ~5min，几小时后必然全冷）。
判据是**预期等待时长与缓存 TTL 的关系**：

| 预期等待 | 决策 | 经济账 |
|---|---|---|
| 短（tiny run、编译；< 阈值，默认 180s） | 留在会话内同步等待（running_local / submitted_job 轮询） | cache 尚热，续跑按缓存价（~1/10）；park+重建反而贵 |
| 灰区（~TTL 边界） | 会话内短等，超时自动升级为 park | 超时兜底，不悬挂 |
| 长（真实流域 run、batch、HPC 排队） | park | cache 必然冷：保留会话 = resume 冷读全量历史（随 park 轮次复利增长）；重建投影 ≤16KB，恒定且便宜 10-30× |

阈值进配置，按 provider cache TTL 校准（另见 [Cost_Inference_Budget §4.1](Cost_Inference_Budget.md) 前缀缓存快照）。
误判偏向 park：错 park 只多付一次 ≤16KB 重建；错不 park，冷读成本随历史长度增长无上界。

## 2. 状态定义

TaskCard.status 使用粗粒度状态机（权威定义见 `03_SPEC/Minimal_Schemas.md`）。
Park/Resume 涉及的阶段映射如下：

| TaskCard.status | runtime_phase | 语义 |
|---|---|---|
| planned | — | 已形成可执行计划 |
| running | `submitted_job` | 已提交一个或多个 RunJob |
| parked | `waiting_for_job` | Agent 已暂停，等待外部 job 完成 |
| running | `collecting` | 正在收集日志、输出、指标和 artifact |
| reporting | — | 正在生成 EvidenceReport |
| awaiting_pi | — | 等待 PI 审阅、批准或补充判断 |
| done / blocked / cancelled | — | 已结束或被阻塞/取消 |

RunJob 状态应与 TaskCard 区分。TaskCard 代表任务生命周期；RunJob 代表一次执行请求。

## 2.1 plan.md 结构契约与修订规则

对抗审查 A02-1/A02-2/A04-5：plan_cursor、幂等 key（[Idempotency §4](Idempotency_Concurrency_Locking_Spec.md) 的 plan_step_id）与
"plan 以磁盘为准"都引用 plan 步骤，但步骤结构、修订权与重算算法此前无任何定义。契约：

**步骤 ID**：plan.md 的可执行步骤必须带稳定 ID（`step-NNN`，创建时由 harness 按序分配）；
修订可增删步骤，但**不得重编号、不得复用已分配 ID**。plan_cursor.completed_steps 与幂等 key 的
plan_step_id 一律引用该 ID。

**修订权与信任级**：plan.md 仅 Coordinator 可写，且仅在 Plan / Resume 阶段（Execute 期间要改
计划须先让 TaskCard 回 planned，走 Control_Kernel 状态机）；每次修订产生 `plan.revised` 事件，
记录 actor、revision 号与依据 refs——refs 不得为空且不得全为 T4（[Context_Trust §4](Context_Trust_And_Injection_Spec.md) 高影响动作中
机器可查的部分）。PI 要求修订走 TaskCard 回 planned 的既有路径。

**cursor 重算（确定性集合运算，无 LLM 参与）**：resume 发现磁盘 revision > parked revision 时：
`completed' = completed ∩ 新 plan 步骤 ID 集`；被删除的已完成步骤记入 resume warning
（不重跑、不静默消失）；`next_step = 新 plan 中第一个 ∉ completed' 的步骤`。

## 3. parked_state 文件

每次 park 必须落盘：

```yaml
parked_state:
  task_id: TASK-20260424-001
  session_id: SESSION-...
  workspace_id: WS-...
  coordinator_agent_id: agent_...
  reason: waiting_for_job
  parked_at: 2026-04-24T10:15:00-04:00
  resume_policy:
    trigger: all_jobs_completed | any_job_failed | manual
    auto_collect: true
    auto_report: false
  waiting_on:
    run_jobs:
      - RUNJOB-001
      - RUNJOB-002
  context_refs:
    task_card: tasks/TASK-.../task.yaml
    plan: tasks/TASK-.../plan.md
    stack_lock: stacks/STACK-.../stacklock.yaml
    data_provenance: provenance/DATA-<uuid>.json
  plan_cursor:
    completed_steps: [step-1, step-2]
    next_step: step-3
    plan_revision: 2          # plan.md 修订号；恢复时若磁盘上的 plan revision 更新，以磁盘为准并重算 cursor
  last_user_visible_summary: "已提交 ccw tiny run，等待 SHUD 运行完成。"
```

建议路径：

```text
workspace/tasks/<task_id>/parked_state.yaml
```

## 4. Job watcher

Job watcher 是非 LLM 后台进程，负责轮询或订阅 job 状态。它不做科学解释，只做状态转换和事件推送。

实现缝 = dsh `ctx.jobs`（JobRegistry 契约），由本项目自写的 durable backend 承载（[ADR-0004 K8](../adr/implemented/0004-dsh-kernel.md)）。

### 4.1 本地 job

本地 job watcher 监控：

- process pid 是否存在；
- exit code；
- stdout/stderr 文件大小；
- heartbeat 文件；
- timeout；
- output directory 是否出现 expected outputs。

### 4.2 Docker job

Docker job watcher 监控：

- container status；
- exit code；
- mounted workspace；
- resource stats；
- logs。

### 4.3 SLURM/HPC job

SLURM watcher 监控：

- scheduler job id；
- `squeue`/`sacct` 状态；
- stdout/stderr 路径；
- walltime；
- node failure；
- array job 子任务状态。

## 5. Collect 阶段

Collect 必须是幂等的。重复调用 `collect` 不应破坏已完成结果。

当前实现：`dsh-shud-jobs` 已提供自动收集与后端 `collectShud(RunId | JobRecordId): Promise<RunRecord>`，共用逐条目队列并等待本地完成回执；先发布不可变 RunRecord，再投影 `collected`。状态投影失败只修复投影，不重做生成或消耗生成尝试；成功重试保留历史错误记录。R9/R10 启动对账复用该收集实现：有效且身份匹配的已有 RunRecord 在读取重试记录前优先返回，即使历史预算耗尽、未到重试间隔或记录损坏，也只修复状态；没有有效已提交结果时，损坏的重试记录阻止新的生成尝试，保留且不重置次数。手动 API 可越过正常重试间隔/次数上限。已挂载 `shud_collect` 工具通过同一 API 接受 `job_id`/`run_id` 二选一，直接返回规范记录；收集本身不投递消息，pending notify 的活动索引在收集后仍保留，由服务初始化后的唯一轮询循环执行 #313 投递，通知终结后迁移索引，见 §9。实现边界与安全规则见 [Runtime Lifecycle](../../instructions/agents/shared.md#runtime-lifecycle)。

M2 collect 先按持久 id 从活动/完成索引找到原运行目录（提交时为 `<session cwd>/runs/<run_id>/`），不从收集调用者 cwd 扫描或推断路径，再读取作业与退出信息：按退出码映射 `exit_class`，扫描 `output/<project>.out/` 得到相对路径/字节数清单，计算 `wall_seconds`，复制模型 id 与来源，经 core schema 校验后写 `run-record.json`，再将 RunJob 置为 `collected`；后续投递步骤由同一轮询循环负责，不由 collector 发消息。有效且身份匹配的已有 `run-record.json` 原样返回，内容和修改时间不变；`shud_collect` 工具复用同一逻辑，通知完成后另一会话/工作区仍可经完成索引读取。当前 `wall_seconds` 由 `(Date.parse(finished_at) - Date.parse(started_at)) / 1000` 计算（缺时间为 null），不是精确求解器计时；测量限制见 §9。

失败写同目录 `collect-error.json`（`attempts`、`last_error`、`at`），作业保持或置为终态；退出码不可读/非整数时为 `failed`，不写占位 RunRecord、不置 `collected`。唯一轮询循环在距上次尝试至少 10 秒后重试，上限 3 次；达到上限不再自动 collect，后端 `collectShud()` 与 `shud_collect` 仍可手工重试。重启由 R9/R10 接续；耗尽后的投递保留原终态和错误记录，仅使用经受控阶段/代码校验及归一化的实际失败原因，不直接转发任意 `last_error`。不可信的历史诊断或损坏、错身份、链接形式的已有 RunRecord 阻止失败唤醒，不重置预算、不猜测结果；有效同身份 RunRecord 仍优先。工具错误保留本次受控生成原因，包括记账发布同时失败的聚合错误；非终态/提交在途请求只返回当前状态与经校验的 nullable `dsh_job_id`，不生成结果或 ledger。参数、用法及验证边界见 [已挂载的 shud_collect](../04_IMPLEMENTATION/Repository_Layout.md#已挂载的-shud_collect)。

metrics、数值健康计算、ArtifactManifest、TaskCard 更新与报告生成不属于 M2 collect；它们在后续里程碑按相应对象契约接入。

## 6. Resume context

Resume 时不应依赖 LLM 原始上下文窗口。必须从磁盘重建：

```yaml
resume_context:
  task_card: ...
  original_brief: ...
  plan_summary: ...
  plan_cursor:
    completed_steps: [step-1, step-2]
    next_step: step-3
    plan_revision: 2
  stack_lock_summary: ...
  data_provenance_summary: ...
  run_records:
    - run_id: RUN-001
      status: succeeded
      metrics_ref: artifacts/metrics/RUN-001.yaml
  job_failures: []
  pending_pi_gates: []
```

Coordinator resume prompt 应明确：

- 这是恢复任务，不是新任务；
- 按 `plan_cursor` 从 `next_step` 接续，不重做 `completed_steps`；
- 不要重新提交已完成 job；
- 先检查 RunRecord 和 metrics；
- 只在证据不足时建议下一步。

多个 job 乱序完成时，resume 不逐 job 触发：按 `resume_policy.trigger` 聚合（如 `all_jobs_completed`），
resume_context.run_records 一次性给出全部终态 job 的 RunRecord。

**resume_context 组装规则（AGA-P1-4）**：resume_context 不是自由拼接——允许进入的内容清单与预算上限
（Resume 阶段 ≤ 16KB）由 [Context_Trust_And_Injection_Spec](Context_Trust_And_Injection_Spec.md) §5 统一定义。
其中 `plan_summary` / `stack_lock_summary` / `data_provenance_summary` 由确定性模板生成（字段抽取，非 LLM 压缩）；
run_records 只带 status 与 metrics_ref，不内联日志或输出数据；job stdout/stderr 若需引用，
按同规范 §5 的 tail 截断规则并以 T4 包裹注入。

resume 时 system prompt 复用 session 首轮存盘的字节级快照（见 [Cost_Inference_Budget §4.1](Cost_Inference_Budget.md)），
不重新渲染——重建的是对话上下文，不是前缀。

## 7. 触发策略

| 触发方式 | 使用场景 |
|---|---|
| `all_jobs_completed` | sensitivity batch、benchmark pair、calibration batch |
| `any_job_failed` | debugging、smoke test、CI-like run |
| `manual` | 需要 PI 决定是否继续的长实验 |
| `time_window` | 定期检查远程 HPC job |

MVP 推荐默认：单 job 使用 `any_job_failed_or_completed`；batch 使用 `all_jobs_completed`。

## 8. 幂等与锁

为了避免重复 collect 或重复 report，应使用 lock 文件：

```text
workspace/jobs/<job_id>/locks/collect.lock    # job 级——batch 多 job 并发 collect 互不阻塞（对抗审查 A02-4，与 Idempotency §5 一致）
workspace/tasks/<task_id>/locks/resume.lock   # resume 是 task 级动作，保持 task 级
```

锁内容记录持有者、开始时间、过期时间。服务重启时，如果锁已过期，可以进入 recovery 流程。

M2 不使用上面的后续 TaskCard/job 级锁布局：注册表在配置的 `stateDir` 通过永久 `.lock-guard` inode 持有内核排他锁，`lock` 仅保存 owner 元数据（pid + 进程启动时间）；同实例索引修改串行化，同条目同时至多一个轮询步骤在途，已有 RunRecord 不重写。存活持有者使第二实例激活失败，陈旧 owner 才可接管，不依据 mtime 或过期时间自动认领；详见 design D2/D7。

**锁释放故障（#335，策略 C）**：关闭准入并排空已接受工作后，仅在持有 guard 时自动尝试一次 unlink `lock`，然后无论 unlink 是否失败都尝试关闭描述符；零自动重试，无新恢复 API、nonce、定时器或 live-self 自动接管。错误包含 stateDir、元数据路径、失败操作与错误码，并保留原始错误；初始化错误与清理错误并存时，初始化仍为主因。描述符成功关闭才能报告 guard 已释放；关闭失败报告状态未知。删除失败可能留下元数据，ENOENT 则表示缺失，不能宣称文件仍在，也不视为成功。`close()` 始终返回同一 promise/rejection，修复权限后重复调用不会重试或重复上报。取得空闲 guard 后仍遇到匹配存活本进程的元数据，apply 会以“疑似自身释放残留、需运维核实”拒绝；外来存活 owner 和实际 guard 争用仍拒绝。

**安全运维恢复**：先修复文件系统权限/健康状况，首选停止原宿主、禁止并发启动，再通过正常陈旧 owner 获取路径启动一个实例。人工处理则必须先停止准入/相关宿主、确认无活跃注册表拥有该 stateDir，再取得并持续持有同一个永久 `.lock-guard` 的内核排他锁，在锁内重新读取并核实 owner，仅移除确认的残留 `lock`，最后释放 guard 并启动一个实例。“检查空闲后放锁，再删除元数据”存在竞态，不是安全恢复；绝不删除/改名 `.lock-guard`，绝不手改/删除两份索引。guard 关闭结果或所有权未知时须退出宿主或进一步核实，不得盲删。该策略保留恢复或原宿主退出前的可用性阻塞窗口；锁恢复不修复损坏索引。外层生命周期一次报告与底层错误保留的完整约定见 [Runtime Lifecycle](../../instructions/agents/shared.md#runtime-lifecycle)。

当前在线取消实现：注册表对本实例实际提交或启动 R3/R5 接管关联的 SHUD 登记提供同步公开 kill，先持久化取消意图并在父类调用前镜像首次期限，再向受控进程组 SIGTERM；重复请求保留首次时间，既有轮询按 core 10 秒宽限期升级 SIGKILL，不新增定时器。父类在消费标记前抛错也不丢失已持久化意图；失败写入不产生意图镜像。包装进程先退出但后代仍可 I/O 时继续等待/升级，组静止后按退出文件 first-wins 结算 durable 结果，再完成本实例登记；本地提交还必须完成真实子进程回收。轮询和 collect 状态投影使用新鲜 RunJob 的同步原子发布，不覆盖并发取消标记。非托管登记保持父类行为；接管顺序、取消意图的文件级重启接续与 #313 唤醒见 §9。工具入口尚未落地，此实现状态不代表完整宿主/Web 恢复或 PI 验收。

**宿主 teardown 与正常结算分开**：`ShudLifecycle` 要求异步可等待的 `settle(outcome)` 和同步 `detach(detail)`，二者释放同一实际登记资源、完成同一个 producer-owned done，完成幂等且不创建替代 promise。未消费一次性 kill 标记的托管 cancel 在回调内 detach 为 failed，父类公开 settled 事件的 cause 为 teardown；不转发任意 supplied cancel（该回调保留给提交回滚），不靠父类异常兜底强制失败伪造 producer 完成。无取消意图时不发信号，detail 说明宿主退出但 SHUD 继续后台运行；已有意图时先按原组所有权证明重发 SIGTERM，再说明 kill 进行中。权限/检查/可观察替代 leader 错误经受控阶段与错误码报告，仍在 finally 完成登记，不向无法证明归属的组发信号，也不宣称静止。

这是纯登记级放手：登记级 detach 不读写 RunJob/索引，不生成 RunRecord 或 collect ledger，不唤醒、不发 SIGKILL、不等待子进程、不重置取消期限；原始 intent、状态及未完成通知留给后续对账。组合生命周期则先关闭准入，再排空已接受的正常工作及启动 R8，包括已接受的通知 flush、失败记账、标记发布与索引迁移，之后释放状态锁；不能把 detach 的无文件副作用解释为丢弃这些在途工作。发起会话的 Agent 释放不取消无 owner 的 SHUD 登记，后台任务仍可自然结束、正常 collect 并进入投递。

本地提交与接管共用内部最小受控组/完成契约 `ShudControl` / `ShudCompletion`，包含组检查/信号与共享同一实际 done 的 settle/detach；接管使用恢复的组能力和真实父类输出泵完成，不伪造原生 child、started、waitForExit 或 abort。实际本地 `ShudExecution` 仍独自拥有子进程启动、回收与回滚 abort；本地取消先等真正的 native-child waiter，不能因接管不拥有 child 而删去此等待。上述 plain/grace teardown 和无 owner Agent 释放语义同样适用于已接管登记。

## 9. 服务重启恢复

M2 注册表 apply 时先取得 `stateDir/lock`，在 Cordis `[Service.init]` 中读取 `active.json`，按索引中的绝对运行目录执行 [design D11 的 R1–R12](../../openspec/changes/m2-run-chain/design.md) 对账。`await ctx.plugin(...)` 完成才表示注册表就绪；此前即使经 root/non-strict 取得服务，`submitShud()`、`pollOnce()`、`collectShud()` 也明确拒绝。#310 原始切片只实现不带新 dsh 登记的文件级对账；#312 在其已验证的 R3/R5 分支接入真实接管登记。当前对账仍不读取 `ctx.storage`，不扫描后续 TaskCard 布局，不重新 spawn、不重新入队，也不伪造原生执行或完成回执；原有锁、逐条目排他与启动/关闭 drain 边界不变。

- **R1–R4（未完成提交）**：created 结算 lost 并 collect；submitted 的退出文件优先，否则只读取已提交的普通、非链接 `wrapper.pid` 并验证真实进程与提交新鲜度，合格才同次写入 running/pid/pid_started_at/started_at。R3 使用该转换返回的新鲜 running 记录进入下述接管，不另造身份通道。确定进程缺失、已死或早于提交时，再读退出文件，仍无才 lost；未知检查错误不等同死亡。没有退出证据且缺有效 `submitted_at` 时保留并报错，不猜测启动边界。
- **R5–R8（已有运行身份）**：匹配且存活、无取消意图的 R5 进入接管，保留原物理执行并发布新 dsh id/历史；R6 按退出证据结算。R7 在 leader 缺失、不匹配或已死后重读退出文件，仍无才 lost（有取消意图则 cancelled），不向未获所有权的组发信号。R8 保持无 dsh 登记的文件级取消：先以新鲜、匹配且存活的 leader 建立恢复组控制，再沿用在线取消的信号、检查与期限逻辑；组静止后重读退出文件，有效数值始终优先，只有缺失才 cancelled。
- **R9–R11（收集与待投递）**：R9 复用 §5 的 canonical collector，有效同身份 RunRecord 优先于重试记录，只修复 `collected`，不重写结果；未提交结果的生成仍受原重试间隔/预算约束。R10 保留已耗尽终态，没有结果绝不伪置 collected；R11 保持 collected。启动文件对账阶段不投递，保持 pending notify；初始化完成后的普通轮询再对符合条件的条目执行下述投递。
- **R12（已通知索引修复）**：经身份/路径/状态路由和完整 notify 校验确认 `delivered`/`unreachable` 后，优先补写 completed 再移出 active，修复崩溃留下的重叠；不重置通知、不改写 RunJob/RunRecord。普通轮询也执行同一修复，不能仅凭 status 字符串迁移损坏的 notify。重复启动不生成第二份结果或索引条目。

**R3/R5 接管登记**：同步恢复已验证进程身份的组能力，在构造时捕获的原始注册表上复用瞬时全局控制器，建立无 owner 的真实 `kind: shud` 登记；label 仍为 run_id 加可选持久 label，输出继续读取原 `stdout.log`，不依赖 tool-jobs 或外部会话控制器。先经新鲜身份/路径校验把旧 `dsh_job_id` 清空为 null；producer 回调内安装托管分类、组能力和身份，父类 start 返回后在任何 await 之前发布新 current id、追加 `dsh_job_ids` 并保存真实完成回执。每个注册表实例只接管一次；重复 tick 不改 id/历史，后续新实例取得新 id 并追加一次，旧非 null id 不代表本实例已登记。

本地提交与接管共用同一 stdout 读取入口：每次打开拒绝最终分量符号链接，以非阻塞方式打开后校验实际描述符为普通文件；目录/FIFO 不被当作空日志，也不会等待 FIFO 写者。失败由父类记 warning 并停止该流，保留已有输出、不追加链接目标字节；正常增量 UTF-8、短读、截断与 spillPath 语义不变。此边界不证明原 inode 身份，不排除同用户硬链接/普通文件替换或祖先目录并发替换；这些残余与 #348 的写入侧非目标见 [design 风险记录](../../openspec/changes/m2-run-chain/design.md#risks--trade-offs)。

父类 `registered` 事件发生在新 id 持久化之前；监听器中重入公开 kill 必须以 `kill identity / MISMATCH` 拒绝，不写取消意图、不发信号，不排队补发。发布后 kill 使用同一 current id、pid/start 和受控组证明，走 §8 的取消/teardown 路径。

**接管失败与降级**：旧 id 清空成功后，父类 start 拒绝、producer 回调后抛错或新 id/历史发布失败均记录含 run_id 的受控阶段/错误码，不泄漏原始异常载荷；current id 保持 null、旧历史不变。已生成的父类登记直接 detach 自己的实际完成资源，等待真实父类终态与输出泵排空后移除，最后释放托管关联；不调用适配后的 cancel 或物理 abort，不发信号、不删除运行目录/索引。清理失败保留未完成关联并受控报告，不假称已经释放。此类已容纳失败正常结束启动分支，后续只做文件级监控、结算和 collect，不逐 tick 重试登记，也不安装失败登记的完成回执。清空旧 id 本身失败或身份/路径拒绝仍保留证据并报错，不能把不可写存储伪报为成功写入 null。

恢复取消沿用持久化的首次 `cancel_requested_at + 10000ms`：未到期只等待剩余宽限，到期可立即升级；重启不赠送新宽限，时钟回退不加速。R8 可因此延迟服务/宿主就绪（正常时钟下剩余宽限最多 10 秒，另需实际组静止与 I/O 完成），不是后台 fire-and-forget。已验证的组控制在 leader 先退出、检查/信号/写入失败后仍保留；后代仍能 I/O 时不能提前结束取消。对账与正常步骤共用逐条目队列和既有 cadence，未完成的对账错误隔离并在后续 tick 重试，其它条目可独立推进；上文已容纳的接管登记/发布失败不重试登记。释放服务先关闭准入，排空已接受的恢复与登记清理工作再放锁；释放后不启动新定时器。

**进程时间证据**：锁与 RunJob 的稳定身份仍是固定 locale/时区的秒级 `ps lstart`（RunJob 为 ISO UTC），不改变 `pid_started_at`、`started_at` 或 R5/R7 比较。R3 的“是否早于提交”是独立的新鲜度观测：Darwin 使用已资格化的 lstart；Linux 的整数 btime/截断 ticks 可使 lstart 与 realtime 提交秒不直接可比，因此使用 `/proc/<pid>/stat` 的启动 ticks、`/proc/uptime` 和括号化 realtime 观测，结合经校验并缓存的 `getconf CLK_TCK` 推导保守出生时间界。原生量化与采样跨度显式入界，不加魔法偏移，不用文件 mtime 代替出生证据。缺失工具、不可读/非法证据、身份变化或过大不确定性均 fail closed；尤其采样跨度使判断跨越提交秒边界时保留记录并报错，不凑整为 lost 或擅自提升 running。真正的进程消失仍走退出文件二次读取规则；Linux 部署除 flock/ps 外还须有上述 proc 文件与 getconf。

**孤儿组残余与 #343 的 PI 决策**：当前快照与秒级 lstart 不是原子的、通用的 PID/进程组代次能力。PI 在 [#343](https://github.com/DankerMu/SHUD-Harness/issues/343) 的 comments 6397949594 / 6399764892 选择安全所有权加明确诊断，并接受仅日志区分：重启前 recorded wrapper 身份已不再存活或匹配时，最终 R7 的 lost/cancelled 不证明历史组静止；不能凭持久化 pid 向裸负 pgid 发信号。退出文件二次读取仍优先，变为 R6 时不告警；本实例若已在 R8 建立并保留组控制，后续 leader 消失也仍受既有组静止与信号规则约束，不误报为未验证、未发信号的孤儿组。

无保留恢复组控制的最终 R7 仅在终态成功发布后、collect 前输出一次带时间戳的 WARN，包含 run_id、记录的 pid/start 身份，并说明历史组静止性未验证、不向未拥有的历史组发信号、后代可能仍活着、cancelled/lost 不是组停止证明；不声称必然存在孤儿或数值 pid 已不存在。操作者从**宿主进程 stderr** 接收该诊断，不是 Web 日志面板或会话唤醒消息。专用 `shud-recovery` Cordis facade 的 exporter 仅转发该实例该 facade 的消息，按显式名称和公开 metadata 的同一个 WeakRef 过滤，随插件释放；不转发其它 facade、插件或既有错误回调的载荷，不加入运行路径、原始异常或文件内容。失败/延迟终态发布不告警，collect 失败、后续 tick 或终态重载不重复。

这是诊断修复，不是孤儿清理能力：RunJob/RunRecord、通知与退出分类不变，不新增持久字段或证据文件。终态发布后、告警前崩溃，stderr 不可用或日志丢失，都可能使区分永久丢失；后续仅凭 RunRecord 不能重建历史组是否静止的证明。人工调查必须重新核实当前进程身份、组成员及控制所有权，不能依据历史 pid/pgid 直接发信号。

原生控制明确区分测试场景：对真实 shell 包装进程先 SIGSTOP 再组 SIGTERM，Linux 保持匹配的 T-state leader，注册表替换可验证 R8 在原始期限 SIGKILL 后组静止且无孤儿告警；Darwin leader 会被 SIGTERM 终止，替换实际走 R7 cancelled，抗 TERM 后代仍活着并产生上述诊断，须由测试的已知所有权显式清理。后者不是 Darwin R8/静止性证据，平台断言不跳过、不用伪 pid/时间或生产 wrapper trap 替代原生行为。同一宿主内的注册表替换证明不等同完整宿主/Web 重启闸；工程验证与本项 PI 语义决策也不等同 Epic #293 / #318 的最终 PI 验收，集中验收仍待完成。

**已裁决、待实现的计时语义**：当前 `started_at` 沿用 lstart，`finished_at` 是结算观测时刻；`wall_seconds` 可能包含起点偏差、退出后未观测延迟或取消宽限，并非精确求解器时长。PI 已在 [#344](https://github.com/DankerMu/SHUD-Harness/issues/344) comment 6397950076 裁决：缺少可信时长证据时记录 null，`finished_at` 保留结算观测语义，在线取消时长包含取消窗口；该决策待 #344 实现。本 #343 切片没有改计时公式或宣称完成真实时长精度测量。

**初始化后的唤醒投递（#313）**：注册表可选注入 `sessionController` 与 `sessions`；缺服务时保持 pending、不消耗尝试，服务撤销后停止使用旧注入 epoch，晚到的恢复结果不能追加消息或计入失败。即使服务已存在，`Service.init` / 启动对账也绝不等待 `resolveAgent`，避免冷会话恢复等待自身插件激活；注入回调只建立可用性，初始化后的既有 cadence 才投递，不新增定时器或完成事件订阅者。

普通逐条目步骤对已收集结果或经校验的收集耗尽终态执行 `resolveAgent` → `createUserMessage`（`source.kind: shud-jobs`）→ `followup` → `sessions.flush`。成功结果消息包含 durable `run_id`、`exit_class` 与产物数；耗尽消息包含受控实际失败原因。确认 flush 成功后才写 `delivered`，随后先写 completed 再移出 active；无 owner 的 SHUD 登记不经 `job/settled` / tool-jobs 再发一份消息。服务可用且条目符合投递条件后，空 owner 或精确的 `session/not-found` 错误码直接标记 `unreachable`，不把其它恢复错误误判为永久不可达。

暂时性恢复、追加或 flush 失败按原失败时间记账，间隔至少 10 秒、上限 3 次；第三次失败与 `unreachable` 原子发布，不进行第四次传输。失败记账写入失败时先重试该次发布，保留原时间/原因，不让 pump cadence 无控制地重发或凭空增加持久次数；若写入实际已提交，服务缺席产生的规范等待提示不能使该记账失效，在运行/owner 身份及次数、时间、状态仍匹配时识别原失败提示或规范等待提示，不重写、不重复计数，也不接受任意变更的提示。确认的追加及成功 flush 回执按 live Session 和完整运行身份保存在进程内：普通注册表重载可继续 flush 或仅补写 delivered，不重复确认过的步骤；实际进程崩溃丢失这些回执，追加与 durable 标记之间的窗口允许重放。这是至少一次语义，不保证 exactly-once；没有新增持久 outbox 或 schema。

协议与验收边界以 [M2 fixture design](../../openspec/changes/m2-run-chain/design.md)、[tasks](../../openspec/changes/m2-run-chain/tasks.md) 为准；实现入口为 [shud-poll.ts](../../packages/dsh-shud-jobs/src/shud-poll.ts)，历史收集诊断的受控校验归 [shud-run-file.ts](../../packages/dsh-shud-jobs/src/shud-run-file.ts) 所有。当前后端验证包含真实原生执行/宿主崩溃与公开会话服务 doubles，工具入口 #314–315 已挂载并经 built/installed 实测；built 完成索引跨工作区读取与 installed headless 活动索引读取的证据分别成立，不等同完整 Web 恢复。完整 Web/PI 验收 #316–318 仍待后续切片，不据此宣称 M2 Epic 完成或 PI 验收。

## 10. 用户体验

前端应清楚显示 task 已 parked，而不是让用户以为 Agent 卡住：

```text
任务已暂停等待运行完成。
当前等待：RUNJOB-001（SHUD ccw tiny 30 days）
最近日志：...
可执行操作：查看日志、取消 job、手动 collect、恢复报告
```

## 11. 验收标准

- [ ] 长任务提交后 LLM loop 停止，TaskCard 进入 parked 状态。
- [ ] 服务重启后可恢复 watcher。
- [ ] collect 可重复执行且不破坏结果。
- [ ] RunRecord 生成后 Coordinator 可从磁盘恢复上下文。
- [ ] 前端能展示 parked 状态、job 状态和可执行操作。
- [ ] 失败 job 不会生成伪成功 EvidenceReport。
- [ ] 浏览器关闭后，RunRecord/report/analysis summary 完成仍能触发 notification。
- [ ] Batch analysis 默认只发送一次 summary notification，不逐 job 打扰 PI。
- [ ] NotificationRecord 有 dedupe_key，服务重启或 retry 不重复发送。
- [ ] notification 失败不回滚 RunRecord 或 EvidenceReport。

## 附录 A. 审查清单（durable JobRegistry / `ctx.jobs` 版）

供 M2 实现与 review 使用；原载 `.agents/skills/shud-gov/reviews/park-resume-audit.md`（Zero SessionDB/AgentLoop 版，2026-10-20 按 ADR-0004 K8 重写）。任何可能导致状态丢失的问题标 critical。

### Job 提交阶段
- [ ] `run-job.json` 与活动索引先落盘，再返回含持久 id 和当前 `dsh_job_id` 的工具结果；`created`/`submitted` 是启动状态，不是排队。
- [ ] 运行目录以 lstat 复核，完整复制输入，只改副本 `END`；失败回滚目录和索引，原输入不变。
- [ ] 无 owner 登记经注册表自身无作用域上下文的瞬时全局控制器完成，`finally` 释放；不改变非 shud owner/作用域准入。
- [ ] `/bin/sh` 包装进程 detached、stdio 落文件；先原子写 `wrapper.pid`，自然退出再原子写 `exit_code`；不经宿主 subprocess 服务。
- [ ] 提交在途集合覆盖 `created` 到 `running` 写出的窗口，轮询不误判 `lost`。

### Collect 阶段
- [ ] 退出码 0/10/12/13/19/20/其它及 `cancelled`/`lost` 映射正确，只有 `ok` 对应成功。
- [ ] 同一 RunRecord 重复 collect 原样返回、mtime 不变；schema 校验前不发布结果。
- [ ] 失败写 `collect-error.json`，不伪造 RunRecord；自动重试间隔 10 秒、上限 3 次，耗尽后带失败原因唤醒。
- [ ] 仅记录本次可证的产物与模型 id/来源；数值健康计算与 metrics 留后续里程碑，不伪造结果。

### Resume / 唤醒阶段
- [ ] 从运行目录读取 RunJob/RunRecord 或 collect 失败记录，而非 `ctx.storage` 或上一 turn 的内存。
- [ ] 所有结算共用 `shud-jobs` 消息路径，`followup` 和 flush 成功后才标记 `delivered`；无 owner 作业不依赖 `job/settled`/tool-jobs 通知。
- [ ] 服务就绪由 inject 回调控制，不依赖插件行序；服务缺失保持 `pending`，会话消失或重试耗尽为带原因的 `unreachable`。
- [ ] 至少一次投递允许崩溃窗口重投，消息含 `run_id`；写完成索引先于移出活动索引。

### 并发与取消
- [ ] 不同运行目录允许并行；同一运行目录至多一个 SHUD 进程。只受父类无 owner 桶上限约束，不设 shud 队列。
- [ ] 唯一轮询循环作为注册表 effect 释放；同条目同一时刻至多一个步骤在途；索引修改串行且原子写。
- [ ] kill 先记 `cancel_requested_at` 再 SIGTERM/宽限后 SIGKILL；`exit_code` 已存在时自然退出获胜。
- [ ] teardown 不取消正常后台 SHUD，同步结束本次 dsh 登记但不 collect/唤醒；kill 宽限期 teardown 保留取消意图，交重启对账接续。

### 重启恢复（K8 对账）
- [ ] R1–R12 每行有可判定输入与证据；pid 复用、退出码在探测期间出现、记录已写但状态未置位均有覆盖；不重新 spawn。
- [ ] R3/R5 接管登记立即可用，不等待 tool-jobs；新旧 `dsh_job_id` 可追溯。
- [ ] SIGTERM/SIGKILL 各一用例，断言 CONTEXT.md 的五条可恢复性不变量，不以模型文本或 `job/settled` 代替。

### SHUD 运行时特有
- [ ] stdout/stderr 落到 `runs/<run_id>/`；输入在 scratch workspace 内复制，submodule 不变。
- [ ] `shudBin` 为显式必填绝对可执行路径，不硬编码机器路径；密钥不进记录或日志。
