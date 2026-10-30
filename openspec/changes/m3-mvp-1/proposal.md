# Proposal

## Issue #447 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Paths #2/#3/#6.
Blast radius: PI-gated terminal report writes, decision provenance, TaskCard terminal projection, asynchronous Markdown publication and raw-first admission.
Selected risk packs: Public API; File IO/path safety; Schema/identity; Auth/permissions/secrets; Concurrency/ordering; Error handling/partial outputs; Legacy compatibility; Documentation.
Evidence floor: test-first actual ToolRuntime with mounted policy/raw and approval boundary doubles, both terminal tools and all non-allowed outcomes, exact callId history, partial commits/repair/concurrent publication, built ccw→report→PI-gated decision smoke, full check/strict/ADR/profile/raw probes and three-seat review.
Only task 6.3 is selected. PI issuecomment6525339104 extends the original boundary only for raw-guard routing/tests/spec of these two tools. O5 issuecomment6463590574 fixes approval_ref to exec.callId. No policy-gate/records/jobs/core production changes, presets, host changes, #481 or centralized PI acceptance.

## Issue #446 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Paths #2/#3/#4/#6.
Blast radius: model-visible report generation/validation, report/card/Markdown commit order and repair, safe workspace IO, retained collection-failure evidence and raw-target admission.
Selected risk packs: Public API; File IO/path safety; Schema/identity; Auth/raw protection/secrets; Concurrency/ordering; Error handling/partial outputs; Legacy compatibility; Release/dependency compatibility; Documentation.
Evidence floor: test-first actual ToolRuntime report lifecycle and failure/repair controls, retained exhausted ledger with successful cached RunRecord, no-side-effect citation checks, raw-target deny before execution, built real ccw→report→validate proof, full check/strict/profile/raw probes and three-seat review.
Only task 6.2 is selected. PI issuecomment6522484479 authorizes minimal records/jobs/raw-guard seams, state/citation rejection before reconcile, independently committed entry repairs, and rejection of illegal TaskCard repair transitions. PI issuecomment6523542892 additionally authorizes explicit collectShud readonly mode so report evidence retrieval cannot generate or journal files. Terminal report tools, presets, task_create raw protection and PI functional acceptance remain separate issues.

## Issue #445 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Paths #2/#3/#4.
Blast radius: optional model-tool task linkage, synchronous TaskCard reconciliation/write-back around durable submission, and raw admission for the new task target.
Selected risk packs: Public API; File IO/path safety; Schema/identity; Auth/raw protection; Concurrency/ordering; Error handling/partial outputs; Legacy compatibility; Documentation.
Evidence floor: test-first actual ToolRuntime task linkage/failed-write durability/recovery/concurrency, raw-task target semantic RED/GREEN and no-task controls, canonical helper reuse, preserved old oracles, independent built tool with real ccw copied inputs, full check/strict/profile and raw-guard probes.
Only task 6.1b is selected. PI approved raw-guard decision/tests/spec expansion (issuecomment6519539604) and clarified non-runnable rejection before reconciliation plus retention of committed reconciliation after new-submit failure (issuecomment6519965712). No jobs/records/core production, dependency/profile/preset changes or #481 task_create protection.

## Issue #444 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Paths #1/#3/#5.
Blast radius: global tool authorization/approval waterfall, current preset attribution, report approval presentation and redacted diagnostics, production bundle importability.
Selected risk packs: Public API; Config/project setup; File IO/path safety; Schema/identity; Auth/permissions/secrets; Concurrency/ordering; Legacy compatibility; Error handling; Release/dependency compatibility; Documentation.
Evidence floor: test-first current-projection cutover and real Cordis/ToolRuntime deny/ask/delegation controls; canonical report-reader path negatives; host approval fail-closed outcomes; raw-guard composition attribution; logger redaction/counts; built public plugin smoke, Web/headless profile installation/import plus smoke negative controls; full check/strict and three-seat review.
Only task 7.1 is selected. New policy package, core unique caller reader/mapping and exports/tests, task_create attribution tests per issue comment6463590022, bundle/dependency/knip/lock and profile-smoke. No core policy-table/raw-guard/records/jobs production changes, actual report tools, presets/restrict, new logging outlet or PI acceptance.

## Issue #453 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Path #4.
Blast radius: readonly indexed RunJob query, full-record validation and registry admission/drain lifetime.
Selected risk packs: Public API; File IO/path safety; Schema/identity; Concurrency/shared state/ordering; Error handling/controlled disclosure; Legacy compatibility; Documentation.
Evidence floor: real registry API test-first RED/GREEN, both-index filtering/sorting, invalid-id no-read, unrelated corrupt-entry fail-closed, duplicate migration window, startup/closing/accepted-read lifetime controls, immutable file snapshots, built public query and compiler consumers, check/strict/instructions/profile smoke.
Only task 5.2 is selected. Jobs source/tests and shared Runtime Lifecycle/generated instructions; no tools/records/core/installer/profile/raw-guard/dependency changes or new model tool.

