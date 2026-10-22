# Spec Delta

## Purpose

定义 RunJob（一次 SHUD 运行作业）与 RunRecord（作业结束后 collect 出的不可变结果记录）的字段契约、id 规范、M2 状态集与退出码类别，使作业持久化、工具与后续 EvidenceReport 共用同一份 Zod 单源。

## ADDED Requirements

### Requirement: Run identifiers
系统 SHALL 为每个 shud 作业在提交时同时分配 `job_id` 与 `run_id`，格式分别为 `JOB-YYYYMMDDTHHMMSS-xxxx` 与 `RUN-YYYYMMDDTHHMMSS-xxxx`：时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数；同一作业的两个 id 共享时间段与随机段。schema SHALL 拒绝不符合该格式的 id（包括旧格式 `JOB-0001`）。新分配的 id SHALL NOT 与仍存在的运行目录、活动索引或完成索引条目重复，冲突时重新生成。dsh 登记 id（`dsh_job_id`，形如 `shud-<16 位十六进制>`）是另一 id 空间，SHALL 只出现在名为 `dsh_job_id`/`dsh_job_ids` 的字段中，SHALL NOT 填入 `job_id`。

#### Scenario: paired identifiers
- **WHEN** 在 UTC 2026-10-22 03:15:00 提交一个 shud 作业
- **THEN** 其 `job_id` 形如 `JOB-20261022T031500-a1b2`，`run_id` 为 `RUN-20261022T031500-a1b2`（随机段相同）

#### Scenario: malformed identifier rejected
- **WHEN** 以 `job_id: "JOB-0001"`、`run_id: "RUN-20261022T031500-A1B2"`（大写十六进制）或 `job_id: "shud-0123456789abcdef"` 解析 RunJob 或 RunRecord
- **THEN** schema 解析失败并指出 id 字段

### Requirement: RunJob record
RunJob SHALL 含以下字段：`job_id`、`run_id`、`task_id`、`stack_id`、`data_id`（三者在 M2 SHALL 允许为 `null`）、`backend`（M2 固定为 `local_job`）、`status`、`project`、`label`（一行描述或 `null`）、`input_dir`（原始输入目录绝对路径）、`run_dir`（运行目录绝对路径）、`command`（实际执行的 argv 数组）、`end_days`（覆写的 `END` 天数或 `null`）、`owner_session`（发起会话 id 或 `null`，只用于唤醒投递）、`dsh_job_id`（当前宿主进程中的 dsh 登记 id 或 `null`）、`dsh_job_ids`（历次在 dsh 中登记得到的 id 列表）、`pid` 与 `pid_started_at`（包装进程，未记录时为 `null`）、`input_bytes`、`submitted_at`、`started_at`、`finished_at`、`cancel_requested_at`（ISO 8601 UTC，未发生为 `null`）、`exit_code`（整数或 `null`）、`llm.response_model`（非空字符串）与 `llm.response_model_source`（`response|configured`）、`notify`（`status` ∈ `pending|delivered|unreachable`，`attempts` 为非负整数，`at` 与 `detail` 可空）。`status` SHALL 为 `created|submitted|running|succeeded|failed|cancelled|collected` 之一，其中 `submitted` 表示启动意图已持久化而 pid 尚未记录；`status` 为 `running` 时 `pid` 与 `pid_started_at` SHALL 非空；M2 SHALL NOT 接受 `timed_out`。唤醒尝试上限、collect 重试上限（各为 3）、collect 与唤醒的重试间隔（10 秒）与 kill 宽限期（10 秒）SHALL 为 core 导出的常量。

#### Scenario: valid starting job
- **WHEN** 解析一个 `status: submitted`、`pid: null`、`started_at: null`、`task_id: null`、`dsh_job_id: null` 的 RunJob
- **THEN** 解析成功

#### Scenario: running requires pid
- **WHEN** 解析 `status: running`、`pid: null` 的 RunJob
- **THEN** 解析失败

#### Scenario: timed_out rejected in M2
- **WHEN** 解析 `status: timed_out` 的 RunJob
- **THEN** 解析失败

#### Scenario: command must be argv
- **WHEN** 解析 `command` 为字符串 `"shud ccw"` 的 RunJob，或含 `cwd` 字段的 RunJob
- **THEN** 解析失败

