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

1. **策略门注入点 = 工具注册层横切包装**。注册时统一 wrap execute（`ToolBase.beforeExecute` throw 即拒），先过 kernel 校验再放行；loop 级 hook 仅作观测。备选"改 Zero 内核"违反 diff=0 与升级成本约束；备选"loop hook 阻断"被 zero@13e25c1 实测否决（不可否决型钩子）。出处：ADR-0001、[Zero_Reuse_Matrix §8](../../../docs/02_ARCHITECTURE/Zero_Reuse_Matrix.md)、[Control_Kernel §5](../../../docs/02_ARCHITECTURE/Control_Kernel.md)。**2026-07-04 界定（revisit 裁决）**：本横切点承载 authority 类结构化校验（role→tool、spawn 剖面、结构化路径参数）；bash 的路径写禁区 capability 约束不在此层判定，authority 下沉执行层 OS 沙箱——见 Decision 13。
2. **spike 内部顺序**：条 1（横切包装）先行；注册期 lint 与 guard_class 标注挂同一横切点其后；条 3 依赖 role→tool_id 映射表（比对基准）。判定条款：任一条 2 人周内不绿 → ADR-0001 revisit，备选顺序按 2026-07-02 修订注（① 自建薄工具注册层 ② Claude Agent SDK 迁移），不带病继续。
3. **zero 引用姿势 [GRILL-1，已定案 2026-07-03；#17 实测回写]**：M1 不 fork——zero 保持根目录 submodule 钉 13e25c1，fork 决策挂 ADR-0001 触发器。引用技术形态在 spike 条 1 已实测定形为 **root Bun workspace 纳入 `zero/packages/*` + SHUD 包按需声明 `@zero-os/*` workspace 依赖**，当前 `packages/core` 直接依赖 `@zero-os/core` / `@zero-os/shared`。实测证据：临时真实目录 Bun workspace（`workspaces=["packages/*","zero/packages/*"]` + `@zero-os/core@workspace:*`）安装通过，当前根 workspace 下 `import("@zero-os/core")` 可解析 `BaseTool` / `ToolRegistry`；`file:` 直连 `zero/packages/core` 失败，因为 zero 内部 `@zero-os/shared|model|observe|secrets` 仍是 `workspace:*` 传递依赖；直接加载 `zero/apps/server/src/cli/dispatch.ts` 会继续引入 app 级 server 依赖（如 `qrcode-terminal`），依赖面超出 M1 package adapter 目标。因此 M1 定形为 workspace-package-reference；不纳入 `zero/apps/*`，不改 zero 源码，`git -C zero diff --quiet` 仍为硬验收。
4. **拒绝载荷统一走 `ErrorRecord.remediation`**：`{next_action ∈ escalate_to_pi|open_gate|adjust_scope|fix_and_retry|abort, hint, ref}`（权威源 [Support_Schema_Contracts §3](../../../docs/03_SPEC/Support_Schema_Contracts.md)）；spawn 剖面超集拒绝断言 `next_action=adjust_scope`。拒绝而不导航制造重试风暴（Control_Kernel §5 拒绝载荷约定）。拒绝事件的 WS 出口不新增事件类型——复用 [WebSocket_Protocol §3](../../../docs/03_SPEC/WebSocket_Protocol.md) 注册表既有的 `tool.failed`（payload 携带含 remediation 的 ErrorRecord）；audit 最小行字段（event/tool_id/rule/decision/ts）与无任务上下文时的 fixture 任务路径（`workspace/tasks/TASK-M1-SPIKE/audit/`）见 policy-gate-spike spec。
5. **role→tool_id 映射表 = packages/core 常量 + 快照测试**。Roles_and_Boundaries §0 只有权限类别散文，本表是唯一具象化落点，也是 spike 条 3 子集校验的比对基准。各角色工具面已 PI 确认（[GRILL-2] 定案 2026-07-03，附表见 tool-registry-governance spec），据此固化快照。
6. **GLM provider 零开发接入**：zero `providers:` 块（`api_type: openai_chat_completions` + `base_url` + `api_key_ref` + `fallback_chain` + 按功能选模型）。`api_key_ref` 遵 [Config_Secrets §3](../../../docs/03_SPEC/Config_Secrets_And_Environment_Spec.md) SecretRef 形态（`env:GLM_API_KEY`，provider=env，purpose=llm；[GRILL-3] 定案 2026-07-03，Config_Secrets §4 已补行）。冒烟判定 = 最小 prompt 一次往返得到非空 completion 且实际命中配置的 `base_url`，exit 0。
7. **schema 生成方向单向**：Zod 源码（canonical 第 1 序）→ `docs/generated/schema/*.md` 与 `docs/generated/json-schema/*.json` 两套生成物（第 2 序）；drift 检查覆盖两目录入 CI（`git diff --exit-code docs/generated/schema docs/generated/json-schema`）。生成物与 drift 政策唯一权威源 = [Schema_Generation_And_Drift_Control](../../../docs/04_IMPLEMENTATION/Schema_Generation_And_Drift_Control.md)。生成脚本是"投影副本转生成物"的前置，单列 issue。
8. **就绪收口签核**：P0 九 Gate 按 [Readiness_Checklist](../../../docs/04_IMPLEMENTATION/MVP_Implementation_Readiness_Checklist.md) 验证方法逐项跑，签核 YAML 落 `workspace/readiness/readiness_gate_v0_8_1.yaml`（Workspace_Conventions §4 补充目录），`checked_at` 签核时填 ISO8601。`make` 复验 = 一次本机编译 + 环境快照（OS/编译器/SUNDIALS 版本）记入 readiness notes，不 CI 化（D2：已验证过，这是复验）。
9. **health live/ready 归属**：Phased_Plan 把 "health live/ready skeleton contract" 列在就绪收口行，实现落点在 backend（task-api capability）——收口行管"契约入库"，端点代码随后端骨架交付。路径以 [Schemas_APIs_CLIs](../../../docs/04_IMPLEMENTATION/Schemas_APIs_CLIs.md) 注册表为准。
10. **M1 验收门观测/性能细目 = 最小骨架交付 + 显式豁免**。Phased_Plan M1 验收门点名 Observability_Test_Plan（health / structured logs）与 Performance_Test_Plan（API metadata perf smoke），M1 据此交付：NDJSON 结构化请求日志（OBS-LOG-001 八字段 + OBS-LOG-002 secret redaction）、health live 字段集（OBS-HEALTH-001）、ready 含 workspace_writable（OBS-HEALTH-002）、PERF-API-001 冒烟脚本入 PR CI（task-api spec 承接，tasks 6.1/6.4/6.5）。豁免并指派：OBS-HEALTH-003（disk critical + job submit 409）依赖 RunJob 与运维骨架 → M3；OBS-HEALTH-004（deep health 认证）依赖认证语境 → M3+；核销按 tasks 9.1 显式清单执行，不再按三份 canonical 测试计划全量字面核销。
11. **Control_Kernel §5 spawn 三项硬校验 M1 全落地**：剖面子集 = spike 条 3（policy-gate-spike）；depth 上限与并发上限 = tool-registry-governance「spawn depth 与并发上限硬校验」requirement（与条 3 同注入点、同为纯函数判定 + 负例单测；并发项 M1 断言非 allow，真实排队调度随 M3 spawn 接线）。由此 guard_class requirement 枚举的护栏与 M1 实际交付一致，不留未承接项。
12. **幂等 skeleton 的 M1 验证载体 = `POST /api/tasks`（change-scoped）**：canonical 幂等适用清单（Idempotency_Concurrency_Locking_Spec §4 / API_Error_And_Idempotency_Contracts §3）不含该端点且 M1 无 §4 表内端点可用，故以 change-scoped 配方（scope=task、request_digest = 规范化请求体 sha256、mismatch 422）在该端点验证 skeleton 通用能力，不以验收断言扩张 canonical 契约；纳入 canonical 清单的账本 bug 修正待办见 proposal Impact。
13. **bash 写禁区 authority = 执行层 OS 沙箱（2026-07-04 revisit 裁决）**：首轮 spike 条 2 证明 pre-exec 静态命令串扫描不能同时满足"任意 bash 写入拒绝 / 合法 raw 读兼容 / 不实现 full shell parser"——六类逃逸 + 读误拒，证据见 [verdict](policy-gate-spike-verdict.md)；"写哪些文件"是程序语义属性，对图灵完备的 shell 只在 syscall 时刻可观测。冻结 spec 本就如此分工（[Preflight_And_Mutation_Boundary_Spec](../../../docs/03_SPEC/Preflight_And_Mutation_Boundary_Spec.md)"preflight 是 submit 前的门，不是运行期防线"A03-5；[Sandbox_and_Executor §1](../../../docs/03_SPEC/Sandbox_and_Executor.md)）。落点：bash 工具 spawn 命令时施加 seatbelt profile（macOS `sandbox-exec`：`(deny file-write* (subpath data/raw))`，子进程继承；包装在 SHUD 侧工具实现内，zero diff 仍 = 0）；相对 raw / evidence / workspace root 必须以显式稳定 project root 解析，不随 agent 进程 cwd 或每次 `ctx.workDir` 漂移；pre-exec 静态检查降级 advisory 提示层（fail-open）。实测（2026-07-04 本机 14 用例 probe）：六类 blocker 全 DENY、raw 读与 workspace 写 ALLOW、新建 hardlink DENY；唯一原理性残留 = 预存 hardlink 别名，兜底 = nlink>1 扫描 + DataProvenance 校验和。否决备选：继续堆静态规则（verdict 明拒——失败类无穷）；ro-mount 独立只读卷（连 PI 一起锁死 + ingest remount 摩擦）；换基座（自建注册层 / Claude Agent SDK 撞同一堵墙，Claude Code 自身在 macOS 亦以 seatbelt 实现 bash 沙箱）。迁移出口：若离开 macOS 单机形态，等价物 = Linux landlock/bwrap（authority 语义不变）。**2026-07-05 补充（PR #48 gate 收窄）**：条 2' 保证分两层——(a) **byte authority**：seatbelt 在 syscall 层守 raw 字节，穿 symlink/超预算/继承 profile 的子孙进程全覆盖（六类逃逸字节均不落盘）；(b) **denial telemetry**：M1 wrapper 只把可信 raw-denial 证据源升格为 raw 写拒绝，当前可信源为 sandbox tool 内层 advisory/static 同根 raw 写捕获；外层 policy-gate evaluator 若返回 `RAW_DATA_WRITE_RULE_ID`，属于配置误用，必须 fail closed，不得静默 generic deny 或伪造 raw evidence；post-exec stdout/stderr/退出码可被被测命令伪造，仅记录普通 lifecycle `failed`，不得单凭进程结果声明 `raw_data_write_denied` 或 `denied_by_sandbox`。`denied_by_sandbox` 预留给后续不可伪造 OS 事件源。隐藏拒绝完整遥测与双 fork/setsid 后代任意进程树所有权移出 #19，归后续 executor/audit 后端；audit 行只记可观测事实，不声称检出每次被拒尝试。合法 waited 前台子进程（`subprocess.Popen`+wait 写 workspace）MUST 保持放行——process-creation preflight 不得过宽误杀。post-gate findings 均**未击穿 raw 字节完整性**，按 acceptance-boundary 修正处置。

## Risks / Trade-offs

- [spike 任一条不绿] → 计划内退路：ADR-0001 revisit 按修订注顺序，产出评估备忘，不带病继续（非未知风险，是本里程碑的判定目的）。已兑现一次（2026-07-04 条 2）：裁决 = 边界重划而非换基座，见 Decision 13。
- [zero 嵌套 Bun workspace 引用形态不可行（如 `file:` 解析冲突）] → 降级为类型级复制 + 运行时 adapter 隔离，记录到本 change 修订与 ADR-0001 债务清单。
- [GLM 第三方端点不稳定] → 冒烟只验连通不做准入；失败重试一次并记录；准入判定延至 M8 金样 eval（D9 债务已声明）。
- [zero 上游 development 分支漂移] → M1 期间钉死 13e25c1 不 bump。
- [P0 Gate 出现 schema/API/path/lock 冲突] → 按 Readiness 判定规则 block，不进入编码；文档格式类允许 pass_with_notes 且 W1 CI 内修复。

## Migration Plan

零代码起步，无存量迁移。回滚 = git revert（无持久化数据兼容问题）。workspace/ 运行时资产不进代码仓（Repository_Layout §2）。

## Open Questions

- [GRILL-1..3] 已全部定案（2026-07-03 M1 grill，记录见 [ADR-0002 开放项处置节](../../../docs/adr/0002-mvp-reality-anchoring.md)）：不 fork + submodule 引用；工具面照准草案；`GLM_API_KEY`（Config_Secrets §4 已补行，账本例外批次 4）。
- zero 包引用技术形态（workspace 纳入 vs `file:` 依赖 vs 运行时入口加载）：已由 #17 spike 条 1 实测解决并回写 Decision 3；M1 采用 workspace-package-reference。

## Subagent Workflow Fixture — Issue #12

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: deterministic script entry, schema/field/format contract (`readiness_gate` YAML), file output/path/overwrite under `workspace/readiness/`, legacy/submodule compatibility, and persisted/shared-state gating for all downstream M1 coding issues.
- Profile triggers: `readiness`, `workspace`, `idempotency`, `lock`, `SHUD`, `rSHUD`, `AutoSHUD`, `Zero`.

Change surface:
- Optional deterministic readiness helper under `scripts/readiness/`.
- Runtime-only output `workspace/readiness/readiness_gate_v0_8_1.yaml` (must not be committed).
- Contract reads across `.gitmodules`, submodule checkouts, `docs/00_INDEX/CANONICAL_CONTRACTS.md`, `docs/03_SPEC/*`, and `docs/04_IMPLEMENTATION/*`.

Must preserve:
- No edits to frozen docs, implementation packages, or submodule source.
- `workspace/` remains runtime state outside tracked source.
- A blocking readiness conflict must stop downstream coding instead of being hidden as pass.

Must add/change:
- A reproducible way to execute and record the P0 nine-gate readiness result.
- Evidence that every gate has an independent result matching `MVP_Implementation_Readiness_Checklist.md`.

Risk packs considered:
- Public API / CLI / script entry: selected - helper script is a user-invoked deterministic entrypoint.
- Config / project setup: selected - `.gitmodules`, submodule state, package/workspace readiness, and local environment are gate inputs.
- File IO / path safety / overwrite: selected - helper writes runtime YAML and must not write outside `workspace/readiness/`.
- Schema / columns / units / field names: selected - YAML keys and decision values are part of the readiness contract.
- Auth / permissions / secrets: not selected - no credential handling; secret checks are later GLM/observability work.
- Concurrency / shared state / ordering: selected - #12 unlocks or blocks all downstream M1 coding issues.
- Resource limits / large input / discovery: not selected - reads are bounded known files and submodule metadata.
- Legacy compatibility / examples: selected - four submodules must remain readable and unchanged.
- Error handling / rollback / partial outputs: selected - failed gates must produce stable `block` or `pass_with_notes` without partial misleading signoff.
- Release / packaging / dependency compatibility: not selected - packageManager/lockfile are #14.
- Documentation / migration notes: selected - issue/PR summary must record gate evidence and decision.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - readiness signoff is governance evidence for M1 entry.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected - submodule checkout gates cover three scientific repos.
- Zero adapter / tool registry / agent role governance: selected - zero checkout and frozen no-source-edit boundary are M1 prerequisites.

Invariant Matrix:
- Governing invariant: The #12 readiness decision must be derived only from the nine canonical P0 gate checks and must bind to the exact local repo/submodule state inspected.
- Source-of-truth identity/contract: `MVP_Implementation_Readiness_Checklist.md` P0 Gate table plus the generated YAML `readiness_gate.version`, `checked_at`, `decision`, and per-gate keys.
- Producers: readiness helper or manual gate runner; issue/PR evidence summary.
- Validators/preflight: YAML decision enum validation; per-gate pass/block/pass_with_notes mapping.
- Storage/cache/query: `workspace/readiness/readiness_gate_v0_8_1.yaml` runtime file only.
- Public routes/entrypoints: none - #12 has no backend/API surface.
- Frontend/downstream consumers: M1 downstream issues consume the decision semantics, not the runtime file directly.
- Failure paths/rollback/stale state: gate failure yields `decision: block`; workspace output is overwrite-safe and regenerated for current HEAD.
- Evidence/audit/readiness: issue comment or PR description records gate summary, commands, and whether downstream coding is unlocked.
- Regression rows:
  - Current HEAD with all nine P0 checks passing -> YAML contains exactly `gitmodules_parse`, `submodules_checkout`, `canonical_index`, `core_schema`, `support_schema`, `api_registry`, `error_idempotency`, `artifact_registry`, `lock_recovery` under `p0`, each `pass`, and aggregate `decision: pass`.
  - Missing required contract file or unreadable submodule in an isolated temp fixture -> affected gate is non-pass and aggregate decision is `block`.
  - `workspace/readiness/` absent or preexisting -> helper creates/overwrites only `workspace/readiness/readiness_gate_v0_8_1.yaml`; `git status --short -- workspace` remains empty because runtime assets are ignored/untracked.
  - PR or issue evidence summary records per-gate inputs/results and the downstream action: `block` freezes #16+ coding, while `pass|pass_with_notes` unlocks it.

Non-goals:
- Link checking / CI (#13), lockfile and DependencyLock (#14), SHUD make and rSHUD version verification (#15).
- Canonical frozen doc edits; any discovered conflict becomes a block or a separately governed bug-fix/ADR exception.

Review focus:
- Gate list exactly matches the P0 table.
- Runtime output cannot accidentally satisfy source-controlled evidence or enter git.
- `decision` aggregation is conservative and cannot classify contract conflicts as pass.

## Subagent Workflow Fixture - Issue #14

Fixture level: expanded; repair intensity: medium. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: package-manager lockfile source of truth, dependency/version evidence file, submodule commit compatibility, and release/dependency reproducibility.
- Profile triggers: `lock`, `SHUD`, `rSHUD`, `AutoSHUD`, `Zero`, and evidence-chain correctness for readiness.

Change surface:
- Root `package.json` packageManager field.
- Root `bun.lock`.
- Initial `dependency-lock.initial.json` DependencyLock record.

Must preserve:
- `zero/` remains source-clean and pinned to `13e25c1`.
- SHUD, rSHUD, AutoSHUD, and zero submodule worktrees are not edited and record `dirty: false`.
- `packages/**`, submodule source files, and unrelated docs/instruction files remain outside this PR.
- This issue does not upgrade dependencies; it records the current resolved lock graph and submodule commits.

Must add/change:
- Root `package.json` declares a fixed Bun `packageManager`.
- Root Bun lockfile is committed and supports frozen install without drift.
- Initial DependencyLock records package manager version, lockfile path and sha256, direct runtime/dev dependency versions, and the exact SHUD/rSHUD/AutoSHUD/zero submodule commit + dirty state set.
- Deterministic validation under `scripts/dependency-lock/` derives direct external dependencies from root `bun.lock` workspace dependency sections, requires a non-empty DependencyLock `packages` array, compares `name`, resolved `version`, `dependency_type`, and `source` without registry/network access, validates package-manager identity against `package.json#packageManager` and the inspected root lockfile, and validates submodule evidence against `.gitmodules` plus `git submodule status`.

Risk packs considered:
- Public API / CLI / script entry: not selected - no runtime entrypoint behavior changes.
- Config / project setup: selected - package manager version, lockfile, and submodule baselines define install/setup reproducibility.
- File IO / path safety / overwrite: selected - the committed lockfile and DependencyLock are source-controlled evidence files and must not imply runtime workspace writes.
- Schema / columns / units / field names: selected - DependencyLock fields must follow Dependency_Versioning_Policy §6.
- Auth / permissions / secrets: selected - generated lock artifacts must not contain registry auth headers, tokens, or API keys.
- Concurrency / shared state / ordering: not selected - no runtime shared state or concurrent execution path changes.
- Resource limits / large input / discovery: not selected - dependency discovery is bounded to the root lock graph and four known submodules.
- Legacy compatibility / examples: selected - SHUD, rSHUD, AutoSHUD, and zero checkouts remain readable and unchanged.
- Error handling / rollback / partial outputs: selected - lock drift or submodule dirty state must block acceptance rather than be silently recorded.
- Release / packaging / dependency compatibility: selected - this is the initial package-manager and dependency baseline.
- Documentation / migration notes: selected - PR evidence must state Bun version, lockfile sha, and submodule pinning.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - DependencyLock is readiness evidence bound to the exact checkout.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected - scientific submodule commits are recorded as the compatibility baseline.
- Zero adapter / tool registry / agent role governance: selected - zero remains pinned and source-clean for ADR-0001 Trial work.

Invariant Matrix:
- Governing invariant: The initial DependencyLock must describe exactly the inspected root package-manager lockfile, direct external dependency graph, and SHUD/rSHUD/AutoSHUD/zero submodule state for this checkout, without changing source packages or submodules.
- Source-of-truth identity/contract: `package.json#packageManager`, root `bun.lock` sha256, Dependency_Versioning_Policy §6, `.gitmodules`, `git submodule status`, and zero commit `13e25c1`.
- Producers: Bun lockfile generation and DependencyLock record generation.
- Validators/preflight: frozen install, lockfile sha check, DependencyLock JSON validation, package-list validation against the root Bun lock graph, package-manager identity validation, `.gitmodules` parser check, submodule exact-set/status/dirty validation, zero diff/pin check.
- Storage/cache/query: committed root `bun.lock` and `dependency-lock.initial.json`; no runtime workspace state.
- Public routes/entrypoints: none - #14 has no backend/API surface.
- Frontend/downstream consumers: future release/readiness evidence consumes the DependencyLock file, not a runtime API.
- Failure paths/rollback/stale state: lockfile drift, wrong sha, dirty submodule, wrong zero commit, or out-of-bound changed file blocks merge.
- Evidence/audit/readiness: PR evidence records frozen install, lockfile sha, submodule commits, zero diff, and clean package/submodule source status.
- Regression rows:
  - Clean checkout with `bun@1.2.19` -> `bun install --frozen-lockfile` succeeds and `bun.lock` sha256 remains equal to DependencyLock.
  - `node scripts/dependency-lock/validate.mjs` on clean checkout -> DependencyLock `packages` is non-empty and exactly matches the root Bun lock graph's direct external workspace dependencies by `name`, resolved `version`, `dependency_type`, and `source`.
  - Negative package fixtures -> empty `packages`, deleting direct dependency `zod`, and changing the resolved `typescript` version all fail validation.
  - Negative package-manager identity fixtures -> stale `package_manager.version` and wrong `package_manager.lockfile_path` both fail validation.
  - `.gitmodules` parse plus `git submodule status` -> exactly SHUD, rSHUD, AutoSHUD, and zero path/url entries exist; DependencyLock submodules contain no missing/extra/duplicate entries; commits match current checkout; every recorded `dirty` flag is `false`; zero commit is `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`.
  - Negative submodule fixtures -> missing submodule, wrong submodule commit, dirty flag `true`, and wrong zero commit all fail validation.
  - `git -C zero rev-parse HEAD` and `git -C zero diff --quiet` -> zero remains `13e25c1` and source-clean.
  - `git status --short -- packages SHUD rSHUD AutoSHUD zero` -> empty, proving package and submodule source boundaries were not edited.
  - Secret scan over `package.json`, `bun.lock`, and `dependency-lock.initial.json` -> no registry auth, tokens, or API keys.

Non-goals:
- Workspace/package initialization (#16), dependency upgrades, package source edits, submodule updates, DuckDB client selection, or CI frozen-install wiring beyond existing check coverage.

Review focus:
- DependencyLock schema fields, lockfile sha, packageManager version, package list, submodule commits, dirty flags, and zero pin all match the inspected checkout.
- Frozen install produces no lockfile drift.
- The PR contains only the #14 boundary files plus this workflow fixture update.

## Subagent Workflow Fixture - Issue #15

Fixture level: expanded; repair intensity: medium. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: local scientific toolchain execution, submodule build products, R package version evidence, runtime readiness notes, and environment snapshot correctness.
- Profile triggers: `readiness`, `SHUD`, `rSHUD`, local Mac toolchain, SUNDIALS/CVODE, and ignored `workspace/readiness/` evidence.

Change surface:
- Deterministic readiness helper under `scripts/readiness/` for SHUD/rSHUD environment verification.
- OpenSpec workflow fixture rows for #15.
- PR/issue evidence comments carrying the actual local environment snapshot and command results.

Must preserve:
- SHUD and rSHUD submodule source files and pointers remain unchanged.
- Build products are transient runtime evidence only; readiness notes are ignored runtime/PR evidence only; neither enters git.
- Existing P0 readiness helper behavior and output schema remain unchanged.
- #15 does not CI-ize SHUD compilation and does not install or upgrade rSHUD.

Must add/change:
- A repeatable helper records OS, compiler, and SUNDIALS evidence.
- The helper runs the SHUD build command from `SHUD/`, verifies exit code 0 and `SHUD/shud` existence at verification time, and cleans runtime build outputs when requested by the workflow.
- The helper checks local R `packageVersion("rSHUD") >= 2.5.0`; the submodule `DESCRIPTION` version may be recorded as supporting source evidence but cannot replace the installed-package check.
- Self-test fixtures cover SHUD build failure, missing executable after success, and rSHUD below the minimum version without touching live submodules.

Risk packs considered:
- Public API / CLI / script entry: selected - new readiness helper is a developer-facing script entrypoint.
- Config / project setup: selected - local compiler, SUNDIALS, and R package state are readiness inputs.
- File IO / path safety / overwrite: selected - helper-authored readiness notes must stay under ignored `workspace/readiness/` or temporary fixture paths; real SHUD build products may appear transiently under `SHUD/` during build verification, but must be cleaned or proven absent from source control before merge.
- Schema / columns / units / field names: selected - readiness note fields for environment/build/version evidence are reviewable evidence.
- Auth / permissions / secrets: not selected - no credentials or network auth are read or emitted.
- Concurrency / shared state / ordering: not selected - one-shot local readiness command, no server shared state.
- Resource limits / large input / discovery: selected - helper must inspect fixed paths and avoid unbounded repository scans.
- Legacy compatibility / examples: selected - SHUD/rSHUD submodules remain readable and source-clean.
- Error handling / rollback / partial outputs: selected - failed build/version checks must return non-zero and leave no committed/runtime source drift.
- Release / packaging / dependency compatibility: selected - this confirms local SHUD/SUNDIALS/rSHUD compatibility baseline.
- Documentation / migration notes: selected - PR evidence must state actual environment snapshot and conclusions.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - local toolchain readiness is governance evidence for M1 entry.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected - SHUD compiler and rSHUD installed package are scientific runtime prerequisites.
- Zero adapter / tool registry / agent role governance: not selected - no Zero runtime changes.

Invariant Matrix:
- Governing invariant: #15 readiness evidence must describe the actual local SHUD build and installed rSHUD version for this checkout while leaving SHUD/rSHUD sources, submodule pointers, build artifacts, and runtime notes out of git; transient SHUD build outputs are allowed only during verification and must be cleaned or proven source-control-invisible before merge.
- Source-of-truth identity/contract: `openspec/changes/m1-foundation/specs/readiness-gates/spec.md` requirement "SHUD make 复验与 rSHUD 在位确认", ADR-0002 D2, SHUD `Makefile`, local R `packageVersion("rSHUD")`, rSHUD `DESCRIPTION`, and ignored `workspace/readiness/`.
- Producers: readiness helper and PR/issue evidence comments.
- Validators/preflight: helper self-test, actual helper run, `Rscript packageVersion("rSHUD")`, SHUD build exit code and executable existence, SUNDIALS evidence scan, `git status --short -- SHUD rSHUD workspace`.
- Storage/cache/query: ignored `workspace/readiness/` note file and PR/issue evidence only; no source-controlled runtime notes.
- Public routes/entrypoints: script CLI only; no backend/API surface.
- Frontend/downstream consumers: #38 M1 acceptance consumes the PR/issue evidence and readiness notes.
- Failure paths/rollback/stale state: build command failure, missing executable after success, rSHUD below 2.5.0, missing Rscript, or dirty SHUD/rSHUD/workspace state blocks #15.
- Evidence/audit/readiness: PR evidence records OS, compiler, SUNDIALS version/path evidence, SHUD build command/exit/artifact observation, rSHUD installed and submodule versions, and cleanup/source-boundary status.
- Regression rows:
  - Real local run -> SHUD build exits 0, `SHUD/shud` exists during verification, rSHUD installed version is `>=2.5.0`, and readiness notes contain environment/build/version evidence.
  - SHUD build failure fixture -> helper exits non-zero and records the failed build result without claiming readiness.
  - Missing executable fixture after a successful build command -> helper exits non-zero.
  - rSHUD version below `2.5.0` fixture -> helper exits non-zero.
  - `git status --short -- SHUD rSHUD workspace` after helper/self-test -> empty.

Non-goals:
- Installing SUNDIALS, compiling SHUD in CI, installing/upgrading rSHUD, running SHUD examples, editing SHUD/rSHUD source, committing runtime notes, or modifying the #12 P0 YAML schema.

Review focus:
- The helper distinguishes installed rSHUD package evidence from submodule DESCRIPTION evidence.
- Build artifact observation is real but artifacts are not committed or left as source drift.
- Failure fixtures exercise the readiness claims without depending on live submodule mutation.

## Subagent Workflow Fixture — Issue #19

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: bash tool entrypoint, subprocess execution wrapper, OS sandbox profile, file write/delete/rename boundary under `data/raw/**`, symlink/path alias behavior, audit file output, and WebSocket `tool.failed` envelope.
- Profile triggers: `workspace`, `remediation`, `guard_class`, `Zero`, `ToolBase`, `beforeExecute`, and Zero adapter/tool registry governance.

Change surface:
- `packages/core` bash sandbox/profile helpers, bash execution wrapper, advisory policy-gate rule, hardlink/nlink check helper, and focused tests.
- `packages/backend/src/ws` skeleton event builder for existing `tool.failed`, if not already in place.
- Audit helper for `workspace/tasks/TASK-M1-SPIKE/audit/` minimum rows with profile identity.

Must preserve:
- `zero/` remains source-clean and pinned to `13e25c1`; wrapping lives in SHUD-owned packages only.
- Pre-exec policy gate core remains pure; static detection is advisory/fail-open and must not be the authority for arbitrary bash writes.
- Legitimate `data/raw/**` reads and writes to workspace allowed directories remain allowed under the sandbox.
- No new WebSocket event type is introduced; `tool.failed` remains the only skeleton event used here.

Must add/change:
- Bash execution applies a macOS seatbelt profile via `sandbox-exec -f <profile>` so writes to canonical `data/raw/**` are denied at syscall time and inherited by child processes.
- Trusted sandbox-tool-owned raw-denial evidence returns the remediation-shaped tool error family, produces `tool.failed`, and writes audit denial evidence; outer `RAW_DATA_WRITE_RULE_ID` evaluator denials fail closed as configuration misuse; post-exec process output alone remains generic lifecycle evidence.
- The profile builder records a stable profile identifier in audit rows.
- A reusable `nlink>1` scanner/helper demonstrates and detects the pre-existing hardlink residual; formal ingest/readiness wiring remains out of scope.

Risk packs considered:
- Public API / CLI / script entry: selected - bash tool invocation and SHUD wrapper are the guarded execution entrypoint.
- Config / project setup: selected - macOS `sandbox-exec` availability and generated seatbelt profile path affect runtime behavior.
- File IO / path safety / overwrite: selected - protected raw-data write/delete/rename behavior and symlink/path alias handling are the core invariant.
- Schema / columns / units / field names: selected - ErrorRecord remediation, `tool.failed` payload, and audit row fields are contract-shaped.
- Auth / permissions / secrets: not selected - no credential or user permission model changes in this slice.
- Concurrency / shared state / ordering: selected - subprocess children must inherit the sandbox and audit output must bind to the exact profile/run.
- Resource limits / large input / discovery: selected - nlink scanning must be bounded to the protected roots it is asked to inspect.
- Legacy compatibility / examples: selected - existing policy-gate wrapper behavior and raw-data read flows must continue working.
- Error handling / rollback / partial outputs: selected - sandbox enforcement must leave no raw write behind; trusted advisory/static raw-denial evidence returns a stable tool failure, while post-exec process output alone stays generic lifecycle failure.
- Release / packaging / dependency compatibility: selected - implementation must keep zero source diff at 0 and avoid adding non-M1 runtime dependencies.
- Documentation / migration notes: selected - PR evidence must state macOS-only seatbelt scope and Linux backend as ADR-recorded migration exit.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - raw data is protected evidence input; denials and residual hardlink detection must be auditable.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected - raw input reads are common scientific workflows and must not be blocked.
- Zero adapter / tool registry / agent role governance: selected - wrapper uses the #17 seam and must not modify Zero.

Invariant Matrix:
- Governing invariant: A bash command may read `data/raw/**` but must not be able to create, modify, delete, rename, or truncate protected raw-data bytes through the SHUD bash wrapper.
- Source-of-truth identity/contract: ADR-0001 2026-07-04裁决, policy-gate-spike 条 2', guard/profile id, `ErrorRecord.remediation`, `tool.failed`, and `workspace/tasks/TASK-M1-SPIKE/audit/`.
- Producers: bash sandbox/profile helper, bash wrapper, advisory rule, audit helper, WS event builder.
- Validators/preflight: profile builder tests, advisory rule tests, nlink scanner tests, sandbox execution tests.
- Storage/cache/query: temporary sandbox profile file during execution; fixture audit file under `workspace/tasks/TASK-M1-SPIKE/audit/`.
- Public routes/entrypoints: none - M1 skeleton builder only, no full backend WS route implementation.
- Frontend/downstream consumers: future AgentActivityFeed consumes `tool.failed`; M1 asserts envelope/payload shape only.
- Failure paths/rollback/stale state: seatbelt enforcement must not leave a raw-data mutation; advisory/static denial is allowed only for clear writes and must not overdeny reads; process-result-only failures must not be mislabeled as `denied_by_sandbox`.
- Evidence/audit/readiness: unit/integration tests plus PR evidence; hardlink residual evidence records both leak demonstration and `nlink>1` detection.
- Regression rows:
  - Six escape classes (interpreter payload, pipeline/stdin, dynamic target, shell state/child process, symlink or `../` alias, rename/unlink) targeting `data/raw/**` -> no raw mutation; advisory/static same-root evidence may fail before execution with remediation, `tool.failed`, audit row including profile id and `decision=denied_by_advisory`; post-exec process-result-only failures remain generic lifecycle evidence and must not be presented as `denied_by_sandbox`; hidden/suppressed denials remain out of telemetry scope and must not be presented as detected.
  - `cat data/raw/input.csv` and a workspace allowed write under the same profile -> command succeeds.
  - Pre-existing hardlink alias to a raw file written outside the protected subpath -> documented residual behavior, `nlink>1` helper accepts explicit protected roots, reads metadata only under those roots, avoids broader workspace/repo traversal, and flags the raw source/root as unsafe.
  - Obvious static raw write seen by advisory layer -> may be denied before execution with remediation and audit/WS evidence; advisory misses remain covered by sandbox and advisory must not block legal reads.
  - `git -C zero diff --quiet` and HEAD `13e25c1` -> unchanged after implementation.

Boundary-surface checklist:
- Shared helper roots: `packages/core/src/tools/*` policy/sandbox/audit helpers.
- Public entrypoints: wrapped bash tool `run()` path only.
- Read surfaces: raw-data reads under sandbox; nlink scan reads metadata only.
- Write/delete/overwrite surfaces: sandboxed bash subprocess writes, deletes, renames, truncation, symlink aliases, and audit append helper.
- Producer/consumer evidence boundaries: trusted sandbox-tool-owned advisory/static raw-denial -> ErrorRecord-shaped payload -> WS `tool.failed` -> audit row with same rule/profile identity; outer raw-rule evaluator misuse -> configuration failure without raw profile identity; sandboxed command lifecycle -> audit row with profile identity and generic `allowed|failed`.
- Unchanged downstream consumers: generic policy-gate pure evaluator, Zero tool registry wrapper, and future full WS/AuditEvent implementation.

Non-goals:
- Full shell parser, Linux landlock/bwrap backend, full WebSocket protocol/session bus, full AuditEvent schema, and ingest/readiness hardlink scan wiring.
- Raw data read prohibition.

Review focus:
- Sandbox denial is the authority and runs at execution time, not a static string scan.
- Child process inheritance, path alias behavior, and raw-read compatibility are covered by tests.
- Denial evidence is synchronized across tool result, WS skeleton event, and audit row only for trusted raw-denial sources; process-result-only failures stay synchronized as generic lifecycle facts.
- Hardlink residual is demonstrated honestly and the reusable nlink helper detects it.

## Subagent Workflow Fixture - Issue #20

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: spawn tool entrypoint, permissions/profile enforcement, ErrorRecord remediation contract, and Zero adapter/tool registry governance.
- Profile triggers: `remediation`, `guard_class`, `Zero`, `ToolBase`, `beforeExecute`, and role/tool governance.

Change surface:
- `packages/core` policy-gate pure rule for spawn profile subset validation.
- SHUD runtime tool registry default evaluator wiring for `spawn_agent`.
- Focused unit/runtime tests for the Zero spawn parameter `tools`; spec term `allowed_tools` maps to Zero's `tools` allowlist input.

Must preserve:
- `zero/` remains source-clean and pinned to `13e25c1`; no Zero spawn implementation edits.
- Existing policy-gate wrapper behavior for bash/edit/spawn denials remains stable.
- #24 role-to-tool map remains the only comparable profile source; this issue must not copy a second tool profile table.
- Spawn depth and concurrent subagent limits remain out of scope for #20 and stay assigned to #27.

Must add/change:
- A reusable spawn profile subset rule rejects `spawn_agent` calls whose requested role's allowlist contains any tool id outside that role's canonical `ROLE_TOOL_MAP` entry.
- Rejection payload uses `remediation.next_action=adjust_scope`, includes bounded representative excess tool examples plus total count in the hint, and points `ref` to Roles_and_Boundaries §0.
- The rule is tagged with `guard_class=authority` in rule metadata or denial evidence available to this slice; if the #26 guard-class assembly lint is not yet merged, #20 leaves the concrete lint hook to #26 and records the marker on the rule.

Risk packs considered:
- Public API / CLI / script entry: selected - `spawn_agent` is a tool-call entrypoint and must be guarded before execution.
- Config / project setup: not selected - no package manager, provider, or environment setup changes.
- File IO / path safety / overwrite: not selected - this slice does not read/write files at runtime beyond tests.
- Schema / columns / units / field names: selected - remediation and rule metadata are contract-shaped.
- Auth / permissions / secrets: selected - role permission profile enforcement is the core authority boundary.
- Concurrency / shared state / ordering: not selected - depth/concurrency are #27 non-goals.
- Resource limits / large input / discovery: selected - spawn allowlists are untrusted tool-call input and must be bounded before trim/dedup/filter processing.
- Legacy compatibility / examples: selected - existing Zero `tools` allowlist behavior and role-map tests must remain compatible.
- Error handling / rollback / partial outputs: selected - denial must happen before the underlying spawn executes and must be navigable.
- Release / packaging / dependency compatibility: selected - no new runtime dependency and zero source diff stays 0.
- Documentation / migration notes: selected - PR evidence must state the `allowed_tools` to `tools` terminology bridge and #27 split.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no scientific evidence or PI-gated model decision changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver or hydrology runtime behavior changes.
- Zero adapter / tool registry / agent role governance: selected - this is the governing boundary under test.

Invariant Matrix:
- Governing invariant: A spawn request may reduce a target role's tool allowlist, but must never add a tool id outside that role's canonical profile.
- Source-of-truth identity/contract: Roles_and_Boundaries §0 role registry, #24 `ROLE_TOOL_MAP`, policy-gate-spike 条 3, and Control_Kernel §5.
- Producers: spawn policy rule and SHUD runtime registry evaluator composition.
- Validators/preflight: pure policy-gate unit tests and wrapped `spawn_agent` runtime tests.
- Storage/cache/query: none - no persisted runtime state in this slice.
- Public routes/entrypoints: wrapped `spawn_agent.run()` only.
- Frontend/downstream consumers: none - M1 has no spawn UI surface.
- Failure paths/rollback/stale state: denied spawn returns a stable policy-gate error without invoking the underlying spawn tool.
- Evidence/audit/readiness: unit tests, OpenSpec validation, zero diff check, and PR review evidence.
- Regression rows:
  - Worker role spawn with `tools=["read","edit"]` -> deny before spawn execution, `remediation.next_action=adjust_scope`, hint contains `edit`, ref points to Roles_and_Boundaries §0.
  - Worker role spawn with a subset such as `tools=["read","sandbox.exec"]` -> allow at pure rule level; SHUD runtime registers the sandboxed command tool under canonical `sandbox.exec` as well as raw Zero `bash`, so exact Zero scoped-registry selection gives workers the executable sandbox tool instead of silently dropping it.
  - Canonical-role spawn input without an explicit allowlist -> normalized before Zero execution to that role's #24 canonical profile, so Zero built-in or `.zero/roles` defaults cannot widen SHUD permissions.
  - Spec alias `allowed_tools` -> normalized to Zero's real `tools` input before execution; malformed or empty canonical-role allowlists -> fail closed with `remediation.next_action=adjust_scope`.
  - Whitespace-padded canonical roles -> policy checks and normalized execution input use the same trimmed role identity as Zero, so `role="reviewer "` cannot bypass #24 role profiles.
  - Missing or non-canonical target role -> fail closed before Zero execution, because there is no #24 canonical profile to prove an explicit allowlist is only a subset; future registry lint may add richer role-schema diagnostics but cannot re-open roleless/custom-role authority.
  - Custom runtime evaluators -> run after SHUD mandatory authority guards and may only add denials, not replace spawn profile subset enforcement.
  - Custom runtime evaluators receive an isolated policy input snapshot and cannot mutate the execution input after authority evaluation.
  - Oversized or malformed tool-id lists -> processing fails closed under explicit count/length/total-character budgets; excess-tool denial remains bounded, includes a small sample such as `edit` plus total count, and does not echo every untrusted id.
  - `git -C zero diff --quiet` and HEAD `13e25c1` -> unchanged after implementation.

Boundary-surface checklist:
- Shared helper roots: `packages/core/src/tools/policy-gate-core.ts`, `policy-gate-registry.ts`, and `role-tool-map.ts`.
- Public entrypoints: wrapped `spawn_agent.run()` path only.
- Producer/consumer evidence boundaries: #24 role map constants -> spawn subset rule -> policy-gate denial JSON.
- Unchanged downstream consumers: Zero `SpawnAgentTool`, role-map snapshot tests, bash sandbox wrapper, and future #27 depth/concurrency checks.

Non-goals:
- Spawn depth limit, concurrent subagent limit, true M3 spawn scheduling, role-file loading, and guard-class assembly lint.
- Changing the canonical role map contents.

Review focus:
- The comparison directly references #24 constants and never duplicates the profile table.
- Runtime tests exercise Zero's real `tools` input name, while PR evidence states it is the implementation of spec `allowed_tools`.
- Denial occurs before the underlying spawn tool can create a subagent and gives an actionable `adjust_scope` remediation.

## Subagent Workflow Fixture - Issue #25

Fixture level: expanded
Project profile: SHUD-Harness
Change surface:
- `packages/core/src/tools/policy-gate-registry.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`
- `packages/core/src/tools/raw-data-sandbox.ts`

Must preserve:
- Existing policy-gated wrapper behavior: evaluator denials and input-preparation failures happen before inner tool execution and return structured payloads.
- Existing spawn profile subset behavior and #24 role-map comparison semantics.
- Existing raw-data sandbox registry behavior, including `bash` / `sandbox.exec` wrapping and raw-denial ownership.
- `zero/` remains source-clean and pinned; no Zero source edits.

Must add/change:
- Register-time lint at the #17 tool registration/wrap seam.
- Per-role visible tool count budget: `<= 20`; the 21st visible tool is rejected with role and excess count.
- Tool description completeness check for the three Control_Kernel §5.3 sections: `何时该用`, `何时不该用`, `成功与失败样态`.
- Zod parameter schema validation before inner tool execution; validation failure returns structured rejection payload with `remediation{next_action,hint,ref}`.

Risk packs considered:
- Public API / CLI / script entry: selected - tool registration and wrapped tool execution are shared entrypoints.
- Config / project setup: not selected - no package manager, provider, or environment setup changes.
- File IO / path safety / overwrite: not selected - no file mutation behavior beyond tests.
- Schema / columns / units / field names: selected - tool parameter schema and rejection payload shape are contracts.
- Auth / permissions / secrets: selected - role-visible tool budgets enforce the tool authority surface.
- Concurrency / shared state / ordering: not selected - no shared runtime state or scheduling changes.
- Resource limits / large input / discovery: selected - per-role tool count is an explicit resource/cognitive budget.
- Legacy compatibility / examples: selected - existing policy-gate, spawn subset, and raw sandbox tests must remain green.
- Error handling / rollback / partial outputs: selected - schema validation failure must be non-silent and pre-execution.
- Release / packaging / dependency compatibility: selected - no new dependency; Bun/TypeScript checks must remain compatible.
- Documentation / migration notes: selected - PR evidence must call out the lint boundary and non-goals.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no scientific decision or evidence claim changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: selected - this is the core shared boundary.

Required evidence:
- Focused Bun tests: 21st role-visible tool registration -> assembly failure with role and excess count.
- Focused Bun tests: missing `何时不该用` description section -> assembly failure with missing section.
- Focused Bun tests: Zod parameter schema failure -> inner tool not executed and structured rejection payload includes remediation three fields.
- Compatibility: `bun run test:policy-gate` and `bun run check`.
- `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`.

Non-goals:
- Changing `ROLE_TOOL_MAP` contents or #24 snapshot oracle.
- `guard_class` assembly lint; remains #26.
- Spawn depth/concurrency hard limits; remain #27.
- Adding new runtime dependencies or editing Zero source.

Review focus:
- Lint is applied at registry assembly/wrap time, not as a late runtime note.
- The description-section check is exact enough to fail missing required sections while preserving existing valid tools.
- Zod validation failures are returned as structured policy-gate-style denials and do not execute inner tools.
- Existing registry and sandbox behavior remains compatible.

## Subagent Workflow Fixture - Issue #59

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness
Change surface:
- `packages/core/src/tools/policy-gate-core.ts`
- `packages/core/src/tools/policy-gate-core.test.ts`
- `packages/core/src/tools/policy-gate-registry.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`

Must preserve:
- Existing evaluator and execution-validator allow/deny semantics.
- Reserved authority `ruleId` and `guard_class` fail-closed behavior from #26/#27.
- Inner tools are not executed when decision validation fails.
- `zero/` remains source-clean and pinned; no Zero source edits.

Must add/change:
- Policy-gate decision candidates from custom evaluators and execution validators are snapshotted as plain data before validation reads identity fields.
- Rule decisions returned by `PolicyRule.evaluate()` through `createPolicyGateEvaluator(...)` are snapshotted as plain data before `evaluatePolicyGate(...)` reads identity fields.
- Proxy-backed, accessor-backed, or enumerable-`toJSON` decision objects fail closed with a stable policy-gate validation error.
- Trap text or accessor-thrown sentinel text is not echoed through `ToolResult.output` or `outputSummary`.

Risk packs considered:
- Public API / CLI / script entry: selected - custom evaluators and execution validators are public extension seams for wrapped tools.
- Config / project setup: not selected - no package manager, provider, or environment setup changes.
- File IO / path safety / overwrite: not selected - no file mutation behavior beyond tests.
- Schema / columns / units / field names: selected - policy decision payload shape is a structured contract.
- Auth / permissions / secrets: selected - reserved authority decisions must not be spoofed or downgraded through malformed payloads.
- Concurrency / shared state / ordering: not selected - no shared runtime state or scheduling changes.
- Resource limits / large input / discovery: selected - snapshotting must bound traversal and reject hostile objects without executing traps.
- Legacy compatibility / examples: selected - existing policy-gate, spawn subset, and raw sandbox tests must remain green.
- Error handling / rollback / partial outputs: selected - invalid decisions must fail closed before side effects and with stable error text.
- Release / packaging / dependency compatibility: selected - no new dependency; Bun/TypeScript checks must remain compatible.
- Documentation / migration notes: selected - PR evidence must explain this is a #26 review follow-up and not a policy semantic change.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no scientific decision or evidence claim changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: selected - policy-gate wrapper authority is the shared governance boundary.

Invariant Matrix:
- Governing invariant: Policy-gate decisions from extension seams must be validated only from bounded, plain-data snapshots, so hostile objects cannot execute code during validation or control stable error text.
- Source-of-truth identity/contract: `PolicyGateDecision` / `PolicyGateDecisionInput`, `PolicyGateRemediationSchema`, reserved authority rule id helpers, and `PolicyGateDecisionValidationError`.
- Producers: custom policy evaluators, execution validators, and custom `PolicyRule.evaluate()` functions.
- Validators/preflight: `evaluatePolicyGate`, `validatePolicyGateDecision`, `validatePolicyGateDenyDecision`, and the decision-candidate snapshot helpers.
- Storage/cache/query: none - decisions are per-call in-memory payloads.
- Public routes/entrypoints: `wrapToolWithPolicyGate(...).run(...)`, `createShudPolicyGateEvaluator(...)`, and execution-validator paths.
- Frontend/downstream consumers: `ToolResult.output`, `ToolResult.outputSummary`, `policy_gate_denied` payload consumers, and running-tool terminal metadata.
- Failure paths/rollback/stale state: malformed/proxy/accessor/toJSON decision candidates fail closed before inner execution and without untrusted trap text.
- Evidence/audit/readiness: PR evidence and review-loop log record #59 as a #26 follow-up hardening, not a policy semantic change.
- Regression rows:
  - Plain valid allow/deny decision -> existing allow/deny semantics and structured `policy_gate_denied` payloads are preserved.
  - Evaluator proxy/accessor decision -> `success=false`, stable `Invalid policy gate decision...` in `output` and `outputSummary`, sentinel/trap text absent from both, no `policy_gate_denied`, inner tool call count `0`.
  - Execution-validator proxy/accessor deny decision -> same stable failure contract and inner tool call count `0`.
  - Rule-based evaluator proxy/accessor decision via `createPolicyGateEvaluator(...)` -> same stable failure contract and inner tool call count `0` when wrapped.
  - Enumerable `toJSON` decision candidate -> rejected or ignored without invoking `toJSON`, without sentinel text leak, and without changing validation semantics.
  - Over-depth or over-wide decision object -> bounded fail-closed validation result or explicit non-goal rationale; no unbounded traversal.

Boundary-surface checklist:
- Shared helper roots: `policy-gate-core.ts` rule evaluation helpers, `policy-gate-registry.ts` decision validation helpers, and policy wrapper error-result builders.
- Public entrypoints: custom evaluator path, execution-validator path, direct `createShudPolicyGateEvaluator` custom path, and `createPolicyGateEvaluator(...)` rule-based custom context path.
- Read surfaces: decision candidate own descriptors only; no accessor/proxy trap execution.
- Write/delete/overwrite surfaces: none.
- Producer/consumer evidence boundaries: candidate decision object -> validation snapshot -> `PolicyGateDecision` or stable failed `ToolResult`.
- Stale-state/idempotency boundaries: none - per-call validation only.
- Unchanged downstream consumers: ordinary plain-object allow/deny decisions, reserved authority validation tests, raw-data sandbox policy-gate composition tests, and running tool handle finalization.

Required evidence:
- Evaluator returns proxy/accessor decision -> `success=false`, stable `Invalid policy gate decision...` in `output`/`outputSummary`, sentinel trap text absent from both, no `policy_gate_denied`, inner tool call count `0`.
- Execution validator returns proxy/accessor deny decision -> `success=false`, stable `Invalid policy gate decision...` in `output`/`outputSummary`, sentinel trap text absent from both, no `policy_gate_denied`, inner tool call count `0`.
- Custom `PolicyRule.evaluate()` returns proxy/accessor decision through `createPolicyGateEvaluator(...)` -> stable `PolicyGateDecisionValidationError`; when wrapped, sentinel trap text absent from `output`/`outputSummary`, no `policy_gate_denied`, and inner tool call count `0`.
- Consumed nested `remediation` proxy/accessor fields in evaluator and execution-validator decisions -> stable invalid-decision failure without sentinel leak and without inner execution.
- Enumerable `toJSON` on a decision candidate -> rejected or ignored without invoking `toJSON`, without sentinel text leak, and without affecting valid plain-object decision behavior.
- Resource-boundary evidence: snapshotting rejects or bounds over-depth/over-wide decision candidates, or records a precise non-goal if the snapshot only reads the first-level decision contract by descriptor.
- Existing reserved authority decision validation tests remain green.
- PR evidence states #59 is a #26 review follow-up and not a policy semantic change.
- `bun run test:policy-gate`; `bun run check`; `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`.

Non-goals:
- WebSocket and audit public-input snapshots already covered by #26.
- Changing policy rule semantics, reserved rule ids, `guard_class` taxonomy, or raw-data sandbox behavior.

Review focus:
- Decision validation reads only a stable, plain-data snapshot and never invokes user-supplied getters, proxies, or `toJSON`.
- Stable validation errors do not contain untrusted trap text.
- The custom evaluator, execution-validator, and rule-based evaluator paths are covered.
- Existing policy-gate denial payloads remain compatible for ordinary plain objects.

## Subagent Workflow Fixture - Issue #61

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness

Expanded-trigger rationale:
- Core triggers: concurrency, shared runtime state, public tool entrypoint, and error/remediation contract.
- Profile triggers: `Zero`, tool registry governance, `remediation`, and `guard_class`.

Change surface:
- `packages/core/src/tools/policy-gate-registry.ts`
- `packages/core/src/tools/policy-gate-registry.test.ts`

Must preserve:
- #27 pure policy-gate contract: `activeSubagentCount >= 3` denies before `spawn_agent` execution with rule id `spawn-concurrency-limit`.
- Standard Zero session serialized execution remains compatible; no M3 queue scheduler is introduced.
- `zero/` remains source-clean and pinned; no Zero source edits.
- Existing spawn profile subset, spawn depth, zod parameter validation, and tool-availability denials keep their policy identity and remediation.

Must add/change:
- Direct concurrent `spawn_agent.run()` calls sharing the same trusted `agentControl` must not both pass admission when `activeAgentCount=2` and max concurrent subagents is 3.
- Admission ownership sits in the SHUD policy-gated adapter layer as a per-`agentControl` reservation/recheck around spawn execution; the pure rule stays unchanged.
- Reservation is released on success, denial, validation failure, or inner tool failure, so serialized follow-up calls are not permanently blocked.

Risk packs considered:
- Public API / CLI / script entry: selected - `spawn_agent.run()` is a direct public tool entrypoint.
- Config / project setup: not selected - no package manager, provider, or environment setup changes.
- File IO / path safety / overwrite: not selected - no file mutation behavior beyond tests.
- Schema / columns / units / field names: selected - denial payload identity and remediation are structured contracts.
- Auth / permissions / secrets: selected - spawn admission is an authority boundary for subagent capability creation.
- Concurrency / shared state / ordering: selected - this is the defect class.
- Resource limits / large input / discovery: selected - max concurrent subagents is an explicit runtime resource limit.
- Legacy compatibility / examples: selected - existing policy-gate, spawn profile, depth, and raw sandbox tests must remain green.
- Error handling / rollback / partial outputs: selected - denied admission must not invoke the inner spawn tool and reservations must unwind on all early exits.
- Release / packaging / dependency compatibility: selected - no new dependency; Bun/TypeScript checks must remain compatible.
- Documentation / migration notes: selected - PR evidence must state this is a #27/#60 follow-up and not M3 scheduling.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no scientific decision or evidence claim changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: selected - admission sits at the SHUD wrapper boundary over Zero tools.

Invariant Matrix:
- Governing invariant: Every direct `spawn_agent` admission for the same trusted `agentControl` must reserve capacity before any async gap, so observed active subagents plus reservations never exceeds `MAX_CONCURRENT_SUBAGENTS`.
- Source-of-truth identity/contract: Control_Kernel §5 max concurrent subagents, `MAX_CONCURRENT_SUBAGENTS`, `SPAWN_CONCURRENCY_LIMIT_RULE_ID`, and `SPAWN_LIMITS_POLICY_REF`.
- Producers: `agentControl.activeAgentCount` and the adapter-owned in-memory reservation map.
- Validators/preflight: wrapped `spawn_agent.run()` admission and existing spawn concurrency policy-gate rule.
- Storage/cache/query: per-process WeakMap keyed by trusted `agentControl`; no persisted runtime state.
- Public routes/entrypoints: direct wrapped `spawn_agent.run()` calls and standard Zero serialized tool execution.
- Frontend/downstream consumers: `ToolResult.output` `policy_gate_denied` payloads and spawn caller expectations.
- Failure paths/rollback/stale state: reservation releases in a `finally` path for denials, validation errors, successful spawn, and inner-tool failures.
- Evidence/audit/readiness: focused Bun concurrency tests, OpenSpec validation, zero diff check, and PR review evidence.
- Regression rows:
  - Two concurrent direct `spawn_agent.run()` calls with shared `agentControl.activeAgentCount=2` -> exactly one inner spawn call, one denial with `spawn-concurrency-limit`, `guard_class=authority`, and `remediation.next_action=adjust_scope`.
  - A later serialized spawn after the first call completes and active count stays below max -> allowed, proving reservation release.
  - Existing trusted `activeAgentCount=3` single call -> denied before inner execution with unchanged remediation payload.
  - Malformed trusted `activeAgentCount` -> fail closed with `spawn-concurrency-limit` and no reservation leak.
  - Standard Zero serialized call with `activeAgentCount=0` and canonical worker tool subset -> remains compatible and spawns once.
  - `git -C zero diff --quiet` -> unchanged after implementation.

Boundary-surface checklist:
- Shared helper roots: `policy-gate-registry.ts` spawn adapter admission helpers.
- Public entrypoints: wrapped `spawn_agent.run()` only.
- Producer/consumer evidence boundaries: `agentControl.activeAgentCount` plus reservation count -> policy-gate denial JSON.
- Stale-state/idempotency boundaries: reservation lifetime is per call and must not leak after early return or thrown inner tool.
- Unchanged downstream consumers: pure `policy-gate-core` spawn rules, Zero `SpawnAgentTool`, role-map snapshot tests, bash/raw sandbox wrapper, and future M3 queue scheduling.

Required evidence:
- Barrier-style Bun test for concurrent direct `spawn_agent.run()` calls with `activeAgentCount=2`: one success, one `spawn-concurrency-limit` denial, one inner spawn call total.
- Follow-up serialized call after the concurrent pair proves reservation release.
- Existing max-active and malformed-active tests still pass with unchanged rule id and remediation.
- Existing spawn subset/depth/tool-availability tests remain green.
- PR evidence states this is a #27/#60 direct-entrypoint hardening, not full M3 queue scheduling.
- `bun run test:policy-gate`; `bun run check`; `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`.

Non-goals:
- Implementing a queue, retry scheduler, cancellation semantics, or cross-process/distributed spawn reservations.
- Changing pure policy-gate rule semantics, max constants, role tool profiles, or Zero source.

Review focus:
- Reservation happens before any awaited operation and is scoped to trusted `agentControl`, not model-controlled input.
- Denial uses the existing spawn concurrency policy identity/remediation.
- Reservation release is covered for success and early-failure paths.
- Existing serialized Zero behavior and #20/#27 spawn guard behavior remain compatible.

## Subagent Workflow Fixture - Issue #28

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness

Expanded-trigger rationale:
- Core triggers: public REST API entrypoints, workspace directory writes, path/schema/field contracts, readiness state, and error/status compatibility.
- Profile triggers: `workspace`, `readiness`, snapshot/readiness directories, and API evidence-chain correctness.

Change surface:
- `packages/backend/src/routes/**` and any backend app/test helpers needed to exercise routes.
- `packages/core/src/**` workspace directory constants/helpers if implementation shares workspace tree logic.
- Backend package scripts/tests for workspace init and health endpoints.

Must preserve:
- Runtime workspace assets remain outside tracked source; tests use temp workspaces only.
- `workspace/` source-controlled ignore behavior and `zero/` source cleanliness remain unchanged.
- #29 owns TaskCard creation/snapshot restore; #30 owns idempotency/lock skeleton; #31 owns structured logs; #32 owns perf smoke; #33 owns general path safety helper.
- Health endpoint paths follow `Schemas_APIs_CLIs.md`: `GET /api/health/live`, `GET /api/health/ready`, and workspace init is `POST /api/workspace/init`.

Must add/change:
- `POST /api/workspace/init` creates the canonical M1 workspace directory tree, including `readiness/`, and is safe to call repeatedly without overwriting existing files.
- Live health returns 2xx with `status`, `version`, `uptime_seconds`, and `timestamp`.
- Ready health returns non-2xx before workspace initialization, and after initialization reports checks including directory tree presence, `snapshot_readable`, and `workspace_writable`.
- Workspace-not-writable readiness reports `status=not_ready` and `workspace_writable=fail` without attempting unrelated write locations.

Risk packs considered:
- Public API / CLI / script entry: selected - three REST endpoints are public backend entrypoints.
- Config / project setup: selected - workspace root configuration/defaulting affects local runtime setup.
- File IO / path safety / overwrite: selected - init creates directories and readiness probes perform write checks.
- Schema / columns / units / field names: selected - health response fields and check names are contract fields.
- Auth / permissions / secrets: not selected - no authenticated route or secret handling in #28; deep health auth is M3+.
- Concurrency / shared state / ordering: selected - repeated init and ready-before/after-init state transitions must be stable.
- Resource limits / large input / discovery: selected - directory creation/probing is bounded to the canonical workspace tree.
- Legacy compatibility / examples: selected - existing backend/ws and package typecheck/check scripts must remain green.
- Error handling / rollback / partial outputs: selected - failed init/ready must return stable responses and not leave misleading readiness.
- Release / packaging / dependency compatibility: selected - any backend dependency/script change must remain Bun workspace compatible.
- Documentation / migration notes: selected - PR evidence must state M1 health skeleton scope and deferred OBS-HEALTH-003/004.
Domain packs:
- Scientific governance / PI gate / evidence lineage: not selected - no scientific decision/evidence claim changes.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime repo behavior changes.
- Zero adapter / tool registry / agent role governance: not selected - no Zero adapter/tool governance changes.

Invariant Matrix:
- Governing invariant: Workspace init and readiness must report only the temp/configured workspace root's actual directory/write state and must never create, overwrite, or probe outside that root.
- Source-of-truth identity/contract: `Workspace_Conventions.md` canonical runtime directory list, `Schemas_APIs_CLIs.md` endpoint paths, task-api spec workspace/health requirements, and OBS-HEALTH-001/002 field sets.
- Producers: workspace root resolver/config, init route, and readiness route.
- Validators/preflight: request method/path routing, workspace root absolute-path validation, directory existence checks, and writable probe.
- Storage/cache/query: filesystem directories under the configured workspace root; no database or task snapshot persistence in #28.
- Public routes/entrypoints: `POST /api/workspace/init`, `GET /api/health/live`, `GET /api/health/ready`.
- Frontend/downstream consumers: future Dashboard/Workbench and M1 acceptance use health/status fields, but no UI data wiring in #28.
- Failure paths/rollback/stale state: uninitialized, not-writable, and partial-directory states must produce stable not-ready responses; repeated init must be idempotent.
- Evidence/audit/readiness: focused backend route tests, OpenSpec validation, typecheck/check, diff check, zero diff, and PR evidence.
- Regression rows:
  - Fresh temp workspace root -> `POST /api/workspace/init` creates canonical dirs including `readiness/` and `snapshots/`, returns success, and `GET /api/health/ready` returns 2xx with directory tree, `snapshot_readable=ok`, and `workspace_writable=ok`.
  - Temp workspace already initialized with an existing sentinel file -> second init returns success and does not overwrite or delete the sentinel.
  - Workspace root absent/uninitialized -> `GET /api/health/ready` returns non-2xx/not_ready while `GET /api/health/live` still returns 2xx with OBS-HEALTH-001 fields.
  - Workspace root not writable, or writable probe failure injected where chmod is unreliable -> ready returns not_ready and `workspace_writable=fail`.
  - Unknown or wrong method for these endpoints -> stable API-style 404/405 behavior if route helper exposes it; no framework default HTML leak.

Boundary-surface checklist:
- Public entrypoints: `POST /api/workspace/init`, `GET /api/health/live`, `GET /api/health/ready`.
- Write/overwrite surfaces: `mkdir` for canonical workspace dirs and readiness writable probe.
- Read surfaces: directory existence/readability checks under workspace root.
- Producer/consumer evidence boundaries: `workspace_writable` check object and health response fields.
- Stale-state/idempotency boundaries: repeated init, partial existing directories, and ready before/after init.
- Unchanged downstream consumers: TaskCard API, idempotency/lock service, artifact registry, structured logs, perf smoke, frontend route data wiring.

Required evidence:
- Backend tests for init idempotency, canonical directory creation including `readiness/`, and existing-file preservation.
- Backend tests for live health OBS-HEALTH-001 fields and ready health OBS-HEALTH-002 `workspace_writable` ok/fail states.
- Backend tests prove ready checks include directory tree presence and `snapshot_readable`; #28 checks `snapshots/` directory readability only and does not implement TaskCard snapshot persistence.
- Backend tests for ready-before-init non-2xx/not_ready with live still 2xx.
- Evidence that tests use temp workspaces and do not create tracked `workspace/` assets.
- Existing backend ws tests, typecheck, and package check remain green.
- `bun run test:backend-api` or focused backend route test command; `bun run check`; `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`.

Non-goals:
- TaskCard create/list/detail, task snapshot persistence/restart restore, idempotency key skeleton, artifact registry, path safety helper, structured API logs, perf smoke, deep health auth, disk critical behavior, and ops dashboard.

Review focus:
- Directory creation is bounded and idempotent; no overwrite/delete of existing workspace content.
- Health response fields match OBS-HEALTH-001/002 and path registry.
- Ready failure states are explicit and stable rather than relying on thrown framework errors.
- Scope stays in #28 and does not pre-implement #29/#31/#32/#33.

## Subagent Workflow Fixture - Issue #29

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness

Expanded-trigger rationale:
- Core triggers: public REST API entrypoints, TaskCard schema/field contract, persisted snapshot file output, configured workspace path boundary, API error envelope, and service restart recovery.
- Profile triggers: `workspace`, `snapshot`, `idempotency` boundary split, and API evidence-chain correctness.

Change surface:
- `packages/core/src/domain/services/**` TaskCard service/snapshot persistence.
- `packages/backend/src/routes/**` task routes, shared API error envelope helper, and API 404 fallback.
- Backend route tests and package scripts needed to exercise task-api behavior.

Must preserve:
- #28 workspace init and health endpoints remain unchanged in route path, response shape, and temp-workspace test behavior.
- Runtime workspace assets remain outside tracked source; `test -z "$(git ls-files workspace)"` stays true.
- `zero/` remains source-clean.
- API fallback must not shadow existing registered routes.
- #30 owns `Idempotency-Key`, idempotency/lock service, and Artifact registry; #33 owns shared path helper wiring; #31 owns structured logs; #32 owns perf smoke; #35 owns frontend Dashboard.

Must add/change:
- `POST /api/tasks` accepts the M1 create input body:
  ```json
  {
    "type": "engineering",
    "title": "Add optional event diagnostics",
    "question_or_goal": "Add event_flux output without breaking old rSHUD readers",
    "inference_budget": { "mode": "normal" },
    "created_by": "pi"
  }
  ```
  `created_by` may default to a deterministic M1 actor only when omitted if tests document the default; the stored TaskCard must include `task_id`, `status="created"`, `created_by`, `current_owner`, `reviewer`, empty `linked_jobs`, empty `linked_reports`, and ISO `created_at`/`updated_at`.
- `GET /api/tasks` returns the list/create shape that #35 Dashboard can consume: an array or object wrapper must be stable and documented in tests; #29 tests become the downstream oracle.
- `GET /api/tasks/:id` returns the same stored TaskCard by `task_id`.
- Standard error envelope is used for schema errors, missing task id, malformed snapshots that block recovery, existing non-directory task lanes, and unknown `/api/*` paths.
- Task persistence writes a workspace-local task snapshot at `workspace/tasks/<task_id>/snapshot.json` plus enough data to reconstruct the full TaskCard after service re-instantiation.

Snapshot shape and recovery source of truth:
- #29 snapshot file is the M1 task-lane snapshot carrier at the canonical path `workspace/tasks/<task_id>/snapshot.json`.
- The file must contain canonical TaskSnapshot fields from `Workspace_Snapshot_And_Recovery_Spec.md`: `task_id`, `status`, optional/nullable `runtime_phase`, optional `stack_id`/`data_id`, `linked_jobs`, `linked_runs`, `linked_reports`, `pending_pi_gates`, `latest_seq`, and `updated_at`.
- Because #29 must restore the TaskCard list before the full M3 event bus exists, the M1 snapshot may also include a nested full `task_card` object. If present, recovery validates `task_card` with `TaskCardSchema` and validates that `task_card.task_id`, `status`, linked jobs/reports, and `updated_at` agree with the outer snapshot fields.
- `latest_seq` is `0` in M1 skeleton snapshots because the event bus critical section is out of scope.
- Malformed snapshot JSON, schema-mismatched snapshot fields, task-id mismatches, or an existing regular file where `workspace/tasks/<task_id>/` is needed must fail with a stable envelope and must not silently create a different accepted task. Recovery may skip malformed snapshots only if an explicit test proves the list remains stable and the error is reported through the public endpoint or service result; default preference is fail closed for M1.

Risk packs considered:
- Public API / CLI / script entry: selected - `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, and API fallback are public backend entrypoints.
- Config / project setup: selected - all persistence and recovery depends on the configured workspace root and its default/env resolution inherited from #28.
- File IO / path safety / overwrite: selected - snapshots are written/read under `workspace/tasks/<task_id>/snapshot.json`; task lanes must not overwrite unrelated files or escape the configured root.
- Schema / columns / units / field names: selected - create body, stored TaskCard, TaskSnapshot carrier, and error envelope fields are structured contracts.
- Auth / permissions / secrets: not selected - M1 task endpoints are unauthenticated skeletons and must not handle or log secrets.
- Concurrency / shared state / ordering: selected - create/list/detail state and snapshot writes must remain coherent across sequential and concurrent creates in one process.
- Resource limits / large input / discovery: selected - startup hydration must scan only `workspace/tasks/*/snapshot.json` and use bounded JSON reads.
- Legacy compatibility / examples: selected - the API registry example create body and existing #28/#20 backend/ws tests remain compatible.
- Error handling / rollback / partial outputs: selected - invalid requests and failed persistence/recovery must return canonical envelope and not leave accepted task state behind.
- Release / packaging / dependency compatibility: selected - no new non-M1 runtime dependency; Bun workspace typecheck/check remain green.
- Documentation / migration notes: selected - PR body/evidence must state exact #29 response shape, snapshot shape, and deferred #30/#33/#35 boundaries.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - TaskCard is the PI-visible unit of work; no scientific claims or PI decisions are made in this slice.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: not selected - no Zero/tool governance changes.

Invariant Matrix:
- Governing invariant: Every accepted TaskCard is schema-valid, queryable by id/list, and represented by exactly one workspace-local snapshot; rejected requests, malformed recovery state, and unknown API paths return canonical envelope errors without creating or switching accepted task state.
- Source-of-truth identity/contract: `task_id`, `TaskCardSchema`, create-body schema, API error envelope fields, configured workspace root, and `workspace/tasks/<task_id>/snapshot.json`.
- Producers: `POST /api/tasks`, task service create path, task snapshot writer.
- Validators/preflight: create-body validation, TaskCard schema validation before persistence, TaskSnapshot parse validation during recovery, safe task-id/path-segment validation.
- Storage/cache/query: in-memory task index hydrated from workspace task snapshots; task snapshot JSON files under configured workspace root.
- Public routes/entrypoints: `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, API 404 fallback.
- Frontend/downstream consumers: #35 Dashboard consumes list/create response shapes and refresh recovery; Workbench task-context navigation remains out of scope.
- Failure paths/rollback/stale state: missing required field, invalid enum, unknown task id, unknown API route, malformed/stale snapshot, existing regular-file task lane, duplicate generated id collision, and service re-instantiation after create.
- Evidence/audit/readiness: backend route tests, focused core service tests if needed, `test:backend-api`, backend/ws tests, root `check`, OpenSpec validation, diff check, zero diff, and PR evidence.
- Regression rows:
  - Valid create body above -> 201 stored TaskCard with generated `task_id`, `status="created"`, default/generated owner fields, empty link arrays, timestamps, and no idempotency record.
  - Created task -> `GET /api/tasks/:id` and `GET /api/tasks` return the same TaskCard shape; #28 health/live/ready tests still pass.
  - Created task -> snapshot exists at `workspace/tasks/<task_id>/snapshot.json`, contains required TaskSnapshot fields, and nested `task_card` if used; unrelated files in the task lane survive snapshot rewrite.
  - Fresh app/service over same workspace -> `GET /api/tasks` includes the prior TaskCard from snapshot.
  - Missing required field, invalid enum, or malformed JSON -> 400 envelope containing all canonical fields under `error` plus field-level `evidence_refs`; no task snapshot is written.
  - Unknown `/api/*` path or missing task id -> 404 envelope containing all canonical fields, not a Hono/framework default body.
  - Malformed snapshot JSON, task-id mismatch, or existing regular file where a task directory is needed -> stable envelope or documented fail-closed recovery result; no alternate task id is created and no workspace outside configured root is touched.
  - Concurrent or sequential valid creates in one process -> unique task ids, coherent list/detail responses, and one snapshot per accepted task.
  - Startup hydration with unrelated files/directories under `workspace/tasks/` -> reads only bounded `*/snapshot.json` candidates and ignores/handles unrelated lanes without broad traversal.

Boundary-surface checklist:
- Public entrypoints: `POST /api/tasks`, `GET /api/tasks`, `GET /api/tasks/:id`, API 404 fallback.
- Read surfaces: request JSON body, snapshot JSON files under `workspace/tasks/*/snapshot.json`.
- Write/delete/overwrite surfaces: task lane directory creation and current task snapshot replace/write only; no delete behavior.
- Producer/consumer evidence boundaries: create body -> stored TaskCard -> TaskSnapshot JSON -> hydrated in-memory list/detail -> #35 Dashboard shape.
- Stale-state/idempotency boundaries: service restart hydration and explicit non-goal for `Idempotency-Key`.
- Unchanged downstream consumers: #28 health/workspace routes, backend WS tool.failed tests, future #30 idempotency/locks, #33 path helper, and #35 Dashboard.

Required evidence:
- Backend route tests for create/list/detail, with exact create input and exact generated/default TaskCard fields asserted.
- Backend tests for 400 schema error and 404 fallback/missing task id that assert every canonical envelope field: `error_id`, `category`, `severity`, `message`, `user_message`, `evidence_refs`, `retryable`, `recommended_next_actions`.
- Backend or core tests for snapshot write shape, restart recovery from the same workspace, malformed snapshot handling, existing regular-file task lane, unrelated lane preservation, and bounded hydration scope.
- Backend tests for concurrent or sequential multi-create coherence and unique `task_id` values.
- Compatibility: #28 route tests, backend ws tests, typecheck, root check, OpenSpec validation, diff check, zero diff, and no tracked `workspace`.

Non-goals:
- `Idempotency-Key`, request digest, LockRecord, and Artifact registry (#30).
- Shared path safety helper and wiring (#33); #29 still keeps task snapshot writes workspace-bounded with route-local checks.
- Structured API request logging (#31), PERF-API-001 (#32), frontend Dashboard (#35), Workbench navigation, full event bus/latest_seq critical section, task execution/planning, and scientific PI decisions.

Review focus:
- Create-input schema, generated/default stored fields, TaskCard schema, and TaskSnapshot carrier are internally consistent.
- Error envelope tests assert the full canonical shape and no framework default error body leaks.
- Snapshot persistence/recovery is bounded to configured workspace task lanes and does not silently accept malformed state.
- Existing #28 routes remain reachable and unchanged; fallback ordering does not shadow real routes.

## Subagent Workflow Fixture - Issue #30

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness

Expanded-trigger rationale:
- Core triggers: public REST write endpoint, schema/field contract for IdempotencyRecord/LockRecord/Artifact, persisted workspace files, retry/concurrency/shared-state behavior, digest mismatch rollback, and artifact registry file output.
- Profile triggers: `workspace`, `artifact`, `idempotency`, `lock`, and evidence-chain correctness.

Change surface:
- `packages/core/src/domain/services/**` idempotency, lock, and artifact registry services.
- `packages/backend/src/routes/**` `POST /api/tasks` Idempotency-Key handling and 422 envelope mapping.
- Backend/core tests proving idempotency replay, mismatch, registry lookup, lock storage, and existing #28/#29 compatibility.

Must preserve:
- #29 create/list/detail response shapes, snapshot path `workspace/tasks/<task_id>/snapshot.json`, restart recovery, bounded hydration, and full canonical error envelope.
- Absence of `Idempotency-Key` keeps the #29 create behavior and writes no idempotency record.
- `POST /api/tasks` remains a change-scoped validation carrier only; this issue must not edit canonical frozen docs or claim the endpoint is in the canonical §4 idempotency applicability list.
- Runtime workspace assets remain untracked; `zero/` remains source-clean.
- #33 still owns the shared path safety helper and symlink/traversal matrix; #30 keeps local deterministic workspace-file guards only for the new skeleton surfaces.

Must add/change:
- `POST /api/tasks` accepts optional `Idempotency-Key`. For this M1 slice only, the backend computes `scope="task"` and `request_digest = sha256(canonical JSON)` where canonical JSON uses sorted object keys over the validated create input, including the M1 defaulted `created_by` when omitted and all business fields.
- Same `Idempotency-Key` + same digest replays the first completed TaskCard, returns the same object, and does not create an additional TaskCard snapshot.
- Same `Idempotency-Key` + different digest returns 422 standard envelope with category/evidence that identify `idempotency key mismatch`, and it does not create a new TaskCard or overwrite the existing idempotency result.
- IdempotencyRecord file skeleton persists completed task records at a deterministic workspace-local path such as `workspace/tasks/_idempotency/task/<sha256(key)>.json`; filenames must be derived from a digest or other safe segment, not the raw header.
- LockRecord storage skeleton validates `LockRecordSchema`, persists a record under `workspace/locks/<scope>/<lock_id>.json`, and can read it back by id.
- Artifact registry skeleton validates `ArtifactSchema`, verifies `type` against the existing enum, persists registry metadata under `workspace/artifacts/manifests/<artifact_id>.json`, and can read it back by id. The artifact payload file itself is not created in M1.

Risk packs considered:
- Public API / CLI / script entry: selected - `POST /api/tasks` write semantics change when `Idempotency-Key` is present.
- Config / project setup: selected - all skeleton records are rooted in the configured workspace.
- File IO / path safety / overwrite: selected - idempotency, lock, and artifact registry records are written/read under workspace paths with no raw-header path segments.
- Schema / columns / units / field names: selected - IdempotencyRecord, LockRecord, Artifact, digest, and error envelope fields are structured contracts.
- Auth / permissions / secrets: selected - the idempotency key is a caller-supplied token-like header and must not appear as a raw filename or leak absolute workspace paths in envelopes.
- Concurrency / shared state / ordering: selected - concurrent same-key creates must converge on one completed result, and mismatch must not race into a second task.
- Resource limits / large input / discovery: selected - digesting and record reads must use bounded already-accepted task request bodies and direct lookup paths, not broad directory scans.
- Legacy compatibility / examples: selected - all #28/#29 backend API and WebSocket tests must stay green; canonical docs remain frozen.
- Error handling / rollback / partial outputs: selected - invalid/mismatched/failed creates must not leave accepted task state or a poisoned completed idempotency record.
- Release / packaging / dependency compatibility: selected - no new non-M1 runtime dependency; Bun workspace checks remain green.
- Documentation / migration notes: selected - PR evidence states change-scoped carrier status and the canonical-list bug-fix follow-up remains out of scope.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - Artifact metadata can become future evidence, but #30 must not implement M2 evidence_usable semantics or make scientific claims.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: not selected - no Zero/tool governance changes.

Invariant Matrix:
- Governing invariant: For `POST /api/tasks`, each nonblank Idempotency-Key binds `scope=task` to exactly one canonical request digest and completed TaskCard result; replay returns that same result, mismatch fails with 422, and Artifact/Lock records remain schema-valid workspace-local files retrievable by id.
- Source-of-truth identity/contract: `Idempotency-Key`, `scope=task`, canonical JSON digest, `IdempotencyRecord.result_ref` task id, TaskCard schema, API error envelope, Artifact/LockRecord schemas, configured workspace root, and deterministic record paths.
- Producers: backend `POST /api/tasks`, idempotency service create/replay path, task service create path, artifact registry register path, and lock service store path.
- Validators/preflight: request-body schema validation before digest acceptance, nonblank header validation, canonical JSON stable key sorting, digest comparison, schema validation before record writes, and safe filename derivation from digests/ids.
- Storage/cache/query: workspace task snapshots plus idempotency records under task-scoped registry paths, lock records under `workspace/locks/`, and artifact metadata under `workspace/artifacts/manifests/`.
- Public routes/entrypoints: `POST /api/tasks` only; artifact and lock services are core service skeletons with no public REST route in #30.
- Frontend/downstream consumers: #35 Dashboard keeps using the #29 create/list shape; future retry/UI logic can rely on same-key replay and 422 mismatch.
- Failure paths/rollback/stale state: missing/blank idempotency key, invalid request body, key digest mismatch, task persistence failure after key reservation, duplicate/concurrent same-key create, invalid artifact/lock schema, unsafe id/key path segment, and service re-instantiation over the same workspace.
- Evidence/audit/readiness: core service tests, backend route tests, `test:backend-api`, backend/ws compatibility, schema tests/check, root check, OpenSpec validation, diff check, zero diff, and no tracked `workspace`.
- Regression rows:
  - Same key + same body, including reordered JSON keys -> first request returns 201 TaskCard, replay returns the same TaskCard, `GET /api/tasks` lists one task, and one completed IdempotencyRecord points at that task.
  - Same key + request with omitted `created_by` followed by explicit `created_by="pi"` -> replay returns the first TaskCard because the digest includes the defaulted actor value; same key + different `created_by` -> 422 and no new task.
  - Same key + changed business field -> 422 envelope with all canonical fields and idempotency evidence refs; no second task snapshot or completed result is created.
  - Absent key -> existing #29 create/list/detail/snapshot behavior, with no idempotency record.
  - Concurrent same-key same-body requests -> exactly one TaskCard/result_ref wins and every successful replay returns that same object; no duplicate task snapshots.
  - Task persistence failure after an idempotency attempt -> no completed result is recorded; after workspace repair the same key/body can create one task.
  - Valid Artifact record -> `registerArtifact` returns schema-valid metadata, `getArtifact(id)` returns the same record, and metadata exists under `workspace/artifacts/manifests/`; invalid type/id/path is rejected without a registry file.
  - Valid LockRecord -> store/read returns the same schema-valid record under `workspace/locks/<scope>/`; invalid lock schema is rejected without a lock file.
  - Existing #28/#29 health, workspace init, task recovery, unknown-route, WebSocket, and schema tests remain green.

Boundary-surface checklist:
- Public entrypoints: `POST /api/tasks`; no artifact/lock REST endpoint in #30.
- Read surfaces: request JSON body, `Idempotency-Key` header, direct idempotency/lock/artifact record files.
- Write/delete/overwrite surfaces: idempotency record create/complete update for the current key, lock record store, artifact metadata store, and existing task snapshot create; no delete behavior.
- Producer/consumer evidence boundaries: request body -> canonical digest -> IdempotencyRecord -> TaskCard snapshot/result_ref -> replayed response; Artifact metadata -> future evidence registry consumers.
- Stale-state/idempotency boundaries: process-local concurrency plus file-level record replay after service re-instantiation; full cross-process distributed locking is out of scope.
- Unchanged downstream consumers: #28 workspace/health routes, #29 task list/detail/snapshot recovery, backend WS tool.failed tests, future #31 logs, #33 path helper, and #35 Dashboard.

Required evidence:
- Backend route tests for same key/same digest replay, key-order-independent digesting, same key/different digest 422 envelope, absent-key compatibility, concurrent same-key create, and failed-create retry without poisoned completed record.
- Core service tests for IdempotencyRecord read/write/replay lookup, LockRecord store/read schema validation, Artifact registry register/get schema validation, safe deterministic record filenames, invalid record rejection, and direct lookup without broad workspace scans.
- Compatibility and gate commands: `bun run test:backend-api`; `bun run test:backend-ws`; `bun run test:schemas`; `bun run typecheck`; `bun run check`; `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`; `test -z "$(git ls-files workspace)"`.

Non-goals:
- Expanding the canonical idempotency applicability list in frozen specs; the proposal Impact follow-up remains a separate bug-fix ledger item.
- Full Artifact manifest semantics, `evidence_usable` upgrade rules, artifact payload serving/download APIs, report evidence lineage, cross-process lock leases/heartbeats, PI gate decisions, structured request logs (#31), path safety helper wiring and symlink/traversal matrix (#33), frontend retry UI (#35), and scientific conclusions.

Review focus:
- Digest canonicalization is deterministic, includes all validated business fields, and cannot be bypassed by JSON key order or omitted default `created_by`.
- Idempotency mismatch and failed create paths do not create duplicate TaskCards or poisoned completed records.
- Workspace record paths use safe derived segments and API error JSON never exposes raw caller headers or absolute workspace paths.
- Artifact/Lock services stay skeleton-sized but schema-valid, workspace-local, directly queryable, and compatible with later #33 path helper wiring.

## Subagent Workflow Fixture - Issue #33

Fixture level: expanded; repair intensity: high
Project profile: SHUD-Harness

Expanded-trigger rationale:
- Core triggers: shared path helper, persisted workspace writes, normalized path field storage, symlink/traversal rejection, and fail-closed no-write behavior.
- Profile triggers: `workspace`, `artifact`, `snapshot`, path/workspace containment, and evidence-chain correctness.

Change surface:
- `packages/core/src/domain/services/workspace-path-safety.ts` shared path resolution helper.
- Artifact registry manifest write path in `packages/core/src/domain/services/artifact-registry-service.ts`.
- Task snapshot write path in `packages/core/src/domain/services/task-card-service.ts`.
- Workspace JSON record write preparation in `packages/core/src/domain/services/workspace-record-store.ts`.

Must preserve:
- #29 TaskCard create/list/detail response shape, snapshot filename, restart recovery, bounded hydration, and existing workspace error envelopes.
- #30 IdempotencyRecord, LockRecord, and Artifact schema validation, direct lookup behavior, immutable manifest semantics, and no raw caller segment leaks.
- Runtime `workspace/` assets remain untracked; `zero/` remains source-clean.
- No bash/sandbox behavior and no workspace allowlist expansion beyond explicit read-only root support in the helper.

Must add/change:
- A shared helper resolves input paths, normalizes them, checks workspace or allowed read-only boundaries, rejects symlink crossings and non-directory ancestors, and returns the normalized path.
- Artifact registry normalizes `artifact.path` before manifest storage and rejects unsafe paths before writing manifests.
- Task snapshot write surfaces resolve the task root, task lane, snapshot path, and temporary path through the helper before writing.
- Workspace JSON record writes use the shared helper at the point of write preparation.

Risk packs considered:
- Public API / CLI / script entry: not selected - no route or CLI contract changes.
- Config / project setup: selected - all behavior is rooted in the configured workspace root and optional allowed read-only roots.
- File IO / path safety / overwrite: selected - this issue owns traversal, symlink, boundary, and no-write regression coverage for workspace write surfaces.
- Schema / columns / units / field names: selected - Artifact manifest `path` is normalized before storage.
- Auth / permissions / secrets: not selected - no credential or permission model changes.
- Concurrency / shared state / ordering: selected - helper checks are applied immediately before write preparation and preserve existing atomic/no-clobber paths.
- Resource limits / large input / discovery: selected - helper walks only path ancestors and stops at the first missing segment; no broad workspace scan is introduced.
- Legacy compatibility / examples: selected - existing #29/#30/#31/#32 tests and response/storage behavior remain compatible.
- Error handling / rollback / partial outputs: selected - rejected paths fail closed and must not create workspace-external files or partial manifests/snapshots.
- Release / packaging / dependency compatibility: not selected - no new dependency.
- Documentation / migration notes: selected - PR evidence states helper boundaries and out-of-scope bash/sandbox behavior.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - Artifact paths are future evidence references and must not be silently rewritten outside the workspace.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/runtime behavior changes.
- Zero adapter / tool registry / agent role governance: not selected - no Zero/tool governance changes.

Invariant Matrix:
- Governing invariant: Every M1 workspace write surface introduced by #29/#30 records only normalized paths inside the configured workspace, or rejects before write when a path traverses outside, crosses a symlink, targets a read-only boundary for write, or encounters a non-directory ancestor.
- Source-of-truth identity/contract: configured `workspaceRoot`, optional `allowedReadonlyRoots`, normalized workspace-relative path, `Artifact.path`, task snapshot paths, and `workspace_path_not_safe` evidence refs.
- Producers: Artifact registry `registerArtifact`, TaskCard snapshot persistence, Workspace JSON record write preparation, and the shared helper.
- Validators/preflight: segment/id validators from #29/#30 plus shared `resolveWorkspacePath` boundary and symlink checks.
- Storage/cache/query: task snapshots under `workspace/tasks/<task_id>/snapshot.json`, temporary snapshot files, and Artifact manifests under `workspace/artifacts/manifests/`.
- Public routes/entrypoints: none directly - #29/#30 backend routes consume these services indirectly.
- Frontend/downstream consumers: #35 Dashboard and future artifact/evidence consumers read normalized stored paths without API shape changes.
- Failure paths/rollback/stale state: traversal, absolute path outside workspace, symlinked ancestor/leaf, write under allowed read-only root, missing parent segments, existing regular-file lanes, and existing rollback/cleanup paths.
- Evidence/audit/readiness: core service tests, root check, OpenSpec validation, diff check, zero diff, and no tracked `workspace`.
- Regression rows:
  - Legal relative Artifact path with `./` -> stored manifest path is normalized workspace-relative and `getArtifact(id)` returns the normalized record.
  - `../` traversal or absolute outside workspace -> helper throws `WorkspacePathSafetyError`/mapped `workspace_path_not_safe` before any outside file exists.
  - Workspace symlink ancestor pointing outside -> Artifact registry and TaskCard snapshot writes reject before writing a manifest or snapshot outside.
  - Allowed read-only root with `access=read` -> helper returns boundary `allowed_readonly`; same root with `access=write` -> rejection.
  - Existing #29/#30 service tests -> snapshot recovery, idempotency, lock, artifact lookup, and immutable duplicate behavior remain green.

Boundary-surface checklist:
- Shared helper roots: `resolveWorkspacePath`, `assertPathInsideWorkspace`, and existing local workspace guards.
- Read surfaces: helper read-only resolution for allowed read-only roots; existing snapshot/record reads are compatibility surfaces.
- Write/delete/overwrite surfaces: Artifact manifest writes, Task snapshot writes, temporary snapshot publish, and JSON record writes.
- Staging/publish/rollback surfaces: snapshot temp-file write/rename/unlink and existing record no-clobber writes.
- Producer/consumer evidence boundaries: Artifact input path -> normalized manifest path; TaskCard id -> normalized snapshot lane.
- Stale-state/idempotency boundaries: existing #30 idempotency/lock behavior; no new cross-process locking.
- Unchanged downstream consumers: backend task routes, idempotency/lock services, structured logging, perf smoke, and future Dashboard.

Required evidence:
- Core service tests for traversal rejection, symlink escape rejection, legal path normalization, allowed read-only read/write split, normalized Artifact manifest storage, Artifact symlink no-write, and Task snapshot normalized/no-write cases.
- Gate commands: `bun run test:core-services`; `bun run typecheck`; `bun run check`; `openspec validate m1-foundation --strict --no-interactive`; `git diff --check`; `git -C zero diff --quiet`; `test -z "$(git ls-files workspace)"`.

Non-goals:
- Bash/sandbox execution path controls, M3 executor behavior, raw-data write denial telemetry, artifact payload serving/download APIs, and expanding workspace external allowlists.

Review focus:
- Helper boundary checks are centralized and fail closed before writes.
- Artifact and Task snapshot write surfaces actually call the helper and persist normalized paths where applicable.
- Tests prove no outside file/manifest/snapshot is created on traversal or symlink escape.
