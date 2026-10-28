---
status: frozen
canonical_for: [core-object-schemas, runjob-backend-enum, stacklock-llm]
---

# Canonical Schema Contract (v0.8)

> **本文件是 8 个核心对象 + MemoryNote 的唯一权威字段定义。**
> 其他文档（Research_Object_Model、SPEC_v0.8_Final、Execution_Jobs_Runs 等）若与本文件冲突，以本文件为准。
> 进入实现后，Zod schema 必须与此一一对应。

> **Canonical Source 说明：** Support schema（Artifact、ErrorRecord、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、User、Session、AuditEvent、LockRecord、IdempotencyRecord 等）的权威定义不在本文件，见 [Support_Schema_Contracts.md](Support_Schema_Contracts.md)。本文件仅定义 8 个核心对象 + MemoryNote。

> **M2 修订来源：** RunJob（§4）与 RunRecord（§5）已按 OpenSpec [m2-run-chain「Run identifiers / RunJob record / RunRecord record」](../../openspec/specs/run-records/spec.md) tasks 4.1–4.2 与 `packages/dsh-shud-core/src/schemas/run-job.ts`、`packages/dsh-shud-core/src/schemas/run-record.ts` 对齐。该修订不改变其余对象的当前契约。
>
> **M2 计时语义修订（#344，2026-10-25）：** 按 PI [观测证据决策](https://github.com/DankerMu/SHUD-Harness/issues/344#issuecomment-6397950076) 与[可重算观测窗口选择](https://github.com/DankerMu/SHUD-Harness/issues/344#issuecomment-6405181313) 对齐 §4–§5 的时间语义与 canonical schema descriptions；不新增字段、不改变校验形状或改写已提交结果。

---

## 1. TaskCard

M3 品牌标识符修订（#424）的实现源为 `packages/dsh-shud-core/src/schemas/task.ts` 与 `run-identifiers.ts`，依据 [m3-mvp-1 TaskCard 契约](../../openspec/changes/m3-mvp-1/specs/task-cards/spec.md)。本刀仅对齐 TaskCard，不改变其余对象的当前契约。

```yaml
task_id: TASK-20261027T080005-3f9c    # TaskId；UTC 秒 + 4 位小写 hex
type: engineering | science_assist | ops
status: created | planned | running | parked | reporting | awaiting_pi | done | cancelled | blocked
runtime_phase: null               # 运行时辅助字段，见下方说明
title: "给 SHUD 添加 event flux 诊断输出"
question_or_goal: "在不破坏 rSHUD 旧版读取的前提下，添加 event_flux 可选输出"
created_by: alice                     # 创建者，不可变
current_owner: alice                  # 当前负责人，可转移
reviewer: pi_name                     # PI 或指定审阅者
stack_id: null                      # 必填；StackId | null，建卡时为 null
data_id: null                       # 必填；DataId | null，建卡时为 null
inference_budget:
  mode: cheap | normal | deep
  advisory_usd: 1.00                  # 软监控，超出时状态栏标黄，不自动中断
  advisory_model_calls: 12            # 同上
  reviewer_enabled: false
linked_jobs: []                     # JobRecordId[]，如 JOB-20261027T081000-0123
linked_reports: []                  # ReportId[]，如 REPORT-20261027T090000-5b10
created_at: 2026-10-27T08:00:05Z
updated_at: 2026-10-27T08:00:05Z
```

**M3 字段处置：**

- `task_id` 保留并收窄为 `TaskId`，格式为 `TASK-YYYYMMDDTHHMMSS-xxxx`；`stack_id`、`data_id` 保留并改为必填可空的 `StackId`、`DataId`，非空时分别使用 `STACK-`、`DATA-` 前缀。缺失不等于 `null`。
- `linked_jobs`、`linked_reports` 保留并收窄为 `JobRecordId[]`、`ReportId[]`，分别使用 `JOB-`、`REPORT-` 前缀；允许空数组。
- 所有上述品牌 id 使用 UTC 秒与 4 位小写十六进制随机段，拒绝旧短 id、UUID 格式、大写 hex 和错误前缀；关联对象不要求共享随机段。`generateRunIdentifiers(now?)` 的 JOB/RUN 同后缀配对保持不变。
- `reviewer`、`type`/`status`/`runtime_phase` 枚举与其余字段保持不变；`theory_bundle_ids` 仍为可选非空字符串数组（数组可为空），`runtime_phase` 仍允许缺省或 `null`。根对象与 `inference_budget` 的未知键仍接受后剥离，不改为严格拒绝。
- 新建卡的 `stack_id`、`data_id` 显式为 `null`；后续提交回填品牌引用。StackLock、DataProvenance、EvidenceReport 的对象对齐与回填流程不在本刀交付。

