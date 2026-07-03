# M1 Foundation — 就绪收口 + 骨架 + 策略门 spike + GLM provider

> 排期与验收唯一真相源：[Phased_Plan M1 节](../../../docs/04_IMPLEMENTATION/Phased_Plan.md)。
> 本 change 是其实施记录投影：把 M1 交付面固化为可审核、可切 issue 的规格。冲突时以 Phased_Plan 与其引用的 canonical spec 为准。

## Why

Spec 体系已冻结（2026-07-02，~105 篇），旧 openspec changes（4 月产物）因漂移整体清理，实施记录为空。Phased_Plan 重写为里程碑制 M1–M9 后，M1 是第一个开工门：交付可持续施工的地基（monorepo 骨架 + TaskCard 最小链路），并完成两项"此后不再做架构判断"的关键判定——中央策略门可行性 spike（ADR-0001 触发器 1）与唯一运行时模型 GLM 5.2 接通（ADR-0002 D9）。没有这份实施记录，M1 无法按"单 agent-PR 尺寸"切 issue、无法 grill。

## What Changes

- **就绪收口**（原 W0 并入 M1 前置）：Readiness_Checklist P0 九 Gate 逐项验证 + 签核 YAML 落 `workspace/readiness/`；link check 与 schema generation 脚本入库并接 CI；packageManager/lockfile 固定；initial DependencyLock；SHUD `make` 一次复验（D2，记录环境快照）+ rSHUD 2.5.0 在位确认。
- **Monorepo 骨架**：Bun workspace（`packages/core + backend + frontend`，命名以 CANONICAL_CONTRACTS §1 / Repository_Layout 为准）；zero 以根目录 submodule 相对引用（M1 不 fork，[GRILL-1] 已定案）。
- **core Zod schema 首批**：TaskCard、Artifact、ErrorRecord（含 `remediation{next_action, hint, ref}`）、IdempotencyRecord、LockRecord；`docs/generated/schema/*.md` 与 `docs/generated/json-schema/*.json` 两套生成物由脚本生成、drift 检查覆盖两目录（遵 Schema_Generation_And_Drift_Control；投影副本转生成物的前置）。
- **Hono 后端骨架**：`POST /api/workspace/init`、`POST/GET /api/tasks`、`GET /api/tasks/:id`、API 错误 envelope、idempotency/lock service skeleton（M1 以 `POST /api/tasks` 为 change-scoped 验证载体，含 digest-mismatch 422）、task snapshot 读写、health live/ready skeleton（ready 含 workspace_writable）、结构化 NDJSON 请求日志（OBS-LOG-001 字段集）、PERF-API-001 metadata 冒烟入 PR CI、workspace 文件树自动生成 + Artifact registry skeleton、路径安全 helper（Workspace_Conventions §9：规范化 + workspace 边界 + 拒 symlink escape，Artifact registry 落盘与 snapshot 写入共用）。
- **React 四栏壳**：WorkbenchLayout（SideNav + AgentFeed + Experiment + Results）、Dashboard、ExperimentHeader、StatusBar；子组件占位，数据接线随后续里程碑。
- **中央策略门 spike（五条全绿才过）**：工具注册层横切包装对全部工具调用生效；一条治理规则（`data/raw/**` 写禁区）端到端穿透且拒绝体含 remediation；spawn 剖面超集负例；策略门纯函数单测；zero@13e25c1 源码 diff = 0。这是 ADR-0001 触发器 1 的判定标准。
- **工具面治理**（三件套 + spawn 硬校验，与策略门同一横切点）：注册期 lint（单角色 ≤20 工具 + 描述完整性 + Zod 参数校验，负例测试）；硬护栏 guard_class 标注（authority | capability）；role→tool_id canonical 映射表（packages/core 常量 + 快照测试，[GRILL-2] 工具面已 PI 确认；领域工具 id 遵 Zero_Reuse_Matrix §10 点分注册名）；spawn depth/并发上限 kernel 硬校验（与剖面子集校验同注入点，纯函数负例——Control_Kernel §5 三项 M1 全落地）。
- **GLM provider 配置**（D9）：zero `providers:` 块（`api_type: openai_chat_completions` + `base_url` + `api_key_ref` + `fallback_chain` + 按功能选模型）+ 一次连通冒烟；api key 环境变量名 = `GLM_API_KEY`（[GRILL-3] 已定案）。正式准入门在 M8 金样 eval。

**M1 grill 定案（2026-07-03，七项议程全过，记录见 [ADR-0002 开放项处置节](../../../docs/adr/0002-mvp-reality-anchoring.md)）**：
[GRILL-1] zero 不 fork——submodule 钉 13e25c1 相对引用，引用技术形态 spike 条 1 实测回写；[GRILL-2] role→tool_id 五角色工具面照准草案（附表见 tool-registry-governance spec）；[GRILL-3] `GLM_API_KEY`（`api_key_ref: env:GLM_API_KEY`，Config_Secrets §4 已补行）。锚点保留作决策溯源。

## Capabilities

### New Capabilities

- `readiness-gates`: P0 九 Gate 验证与签核、校验脚本入库接 CI、DependencyLock、SHUD make 复验与 rSHUD 确认
- `monorepo-skeleton`: Bun workspace 三包结构、zero submodule 引用姿势、workspace 根配置
- `core-schemas`: 首批 5 个 Zod schema + schema 生成脚本与 drift 检查
- `task-api`: Hono 后端骨架——workspace init、TaskCard 最小链路、错误 envelope、幂等/锁/快照 skeleton、health
- `workbench-shell`: React 四栏壳与两页两组件（占位深度）
- `policy-gate-spike`: 中央策略门五条 spike（ADR-0001 触发器 1 判定）
- `tool-registry-governance`: 注册期 lint + guard_class 标注 + role→tool_id canonical 映射表
- `glm-provider`: GLM 5.2 providers 配置与连通冒烟

### Modified Capabilities

（无——`openspec/specs/` 当前为空，旧实施记录已整体清理）

## Impact

- **新代码**：`packages/core|backend|frontend`（此前零代码）、`scripts/`（link check、schema gen、readiness、冒烟）、CI 工作流（schema + link + unit）。
- **文档**：`docs/generated/schema/*.md` 与 `docs/generated/json-schema/*.json` 为新生成物；冻结的 spec 正文本 change 不改——grill 定案若触及 spec（如 Config_Secrets §4 补 GLM 变量行），按账本冻结规则以 bug 修正/ADR 例外单独处理。本 change 记录两笔待办账本条目（均走账本 bug 修正/冻结例外流程，不在本 change 内改冻结正文）：① Roles_and_Boundaries §3「选择是否直接 bash」句补修订注——已被 ADR-0002 开工三决②取代，coordinator 无直接 bash，工具面以 tool-registry-governance 映射表为准（该 spec 已显式声明优先级）；② `POST /api/tasks` 幂等（scope=task、digest 配方、mismatch 422）补入 Idempotency_Concurrency_Locking_Spec §4 与 API_Error_And_Idempotency_Contracts §3 适用清单（M1 期间为 change-scoped 验证载体，不扩张 canonical 契约）。
- **依赖**：Bun（packageManager 固定）、Hono、React、Zod；zero submodule 钉 13e25c1 不 fork；SHUD/rSHUD/AutoSHUD submodule 只读。
- **风险面**：spike 任一条 2 人周内不绿 → 触发 ADR-0001 revisit，备选顺序按其 2026-07-02 修订注（① 自建薄工具注册层 ② Claude Agent SDK 迁移），不带病继续。
