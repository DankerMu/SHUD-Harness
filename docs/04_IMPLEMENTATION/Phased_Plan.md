---
status: living
canonical_for: [implementation-plan]
---

# 里程碑实施计划（M1–M9）

> **唯一真相源声明**：实施排期、交付切分、验收门、每里程碑必读清单，以本文为准。分工——
> spec 激活基线与阅读账 → [Phased_Spec_Activation.md](../Phased_Spec_Activation.md)（账本）；
> 现实锚定决策 → [ADR-0002](../adr/0002-mvp-reality-anchoring.md)；运行时基座 → [ADR-0001](../adr/0001-agent-runtime-and-topology.md)；
> 逐测试细目 → [Phase_By_Phase_Test_Plan.md](Phase_By_Phase_Test_Plan.md)（周标签经 §0 映射表解析）。
>
> 本文 2026-07-02 由"8 周实施计划"重写为里程碑制（ADR-0002 D8，PI 指令）；旧日历周版本见 git 历史。
> 重写同时吸收五路对齐审查修复：敏感性压缩（D5）、首任务回放主链（D3/D4）、`GET /api/patches/:id/diff`
> 方法修正、备胎表述随 ADR-0001 修订、新机制落点（remediation / guard_class / 注册 lint / eval 管道 /
> gardening / 降级三件套 / 金样准入 / GLM provider）。

## 0. 里程碑总览与映射

**排期语义（ADR-0002 D8）**：M1..M9 是弹性依赖门，无日历承诺；上一门全绿才进下一门；
每个 issue 按"单 agent-PR"尺寸切；实施记录（openspec changes）由 stage-change-pipeline 按本文重建，
逐里程碑先 grill 再动工。

| 里程碑 | 主题 | 账本 Phase | 旧周标签（测试文档沿用） |
|---|---|---|---|
| M1 | 就绪收口 + 骨架 + 策略门 spike + GLM provider | Phase 1 | W0 + W1 |
| M2 | 研究上下文：StackLock + DataProvenance | Phase 1 | W2 |
| M3 | 执行闭环：sandbox + RunJob + park/resume + WS | Phase 2 | W3 |
| M4 | 科学运行：ccw tiny + 首个 VerificationCase | Phase 3 | W4 |
| M5 | 变更主链：ChangeRequest + patch + 兼容性 | Phase 3 | W5 |
| M6 | 最小 OAT 敏感性（压缩口径） | Phase 4 | W6（按 D5 取舍） |
| M7 | 报告 + 审批 + 记忆 + 成本 + 通知 | Phase 5 | W7 + v0.8.1 sprint |
| M8 | GLM 接入 + eval 准入 + e2e | Phase 6 | W8 |
| M9 | **MVP 验收：openMP RHS 已知答案回放** | 全体系 | （新增，无旧周） |

配套测试文档（[Phase_By_Phase_Test_Plan.md](Phase_By_Phase_Test_Plan.md)、[Testing_Strategy.md](Testing_Strategy.md)、
[Test_Fixtures_And_Command_Matrix.md](Test_Fixtures_And_Command_Matrix.md)、[DOD_and_Risks.md](DOD_and_Risks.md)、
[MVP_Implementation_Readiness_Checklist.md](MVP_Implementation_Readiness_Checklist.md)）沿用 W0–W8 标签，按上表解析；
其中 W6 条目按 M6 压缩口径取舍（heatmap/DuckDB 相关测试出 MVP，见 M6）。
运维/性能测试细目宿主在 [Observability_Test_Plan.md](Observability_Test_Plan.md)（OBS-\*）与
[Performance_Test_Plan.md](Performance_Test_Plan.md)（PERF-\*），**不在 Test_Plan 的 W 节内**——随账本渐进文档
自 Phase 1 起激活，各里程碑验收门显式点名，勿因 W 节指针而漏做。

**通用必读基座**（每个里程碑都装载，下文不再重复）：账本「全程基座」（10 篇常驻 + 5 篇渐进）——
[Minimal_Schemas](../03_SPEC/Minimal_Schemas.md)、[Support_Schema_Contracts](../03_SPEC/Support_Schema_Contracts.md)、
[CANONICAL_CONTRACTS](../00_INDEX/CANONICAL_CONTRACTS.md)、[Requirements_Catalog](../00_INDEX/Requirements_Catalog.md)、
[Schemas_APIs_CLIs](Schemas_APIs_CLIs.md)（API 端点唯一注册表）等，以及账本"渐进文档"按各自标注激活。

**里程碑切换仪式**：进入 M(n+1) 前执行账本"对齐检查点操作流程"（回顾 → 修正 → 预读 → 调整），
并对 M(n+1) 的实施记录做 grill。

