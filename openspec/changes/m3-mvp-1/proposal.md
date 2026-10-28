# Proposal

## Issue #424 fixture

Issue type: feature. Fixture level: expanded. Upstream suggested level: expanded (agree).
Blast radius: core TaskCard parsing, public identifier generation, generated schema consumers.
Selected risk packs: Public API; Schema; Legacy compatibility; Documentation.
Evidence floor: branded-id and TaskCard positive/negative tests, unchanged JOB/RUN pairing tests, runtime schema smoke, `pnpm run schema:check`, `pnpm run check`, Critical Path #7 white-box review.
Only task 3.1a is implemented by #424; the remaining M3 tasks and PI acceptance remain open.

## Issue #425 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: model-facing task creation, caller attribution and workspace file safety.
Selected risk packs: Public API; File IO/path safety; Schema; Auth/permissions; Concurrency/ordering; Error handling; Legacy compatibility; Documentation.
Evidence floor: real ToolRuntime/temporary-filesystem positive and negative tests, direct tool smoke, `pnpm run check`, `pnpm run profile:smoke`, white-box review.
Only task 6.1a is selected; no records package, report tools, task/job reconciliation or profile changes.

## Issue #430 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: public StackLock schema/types, read-only git revision collection, fingerprints and generated examples.
Selected risk packs: Public API; File IO/path safety; Schema; Auth/permissions; Resource limits; Legacy compatibility; Error handling; Documentation.
Evidence floor: test-first schema/revision/fingerprint cases, independent fixed-vector hash, real temporary-git smoke, generated-example parse, schema drift and full `pnpm run check`, Critical Path #7 white-box review.
Only task 3.1b is selected. PI approved migrating only the StackLock `exampleOverrides` in `scripts/schema/registry.ts` beyond the original boundary (issue comment 6464490698); generator behavior and validation stay unchanged.

## Issue #431 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: public DataProvenance schema/type, generated examples and strict-object generator self-checks.
Selected risk packs: Public API; File IO/path metadata; Schema; Legacy compatibility/examples; Error handling; Documentation.
Evidence floor: schema red/green cases, compiler-owned DataId field assertions, generated-example round trip, open-record rejection self-test, direct Node schema smoke and `pnpm run check`, Critical Path #7 white-box review.
Only task 3.1c is selected. PI approved DataProvenance registry exampleOverrides (6465754667), its field assertions in existing run-identifiers.typecheck.ts (6467078388), and removing only yamlLines' unused export keyword in scripts/schema/render.ts (6469406828); no compiler/generator relaxation.

## Issue #432 fixture

