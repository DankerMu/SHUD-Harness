# Spec Delta

## MODIFIED Requirements

### Requirement: Role tool surface restriction
插件 `shud-role-restrict` SHALL 作为全局行挂载，无固定 `role` 配置。在真实 `agent/created` 时按 policy-gate「Caller role derivation」读取当前角色，经该 Agent 的 `agent.ctx.tools.restrict({allow})` 绑定限制；对 coordinator、worker、coder、reviewer 四个已知角色，`allow` SHALL 恰为该角色条目的 `inherited` 集合。`local` 集合 SHALL NOT 传给 restrict：钉版 `tool-subagent` 把委派工具（`subagent`、`subagent_coder`、`subagent_reviewer`）注册在 Agent 自身作用域；`job_*`、`read`、`edit`、`bash` 则从 preset 继承，必须纳入 allow。`inherited` 为空或含未知工具时 SHALL 明确失败，不静默移除不认识的名字或退化为无限制。policy-gate 始终以 `inherited ∪ local` 做执行时 deny；两者共用唯一 role-tool-map。

插件 SHALL 在已提交的 `agent-preset/selected` 会话事件后同步重绑该 Agent 的限制，不以早于投影更新的 `tools/change` 决定角色；成功安装新限制后才释放旧限制。同一角色重复事件不叠加限制；切到 unknown 时释放本插件的旧限制，不影响其它插件的限制；Agent/插件释放时移除自身注册与限制。不得使用 creation header 决定切换后的角色。K13 O3 已证明原 preset apply 时全局 shud 工具尚未注册、原 allow(global) 备选会隐藏 job_*；PI 已授权重开并采用经真实 Web 验证的 inherited/local 设计。

#### Scenario: coordinator sees only its tool surface
- **WHEN** 在 Web 以默认 coordinator preset 开会话并查看模型可见工具
- **THEN** 可见工具集合恰为 `task_create`、`analysis_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`shud_collect`、`subagent`、`subagent_coder`、`subagent_reviewer`、`job_output`、`job_list`、`job_kill`；`shud_run`、`change_create`、`change_submit`、`shud_build`、`verification_run`、`bash`、`read`、`write`、`edit` 与 `list_subagent_models` 不可见

#### Scenario: worker sees only its tool surface
- **WHEN** coordinator 以 preset `worker` 派发子代理，在 Web 查看该子代理会话的模型可见工具
- **THEN** 可见工具集合恰为 `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`subagent`、`analysis_create`、`report_generate`、`change_create`、`shud_build`、`verification_run`、`bash` 不可见

#### Scenario: coder sees only its tool surface
- **WHEN** coordinator 以 `subagent_coder` 派发子代理，在 Web 查看该子代理会话的模型可见工具
- **THEN** 可见工具集合恰为 `bash`、`read`、`edit`、`change_create`、`change_submit`、`shud_build`；`write`、`shud_run`、`shud_collect`、`verification_run`、`job_output`、`job_list`、`job_kill`、`report_generate`、`analysis_create` 与任何委派工具不可见

#### Scenario: reviewer sees only its tool surface
- **WHEN** coordinator 以 `subagent_reviewer` 派发子代理，在 Web 查看该子代理会话的模型可见工具
- **THEN** 可见工具集合恰为 `read`、`verification_run`、`shud_collect`、`job_output`、`job_list`；`job_kill`、`edit`、`write`、`bash`、`shud_run`、`shud_build`、`change_submit`、`analysis_create` 与任何委派工具不可见

#### Scenario: empty or unknown inherited allow fails loudly
- **WHEN** 已知角色的 `inherited` 为空或含未挂载名 `shud.run` 时绑定限制
- **THEN** 返回含 `shud-role-restrict` 与角色或工具名的错误，不静默放宽

#### Scenario: inherited jobs are included and agent-owned subagent is excluded
- **WHEN** 检查 coordinator 经 `agent.ctx` 传给 restrict 的 allow
- **THEN** 它等于 `inherited`，包含三个 job 工具、不含 `subagent`、`subagent_coder`、`subagent_reviewer`；真实模型工具面仍包含这三个委派工具

#### Scenario: blank-session preset switch rebinds the tool surface
- **WHEN** Web 空白会话由 coordinator 切到 worker，再切到 coder，再切回 coordinator
- **THEN** 每次 committed selected 事件后工具面匹配当前角色，旧限制不残留；角色执行门与 TaskCard attribution 使用同一当前投影