**不变式（全程）**：secrets 不进 RunRecord/报告/git；agent 不作科学结论判断（Research_Constitution）；
高风险科学变更不绕过 PI gate。

---

## M1：就绪收口 + 骨架 + 策略门 spike + GLM provider

**目标**：可持续施工的地基——monorepo 骨架 + TaskCard 最小链路 + 中央策略门可行性判定（ADR-0001
触发器）+ 唯一运行时模型接通（D9）。此后不再做架构判断。

**前置（M1 grill）**：✅ 已完成（2026-07-03，七项议程全部定案，记录见
[ADR-0002 开放项处置节](../adr/0002-mvp-reality-anchoring.md)，实施记录 = openspec change `m1-foundation`）——
① 四开放项：回放切片 = 单 PR 尺寸 + openMP pin/基线体系 + keliya（具体 PR M9 备料时选）；预算三档
call 数不动、USD 由冒烟实测换算（M7 校准写回）；SMTP = Gmail 应用密码自发自收；eval plan B = 分层
递进（提示工程 → 治理节点切强模型 → 换供应商）。② 开工三决：zero 不 fork（submodule 钉 13e25c1
相对引用，fork 挂 ADR-0001 触发器）、role→tool_id 工具面照准（快照基准入 packages/core）、GLM key =
`GLM_API_KEY`。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [ADR-0002](../adr/0002-mvp-reality-anchoring.md) | D1/D2/D8/D9 + 开放项清单 |
| [ADR-0001](../adr/0001-agent-runtime-and-topology.md) + 2026-07-02 修订注 | spike 判定；备胎顺序 = ① 自建薄工具注册层 ② Claude Agent SDK（仅回 Anthropic 生态时） |
| [Control_Kernel](../02_ARCHITECTURE/Control_Kernel.md) §5 / §5.2 / §5.3 | 策略门注入点与拒绝载荷、guard_class 分类、工具面治理（注册 lint 本里程碑落地） |
| [Zero_Reuse_Matrix](../02_ARCHITECTURE/Zero_Reuse_Matrix.md) §3 | 扩展层标注 + Provider 配置行（GLM 接入即配置） |
| [Repository_Layout](Repository_Layout.md) · [Workspace_Conventions](../03_SPEC/Workspace_Conventions.md) | Monorepo 目录 + 路径体系 |
| [Support_Schema_Contracts](../03_SPEC/Support_Schema_Contracts.md) §3 | ErrorRecord.remediation（拒绝即教学） |
| [Config_Secrets_And_Environment_Spec](../03_SPEC/Config_Secrets_And_Environment_Spec.md) §3 | SecretRef / `api_key_ref` 形态与环境变量约定（GLM key） |
| [API_Error_And_Idempotency_Contracts](API_Error_And_Idempotency_Contracts.md) | 错误 envelope + 幂等 |
| [MVP_Implementation_Readiness_Checklist](MVP_Implementation_Readiness_Checklist.md) | P0 开工门禁（原 W0 并入本里程碑前置） |
| 账本 [Phase 1 激活表](../Phased_Spec_Activation.md) | 其余：UI_Implementation、Interaction_Model、Data_Storage_Provenance 等 |

**交付（issue 粒度）**：

- 就绪收口（原 W0 十项：gitmodules parser 检查、CANONICAL/索引检查、link check 与 schema generation 脚本入库、readiness YAML（落 `workspace/readiness/`，Workspace_Conventions §4 补充目录已同步）、packageManager/lockfile、initial DependencyLock、health live/ready skeleton contract 等。切分：按 Readiness_Checklist P0 Gate 表逐 Gate 切 issue，校验类可合并；schema generation 脚本单列——它是投影副本转生成物的前置）
- **SHUD `make` 复验**（D2：本机曾编译跑通，一次复验并记录环境快照）+ rSHUD 2.5.0 在位确认
- **GLM provider 配置**（D9：zero `providers:` 块——`api_type: openai_chat_completions` + `base_url` + `api_key_ref` + `fallback_chain` + 按功能选模型；`api_key_ref` 形态遵 Config_Secrets §3，变量名 M1 grill 定；一次连通冒烟。正式准入门在 M8 金样 eval）
- Bun workspace monorepo（packages/core + backend + frontend——包名以 [CANONICAL_CONTRACTS](../00_INDEX/CANONICAL_CONTRACTS.md) §1 / Repository_Layout 为准）；zero 以根目录 submodule 相对引用（M1 不 fork，见前置②）
- core Zod schema：TaskCard、Artifact、ErrorRecord（**含 remediation 结构**）、IdempotencyRecord、LockRecord
- Hono 后端：`POST /api/workspace/init`、`POST/GET /api/tasks`、`GET /api/tasks/:id`、API error envelope、idempotency/lock service skeleton、task snapshot read/write
- React 四栏壳：WorkbenchLayout（SideNav + AgentFeed + Experiment + Results）、Dashboard、ExperimentHeader、StatusBar。切分参考：WorkbenchLayout 骨架 / Dashboard 页 / ExperimentHeader+StatusBar 三个 issue，子组件占位即可，数据接线随后续里程碑
- workspace 文件树自动生成 + Artifact registry skeleton
- **策略门 spike**（下述五条）
- **工具注册期 lint**（Control_Kernel §5.3：单角色 ≤20 工具 + 描述完整性（何时用/不用、成功失败样态）+ 参数 Zod 校验；与策略门同一横切点，负例测试）
- **硬护栏 guard_class 标注**（Control_Kernel §5.2：每条 guard 标 `authority | capability`，为换代减重审查留数据基础）
- **role→tool_id canonical 映射表**（把 Roles_and_Boundaries §0 权限类别展开为各角色具体工具 ID 集合，落 packages/core 常量 + 快照测试；spike 第 3 条子集校验的比对基准，工具面经 M1 grill PI 确认）

