# Proposal

## Issue #424 fixture

Issue type: feature. Fixture level: expanded. Upstream suggested level: expanded (agree).
Blast radius: core TaskCard parsing, public identifier generation, generated schema consumers.
Selected risk packs: Public API; Schema; Legacy compatibility; Documentation.
Evidence floor: branded-id and TaskCard positive/negative tests, unchanged JOB/RUN pairing tests, runtime schema smoke, `pnpm run schema:check`, `pnpm run check`, Critical Path #7 white-box review.
Only task 3.1a is implemented by #424; the remaining M3 tasks and PI acceptance remain open.

## Why

M3 的用户可见步骤是"从任务卡到 Markdown 证据报告，含 PI 审批"（`docs/04_IMPLEMENTATION/Phased_Plan.md` §0 M3 行、§3）：首任务 "ccw 运行 → RunRecord → EvidenceReport" 端到端跑通，报告含 StackLock 三字段与响应 model，措辞过治理四条不变式。M2 已于 2026-10-27 通过 PI 验收（#318，ADR-0007），运行主链（`shud_run` → durable JobRegistry → RunRecord → 唤醒）就绪，但 M3 的四个对象（TaskCard、StackLock 三字段、DataProvenance、EvidenceReport）在代码里要么不存在、要么仍是 Zero 时代的旧字段（`docs/04_IMPLEMENTATION/Port_List.md`）；`policy-gate-core` 零消费者、profile 无 agent preset、`approval` seam 没有 PI comment 字段（ADR-0004 附录 ⑫）。M2→M3 边界升级评估（#420）确认钉版 rc.2 的 seam 事实在 rc.4 不变，设计据此冻结。

## What Changes

