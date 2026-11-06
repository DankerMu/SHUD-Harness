---
status: frozen
canonical_for: [core-object-schemas, runjob-backend-enum, stacklock-llm]
---

# Canonical Schema Contract (v0.8)

> **本文件是核心对象、M4 VerificationCase / BuildRecord 与 MemoryNote 的权威字段定义。**
> 其他文档（Research_Object_Model、SPEC_v0.8_Final、Execution_Jobs_Runs 等）若与本文件冲突，以本文件为准。
> 进入实现后，Zod schema 必须与此一一对应。

> **Canonical Source 说明：** Support schema（Artifact、ErrorRecord、PiGate、PiGateDecision、NotificationRecord、ReportExport、AnalysisProgressPayload、User、Session、AuditEvent、LockRecord、IdempotencyRecord 等）的权威定义不在本文件，见 [Support_Schema_Contracts.md](Support_Schema_Contracts.md)。本文件的 M4 修订依据 [m4-mvp-2](../../openspec/changes/archive/2026-11-05-m4-mvp-2/design.md)；相关实现与生成投影已随对应子 issue 交付，当前契约见各节的 canonical spec 链接。

> **M2 修订来源：** RunJob（§4）与 RunRecord（§5）已按 OpenSpec [m2-run-chain「Run identifiers / RunJob record / RunRecord record」](../../openspec/specs/run-records/spec.md) tasks 4.1–4.2 与 `packages/dsh-shud-core/src/schemas/run-job.ts`、`packages/dsh-shud-core/src/schemas/run-record.ts` 对齐。该修订不改变其余对象的当前契约。
>
> **M2 计时语义修订（#344，2026-10-25）：** 按 PI [观测证据决策](https://github.com/DankerMu/SHUD-Harness/issues/344#issuecomment-6397950076) 与[可重算观测窗口选择](https://github.com/DankerMu/SHUD-Harness/issues/344#issuecomment-6405181313) 对齐 §4–§5 的时间语义与 canonical schema descriptions；不新增字段、不改变校验形状或改写已提交结果。

---

## 1. TaskCard

M3 品牌标识符修订（#424）的实现源为 `packages/dsh-shud-core/src/schemas/task.ts` 与 `run-identifiers.ts`，依据 [M3 TaskCard 契约](../../openspec/specs/task-cards/spec.md)。本刀仅对齐 TaskCard，不改变其余对象的当前契约。

```yaml
task_id: TASK-20261027T080005-3f9c    # TaskId；UTC 秒 + 4 位小写 hex
type: engineering | science_assist | ops | code_change
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
linked_changes: []                  # ChangeId[]，排序唯一；缺键按 []
linked_verifications: []            # VerificationId[]，排序唯一；缺键按 []
source_base_commit: null            # code_change 必须为 40 位小写 hex，其它类型必须为 null
created_at: 2026-10-27T08:00:05Z
updated_at: 2026-10-27T08:00:05Z
```

**M3 字段处置：**

- `task_id` 保留并收窄为 `TaskId`，格式为 `TASK-YYYYMMDDTHHMMSS-xxxx`；`stack_id`、`data_id` 保留并改为必填可空的 `StackId`、`DataId`，非空时分别使用 `STACK-`、`DATA-` 前缀。缺失不等于 `null`。
- `linked_jobs`、`linked_reports` 保留并收窄为 `JobRecordId[]`、`ReportId[]`，分别使用 `JOB-`、`REPORT-` 前缀；允许空数组。
- 所有上述品牌 id 使用 UTC 秒与 4 位小写十六进制随机段，拒绝旧短 id、UUID 格式、大写 hex 和错误前缀；关联对象不要求共享随机段。`generateRunIdentifiers(now?)` 的 JOB/RUN 同后缀配对保持不变。
- `reviewer`、`type`/`status`/`runtime_phase` 枚举与其余字段保持不变；`theory_bundle_ids` 仍为可选非空字符串数组（数组可为空），`runtime_phase` 仍允许缺省或 `null`。根对象与 `inference_budget` 的未知键仍接受后剥离，不改为严格拒绝。
- 新建卡的 `stack_id`、`data_id` 显式为 `null`；后续提交回填品牌引用。StackLock、DataProvenance、EvidenceReport 的对象对齐与回填流程不在本刀交付。