内部顺序：spike 第 1 条（横切包装）先行，注册 lint 与 guard_class 标注挂其后同一横切点。

**策略门 spike（五条全绿才过；ADR-0001 触发器 1 的判定标准）**：

1. 工具注册层中央策略门对**全部**工具调用生效（含 spawn/bash/edit；`ToolBase.beforeExecute` 包装或注册 wrap，拦截即返回工具错误，不改 Zero 内核）；
2. 一条治理规则端到端穿透：路径写禁区（如 `data/raw/**`）在 bash 工具真实执行前被拒，**拒绝错误体含 `remediation{next_action, hint, ref}`**（Control_Kernel §5 拒绝载荷约定），拒绝事件出 WebSocket 并落 AuditEvent；
3. spawn 剖面校验负例：传入超集 allowed_tools 的 spawn 被拒（Control_Kernel §5；比对基准 = 本里程碑交付的 role→tool_id 映射表），**断言 remediation.next_action = adjust_scope**；
4. 策略门有独立单测（纯函数：ToolCall → allow/deny + reason + remediation）；
5. 以上全部在 zero@13e25c1 上以 adapter/包装实现，Zero 源码 diff = 0。

spike 第 2 条对 WebSocket/AuditEvent 的依赖取 skeleton 深度即可（envelope 含 seq/event_id + audit 行落盘；
完整协议在 M3）。任一条在 2 人周内做不绿 → 触发 ADR-0001 revisit，备选评估顺序以 ADR-0001 2026-07-02
修订注为准（① 自建薄工具注册层 ② Claude Agent SDK 迁移），不带病继续。

**验收门**：浏览器打开四栏、可建任务、刷新后 snapshot 恢复；spike 五条绿；make 复验通过；GLM 冒烟 =
最小 prompt 一次往返得到非空 completion 且实际命中配置的 `base_url`，exit 0；注册 lint 负例生效。
测试细目：Test_Plan W0/W1 节 + Observability_Test_Plan（health / structured logs）+ Performance_Test_Plan（API metadata perf smoke）。

---

## M2：研究上下文——StackLock + DataProvenance

**目标**：任务可绑定完整版本链与数据溯源；Artifact registry 可记录 evidence_usable 产物。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Minimal_Schemas](../03_SPEC/Minimal_Schemas.md) StackLock/DataProvenance 节 | **llm 块含 `base_url` 必锁**（ADR-0002 D9：第三方端点防静默换版） |
| [Data_Storage_Provenance](../03_SPEC/Data_Storage_Provenance.md) | 存储分层、sha256、原始数据保护 |
| [Artifact_Registry_Spec](../03_SPEC/Artifact_Registry_Spec.md)（预读，Phase 3 正式激活） | Artifact 类型、evidence_usable、manifest |
| [Auth_Permission_Design](../03_SPEC/Auth_Permission_Design.md) + [User_Session_And_Audit_Schema](../03_SPEC/User_Session_And_Audit_Schema.md)（预读） | **按 D6 收缩：单账号 + localhost**；多角色 Session 层停用至第二个真实用户；agent 侧角色剖面不受影响 |

**交付（issue 粒度）**：

- `POST /api/stacks/lock`（自动采集 repo submodule commits + runtime versions 占位 + **llm: provider/model_id/base_url**）
- `POST /api/data/register`（path 校验 + sha256）+ renv.lock 集成
- Artifact registry service + ArtifactManifest read/write + `GET /api/artifacts/:artifactId/data` skeleton
- 单账号 + localhost 鉴权（D6 口径，不建多用户 Session 管理）
- 前端：ResearchContext（SideNav 内 StackLock + DataProvenance 摘要卡）、ArtifactRef、ExperimentHeader 完整化