#### Scenario: unknown role releases only this plugin restriction
- **WHEN** 已限制的 Agent 切换到 standard 或插件释放
- **THEN** 本插件旧限制与登记被释放，不移除其它来源的工具限制

#### Scenario: failed replacement preserves the owned prior mask
- **WHEN** 已限制的 Agent 切换到已知角色，但新 inherited 列表含未挂载工具，真实 restrict 拒绝
- **THEN** 绑定处理器抛出含插件名与角色/工具名的错误，旧限制尚未释放；不记录新角色已成功绑定，不删除失败项重试，不影响其它来源限制。原始 Cordis emit 可传播该错误；真实会话提交路径的外层 observer 会捕获并记日志，不宣称会话选择被回滚或错误保证可见

#### Scenario: repeated events and separate Agent lifetimes do not leak masks
- **WHEN** 两个 live Agent 分别收到重复同角色事件，随后其中一个释放，再释放插件
- **THEN** 重复事件不叠加本插件限制；第一个 Agent 的清理不改变第二个 Agent 或外部限制；插件释放移除剩余自有登记/限制，后续生命周期事件不再安装本插件限制

### Requirement: Role tool map uses mounted names
`packages/dsh-shud-core/src/governance/role-tool-map.ts` SHALL 为每个角色保留一个条目，含 `{ inherited, local }` 两份实际工具名集合。`inherited` 是 Agent 从全局及 preset 祖先作用域继承、可被 restrict 过滤的工具；`local` 是宿主按 Agent 注册的自有工具。`getRoleToolIds(role)` SHALL 返回这两份集合；`isRoleToolIdAllowed(role, toolId)` SHALL 检查其并集。该条目是 restrict（只取 inherited）与 policy-gate（取并集）的唯一来源。
- coordinator：`inherited` = `task_create`、`analysis_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`local` = `subagent`、`subagent_coder`、`subagent_reviewer`。
- worker：`inherited` = `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`local` 为空。M5 的 plan 绑定参数不改变 `shud_run` 的工具 id，worker 条目不变。
- coder：`inherited` = `bash`、`read`、`edit`、`change_create`、`change_submit`、`shud_build`；`local` 为空。
- reviewer：`inherited` = `read`、`verification_run`、`shud_collect`、`job_output`、`job_list`；`local` 为空。
- `repo_explorer`：`inherited` = `read`，`local` 为空，注明"M4 无 preset、不消费、不经 restrict 校验"；该角色仍推导为 unknown。

`ROLE_TOOL_IDS` SHALL 为全部条目两份集合的并集，SHALL NOT 保留 Zero 时代 id（`shud.run`、`harness.job.submit`、`harness.job.collect`、`harness.report.generate`、`spawn_agent`、`wait_agent`、`harness.memory.propose`、`patch.apply`、`validator.run`、`git.inspect`、`repo.glob`、`repo.grep`、`repo.search` 等任何 `repo.*`）。

#### Scenario: worker sets are the mounted names
- **WHEN** 调用 `getRoleToolIds("worker")`
- **THEN** 返回 `inherited` 为 `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`，`local` 为空