- `@shud-harness/dsh-shud-core`：新增 EvidenceReport 与 PiGateDecision Zod schema；TaskCard/StackLock/DataProvenance 对齐——品牌 id `TASK-/STACK-/DATA-/REPORT-<UTC>-xxxx`（复用 run-identifiers 生成器），`StackLock.llm` 收窄为 `base_url`/`request_alias`/`response_model` 三字段并排除 `response_model` 出指纹，`repos.<name>` 新增 `dirty_paths`，`StackLock.runtime` 最小化为 `os`/`sundials_version`/`host_version`、`harness` 为 `{version}`（可确定项必填，其余删除：无采集者的字段不保留）；TaskCard 状态机转换表与 closure 谓词为纯函数；新增 `governance/wording.ts`（禁止用语与四条不变式常量 + 测试）；`policy-gate-core` 拆分到 ≤1000 行，删除与 dsh 原生 `maxDepth`/`maxActiveSubagents`/preset 子集语义重复的 spawn depth/concurrency/profile-subset 三条规则，保留参数校验框架与 `raw-data-write` 保留 id，新增唯一默认 deny 规则 `role-tool-surface`；去掉 `isReservedAuthorityPolicyEvidenceId` 别名、knip `duplicates` 转 error。`pnpm run schema:generate` 刷新 `docs/generated/`，`docs/03_SPEC/Minimal_Schemas.md` 随之修订。
- 新包 `@shud-harness/dsh-shud-records`：四个对象在会话工作区的文件持久化（`tasks/<task_id>/task.json`、`stacks/<stack_id>.json`、`provenance/<data_id>.json`、`reports/<report_id>.{md,json}`，原子写，不经 `ctx.storage`、无 stateDir 索引）；StackLock 确定性采集（三 submodule 版本 + dirty_paths + llm 三字段 + 最小 runtime）；DataProvenance 由复制后的输入文件 sha256 生成；EvidenceReport 模板填充（10 节、7 态水印）、确定性 validator（12 项 (D) + 语言护栏 + 四句不变式逐字出现 + 第 13 项 `sk-` 密钥形态扫描）与状态机；目录与目标文件 `lstat` 校验、品牌 id 先校验后拼路径。
- `@shud-harness/dsh-shud-tools`：`shud_run` 新增可选 `task_id`，提交时注册表复用指纹相等的当前 StackLock（无则确定性采集新 lock）、由输入副本生成新 DataProvenance，写入 RunJob 的 `task_id`/`stack_id`/`data_id`（schema 保持 nullable，M2 记录仍可读）；新增 5 个模型工具 `task_create`、`report_generate`（coordinator 以参数提供 summary/observations/limitations/pi_questions，工具做引用存在性校验与模板填充）、`report_validate`（draft→reviewed）、`report_submit`（审批卡放行即 accepted）、`report_decide`（PI 拒绝后由 coordinator 转述 comment 与处置，二次审批卡放行即 rejected/revision_requested）；终态只在审批 `allowed-once` 分支写入，`awaiting_pi` 为审批卡挂起时的瞬时态不落盘。
- 新包 `@shud-harness/dsh-shud-policy-gate`：`tools/pre-execute` 插件——先求值 `role-tool-surface`（已知角色调用角色工具面外的工具 → `{kind: "deny"}`，求值器抛错 fail-closed），再对 `report_submit`/`report_decide` 无条件返回 `ask`（审批卡 = PI 决定点；`report_submit` 放行 → `accepted`，其余 fail-closed）；角色 deny 先于报告 ask，worker 调报告工具直接被拒。PI comment 按候选 (a)：submit 卡被拒后由 coordinator 在下一轮对话向 PI 索要 comment 与明确处置（`rejected` 或 `revision_requested`，PI 未说明不得默认），调 `report_decide(report_id, disposition, comment)`，二次审批卡回显两者、放行才写入 PiGateDecision；`approval_ref` 记本张 decide 卡（`approval/asked.id`，不可得时 `callId`，见 design D3/O5），被拒 submit 卡经 session log 中携带 `report_id` 的 `approval/asked|decided` 关联；无 comment 不得写入非 accepted 终态（GR-003）。
- 新包 `@shud-harness/dsh-shud-presets`：`coordinator` 与 `worker` 两个 `dsh-agent-preset` 行，子树逐行显式列出（persona、agent-instructions、time-context、tool-jobs；coordinator 另加 `tool-subagent`，`modelSelectionSettings: false`；均不挂 `tool-fs`/`tool-bash`/skill 等行，两角色都没有 `read`）；`role-tool-map` 的 tool id 改为实际挂载名，每个角色两个集合——`global`（全局 bundle 行挂载的 shud 工具，内嵌插件 `shud-role-restrict` 以 `ctx.tools.restrict({allow: global})` 收窄）与 `preset`（角色自身 preset 子树挂载的工具），policy-gate 以两者并集为执行面，单一事实源、两个消费者；子代理 `maxDepth` 走 dsh 原生设置（1）。首任务流程：coordinator `task_create` → spawn worker 调 `shud_run(task_id)`，worker 等待运行到达终态且已收集（唤醒或 `job_output`/`shud_collect` 轮询）后向 coordinator 返回 `run_id` 与终态 → coordinator `report_generate`/`report_validate`/`report_submit` → PI 审批卡。
- profile：挂载 `shud-policy-gate` 与两个 preset 行；subagent 注册表与 `subagent-spawn-in-process` 保持 stock web bundle 的宿主平面全局行（只插入一次、不进 preset），coordinator preset 只加 `tool-subagent` 工具行；headless 模板（`shud-probe`）与 web 共用 bundle，但模板无 `agent-preset-registry`，安装器（`profile-patch.ts`）在 `PROFILE_TEMPLATE=headless` 时为两 preset 行写 `disabled: true`，会话角色为 `unknown`；`shud-jobs` 行配置扩展采集键（`stackRepos`、`sundialsRoot`、`hostVersion`、`llm.base_url`/`request_alias`），`profile:install` 写入、`profile:smoke` 断言随之更新。
- 首个子 issue 为限时 K13 spike，验证 O1/O2/O3/O5/O6：worker 子代理提交的 shud 作业唤醒以哪种方式送达（O1）、`tools/pre-execute` 新监听与 `auto-review`/hooks 的顺序（O2）、preset `plugins` 子树内插件行在 apply 时调 `restrict` 可行且全局 shud 工具名已注册（O3）、工具执行上下文能否取得 `approval/asked.id`（O5）、根会话与派生 worker 的 `session.header.agentPreset` 可读（O6）；收尾于 Web 内 coordinator 建卡并派 worker 跑 ccw。为此最小切片先行：`TaskId` + TaskCard schema（3.1a）与只建卡的最小 `task_create`（6.1a），spike 中 `shud_run` 不带 `task_id`。
- 实现组之前的独立文档任务组对齐约 20 条 spec 漂移（Task_Playbooks `ctx.storage`、Workspace_Conventions 目录与 HTML 残留、Minimal_Schemas id/引用与既有 PiGateDecision 段改写、Report_Generation_Spec HTML/API 残留与 §5.2 配置措辞、§7.1 导出 manifest（标注 M4）、Gating API 422/403、Port_List、role-tool-map 旧 id、Spec_Gaps_Register GAP-01/04/05）。
- PI 功能验收在 Epic 收口时统一进行（新决策记录，沿 ADR-0005/0007 模式）；metrics/水量平衡生产者不在本 change（#422，挂 M5）。