**验收门**：一个 task 绑定 stack_id + data_id，SideNav 展示完整版本链（含 llm base_url）；
Artifact registry 记录 evidence_usable artifact。测试细目：Test_Plan W2 节。

---

## M3：执行闭环——sandbox + RunJob + park/resume + WebSocket

**目标**：dummy job 全链路：submit → sandbox 执行 → 实时推流 → collect 成 RunRecord → 服务重启可恢复。
**风险优先级（账本 Phase 2 同款）**：park→collect→resume→按 plan_cursor 接续的端到端原型是本里程碑
**第一个 issue**，先于 WebSocket 细节打磨——这是全系统技术风险最高点。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Execution_Jobs_Runs](../03_SPEC/Execution_Jobs_Runs.md) · [Runner_Adapter_Contracts](../03_SPEC/Runner_Adapter_Contracts.md) | RunJob 状态机、collect、runner 统一接口（**只做 local_direct/local_job；slurm 不实现，D1**） |
| [Park_Resume_Design](../03_SPEC/Park_Resume_Design.md) · [Workspace_Snapshot_And_Recovery_Spec](../03_SPEC/Workspace_Snapshot_And_Recovery_Spec.md) | ParkedState、watcher、restart recovery |
| [Sandbox_and_Executor](../03_SPEC/Sandbox_and_Executor.md) · [Idempotency_Concurrency_Locking_Spec](../03_SPEC/Idempotency_Concurrency_Locking_Spec.md) | 路径策略、命令审计、collect 幂等 |
| [WebSocket_Protocol](../03_SPEC/WebSocket_Protocol.md) · [Frontend_State_Design](../03_SPEC/Frontend_State_Design.md) | envelope、seq 单调、断线重连 |
| [Preflight_And_Mutation_Boundary_Spec](../03_SPEC/Preflight_And_Mutation_Boundary_Spec.md) | runner preflight 初版 + PreflightCheck.remediation |
| [Context_Trust_And_Injection_Spec](../03_SPEC/Context_Trust_And_Injection_Spec.md) | T0–T4 信任分级（Repo Explorer 上线即注入面打开）；§5.1 session digest 对象 |
| [Agent_Behavior_Eval_Spec](Agent_Behavior_Eval_Spec.md) | eval 管道空跑从本里程碑开始积累 golden 场景 |
| 账本 [Phase 2 激活表](../Phased_Spec_Activation.md) | 其余：Roles_and_Boundaries、Agent_Architecture、Error_Handling 等 |

**交付（issue 粒度）**：

- **park→collect→resume 端到端原型**（dummy job；plan_cursor 接续）
- Sandbox path policy + command trace + secret redaction
- local_direct / local_job runner adapter（slurm 适配器不实现，D1）
- `POST /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/collect`（幂等）
- WS `/ws/session/:sessionId`：envelope（event_id/seq/type/payload/created_at）、session event log、reconnect with since_seq
- Repo Explorer 角色定义 + 只读工具策略 + RepoContextBrief artifact 契约
- service restart recovery（uncollected terminal job 自动恢复）
- **eval 管道空跑骨架**（dummy fixture 驱动 + EVAL-REV-001/002/003 场景登记；全量运行在 M8 准入门）
- **session digest schema 占位**（Context_Trust §5.1；完整超预算收纳策略 defer 至首个长任务，此处仅对象落库 + EVAL-INJ-004 负例）
- 运维骨架：ops dashboard API skeleton、alert evaluator skeleton、log aggregation NDJSON、disk critical block new jobs
- 前端：AgentActivityFeed（多角色消息流）、RuntimeTerminal（实时日志）、RepoContextBrief 卡片、job status badge、error banner、WebSocket reconnect

**验收门**：dummy job 提交 → 实时日志 → collect 成 RunRecord → UI 展示；park→resume 原型走通；
服务重启恢复；sandbox 越界写被拒（含 remediation）。测试细目：Test_Plan W3 节。

---

## M4：科学运行——ccw tiny + 首个 VerificationCase

