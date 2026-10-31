# Spec Delta

## Purpose

定义 `shud` profile 中 coordinator 与 worker 两个 agent preset 的可观察组成与角色工具面：preset 行与默认 preset、逐行列出的插件子树、宿主平面的子代理注册表与 provider 行、全局 `shud-role-restrict` 生命周期插件经 agent.ctx 绑定的限制、inherited/local 两集合角色工具清单、system prompt 的内容要求，以及首任务"建卡 → worker 跑 ccw 并等到收集 → 报告 → PI 审批"的编排、K13 spike、本机首任务验收脚本与 Epic 收口 PI 验收的证据形态。

## ADDED Requirements

### Requirement: Coordinator and worker preset rows
bundle patch（`profile/shud/cordis.patch.yml`）SHALL 插入两行 `@deepseek-ai/dsh-agent-preset`：`preset-coordinator`（`order: 1`，preset `config.id: coordinator`）与 `preset-worker`（preset `config.id: worker`），行 id 与 preset id 的关系同 stock `preset-standard`/`standard`；`agent-preset-registry` 行的 `config.default` SHALL 为 preset id `coordinator`，使 Web 新会话的主 Agent 默认使用 coordinator preset。两行 SHALL 由 `@shud-harness/dsh-shud-presets` 提供，SHALL NOT 改动 `../deepseek-harness` 或 import dsh loop 内部。

#### Scenario: dump-config shows both preset rows and the default
- **WHEN** 在已执行 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出含 `id: preset-coordinator` 与 `id: preset-worker` 两行，`name` 均为 `@deepseek-ai/dsh-agent-preset`，其 `config.id` 分别为 `coordinator` 与 `worker`，`agent-preset-registry` 行的 `config.default` 为 `coordinator`

#### Scenario: missing default fails the smoke
- **WHEN** bundle patch 未设置 `agent-preset-registry.default` 或其值不是 `coordinator`，执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出默认 preset 断言失败

### Requirement: Preset plugin subtrees
两个 preset 的 `config.plugins` 子树 SHALL 逐行显式列出，不沿用 stock `standard` preset 的骨架：
- coordinator 子树 SHALL 恰为 `persona`、`agent-instructions`（`maxBytes: 65536`）、`time-context`、`tool-jobs`（挂载 `job_output`、`job_list`、`job_kill`）、`tool-subagent`（provider `spawn`，`toolName: subagent`，`agentPreset: worker`，`modelSelectionSettings: false`）。显式 worker 选择 SHALL NOT 省略，否则子代理继承 coordinator。
- worker 子树 SHALL 恰为 `persona`、`agent-instructions`（`maxBytes: 65536`）、`time-context`、`tool-jobs`；没有任何委派行，worker 不能派生子代理是装配的结构性事实。
- 两个子树 SHALL NOT 挂载 `shud-role-restrict`、`tool-fs`、`tool-fs-search`、`tool-bash`、`tool-skill`、`skill-filesystem`、`tool-subagent-control`、`tool-ask-user`、`tool-todo`、`tool-web`、`tool-schedule`、`plan-mode`、`compaction`、`present` 或 `tool-goal` 行。角色工具面不含 `read`；PI 经 Web 工作区文件面板打开报告文件，不经模型。

子代理注册表（`subagent` 行）与 provider 行 `subagent-spawn-in-process` SHALL 保持 stock bundle 的宿主平面全局行位置（`packages/bundle/web-app/cordis.patch.yml` 注释"The subagent registry and its backends STAY in the host plane"：注册表是进程单例，provider 名全局唯一），由 shud bundle patch 保持启用、各只出现一次，SHALL NOT 出现在任何 preset 子树中；coordinator preset 只添加委派工具行 `tool-subagent`。子代理深度沿用 dsh `maxDepth` 设置的默认值 1，不另设。

#### Scenario: coordinator subtree rows are exact
- **WHEN** 检查 dump-config 中 `preset-coordinator` 的 `config.plugins`
- **THEN** 行集合恰为 `persona`、`agent-instructions`、`time-context`、`tool-jobs`、`tool-subagent`（`toolName: subagent`、`agentPreset: worker`、`modelSelectionSettings: false`），不含 `shud-role-restrict`、`subagent-spawn-in-process`、`tool-fs` 或 `tool-bash`，未覆写 `maxDepth`