#### Scenario: coordinator sets are the mounted names
- **WHEN** 调用 `getRoleToolIds("coordinator")`
- **THEN** 返回 `inherited` 为七个 coordinator SHUD 工具（`task_create`、`analysis_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`shud_collect`）与三个 job 工具，`local` 恰为 `subagent`、`subagent_coder`、`subagent_reviewer`

#### Scenario: coder and reviewer sets are the mounted names
- **WHEN** 调用 `getRoleToolIds("coder")` 与 `getRoleToolIds("reviewer")`
- **THEN** coder 的 `inherited` 恰为 `bash`、`read`、`edit`、`change_create`、`change_submit`、`shud_build`，reviewer 的 `inherited` 恰为 `read`、`verification_run`、`shud_collect`、`job_output`、`job_list`，两者 `local` 均为空；`isRoleToolIdAllowed("coder", "write")` 与 `isRoleToolIdAllowed("reviewer", "job_kill")` 均为 `false`

#### Scenario: analysis_create belongs to the coordinator only
- **WHEN** 调用 `isRoleToolIdAllowed` 判定 `analysis_create`
- **THEN** 对 `coordinator` 返回 `true`，对 `worker`、`coder`、`reviewer`、`repo_explorer` 均返回 `false`

#### Scenario: legacy ids are rejected
- **WHEN** 调用 `isRoleToolIdAllowed("worker", "shud.run")`、`isRoleToolIdAllowed("coordinator", "spawn_agent")`、`isRoleToolIdAllowed("coder", "harness.memory.propose")`、`isRoleToolIdAllowed("coder", "patch.apply")`、`isRoleToolIdAllowed("reviewer", "validator.run")` 或 `isRoleToolIdAllowed("repo_explorer", "git.inspect")`
- **THEN** 全部返回 `false`

#### Scenario: M4 rows survive unchanged
- **WHEN** 读取 `ROLE_TOOL_MAP` 与 `ROLE_TOOL_IDS`
- **THEN** `ROLE_TOOL_MAP` 含 coordinator、worker、coder、reviewer、repo_explorer 五行，repo_explorer 的 `inherited` 恰为 `read`、`local` 为空，worker、coder、reviewer 条目与 M4 相同；`ROLE_TOOL_IDS` 含 `analysis_create`、`change_create`、`change_submit`、`shud_build`、`verification_run`、`subagent_coder`、`subagent_reviewer`，不含 `harness.memory.propose`、`patch.apply`、`validator.run`、`git.inspect` 或任何以 `repo.` 开头的 id

### Requirement: Preset system prompts
preset 的 persona/agent-instructions 段 SHALL 来自 `packages/dsh-shud-presets/prompts/coordinator.md`、`packages/dsh-shud-presets/prompts/worker.md`、`packages/dsh-shud-presets/prompts/coder.md` 与 `packages/dsh-shud-presets/prompts/reviewer.md`，由对应 preset 行引用。对模型行为的要求 SHALL 表述为 prompt 文件的内容要求，实际行为序列以 session log 中的证据为准（首任务见「Local first-task acceptance script」，`code_change` 见「code_change orchestration」，`sensitivity` 见「sensitivity orchestration」）。
- `coordinator.md` SHALL 含：首任务步骤的文字说明（`task_create` 建卡 → 以 `subagent` 派发 preset `worker`，任务文本含 `task_id` 与 `input_dir` → 等待 worker 返回 `run_id` 与终态 → `report_generate` → `report_validate` → `report_submit`）；"worker 的返回以其后到达的 subagent-settled 消息为准，`subagent` 的立即结果（`started subagent <id>`）不是 worker 返回，收到该消息之前不调用 `report_generate`"（`code_change` 流程中每次委派——`subagent_coder`、`subagent`、`subagent_reviewer`——之后，同样以该子代理的 settled 消息为其返回，到达前不使用其 `build_id`、`run_id` 或验证证据，也不进入下一阶段；第 8 步的 `report_generate` 以 reviewer 的 settled 消息为前提）；"不直接调用 `shud_run`"；"收到 worker 的 settled 消息后，其中缺少已收集的终态时，自行以 `shud_collect` 轮询该运行"；"`report_validate` 失败时修正输入并重新调用 `report_generate`（得到新 `report_id`）"；"`report_submit` 未获放行后，向 PI 索要 comment 与明确处置（`rejected` 或 `revision_requested`），PI 未说明处置时不得默认、须再问，取得二者之前不调用 `report_decide`，随后调用 `report_decide(report_id, disposition, comment)`"；`code_change` 流程的文字说明（建 `code_change` 卡 → 以 `subagent_coder` 派 coder 做 base 构建 → 派 coder 改码并提交 ChangeRequest（可与 base 构建合并为一次 coder 派发，但 base 构建先于改码）→ 以 `subagent` 派 worker 跑 base 构建，任务文本含 base `build_id` → 派 coder 做候选构建 → 派 worker 跑候选构建，任务文本含候选 `build_id` → 以 `subagent_reviewer` 派 reviewer 验证 → 报告）；"ChangeRequest 未获放行时把 PI 的话转述给 coder，不自行批准"；`sensitivity` 流程的文字说明（`task_create(type: sensitivity)` 建卡 → 以 `analysis_create` 为该卡建恰好一个 plan，parameter_sets 只含白名单键的倍率、不给 calib 绝对值 → 以 `subagent` 派 worker，任务文本含 `task_id`、`analysis_plan_id`、各 `parameter_set_id` 与 `input_dir` → 收到 worker 汇报后 `report_generate` → `report_validate` → `report_submit`）；sensitivity 的有限恢复（置于既有 `shud_collect` 兜底段之后）："`report_generate` 以 closure 失败点名某 `parameter_set_id` 时：`inadmissible_effective_run` 先对所点名 `job_id` 调用一次 `shud_collect` 再调用 `report_generate`（每个被点名作业至多一次，不计为再委派）；该 pset 仍被 `missing_parameter_set` 或 `inadmissible_effective_run` 点名时，以 `subagent` 为该 pset 再委派 worker 一次（任务文本含 `task_id`、`analysis_plan_id`、`input_dir` 与仅这一个 `parameter_set_id`），等其 settled 消息后再调用 `report_generate`；每个 pset 至多再委派一次；再委派后同一 pset 仍被点名，或 closure 因 `job_not_terminal` 以外的其它原因失败时停止，把错误与已收集证据交给 PI，不新建卡或 plan；`job_not_terminal` 按既有 `shud_collect` 兜底等待收集后再调用 `report_generate`"；"不对已链接 plan 的卡再次调用 `analysis_create`"；"汇总表只陈述相对 baseline 的变化，不给敏感性指数、排名或机制解释，参数范围是 agent 建议值"；core `governance/wording.ts` 的 `FORBIDDEN_REPORT_PHRASES` 全部 10 条与 `GOVERNANCE_INVARIANTS` 全部 4 句的逐字文本；以及"语言护栏只是枚举短语 lint，通过 ≠ 合规，PI 审阅是最终防线"的边界说明。
- `worker.md` SHALL 含：以任务文本中的 task_id 调用 shud_run（任务文本点名 `build_id` 或 `analysis_plan_id` 时参数按下述对应段落给出；该子句位于第 1 步首句内、"Retain the returned…"之前，首任务行为不变）；不依赖 SHUD wake，用 job_output（dsh_job_id）等待并用 shud_collect（持久 run_id/job_id，不是 dsh_job_id）确认收集；取得终态 RunRecord 后才返回 run_id 与终态，不调用报告工具。本次 spike 唤醒未投递、原因未诊断，不宣称钉版全部子代理都不能被唤醒。worker 收到 coordinator 任务文本中的 `build_id` 时，以 `shud_run(input_dir, task_id, build_id, threads: 1)` 提交且不传 `end_days`，等待收集后回报 `run_id` 与 `build_id`；任务文本既无 `build_id` 也无 `analysis_plan_id`（`science_assist` 卡）时行为同 M3（不传 `build_id`/`threads`/plan 参数）。worker 收到 coordinator 任务文本中的 `analysis_plan_id` 与 parameter set 列表时（`sensitivity` 卡），对每个 pset 调用 `shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)`，每次都同时传 `analysis_plan_id` 与 `parameter_set_id`，不传 calib 值、`end_days`、`build_id` 或 `threads`；`sensitivity` 卡上不带 plan 参数的 `shud_run` 会被拒绝，被拒后不以省略 plan 参数或 `task_id` 的形态重试；仅因缺少 plan 参数或 `task_id` 被拒时（错误为 `requires parameter_set_id`、`requires analysis_plan_id`、`require task_id` 或 `requires its plan binding`）可为该 pset 以同时带 `task_id`、`input_dir`、`analysis_plan_id` 与 `parameter_set_id` 的正确形态再提交一次，其它原因的拒绝（id 格式不符、plan 读取失败、plan 属于其它卡、pset 不在 plan、与 plan 比对不符、plan 未链接到卡、`build_id`、重复 pset、输入摘要不符）如实回报该错误、不再提交；可以先提交全部 pset 再逐个以 `job_output(wait: true)` 等待并以 `shud_collect` 确认收集；失败的 pset 不自行重提，如实把 `parameter_set_id`、`run_id` 与终态回报 coordinator。
- `coder.md` SHALL 含：只在工作区 `repos/SHUD` 内修改已跟踪文件；先做 base 构建再改码；改完调用 `change_create` 再调用 `change_submit`；`change_submit` 未获放行即停止并回报，不重试提交；获批后调用 `shud_build(change_id, rhs_openmp: true)` 并回报 `build_id`；禁止科学结论措辞；禁止运行 SHUD。
- `reviewer.md` SHALL 含：只调用 `verification_run` 给出验证结论；`reviewer_notes` 只陈述工程事实；"bitwise 相等 ≠ 并行正确性/性能"。

presets 包 SHALL 有一项纳入默认 `pnpm run test` 的漂移测试：读取 `coordinator.md`、`coder.md` 与 `reviewer.md`，断言每份逐字含 `FORBIDDEN_REPORT_PHRASES` 与 `GOVERNANCE_INVARIANTS` 的每一项；常量增删或改字而任一 prompt 未同步时测试失败。prompt 中的这些文案 SHALL NOT 另有手写副本作为来源。`worker.md` 保留独立的执行与收集契约，不要求复制这两份措辞列表。

#### Scenario: coordinator prompt carries the governance rules
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/coordinator.md`
- **THEN** 文件含首任务步骤、"不直接调用 `shud_run`"、`shud_collect` 轮询退路、重新生成规则、comment 与处置索要规则及 `report_decide(report_id, disposition, comment)` 调用形态、10 条禁止用语与 4 句不变式的逐字文本，以及"PI 审阅是最终防线"的说明