**目标**：真实 SHUD tiny case 跑通并出图；Theory-to-Code 治理链从最小 VerificationCase 起步。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [SHUD_Output_Variables](../03_SPEC/SHUD_Output_Variables.md) | 变量注册表、单位、NumericalHealth |
| [Artifact_Registry_Spec](../03_SPEC/Artifact_Registry_Spec.md) | 正式激活：类型、metadata、manifest |
| [Visualization_Data_Spec](../03_SPEC/Visualization_Data_Spec.md) | HydrographChart、ResultsOverview（**不含 heatmap**） |
| [Domain_CLI_Spec](../03_SPEC/Domain_CLI_Spec.md) | shud/metrics 命令组（build/run wrapper 即此 CLI） |
| [Memory_Skills_Lite](../03_SPEC/Memory_Skills_Lite.md) | 第一个 Skill：run-shud-tiny-case |
| [Theory_To_Code_Governance_Spec](../03_SPEC/Theory_To_Code_Governance_Spec.md) · [Verification_Case_Spec](../03_SPEC/Verification_Case_Spec.md) | T2C Phase 3 起步：最小 VerificationCase |
| [Research_Constitution](../02_ARCHITECTURE/Research_Constitution.md) | 禁止表述（单流域提升 ≠ 模型改进等） |
| 账本 [Phase 3 激活表](../Phased_Spec_Activation.md) | 本阶段全量清单 |
| 参考 | [SHUD_Codebase_Report](../01_CODEBASE/SHUD_Codebase_Report.md) · [rSHUD_Codebase_Report](../01_CODEBASE/rSHUD_Codebase_Report.md) |

**交付（issue 粒度）**：

- `run-shud-tiny-case` skill（deterministic script）：SHUD build wrapper + 30 天 ccw input patch（仅在 task workspace 内）+ run wrapper + output scan
- metrics / hydrograph series artifact + RunRecord numerical_health
- `GET /api/runs/:runId/variables`、`GET /api/runs/:runId/series`、`GET /api/runs/:id/metrics`、`GET /api/runs/:id/hydrograph`
- **VC-CCW-TINY-001**（case_type=tiny_basin；expected：exit_code=0 + WB residual 阈值 + 必需输出存在；挂 run_record_id 与 artifact_refs。实例 ID 为本计划命名，Verification_Case_Spec 未约定 ID 格式）
- 前端：HydrographChart（缩放/tooltip/多变量切换）、ResultsOverview（NSE/Peak Error/WB 指标卡）、variable selector、run artifact links

**验收门**：ccw tiny 编译 + 运行成功，water_balance_residual < 阈值，浏览器展示 rivqdown 过程线 + 指标卡；
VerificationCase 生成且可追溯。测试细目：Test_Plan W4 节。

---

## M5：变更主链——ChangeRequest + patch + 兼容性

**目标**：**这是 ADR-0002 D5 定义的 MVP 唯一主链**（ChangeRequest + VerificationCase）——**变更侧**治理
装置在此就位：代码变更 → diff → patch bundle → 风险分级 → **开 PiGate（gate 记录落库）** → 可审查证据；
PI 审批工作流（decision/comment/audit）在 M7 补齐。不是纯工程 diff 周。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Theory_To_Code_Governance_Spec](../03_SPEC/Theory_To_Code_Governance_Spec.md) · [Verification_Case_Spec](../03_SPEC/Verification_Case_Spec.md) | ChangeRequest↔VerificationCase 治理链（T2C Phase 3 主体） |
| [Theory_To_Code_API_Contracts](Theory_To_Code_API_Contracts.md) · [Theory_To_Code_Test_Plan](Theory_To_Code_Test_Plan.md) | T2C API 与测试契约（账本 Phase 3 追加激活） |
| [Scientific_Change_Gating_Spec](../03_SPEC/Scientific_Change_Gating_Spec.md)（预读，Phase 5 正式激活） | 高风险变更门规则 |
| [Minimal_Schemas](../03_SPEC/Minimal_Schemas.md) ChangeRequest 节 | 字段与风险分级 |
| 账本 [Phase 3 激活表](../Phased_Spec_Activation.md) | 本阶段全量清单 |
| 参考 | [rSHUD_Codebase_Report](../01_CODEBASE/rSHUD_Codebase_Report.md)（read_output 兼容面） |

**交付（issue 粒度）**：

- ChangeRequest Zod schema + 风险分级规则（high-risk → PiGate；additive compatible 不强制）
- **PiGate 最小 schema + 开 gate**（high-risk 判定触发 gate 记录落库、状态可查；decision API / comment 规则 / 审批 UI 在 M7）
- **patch bundle `status` 状态机**（`draft → in_review → accepted | accepted_for_search`；创建 = draft、开 gate = in_review、`accepted*` 由 M7 PiGate decision 写回；M6 preflight 仅读字段，fixture 可预置状态）
- `GET /api/patches/:id/diff`（**GET，非 PATCH**——以 [Schemas_APIs_CLIs](Schemas_APIs_CLIs.md) 注册表为准）+ `POST /api/patches/:id/bundle`（sha256）
- diff artifact + patch bundle artifact + compatibility check summary
- rSHUD read_output wrapper + old-output fixture + roundtrip test（reader 兼容性）
- 前端：DiffViewer、HydrographComparison（baseline vs experiment 差异带）、compatibility status card、patch bundle link