Issue type: feature. Fixture level: expanded (agree with upstream; Critical Paths #6/#7).
Blast radius: new public EvidenceReport/PiGateDecision schemas and types, schema registry/projections, canonical decision fields and their existing documentation projection.
Selected risk packs: Public API; Schema; Legacy compatibility/examples; Error handling; Documentation; scientific governance/evidence lineage (schema boundary only).
Evidence floor: parent-mediated red/green runtime and compiler field tests, real generated-example parsing, schema drift/default check, direct built public API smoke and white-box review.
Only task 3.1d is selected. PI approved bounded additions to the existing compiler fixture and removal of the contradictory optional decision_history extension declaration (6470602398). Registry registration and public schema barrel are required integration, not a new generator implementation.

## Why

M3 的用户可见步骤是"从任务卡到 Markdown 证据报告，含 PI 审批"（`docs/04_IMPLEMENTATION/Phased_Plan.md` §0 M3 行、§3）：首任务 "ccw 运行 → RunRecord → EvidenceReport" 端到端跑通，报告含 StackLock 三字段与响应 model，措辞过治理四条不变式。M2 已于 2026-10-27 通过 PI 验收（#318，ADR-0007），运行主链（`shud_run` → durable JobRegistry → RunRecord → 唤醒）就绪，但 M3 的四个对象（TaskCard、StackLock 三字段、DataProvenance、EvidenceReport）在代码里要么不存在、要么仍是 Zero 时代的旧字段（`docs/04_IMPLEMENTATION/Port_List.md`）；`policy-gate-core` 零消费者、profile 无 agent preset、`approval` seam 没有 PI comment 字段（ADR-0004 附录 ⑫）。M2→M3 边界升级评估（#420）确认钉版 rc.2 的 seam 事实在 rc.4 不变，设计据此冻结。

## What Changes

- `@shud-harness/dsh-shud-core`：新增 EvidenceReport 与 PiGateDecision Zod schema；TaskCard/StackLock/DataProvenance 对齐——品牌 id `TASK-/STACK-/DATA-/REPORT-<UTC>-xxxx`（复用 run-identifiers 生成器），`StackLock.llm` 收窄为 `base_url`/`request_alias`/`response_model` 三字段并排除 `response_model` 出指纹，`repos.<name>` 新增 `dirty_paths`，`StackLock.runtime` 最小化为 `os`/`sundials_version`/`host_version`、`harness` 为 `{version}`（可确定项必填，其余删除：无采集者的字段不保留）；TaskCard 状态机转换表与 closure 谓词为纯函数；新增 `governance/wording.ts`（禁止用语与四条不变式常量 + 测试）；`policy-gate-core` 拆分到 ≤1000 行，删除与 dsh 原生 `maxDepth`/`maxActiveSubagents`/preset 子集语义重复的 spawn depth/concurrency/profile-subset 三条规则，保留参数校验框架与 `raw-data-write` 保留 id，新增唯一默认 deny 规则 `role-tool-surface`；去掉 `isReservedAuthorityPolicyEvidenceId` 别名、knip `duplicates` 转 error。`pnpm run schema:generate` 刷新 `docs/generated/`，`docs/03_SPEC/Minimal_Schemas.md` 随之修订。
- 新包 `@shud-harness/dsh-shud-records`：四个对象在会话工作区的文件持久化（`tasks/<task_id>/task.json`、`stacks/<stack_id>.json`、`provenance/<data_id>.json`、`reports/<report_id>.{md,json}`，原子写，不经 `ctx.storage`、无 stateDir 索引）；StackLock 确定性采集（三 submodule 版本 + dirty_paths + llm 三字段 + 最小 runtime）；DataProvenance 由复制后的输入文件 sha256 生成；EvidenceReport 模板填充（10 节、7 态水印）、确定性 validator（12 项 (D) + 语言护栏 + 四句不变式逐字出现 + 第 13 项 `sk-` 密钥形态扫描）与状态机；目录与目标文件 `lstat` 校验、品牌 id 先校验后拼路径。
- `@shud-harness/dsh-shud-tools`：`shud_run` 新增可选 `task_id`，提交时注册表复用指纹相等的当前 StackLock（无则确定性采集新 lock）、由输入副本生成新 DataProvenance，写入 RunJob 的 `task_id`/`stack_id`/`data_id`（schema 保持 nullable，M2 记录仍可读）；新增 5 个模型工具 `task_create`、`report_generate`（coordinator 以参数提供 summary/observations/limitations/pi_questions，工具做引用存在性校验与模板填充）、`report_validate`（draft→reviewed）、`report_submit`（审批卡放行即 accepted）、`report_decide`（PI 拒绝后由 coordinator 转述 comment 与处置，二次审批卡放行即 rejected/revision_requested）；终态只在审批 `allowed-once` 分支写入，`awaiting_pi` 为审批卡挂起时的瞬时态不落盘。
- 新包 `@shud-harness/dsh-shud-policy-gate`：先用当前 preset 投影与 role-tool-surface 执行 deny，再对 report_submit/report_decide 无条件 ask，其余 next。PI 拒绝 submit 后 coordinator 索要 comment 与明确处置，decide 二次卡回显，allowed-once 才写非 accepted 终态；缺 comment 不写（GR-003）。O5 已确认 approval_ref 固定为本次 exec.callId，审计由 session log 的 asked.callId/id 与 decided.id 关联，不记录先前被拒卡的字段。
- 新包 `@shud-harness/dsh-shud-presets`：两份 coordinator/worker prompt；全局生命周期插件 shud-role-restrict 经 agent.ctx 限制工具，并在 committed preset 选择事件后重绑。role-tool-map 单一来源改为 `{inherited, local}`：前者含 SHUD 全局工具与 preset job_*，后者仅 coordinator 的 agent-owned subagent；restrict 取 inherited，policy-gate 取并集。实际角色工具面不变，原 global/preset 分类已被 O3 运行证据否定。worker 仍须等待运行终态且已收集，再返回 run_id 与终态供 coordinator 报告。
- profile：挂载 shud-policy-gate、全局 shud-role-restrict、两 preset 行。preset 子树不挂 restrict；coordinator tool-subagent 显式 agentPreset: worker、modelSelectionSettings: false；两 agent-instructions 按钉版必填 maxBytes 配置。subagent 注册表/provider 保持宿主平面且各一次。headless 安装禁用两 preset 行、无默认 preset 设置，unknown 不受角色限制。采集配置键仍由 profile:install 写入唯一 shud-jobs 用户项并经 profile:smoke 校验。
- K13 spike 在 #424/#425 合入后已实测 Web coordinator 建卡并派真实 worker 跑 ccw，不带 task_id。O1 为 worker owner、SHUD 唤醒 unreachable，但 worker 等待/收集及 coordinator 收集均成功；O2 为实测 raw-guard 先于第二监听器，组合未挂 auto-review/hooks；O3 经停止回报与 PI 重开后采用上述 inherited/local 划分及全局绑定；O5 固定 callId；O6 使用当前会话投影，不以创建 header 判断切换后角色。证据记录于 Migration_Plan_dsh，受影响规格经复审后才进入后续切片；不代表首任务报告或 PI 功能验收。
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