## Issue #443 fixture

Issue type: feature. Fixture level: expanded (agree with upstream); Critical Paths #2/#4 after the PI-approved review amendment.
Blast radius: jobs submission transaction/rollback, workspace evidence ownership, registry configuration and production profile installation.
Selected risk packs: Public API/CLI; Config/project setup; File IO/path safety; Schema/identity; Auth/permissions and Secrets/diagnostics; Concurrency/ordering; Error handling/rollback; Legacy compatibility; Release/dependency compatibility; Documentation.
Evidence floor: semantic RED before production edits; actual registry/config/submit/rollback/collect consumers, independent copied-input hashes and first-created ordering, installer byte/idempotence/negative controls, default check, strict validation, instructions check, profile smoke, real SHUD tiny and Web SIGTERM/SIGKILL restart, three-seat white-box review.
Only task 5.1 is selected. Keep records implementations, core schemas, bundle rows and profile-install.sh unchanged; the existing records dependency and installer precheck suffice. Task query/TaskCard writes/presets remain downstream issues. After executable confirmation of raw-write bypass and original-input overlap, PI selected “扩展 #443 边界” in this conversation: additionally allow raw-guard's shud_run decision/tests and the actual guarded-tool regression test, with a raw-data-guard delta. No tools production change or duplicated jobs-side raw policy.

## Issue #442 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: records pure report transitions/decision history, report-to-task status projection and repair predicate.
Selected risk packs: Public API; State transitions/ordering; Schema/identity/time; Scientific governance/approval boundary; Controlled diagnostics; Legacy compatibility; Documentation.
Evidence floor: independent seven-state transition/decision matrices, strict decision/comment/identity negatives, frozen inputs and clock ownership, complete status mapping and last-link repair controls, direct built lifecycle/predicate and real compiler consumers, default check/strict/profile and three-seat white-box review.
Only task 4.4c is selected. No validator execution, report rendering, file publication, TaskCard mutation, approval seam, tool, core schema or configuration change.

## Issue #441 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: records deterministic report validation and package-internal reuse of the canonical renderer's evidence/section provenance.
Selected risk packs: Public API; Scientific governance; Secrets/error disclosure; File IO/path safety; Schema/identity; Determinism/ordering; Legacy compatibility; Documentation.
Evidence floor: independent thirteen-check table, positive/negative controls for every non-vacuous clause, no-state/file-mutation evidence, actual fresh rendering with template-asset fault controls, authored-heading spoof controls, multi-section secret non-disclosure, existing renderer golden unchanged, built public API and real compiler consumers, default check/strict/profile and three-seat white-box review.
Only task 4.4b is selected. No report-state transition, publication, approval, tool, core schema/wording, runtime configuration or dependency change. Minimal internal renderer reuse may expose template-owned section provenance without changing #440 output or its public API.