**验收门**：能发现 old-output reader 兼容性问题；变更生成可审查 patch bundle（含 `status` 字段）；high-risk
变更自动开 PiGate（gate 记录落库可查；decision 通路在 M7 验收）；diff 与对比过程线可视。测试细目：Test_Plan W5 节。

---

## M6：最小 OAT 敏感性（压缩口径）

**目标**：AnalysisPlan 对象 + batch 机制成立即可——**按 ADR-0002 D5 压缩为最小 OAT（3–5 run）**，
保 AnalysisPlan mode=sensitivity 与 batch 汇总，验证"敏感性一等公民"的对象模型，不建分析引擎。

**出 MVP（本里程碑不做，revisit = 首个真实敏感性研究任务）**：SensitivityHeatmap 组件、
`GET /api/analysis/:id/heatmap`、sensitivity_results.parquet/DuckDB 列存。配套测试文档 W6 中
heatmap shape / DuckDB fallback / 3×3 相关条目随之出 MVP。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Sensitivity_Calibration_Benchmark](../03_SPEC/Sensitivity_Calibration_Benchmark.md) + [Addendum](../03_SPEC/Sensitivity_Calibration_Benchmark_Addendum.md) | 三模式边界；batch 设计、stop_condition |
| [Parameter_Set_And_Analysis_Run_Mapping](../03_SPEC/Parameter_Set_And_Analysis_Run_Mapping.md) | PSET↔RunJob↔RunRecord 映射 |
| [Batch_Progress_View_Spec](../03_SPEC/Batch_Progress_View_Spec.md) | BatchProgressGrid 前端规格 |
| [Controlled_Search_Boundary_Spec](../03_SPEC/Controlled_Search_Boundary_Spec.md) | **仅 schema 占位（D5）**：`accepted_for_search` 状态检查保留为 AnalysisPlan preflight 一行判断，search 本体不实现 |
| [Research_Object_Model](../03_SPEC/Research_Object_Model.md) | AnalysisPlan 在对象模型中的位置 |
| 账本 [Phase 4 激活表](../Phased_Spec_Activation.md) | 本阶段全量清单 |

**交付（issue 粒度）**：

- AnalysisPlan mode=sensitivity + parameter_sets（**OAT 3–5 组**）
- batch parameter runner + ParameterSet↔RunJob↔RunRecord 映射 + 并发目录隔离
- analysis progress aggregate + progress artifact + `GET /api/analysis/:id/progress` + `GET /api/analysis/:id/parameters`
- **batch 汇总表 artifact**（sensitivity table；无 parquet/DuckDB，普通 artifact 即可）
- AnalysisPlan preflight：downstream of high-risk change → require bundle.status ∈ {accepted_for_search, accepted}；否则 improvement 主张 require baseline_run_id
- 前端：ParameterSetTable（排序/高亮）、BatchProgressGrid + cell detail panel（failed cell 保留展示）
- retry failed parameter_set → 新 attempt，不覆盖旧 FailureRecord

**验收门**：PI 指定 3–5 组参数 → batch 运行 → 参数表 + 进度网格 + 对比过程线，失败 cell 可见；partial
batch 的 limitation 标注落 progress / 汇总表 artifact（report 侧消费与验收在 M7）。测试细目：Test_Plan W6 节
（按压缩口径取舍）+ Performance_Test_Plan（batch progress latency）。

---

## M7：报告 + 审批 + 记忆 + 成本 + 通知

**目标**：证据到决策的闭环：EvidenceReport 生成 → Reviewer 检查 → PI 审批（含 comment）→ HTML 导出 →
邮件通知 → 审计链可查。原 v0.8.1 Operational UX Sprint 四项全部并入本里程碑。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Report_Generation_Spec](../03_SPEC/Report_Generation_Spec.md) · [Report_Review_And_Evidence_Lineage_Spec](../03_SPEC/Report_Review_And_Evidence_Lineage_Spec.md) | 模板、language guard、assertion 分类、lineage |
| [Report_Export_Spec](../03_SPEC/Report_Export_Spec.md) · [PI_Decision_Comments_Spec](../03_SPEC/PI_Decision_Comments_Spec.md) | HTML/watermark/manifest；comment 必填 |
| [Notification_Design](../03_SPEC/Notification_Design.md) | 触发规则、dedupe、SMTP（**D7 保留 MVP，机器常开；发信账号 = ADR-0002 开放项**） |
| [Memory_Skills_Lite](../03_SPEC/Memory_Skills_Lite.md) §9/§10 | 两级记忆 + **gardening 周期清扫（sweep 仅提名，PI 退役）** |
| [Cost_Inference_Budget](../03_SPEC/Cost_Inference_Budget.md) | 三档预算（**数值按 GLM 计价重估 = ADR-0002 开放项**）、CostRecord |
| [Theory_To_Code_Report_Lineage_Spec](../03_SPEC/Theory_To_Code_Report_Lineage_Spec.md) · [Scientific_Change_Gating_Spec](../03_SPEC/Scientific_Change_Gating_Spec.md) | report 的 T2C Evidence 章 + 高风险变更门 |
| [Operational_UX_Addendum](../03_SPEC/Operational_UX_Addendum.md) · [Operational_UX_API_Contracts](Operational_UX_API_Contracts.md) | 运维四功能 |
| 账本 [Phase 5 激活表](../Phased_Spec_Activation.md) | 本阶段全量清单 |