### Requirement: RunRecord record
RunRecord SHALL 含：`run_id`、`job_id`、`task_id`、`stack_id`、`data_id`（M2 可为 `null`）、`status`（`succeeded|failed`）、`command`（argv 数组）、`exit_code`（整数或 `null`）、`exit_class`、`artifacts`（`stdout`、`stderr` 路径，`shud_output` 目录路径，`files` 为 `{path, size_bytes}` 列表，`path` 相对于 `shud_output`）、`numerical_health`（`water_balance_residual`、`cvode_failures`、`negative_state_count`、`max_solver_dt`，M2 均 SHALL 允许为 `null`）、`resources`（`wall_seconds` 数值或 `null`，`peak_memory_mb` 可为 `null`）、`llm.response_model`（非空字符串）、`llm.response_model_source`（`response|configured`：前者为响应体 model 原值，后者为响应体 model 不可得时记录的已配置模型 id）、`collected_at`。`exit_class` SHALL 为 `ok|nan|file_io|input|cvode|consistency|other|cancelled|lost` 之一：退出码 0→`ok`、10→`nan`、12→`file_io`、13→`input`、19→`cvode`、20→`consistency`、其他非 0→`other`；作业被取消且无退出码文件→`cancelled`（`exit_code` 为 `null`）；进程已不存在（或从未启动）且无退出码文件→`lost`（`exit_code` 为 `null`）。`status` SHALL 仅在 `exit_class` 为 `ok` 时为 `succeeded`。`artifacts.files` 是运行目录内的文件清单，SHALL NOT 视为 `ArtifactSchema` 登记的 Artifact 对象（后者要求非空 `task_id`，M2 不为运行产物创建 Artifact 记录）；其 `size_bytes` 语义 SHALL 与 `ArtifactSchema.size_bytes` 相同（非负整数字节数）。RunRecord SHALL NOT 含任何密钥材料。

#### Scenario: exit code classes
- **WHEN** 分别以退出码 0、10、12、13、19、20、3 生成 RunRecord
- **THEN** `exit_class` 依次为 `ok`、`nan`、`file_io`、`input`、`cvode`、`consistency`、`other`，仅第一条 `status` 为 `succeeded`

#### Scenario: lost process
- **WHEN** 作业的包装进程已不存在且运行目录没有 `exit_code` 文件
- **THEN** RunRecord 的 `exit_code` 为 `null`、`exit_class` 为 `lost`、`status` 为 `failed`

#### Scenario: response model required
- **WHEN** 解析 `llm.response_model` 为空字符串或缺失、或 `llm.response_model_source` 缺失或不在 `response|configured` 中的 RunRecord
- **THEN** 解析失败

#### Scenario: configured model provenance
- **WHEN** 解析 `llm.response_model: "deepseek-flash-guan"`、`llm.response_model_source: configured` 的 RunRecord
- **THEN** 解析成功，记录表明该值不是响应体原值

### Requirement: Generated projection
RunJob 与 RunRecord 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/`，SHALL 登记进 `scripts/schema/registry.ts` 的 schema 定义表（由 `scripts/schema/generate.ts` 入口调用），经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 RunJob/RunRecord 段 SHALL 与本 spec 一致，并逐项写明相对原文的处置：id 格式由 `JOB-NNNN`/`RUN-NNNN` 改为本 spec 格式；RunJob `status` 去掉 `timed_out`（推迟 M3）；`backend` 在 M2 只有 `local_job`；`cwd` 删除、由 `run_dir` 取代；`command` 由字符串改为 argv 数组；`resources.max_memory_mb`、`resources.max_wall_minutes`、`cost_budget.max_compute_minutes` 推迟 M3（标注"M3"）；新增 `project`、`label`、`input_dir`、`run_dir`、`end_days`、`owner_session`、`dsh_job_id`、`dsh_job_ids`、`pid_started_at`、`input_bytes`、`started_at`、`cancel_requested_at`、`exit_code`、`llm`、`notify`；RunRecord `artifacts.metrics_summary` 与 `artifacts.plots` 推迟 M3（标注"M3"），新增 `artifacts.files`、`exit_class`、`llm.response_model_source`、`collected_at`；`task_id`/`stack_id`/`data_id` 在 M2 可空、M3 收紧为必填。

#### Scenario: drift detected
- **WHEN** 修改 RunRecord 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: schemas registered for generation
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下出现 RunJob 与 RunRecord 的 Markdown 与 JSON Schema 投影

### Requirement: Generator refactor preserves existing projections
The generator refactor SHALL preserve every existing generated path and byte, its CLI entrypoints, registry completeness checks, and fail-closed generated-output path checks. The schema definition table SHALL remain independently extensible for subsequent RunJob/RunRecord registration. Every generator module SHALL contain at most 1000 lines, and generator-specific lint/type-safety and large-file exemptions SHALL be removed.

#### Scenario: unchanged schemas retain identical projections
- **WHEN** the eight existing schemas are generated before and after the module split
- **THEN** the complete generated file path and SHA-256 inventories are identical and the existing generator self-test passes

#### Scenario: unsafe paths remain rejected
- **WHEN** the existing self-test attempts generation through a symlink ancestor or supplies an incomplete schema registry
- **THEN** the refactored generator rejects the input before mutating the protected output destination, as before the split
