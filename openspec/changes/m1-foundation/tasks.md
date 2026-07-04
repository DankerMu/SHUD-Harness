# M1 Foundation — Tasks

> 章节为能力分组，编号不代表全局依赖序：同节内按列出顺序依赖，跨节依赖以行内「依赖:」标注为准——Stage 5 逐任务映射子 issue 时据此生成依赖边。每个任务按"单 agent-PR"尺寸切（ADR-0002 D8）。
> M1 grill 已定案（2026-07-03，见 proposal 定案节）：原 `[GRILL-N]` 开工阻塞全部解除，标注保留作决策溯源。
> 内部顺序铁律（Phased_Plan M1）：3.1（spike 条 1 横切包装）先行，注册 lint 与 guard_class 挂其后同一横切点（5.2/5.3 依赖 3.1）。

## 1. 就绪收口（readiness-gates）

- [ ] 1.1 P0 九 Gate 逐项验证 + 签核 YAML 落 `workspace/readiness/readiness_gate_v0_8_1.yaml`（校验类合并一个 issue；decision=block 时后续编码任务全部冻结）
  - Evidence floor (#12):
    - Current HEAD + nine P0 checks -> `workspace/readiness/readiness_gate_v0_8_1.yaml` contains `checked_at`, `checked_by`, legal `decision`, and exactly these `p0` keys: `gitmodules_parse`, `submodules_checkout`, `canonical_index`, `core_schema`, `support_schema`, `api_registry`, `error_idempotency`, `artifact_registry`, `lock_recovery`.
    - All nine gates pass -> aggregate `decision: pass`; a schema/API/path/lock conflict in an isolated failure fixture (for example missing required contract file) -> affected gate non-pass and aggregate `decision: block`.
    - Absent or preexisting `workspace/readiness/` -> helper creates/overwrites only `workspace/readiness/readiness_gate_v0_8_1.yaml`; `git status --short -- workspace` remains empty.
    - PR description or issue comment -> records per-gate input/result, command evidence, and downstream action: `block` freezes #16+ coding; `pass|pass_with_notes` unlocks downstream M1 coding.
- [ ] 1.2 link check 脚本入库 `scripts/` + CI 工作流骨架（PR 触发：link check + 单测占位；schema drift 检查由 4.2 接入，PERF-API-001 冒烟由 6.5 接入）
- [ ] 1.3 根 `package.json` 固定 packageManager + lockfile 入库 + 初始 DependencyLock（四 submodule commit + 运行时依赖版本）
- [ ] 1.4 SHUD `make` 复验（一次本机编译 + 环境快照记入 readiness notes）+ rSHUD ≥2.5.0 在位确认

## 2. Monorepo 骨架（monorepo-skeleton）

- [ ] 2.1 [GRILL-1] Bun workspace 三包初始化（packages/core|backend|frontend，目录遵 Repository_Layout §1）+ zero 引用姿势 provisional 落地（submodule 钉 13e25c1 不 fork；选定一种引用形态并标注 provisional，保证三包与 zero 可解析引用即可；引用技术形态的实测定形与 design.md Decision 3 回写归 3.1）

## 3. 策略门 spike（policy-gate-spike）——ADR-0001 触发器 1

> 判定（2026-07-04，#21）：spike 条 2（#19 / PR #46）最终 review+verifier gate 不绿，已触发 ADR-0001 revisit。
> Zero 保持 Trial；#19 当前实现保留为 spike 证据，不 merge。策略门依赖的 3.x/5.x 后续任务暂停到 enforcement boundary 重审完成。
> 逐条证据见 `policy-gate-spike-verdict.md`。
>
> **裁决（2026-07-04 同日，ADR-0001 revisit 记录）**：边界重划，基座不换——bash 写禁区 authority 下沉执行层 OS 沙箱（macOS seatbelt，子进程继承），pre-exec 静态检查降级 advisory；3.3 重定为条 2'（#19 已重定标），冻结解除（3.4 与 3.3 无依赖可并行，5.x 按原依赖图恢复）；条 2' 绿后重出五条判定再议 Trial 转正。

- [ ] 3.1 spike 条 1：工具注册层横切包装（`ToolBase.beforeExecute` 包装/注册期 wrap；未包装工具装配失败负例；Zero 内核零改动）+ zero 引用技术形态定形（嵌套 Bun workspace 解析实测：workspace 纳入 vs `file:` 依赖 vs 运行时入口加载，实测结论回写 design.md Decision 3；验收含「Decision 3 已回写」）——依赖: 2.1
- [ ] 3.2 spike 条 4：策略门纯函数核心（ToolCall → allow/deny + reason + remediation）+ 独立单测（正负例 + remediation 载荷断言）——依赖: 4.1（ErrorRecord.remediation 枚举）
- [ ] 3.3 spike 条 2'：`data/raw/**` 写禁区执行层穿透（authority = bash 工具 spawn 时施加 OS 沙箱 profile——macOS `sandbox-exec`/seatbelt `deny file-write*` subpath、子进程继承；六类逃逸负例（解释器 payload / pipeline·stdin / 动态目标 / shell 状态与子进程 / symlink·`../` 别名 / rename+unlink）+ raw 读与 workspace 写正例 + 预存 hardlink 残留演示与 nlink>1 扫描检出；pre-exec 静态检查降级 advisory（fail-open，复用 3.2 纯函数 + 3.1 横切缝）；拒绝面 remediation 三字段 + WS 复用 `tool.failed`（envelope 含 seq/event_id）+ audit 最小行落盘（event/tool_id/rule/decision/ts + profile 标识，路径与 fixture 任务见 policy-gate-spike spec））——依赖: 4.1；2026-07-04 重定（ADR-0001 revisit 裁决）
- [ ] 3.4 spike 条 3：spawn 剖面超集拒绝负例（比对基准 = 5.1 映射表；断言 `remediation.next_action=adjust_scope`）——依赖: 5.1；与 3.3 无依赖，可并行（2026-07-04 裁决解冻）
- [x] 3.5 spike 条 5 核验 + 判定记录（`git -C zero diff --quiet` && HEAD=13e25c1；五条全绿 → Trial 转正记录；任一条 2 人周不绿 → ADR-0001 revisit 备忘并冻结 3.x/5.x 后续）——依赖: 节内 3.1–3.4 + 跨节 4.1、5.1（经 3.2/3.4 传递）；首轮判定已出（2026-07-04：条 2 不绿 → revisit 已裁决），条 2' 绿后重出五条判定

## 4. core schema（core-schemas）

- [ ] 4.1 首批 5 个 Zod schema（TaskCard 状态机枚举、Artifact、ErrorRecord 含 remediation 枚举、IdempotencyRecord、LockRecord）+ 正反例单测——依赖: 2.1
- [ ] 4.2 schema generation 脚本（Zod → `docs/generated/schema/*.md` 与 `docs/generated/json-schema/*.json` 两套单向生成，遵 Schema_Generation_And_Drift_Control）+ drift 检查（`git diff --exit-code` 覆盖 schema 与 json-schema 两目录）接入 1.2 的 CI（投影副本转生成物的前置，单列）——依赖: 1.2

## 5. 工具面治理（tool-registry-governance）

- [ ] 5.1 [GRILL-2] role→tool_id canonical 映射表常量（领域工具 id 遵 Zero_Reuse_Matrix §10 点分注册名）+ 快照测试 + 语义不变式单测（只读角色无写工具 / spawn 权唯一 / coordinator 无 bash / coder 独占 edit+patch）——依赖: 2.1
- [ ] 5.2 注册期 lint（≤20/角色 + 描述三节完整性 + Zod 参数校验回吐）+ 负例测试（挂 3.1 横切点）——依赖: 3.1
- [ ] 5.3 硬护栏 guard_class 标注（authority|capability）+ 未标注装配失败负例——依赖: 3.1
- [ ] 5.4 spawn depth/并发上限 kernel 硬校验（Control_Kernel §5：depth >1 拒绝且含 remediation 三字段；活跃子代理 =3 时新 spawn 非 allow——纯函数负例，真实排队调度随 M3 spawn 接线）+ guard_class 标注——依赖: 3.2

## 6. 后端骨架（task-api）

- [ ] 6.1 `POST /api/workspace/init` 幂等目录树生成（含 `readiness/`）+ health live/ready skeleton（live 响应含 status/version/uptime_seconds/timestamp，OBS-HEALTH-001；ready 检查含 workspace_writable，OBS-HEALTH-002；路径遵 Schemas_APIs_CLIs 注册表）——依赖: 2.1
- [ ] 6.2 TaskCard 最小链路：`POST/GET /api/tasks`、`GET /api/tasks/:id` + 统一错误 envelope（含 404 路由兜底）+ task snapshot 落盘/重启恢复——依赖: 4.1
- [ ] 6.3 幂等/锁 service skeleton（相同 Idempotency-Key + 相同 request_digest 重放返回同一对象；相同 key + 不同 digest → 422 标准 envelope；M1 验证载体 = `POST /api/tasks`，key/digest 配方为 change-scoped，见 task-api spec 与 proposal Impact 账本待办）+ Artifact registry skeleton（注册/按 id 查询/落盘）——依赖: 4.1（IdempotencyRecord/LockRecord schema）
- [ ] 6.4 结构化 NDJSON API 请求日志中间件（OBS-LOG-001 八字段：ts/level/service/event/request_id/route/status/duration_ms；secret 仅以 ref/[REDACTED] 形式出现，OBS-LOG-002）
- [ ] 6.5 PERF-API-001 冒烟脚本 `bun run test:perf:api`（fixture = mock workspace + 100 tasks；GET /api/tasks、GET /api/tasks/:id、health ready P95 ≤ 300ms）+ 接入 1.2 的 PR CI——依赖: 1.2
- [ ] 6.6 路径安全 helper（packages/core 共享 service，遵 Workspace_Conventions §9：resolve 规范化 → workspace 边界校验 → 拒 symlink escape → 记录规范化路径）+ Artifact registry 落盘与 task snapshot 写入两处接线 + 正负例单测（`../` 穿越拒绝、symlink escape 拒绝、合法路径规范化记录；承接 Test_Plan W1 Unit「path normalization」）——依赖: 6.2、6.3（两处落盘写入面在位）

## 7. 四栏壳（workbench-shell）

- [ ] 7.1 WorkbenchLayout 四栏骨架（SideNav + AgentFeed + Experiment + Results 占位；SideNav 任务列表与 Dashboard→Workbench 任务上下文导航接线 deferred M2，见 design Non-Goals）——依赖: 2.1
- [ ] 7.2 Dashboard 页（GET /api/tasks 列表 + 建卡表单 + 刷新恢复）——依赖: 6.2
- [ ] 7.3 ExperimentHeader + StatusBar 占位组件（task 上下文 props）

## 8. GLM provider（glm-provider）

- [ ] 8.1 [GRILL-3] zero `providers:` 配置（api_type/base_url/`api_key_ref: env:GLM_API_KEY`/fallback_chain + 按功能选模型占位）+ 连通冒烟脚本（非空 completion + 命中 base_url + exit 0；key 缺失明确报错；结论入 readiness notes）——依赖: 2.1

## 9. M1 验收门走查

- [ ] 9.1 验收清单执行并留痕（依赖: 1–8 节全部）：浏览器四栏打开、建卡、刷新 snapshot 恢复；spike 五条绿；make 复验过；GLM 冒烟过；注册 lint 负例生效。测试细目按下列显式清单核销（Phased_Plan M1 验收门三源的 M1 裁剪，裁剪依据见 design Decision 10）：
  - 适用：Test_Plan W0 五项（W0-GIT/DOC/SPEC/CANON/READY-001）；W1 Unit/Integration/UI 细目（下列 N/A 项除外；其中「idempotency request digest」由 6.3 覆盖、「path normalization」由 6.6 覆盖）；OBS-HEALTH-001/002（6.1）；OBS-LOG-001/002（6.4 + glm-provider secret 约束）；PERF-API-001（6.5）
  - N/A-M1（显式豁免并指向补齐里程碑）：OBS-HEALTH-003（disk critical + job submit 409 → M3 运维骨架，Phased_Plan M3「disk critical block new jobs」行）；OBS-HEALTH-004（deep health 认证 → M3+，认证语境在位后）；W1 UI/E2E「进入 Workbench（Dashboard→Workbench 任务上下文导航）」与「SideNav 显示任务」→ M2 数据接线（design Non-Goals 已记；M1「浏览器四栏打开」由 workbench-shell 四栏可见场景独立覆盖）