#### Scenario: worker subtree rows are exact
- **WHEN** 检查 dump-config 中 `preset-worker` 的 `config.plugins`
- **THEN** 行集合恰为 `persona`、`agent-instructions`、`time-context`、`tool-jobs`，不含 `shud-role-restrict`、`tool-subagent` 或任何其它 `tool-subagent*` 行

#### Scenario: subagent registry and provider stay in the host plane
- **WHEN** 检查同一 dump-config 的全局插件列表
- **THEN** `id: subagent` 与 `id: subagent-spawn-in-process` 各出现一次、未被禁用且位于全局列表，两个 preset 子树中都没有这两行

#### Scenario: worker cannot spawn a nested subagent
- **WHEN** 枚举 worker 子代理会话的模型可见工具，并在该会话中令模型尝试调用 `subagent`
- **THEN** 工具列表不含 `subagent`（worker 子树没有委派行），调用不产生新的子代理会话；即使调用到达 `tools/pre-execute`，`role-tool-surface` 也返回 `deny`

### Requirement: Role tool surface restriction
插件 `shud-role-restrict` SHALL 作为全局行挂载，无固定 `role` 配置。在真实 `agent/created` 时按 policy-gate「Caller role derivation」读取当前角色，经该 Agent 的 `agent.ctx.tools.restrict({allow})` 绑定限制；`allow` SHALL 恰为该角色条目的 `inherited` 集合。`local` 集合 SHALL NOT 传给 restrict：钉版 `tool-subagent` 把 `subagent` 注册在 Agent 自身作用域；`job_*` 则从 preset 继承，必须纳入 allow。`inherited` 为空或含未知工具时 SHALL 明确失败，不静默移除不认识的名字或退化为无限制。policy-gate 始终以 `inherited ∪ local` 做执行时 deny；两者共用唯一 role-tool-map。

插件 SHALL 在已提交的 `agent-preset/selected` 会话事件后同步重绑该 Agent 的限制，不以早于投影更新的 `tools/change` 决定角色；成功安装新限制后才释放旧限制。同一角色重复事件不叠加限制；切到 unknown 时释放本插件的旧限制，不影响其它插件的限制；Agent/插件释放时移除自身注册与限制。不得使用 creation header 决定切换后的角色。K13 O3 已证明原 preset apply 时全局 shud 工具尚未注册、原 allow(global) 备选会隐藏 job_*；PI 已授权重开并采用经真实 Web 验证的 inherited/local 设计。

#### Scenario: coordinator sees only its tool surface
- **WHEN** 在 Web 以默认 coordinator preset 开会话并查看模型可见工具
- **THEN** 可见工具集合恰为 `task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`shud_collect`、`subagent`、`job_output`、`job_list`、`job_kill`；`shud_run`、`bash`、`write`、`edit` 与 `list_subagent_models` 不可见

#### Scenario: worker sees only its tool surface
- **WHEN** coordinator 以 preset `worker` 派发子代理，在 Web 查看该子代理会话的模型可见工具
- **THEN** 可见工具集合恰为 `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`subagent`、`report_generate`、`bash` 不可见

#### Scenario: empty or unknown inherited allow fails loudly
- **WHEN** 已知角色的 `inherited` 为空或含未挂载名 `shud.run` 时绑定限制
- **THEN** 返回含 `shud-role-restrict` 与角色或工具名的错误，不静默放宽

#### Scenario: inherited jobs are included and agent-owned subagent is excluded
- **WHEN** 检查 coordinator 经 `agent.ctx` 传给 restrict 的 allow
- **THEN** 它等于 `inherited`，包含三个 job 工具、不含 `subagent`；真实模型工具面仍包含 `subagent`

