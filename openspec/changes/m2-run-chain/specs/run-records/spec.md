# Spec Delta

## Purpose

定义 RunJob（一次 SHUD 运行作业）与 RunRecord（作业结束后 collect 出的不可变结果记录）的字段契约、id 规范、M2 状态集与退出码类别，使作业持久化、工具与后续 EvidenceReport 共用同一份 Zod 单源。

## ADDED Requirements

### Requirement: Run identifiers
系统 SHALL 为每个 shud 作业在提交时同时分配 `job_id` 与 `run_id`，格式分别为 `JOB-YYYYMMDDTHHMMSS-xxxx` 与 `RUN-YYYYMMDDTHHMMSS-xxxx`：时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数；同一作业的两个 id 共享时间段与随机段。schema SHALL 拒绝不符合该格式的 id（包括旧格式 `JOB-0001`）。新分配的 id SHALL NOT 与仍存在的运行目录或活动索引条目重复，冲突时重新生成。

#### Scenario: paired identifiers
- **WHEN** 在 UTC 2026-10-22 03:15:00 提交一个 shud 作业
- **THEN** 其 `job_id` 形如 `JOB-20261022T031500-a1b2`，`run_id` 为 `RUN-20261022T031500-a1b2`（随机段相同）

#### Scenario: malformed identifier rejected
- **WHEN** 以 `job_id: "JOB-0001"` 或 `run_id: "RUN-20261022T031500-A1B2"`（大写十六进制）解析 RunJob 或 RunRecord
- **THEN** schema 解析失败并指出 id 字段

### Requirement: RunJob record
RunJob SHALL 含以下字段：`job_id`、`run_id`、`task_id`、`stack_id`、`data_id`（三者在 M2 SHALL 允许为 `null`）、`backend`（M2 固定为 `local_job`）、`status`、`project`、`input_dir`（原始输入目录绝对路径）、`run_dir`（运行目录绝对路径）、`command`（实际执行的 argv 数组）、`end_days`（覆写的 `END` 天数或 `null`）、`owner_session`（发起会话 id 或 `null`）、`dsh_job_ids`（历次在 dsh 中登记得到的 JobId 列表）、`pid` 与 `pid_started_at`（包装进程，未启动时为 `null`）、`input_bytes`、`submitted_at`、`started_at`、`finished_at`（ISO 8601 UTC，未发生为 `null`）、`exit_code`（整数或 `null`）、`llm.response_model`、`notify`（`status` ∈ `pending|delivered|unreachable`，`at` 与 `detail` 可空）。`status` SHALL 为 `created|submitted|running|succeeded|failed|cancelled|collected` 之一；M2 SHALL NOT 接受 `timed_out`。

#### Scenario: valid queued job
- **WHEN** 解析一个 `status: submitted`、`pid: null`、`started_at: null`、`task_id: null` 的 RunJob
- **THEN** 解析成功

#### Scenario: timed_out rejected in M2
- **WHEN** 解析 `status: timed_out` 的 RunJob
- **THEN** 解析失败

### Requirement: RunRecord record
RunRecord SHALL 含：`run_id`、`job_id`、`task_id`、`stack_id`、`data_id`（M2 可为 `null`）、`status`（`succeeded|failed`）、`command`、`exit_code`（整数或 `null`）、`exit_class`、`artifacts`（`stdout`、`stderr` 路径，`shud_output` 目录路径，`files` 为 `{path, size_bytes}` 列表，`path` 相对于 `shud_output`）、`numerical_health`（`water_balance_residual`、`cvode_failures`、`negative_state_count`、`max_solver_dt`，M2 均 SHALL 允许为 `null`）、`resources`（`wall_seconds` 数值或 `null`，`peak_memory_mb` 可为 `null`）、`llm.response_model`（非空字符串）、`collected_at`。`exit_class` SHALL 为 `ok|nan|file_io|input|cvode|consistency|other|cancelled|lost` 之一：退出码 0→`ok`、10→`nan`、12→`file_io`、13→`input`、19→`cvode`、20→`consistency`、其他非 0→`other`；作业被取消→`cancelled`（`exit_code` 可为 `null`）；进程已不存在且无退出码文件→`lost`（`exit_code` 为 `null`）。`status` SHALL 仅在 `exit_class` 为 `ok` 时为 `succeeded`。RunRecord SHALL NOT 含任何密钥材料。

#### Scenario: exit code classes
- **WHEN** 分别以退出码 0、10、12、13、19、20、3 生成 RunRecord
- **THEN** `exit_class` 依次为 `ok`、`nan`、`file_io`、`input`、`cvode`、`consistency`、`other`，仅第一条 `status` 为 `succeeded`

#### Scenario: lost process
- **WHEN** 作业的包装进程已不存在且运行目录没有 `exit_code` 文件
- **THEN** RunRecord 的 `exit_code` 为 `null`、`exit_class` 为 `lost`、`status` 为 `failed`

#### Scenario: response model required
- **WHEN** 解析 `llm.response_model` 为空字符串或缺失的 RunRecord
- **THEN** 解析失败

### Requirement: Generated projection
RunJob 与 RunRecord 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/`，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 RunJob/RunRecord 段 SHALL 与本 spec 的 id 规范、M2 状态集与新增字段一致，并注明 `timed_out` 与必填跨对象引用推迟到 M3。

#### Scenario: drift detected
- **WHEN** 修改 RunRecord 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出