**废弃字段**: 单个 `owner`（歧义）、嵌套 `linked_objects`（过深）。

**runtime_phase 说明**:
TaskCard.status 使用粗粒度状态机管理任务生命周期。执行期间的细粒度阶段通过 `runtime_phase` 辅助字段跟踪，不参与核心状态流转：

| status | runtime_phase（可选值） | 语义 |
|--------|------------------------|------|
| running | `running_local` | 短命令在 sandbox 同步执行 |
| running | `submitted_job` | 已提交 RunJob，LLM loop 仍活跃 |
| parked | `waiting_for_job` | Agent 已暂停，等待外部 job 完成 |
| running | `collecting` | 正在收集日志、输出、指标和 artifact |

`runtime_phase` 仅用于前端展示和调试，不作为状态机转换条件。
其他文档（Park_Resume_Design、Control_Kernel、Execution_Jobs_Runs 等）中出现的
`running_local`、`submitted_job`、`parked_waiting_for_job`、`collecting` 均指 runtime_phase，不是 TaskCard.status。

**blocked 说明**: 当硬限制触发（max_retries、no_progress）或 workspace 损坏时，TaskCard 进入 `blocked`。需要人工检查后手动恢复。

**废弃状态**: `revised`（PI 要求修订时，TaskCard 回到 `planned` 并关联新的 ChangeRequest，不使用独立状态）。

---

## 2. StackLock

```yaml
stack_id: STACK-20261027T080000-3f9a  # 品牌 StackId：STACK-YYYYMMDDTHHMMSS-xxxx，UTC 秒 + 小写 hex
repos:
  SHUD:      { commit: 9b55b0cb9b55b0cb9b55b0cb9b55b0cb9b55b0cb, branch: master, dirty: false, dirty_paths: [], dirty_paths_truncated: false }
  rSHUD:     { commit: d162db3d162db3d162db3d162db3d162db3d162d, branch: master, dirty: false, dirty_paths: [], dirty_paths_truncated: false }
  AutoSHUD:  { commit: 1cbec6f1cbec6f1cbec6f1cbec6f1cbec6f1cbe, branch: master, dirty: false, dirty_paths: [], dirty_paths_truncated: false }
runtime:
  os: "Darwin 24.6.0"                # 非空 string
  sundials_version: null             # 非空 string | null；不可得时明确为 null
  host_version: "0.2.1-rc.2"         # 非空 string；dsh 宿主版本
harness:
  version: "0.9.0"                   # 非空 string
llm:                                 # 恰好三个非空 string（ADR-0004 K4）
  base_url: "https://www.dmxapi.cn"   # 第三方端点必锁
  request_alias: "deepseek-flash-guan" # 请求中发送的 model id
  response_model: "deepseek-flash-guan" # 仅记录、不使 lock 失效；来源由对应 RunRecord 标注
fingerprint: "sha256:..."            # 排除 stack_id/created_at/fingerprint/llm.response_model 后的规范 JSON SHA-256
created_at: 2026-10-27T08:00:00Z
```

**仓库修订与路径**：三仓库固定为 `SHUD`、`rSHUD`、`AutoSHUD`；每个修订必填非空 `commit`、`branch`，boolean `dirty`、`dirty_paths_truncated`，以及 `dirty_paths` 字符串数组。路径相对仓库 top-level，非空、不得为绝对路径、含 `..` 路径段或 NUL；去重后按 Unicode 码点升序，不依赖 locale 或 UTF-16 单元排序。合法 POSIX 文件名中的空格、tab、换行、反斜杠及 untracked 目录的尾部 `/` 原样保留，不规范化。未截断时 `dirty` 必须等于路径非空；截断时必须 `dirty: true`，允许空路径数组。

`collectRepositoryRevision` 只执行原有四条只读 git 子命令；status 使用 `--porcelain -z --untracked-files=normal --ignore-submodules=none`。路径来自同一次 stdout，只接受完整 NUL 记录，重命名/复制必须完整读到新旧路径两个终止符，且只记新路径。stdout 非空的缓冲溢出返回已完整读取的路径与 `dirty_paths_truncated: true`；非溢出错误或 stdout 为空的溢出仍抛错并保留原始错误。忽略规则沿用 git（`.gitignore`、`.git/info/exclude`、`core.excludesFile` 等），禁用 fsmonitor/optional locks、剔除继承的仓库定位环境变量，不改 index、不新增 git 调用。`commit` 为 HEAD 完整 id；`branch` 为 `refs/heads/<name>` 的 `<name>`，detached HEAD 为 `HEAD`；非分支引用或名为 `HEAD` 的分支拒绝，路径必须是物理仓库根。git 配置的外部 filter 驱动副作用不属于 git 自身只读保证。