#### Scenario: blank-session preset switch rebinds the tool surface
- **WHEN** Web 空白会话由 coordinator 切到 worker，再切回 coordinator
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
- coordinator：`inherited` = `task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`local` = `subagent`。
- worker：`inherited` = `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`；`local` 为空。
- `repo_explorer`、`coder`、`reviewer` 三行保留现有 id，整体置于 `inherited`、`local` 为空，注明"M4 契约，M3 无 preset 消费、不经 restrict 校验"；M3 仍推导为 unknown。

`ROLE_TOOL_IDS` SHALL 为全部条目两份集合的并集，SHALL NOT 保留只由旧 coordinator/worker 行使用的 Zero 时代 id（`shud.run`、`harness.job.submit`、`harness.job.collect`、`harness.report.generate`、`spawn_agent`、`wait_agent` 等）。

#### Scenario: worker sets are the mounted names
- **WHEN** 调用 `getRoleToolIds("worker")`
- **THEN** 返回 `inherited` 为 `shud_run`、`shud_collect`、`job_output`、`job_list`、`job_kill`，`local` 为空

#### Scenario: coordinator sets are the mounted names
- **WHEN** 调用 `getRoleToolIds("coordinator")`
- **THEN** 返回 `inherited` 为六个 coordinator SHUD 工具与三个 job 工具，`local` 为 `subagent`

#### Scenario: legacy ids are rejected
- **WHEN** 调用 `isRoleToolIdAllowed("worker", "shud.run")` 或 `isRoleToolIdAllowed("coordinator", "spawn_agent")`
- **THEN** 两者均返回 `false`

#### Scenario: M4 rows survive unchanged
- **WHEN** 读取 `ROLE_TOOL_MAP`
- **THEN** 仍含 `repo_explorer`、`coder`、`reviewer` 三行，其 `inherited` 等于本 change 之前的 id 列表、`local` 为空，且其 id 均在 `ROLE_TOOL_IDS` 内

### Requirement: Profile smoke covers presets
两个 preset 行、`agent-preset-registry.default`、宿主平面 `subagent` 与 `subagent-spawn-in-process` 行和 `shud-policy-gate` 行的存在性，以及 `shud-jobs` 行采集键与 `llm-deepseek`/`agent-default-model` 的一致性断言，SHALL 由 shud-profile 的「Local profile smoke」唯一规定；本 capability SHALL NOT 另行定义 `pnpm run profile:smoke` 的断言集合。records 包是文件层，SHALL NOT 有自己的插件行。

#### Scenario: preset assertions live in shud-profile
- **WHEN** 查阅 `pnpm run profile:smoke` 对 preset 行与默认 preset 的判据
- **THEN** 唯一来源是 shud-profile「Local profile smoke」，本 spec 无第二份断言清单

#### Scenario: no records plugin row
- **WHEN** 检查 `dsh --profile shud --dump-config` 的插件行
- **THEN** 不存在名为 `shud-records` 的行；StackLock/DataProvenance 采集配置只出现在 `shud-jobs` 行

### Requirement: Preset system prompts
preset 的 persona/agent-instructions 段 SHALL 来自 `packages/dsh-shud-presets/prompts/coordinator.md` 与 `packages/dsh-shud-presets/prompts/worker.md`，由对应 preset 行引用。对模型行为的要求 SHALL 表述为 prompt 文件的内容要求，实际行为序列以「Local first-task acceptance script」在 session log 中的证据为准。
- `coordinator.md` SHALL 含：首任务步骤的文字说明（`task_create` 建卡 → 以 `subagent` 派发 preset `worker`，任务文本含 `task_id` 与 `input_dir` → 等待 worker 返回 `run_id` 与终态 → `report_generate` → `report_validate` → `report_submit`）；"不直接调用 `shud_run`"；"worker 未带回已收集的终态时，自行以 `shud_collect` 轮询该运行"；"`report_validate` 失败时修正输入并重新调用 `report_generate`（得到新 `report_id`）"；"`report_submit` 未获放行后，向 PI 索要 comment 与明确处置（`rejected` 或 `revision_requested`），PI 未说明处置时不得默认、须再问，取得二者之前不调用 `report_decide`，随后调用 `report_decide(report_id, disposition, comment)`"；core `governance/wording.ts` 的 `FORBIDDEN_REPORT_PHRASES` 全部 10 条与 `GOVERNANCE_INVARIANTS` 全部 4 句的逐字文本；以及"语言护栏只是枚举短语 lint，通过 ≠ 合规，PI 审阅是最终防线"的边界说明。
- `worker.md` SHALL 含：以任务文本中的 task_id 调用 shud_run；不依赖 SHUD wake，用 job_output（dsh_job_id）等待并用 shud_collect（持久 run_id/job_id，不是 dsh_job_id）确认收集；取得终态 RunRecord 后才返回 run_id 与终态，不调用报告工具。本次 spike 唤醒未投递、原因未诊断，不宣称钉版全部子代理都不能被唤醒。

presets 包 SHALL 有一项纳入默认 `pnpm run test` 的漂移测试：读取 `coordinator.md`，断言其逐字含 `FORBIDDEN_REPORT_PHRASES` 与 `GOVERNANCE_INVARIANTS` 的每一项；常量增删或改字而 prompt 未同步时测试失败。prompt 中的这些文案 SHALL NOT 另有手写副本作为来源。

#### Scenario: coordinator prompt carries the governance rules
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/coordinator.md`
- **THEN** 文件含首任务步骤、"不直接调用 `shud_run`"、`shud_collect` 轮询退路、重新生成规则、comment 与处置索要规则及 `report_decide(report_id, disposition, comment)` 调用形态、10 条禁止用语与 4 句不变式的逐字文本，以及"PI 审阅是最终防线"的说明