#### Scenario: worker return is anchored to the settled message
- **WHEN** 检查 `coordinator.md` 首任务与 `code_change` 流程中等待各子代理的步骤及 `shud_collect` 兜底段
- **THEN** 文件写明 worker 的返回以 subagent-settled 消息为准、`started subagent <id>` 不是返回、收到该消息之前不调用 `report_generate`，`code_change` 流程每次委派（coder、worker、reviewer）同样以该子代理的 settled 消息为返回、报告生成以 reviewer 的 settled 消息为前提，兜底轮询以收到 settled 消息且缺少已收集终态为前提

#### Scenario: coordinator prompt carries the code_change flow
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/coordinator.md`
- **THEN** 文件含按序的 `code_change` 流程（建卡、coder base 构建、coder 改码提交、worker 跑 base、coder 候选构建、worker 跑候选、reviewer 验证、报告），点名 `subagent_coder`、`subagent`、`subagent_reviewer` 三个委派工具，并含"ChangeRequest 未获放行时转述 PI 的话给 coder、不自行批准"

#### Scenario: coordinator prompt carries the sensitivity flow
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/coordinator.md`
- **THEN** 文件含按序的 `sensitivity` 流程（`task_create(type: sensitivity)`、`analysis_create`、以 `subagent` 派 worker 并给出 plan id、pset 列表与 `input_dir`、`report_generate`、`report_validate`、`report_submit`），含"不对已链接 plan 的卡再次调用 `analysis_create`"，以及"不给敏感性指数、排名或机制解释，参数范围是 agent 建议值"

