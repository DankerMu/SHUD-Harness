# Spec Delta

## Purpose

定义替换 dsh `jobs-local` 的持久化作业注册表：shud 作业如何落盘、脱离宿主运行、单并发排队、在 dsh 重启（SIGTERM/SIGKILL）后对账、结算时自动生成 RunRecord 并至少一次唤醒发起会话，以及证明这些行为的本机验收脚本与 Epic 收口手工验收。

## ADDED Requirements

### Requirement: Registry replacement
`shud` profile SHALL 只有一个 `ctx.jobs` 实现，由 `@shud-harness/dsh-shud-jobs` 提供并以 id `jobs` 替换 Web 模板的 `jobs-local` 行。对 `kind` 不是 `shud` 的作业，注册表的行为（登记、输出读取、`job_list`/`job_output`/`job_kill`、并发上限、作用域与事件路由、teardown 时取消并等待结算）SHALL 与 `jobs-local` 一致，且 SHALL NOT 跨重启保留；重启后对这些作业 id 的查询仍为 `unknown job`。

#### Scenario: bash background job unchanged
- **WHEN** 模型以 `bash` 的 `run_in_background` 启动 `sleep 1; echo ok`
- **THEN** `job_list` 列出该作业，结束后 `job_output` 返回 `ok`，发起会话按 `tool-jobs` 常规路径被唤醒

#### Scenario: non-shud job not durable
- **WHEN** 一个 `bash` 后台作业运行中 dsh 被重启
- **THEN** 重启后 `job_output` 对该作业 id 报 `unknown job`，不产生运行目录或活动索引条目

### Requirement: Registry configuration
插件行 SHALL 要求配置 `stateDir`（绝对路径，可写目录，不存在时创建）与 `shudBin`（可执行文件绝对路径）；任一缺失、为空、不可写或不可执行时，插件行 SHALL 启动失败并给出指明配置键的错误，SHALL NOT 回退到任何内置默认值。未知配置键 SHALL 使启动失败。

#### Scenario: missing shudBin
- **WHEN** profile 中 `jobs` 行的配置缺少 `shudBin`
- **THEN** `dsh --profile shud --dump-config` 报告该插件行失败且错误含 `shudBin`

### Requirement: Shud job submission
提交 shud 作业时注册表 SHALL：分配 `job_id`/`run_id`；在 `<有效工作目录>/runs/<run_id>/` 建运行目录；把输入目录完整复制到 `input/<project>/`（复制失败则作业以 `failed` 结束、不启动 SHUD）；有 `end_days` 时只在副本的 `<project>.cfg.para` 中改写 `END`；先原子写 `run-job.json`（`status: created`）与活动索引条目，再入队。SHALL NOT 修改原输入目录。作业 SHALL 在 dsh 中以 `kind: shud` 登记，`job_output` SHALL 能读到 `stdout.log` 的增量内容。

#### Scenario: input copied and END patched
- **WHEN** 以 `SHUD/input/ccw` 为输入、`end_days: 30` 提交
- **THEN** `runs/<run_id>/input/ccw/ccw.cfg.para` 的 `END` 为 30，原 `SHUD/input/ccw/ccw.cfg.para` 字节不变，`run-job.json` 存在且 `status` 不早于 `created`

#### Scenario: job output streams log
- **WHEN** 作业运行中模型调用 `job_output`
- **THEN** 返回 `stdout.log` 中自上次读取后新增的内容

### Requirement: Detached execution and exit capture
shud 作业 SHALL 由注册表直接启动的包装进程运行（不经宿主 subprocess 服务），在运行目录内执行 `<shudBin> -o output/<project>.out <project>`，stdout/stderr 分别写入 `stdout.log`/`stderr.log`；SHUD 结束后包装进程 SHALL 以"写临时文件再 rename"的方式写出 `exit_code`。`run-job.json` SHALL 记录包装进程 `pid` 与其启动时间。宿主进程退出 SHALL NOT 终止包装进程或 SHUD。