## Issue #440 fixture

Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: records report rendering, workspace reference reads, deterministic facts, scientific governance watermarks and packaged template.
Selected risk packs: Public API; File IO/path safety; Schema/identity provenance; Scientific governance/watermarks; Secrets/error diagnostics; Determinism/ordering; Packaging; Legacy compatibility; Documentation.
Evidence floor: fixed successful/failed-run dirty-stack rendering snapshot, independent watermark table, fresh-read and missing/corrupt/unsafe-reference controls, literal governance text, exact aggregate facts, no log/artifact reads, stale-header controls, built temporary-workspace Markdown inspection, real packed-template consumer, compiler checks, default check/profile smoke and three-seat white-box review.
Packed-consumer evidence retains the existing canonical harness-root manifest layout; it proves tarball template inclusion/use from unrelated cwd, not standalone package relocation support (design #440).
Only task 4.4a is selected. Validator/state decisions/tools/approvals remain #441/#442/#446/#447; no core/jobs schema or configuration change.

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

## Issue #433 fixture

Issue type: feature. Fixture level: expanded (agree with upstream; Critical Path #6).
Blast radius: public deterministic wording constants/scanner and their blocking control-plane registration.
Selected risk packs: Public API; Config/control-plane registration; Error handling; Documentation; scientific governance/secrets shape.
Evidence floor: parent-mediated scanner red/green, all ten literal phrase/overlap/field and regex boundaries, generated instruction drift, direct built public API smoke, full check and white-box review.
Only task 3.2 is selected. No renderer/validator/preset integration or semantic-compliance claim. Core root barrel addition is the required export path for the requested public constants/API.

## Issue #434 fixture

Issue type: refactor. Fixture level: expanded (agree with upstream; Critical Path #1).
Blast radius: public policy evaluator, hostile decision/input snapshots, reserved authority identity, spawn rules and file/type safety gates.
Selected risk packs: Public API; Config/control-plane; Schema/input metadata; Auth/permissions; Resource limits; Legacy compatibility; Error handling; Documentation.
Evidence floor: accepted reference tests GREEN, parent-owned public API parity oracle qualified against a deny-to-allow mutant, unchanged decision-table expectations, strengthened lint/size gates, full check/guardrails and white-box review.
Only task 3.3a is selected. PI approved two documentation rows plus normal instruction rendering (6484832659). Spawn/alias deletion belongs to #435, role-tool-surface to #436; neither is included here.

## Issue #435 fixture

Issue type: refactor/clean cutover. Fixture level: expanded (agree with upstream; Critical Path #1 and bounded jobs export integration).
Blast radius: obsolete spawn API removal, retained authority evaluator, duplicate-export gate and unchanged jobs public plugin identity.
Selected risk packs: Public API; Config/control-plane; Auth/permissions; Legacy compatibility; Error handling; Documentation; package integration.
Evidence floor: retained evaluator regression parity, active-source removal audit, duplicate-gate negative control then clean pass, jobs default/named identity plus actual profile smoke, full check/guardrails and white-box review.
Only task 3.3b is selected. PI approved jobs export declarations (6488512616) and two current-state documentation rows plus normal rendering (6490581206); no registration lifecycle or new role rule is authorized.

## Issue #436 fixture

Issue type: feature. Fixture level: expanded (agree with upstream; Critical Path #1).
Blast radius: canonical role/tool map public shape and authority decision table; no host seam mounting.
Selected risk packs: Public API; Auth/permissions; Schema/tool-name contract; Legacy compatibility; Error handling; Documentation.
Evidence floor: semantic RED at existing evaluator/map boundaries, exhaustive finite M3 role/tool decision table, unchanged M4 inventory, no-input-access denial, reserved-id downgrade checks, direct built API smoke and full check/white-box review.
Only task 3.3c is selected. Use reviewed inherited/local design, not superseded issue global/preset wording (6463589546). PI approved only the Port_List policy row beyond code scope (6495996803).

## Issue #437 fixture

Issue type: refactor + file-layer feature. Fixture level: expanded (agree with upstream; Critical Paths #2/#5 and shared durable writer migration).
Blast radius: every jobs atomic-file consumer and fault-injection seam, tools task_create allocation, four workspace object layouts, workspace dependency graph.
Selected risk packs: Public API; Config/project setup; File IO/path safety/overwrite; Schema; Secrets; Concurrency/ordering; Legacy compatibility; Error handling/rollback; Packaging/dependencies; Documentation.
Evidence floor: unchanged jobs/tools assertions and atomic primitive semantics, semantic path-safety/collision/failure tests, real temporary-filesystem smoke, package build/default check and pinned-host profile smoke, three-seat white-box review.
Only task 4.1 is selected. StackLock capture/exclusive creation, provenance generation, transitions, report rendering/validation and tools integration remain later issues. No profile dependency or external runtime dependency is added.

## Issue #438 fixture

Issue type: feature. Fixture level: expanded (agree with upstream; Critical Path #5 and immutable persistence/path safety).
Blast radius: deterministic environment snapshots, immutable lock reuse/exclusive creation, copied-input byte inventory and provenance publication.
Selected risk packs: Public API; Config/input contract; File IO/path safety/overwrite; Schema/field provenance; Secrets; Concurrency/ordering; Resource limits/discovery; Legacy compatibility; Error handling/partial output; Documentation.
Evidence floor: real temporary Git repositories, fixed independent SHA-256 vectors, immutable reuse/mtime and collision/error controls, copied-versus-original input proof, direct built API smoke, full check and white-box review.
Only task 4.2 is selected; code changes stay in records/src. Existing core collectors/fingerprint and records safety/allocation are reused. No jobs/profile/config installer wiring, new dependencies, report behavior or provenance deduplication.

## Issue #439 fixture

Issue type: feature. Fixture level: expanded (agree with upstream; TaskCard state/closure governance, Critical Path #6 and controlled diagnostics).
Blast radius: reachable TaskCard transitions, recovered job references, no-op write suppression contract and deterministic scientific-assist closure decisions.
Selected risk packs: Public API; Schema/identity/time; State transitions/ordering; Scientific governance; Secrets/error diagnostics; Legacy compatibility; Error handling; Documentation.
Evidence floor: independent complete state/event matrix, reconciliation order/null/reference/no-op cases, closure success and every blocking clause with job-specific diagnostics, mutation-free built API smoke, compiler/default gate and white-box review.
Only task 4.3 is selected, records/src only. No filesystem/registry/tool/approval wiring, new schema/dependency, report rendering or LLM closure classifier. Later callers own persistence and verified approval/closure event prerequisites.

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

- `raw-data-guard`: PI-approved #443 review repair extends the existing shud_run output-root check from runs to runs/stacks/provenance, preserving raw-input approval and denial precedence.
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