## Capabilities

### New Capabilities

- `task-cards`: TaskCard 的品牌 id、字段、状态机转换表、closure 谓词（science_assist）与工作区文件持久化；`task_create` 工具契约。
- `data-provenance`: DataProvenance 的品牌 id、字段与由运行输入副本确定性生成的采集规则及持久化。
- `evidence-reports`: EvidenceReport 的字段、7 态状态机、Markdown 模板与水印、禁止用语/不变式常量、确定性 validator、引用存在性校验、`report_generate`/`report_validate`/`report_submit`/`report_decide` 工具契约与 PiGateDecision 记录（`{decision_id, report_id, approval_ref, outcome, comment, decided_at}`）。
- `policy-gate`: `tools/pre-execute` 治理插件——`role-tool-surface` deny 先于 `report_submit`/`report_decide` 的 ask、fail-closed 审批结果处理与 PI comment 对话承载规则（`report_decide(report_id, disposition, comment)`）。
- `agent-presets`: coordinator/worker preset 行与显式子树、`role-tool-map` 两集合角色工具面与 restrict、子代理深度与首任务编排流程。

### Modified Capabilities

- `stack-lock`: `llm` 三字段、`repos.<name>.dirty_paths`、指纹排除 `response_model`、最小 `runtime`、品牌 `stack_id`、确定性采集入口与工作区持久化。
- `run-records`: RunJob/RunRecord 的 `task_id`/`stack_id`/`data_id` 在提交时写入（保持 nullable）；Minimal_Schemas 处置更新。
- `shud-run-tools`: `shud_run` 新增可选 `task_id`；提交时复用或采集 StackLock、生成 DataProvenance，并回写 TaskCard 链接。
- `shud-profile`: 挂载新插件行与 preset 行，subagent 行保持宿主平面；`profile:install`/`profile:smoke` 断言更新。
- `engineering-gates`: `policy-gate-core` 行数基线移除（≤1000）、knip `duplicates` 转 error、措辞规则由 review_only 转为测试常量。

## Impact

- 代码：`packages/dsh-shud-core/src/schemas/`、`src/governance/`（Critical Path #1/#7）；新包 `packages/dsh-shud-records`、`packages/dsh-shud-policy-gate`、`packages/dsh-shud-presets`；`packages/dsh-shud-tools`；`packages/dsh-shud-jobs`（提交时复用/采集 lock、生成 provenance，Critical Path #4 局部）；`profile/shud/`；`scripts/runtime/profile-install.sh`、`profile-smoke.sh`；`constraints.yaml` baseline/review_only；`knip.json`；`eslint.config.mjs`（如需放宽 `@deepseek-ai/dsh-agent-preset` 等运行时 import，走独立决策记录）。
- 审批 seam 结果处理（Critical Path #3）、报告语言护栏与水印（#6）、schema 投影（#7）须 reviewer 白盒审查。
- 文档：`docs/03_SPEC/Minimal_Schemas.md`、`Report_Generation_Spec.md`、`PI_Decision_Comments_Spec.md` §7、`Workspace_Conventions.md`、`docs/04_IMPLEMENTATION/{Phased_Plan,Port_List,Task_Playbooks,Repository_Layout,Testing_Strategy,Test_Fixtures_And_Command_Matrix}.md`、`CONTEXT.md`（K4 两态并存解除、新增不变量伴生）、`openspec/glossary.md`、`instructions/agents/*`（经 `instructions:render`）、`docs/generated/`；两份决策记录（PI comment 对话承载、M3 Epic 验收）。
- 依赖：不引入第三方新依赖、不引入 R 依赖；dsh 保持钉 `0.2.1-rc.2`（#420）。
- 运行时：新增模型工具 5 个（`task_create`、`report_generate`、`report_validate`、`report_submit`、`report_decide`）与 pre-execute 第二个监听；SHUD 运行路径不变；单用户工作台边界下不对 `reports/` 做 bash 写保护（设计 Non-Goal）。
