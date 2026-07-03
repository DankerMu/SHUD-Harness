# M1 Foundation — Design

## Context

- Spec 体系已冻结（2026-07-02，仅收 bug 修正 + ADR 例外）；代码为零；zero@13e25c1 以根目录 submodule 在位。
- ADR-0001：基座评级 **Trial**，转正判定 = 本里程碑策略门 spike（触发器 1）；关键实测事实——`AgentLoopHooks.onToolCallStart` 是 void 观测钩子**不可否决**，可阻断缝 = `ToolBase.beforeExecute`（throw 即拒）。
- ADR-0002：D1 全本机 Mac；D2 工具链已验证（M1 只做一次 `make` 复验）；D8 里程碑制 + 单 agent-PR 尺寸切 issue；D9 运行时模型 GLM 5.2（第三方 OpenAI 兼容端点，zero `providers:` 原生支持零开发）。
- M1 定位（Phased_Plan）：**此后不再做架构判断**。

## Goals / Non-Goals

**Goals:**

- 可持续施工的 monorepo 地基 + TaskCard 最小链路（建卡 → 落盘 → 刷新恢复）。
- 中央策略门可行性判定出结论（五条 spike，ADR-0001 触发器 1）。
- 工具面治理三件套与策略门同一横切点落地（lint / guard_class / role→tool_id 表）。
- GLM provider 配置接通（连通冒烟，非准入）。
- 就绪收口签核（P0 九 Gate）+ SHUD `make` 复验。

**Non-Goals:**

- 不接真实 LLM 驱动 AgentLoop 业务流（GLM 仅冒烟；准入门在 M8 金样 eval）。
- 不实现 WebSocket 完整协议（spike 条 2 只需 skeleton：复用注册表既有事件 `tool.failed`、不新增事件类型，envelope 含 seq/event_id + audit 最小行落盘；完整协议在 M3）。
- 不做 StackLock/DataProvenance（M2）、RunJob/sandbox/park-resume（M3）、SLURM（D1 出 MVP）、多用户（D6 停用）。
- 四栏壳子组件占位即可，数据接线随后续里程碑；SideNav 任务列表与 Dashboard→Workbench 携带任务上下文的导航接线明确 deferred M2——对应 Test_Plan W1 UI/E2E「进入 Workbench」「SideNav 显示任务」两条细目在 M1 按 tasks 9.1 显式清单标 N/A-M1。
- 不做观测全量栈（metrics/alerts/ops dashboard、OBS-HEALTH-003/004 随 M3 运维骨架）；M1 仅交付观测最小骨架（Decision 10）。

## Decisions