status stdout 先按原始字节确定完整 NUL 记录和 R/C 双路径边界，再对保留的新路径严格解码 UTF-8；完整路径含非法 UTF-8 时，以含仓库路径的受控读取错误失败并保留解码异常 cause，不返回替换字符或转义格式。合法字面 U+FFFD 与路径开头 U+FEFF 原样保留。溢出的未完整尾记录先丢弃，即使截在多字节字符中也不解码、不误拒绝完整前缀；前三条 git 命令的解码/错误行为、四次调用与既有缓冲上限不变。

**llm 与指纹**（ADR-0004 K4）：`base_url`、`request_alias` 以及仓库修订（含路径与截断标记）、runtime、harness 都参与指纹；`response_model` 只记录，不自动使 lock 失效。每条 RunRecord 另记模型与来源；不可把 configured 模型 id 冒称为响应体原值。指纹恰排除根 `stack_id`、`created_at`、`fingerprint` 和 `llm.response_model`，其余内容按每层键名排序、数组保持顺序、无空白 JSON 的 UTF-8 字节计算 SHA-256，加 `sha256:` 前缀。键顺序、身份、创建时间、响应模型变化不影响指纹；`base_url` 或 `request_alias` 变化仍为 stack 变更，行为 eval 子集见 [Agent_Behavior_Eval_Spec](../04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md)。

**废弃字段**: `runtime.container`（MVP 不强制容器）、`limits`（已移入 RunJob.resources）、`policy_version`（已合并入 harness.version）、`repos.zero`（内核改为 dsh，ADR-0004 K1）、`llm.provider` / `llm.model_id` / `llm.params_digest` / `llm.prompt_pack_digest`（K4 收窄为三字段）。

**M3 对齐处置（#430）**：根对象和所有嵌套对象严格拒绝未知键；`stack_id` 统一复用 `StackIdSchema`，拒绝旧 `STACK-NNNN`、UUID 与大写 hex。repo 新增必填路径及截断标记；llm 收窄为上列三字段并将响应模型排除出指纹。runtime 只保留 `os`、nullable `sundials_version`，新增 `host_version`，删除 `r_version`、`r_packages_lock`、`python_version`、`gcc_version`、`gdal_version`；harness 只保留 `version`，删除 `cli_version`、`prompt_pack`、`skills_version`。已删除字段作为多余字段拒绝，不以 nullable 形式保留。这里只对齐 core schema、修订采集与指纹，不交付 StackLock 文件持久化或提交时采集流程。

---

## 3. DataProvenance

```yaml
data_id: DATA-20261027T081000-7d2e    # 品牌 DataId，UTC 秒 + 4 位小写 hex
basin: ccw                         # 非空；生成时等于本次运行的 project
event_window: { start: null, end: null }
sources:
  input_root: /workspace/input/ccw  # 原始 input_dir 的绝对路径
  files:
    - path: ccw.sp.mesh             # 相对于输入副本根的 POSIX 路径
      sha256: "sha256:mesh"         # schema 只要求非空，不限制摘要语法
      size_bytes: 1024              # 必填非负整数，允许 0
preprocess: null
uncertainty_notes: null
```

**字段契约：** 上列字段全部必填，根对象、`event_window`、`sources` 与每个文件条目均严格拒绝未知键。`event_window.start` / `end` 各接受非空字符串或 `null`，不解析日期；M3 生成约定两端均为 `null`，不推算事件窗口。`preprocess`、`uncertainty_notes` 仅接受显式 `null`。

**路径与文件：** `input_root` 按运行平台的绝对路径规则校验。`files[].path` 非空，拒绝 POSIX 绝对路径、`..` 路径段与 NUL，保留 Unicode、空白、反斜杠等合法文件名字符；这是词法检查，不访问文件系统。`files` 允许为空，schema 不要求排序或去重；确定性生成时的清单排序属于后续采集流程。

**M3 对齐处置（#431）：** `data_id` 复用 `DataIdSchema`，拒绝旧 `DATA-NNNN`、`DATA-<UUID>` 与大写 hex。删除 `sources.terrain` / `mesh` / `forcing` / `observations` 分类，改为 `input_root` + `files`；删除 `preprocess` 对象及其开放 `params`，不保留兼容分支。旧 `event_window` 数组、无 sha256 的文件条目和已删除字段均拒绝。此刀仅交付 schema/type 与生成文档投影，不交付输入遍历、hash 计算、持久化或提交接线。

---

## 4. RunJob