#### Scenario: exit code file
- **WHEN** 以一个立即 `exit 13` 的伪 `shudBin` 运行作业
- **THEN** 运行目录出现内容为 `13` 的 `exit_code` 文件，且不存在残留的临时文件

#### Scenario: survives host exit
- **WHEN** 作业运行中宿主进程收到 SIGKILL
- **THEN** 包装进程与 SHUD 继续运行，最终写出 `exit_code`

### Requirement: Single-run queue
同一台机器上通过该注册表启动的 shud 作业 SHALL 同时最多一个处于 `running`；其余 SHALL 按提交顺序以 `submitted` 排队，前一个进入终态后自动启动队首。队列 SHALL 由活动索引持久化，dsh 重启后按原顺序继续。

#### Scenario: second run queues
- **WHEN** 一个作业 `running` 时再提交第二个作业
- **THEN** 第二个作业状态为 `submitted`；第一个结束后第二个进入 `running`

#### Scenario: queue survives restart
- **WHEN** 一个作业 `running`、一个 `submitted` 时 dsh 被重启，随后第一个结束
- **THEN** 第二个作业被启动，且提交顺序不变

### Requirement: Cancellation
模型对 shud 作业调用 `job_kill` 时，注册表 SHALL 对运行中的包装进程组发送 SIGTERM，宽限期后仍存活则 SIGKILL，作业状态置 `cancelled` 并照常 collect；对排队中的作业 SHALL 直接出队并置 `cancelled`，不启动 SHUD。

#### Scenario: kill queued job
- **WHEN** 对 `submitted` 状态的作业调用 `job_kill`
- **THEN** 该作业变为 `cancelled`、生成 `exit_class: cancelled` 的 RunRecord，且从未启动 SHUD

### Requirement: Host teardown keeps shud running
宿主 teardown（SIGTERM 等正常退出、owner Agent 被释放）时，注册表 SHALL NOT 终止 shud 包装进程，SHALL 让该次 dsh 登记以终态结算（detail 说明 shud 在后台继续），`run-job.json` 的 `status` SHALL 保持 `running` 或 `submitted`，活动索引条目 SHALL 保留。该结算 SHALL NOT 触发唤醒，也 SHALL NOT 生成 RunRecord。

#### Scenario: graceful restart
- **WHEN** 作业 `running` 时 dsh 收到 SIGTERM 并退出
- **THEN** SHUD 进程仍在运行，`run-job.json` 仍为 `running`，运行目录中没有 `run-record.json`

### Requirement: Startup reconciliation
插件启动时 SHALL 读取活动索引并逐条对账：
- 有 `exit_code` 文件且未 collect → 补结算、collect、唤醒；
- 无 `exit_code`、记录的 pid 存活且进程启动时间与记录一致 → 以新 dsh 登记接管（新 JobId 追加到 `dsh_job_ids`），继续监视至结束；
- 无 `exit_code` 且进程不存在或启动时间不一致 → 作为 `lost` 结算、collect、唤醒；
- `submitted` → 按原顺序重新入队；
- 已 `collected` 但 `notify.status` 为 `pending` → 只补唤醒。
对账 SHALL 在每个条目上幂等，重复执行不产生第二份 RunRecord。

#### Scenario: exited while host down
- **WHEN** 作业在 dsh 停机期间结束并写出 `exit_code` 为 0，随后 dsh 启动
- **THEN** 启动对账生成 `exit_class: ok` 的 RunRecord，发起会话收到一次唤醒

#### Scenario: still running after restart
- **WHEN** dsh 重启时作业仍在运行
- **THEN** `job_list` 列出一个新的 `kind: shud` 登记，其结束后照常 collect 与唤醒

#### Scenario: pid reused
- **WHEN** 记录的 pid 存活但其进程启动时间与记录不一致，且无 `exit_code`
- **THEN** 作业以 `exit_class: lost` 结算