1. **策略门注入点 = 工具注册层横切包装**。注册时统一 wrap execute（`ToolBase.beforeExecute` throw 即拒），先过 kernel 校验再放行；loop 级 hook 仅作观测。备选"改 Zero 内核"违反 diff=0 与升级成本约束；备选"loop hook 阻断"被 zero@13e25c1 实测否决（不可否决型钩子）。出处：ADR-0001、[Zero_Reuse_Matrix §8](../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)、[Control_Kernel §5](../../../docs/02_ARCHITECTURE/Control_Kernel.md)。
2. **spike 内部顺序**：条 1（横切包装）先行；注册期 lint 与 guard_class 标注挂同一横切点其后；条 3 依赖 role→tool_id 映射表（比对基准）。判定条款：任一条 2 人周内不绿 → ADR-0001 revisit，备选顺序按 2026-07-02 修订注（① 自建薄工具注册层 ② Claude Agent SDK 迁移），不带病继续。
3. **zero 引用姿势 [GRILL-1，已定案 2026-07-03]**：M1 不 fork——zero 保持根目录 submodule 钉 13e25c1，packages/* 相对引用；fork 决策挂 ADR-0001 触发器。引用的技术形态（workspace 纳入 zero 子包 vs `file:` 依赖 vs 运行时入口加载）在 spike 条 1 实现时确认并回写本节——zero 自身是 Bun workspace（9 packages），嵌套 workspace 的解析行为需实测，不在纸面裁决。
4. **拒绝载荷统一走 `ErrorRecord.remediation`**：`{next_action ∈ escalate_to_pi|open_gate|adjust_scope|fix_and_retry|abort, hint, ref}`（权威源 [Support_Schema_Contracts §3](../../../docs/03_SPEC/Support_Schema_Contracts.md)）；spawn 剖面超集拒绝断言 `next_action=adjust_scope`。拒绝而不导航制造重试风暴（Control_Kernel §5 拒绝载荷约定）。拒绝事件的 WS 出口不新增事件类型——复用 [WebSocket_Protocol §3](../../../docs/03_SPEC/WebSocket_Protocol.md) 注册表既有的 `tool.failed`（payload 携带含 remediation 的 ErrorRecord）；audit 最小行字段（event/tool_id/rule/decision/ts）与无任务上下文时的 fixture 任务路径（`workspace/tasks/TASK-M1-SPIKE/audit/`）见 policy-gate-spike spec。
5. **role→tool_id 映射表 = packages/core 常量 + 快照测试**。Roles_and_Boundaries §0 只有权限类别散文，本表是唯一具象化落点，也是 spike 条 3 子集校验的比对基准。各角色工具面已 PI 确认（[GRILL-2] 定案 2026-07-03，附表见 tool-registry-governance spec），据此固化快照。
6. **GLM provider 零开发接入**：zero `providers:` 块（`api_type: openai_chat_completions` + `base_url` + `api_key_ref` + `fallback_chain` + 按功能选模型）。`api_key_ref` 遵 [Config_Secrets §3](../../../docs/03_SPEC/Config_Secrets_And_Environment_Spec.md) SecretRef 形态（`env:GLM_API_KEY`，provider=env，purpose=llm；[GRILL-3] 定案 2026-07-03，Config_Secrets §4 已补行）。冒烟判定 = 最小 prompt 一次往返得到非空 completion 且实际命中配置的 `base_url`，exit 0。
7. **schema 生成方向单向**：Zod 源码（canonical 第 1 序）→ `docs/generated/schema/*.md` 与 `docs/generated/json-schema/*.json` 两套生成物（第 2 序）；drift 检查覆盖两目录入 CI（`git diff --exit-code docs/generated/schema docs/generated/json-schema`）。生成物与 drift 政策唯一权威源 = [Schema_Generation_And_Drift_Control](../../../docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md)。生成脚本是"投影副本转生成物"的前置，单列 issue。
8. **就绪收口签核**：P0 九 Gate 按 [Readiness_Checklist](../../../docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md) 验证方法逐项跑，签核 YAML 落 `workspace/readiness/readiness_gate_v0_8_1.yaml`（Workspace_Conventions §4 补充目录），`checked_at` 签核时填 ISO8601。`make` 复验 = 一次本机编译 + 环境快照（OS/编译器/SUNDIALS 版本）记入 readiness notes，不 CI 化（D2：已验证过，这是复验）。
9. **health live/ready 归属**：Phased_Plan 把 "health live/ready skeleton contract" 列在就绪收口行，实现落点在 backend（task-api capability）——收口行管"契约入库"，端点代码随后端骨架交付。路径以 [Schemas_APIs_CLIs](../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md) 注册表为准。
10. **M1 验收门观测/性能细目 = 最小骨架交付 + 显式豁免**。Phased_Plan M1 验收门点名 Observability_Test_Plan（health / structured logs）与 Performance_Test_Plan（API metadata perf smoke），M1 据此交付：NDJSON 结构化请求日志（OBS-LOG-001 八字段 + OBS-LOG-002 secret redaction）、health live 字段集（OBS-HEALTH-001）、ready 含 workspace_writable（OBS-HEALTH-002）、PERF-API-001 冒烟脚本入 PR CI（task-api spec 承接，tasks 6.1/6.4/6.5）。豁免并指派：OBS-HEALTH-003（disk critical + job submit 409）依赖 RunJob 与运维骨架 → M3；OBS-HEALTH-004（deep health 认证）依赖认证语境 → M3+；核销按 tasks 9.1 显式清单执行，不再按三份 canonical 测试计划全量字面核销。
11. **Control_Kernel §5 spawn 三项硬校验 M1 全落地**：剖面子集 = spike 条 3（policy-gate-spike）；depth 上限与并发上限 = tool-registry-governance「spawn depth 与并发上限硬校验」requirement（与条 3 同注入点、同为纯函数判定 + 负例单测；并发项 M1 断言非 allow，真实排队调度随 M3 spawn 接线）。由此 guard_class requirement 枚举的护栏与 M1 实际交付一致，不留未承接项。
12. **幂等 skeleton 的 M1 验证载体 = `POST /api/tasks`（change-scoped）**：canonical 幂等适用清单（Idempotency_Concurrency_Locking_Spec §4 / API_Error_And_Idempotency_Contracts §3）不含该端点且 M1 无 §4 表内端点可用，故以 change-scoped 配方（scope=task、request_digest = 规范化请求体 sha256、mismatch 422）在该端点验证 skeleton 通用能力，不以验收断言扩张 canonical 契约；纳入 canonical 清单的账本 bug 修正待办见 proposal Impact。

## Risks / Trade-offs

- [spike 任一条不绿] → 计划内退路：ADR-0001 revisit 按修订注顺序，产出评估备忘，不带病继续（非未知风险，是本里程碑的判定目的）。
- [zero 嵌套 Bun workspace 引用形态不可行（如 `file:` 解析冲突）] → 降级为类型级复制 + 运行时 adapter 隔离，记录到本 change 修订与 ADR-0001 债务清单。
- [GLM 第三方端点不稳定] → 冒烟只验连通不做准入；失败重试一次并记录；准入判定延至 M8 金样 eval（D9 债务已声明）。
- [zero 上游 development 分支漂移] → M1 期间钉死 13e25c1 不 bump。
- [P0 Gate 出现 schema/API/path/lock 冲突] → 按 Readiness 判定规则 block，不进入编码；文档格式类允许 pass_with_notes 且 W1 CI 内修复。

## Migration Plan

零代码起步，无存量迁移。回滚 = git revert（无持久化数据兼容问题）。workspace/ 运行时资产不进代码仓（Repository_Layout §2）。

## Open Questions

- [GRILL-1..3] 已全部定案（2026-07-03 M1 grill，记录见 [ADR-0002 开放项处置节](../../../docs/adr/0002-mvp-reality-anchoring.md)）：不 fork + submodule 引用；工具面照准草案；`GLM_API_KEY`（Config_Secrets §4 已补行，账本例外批次 4）。
- zero 包引用技术形态（workspace 纳入 vs `file:` 依赖 vs 运行时入口加载）：**唯一存留开放项**，spike 条 1 实现时实测确认并回写 Decision 3。