**M4 扩展：** `linked_changes`、`linked_verifications` 分别为品牌 `CHG-`、`VC-` 数组，码点升序且唯一；M3 文件缺键按 `[]` 解析，不改写原文件。`source_base_commit` 缺键按 `null` 解析；`code_change` 必须为完整的 40 位小写十六进制 commit，其它类型必须为 `null`。建卡时从会话工作区 `repos/SHUD` 的 HEAD 钉定，后续变更、构建与验证均复核，不由模型指定。状态/链接语义见 [M4 task-cards](../../openspec/specs/task-cards/spec.md)。

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
build_id: null                       # BuildId | null；M3 缺键按 null
fingerprint: "sha256:..."            # 排除 stack_id/created_at/fingerprint/llm.response_model 后的规范 JSON SHA-256
created_at: 2026-10-27T08:00:00Z
```

**仓库修订与路径**：三仓库固定为 `SHUD`、`rSHUD`、`AutoSHUD`；每个修订必填非空 `commit`、`branch`，boolean `dirty`、`dirty_paths_truncated`，以及 `dirty_paths` 字符串数组。路径相对仓库 top-level，非空、不得为绝对路径、含 `..` 路径段或 NUL；去重后按 Unicode 码点升序，不依赖 locale 或 UTF-16 单元排序。合法 POSIX 文件名中的空格、tab、换行、反斜杠及 untracked 目录的尾部 `/` 原样保留，不规范化。未截断时 `dirty` 必须等于路径非空；截断时必须 `dirty: true`，允许空路径数组。

`collectRepositoryRevision` 只执行原有四条只读 git 子命令；status 使用 `--porcelain -z --untracked-files=normal --ignore-submodules=none`。路径来自同一次 stdout，只接受完整 NUL 记录，重命名/复制必须完整读到新旧路径两个终止符，且只记新路径。stdout 非空的缓冲溢出返回已完整读取的路径与 `dirty_paths_truncated: true`；非溢出错误或 stdout 为空的溢出仍抛错并保留原始错误。忽略规则沿用 git（`.gitignore`、`.git/info/exclude`、`core.excludesFile` 等），禁用 fsmonitor/optional locks、剔除继承的仓库定位环境变量，不改 index、不新增 git 调用。`commit` 为 HEAD 完整 id；`branch` 为 `refs/heads/<name>` 的 `<name>`，detached HEAD 为 `HEAD`；非分支引用或名为 `HEAD` 的分支拒绝，路径必须是物理仓库根。top-level stdout 仅在末尾存在 LF 记录终止符时移除一个 LF，保留路径自身的尾随空格或换行；仍须与 `realpathSync.native(repoPath)` 相等，拒绝从子目录采集祖先仓库。git 配置的外部 filter 驱动副作用不属于 git 自身只读保证。

status stdout 先按原始字节确定完整 NUL 记录和 R/C 双路径边界，再对保留的新路径严格解码 UTF-8；完整路径含非法 UTF-8 时，以含仓库路径的受控读取错误失败并保留解码异常 cause，不返回替换字符或转义格式。合法字面 U+FFFD 与路径开头 U+FEFF 原样保留。溢出的未完整尾记录先丢弃，即使截在多字节字符中也不解码、不误拒绝完整前缀；前三条 git 命令的解码/错误行为、四次调用与既有缓冲上限不变。

**llm 与指纹**（ADR-0004 K4）：`base_url`、`request_alias` 以及仓库修订（含路径与截断标记）、runtime、harness 都参与指纹；`response_model` 只记录，不自动使 lock 失效。每条 RunRecord 另记模型与来源；不可把 configured 模型 id 冒称为响应体原值。指纹排除根 `stack_id`、`created_at`、`fingerprint` 和 `llm.response_model`；M4 的 `build_id` 为 `null` 或缺键时也排除，非 null 时保留。其余内容按每层键名排序、数组保持顺序、无空白 JSON 的 UTF-8 字节计算 SHA-256，加 `sha256:` 前缀。无 build 时与 M3 指纹逐字节相同，旧 lock 可复用且不改写；不同 build id 改变指纹。键顺序、身份、创建时间、响应模型变化不影响指纹；`base_url` 或 `request_alias` 变化仍为 stack 变更，行为 eval 子集见 [Agent_Behavior_Eval_Spec](../04_IMPLEMENTATION/Agent_Behavior_Eval_Spec.md)。

**M4 构建来源：** `build_id` 为品牌 `BuildId` 或 `null`，缺键按 `null` 解析而不改写旧 lock。有 build 时 `repos.SHUD` 取 BuildRecord 的 `source_commit`、`source_branch` 与 `dirty_paths`，`dirty` 等于路径非空、`dirty_paths_truncated: false`；不再采集配置的 SHUD 仓库，其余两仓库照常采集。构建时的 dirty 列表是观测，不是构建输入；base 的精确输入仅为钉定 commit 的归档，不要求 CR 或 patch；候选的精确输入为同一归档加已批 CR 的 patch。

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
  external_files: []                # {path(绝对), sha256, size_bytes}；M3 缺键按 []
preprocess: null
uncertainty_notes: null
```

