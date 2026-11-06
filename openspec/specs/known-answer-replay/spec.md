# known-answer-replay Specification

## Purpose
定义已知答案回放（known-answer replay）的工作区准备契约（工作区内 SHUD base 检出与 keliya 输入副本的两项准备期改写）、本机阻断闸 `pnpm run shud:replay <scratch-workspace>` 的驱动与判据、控制面登记，以及 Epic 收口的 PI 验收边界，使 M4 的用户可见步骤有可重跑的工程证据，且该证据不冒充 PI 验收。

## Requirements

### Requirement: Replay workspace preparation
`scripts/runtime/shud-replay-prepare.sh <workspace>` SHALL 在给定 scratch 工作区建立：(1) `repos/SHUD`：以本地对象库 `git clone <本仓库根>/SHUD repos/SHUD` 后 `git checkout --detach 9a422e5eb708df7d2f8b4066a3083a031d679a82`（正文简写 `9a422e5`，脚本与断言一律使用全 sha），脚本断言 `git -C repos/SHUD rev-parse HEAD` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`、`git -C repos/SHUD status --porcelain` 为空，且 `git -C repos/SHUD rev-parse --absolute-git-dir` 等于 `<ws 的 realpath>/repos/SHUD/.git`（证明是独立 clone 而非 worktree 或指向根仓库的 gitlink）；SHALL NOT 使用 `git worktree add`；根 submodule 的 git 目录（`git -C SHUD rev-parse --absolute-git-dir` 的结果：gitlink 布局下为根仓库 `.git/modules/SHUD`，内嵌布局下为 `SHUD/.git`）SHALL NOT 新增任何文件，`SHUD/.git` 为 gitlink 文件时其字节 SHALL 不变，根 submodule 修订与工作树 SHALL 不变；(2) `input/keliya`：复制由 `--keliya <dir>` 或环境变量 `SHUD_REPLAY_KELIYA` 显式给出的 keliya 输入目录（缺省 SHALL 失败，不猜兄弟目录），仅两项改写：`keliya.cfg.para` 的 `NUM_OPENMP` 行改为 `NUM_OPENMP\t1`；`keliya.tsd.forc` 第 2 行改为同一来源下 `forcing.trimmed/` 的绝对路径（该目录 SHALL 存在且含 `keliya.tsd.forc` 表格引用的全部 32 个普通文件，否则失败）。脚本 SHALL 把两项改写前后的 sha256 写入 `input/keliya/PREPARED.json`。`forcing.trimmed/` SHALL NOT 复制。工作区已存在 `repos/SHUD` 或 `input/keliya` 时 SHALL 失败，不覆盖。

#### Scenario: preparation produces the pinned checkout and prepared input
- **WHEN** 对空目录执行准备脚本并给出 keliya 目录
- **THEN** `repos/SHUD` 的 `git rev-parse HEAD` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82` 且干净，`git rev-parse --absolute-git-dir` 等于 `<ws 的 realpath>/repos/SHUD/.git`；`input/keliya/keliya.cfg.para` 含 `NUM_OPENMP\t1`；`keliya.tsd.forc` 第 2 行为 `forcing.trimmed` 的绝对路径；`PREPARED.json` 记录两文件改写前后 sha256；根 submodule `git -C SHUD rev-parse HEAD` 与准备前相同，`git -C SHUD rev-parse --absolute-git-dir` 所指目录下无新文件，`SHUD/.git` 为 gitlink 文件时其字节不变

#### Scenario: missing keliya source fails before any write
- **WHEN** 未给 `--keliya` 且未设 `SHUD_REPLAY_KELIYA`
- **THEN** 脚本退出非零并说明缺少来源，工作区无 `repos/`、`input/`

#### Scenario: existing checkout is not overwritten
- **WHEN** 工作区已有 `repos/SHUD`
- **THEN** 脚本退出非零并指出该路径，不修改它

#### Scenario: Unrepresentable forcing directory fails before writes

- **WHEN** the physical forcing.trimmed directory contains ASCII whitespace, which the pinned SHUD reader's sscanf `%s` conversion cannot preserve
- **THEN** preparation exits nonzero with an actionable path-format diagnostic before creating workspace outputs; quoting, copying forcing, or modifying the solver does not substitute for rejection
- **AND** workspace paths may still contain spaces or resolve through aliases when the physical forcing directory is representable

### Requirement: Replay local acceptance script
`pnpm run shud:replay <scratch-workspace>`（`scripts/runtime/shud-replay.sh` → `shud-replay.ts`）SHALL 以显式工作区参数运行（不检查、不拒绝 `$TMPDIR` 下的路径），前置：非空 `DMXAPI_KEY`、绝对可执行普通文件 `SHUD_BIN`（安装器仍要求）、已存在绝对目录 `SUNDIALS_ROOT`、keliya 来源（`SHUD_REPLAY_KELIYA`）；任一缺失 SHALL 在创建会话前失败。脚本 SHALL 依次：执行「Replay workspace preparation」；以独立 Web profile 安装 bundle（沿 `shud:first-task` 的安装与 HTTP 驱动）；以一句话任务启动 coordinator 会话（任务文本给出 P1e 设计文档路径 `../openMP/docs/p1e/p1e_strict_omp_design.md` 与五文件清单，SHALL NOT 给出上游 diff）；对 `approval/asked` 自动 Allow once（恰两次：`change_submit` 与 `report_submit`），该自动允许是工程证据而非 PI 验收；等待子会话结束与作业终态；最后执行判据并输出汇总。退出码：全部判据成立为 0；VerificationCase `failed` 或任一判据不成立为 1 并保留全部证据（coder 重导出失败是回归证据，SHALL NOT 标为 INCONCLUSIVE）；前置缺失为 1 且不创建会话。CI SHALL NOT 运行本脚本。