M2 的实现源为 `packages/dsh-shud-core/src/schemas/run-job.ts`；以下示例是可解析的 `submitted` 记录。所有列出的字段都必填，可空字段必须显式传 `null`。根对象与 `llm`、`notify` 均拒绝未知字段。

```yaml
job_id: JOB-20261022T031500-a1b2
run_id: RUN-20261022T031500-a1b2
task_id: null                       # M2 允许 null；M3 绑定 TaskCard
stack_id: null                      # M2 允许 null；非空引用由 job 携带，collect 不回猜
data_id: null                       # M2 允许 null
backend: local_job                 # M2 唯一后端
status: submitted                  # 启动意图已持久化，尚未记录 pid
project: ccw
label: "Run the ccw example"        # 非空单行描述或 null
input_dir: /models/input/ccw        # 原始输入目录绝对路径
run_dir: /workspace/runs/RUN-20261022T031500-a1b2 # 运行目录绝对路径，取代 cwd
command: ["/usr/local/bin/shud", "-o", "output/ccw.out", "ccw"] # 非空 argv 数组
end_days: 30                        # END 覆写正整数，或 null
owner_session: null                 # 发起会话 id，仅用于唤醒投递
dsh_job_id: null                    # 当前宿主登记 id：shud- + 16 位小写十六进制，或 null
dsh_job_ids: []                     # 历次宿主登记 id
pid: null                          # 包装进程正整数 pid，未记录时为 null
pid_started_at: null               # 包装进程启动时间，ISO 8601 UTC
input_bytes: 1024                  # 非负整数字节数
submitted_at: "2026-10-22T03:15:00Z"
started_at: null
finished_at: null
cancel_requested_at: null
exit_code: null                     # 整数或 null
llm:
  response_model: deepseek-chat     # 非空字符串
  response_model_source: response   # response | configured
notify:
  status: pending                   # pending | delivered | unreachable
  attempts: 0                       # 非负整数
  at: null                          # ISO 8601 UTC 或 null
  detail: null                      # 字符串或 null
```

**ID 规范：** `JOB-YYYYMMDDTHHMMSS-xxxx` / `RUN-YYYYMMDDTHHMMSS-xxxx` 取代 `JOB-NNNN` / `RUN-NNNN`；时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制。同一次 `generateRunIdentifiers()` 调用共享时间戳和随机段，分别返回品牌类型 `JobRecordId` / `RunId`。旧格式、大写随机段或将 dsh 登记 id 填入 `job_id` 均被拒绝。运行目录与索引的碰撞检查由提交层负责，不由 schema/id 生成函数访问文件系统。

**状态机：**

```text
created → submitted → running → succeeded | failed | cancelled → collected
```

`created` 表示输入已复制、记录与活动索引已写；`submitted` 不再表示排队，而是启动意图已持久化、接下来登记并 spawn 的窗口。`running` 必须同时具有非空 `pid` 与 `pid_started_at`，否则 schema 在对应字段报错。时间字段使用 ISO 8601 UTC，未发生时为 `null`。

`started_at` 沿用接受的包装进程 lstart 身份时间，不是精确求解器启动测量；`finished_at` 是终态发布时的结算观测时间，不是进程退出时间，完成/收集重试不推进该端点。持久时间齐全不代表本实例观察过原始执行，恢复或接管也不补发此证明。

**Core 常量：** `MAX_NOTIFY_ATTEMPTS = 3`、`MAX_COLLECT_ATTEMPTS = 3`；`NOTIFY_RETRY_INTERVAL_MS`、`COLLECT_RETRY_INTERVAL_MS`、`KILL_GRACE_PERIOD_MS` 均为 `10_000` 毫秒（10 秒）。`notify.attempts` 记录非负次数，重试调度按这些常量执行。

**相对原文的处置：** `command` 从命令字符串改为 argv 数组；`cwd` 被删除并由 `run_dir` 取代。新增 `run_id`、`project`、`label`、`input_dir`、`run_dir`、`end_days`、`owner_session`、`dsh_job_id`、`dsh_job_ids`、`pid_started_at`、`input_bytes`、`started_at`、`cancel_requested_at`、`exit_code`、`llm` 与 `notify`。M2 不接受 `timed_out`、`local_direct`、`docker_job`、`slurm`、`k8s` 或旧 `backend: local`。

**M3（不属于 M2 字段）：** `timed_out` 及其超时转换、`resources.max_wall_minutes`、`resources.max_memory_mb`、`cost_budget.max_compute_minutes` 延后；M2 对 `resources`、`cost_budget`、旧 `resources.cpu` 与 `cwd` 均不接收。

---

## 5. RunRecord

