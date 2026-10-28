# Spec Delta

## Purpose
定义 DataProvenance（一次 SHUD 运行所用输入数据的来源记录）的品牌 id、字段契约，以及在 `shud_run` 提交时由运行输入副本确定性生成、写入会话工作区的规则，使每个 RunJob/RunRecord 都能追溯到逐文件的 sha256 与大小，且全程无 LLM 参与。

## ADDED Requirements

### Requirement: Data identifier
系统 SHALL 为每份 DataProvenance 分配 `data_id`，格式为 `DATA-YYYYMMDDTHHMMSS-xxxx`：时间为 UTC、精确到秒，`xxxx` 为 4 位小写十六进制随机数，随机段独立生成，SHALL NOT 要求与同一提交的 `job_id`/`run_id` 共享。schema SHALL 拒绝不符合该格式的 id（包括旧的 `DATA-<UUID>` 与 `DATA-0001`）。新分配的 `data_id` 在会话 cwd 下已存在 `provenance/<data_id>.json` 时 SHALL 重新生成。

#### Scenario: branded data id
- **WHEN** 在 UTC 2026-10-27 08:10:00 提交一次 `shud_run`
- **THEN** 生成的 `data_id` 形如 `DATA-20261027T081000-7d2e`

#### Scenario: legacy data id rejected
- **WHEN** 以 `data_id: "DATA-0f8fad5b-d9cb-469f-a165-70867728950e"` 或 `data_id: "DATA-0001"` 解析 DataProvenance
- **THEN** schema 解析失败并指出 `data_id` 字段

### Requirement: DataProvenance record
DataProvenance SHALL 含且只含：`data_id`（品牌 `DataId`）、`basin`（非空字符串，等于本次运行的 `project`）、`event_window`（`start` 与 `end` 的 schema 类型均为非空字符串或 null；M3 生成器按 design D6 均写 null，不推算窗口）、`sources`（`input_root` 为原始 `input_dir` 的绝对路径；`files` 为 `{path, sha256, size_bytes}` 列表，`path` 为相对于输入副本根的 POSIX 相对路径，`size_bytes` 为非负整数字节数）、`preprocess`（M3 SHALL 为 `null`）、`uncertainty_notes`（M3 SHALL 为 `null`）。原 `sources.terrain`、`sources.mesh`、`sources.forcing`、`sources.observations` 分类 SHALL NOT 出现；未知字段 SHALL 使解析失败。

#### Scenario: valid minimal provenance
- **WHEN** 解析 `basin: "ccw"`、`event_window: {start: null, end: null}`、`preprocess: null`、`uncertainty_notes: null`、`sources.files` 含 `{path: "ccw.sp.mesh", sha256: …, size_bytes: 1024}` 的 DataProvenance
- **THEN** 解析成功

#### Scenario: legacy categories rejected
- **WHEN** 解析 `sources` 含 `terrain` 或 `observations` 键、或 `files` 中某项 `size_bytes` 为 `-1` 的 DataProvenance
- **THEN** schema 解析失败

### Requirement: Provenance generation at submission
每次 `shud_run` 提交 SHALL 在输入复制完成之后、首次写入 `run-job.json` 之前生成一份新的 DataProvenance：遍历运行目录内 `input/<project>/` 副本中的全部普通文件，逐个计算 sha256 与字节数，`files` SHALL 按 POSIX 相对路径排序。同一输入目录的多次提交 SHALL 各自生成新的 `data_id` 与文件。生成 SHALL 确定：相同的副本内容产生相同的 `files` 列表。该过程 SHALL NOT 调用 LLM。

#### Scenario: provenance covers copied input
- **WHEN** 以 `SHUD/input/ccw` 提交 `shud_run`
- **THEN** `provenance/<data_id>.json` 的 `files` 恰好列出运行目录 `input/ccw/` 下每个普通文件一次，各项 `sha256` 与 `size_bytes` 等于对该副本文件独立计算的值，`path` 按字典序排列，`input_root` 为原始 `input_dir` 的绝对路径，`basin` 为 `ccw`

#### Scenario: repeated submission yields new provenance
- **WHEN** 以同一 `input_dir` 连续提交两次 `shud_run`
- **THEN** 产生两个不同的 `data_id` 与两份 `provenance/` 文件，二者 `files` 相同

### Requirement: Provenance persistence and run linkage
DataProvenance SHALL 以同目录临时文件加 rename 原子写入会话 cwd 下的 `provenance/<data_id>.json`，SHALL NOT 经 `ctx.storage` 或 stateDir 索引；`provenance/` 目录与其中文件的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则。本次 `data_id` SHALL 与 `stack_id`、`task_id`（未提供时为 `null`）在同一次原子写入中写进 `run-job.json`，该运行的 RunRecord SHALL 继承同一 `data_id`。生成或写入失败时 `shud_run` SHALL 返回说明原因的工具错误，提交 SHALL 中止并经既有提交回滚移除运行目录与索引条目，SHALL NOT 留下运行目录。读取 SHALL 经 core schema 校验，损坏文件 SHALL 报错且 SHALL NOT 被改写。

#### Scenario: run job references provenance
- **WHEN** `shud_run` 提交成功
- **THEN** `run-job.json` 的 `data_id` 指向会话 cwd 下已存在且通过 schema 校验的 `provenance/<data_id>.json`，collect 后 `run-record.json` 的 `data_id` 相同

#### Scenario: provenance write failure aborts submission
- **WHEN** 会话 cwd 下的 `provenance` 是一个普通文件或符号链接时调用 `shud_run`
- **THEN** 工具返回错误结果，`runs/` 下不留下本次运行目录，活动索引不含本次作业

### Requirement: DataProvenance generated projection
DataProvenance 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/` 并登记进 schema 生成注册表，经 `pnpm run schema:generate` 投影到 `docs/generated/`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 DataProvenance 段 SHALL 与本 spec 一致，并写明处置：id 格式改为品牌格式；`sources` 分类改为 `input_root` + `files`；`event_window` 两端、`preprocess`、`uncertainty_notes` 在 M3 为 `null`。

#### Scenario: drift detected
- **WHEN** 修改 DataProvenance 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出

#### Scenario: projection regenerated
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/` 下的 DataProvenance 投影含 `sources.input_root` 与 `sources.files`，不含 `sources.terrain`