#### Scenario: full replay passes
- **WHEN** 在本机以可编译的工具链执行 `pnpm run shud:replay <ws>`，coder 成功重导出切片
- **THEN** 脚本 exit 0，汇总列出 `change_id`、两个 `build_id`、两个 `run_id`、`vc_id: passed`、`report_id: accepted`

#### Scenario: failed verification is a regression
- **WHEN** coder 的实现使候选 rivqdown 与 base 不同
- **THEN** `verifications/` 含 `status: failed` 的 VC，脚本 exit 1，工作区与 session log 保留

#### Scenario: missing prerequisites stop before a session
- **WHEN** 未设 `SUNDIALS_ROOT`
- **THEN** 脚本 exit 1 并说明缺项，`DSH_HOME` 下没有新会话

### Requirement: Replay acceptance criteria
脚本判据 SHALL 全部取自工作区文件与 canonical session log（`approval/asked|decided`、`request/header.data.header.tools`、`tool/result`），SHALL NOT 取自模型文本：
- `tasks/<task_id>/task.json` 的 `type: code_change`，`source_base_commit` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`；
- `changes/` 恰一个 `status: approved` 的 CR，`files_changed` ⊆ `{Makefile, src/Model/MD_rhs_core.cpp, src/Model/f.cpp, src/Model/Macros.hpp, src/Model/shud.cpp}` 且同时含 `Makefile` 与 `src/Model/MD_rhs_core.cpp`，`base_commit` 等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`semantic_level: numerical_implementation`、`risk: high`、`approval_ref` 等于 session log 中一条 `approval/asked.callId`，其 `approval/decided.outcome` 为 `allowed-once`；
- `builds/` 恰两个 BuildRecord：base 记录 `change_id: null`、`patch_sha256: null`、`rhs_openmp: false`；候选记录 `change_id` 为该 CR、`patch_sha256` 等于该 CR 的 `patch_sha256`、`rhs_openmp: true`，且其 `builds/<build_id>/make.stdout.log` 含 `-fopenmp` 字串（候选二进制以 OpenMP 编译链接的直接证据）；两者 `source_commit` 均等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`exit_code: 0`；
- 两个 `collected` RunJob：`threads: 1`、`build_id` 各对应上述两条、RunRecord `status: succeeded`、`project: keliya`、DataProvenance `sources.external_files` 恰 32 项；
- `verifications/` 恰一个 VC，`status: passed`（exit 0 条件），`base_build_id`/`candidate_build_id` 对应；
- 报告 `accepted`、TaskCard `done`、`linked_changes`/`linked_verifications` 各一项；报告 `.md` 含 StackLock 两份且 `build_id` 互异、含 CR 与 VC 事实表、四句不变式与 code_change §5 固定句逐字出现；
- 四角色会话 header（`agentPreset` 为 coordinator/coder/worker/reviewer）各至少一个，coordinator 的 `header.tools` 含 `subagent`、`subagent_coder`、`subagent_reviewer`；
- `repos/SHUD` 的 `git rev-parse HEAD` 仍等于 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`git rev-parse --absolute-git-dir` 等于 `<ws 的 realpath>/repos/SHUD/.git`；根 submodule 修订、`SHUD/.git`（gitlink 文件时为其字节）与 `SHUD/input/ccw` 的 md5 清单不变，`git -C SHUD rev-parse --absolute-git-dir` 所指目录（`.git/modules/SHUD` 或内嵌 `SHUD/.git`）相对脚本开始时无新文件；`data/raw` md5 不变。

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

### Requirement: Replay gate registration
`shud:replay` SHALL 登记为本机阻断闸：`docs/04_IMPLEMENTATION/Testing_Strategy.md` Verification Matrix 增加一行（block，本机，CI 不运行，需 SHUD 工具链、`SUNDIALS_ROOT`、`DMXAPI_KEY`、keliya 来源）；`docs/04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md` 增加 keliya 回放夹具（来源、两项准备期改写、窗口 12053–12143、`forcing.trimmed` 被引用 32 文件）；`docs/04_IMPLEMENTATION/Phased_Plan.md` §4 的验收门措辞 SHALL 与「Replay acceptance criteria」一致；`instructions/agents/shared.md` 的 Verification Matrix 经 `instructions:render` 同步。

#### Scenario: matrix row present
- **WHEN** 读取 Testing_Strategy 与渲染后的 CLAUDE.md
- **THEN** 两者均含 `pnpm run shud:replay <scratch-workspace>` 行及其通过判据

### Requirement: Epic-close PI acceptance for replay
M4 的 PI 功能验收 SHALL 在 Epic 收口时由 PI 在 Web 亲自完成一次回放：至少一次 CR 审批卡操作与一次报告审批卡操作；证据（session id、`change_id`、`build_id`、`run_id`、`vc_id`、`report_id`、审批序号）记入 `docs/Migration_Plan_dsh.md`；验收安排由新的决策记录（沿 ADR-0010 模式，PI 通过后转 implemented）登记。`shud:replay` 的自动 Allow once、子 PR 合并与工程审查 SHALL NOT 被表述为 PI 验收；模型能否重导出切片是本验收的实测项，SHALL NOT 预设结论；bitwise 一致 SHALL NOT 被表述为并行正确性、性能或模型改进结论。

#### Scenario: acceptance recorded separately from engineering evidence
- **WHEN** 阅读 Migration_Plan 的 M4 验收节
- **THEN** PI 亲自操作的会话与脚本自动审批的会话分别记账，且没有"并行正确性已验证"或"性能提升"措辞