M2 的实现源为 `packages/dsh-shud-core/src/schemas/run-record.ts`。RunRecord 是 collect 后的不可变结果记录；以下为可解析的成功记录。所有字段必填，未测量或未绑定的可空字段显式传 `null`；`numerical_health` 本身必须是对象。

```yaml
run_id: RUN-20261022T031500-a1b2
job_id: JOB-20261022T031500-a1b2
task_id: null                       # M2 可空，M3 收紧
stack_id: null
data_id: null
status: succeeded                  # succeeded | failed；仅 exit_class: ok 成功
command: ["/usr/local/bin/shud", "-o", "output/ccw.out", "ccw"] # argv
exit_code: 0                       # 整数或 null
exit_class: ok
artifacts:
  stdout: /workspace/runs/RUN-20261022T031500-a1b2/stdout.log
  stderr: /workspace/runs/RUN-20261022T031500-a1b2/stderr.log
  shud_output: /workspace/runs/RUN-20261022T031500-a1b2/output/ccw.out
  files:
    - path: flow.dat               # 相对于 shud_output
      size_bytes: 1024             # 必填非负整数字节数
numerical_health:                   # M2 不计算这些指标，四个字段均可为 null
  water_balance_residual: null
  cvode_failures: null
  negative_state_count: null
  max_solver_dt: null
resources:
  wall_seconds: 60                  # 原始实例可重算的非负观测窗口（秒），缺观测为 null
  peak_memory_mb: null              # 非负 MB 数值或 null
llm:
  response_model: deepseek-flash-guan # 必填非空字符串
  response_model_source: configured # response | configured
collected_at: "2026-10-22T03:16:00Z" # ISO 8601 UTC
```

