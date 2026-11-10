# Spec Delta

## Purpose

定义 M5 最小 OAT 敏感性批次的本机阻断闸 `pnpm run shud:sensitivity <scratch-workspace>`：工作区准备、单提示驱动与固定验收 plan、全部取自工作区文件与 canonical session log 的判据（StackLock 一致、汇总表可复算、批外 baseline 重复性）、控制面登记，以及 Epic 收口 PI 验收的边界，使"一次批量运行与汇总表"有可重跑的工程证据，且该证据不冒充 PI 验收或科学结论。

## ADDED Requirements

### Requirement: Sensitivity workspace preparation

`pnpm run shud:sensitivity` SHALL 以显式参数接收 scratch 工作区路径并以之为会话 cwd，SHALL NOT 检查或拒绝位于 `$TMPDIR` 下的路径。前置条件为：工作区参数、绝对路径且可执行的普通文件 `SHUD_BIN`、非空 `DMXAPI_KEY`，以及根 submodule 中存在的 `SHUD/input/ccw` 源输入；任一缺失 SHALL 在复制输入与启动会话之前以 exit 1 失败并在 stderr 指明缺失项，SHALL NOT 跳过、SHALL NOT 以替代路径或默认值回退。工作区已存在 `tasks`、`runs`、`reports`、`stacks`、`provenance`、`analyses` 或 `input/ccw` 中任一路径时 SHALL 失败且不覆盖。准备阶段 SHALL 把 `SHUD/input/ccw` 复制为工作区 `input/ccw`，并记录源目录与副本的逐文件哈希（该记录是「Sensitivity acceptance criteria」判据 12 的起点哈希）；`SHUD/input/ccw` 与根 submodule SHALL NOT 被改动。

#### Scenario: preparation copies ccw into the workspace

- **WHEN** 以空目录为工作区、`SHUD_BIN` 与 `DMXAPI_KEY` 齐全时执行 `pnpm run shud:sensitivity <ws>`
- **THEN** `<ws>/input/ccw` 的逐文件哈希与 `SHUD/input/ccw` 相同，`SHUD/input/ccw` 的 md5 清单与根 submodule 修订在脚本前后不变

#### Scenario: missing prerequisite fails before any session

- **WHEN** 未设 `SHUD_BIN`、未设 `DMXAPI_KEY` 或缺少工作区参数时执行脚本
- **THEN** 脚本 exit 1，stderr 指明缺失项，工作区无 `input/ccw`，`DSH_HOME` 下没有新会话

#### Scenario: occupied workspace is not overwritten

- **WHEN** 工作区已有 `analyses/` 或 `input/ccw`
- **THEN** 脚本退出非零并点名该路径，不修改它，不启动会话

### Requirement: Sensitivity local acceptance script

`pnpm run shud:sensitivity <scratch-workspace>` SHALL 依次：执行「Sensitivity workspace preparation」；以独立 Web profile 安装 bundle（沿 `shud:first-task` 的安装与 HTTP 驱动）；经 HTTP 发送单条提示启动 coordinator 会话，提示 SHALL 给出 `input/ccw` 的绝对路径与固定验收 plan：`end_days: 90`、`threads: 1`，四个 parameter set 依次为 baseline（无改动）、`GEOL_KSATH`×0.5、`GEOL_KSATH`×2、`LC_ROUGH`×2，且 SHALL NOT 给出任何 calib 绝对值或批量提交指令以外的执行捷径；对 `report_submit` 的 `approval/asked` 自动 Allow once，且只对它——该自动允许是工程证据，SHALL NOT 被表述为 PI 验收；等待子会话结束与全部作业终态。