**字段契约：** 除 `sources.external_files` 缺键按 `[]` 解析外，上列字段全部必填，根对象、`event_window`、`sources` 与每个文件条目均严格拒绝未知键。`event_window.start` / `end` 各接受非空字符串或 `null`，不解析日期；生成约定两端均为 `null`，不推算事件窗口。`preprocess`、`uncertainty_notes` 仅接受显式 `null`。读取默认值不改写 M3 文件。

**路径与文件：** `input_root` 按运行平台的绝对路径规则校验。`files[].path` 非空，拒绝 POSIX 绝对路径、`..` 路径段与 NUL，保留 Unicode、空白、反斜杠等合法文件名字符；这是词法检查，不访问文件系统。`files` 允许为空，schema 不要求排序或去重；确定性生成时的清单排序属于后续采集流程。

**M3 对齐处置（#431）：** `data_id` 复用 `DataIdSchema`，拒绝旧 `DATA-NNNN`、`DATA-<UUID>` 与大写 hex。删除 `sources.terrain` / `mesh` / `forcing` / `observations` 分类，改为 `input_root` + `files`；删除 `preprocess` 对象及其开放 `params`，不保留兼容分支。旧 `event_window` 数组、无 sha256 的文件条目和已删除字段均拒绝。此刀仅交付 schema/type 与生成文档投影，不交付输入遍历、hash 计算、持久化或提交接线。