**退出类别：** `classifyRunExit(exitCode, missingOutcome?)` 为唯一映射：`0 → ok`、`10 → nan`、`12 → file_io`、`13 → input`、`19 → cvode`、`20 → consistency`，其它非零整数为 `other`（退出码事实见 [SHUD_IO_Facts](../01_CODEBASE/SHUD_IO_Facts.md#退出码)）。`exit_code: null` 必须明确提供 `cancelled`（取消且无退出码）或 `lost`（进程丢失/从未启动且无退出码），不猜测默认结果。数值退出证据优先于取消意图。schema 拒绝退出码与类别矛盾的记录，并要求 `ok` 对应 `succeeded`，其余八类对应 `failed`。

**时长语义：** 新生成的数值 `resources.wall_seconds` 必须有原始提交实例的匹配启动身份与其成功发布的终态观测，值为 `(Date.parse(finished_at) - Date.parse(started_at)) / 1000`。有效数值退出或本地受控取消达到既有静止条件时可形成观测；丢失执行、非法/不可读退出证据、缺失或不匹配的观测不能授权数值。重启、接管及终态发布后但结果提交前的实例丢失，新结果均为 `null`，即使两端时间都有值；未知端点也为 `null`。两端已知但负区间仍拒绝，不能用 `null` 隐藏错误。该窗口可能包含 lstart 起点偏差、检测延迟及在线取消宽限，不是求解器运行时长、求解器时长上界或固定精度测量。同实例完成/生成重试保留原始端点，包括自动预算耗尽后的手动收集；有效已提交 RunRecord 优先原样返回，历史数值不改写，也不追认证实。

**产物清单：** `artifacts.files` 不是 Artifact 登记对象，不要求非空 `task_id`；`size_bytes` 复用 `ArtifactSchema.size_bytes` 的非负整数约束，但在文件条目中必填。`path` 必须是非空相对路径，拒绝绝对路径、驱动器路径与任一 `..` 路径段（包含反斜杠形式）。这些是词法检查，不证明实际文件或符号链接仍位于 `shud_output` 内；文件系统复核属于 collect。

**数值与来源：** `water_balance_residual` 为数值或 `null`，`cvode_failures` / `negative_state_count` 为非负整数或 `null`，`max_solver_dt` 为非负数值或 `null`。`response` 表示响应体 model 原值；`configured` 表示响应体不可得时记录已配置模型 id，不能冒称响应体值。模型变化不自动失效 lock（K4）。

**密钥边界：** 根对象、产物对象、每个文件条目、数值健康、资源与模型来源对象均拒绝未知键，不接受 credentials、环境变量、headers 或自由 metadata 袋。规定的 argv、路径、模型字符串仍是领域数据，不是任意密钥内容扫描器；生产者不得把密钥放入这些字段。

**相对原文的处置：** 采用 §4 的品牌 ID 格式替换 `RUN-NNNN` / `JOB-NNNN`；`command` 为 argv 数组；新增 `exit_code`、`exit_class`、`artifacts.files`、`llm.response_model_source` 与 `collected_at`，M2 允许三项引用为空。`artifacts.metrics_summary` / `artifacts.plots` 标为 **M3**，M2 不接受这两个字段。旧 `status: success` 与 `metrics: {}` 仍废弃。

---

## 6. AnalysisPlan

```yaml
analysis_id: PLAN-0001                # 格式: PLAN-NNNN
task_id: TASK-0001
mode: sensitivity | calibration | benchmark | comparison
baseline_run: RUN-0001                # 可选，comparison/benchmark 时必填
parameters:
  ksat_multiplier: [0.5, 1.0, 2.0]
  mannings_n_multiplier: [0.7, 1.0, 1.3]
metrics:
  - peak_flow_error
  - peak_timing_error
  - water_balance_residual
holdout:
  enabled: false
  basins: []
  events: []
rules:
  - "Do not present calibration improvement as structural validation."
```

> **实现扩展：** AnalysisPlan 实现 schema 应支持 `parameter_sets` 和 `batch_policy`，详细定义见 [Parameter_Set_And_Analysis_Run_Mapping.md](Parameter_Set_And_Analysis_Run_Mapping.md)。本文件保留最小字段，避免核心对象膨胀。

---

## 7. EvidenceReport

```yaml
report_id: REPORT-20261027T090000-5b10 # 品牌 ReportId，UTC 秒 + 4 位小写 hex
task_id: TASK-20261027T080005-3f9c     # 品牌 TaskId
status: draft
summary: "Two ccw runs provide evidence from distinct stacks and inputs."
observations:
  - "Both runs produced output artifacts."
limitations:
  - "No scientific metrics were collected."
pi_questions:
  - "Should these runs proceed to scientific review?"
linked_runs: [RUN-20261027T083000-b2c3, RUN-20261027T082000-a1b2]
stack_ids: [STACK-20261027T081500-b2c3, STACK-20261027T080000-a1b2]
data_ids: [DATA-20261027T081500-8e3f, DATA-20261027T081000-7d2e]
llm_response_models: [deepseek-flash-guan]
decision_history: []
created_at: "2026-10-27T09:00:00Z"
updated_at: "2026-10-27T09:00:00Z"
```

M3 实现源为 `packages/dsh-shud-core/src/schemas/evidence-report.ts`，依据 [m3-mvp-1 报告契约](../../openspec/changes/m3-mvp-1/specs/evidence-reports/spec.md)。根对象与嵌套 PiGateDecision 均严格拒绝未知字段，以上字段全部必填，不允许省略或 `undefined`。

- `report_id` 从 `REPORT-NNNN` 改为品牌 `ReportId`；`task_id` 为品牌 `TaskId`。品牌格式为 `<PREFIX>-YYYYMMDDTHHMMSS-xxxx`，UTC 秒与 4 位小写 hex。
- `linked_runs` 改为非空品牌 `RunId[]`，允许重复；新增 `stack_ids: StackId[]`、`data_ids: DataId[]`、`llm_response_models: string[]`，三者均非空且拒绝重复。schema 保留调用方顺序，不排序、不静默去重。后续生成器从关联 RunRecord 取引用并去重，不由 schema 读取运行记录。
- `summary` 为非空字符串；`observations`、`limitations`、`pi_questions` 可为空数组，但元素必须是非空字符串。响应 model 元素也必须非空。不裁剪、不强制转换、不填默认值。
- 新增必填 `decision_history: PiGateDecision[]`，允许空数组；新增必填 `updated_at`。`created_at`/`updated_at` 沿用 TaskCard 非空字符串约定，不做时间格式或先后关系校验。仅 PiGateDecision 的 `decided_at` 要求 ISO 8601 UTC。
- `status` 恰为 `draft | reviewed | awaiting_pi | accepted | revision_requested | rejected | archived`。schema 不强制 history 与状态一致，不校验 history 中 report_id 与外层一致，不检查决策时间顺序或审批权限。

**状态流转边界**：后续记录/工具层负责 `draft` → `reviewed` → `accepted | revision_requested | rejected`；`awaiting_pi` 在 M3 仅表示审批卡挂起瞬时态，不写入持久报告；`archived` 保留但无 M3 入口。解析成功不等同 PI 审批通过。

**废弃字段/写法**：旧 `REPORT-NNNN`/`RUN-NNNN` 引用与旧状态 `pi_reviewed` 被拒绝；决策记录的字段迁移见下方 PiGateDecision 投影。

---

## 8. ChangeRequest

```yaml
change_id: CHG-0001                   # 格式: CHG-NNNN
task_id: TASK-0001
risk: low | medium | high
files_changed:
  - "repos/SHUD/src/output.c"
  - "repos/rSHUD/R/read_output.R"
interface_impact:
  output_change: additive | breaking | none
  backward_compatible: true | false
compat_checks:
  old_output_reader: pass | fail | skipped
  tiny_case: pass | fail | skipped
gates:
  needs_pi_approval: true
  reason: "output compatibility changed"
patch_bundle: "artifacts/CHG-0001.patch"   # null 若未生成
```

---

## 9. MemoryNote

```yaml
note_id: NOTE-0001                    # 格式: NOTE-NNNN
type: failure_note | data_note | compatibility_note | pi_decision | playbook_candidate
status: draft | accepted | retired
task_id: TASK-0001
title: "rSHUD old output fails when optional diagnostics assumed"
body: "The rSHUD reader failed because it assumed event_flux.csv exists."
evidence: [RUN-0007, REPORT-0003]     # 关联的 run/report ID
created_by: agent | pi               # 创建者角色
reviewed_by: null                     # PI 审阅后填写
created_at: 2026-04-25T16:00:00Z
```

---

## Theory-to-Code optional field additions

以下字段为 optional，不破坏现有 8 核心对象。high-risk `semantic_level` 触发 Scientific_Change_Gating_Spec。

```ts
// TaskCard optional additions
theory_bundle_ids?: string[];

// ChangeRequest additions
semantic_level?:
  | "pure_engineering"
  | "io_format"
  | "output_semantics"
  | "numerical_implementation"
  | "parameter_default"
  | "physical_equation"
  | "model_assumption";
theory_bundle_id?: string;
verification_case_ids?: string[];
pi_gate_required?: boolean;

// AnalysisPlan additions
requires_theory_bundle_id?: string;
baseline_run_id?: string;
search_preflight_status?: "not_run" | "passed" | "failed";
experiment_ledger_id?: string;

// EvidenceReport additions
theory_bundle_ids?: string[];
verification_case_ids?: string[];
```

---

## Support Schemas for Operational UX

以下 schema 是 v0.8.1 operational UX 支撑对象，不属于 8 个核心对象。它们用于通知、报告导出、批运行进度和 PI decision comment。

> **投影声明（2026-07-02 单源治理）**：本节全部定义（NotificationRecord / ReportExport /
> AnalysisProgressPayload / PiGateDecision / PiDecisionMemoryNote）为**投影副本**——字段事实源 =
> [Support_Schema_Contracts.md](Support_Schema_Contracts.md)（PiDecisionMemoryNote 的权威源为
> [PI_Decision_Comments_Spec.md](PI_Decision_Comments_Spec.md)）。改动先落权威源再同步此处；
> `schema:generate` 上线后本节转为生成物（CANONICAL_CONTRACTS 投影规则）。

### NotificationRecord

```ts
interface NotificationRecord {
  notification_id: string;
  task_id: string;
  job_id?: string;
  run_id?: string;
  analysis_plan_id?: string;
  report_id?: string;

  channel: "email";
  trigger:
    | "runrecord_created"
    | "report_draft_created"
    | "analysis_completed"
    | "critical_failure";

  recipient_email: string;
  subject: string;
  body_preview: string;

  status: "pending" | "sent" | "failed" | "skipped";
  dedupe_key: string;
  attempted_at?: string;
  sent_at?: string;
  error?: string;
}
```

### ReportExport

```ts
interface ReportExport {
  export_id: string;
  report_id: string;
  task_id: string;
  format: "html" | "markdown";
  status_at_export: "draft" | "reviewed" | "awaiting_pi" | "accepted" | "revision_requested" | "rejected" | "archived";
  output_path: string;
  inline_assets: boolean;
  include_logs: boolean;
  created_at: string;
  exported_by: "system" | string;
  included_artifacts: Array<{
    artifact_id: string;
    path: string;
    embedded: boolean | "summary_only";
  }>;
  excluded_artifacts: Array<{
    artifact_id: string;
    reason: string;
  }>;
}
```

### AnalysisProgressPayload

```ts
interface AnalysisProgressPayload {
  analysis_plan_id: string;
  task_id: string;
  total: number;
  queued: number;
  submitted: number;
  running: number;
  collecting: number;
  succeeded: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  blocked: number;
  updated_at: string;
  cells: Array<{
    parameter_set_id: string;
    job_id?: string;
    run_id?: string;
    // 与 ParameterSet.status 派生源对齐，补 submitted/timed_out（对抗审查 A01-5：
    // 缺态会把超时误映射为 failed、已提交误映射为 queued）
    status: "queued" | "submitted" | "running" | "collecting" | "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";
    parameter_changes: Record<string, number | string | boolean>;
    log_artifact_id?: string;
    metrics_artifact_id?: string;
    report_section_ref?: string;
    failure_reason?: string;
    started_at?: string;
    completed_at?: string;
  }>;
}
```

### PiGateDecision

```ts
interface PiGateDecision {
  decision_id: DecisionId; // DEC-YYYYMMDDTHHMMSS-xxxx
  report_id: ReportId; // REPORT-YYYYMMDDTHHMMSS-xxxx
  approval_ref: string; // 本次获准执行的 exec.callId，非空
  outcome: "accepted" | "rejected" | "revision_requested";
  comment: string | null; // accepted 当且仅当为 null，其余为非空字符串
  decided_at: string; // ISO 8601 UTC，Z 后缀
}
```

本段投影自 [Support_Schema_Contracts §6](Support_Schema_Contracts.md#6-pigatedecision)，实现源为 `packages/dsh-shud-core/src/schemas/evidence-report.ts`。严格对象仅含以上六个必填字段，缺字段、未知键与非法 outcome/comment 组合均被拒绝，关系错误定位到 `comment`。

`approval_ref` 是本次执行的 callId，不是 approval id 或审批通过证明；审计经 session log 的 `asked.callId` → `asked.id` → `decided.id` 关联。不记录先前被拒 submit 卡引用。schema 不执行审批或跨记录/状态机校验。

保留并品牌化 `decision_id`，新增 `report_id`/`approval_ref`；`decision`→`outcome`、`created_at`→`decided_at`、`comment?`→必填且仅 accepted 为 null。删除 `gate_id`、`task_id`、`actor_user_id`、`actor_role`、`comment_required`、`next_action`、`evidence_refs`，不保留旧枚举映射或兼容字段。

### MemoryNote(type=pi_decision)

```ts
interface PiDecisionMemoryNote {
  type: "pi_decision";
  note_id: string;
  task_id: string;
  report_id?: string;
  gate_id: string;
  decision: "approved" | "rejected" | "request_revision";
  comment: string;
  evidence_refs: string[];
  scope: "task" | "report" | "run" | "analysis_plan";
  evidence_level: "pi_confirmed";
  generalization_allowed: false;
  created_by: "pi";
  created_at: string;
}
```

### Operational UX 核心对象扩展字段

在对应核心对象中可增加可选字段：

```ts
// TaskCard 扩展
interface TaskCard {
  notification_recipients?: string[];
  pi_owner_email?: string;
  reviewer_email?: string;
}

// EvidenceReport 扩展
interface EvidenceReport {
  exports?: ReportExport[];
  // decision_history: PiGateDecision[] 已由 §7 定义为必填，不是可选扩展。
}

// AnalysisPlan 扩展
interface AnalysisPlan {
  progress_artifact_id?: string;
  progress_summary?: Pick<AnalysisProgressPayload, "total" | "queued" | "submitted" | "running" | "collecting" | "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked">;
}
```

---

## 附录: 命名决策记录

| 冲突点 | 废弃写法 | Canonical 写法 | 理由 |
|--------|---------|---------------|------|
| RunJob.backend | `local` / `local \| docker \| slurm` | `local_direct \| local_job \| docker_job` | 区分同步/异步执行语义 |
| RunRecord.status | `success` | `succeeded` | 与 RunJob 终态命名一致 |
| TaskCard 所有者 | 单个 `owner` | `created_by` + `current_owner` + `reviewer` | 区分创建者、当前负责人、审阅者三个角色 |
| TaskCard 关联 | 嵌套 `linked_objects: {stacklock, data, jobs, reports}` | 扁平 `stack_id` + `data_id` + `linked_jobs[]` + `linked_reports[]` | 减少嵌套深度 |
| EvidenceReport.status | 仅 `draft` 或旧 4 态 `pi_reviewed` | `draft \| reviewed \| awaiting_pi \| accepted \| revision_requested \| rejected` | 区分 Reviewer 检查与 PI 审阅，增加修订态 |
| StackLock.limits | 在 StackLock 中 | 移入 RunJob.resources | limits 是执行级，不是环境级 |
| TaskCard 执行细节 | `running_local \| submitted_job \| parked_waiting_for_job \| collecting` 作为 TaskCard.status | 下沉至 `TaskCard.runtime_phase`；TaskCard.status 保持 `running \| parked` 粗粒度 | 执行细节属于 RunJob/ParkedState 领域，不应膨胀 TaskCard 状态机 |
| TaskCard.revised | `revised` 作为独立状态 | 废弃；PI 修订时回到 `planned` | 减少状态数，`revised` 语义可由 ChangeRequest 关联表达 |
| TaskCard.blocked | 未在 canonical schema 声明 | 加入 `blocked` | 硬限制和 workspace 损坏需要明确终态 |