批次结束且宿主停止后，脚本 SHALL 在批外执行一次 baseline 重复运行：把批内 baseline run 的 `input/ccw` 副本（其 `ccw.cfg.para` 已由注册表按 plan 改写，`NUM_OPENMP` 为 plan 的 `threads`，固定验收 plan 为 1）逐字节复制到脚本自有的 scratch 目录，SHALL NOT 再改写其中任何文件，以同一 `SHUD_BIN`、以 plan 的 `threads` 值（固定验收 plan 为 1）设置的 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS` 直接执行求解器。该运行 SHALL NOT 经模型、注册表或 `shud_run`，SHALL NOT 产生 RunJob、RunRecord、TaskCard 链接或会话事件，SHALL NOT 进入报告或汇总表，其参数也 SHALL NOT 由模型决定。最后脚本执行「Sensitivity acceptance criteria」并输出汇总。脚本 SHALL 由三个可独立验证的部分组成：工作区准备（「Sensitivity workspace preparation」）、会话驱动加批外重复运行（本要求）、判据评估器（「Sensitivity acceptance criteria」）；三者之间只经工作区文件、session log 路径与重复运行结果文件传递数据。CI SHALL NOT 运行本脚本。

#### Scenario: full sensitivity batch passes

- **WHEN** 本机以可执行 `SHUD_BIN` 与 `DMXAPI_KEY` 执行 `pnpm run shud:sensitivity <ws>`，模型按固定 plan 完成批次且报告获 Allow once
- **THEN** 脚本 exit 0，汇总列出 `task_id`、`analysis_plan_id`、四个 `run_id` 及其 `parameter_set_id`、共同 `stack_id`、批外重复运行的 rivqdown sha256、`report_id: accepted`

#### Scenario: only the report approval is auto-answered

- **WHEN** 会话中出现 `report_submit` 以外工具的 `approval/asked`
- **THEN** 脚本不对其自动放行，最终判据因额外审批不成立而 exit 1

#### Scenario: repeat run stays out of the batch

- **WHEN** 批外 baseline 重复运行完成
- **THEN** 工作区 `runs/`、`active.json`/`completed.json` 与 session log 均没有该运行的痕迹，sensitivity 卡的 `linked_jobs` 与报告的 `linked_runs` 不变；重复运行的输入与批内 baseline 副本逐字节相同

### Requirement: Sensitivity acceptance criteria

脚本判据 SHALL 全部取自工作区文件与 canonical session log（`approval/asked|decided`、`request/header.data.header`、`tool/result`），SHALL NOT 取自模型文本：

1. `tasks/` 中恰好一个 `type: sensitivity` 的 TaskCard，其 `linked_analyses` 恰好一项；该 `analyses/<analysis_plan_id>.json` 的 parameter_sets 与固定 plan 等价——按（键、倍率、`baseline` 标志）的集合相等，不计 label 与顺序——且其 `end_days` 为 90、`threads` 为 1、`input_dir` 为工作区 `input/ccw` 的 realpath、`project` 为 `ccw`。
2. 每个 parameter set 恰好一个 `collected` 且 RunRecord `status: succeeded` 的 RunJob，其 `analysis_plan_id`/`parameter_set_id` 与该 plan 和 pset 对应，且该 RunJob 在卡片 `linked_jobs` 中；`linked_jobs` 不含这些 RunJob 以外的任何项。
3. 批内全部 RunRecord 的 `stack_id` 相同且非 null（StackLock 一致门），`data_id` 非 null。
4. 每个批内 run 的 `<run_dir>/output/ccw.out/ccw.cfg.calib.bak` 中，被扰动键的值等于源 `input/ccw/ccw.cfg.calib` 中该键的值 `b` 乘以倍率 `m`；`.bak` 中其余在源文件出现的键与源文件值相等；baseline run 的全部此类键与源文件相等。比较 SHALL 在把两侧解析为数值并按 SHUD 写出该文件的 `%g`（6 位有效数字）精度后进行，不做字节比较。
5. 每个批内 run 的 RunRecord `numerical_health` 中 `water_balance_residual`、`cvode_failures`、`negative_state_count` 均非 null，`max_solver_dt` 为 null；`artifacts.metrics_summary` 非 null，指向的 `metrics.json` 为 `status: ok` 且 sha256 与 RunRecord 记录一致。
6. 脚本对保留的 `.dat` 与运行副本输入，以 records 包导出的同一确定性实现独立重算每个批内 run 的 `metrics.json` 与报告的 `reports/<report_id>.sensitivity.json`，结果与工作区中的文件逐字节相同（可复算门）。
7. 批外 baseline 重复运行的输入目录与批内 baseline run 的 `input/ccw` 副本逐文件 sha256 相同，其包装环境 `OMP_NUM_THREADS` 与 `SHUD_RHS_THREADS` 均为 1；求解器退出码为 0，其 `output/ccw.out/ccw.rivqdown.dat` 的 sha256 与批内 baseline run 的相同；批内各 run 的 RunJob `threads` 均为 1。
8. 报告 `accepted`、TaskCard `done`；报告的 `analysis_ids` 恰为该 plan；`reports/<report_id>.md` 含汇总表、确定性覆盖声明与"agent 建议值"标注的逐字文本，以及 `GOVERNANCE_INVARIANTS` 四句的逐字文本。
9. session log 中恰好一次 `approval/asked`，其 `toolName` 为 `report_submit`，对应 `approval/decided.outcome` 为 `allowed-once`，且报告 `decision_history` 的 `approval_ref` 等于该 `callId`；`analysis_create` 与 `shud_run` 没有任何审批记录。
10. coordinator 与 worker 两个 `agentPreset` 的会话 header 各至少一个；`analysis_create` 的 `tool/result` 出现在 coordinator 会话，批内 `shud_run` 的 `tool/result` 只出现在 worker 会话。
11. `SHUD/input/ccw` 的 md5 清单、根 submodule（`SHUD`、`rSHUD`、`AutoSHUD`）修订与 `data/raw` 的 md5 在脚本前后不变。
12. plan 的 `input_digests` 的文件集合等于 analysis-plans「AnalysisPlan record」对该字段规定的集合（`ccw.cfg.calib` 与白名单类别文件），每项 sha256 等于准备阶段记录的工作区 `input/ccw` 同名文件的 sha256；脚本结束时工作区 `input/ccw` 的逐文件 sha256 仍等于准备阶段记录（源副本未被改动）。
13. 每个批内 run 的 `<run_dir>/input/ccw/ccw.cfg.para` 中有效 `NUM_OPENMP` 行的值为 1、有效 `END` 行的值为 90、有效 `DT_YE_IC` 行的值为 1440；该文件相对工作区 `input/ccw/ccw.cfg.para` 只在 `END`、`NUM_OPENMP` 与 `DT_YE_IC` 行（ccw 源文件无 `DT_YE_IC` 时为末尾追加的一行）上不同，其余行逐字节相同。

退出码 SHALL 为：全部判据成立为 0；判据 1 中恰好存在一张 sensitivity 卡与一个链接 plan、但该 plan 与固定 plan 不等价（模型偏离），判据 1 仅因该不等价而不成立，且除判据 1 与 13（运行副本 `END`/`NUM_OPENMP` 取值绑定固定 plan）以外的判据全部成立——含判据 9 与 11——时为 2（INCONCLUSIVE，需重跑，不计回归；判据 13 的失败照常打印但不改变退出码 2）；其余任一判据不成立——含批外重复的 rivqdown sha256 不等、任一 pset 运行失败、没有 sensitivity 卡或没有 plan——以及前置缺失均为 1。exit 1 与 exit 2 SHALL 保留并打印工作区与 session log 路径。INCONCLUSIVE SHALL NOT 用于运行失败、重复性不等或可复算不等。

判据评估器 SHALL 可离线运行：输入为工作区目录、canonical session log 路径、准备阶段的哈希记录与批外重复运行的结果记录（退出码、输入哈希、线程环境、rivqdown sha256），输出为上述退出码与点名失败判据的 stderr；评估器 SHALL NOT 启动宿主、模型会话或求解器，SHALL NOT 写入工作区。

#### Scenario: non-equivalent model plan is inconclusive

- **WHEN** 模型建的 plan 含 `LC_ROUGH`×0.5 而非 `LC_ROUGH`×2，或 `end_days` 不为 90，审批与保存判据均成立
- **THEN** 脚本 exit 2 并标注 INCONCLUSIVE 与偏离的 pset，保留证据

#### Scenario: non-equivalent plan with a governance breach is a failure

- **WHEN** plan 与固定 plan 不等价，且 `data/raw` md5 改变或 session log 含第二次 `approval/asked`
- **THEN** 脚本 exit 1，不归为 INCONCLUSIVE

#### Scenario: missing plan is a failure

- **WHEN** sensitivity 卡的 `linked_analyses` 为空或工作区没有 sensitivity 卡
- **THEN** 脚本 exit 1 并指出缺少 plan 或卡片

#### Scenario: failed parameter set run fails the gate

- **WHEN** `GEOL_KSATH`×2 的 run 收集为 `status: failed`，即使报告因非 baseline 失败 cell 可放行而 accepted
- **THEN** 脚本 exit 1 并点名该 `parameter_set_id` 与 `run_id`

#### Scenario: divergent StackLock fails the gate

- **WHEN** 批内四个 RunRecord 中有一个 `stack_id` 与其余不同
- **THEN** 脚本 exit 1 并列出各 run 的 `stack_id`

#### Scenario: effective calib value mismatch fails the gate

- **WHEN** `LC_ROUGH`×2 的 run 的 `ccw.cfg.calib.bak` 中 `LC_ROUGH` 按 `%g` 精度不等于源值乘 2
- **THEN** 脚本 exit 1 并点名 run、键、期望值与实际值

#### Scenario: missing numerical health fails the gate

- **WHEN** 某个 succeeded 批内 run 的 `water_balance_residual` 为 null，或 `metrics.json` 为 `status: unavailable`，或其 sha256 与 RunRecord 不符
- **THEN** 脚本 exit 1 并点名该 run 与字段

#### Scenario: recomputed summary differs

- **WHEN** 独立重算得到的 `.sensitivity.json` 或任一 `metrics.json` 与工作区文件有任一字节不同
- **THEN** 脚本 exit 1 并点名不一致的文件

#### Scenario: repeat rivqdown mismatch fails

- **WHEN** 批外 baseline 重复运行的 `ccw.rivqdown.dat` sha256 与批内 baseline 不同
- **THEN** 脚本 exit 1（FAIL，不是 INCONCLUSIVE），输出两个 sha256 与两个 `run_id`

#### Scenario: extra approval fails the gate

- **WHEN** session log 含 `analysis_create` 或 `shud_run` 的 `approval/asked`，或 `report_submit` 之外的第二次审批
- **THEN** 脚本 exit 1 并列出多出审批的 `toolName`/`callId`

#### Scenario: missing report wording fails the gate

- **WHEN** 报告 accepted 但 `.md` 缺少覆盖声明、"agent 建议值"标注或任一不变式句子的逐字文本
- **THEN** 脚本 exit 1 并点名缺失文案

#### Scenario: criteria come from evidence, not model text

- **WHEN** 模型文本声称批次全部成功，但 `runs/` 中缺少某个 pset 的 collected RunJob
- **THEN** 脚本 exit 1 并点名缺失的 `parameter_set_id`

#### Scenario: source or raw mutation fails the gate

- **WHEN** 脚本结束时 `SHUD/input/ccw` 某文件 md5 或 `data/raw` md5 与开始时不同
- **THEN** 脚本 exit 1 并点名改变的文件

#### Scenario: plan input digests must match the prepared workspace input

- **WHEN** plan 的 `input_digests` 中 `ccw.cfg.calib` 或某白名单类别文件的 sha256 与准备阶段记录的工作区 `input/ccw` 同名文件不同，或集合缺少/多出文件，或脚本结束时工作区 `input/ccw` 某文件 sha256 已改变
- **THEN** 脚本 exit 1 并点名该文件与两个 sha256

#### Scenario: run copy cfg.para differs only in END, DT_YE_IC and NUM_OPENMP

- **WHEN** 检查四个批内 run 的 `input/ccw/ccw.cfg.para`
- **THEN** 每份的 `NUM_OPENMP` 为 1（源为 8）、`END` 为 90、末尾多一行 `DT_YE_IC` 值 1440，其余行与工作区 `input/ccw/ccw.cfg.para` 逐字节相同；若某份 `NUM_OPENMP` 不为 1 或任一其它行不同，脚本 exit 1 并点名 run 与行

#### Scenario: repeat run input is the baseline copy with the same thread environment

- **WHEN** 批外 baseline 重复运行的输入中任一文件 sha256 与批内 baseline 副本不同，或其 `OMP_NUM_THREADS`/`SHUD_RHS_THREADS` 不为 1
- **THEN** 脚本 exit 1 并点名该文件或环境变量，不比较 rivqdown，不归为 INCONCLUSIVE

#### Scenario: criteria evaluator runs on recorded fixtures without a host

- **WHEN** 以已录制的工作区目录、session log、准备阶段哈希记录与重复运行结果记录夹具（一组全部判据成立、一组仅 plan 不等价、一组仅重复 rivqdown sha256 不等）调用判据评估器，环境中没有 dsh 宿主、`DMXAPI_KEY` 与 `SHUD_BIN`
- **THEN** 评估器分别 exit 0、2、1，不启动宿主、会话或求解器，夹具文件字节不变

### Requirement: Sensitivity gate registration

`shud:sensitivity` SHALL 登记为本机阻断闸：根 `package.json` 提供 `shud:sensitivity` 脚本；`docs/04_IMPLEMENTATION/Testing_Strategy.md` Verification Matrix 与 Enforcement Index 各增加一行（block，本机，CI 不运行，需 SHUD、`SHUD_BIN`、`DMXAPI_KEY` 与显式工作区，通过判据链接「Sensitivity acceptance criteria」且不另写判据清单）；`constraints.yaml` verification 镜像增加该命令，并在"CI cannot run SHUD"本机闸列表中加入 `shud:sensitivity`；`instructions/agents/shared.md` 的 Verification Matrix 增加对应行，经 `pnpm run instructions:render` 同步到 `AGENTS.md`/`CLAUDE.md`；`docs/04_IMPLEMENTATION/Test_Fixtures_And_Command_Matrix.md` 记录 ccw 敏感性夹具（源 `SHUD/input/ccw`、90 天窗口、固定四 pset plan）；`docs/04_IMPLEMENTATION/Phased_Plan.md` M5 节的验收门措辞 SHALL 与「Sensitivity acceptance criteria」一致。

#### Scenario: matrix row present

- **WHEN** 读取 Testing_Strategy 与渲染后的 `CLAUDE.md`
- **THEN** 两者均含 `pnpm run shud:sensitivity <scratch-workspace>` 行，级别为 block（本机，CI 不运行），通过判据指向「Sensitivity acceptance criteria」

#### Scenario: CI does not claim the gate

- **WHEN** 检查 `.github/workflows/` 与 `constraints.yaml`
- **THEN** 没有 CI job 运行 `shud:sensitivity`，`constraints.yaml` 把它列为本机闸

### Requirement: Epic-close PI acceptance for sensitivity

M5 的 PI 功能验收 SHALL 在 Epic 收口时由 PI 在 `dsh --profile shud` 的 Web 内亲自完成一次 sensitivity 任务，并亲自对其报告审批卡作出放行决定；证据（session id、`task_id`、`analysis_plan_id`、各 `run_id`、`report_id`、审批 `callId` 与 `approval/asked|decided` 摘录）SHALL 记入 `docs/Migration_Plan_dsh.md`。按 PI 2026-11-07 的明确决定，验收安排 SHALL 先登记并接受为 [ADR-0015](../../../../../docs/adr/implemented/0015-m5-epic-acceptance.md)，仅授权 M5 #639 子 PR 经完整工程门与审查后合并；流程 accepted SHALL NOT 被表述为功能验收通过。PI 明确功能通过后 SHALL 给该 ADR 追加功能证据链接，#422 SHALL 在同一收口时由 PI 关闭。`shud:sensitivity` 的自动 Allow once、子 PR 合并与工程审查 SHALL NOT 被表述为 PI 验收。验收记录与报告 SHALL 把结果限定为单流域（ccw）、单窗口（90 天）、相对 baseline 的变化，SHALL NOT 含模型改进、校准结论、敏感性指数或排名、机制解释的措辞；参数范围 SHALL 标注为 agent 建议值。

#### Scenario: acceptance recorded separately from engineering evidence

- **WHEN** 阅读 Migration_Plan 的 M5 验收节
- **THEN** PI 亲自操作的会话与脚本自动审批的会话分别记账，PI 会话含报告审批卡的 `approval/decided` 摘录

#### Scenario: engineering green is not acceptance

- **WHEN** 全部子 PR 已合入且 `shud:sensitivity` exit 0，但 PI 尚未完成 Web 验收
- **THEN** M5 Epic、#422 与 #675 不关闭，OpenSpec change 不归档；已 accepted 的流程 ADR 不被当作功能验收通过记录

#### Scenario: process acceptance precedes engineering delivery

- **WHEN** PI 已明确接受仅限 M5 的工程合并流程，子 PR 已完成规定工程验证、Critical Path 审查与 CI
- **THEN** 子 PR 可合并、工程 issue 可关闭；仍须等待 #675 的 PI Web 功能验收才收口 Epic/change，工程判据、运行时审批与科学判断边界不变

#### Scenario: no scientific overclaim in acceptance

- **WHEN** 检索验收决策记录与 Migration_Plan M5 节
- **THEN** 不含把结果表述为模型改进或校准结论、给出敏感性指数或排名，或把 OAT Δ% 表述为单流域单窗口以外普遍结论的句子