### Requirement: Automatic collect
作业进入 `succeeded`、`failed` 或 `cancelled` 时注册表 SHALL 立即 collect：按 run-records spec 生成 RunRecord 写入 `run-record.json`，作业状态置 `collected`，之后才唤醒。`run-record.json` 已存在时 collect SHALL 返回已有记录而不改写。

#### Scenario: collect is idempotent
- **WHEN** 对同一已 collect 的作业再次 collect
- **THEN** 返回与 `run-record.json` 相同的记录，文件修改时间不变

### Requirement: At-least-once wake
每个由会话发起的 shud 作业 collect 后，注册表 SHALL 确保发起会话至少收到一次含 `run_id`、`exit_class` 与产物数量的完成消息：宿主在线时经常规作业唤醒路径；宿主停机期间结算的作业在对账时冷恢复发起会话、投递消息并持久化会话后，才把 `notify.status` 置 `delivered`。发起会话已不存在或无法恢复时 SHALL 置 `notify.status: unreachable` 并记录原因，SHALL NOT 无限重试；之后该条目从活动索引移除。

#### Scenario: wake after restart
- **WHEN** 作业在 dsh 停机期间结束，dsh 启动后对账完成
- **THEN** 发起会话的 session log 出现一条来源为 `shud-jobs` 的用户消息并开启新一轮，`notify.status` 为 `delivered`

#### Scenario: owner gone
- **WHEN** 发起会话已被删除后对账遇到该作业
- **THEN** `notify.status` 为 `unreachable`，`run-record.json` 存在，下次启动不再尝试唤醒

### Requirement: Restart acceptance script
系统 SHALL 提供本机命令 `pnpm run shud:restart`：在临时 `DSH_HOME` 与临时工作区中，以真实 SHUD 与 ccw 输入依次执行两个用例——作业运行中对 dsh 发送 SIGTERM 后重启、作业运行中对 dsh 发送 SIGKILL 后重启——每个用例 SHALL 判定：重启前后 SHUD 进程连续存活、作业最终产出 RunRecord 且含退出码与非空产物清单、发起会话在 session log 中至少被唤醒一次。判据 SHALL 取自 session log 与运行目录，SHALL NOT 取自模型文本；缺少 SHUD 二进制、dsh 或 `DMXAPI_KEY` 时 SHALL 在开始前非 0 退出。该命令 SHALL 登记进 Verification Matrix（本机，block），运行时不变量"`job/settled` 可恢复、SIGTERM/SIGKILL 均可恢复"的伴生测试 SHALL 进入矩阵，`constraints.yaml` 的对应 review_only 条目 SHALL 移除。

#### Scenario: SIGTERM case
- **WHEN** 执行 `pnpm run shud:restart` 的 SIGTERM 用例
- **THEN** 输出该用例 PASS，运行目录含 `run-record.json`，session log 含重启后的唤醒消息

#### Scenario: missing SHUD binary
- **WHEN** 配置的 SHUD 二进制不存在时执行 `pnpm run shud:restart`
- **THEN** 命令在启动 dsh 前以非 0 退出并指明缺失项

### Requirement: Epic-close manual acceptance
M2 Epic 收口时 PI SHALL 在 `dsh --profile shud` 的 Web 界面亲自完成一次：一句话让 agent 用 `shud_run` 跑 ccw，运行中重启 dsh，完成后会话被唤醒并给出 RunRecord；证据（session log 路径、事件序列摘录、运行目录）记入 `docs/Migration_Plan_dsh.md`。合并子 PR 与关闭实现 issue SHALL NOT 视为该验收通过（`docs/adr/implemented/0007-m2-epic-acceptance.md`）。

#### Scenario: acceptance recorded
- **WHEN** PI 完成该次 Web 验收
- **THEN** `docs/Migration_Plan_dsh.md` 含该会话的 session log 路径、`shud_run` 调用、重启后的唤醒消息与 RunRecord 路径