**M4 外部 forcing：** `sources.external_files` 条目为 `{path, sha256, size_bytes}`，`path` 必须为规范绝对路径，摘要与非负整数字节数沿用 `files` 约束。生成器在副本清单完成后增量解析必需的 `<project>.tsd.forc`：严格 UTF-8，支持 LF、CRLF 与无末尾换行；首行首 token 为完整非负安全十进制整数，后续首行字段不作日期或科学校验；第二整行去除首尾空白后为目录，保留内部空格；第三行末列必须为 `Filename`，非空数据行列数与表头一致，原始行数在去重前必须等于站点数。零站点仍须有合法目录与表头且无数据行。相对目录从运行 cwd 按物理遍历解析，再以 native realpath 规范化；目录根别名可解析，但随后每个路径型 `Filename` 按 SHUD 的目录 + `/` + 文件名拼接逐组件检查，保留 `..` 遍历语义，拒绝中间或末尾链接、缺失及非普通文件，不作 rSHUD fallback、tilde/环境展开或前导 `/` 覆盖目录。每个规范文件路径分别与物理副本根比较：内部引用由 `files` 覆盖，内部目录越出副本的引用必须计入外部，外部目录引用回副本的文件不得重复；只有所有引用均在副本内或引用集合为空时才为 `[]`。全部引用通过预检后，仅流式哈希被引用的外部普通文件，按实际读取字节计数、规范路径去重及码点升序记录，不扫描外部目录、不复制或修改文件、不新增审批。解析或路径/读取失败均使提交失败，由既有调用方回滚，不能降级为空或部分清单；诊断只含受控阶段与相关路径，不携带原始异常或 manifest 载荷。副本哈希、解析与外部哈希共用逐文件关闭的流生命周期，全部成功前不分配或发布 provenance，已有证据不变；不承诺外部并发修改的快照隔离。此规则也作用于无 build 提交；ccw 的 forcing 位于副本内，keliya 回放引用外部 32 个文件。详见 [M4 provenance 契约](../../openspec/specs/data-provenance/spec.md)。

---

## 4. RunJob

实现源为 `packages/dsh-shud-core/src/schemas/run-job.ts`；以下示例保留 M2 `submitted` 记录形态并列出 M4 扩展字段。除下述三个 M4 字段缺键按 `null` 解析外，所有字段都必填，可空字段必须显式传 `null`。根对象与 `llm`、`notify` 均拒绝未知字段。

```yaml
job_id: JOB-20261022T031500-a1b2
run_id: RUN-20261022T031500-a1b2
task_id: null                       # schema 保持可空；新提交取可选 TaskId，未提供为 null
stack_id: null                      # M2 记录允许 null；M3 新提交为采集/复用的 StackId
data_id: null                       # M2 记录允许 null；M3 新提交为本次生成的 DataId
backend: local_job                 # M2 唯一后端
status: submitted                  # 启动意图已持久化，尚未记录 pid
project: ccw
label: "Run the ccw example"        # 非空单行描述或 null
input_dir: /models/input/ccw        # 原始输入目录绝对路径
run_dir: /workspace/runs/RUN-20261022T031500-a1b2 # 运行目录绝对路径，取代 cwd
command: ["/usr/local/bin/shud", "-o", "output/ccw.out", "ccw"] # 非空 argv 数组
end_days: 30                        # END 覆写正整数，或 null
build_id: null                      # BuildId | null；M2/M3 缺键按 null
threads: null                       # 正整数 | null；缺键按 null，不强制转换
binary_sha256: null                 # 64 位小写 hex | null；非 null iff build_id 非 null
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

**M3 提交关联（#443）：** `shud_run` 使用的注册表 `submitShud` 请求可携带品牌 `task_id`，未提供时写 `null`，显式 `null` 或非法值在文件系统操作前拒绝；本刀不新增工具参数或回写 TaskCard。输入完整复制并完成可选 END 改写后，调用规范 `captureStackLock`，再等待 `generateProvenance` 对运行副本计算文件 hash/字节数；在首次 `created` RunJob 原子写之前，StackLock 与本次 DataProvenance 已持久化。该次写入同时包含 `task_id`、非空 `stack_id`、非空 `data_id`，后续 collect 原样继承；schema 仍允许三者为 `null`，M2 恢复与旧结果不迁移。

**M4 运行绑定：** `build_id`、`threads`、`binary_sha256` 缺键各按 `null` 解析，默认值之后校验 `binary_sha256` 非 null 当且仅当 `build_id` 非 null。`threads` 接受正整数或 null，拒绝 0、负数、小数与字符串；它不是仅允许 1 的 schema，N=1 是回放验证门。有 build 的提交校验 BuildRecord 与二进制摘要，复制二进制到本次运行目录 `bin/shud` 并执行副本；首次 `created` 即记录三字段，collect 原样继承。提供 threads 时设置 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS`；缺省不设置，继承宿主环境。旧 M2/M3 文件读取不改写。