**交付（issue 粒度）**：

- EvidenceReport deterministic template + language guard（负例：禁止表述）+ Theory-to-Code Evidence 章（code_change 任务必含）
- PiGate decision 工作流：PiGateDecision + `POST /api/pi-gates/:gateId/decision`（comment 必填；agent 403）+ audit log + `MemoryNote(type=pi_decision)` + report decision history + bundle.status `accepted*` 写回（PiGate schema 与开 gate 在 M5 已交付）
- standalone HTML/Markdown export + draft watermark + export manifest + `GET /api/reports/:id/export` + MarkdownRenderer（报告渲染组件）
- MemoryNote（note 直写 draft / evidence_note 需 PI review）+ `POST/GET /api/notes` + skill loader
- **gardening sweep job**（周期触发、仅产候选清单 + sweep report Web 审批面 + 退役状态迁移 AuditEvent；§10 验收单测）
- inference budget 实时追踪 + cost tracker + CostMonitor（SideNav 悬浮）+ CostAdmin 页
- **email notification**（NotificationRecord + recipient resolver + SMTP provider interface + dedupe key + report/analysis ready 触发 + notification.status UI；接入时机在 park/resume 与 collect 语义稳定之后——本里程碑已满足）
- NextSuggestedAction（Coordinator 建议 + PI 选择）
- 运维收尾：runbook drills、dependency release manifest、requirements coverage report

**验收门**：RunRecord → report → Reviewer 检查 → PI 审批（comment 必填、决策入审计 + 记忆）→ HTML 导出
→ 邮件送达；Dashboard 显示成本；partial batch 的 report limitation 呈现（承接 M6）；gardening sweep 过
Memory_Skills_Lite §10 验收单测。测试细目：Test_Plan W7 节 + Operational_UX_Testing_Addendum + Performance_Test_Plan（report/export perf）。

---

## M8：GLM 接入 + eval 准入 + e2e

**目标**：真实 LLM 驱动全链路。**接入前置门 = 金样 eval 全量首跑**（ADR-0002 D9：即 GLM 5.2 模型准入
测试，治理/注入类不达标 → 启用开放项 plan B，不带病进 e2e）。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [Agent_Behavior_Eval_Spec](Agent_Behavior_Eval_Spec.md) | 全量 eval：治理 5/5 门、EVAL-REV 校准、nightly release blocker、verdict drift 度量 |
| [Error_Handling_Spec](../03_SPEC/Error_Handling_Spec.md) §5.1 | **LLM 故障降级三件套**：确定性分类器（status/code → 唯一恢复路径）+ 未知错误落 block 负例 |
| [Zero_Codebase_Report](../01_CODEBASE/Zero_Codebase_Report.md) · [Zero_Reuse_Matrix](../02_ARCHITECTURE/Zero_Reuse_Matrix.md) | AgentLoop/Session/Tool 扩展点 + provider 配置 |
| [Context_Trust_And_Injection_Spec](../03_SPEC/Context_Trust_And_Injection_Spec.md) | 注入防护全量生效（真实 LLM = 注入面全开） |
| 账本 [Phase 6 激活表](../Phased_Spec_Activation.md) | CICD_Release、Deployment_Architecture、Task_Playbooks、DOD_and_Risks 等（**Multiuser 与 i18n 除外——D6 停用/后置**） |

**交付（issue 粒度）**：