#### Scenario: guard pass is not presented as compliance
- **WHEN** 检索 `coordinator.md` 中关于 `report_validate` 与语言护栏的表述
- **THEN** 不含把护栏通过表述为合规充分条件的句子，且含"PI 审阅是最终防线"的说明

#### Scenario: worker prompt requires waiting for collection
- **WHEN** 检查 `packages/dsh-shud-presets/prompts/worker.md`
- **THEN** 文件含以 `task_id` 调用 `shud_run`、等待运行终态且已收集后再返回 `run_id` 与终态，以及不调用报告工具的要求

#### Scenario: wording drift fails the test
- **WHEN** `GOVERNANCE_INVARIANTS` 的某一句被改字而 `coordinator.md` 未同步
- **THEN** 漂移测试失败并指出缺失的文案，`pnpm run test` 非 0 退出

### Requirement: First-task orchestration
首任务 SHALL 为 coordinator task_create → subagent（显式 worker，任务含 task_id/input_dir）→ worker shud_run(task_id) → worker 以 job_output 等待并以 shud_collect 确认已收集 → 返回 run_id 与终态 → coordinator report_generate/report_validate/report_submit → PI 审批。coordinator 不直接 shud_run。O1 本次实测 owner_session 为真实 worker 子会话，SHUD notify 最终 unreachable，恢复失败根因未诊断；worker 轮询成功，原生 subagent-settled 通知携带结果回到 coordinator。不得把该通知当作 shud-jobs wake。coordinator 若未收到已收集结果，可按既有兜底自行 collect；不改变 M2 jobs 的通知契约。

#### Scenario: first task reaches the approval card
- **WHEN** PI 在 Web 默认会话中要求对 ccw 跑首任务
- **THEN** session log 中依次出现 `task_create`、`subagent`（preset `worker`）、worker 会话内的 `shud_run`（参数含该 `task_id`）、worker 的 `job_output` 等待结果及随后成功 `shud_collect` 返回的终态 RunRecord、worker 完成并向 coordinator 返回 `run_id` 与终态、`report_generate`、`report_validate` 的 `tool/result`，以及 `report_submit` 的 `approval/asked`；仅有 job_output 或唤醒消息但无 worker 成功收集时，此 happy-path 验收失败，coordinator 兜底收集不能冒充 worker 收集证据

#### Scenario: coordinator cannot run SHUD directly
- **WHEN** coordinator 会话中模型尝试调用 `shud_run`
- **THEN** 调用不执行（restrict 隐藏，执行门也 deny），不产生运行目录

### Requirement: Time-boxed K13 spike
本 change 的限时 K13 spike（2 个工作日）SHALL 在 TaskCard 品牌/schema 与最小 task_create 合入后执行，且记录 O1/O2/O3/O5/O6 的真实会话、配置与一次性探针证据，不能以源码推测替代。记录 SHALL 包含：子代理 owner_session 与 worker 收集路径；两个实际监听的顺序与未挂载 auto-review/hooks 的边界；O3 原方案/备选失败、PI 授权重开及 inherited/local 方案证据；审批 callId 与 asked/decided 关联；header/当前投影及空白 preset 切换。收尾 SHALL 含 Web coordinator 建卡、真实 worker 子代理跑 ccw（不带 task_id）并等待已收集终态。停止条件（预算/O3 两路径均失败/O1 无收集路径/O6 无身份路径）触发时必须先报告再经设计授权重开；后续切片只消费已复审的结论。