采集来源由注册表必填配置 `stackRepos.{SHUD,rSHUD,AutoSHUD}`（绝对路径）、`hostVersion`、`llm.{base_url,request_alias}` 指定；可选 `sundialsRoot` 为绝对路径。apply 验证这些键与父类配置的严格并集，不采集 Git 或写工作区证据。安装器从自身所在仓库根派生三仓库路径，从 bundle peer 读取 hostVersion，从 bundle 模型行读取 llm；`SUNDIALS_ROOT` 未设置则省略，设置时须为已存在绝对目录。新 lock 的 response_model 与请求相同；指纹匹配时复用原 lock，保留其字节/mtime，不因响应模型变化改写。

提交失败沿既有事务回滚：先证明执行已不能继续 I/O、完成登记清理，再移除自有索引/运行目录及本次返回的 provenance。删除前复核 provenance 普通文件及父目录身份，拒绝链接和外来替换；不扫描认领其它 provenance，从不删除任何 StackLock（包括本次新建或复用的 lock）。清理失败保留既有聚合错误、D7/预留 fail-closed 语义，不宣称全部删除；采集及回滚均纳入关闭前 drain。

**状态机：**

```text
created → submitted → running → succeeded | failed | cancelled → collected
```

`created` 表示输入已复制、记录与活动索引已写；`submitted` 不再表示排队，而是启动意图已持久化、接下来登记并 spawn 的窗口。`running` 必须同时具有非空 `pid` 与 `pid_started_at`，否则 schema 在对应字段报错。时间字段使用 ISO 8601 UTC，未发生时为 `null`。

`started_at` 沿用接受的包装进程 lstart 身份时间，不是精确求解器启动测量；`finished_at` 是终态发布时的结算观测时间，不是进程退出时间，完成/收集重试不推进该端点。持久时间齐全不代表本实例观察过原始执行，恢复或接管也不补发此证明。

**Core 常量：** `MAX_NOTIFY_ATTEMPTS = 3`、`MAX_COLLECT_ATTEMPTS = 3`；`NOTIFY_RETRY_INTERVAL_MS`、`COLLECT_RETRY_INTERVAL_MS`、`KILL_GRACE_PERIOD_MS` 均为 `10_000` 毫秒（10 秒）。`notify.attempts` 记录非负次数，重试调度按这些常量执行。

**相对原文的处置：** `command` 从命令字符串改为 argv 数组；`cwd` 被删除并由 `run_dir` 取代。新增 `run_id`、`project`、`label`、`input_dir`、`run_dir`、`end_days`、`owner_session`、`dsh_job_id`、`dsh_job_ids`、`pid_started_at`、`input_bytes`、`started_at`、`cancel_requested_at`、`exit_code`、`llm` 与 `notify`。M2 不接受 `timed_out`、`local_direct`、`docker_job`、`slurm`、`k8s` 或旧 `backend: local`。

**未排期（GAP-02）：** `timed_out` 及其超时转换、`resources.max_wall_minutes`、`resources.max_memory_mb`、`cost_budget.max_compute_minutes` 仍无生产者；M4 不接收 `resources`、`cost_budget`、旧 `resources.cpu` 与 `cwd`，不增加超时终止。

---

## 5. RunRecord

实现源为 `packages/dsh-shud-core/src/schemas/run-record.ts`。RunRecord 是 collect 后的不可变结果记录；以下示例保留 M2 成功记录形态并列出 M4 扩展字段。除三个 M4 字段缺键按 `null` 解析外，所有字段必填，未测量或未绑定的可空字段显式传 `null`；`numerical_health` 本身必须是对象。