#### Scenario: guard pass is not presented as compliance
- **WHEN** 检索 `coordinator.md` 中关于 `report_validate` 与语言护栏的表述
- **THEN** 不含把护栏通过表述为合规充分条件的句子，且含"PI 审阅是最终防线"的说明

#### Scenario: worker prompt requires waiting for collection
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/worker.md`
- **THEN** 文件含以 `task_id` 调用 `shud_run`、等待运行终态且已收集后再返回 `run_id` 与终态，以及不调用报告工具的要求

#### Scenario: worker prompt carries the build-bound run
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/worker.md`
- **THEN** 文件含"任务文本给出 `build_id` 时以 `shud_run(input_dir, task_id, build_id, threads: 1)` 提交、不传 `end_days`、收集后回报 `run_id` 与 `build_id`"，以及"既无 `build_id` 也无 `analysis_plan_id`（`science_assist` 卡）时不传 `build_id`、`threads` 与 plan 参数、行为同 M3"

#### Scenario: worker prompt carries the plan-bound batch
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/worker.md`
- **THEN** 文件含"对每个 pset 以 `shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)` 提交、每次都同时传 `analysis_plan_id` 与 `parameter_set_id`、不传 calib 值、`end_days`、`build_id` 与 `threads`"、"`sensitivity` 卡上不带 plan 参数的提交会被拒绝，被拒后不以省略 plan 参数或 `task_id` 的形态重试"、"可先全部提交再逐个 `job_output(wait: true)` 与 `shud_collect`"，以及"失败的 pset 不自行重提、如实回报"

#### Scenario: coder prompt bounds the change workflow
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/coder.md`
- **THEN** 文件含只在 `repos/SHUD` 改已跟踪文件、先 base 构建再改码、`change_create` → `change_submit` 顺序、未获放行即停止回报且不重试提交、获批后 `shud_build(change_id, rhs_openmp: true)` 并回报 `build_id`、禁止科学结论措辞与禁止运行 SHUD 的要求