#### Scenario: spike closes with the Web step
- **WHEN** spike 收尾
- **THEN** 其证据含一次 Web 会话的 session log：coordinator 的 `task_create` 结果与 preset `worker` 子代理内对 ccw 的 `shud_run` 结果（参数不含 `task_id`），且 O1/O2/O3/O5/O6 各有记录的结论

#### Scenario: spike without a user-visible step is not done
- **WHEN** spike 只给出单测或 dump-config 证据而没有 Web 内建卡并派 worker 跑 ccw 的会话
- **THEN** spike issue 不得关闭，后续实现子 issue 不得开工

#### Scenario: unreadable preset id stops the spike
- **WHEN** spike 记录 Web 主会话与 worker 子代理会话的 `session.header.agentPreset` 都读不到 preset id，且 `agentPreset` 会话投影也不可用
- **THEN** spike 结论为停止，后续依赖角色推导的子 issue 不开工，直至设计决策重开

### Requirement: Local first-task acceptance script
系统 SHALL 提供本机 `pnpm run shud:first-task`：因 headless 模板无审批卡，SHALL 以 Web 模板加 HTTP 接口（沿 M2 `shud-restart.sh` 的会话驱动机制）驱动一次完整首任务并对 `report_submit` 卡给出 `allowed-once`。脚本 SHALL 以显式参数接收 scratch 工作区路径并以之为会话 cwd，SHALL NOT 检查或拒绝位于 `$TMPDIR` 下的路径；缺少该参数、dsh、`SHUD_BIN` 或 `DMXAPI_KEY` 时 SHALL 在启动会话前以非 0 退出并指明缺失项，SHALL NOT 跳过。判据 SHALL 取自 session log 与工作区文件，不取自模型文本：session log 依次出现「First-task orchestration」所列的工具调用序列；`report_submit` 有 `approval/asked` 且 `approval/decided.outcome` 为 `allowed-once`；`tasks/<task_id>/task.json` 状态为 `done`；`reports/<report_id>.md` 含 `Accepted by PI`、StackLock llm 三字段（`base_url`、`request_alias`、`response_model`）、`SHUD`/`rSHUD`/`AutoSHUD` 三个 submodule 的修订，以及 `GOVERNANCE_INVARIANTS` 四句的逐字文本。全部满足时退出 0，否则非 0 并保留工作区与 session 路径。该脚本 SHALL 在 Verification Matrix 登记为本机阻断闸。

#### Scenario: first task passes end to end
- **WHEN** 本机具备 dsh、可执行 `SHUD_BIN` 与 `DMXAPI_KEY`，以一个 scratch 工作区路径执行 `pnpm run shud:first-task`
- **THEN** 退出码 0，上述判据全部成立

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

### Requirement: Epic-close PI acceptance
M3 Epic 收口时 PI SHALL 在 `dsh --profile shud` 的 Web 内亲自完成一次首任务，至少包含一次 `report_submit` 的 Allow once，以及一次拒绝 + 对话 comment + `report_decide` 的往返；证据（session log 路径与 `approval/asked|decided` 事件序列摘录、工作区 task/report 文件路径）SHALL 记入 `docs/Migration_Plan_dsh.md`，验收安排由决策记录 `docs/adr/proposed/0010-m3-epic-acceptance.md`（沿 ADR-0005/0007 模式）登记。子 PR 按工程门合入不等于验收通过；`shud:first-task` 等工程验证 SHALL NOT 替代该验收。

#### Scenario: acceptance evidence is recorded
- **WHEN** PI 完成 Epic 收口验收
- **THEN** `docs/Migration_Plan_dsh.md` 含该会话的 session log 路径，摘录中有至少一条 `report_submit` 的 `approval/decided{outcome: "allowed-once"}`，以及一组未放行的 `approval/decided` 后接 `report_decide` 的 `approval/asked|decided`

#### Scenario: engineering green is not acceptance
- **WHEN** 全部子 PR 已合入且 `shud:first-task` 退出 0，但 PI 尚未完成上述 Web 验收
- **THEN** M3 Epic 不关闭，OpenSpec 变更不归档
