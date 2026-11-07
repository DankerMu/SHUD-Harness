# Spec Delta

## MODIFIED Requirements

### Requirement: Replay acceptance criteria
脚本判据 SHALL 全部取自工作区文件与 canonical session log（`approval/asked|decided`、`request/header.data.header.tools`、`tool/result`），SHALL NOT 取自模型文本：
- `tasks/<task_id>/task.json` 的 `type: code_change`，`source_base_commit` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`；
- `changes/` 恰一个 `status: approved` 的 CR，`files_changed` ⊆ `{Makefile, src/Model/MD_rhs_core.cpp, src/Model/f.cpp, src/Model/Macros.hpp, src/Model/shud.cpp}` 且同时含 `Makefile` 与 `src/Model/MD_rhs_core.cpp`，`base_commit` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`semantic_level: numerical_implementation`、`risk: high`、`approval_ref` 等于 session log 中一条 `approval/asked.callId`，其 `approval/decided.outcome` 为 `allowed-once`；
- `builds/` 恰两个 BuildRecord：base 记录 `change_id: null`、`patch_sha256: null`、`rhs_openmp: false`；候选记录 `change_id` 为该 CR、`patch_sha256` 等于该 CR 的 `patch_sha256`、`rhs_openmp: true`，且其 `builds/<build_id>/make.stdout.log` 含 `-fopenmp` 字串（候选二进制以 OpenMP 编译链接的直接证据）；两者 `source_commit` 均等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`exit_code: 0`；
- 两个 `collected` RunJob：`threads: 1`、`build_id` 各对应上述两条、RunRecord `status: succeeded`、`project: keliya`、DataProvenance `sources.external_files` 恰 32 项；
- 两个运行副本 `runs/<run_id>/input/keliya/` 中，`keliya.cfg.para` 与准备后的 `input/keliya/keliya.cfg.para` 相比只多出或改写了 `DT_YE_IC` 一行（值 1440，其余行逐字节相同；两个 run 绑定 `build_id` 而不绑定 plan，`NUM_OPENMP` 与 `END` 不改写），其它输入文件与准备后的副本逐字节相同；DataProvenance `sources.files` 的文件集合等于准备后 `input/keliya/` 的文件集合（不含 `PREPARED.json`），其中 `keliya.cfg.para` 的 sha256 等于该运行副本的 sha256，其余文件的 sha256 等于准备后 `input/keliya/` 中同名文件的 sha256；
- 两个 RunRecord 的 `numerical_health.water_balance_residual` 均为 null，其 `artifacts.metrics_summary` 非 null 且 sha256 与 `runs/<run_id>/metrics.json` 一致，该 `metrics.json` 记录的 residual 原因以 `missing_variable:` 开头（keliya 的 `keliya.cfg.para` 中 `DT_YE_SNOW`、`DT_YE_SURF`、`DT_YE_UNSAT`、`DT_YE_GW` 均为 0，不输出储量变量）；`max_solver_dt` 为 null；
- `verifications/` 恰一个 VC，`status: passed`（exit 0 条件），`base_build_id`/`candidate_build_id` 对应；rivqdown bitwise 判定不因 `DT_YE_IC` 写入或 metrics 计算而改变或放宽；
- 报告 `accepted`、TaskCard `done`、`linked_changes`/`linked_verifications` 各一项；报告 `.md` 含 StackLock 两份且 `build_id` 互异、含 CR 与 VC 事实表、四句不变式与 code_change §5 固定句逐字出现；
- 四角色会话 header（`agentPreset` 为 coordinator/coder/worker/reviewer）各至少一个，coordinator 的 `header.tools` 含 `subagent`、`subagent_coder`、`subagent_reviewer`；
- `repos/SHUD` 的 `git rev-parse HEAD` 仍等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`git rev-parse --absolute-git-dir` 等于 `<ws 的 realpath>/repos/SHUD/.git`；根 submodule 修订、`SHUD/.git`（gitlink 文件时为其字节）与 `SHUD/input/ccw` 的 md5 清单不变，`git -C SHUD rev-parse --absolute-git-dir` 所指目录（`.git/modules/SHUD` 或内嵌 `SHUD/.git`）相对脚本开始时无新文件；`data/raw` md5 不变。

#### Scenario: run copy differs from prepared input only by DT_YE_IC
- **WHEN** 回放完成，检查两个运行副本的 `keliya.cfg.para` 与 DataProvenance
- **THEN** 两份副本相对准备后的 `input/keliya/keliya.cfg.para` 只有 `DT_YE_IC` 一行不同，DataProvenance 中该文件的 sha256 等于副本哈希，其余文件哈希等于准备后 `input/keliya/` 中同名文件的哈希；任一其它行或其它文件不同时脚本判定失败并点名该文件，exit 1

#### Scenario: keliya residual is null with a missing-variable reason
- **WHEN** 回放的两个 RunRecord 被收集
- **THEN** 两者 `water_balance_residual` 为 null，`metrics.json` 的 residual 原因以 `missing_variable:` 开头；若 residual 非 null、原因不是 `missing_variable:*` 或 `metrics_summary` 为 null，脚本判定失败，exit 1

#### Scenario: criteria evaluated from evidence only
- **WHEN** 模型文本声称验证通过但 `verifications/` 为空
- **THEN** 脚本判定失败并指出缺少 VC，exit 1

#### Scenario: extra approval is a failure
- **WHEN** session log 含第三次 `approval/asked`
- **THEN** 脚本判定失败并列出多出的 `toolName`/`callId`

#### Scenario: candidate build without -fopenmp evidence fails the gate
- **WHEN** 候选 BuildRecord 为 `rhs_openmp: true`、其余判据均成立，但其 `make.stdout.log` 不含 `-fopenmp`（如 Makefile 改动未把该标志接入编译命令，或编译命令被静默）
- **THEN** 脚本判定失败并指出候选构建缺少 `-fopenmp` 证据及该 `build_id`，exit 1，工作区与 session log 保留

#### Scenario: abbreviated or drifted commit fails the gate
- **WHEN** 任一 BuildRecord 的 `source_commit` 或 TaskCard 的 `source_base_commit` 不等于全 sha `9a422e5eb708df7d2f8b4066a3083a031d679a82`（含仅为短 sha `9a422e5` 的情形）
- **THEN** 脚本判定失败并指出该字段与文件，exit 1