```yaml
run_id: RUN-20261022T031500-a1b2
job_id: JOB-20261022T031500-a1b2
task_id: null                       # schema 保持可空；collect 继承 RunJob 的同名值
stack_id: null                      # M2 null 仍有效；M3 新提交的采集引用原样继承
data_id: null                       # M2 null 仍有效；M3 新提交的 provenance 引用原样继承
build_id: null                      # BuildId | null；collect 原样继承
threads: null                       # 正整数 | null；collect 原样继承
binary_sha256: null                 # 64 位小写 hex | null；非 null iff build_id 非 null
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

**提交来源：** collect 不补采集、不猜测引用；`task_id`、`stack_id`、`data_id` 逐一取所属 RunJob 的值。M3 新提交的 stack/data 非空，task 可空；这不收紧 durable schema，也不改写已有 M2 null-id RunRecord。

**M4 兼容：** `build_id`、`threads`、`binary_sha256` 的类型、缺键默认值与默认值后的 iff 校验同 §4；collect 不重新推断三字段，不改写已有 M2/M3 RunRecord 字节或 mtime。

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
change_ids: []                      # ChangeId[]，去重；M3 缺键按 []
verification_ids: []                # VerificationId[]，去重；M3 缺键按 []
decision_history: []
created_at: "2026-10-27T09:00:00Z"
updated_at: "2026-10-27T09:00:00Z"
```

M3 实现源为 `packages/dsh-shud-core/src/schemas/evidence-report.ts`，依据 [报告契约](../../openspec/specs/evidence-reports/spec.md)，其中已同步 M4 扩展。根对象与嵌套 PiGateDecision 均严格拒绝未知字段；除 `change_ids`、`verification_ids` 缺键按 `[]` 解析外，以上字段全部必填。

- `report_id` 从 `REPORT-NNNN` 改为品牌 `ReportId`；`task_id` 为品牌 `TaskId`。品牌格式为 `<PREFIX>-YYYYMMDDTHHMMSS-xxxx`，UTC 秒与 4 位小写 hex。
- `linked_runs` 改为非空品牌 `RunId[]`，允许重复；新增 `stack_ids: StackId[]`、`data_ids: DataId[]`、`llm_response_models: string[]`，三者均非空且拒绝重复。schema 保留调用方顺序，不排序、不静默去重。后续生成器从关联 RunRecord 取引用并去重，不由 schema 读取运行记录。
- `summary` 为非空字符串；`observations`、`limitations`、`pi_questions` 可为空数组，但元素必须是非空字符串。响应 model 元素也必须非空。不裁剪、不强制转换、不填默认值。
- 新增必填 `decision_history: PiGateDecision[]`，允许空数组；新增必填 `updated_at`。`created_at`/`updated_at` 沿用 TaskCard 非空字符串约定，不做时间格式或先后关系校验。仅 PiGateDecision 的 `decided_at` 要求 ISO 8601 UTC。
- `status` 恰为 `draft | reviewed | awaiting_pi | accepted | revision_requested | rejected | archived`。schema 不强制 history 与状态一致，不校验 history 中 report_id 与外层一致，不检查决策时间顺序或审批权限。
- M4 `change_ids`、`verification_ids` 为品牌 id 的去重数组，允许空数组；生成时按新鲜 TaskCard 的 `linked_changes`、`linked_verifications` 顺序取值，不接受模型指定。M3 报告缺键按 `[]` 解析，文件不改写。字段名固定为 `verification_ids`，不接受 Theory-to-Code 规划中的 `verification_case_ids`。

**状态流转边界**：后续记录/工具层负责 `draft` → `reviewed` → `accepted | revision_requested | rejected`；`awaiting_pi` 在 M3 仅表示审批卡挂起瞬时态，不写入持久报告；`archived` 保留但无 M3 入口。解析成功不等同 PI 审批通过。

**废弃字段/写法**：旧 `REPORT-NNNN`/`RUN-NNNN` 引用与旧状态 `pi_reviewed` 被拒绝；决策记录的字段迁移见下方 PiGateDecision 投影。

