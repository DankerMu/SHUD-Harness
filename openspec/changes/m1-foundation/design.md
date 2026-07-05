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
13. **bash 写禁区 authority = 执行层 OS 沙箱（2026-07-04 revisit 裁决）**：首轮 spike 条 2 证明 pre-exec 静态命令串扫描不能同时满足"任意 bash 写入拒绝 / 合法 raw 读兼容 / 不实现 full shell parser"——六类逃逸 + 读误拒，证据见 [verdict](policy-gate-spike-verdict.md)；"写哪些文件"是程序语义属性，对图灵完备的 shell 只在 syscall 时刻可观测。冻结 spec 本就如此分工（[Preflight_And_Mutation_Boundary_Spec](../../../docs/03_SPEC/Preflight_And_Mutation_Boundary_Spec.md)"preflight 是 submit 前的门，不是运行期防线"A03-5；[Sandbox_and_Executor §1](../../../docs/03_SPEC/Sandbox_and_Executor.md)）。落点：bash 工具 spawn 命令时施加 seatbelt profile（macOS `sandbox-exec`：`(deny file-write* (subpath data/raw))`，子进程继承；包装在 SHUD 侧工具实现内，zero diff 仍 = 0）；pre-exec 静态检查降级 advisory 提示层（fail-open）。实测（2026-07-04 本机 14 用例 probe）：六类 blocker 全 DENY、raw 读与 workspace 写 ALLOW、新建 hardlink DENY；唯一原理性残留 = 预存 hardlink 别名，兜底 = nlink>1 扫描 + DataProvenance 校验和。否决备选：继续堆静态规则（verdict 明拒——失败类无穷）；ro-mount 独立只读卷（连 PI 一起锁死 + ingest remount 摩擦）；换基座（自建注册层 / Claude Agent SDK 撞同一堵墙，Claude Code 自身在 macOS 亦以 seatbelt 实现 bash 沙箱）。迁移出口：若离开 macOS 单机形态，等价物 = Linux landlock/bwrap（authority 语义不变）。**2026-07-05 补充（PR #48 gate 收窄）**：条 2' 保证分两层——(a) **byte authority**：seatbelt 在 syscall 层守 raw 字节，穿 symlink/超预算/继承 profile 的子孙进程全覆盖（六类逃逸字节均不落盘）；(b) **denial telemetry**：M1 wrapper 只把可信 raw-denial 证据源升格为 raw 写拒绝，当前可信源为 advisory/static 同根 raw 写捕获；post-exec stdout/stderr/退出码可被被测命令伪造，仅记录普通 lifecycle `failed`，不得单凭进程结果声明 `raw_data_write_denied` 或 `denied_by_sandbox`。`denied_by_sandbox` 预留给后续不可伪造 OS 事件源。隐藏拒绝完整遥测与双 fork/setsid 后代任意进程树所有权移出 #19，归后续 executor/audit 后端；audit 行只记可观测事实，不声称检出每次被拒尝试。合法 waited 前台子进程（`subprocess.Popen`+wait 写 workspace）MUST 保持放行——process-creation preflight 不得过宽误杀。post-gate findings 均**未击穿 raw 字节完整性**，按 acceptance-boundary 修正处置。

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
- Trusted raw-denial evidence returns the remediation-shaped tool error family, produces `tool.failed`, and writes audit denial evidence; post-exec process output alone remains generic lifecycle evidence.
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
- Producer/consumer evidence boundaries: trusted advisory/static raw-denial -> ErrorRecord-shaped payload -> WS `tool.failed` -> audit row with same rule/profile identity; sandboxed command lifecycle -> audit row with profile identity and generic `allowed|failed`.
- Unchanged downstream consumers: generic policy-gate pure evaluator, Zero tool registry wrapper, and future full WS/AuditEvent implementation.

Non-goals:
- Full shell parser, Linux landlock/bwrap backend, full WebSocket protocol/session bus, full AuditEvent schema, and ingest/readiness hardlink scan wiring.
- Raw data read prohibition.

Review focus:
- Sandbox denial is the authority and runs at execution time, not a static string scan.
- Child process inheritance, path alias behavior, and raw-read compatibility are covered by tests.
- Denial evidence is synchronized across tool result, WS skeleton event, and audit row only for trusted raw-denial sources; process-result-only failures stay synchronized as generic lifecycle facts.
- Hardlink residual is demonstrated honestly and the reusable nlink helper detects it.