#### Scenario: reviewer prompt limits the verdict to engineering facts
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/reviewer.md`
- **THEN** 文件含只调用 `verification_run`、`reviewer_notes` 只陈述工程事实，以及"bitwise 相等 ≠ 并行正确性/性能"的说明；不含把 bitwise 相等表述为并行正确性、性能或模型改进的句子

#### Scenario: wording drift fails the test
- **WHEN** `GOVERNANCE_INVARIANTS` 的某一句被改字而 `coordinator.md`、`coder.md` 或 `reviewer.md` 中任一份未同步
- **THEN** 漂移测试失败并指出该 prompt 缺失的文案，`pnpm run test` 非 0 退出

### Requirement: Local first-task acceptance script
系统 SHALL 提供本机 `pnpm run shud:first-task`：因 headless 模板无审批卡，SHALL 以 Web 模板加 HTTP 接口（沿 M2 `shud-restart.sh` 的会话驱动机制）驱动一次完整首任务并对 `report_submit` 卡给出 `allowed-once`。脚本 SHALL 以显式参数接收 scratch 工作区路径并以之为会话 cwd，SHALL NOT 检查或拒绝位于 `$TMPDIR` 下的路径；缺少该参数、dsh、`SHUD_BIN` 或 `DMXAPI_KEY` 时 SHALL 在启动会话前以非 0 退出并指明缺失项，SHALL NOT 跳过。判据 SHALL 取自 session log 与工作区文件，不取自模型文本：session log 依次出现「First-task orchestration」所列的工具调用序列；`report_submit` 有 `approval/asked` 且 `approval/decided.outcome` 为 `allowed-once`；`tasks/<task_id>/task.json` 状态为 `done`；`reports/<report_id>.md` 含 `Accepted by PI`、StackLock llm 三字段（`base_url`、`request_alias`、`response_model`）、`SHUD`/`rSHUD`/`AutoSHUD` 三个 submodule 的修订，以及 `GOVERNANCE_INVARIANTS` 四句的逐字文本；该 ccw run 的 RunRecord `numerical_health` 中 `water_balance_residual`、`cvode_failures`、`negative_state_count` 均非 null、`max_solver_dt` 为 null，`artifacts.metrics_summary` 非 null 且其 sha256 与 `runs/<run_id>/metrics.json` 一致；报告 §5 渲染逐 run 指标表，`.md` SHALL NOT 含"本里程碑无指标 artifact"。报告 `.md` 与按同一组记录确定性重新渲染的结果逐字节相同，因此 §5 指标表的内容由该等式覆盖。这些断言与改变 collect/报告行为的实现在同一切片中更新，附本机重跑证据；判据不因新行为放宽，已消费的证据字节 SHALL NOT 重写（ADR-0009）。全部满足时退出 0，否则非 0 并保留工作区与 session 路径。该脚本 SHALL 在 Verification Matrix 登记为本机阻断闸。

#### Scenario: first task passes end to end
- **WHEN** 本机具备 dsh、可执行 `SHUD_BIN` 与 `DMXAPI_KEY`，以一个 scratch 工作区路径执行 `pnpm run shud:first-task`
- **THEN** 退出码 0，上述判据全部成立

#### Scenario: missing run metrics fail the first task
- **WHEN** 首任务报告 accepted、卡片 done，但 ccw run 的 `numerical_health.water_balance_residual` 为 null，或 `metrics_summary` 为 null，或 `.md` 仍含"本里程碑无指标 artifact"
- **THEN** 退出码非 0，输出指出失败的指标判据，并打印保留的工作区与 session log 路径

#### Scenario: workspace under TMPDIR is accepted
- **WHEN** 传入的 scratch 工作区路径位于 `$TMPDIR` 下，其余前提齐全
- **THEN** 脚本不因路径位置拒绝，判据与其它路径相同

#### Scenario: missing key does not skip
- **WHEN** 未设置 `DMXAPI_KEY` 时执行 `pnpm run shud:first-task`
- **THEN** 在启动 dsh 会话前以非 0 退出，stderr 指明 `DMXAPI_KEY`

#### Scenario: missing workspace argument
- **WHEN** 不带 scratch 工作区路径参数执行 `pnpm run shud:first-task`
- **THEN** 在启动 dsh 会话前以非 0 退出，stderr 指明缺少工作区路径

#### Scenario: unaccepted report fails
- **WHEN** 会话结束时 `report.md` 不含 `Accepted by PI` 或 `task.json` 不是 `done`
- **THEN** 退出码非 0，输出指出失败的判据，并打印保留的工作区与 session log 路径

#### Scenario: accepted files without approval audit fail
- **WHEN** 以一次性 --patch 禁用 shud-policy-gate，模型完成首任务并使 report JSON/Markdown 为 accepted、TaskCard 为 done，但该 report_submit callId 没有匹配的 approval/asked 与 allowed-once approval/decided
- **THEN** 脚本退出非0并指出缺失的报告审批审计，保留并打印 workspace 与规范 session log 路径，不以 accepted 文件或不存在卡片的超时替代此判据

#### Scenario: worker evidence is bound to the submitted report
- **WHEN** coordinator 使用另一个子会话/任务/运行的收集结果，或只收到 job_output 终态而 worker 尚未成功 shud_collect 就生成报告
- **THEN** 脚本拒绝该证据链，即使最终文件看起来 accepted；有效链必须把 parent/child、task/job/run、validated/submitted report 和 decision approval_ref 对齐

#### Scenario: first-task failure retains evidence and owned cleanup boundaries
- **WHEN** HTTP/审批连接或模型任务失败，或操作被中断
- **THEN** 脚本非0、保留已创建的工作区/home/session路径，停止并排空自有宿主/连接；仅凭已核实的本次运行身份清理 detached SHUD，无法证明所有权时报告未完成清理而不裸发历史PID信号


## ADDED Requirements

### Requirement: sensitivity orchestration
`sensitivity` 任务 SHALL 由 coordinator 编排为：`task_create`（`type: sensitivity`）→ coordinator `analysis_create` 为该卡建恰好一个不可变 plan → `subagent` 派 worker，任务文本含 `task_id`、`analysis_plan_id`、各 `parameter_set_id` 与 `input_dir` → worker 对每个 pset 调用绑定 plan 的 `shud_run(task_id, input_dir, analysis_plan_id, parameter_set_id)`（覆盖值只从 plan 解析；`sensitivity` 卡上的每次 `shud_run` SHALL 同时带 `analysis_plan_id` 与 `parameter_set_id`，不带 plan 参数的提交由 shud-run-tools「shud_run arguments」拒绝；不绑定 plan 的 M3 提交路径只用于 `science_assist` 卡）→ worker 以 `job_output(wait: true)` 等待并以 `shud_collect` 确认每个 run 已收集 → 返回各 pset 的 `run_id` 与终态 → coordinator `report_generate`/`report_validate`/`report_submit` → PI 审批。coordinator SHALL NOT 直接调用 `shud_run`；worker、coder、reviewer SHALL NOT 调用 `analysis_create` 或报告工具（restrict 隐藏，执行门也 deny）。`analysis_create` 与绑定 plan 的 `shud_run` SHALL NOT 触发 PI 审批门，整个流程唯一的 PI 审批点是 `report_submit`（及其后可能的 `report_decide`）；输入位于 raw 时的 provenance 读审批卡由 raw-data-guard 产生，不属于审批门。本要求只约束工具调用的先后顺序与角色归属：worker 可以先提交全部 pset 再逐个等待与收集，SHALL NOT 被要求逐个串行提交；不新增 preset、委派工具或批量提交工具。worker 遇到失败的 pset SHALL NOT 自行重提，如实回报 coordinator。worker 的提交仅因缺少 plan 参数或 `task_id` 被拒时 SHALL 至多以正确形态为该 pset 再提交一次；其它拒绝 SHALL 如实回报、不再提交。`report_generate` 的 closure 失败点名某 pset 时，coordinator SHALL 按「Preset system prompts」的有限恢复处理：`inadmissible_effective_run` 先对所点名作业至多一次 `shud_collect`；该 pset 仍被 `missing_parameter_set` 或 `inadmissible_effective_run` 点名时为其再委派 worker，每个 pset 至多一次；再委派后同一 pset 仍被点名或 closure 因 `job_not_terminal` 以外的其它原因失败时 SHALL 停止并把错误与证据交给 PI，SHALL NOT 新建卡或 plan、再次调用 `analysis_create` 或调用 `shud_run`；`job_not_terminal` 沿用既有 `shud_collect` 兜底。注册表把 `failed`/`cancelled`、收集耗尽或 RunRecord `status: failed` 的作业视为失败（shud-run-jobs 重复提交规则），故再委派的提交在上述情形下均被接受。重提后先前失败或取消的作业仍留在 `linked_jobs` 中（重复提交规则见 shud-run-jobs）；`shud:sensitivity` 判据 2 对恢复后集合的处理不在本要求内。端到端判据由 oat-sensitivity 的 `shud:sensitivity` 以 session log 与工作区文件给出，不取模型文本。

#### Scenario: sensitivity session follows the orchestration order
- **WHEN** 在 Web 默认 coordinator 会话中对 ccw 发起一次 sensitivity 任务并对报告审批卡 Allow once
- **THEN** session log 中依次出现 coordinator 的 `task_create`（`type: sensitivity`）与 `analysis_create` 的 `tool/result`、`subagent`（preset `worker`）、worker 子会话内每个 pset 一次参数含 `analysis_plan_id` 与 `parameter_set_id` 的 `shud_run`、worker 的 `job_output` 等待与成功 `shud_collect`、worker 向 coordinator 返回各 `run_id` 与终态，以及 coordinator 的 `report_generate`、`report_validate` 与 `report_submit` 的 `approval/asked`

#### Scenario: batch submission before waiting satisfies the order
- **WHEN** worker 先连续提交全部四个 pset 的 `shud_run`，再逐个 `job_output(wait: true)` 与 `shud_collect`
- **THEN** 编排顺序成立；提交与等待交错的次序不构成违反

#### Scenario: plan creation and plan-bound runs raise no approval
- **WHEN** 检查一次输入不在 raw 内的 sensitivity 会话的 session log
- **THEN** `analysis_create` 与全部 `shud_run` 调用没有对应的 `approval/asked`，唯一的 `approval/asked` 来自 `report_submit`

#### Scenario: coordinator cannot run SHUD in a sensitivity task
- **WHEN** coordinator 会话中模型尝试调用 `shud_run`（含带 `analysis_plan_id` 的形态）
- **THEN** 调用不执行（restrict 隐藏，执行门也 deny），不产生运行目录

#### Scenario: worker cannot create a plan
- **WHEN** worker 子会话中模型尝试调用 `analysis_create`
- **THEN** 调用不执行（restrict 隐藏，执行门也 deny），`analyses/` 下没有新文件，卡片 `linked_analyses` 不变

#### Scenario: plan-less run on a sensitivity card is rejected and not retried around
- **WHEN** worker 子会话中模型以 sensitivity 卡的 `task_id` 调用不带 `analysis_plan_id`/`parameter_set_id` 的 `shud_run`
- **THEN** 工具返回指出缺少 plan 参数的错误，不产生运行目录，卡片 `linked_jobs` 不变，`analyses/` 下文件字节不变

#### Scenario: plan-less rejection is retried once in the correct form
- **WHEN** worker 在 sensitivity 卡上的某次 `shud_run` 因缺少 `analysis_plan_id`/`parameter_set_id` 被拒
- **THEN** worker 子会话中该 pset 至多再有一次 `shud_run`，且其参数同时含 `task_id`、`input_dir`、`analysis_plan_id` 与 `parameter_set_id`；因其它原因（如 plan 未链接、pset 不在 plan、重复 pset）被拒之后该 pset 没有再次 `shud_run`

#### Scenario: missing parameter set is recovered once through the worker
- **WHEN** `report_generate` 以 `missing_parameter_set` 点名某个 pset 失败
- **THEN** coordinator 随后以 `subagent` 为该 pset 委派 worker 一次，任务文本只含这一个 `parameter_set_id`，在该子代理的 settled 消息之后才再次调用 `report_generate`；coordinator 会话中没有 `shud_run` 或新的 `analysis_create`

#### Scenario: inadmissible run is collected once, then re-delegated once
- **WHEN** `report_generate` 以 `inadmissible_effective_run` 点名某 pset 与 `job_id` 失败
- **THEN** coordinator 对该 `job_id` 调用一次 `shud_collect` 后再调用 `report_generate`；若该 pset 仍被点名，coordinator 为其以 `subagent` 委派 worker 一次，在该子代理的 settled 消息之后再调用 `report_generate`；同一 `job_id` 没有第二次恢复性 `shud_collect`

#### Scenario: repeated failure stops for the PI
- **WHEN** 已为某 pset 再委派过一次后 `report_generate` 仍因该 pset 失败，或 closure 以 `multiple_successes`、`mixed_stack` 等其它原因失败
- **THEN** coordinator 不再委派 worker、不新建卡或 plan，而是把错误与已收集证据交给 PI

#### Scenario: coordinator prompt carries the sensitivity recovery
- **WHEN** 读取 `coordinator.md` 的 `## sensitivity workflow` 段与 `worker.md` 的 `## Plan-bound sensitivity runs` 段
- **THEN** 前者在既有 `shud_collect` 兜底段之后依序含 `missing_parameter_set`/`inadmissible_effective_run` 的处理、对所点名作业一次 `shud_collect`、为该 pset 至多一次的 worker 再委派、`job_not_terminal` 走兜底与停止交 PI；后者含仅缺 plan 参数或 `task_id` 时正确形态再提交一次与其它拒绝如实回报；删去任一子句时 prompts 测试失败，既有断言不改仍通过

#### Scenario: failed parameter set is reported, not resubmitted by the worker
- **WHEN** 某个非 baseline pset 的 run 收集为 `status: failed`
- **THEN** worker 子会话中该 `parameter_set_id` 只有一次被接受的 `shud_run`，worker 的回报含该 pset 的 `run_id` 与失败终态