---

## 8. ChangeRequest

M4 严格对象，依据 [ChangeRequest record](../../openspec/specs/change-requests/spec.md#requirement-changerequest-record)：

```yaml
change_id: CHG-20261102T093000-4a1f   # 品牌 ChangeId；UTC 秒 + 4 位小写 hex
task_id: TASK-20261102T090000-3f9c
source_path: repos/SHUD
base_commit: 9a422e5eb708df7d2f8b4066a3083a031d679a82
files_changed: [Makefile, src/Model/MD_rhs_core.cpp]
semantic_level: numerical_implementation
semantic_floor: numerical_implementation
floor_categories: [numerical_implementation]
risk: high
patch_path: patches/CHG-20261102T093000-4a1f.patch
patch_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
status: proposed
approval_ref: null
approved_at: null
description: "StrictOMP RHS slice"
created_by: coder
created_at: "2026-11-02T09:30:00Z"
updated_at: "2026-11-02T09:30:00Z"
```

上列为全部字段，未知键拒绝。`source_path` 固定 `repos/SHUD`；`base_commit` 为完整 40 位小写 hex，工具复核其等于卡片 `source_base_commit`。`files_changed` 为非空、唯一、码点升序的相对 POSIX 路径数组，不含父目录穿越与 NUL。`description` 为字符串或 null；`patch_path` 必须与 `change_id` 对应，`patch_sha256` 为 64 位小写 hex。

`semantic_level` 与 `semantic_floor` 采用 [Gating §1](Scientific_Change_Gating_Spec.md#1-semantic-level) 七档顺序，前者不得低于后者；`floor_categories` 非空、唯一、按该顺序升序，最后一项必须等于 `semantic_floor`，包含全部匹配类别而不只保留最大值。`risk` 必须等于级别映射：pure_engineering → low、io_format → medium、其余 → high。

`status` 只接受 proposed/approved；proposed 的 `approval_ref` 与 `approved_at` 必须为 null，approved 则分别为非空字符串与非空 ISO 时间。`approval_ref` 是执行 callId，需与 session log 核对，不是独立的审批证明。被拒 CR 保持 proposed，不产生 rejected 或修订链。读取不修改文件。

M4 原地删除 `interface_impact`、`compat_checks`、`gates`、`patch_bundle`、`theory_bundle_id`、`verification_case_ids`、`pi_gate_required`，旧 `CHG-NNNN` 拒绝；不保留无生产者字段或别名。这是 M4 范围裁剪、非放宽 baseline（design D15）。

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

## 10. VerificationCase

M4 严格对象，字段权威见 [VerificationCase record](../../openspec/specs/verification-cases/spec.md#requirement-verificationcase-record)。全部字段如下：

| 字段 | 类型与约束 |
|---|---|
| `vc_id` / `task_id` / `change_id` | 品牌 `VerificationId` / `TaskId` / `ChangeId`；VC 格式 `VC-YYYYMMDDTHHMMSS-xxxx` |
| `bundle_id` | 非空字符串或 null；M4 生产者恒为 null |
| `case_type` | dimension_check / mass_balance / limiting_case / manufactured_solution / regression / unit_test / tiny_basin / output_semantics |
| `expected_result_source` | analytic / published / pi_provided / baseline_regression / agent_proposed |
| `target_code_targets` | 相对 POSIX 路径数组 |
| `description` / `expected_result` / `pass_criteria` | 非空字符串 |
| `base_run_id` / `candidate_run_id` | 品牌 RunId |
| `base_build_id` / `candidate_build_id` | 品牌 BuildId |
| `artifact_refs` | 恰两项相对 POSIX 路径，对应 base/candidate 实际比较文件 |
| `observed` | `{ compared_path, base_sha256, candidate_sha256 }`；路径相对运行目录，摘要为 SHA256 |
| `status` | not_run / running / passed / failed / inconclusive / waived_by_pi |
| `failure_reason` | 非空字符串或 null |
| `reviewed_by` | 非空字符串 |
| `reviewer_notes` | 至少一条非空字符串 |
| `compatibility_verdict` | compatible / incompatible / unknown |
| `created_at` | 创建时间 |

M4 只生产 regression / baseline_regression / passed 或 failed，拒绝 agent_proposed，不生产其余 schema 保留状态。passed 要求两个摘要相等且 failure_reason 为 null；failed 要求摘要不等且原因非空。缺失、链接或非普通比较文件是工具错误，不生成 failed 判定。`artifact_refs` 写入时必须为实际比较文件；报告校验第 (15) 项再次复核存在性与摘要。

旧 `id` / `verification_case_id` 改为 `vc_id`；旧 `run_job_ids` / `run_record_ids` 收敛为 base/candidate 运行与构建两对引用，不保留 `target_equations` 或无生产者的 bundle 扩展字段。M4 bundle 免除与字段裁剪见 [Verification_Case_Spec 的 M4 实现范围](Verification_Case_Spec.md#m4-实现范围)，不是普遍放宽科学验证门。

## 11. BuildRecord

M4 严格对象，字段权威见 [BuildRecord record](../../openspec/specs/shud-build/spec.md#requirement-buildrecord-record)。全部字段如下：

| 字段 | 类型与约束 |
|---|---|
| `build_id` / `task_id` | 品牌 BuildId / TaskId；BUILD 格式 `BUILD-YYYYMMDDTHHMMSS-xxxx` |
| `change_id` / `patch_sha256` | ChangeId 或 null / 64 位小写 hex 或 null；两者同时非 null |
| `source_path` | 相对 POSIX 路径，M4 固定 repos/SHUD |
| `source_commit` | 40 位小写 hex，等于 TaskCard.source_base_commit |
| `source_branch` | 非空字符串 |
| `dirty_paths` | 排序唯一的相对 POSIX 路径数组，表示构建时工作树观测，不是构建输入 |
| `make_argv` | 非空字符串数组，实际 make argv |
| `sundials_dir` | 绝对路径 |
| `rhs_openmp` | boolean |
| `compiler` | 非空字符串，构建所用 CXX 的 --version 首行 |
| `exit_code` | 恒 0；失败构建不产生 BuildRecord |
| `duration_seconds` | 非负数 |
| `binary_path` / `binary_sha256` | builds/&lt;build_id&gt;/shud / 64 位小写 hex |
| `stdout_path` / `stderr_path` | builds/&lt;build_id&gt;/make.stdout.log / builds/&lt;build_id&gt;/make.stderr.log |
| `created_at` | 创建时间 |

base 构建 `change_id: null`，必须 `dirty_paths: []`、`patch_sha256: null`，精确输入仅为钉定 commit 的归档；候选构建 `change_id` 非 null 时，必须 `dirty_paths` 非空且 `patch_sha256` 非 null，空路径数组即拒绝。仅候选的 patch 摘要须等于已批 CR，其精确输入为同一归档加该 patch；两类构建均不采用工作树或陈旧二进制。构建记录不把 rhs_openmp 为真等同于实际编译带 OpenMP 标志；回放另验 make 回显的 `-fopenmp`。首次发布采用临时目录整体 rename，消费者校验普通可执行文件与 binary_sha256。

---

## Theory-to-Code optional field additions

以下为未激活的 Theory-to-Code 规划，不覆盖上文 M4 严格对象契约；M4 不生产 bundle。TaskCard 与 AnalysisPlan 的后续可选字段保留，ChangeRequest 与 EvidenceReport 不接受旧别名。

```ts
// TaskCard optional additions
theory_bundle_ids?: string[];

// AnalysisPlan additions
requires_theory_bundle_id?: string;
baseline_run_id?: string;
search_preflight_status?: "not_run" | "passed" | "failed";
experiment_ledger_id?: string;

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