- **金样 eval 准入门**：GLM 5.2 全量 golden eval 首跑（governance/injection 类达标才放行后续 issue；结果记入 StackLock.llm 关联 eval 记录）
- **LLM 降级三件套分类器**（纯函数 + 负例测试；接 fallback_chain）
- Zero event → Harness WebSocket envelope adapter；Zero tool call → sandbox/runner wrapper；Zero memory create → MemoryNote draft override（不默认 verified）；closure classifier override（no-progress 阈值拦截）
- Coordinator prompt 与 TaskCard/RunRecord/EvidenceReport context 注入
- LLM streaming（可重放/可终止）+ StreamingText + PIInput（自然语言 → Coordinator 解析 → 执行）+ toolcall expand/collapse + agent role message rendering（在 M3 AgentActivityFeed 基础上做消息级交互）
- e2e demo：engineering task（PI 对话驱动 event diagnostics）+ science_assist task（对话驱动最小 OAT 敏感性，对应 W8-E2E-002）+ **M9 回放 dry-run**（用 dummy patch 走一遍 ChangeRequest→VerificationCase→PiGate→report 链，验证 M9 所需全部装置）
- rollback test + job failure recovery test + 部署文档

**验收门**：金样 eval 达标；LLM 降级分类器负例通过（未知错误落 block）；rollback + job failure recovery
test 绿；PI 用自然语言驱动 engineering 与 science_assist 全流程且四栏实时联动；回放 dry-run 走通。
测试细目：Test_Plan W8 节。

---

## M9：MVP 验收——openMP RHS 已知答案回放

**目标**：首个真实科研任务（ADR-0002 D3/D4）：从兄弟项目 openMP 抽取 RHS 并行化切片，以 code_change
任务在 Harness 内**已知答案回放**。答案已知（openMP P1e epic 已交付），评价对象是 **Harness 本身**：
治理链路是否走通、正确性门是否有效。**明确不做性能复现**（加速比留待真实性能任务）。

**前置**：回放切片粒度 + SHUD baseline pin 选择已过 M1 grill 定案（openMP 侧 B0/P1e-tag 体系 vs
Harness submodule pin）。

**必读（增量重点）**：

| 文档 | 关注点 |
|---|---|
| [ADR-0002](../adr/0002-mvp-reality-anchoring.md) D3/D4 | 回放定义与验收口径 |
| `../openMP/SHUD_openMP_master_plan.md`（本机兄弟目录，非本仓库） | P1e epic：StrictOMP RHS、基线锁、决定论机制、验收门设计 |
| [Scientific_Change_Playbooks](Scientific_Change_Playbooks.md) | code_change playbook 全流程 |
| [Verification_Case_Spec](../03_SPEC/Verification_Case_Spec.md) · [Theory_To_Code_Governance_Spec](../03_SPEC/Theory_To_Code_Governance_Spec.md) | serial-baseline 一致性门的 VerificationCase 表达 |
| [Research_Constitution](../02_ARCHITECTURE/Research_Constitution.md) | 表述边界（回放结果 ≠ 性能结论） |
| [Task_Playbooks](Task_Playbooks.md) | E2E playbook 验证 |

**交付（issue 粒度）**：

- 回放任务包：RHS 切片 patch 素材 + 小流域 fixture + serial baseline 预置（pin 按 grill 定案）
- code_change TaskCard 全流程实跑：Repo Explorer 定位 → Coder 在 worktree 施工 → ChangeRequest + patch bundle → **VerificationCase：serial baseline 一致性判定**（并行 RHS 输出 vs 串行基线，阈值内一致）→ Reviewer 工程检查 → PiGate 审批 → EvidenceReport（T2C Evidence 章 + lineage 完整）
- 回放复盘报告：Harness 各环节表现（策略门拒绝质量、park/resume 触发、成本、人工介入点）

**验收门（= MVP 验收）**：治理链路无人工绕过地走通；正确性门正确判定（含一次故意注入的错误 patch 被
VerificationCase 拦下的负例）；EvidenceReport 可导出、lineage 可追溯；全程审计链完整。
**通过 = MVP 交付**；复盘产出下一批真实任务的 backlog。

---

## Post-MVP（明确不做，含降级项）

| 项 | 依据 | revisit 触发器 |
|---|---|---|
| SensitivityHeatmap / heatmap API / parquet+DuckDB | D5 压缩 | 首个真实敏感性研究任务 |
| Controlled_Search / 校准 / benchmark 引擎本体 | D5：仅 schema 占位 | 回放链路走通后按需 |
| Multiuser_Harness_Versioning（并发 session、task lock） | D6 停用 | 出现第二个真实用户 |
| slurm/HPC 适配器 | D1 全本机 | Mac 成为瓶颈（ADR-0002 触发器 4） |
| 性能复现类任务（heihe 级加速比） | D4 | 回放链路走通后 |
| Harness Optimizer · multi-agent autonomous loop · release gate platform · complex memory review workflow · 3D 流域可视化 · notebook 式交互分析 · i18n 全量 | 原 8 周版排除项沿用 | 按需立 ADR |
