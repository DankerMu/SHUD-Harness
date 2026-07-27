# M2 Research Context — Design

## Decisions

### D1. 鉴权形态：localhost 绑定 + 单一本地 token（grill 定案）

- server 仅监听 `127.0.0.1`；启动时从 `HARNESS_LOCAL_TOKEN` 环境变量读取 token，缺失时生成并写入 `workspace/secrets/local-token`（文件 0600、目录 0700）。
- `workspace/secrets/` 为**本次新建目录**（勘误：早稿「目录已在 secrets 白名单」表述不实——M1 `WORKSPACE_CANONICAL_DIRECTORIES` 与 Workspace_Conventions §1.2 树均无该目录，「不入 git」此前仅靠 `/workspace/` 整体 ignore）：本 change 将其加入 `WORKSPACE_CANONICAL_DIRECTORIES` 并联动 ready 检查；该子树 MUST NOT 被任何目录列举/读取端点服务（含 `GET /api/artifacts/:artifactId/data` 与 `POST /api/data/register`，各 spec 有 secrets denylist requirement）；token 值受 redaction 覆盖。
- `HARNESS_LOCAL_TOKEN` 为**新登记环境变量**：Config_Secrets §4 推荐环境变量表现无此项，按批次 4（`GLM_API_KEY`）先例补一行并并入例外批次 6 账（任务 0.1）。
- 中间件对全部 `/api/**` 校验 `Authorization: Bearer <token>`；豁免 `GET /api/health/live` 与 `GET /api/health/ready`（本地监控探针，无副作用只读）。非 `/api` 面（前端入口页/静态资源）不做 Bearer 校验——token 即经该面 bootstrap 分发，见下条。
- **前端 token 获取/携带**：后端 serve 前端入口页时把 token 注入页面 bootstrap 配置（inline `window.__HARNESS_BOOTSTRAP__`；仅回环监听 + 同源可读，不设 CORS 头，跨源页面无法读取注入值）；前端统一 fetch wrapper（api 层唯一出口）为全部 `/api/**` 请求附加 `Authorization: Bearer <token>`。token MUST NOT 出现在 URL/query，不写 localStorage（页内存态，刷新随入口页重新注入）。M1 既有 `window.fetch` 直连调用点（Dashboard 建卡/列表）随任务 1.2 迁移到该 wrapper 并做浏览器 UI 回归——否则 8.1 验收门（SideNav 浏览器走查）与 W2 UI/E2E 三条在 token 体制下不可达。
- 失败返回 canonical error envelope（401，`category=permission_error`）。勘误：早稿写 `category=auth`，但 Error_Handling_Spec §1（frozen）分类枚举与 M1 `ErrorCategorySchema` 均无 `auth` 类别；复用既有 `permission_error`（权限类拒绝的既有类别；API_Error_And_Idempotency_Contracts §2 只约束 status 映射 `auth missing → 401`，不定义类别），不扩 frozen 枚举，与 proposal「不改 error envelope」一致。响应不回显 token。
- 备选：仅 localhost 无 token（拒绝：浏览器任意页面可打本地 API，CSRF 面；M3 WebSocket 建连校验无凭据可用）；本地密码 + session（拒绝：超出 ADR-0002 D6 收缩口径）；新增 `auth_error` 枚举值（拒绝：需动 frozen 错误分类与 M1 schema，401 语义 `permission_error` 已可承载）。
- 排序决策：auth 在 backend 面第一个落地（schemas 之后），此后全部新路由与测试在最终鉴权体制下编写，避免后补 token 时全量测试翻改。迁移面 = M1 全部路由测试 + `bun run check` 之外直打 `/api` 的 harness（`scripts/perf/api.ts`，PERF-API-001）+ 前端 fetch 面（任务 1.2）。

### D2. renv.lock 归 StackLock 采集（grill 定案）

`POST /api/stacks/lock` 时读取仓库根 `renv.lock`：存在 → `runtime.r_packages_lock = { path, sha256 }`；缺失 → `null` 并在响应 `degraded[]` 数组中列出 `renv_lock_missing`（显式降级语义，不静默）。data/register 不涉 renv。

### D3. sha256 语义：文件与目录双形态

- 文件：内容字节流式 sha256（不整读内存，SHUD 输出可能大）。
- 目录（canonical 示例中 `forcing/` 是目录源）：对目录内全部常规文件按 **相对路径字典序** 生成 `"<relpath>\n<file-sha256>\n"` 行序列，对该序列再做 sha256。为保持该冻结行协议无歧义，任一相对路径 segment 含 LF（`\n`）时 MUST 在读取对应文件内容前以 path-safety 错误拒绝；普通名称的行协议与 oracle 不变。符号链接与非常规文件直接拒绝（raw 数据保护 + M1 no-follow 纪律）。
- 空目录拒绝（422）：无内容可溯源。

### D4. 持久化复用 M1 硬化后的 workspace record store（关键的 review 经济决策）

StackLock 与 DataProvenance 记录以 JSON 形式经 **既有 `writeJsonRecord` 发布权威** 落盘（`workspace/stacks/`、`workspace/provenance/`），复用 #74 已硬化的唯一 rename 提交、observation binding 与 path safety。**不新建任何写路径**——M1 的 #19/#74 审查爆炸都源于新建高风险面；M2 的存储层零新面。读取走既有 bounded no-follow reader。

**provenance 目录裁决（对两个互相矛盾 canonical 的显式偏离）**：Workspace_Conventions §5（canonical_for workspace-paths）写 `data/DATA-001/provenance.yaml`，Repository_Layout §2 写 `data_provenance/DATA-*.yaml`——两个 canonical 本身互相矛盾，且都不是平面 JSON record 目录形态。M2 采用 `workspace/provenance/DATA-<uuid>.json`：与 `workspace/stacks/`、M1 `workspace/tasks/` 同构，record store 权威直接复用（per-DATA 嵌套目录 + YAML 需新建写路径，违背本决策首段）。偏离在 data-provenance spec 显式记录；两 canonical 的统一走 bug 级修正通道（canonical 内部矛盾，符合冻结规则），任务 0.1 落账。

**群组 ArtifactManifest 目录裁决**：`workspace/artifacts/manifests/` 已被 M1 交付占用——`artifact-registry-service.ts` 把**单 artifact 元数据记录**以 `<artifactId>.json` 存于该目录，并对该目录任意 id 按 `ArtifactSchema` 解析（失败走 `record_malformed` 500），两类记录同目录必然冲突。裁决：群组 ArtifactManifest 落独立目录 `workspace/artifacts/manifest-sets/`（加入 `WORKSPACE_CANONICAL_DIRECTORIES`）——零迁移、不触碰 M1 硬化面、命名空间隔离。备选「M1 单 artifact 记录目录改名 registry/、manifests/ 归群组语义」被拒：需迁移既有 workspace 数据，破坏 M1 已验收面。canonical §4 `manifests/` 语义与 M1 占用的错位随任务 0.1 一并落账。

**目录树扩展账**：本 change 新增目录 = `provenance/`、`secrets/`、`artifacts/manifest-sets/`；`stacks/` 已在 M1 `WORKSPACE_CANONICAL_DIRECTORIES` 存在（proposal 早稿把 stacks/ 记为本次扩展系账目不实，已修正）。

### D5. ID 规范：`STACK-<uuid>` / `DATA-<uuid>` / `MANIFEST-<uuid>`，沿用 M1 已验收的 TaskCard 先例

Minimal_Schemas 示例写 `STACK-NNNN`（ArtifactManifest 示例 `MANIFEST-001` 同理）；M1 实际交付并通过验收的是 `TASK-<uuid>`（见 m1-acceptance-record 走查记录）。单调 NNNN 计数器需要一个可变的计数权威——这正是 #74 花 47 轮审查才收口的那类并发/持久化面。裁决：M2 采用 `STACK-<uuid>`/`DATA-<uuid>`/`MANIFEST-<uuid>`（无碰撞、无计数器、无新并发面），canonical 示例中的 NNNN 视为示意格式；本偏离在 spec 中显式记录，与 M1 先例一致。

### D5a. StackLock schema 两处内容偏离（与 D5 同款显式记录）

- `repos` 含第四键 `zero`：Minimal_Schemas §2（frozen）示例仅 SHUD/rSHUD/AutoSHUD 三键，但 zero 是 ADR-0001 钉死的 agent runtime 基座（submodule pin 13e25c1），复现链必须含 runtime pin；Test_Plan W2-SUB-001 已明列「SHUD/rSHUD/AutoSHUD/zero 均可读取」——canonical 内部自相矛盾。M2 按四键实现；Minimal_Schemas §2 补 zero 行走 bug 级修正通道（任务 0.1）。
- `runtime.r_packages_lock` 为 `{ path, sha256 } | null`：canonical 写字符串 `renv.lock`（文件名指针，Config_Secrets §6 同），指针防不了内容漂移——grill 定案 2 的目的正是内容哈希锁定；对象化 = path + 内容 sha256，缺文件显式 `null` + degraded。字段形态补正同走任务 0.1。

### D6. evidence_usable 规则引擎与 audit（grill 定案）

- registry 服务在 register/update 时执行 Artifact_Registry_Spec §4 的七条确定性校验；不满足 → `evidence_usable` 强制 false（不报错，降级记录）。
- **`llm_generated` 为 Artifact 持久化扩展字段**（boolean，可选，缺省 false）：canonical 机制（Artifact_Registry_Spec §4）以「created_by 与操作者身份」识别 LLM 产物，但 M2 无 agent 身份体系，该机制无输入可用；M2 以显式持久化标记承载。这是对 Support_Schema_Contracts §1 Artifact 接口的 additive 偏离（落账任务 0.1）——M1 `ArtifactSchema` 为 strict 集合，未声明键会被直接拒，必须做 schema delta（任务 2.1），不能只作瞬态注册参数。register 时随记录落盘；update 与升级路径 MUST 读取**落盘值**而非请求值（否则 register 后无从得知产物是否 LLM 生成，红线可被后续请求洗白）。M3+ agent 身份落地后与 `created_by` 校验机制合流。
- 落盘 `llm_generated: true` → `evidence_usable` 默认 false 且注册时不可直接置 true；升级为 true 是 **core 服务操作**（M2 不开 HTTP 端点——API 注册表无此端点，审批 UI 属 M7），D6 单账号下 actor 恒为本地用户。
- **audit 通道形态**（勘误：早稿「复用 #31 日志通道」不成立——#31 交付的是 HTTP 请求级中间件，event 为字面量 `api.request.completed`、仅在请求生命周期触发，而升级操作是 core 服务操作、无请求可挂钩，packages/core 亦无日志 sink 基础设施）：registry 服务 options bag 注入 `auditSink`（与既有 `ApiRequestLogSink` 同型 `(line: string) => void | Promise<void>`）；成功升级写一行 NDJSON：`{ ts, level: "info", service, event: "audit.evidence_upgrade", actor, target_id, result }`；默认 sink 沿 #31 约定（console 行输出、best-effort、失败不影响操作结果）。sink 与行 schema 定义属任务 6.1 交付物。
- `created_by=agent` 一律 403 的校验 **显式推迟** 到 agent 身份进入系统的里程碑（M3+）：M2 无 agent 身份，无消费方；spec 中留 deferred requirement 记录，防止治理红线被遗忘。

### D7. 读取端点：注册表例外批次 6（PI 已批）

SideNav 刷新后重建版本链快照需要 REST 读取；注册表原只登记两个 POST，属注册表漏登记（其 UI 契约自身要求 REST snapshot）。经 grill 拍板走账本例外：`GET /api/stacks/:stackId`、`GET /api/data/:dataId` 已补入 Schemas_APIs_CLIs §1，账见 Phased_Spec_Activation 例外批次 6。artifact metadata 读取沿用 M1 core 服务先例，M2 不开 metadata HTTP 端点（`GET /api/artifacts/:artifactId/data` 是注册表既有 canonical 数据端点，属本 change 交付）。

**ArtifactRef 数据来源随之定案**：M2 契约 = 纯展示组件，props（artifact_id/type/path/evidence_usable）由调用方传入；M2 交付面无任何返回 artifact 元数据的读取端点，组件经组件测试行使 W2 UI 细目（「可点击/复制路径」）。真实调用场景 = RunRecord/报告视图接线，属该视图所在里程碑（M3+）；届时如需 metadata HTTP 端点，按批次 6 同款流程补登记（Artifact_Registry_Spec §7 的 `GET /api/artifacts/:artifactId` 属 Phase 3 激活面）。

### D7a. StackLock repo 采集：gitlink 代际 authority + 实际 checkout 状态

采集先把调用方 `repositoryRoot` 物理规范化，并以 no-follow directory observation 捕获稳定目录对象 `(dev, ino)`，再以同一最小非敏感 Git seam 执行 `git --no-lazy-fetch rev-parse --show-toplevel`；Git 报告的物理 top-level 必须与请求根完全相等，且 pathname 与目录对象身份在 root admission、每个 snapshot/producer 前后和 publication 前持续重验。任一不等或同 pathname 下的目录对象替换均以稳定 typed error fail closed，不返回 partial result。

superproject `HEAD` 的四个 gitlink 与同一 generation 的 `HEAD:.gitmodules` 只负责确认 SHUD/rSHUD/AutoSHUD/zero 四个声明路径及代际完整性；它们不是 StackLock `repos.*.commit/branch` 的输出值。每个声明路径先以 no-follow observation 拒绝 symlink，再打开并持有目录 descriptor/cwd capability，物理身份以 `(path, dev, ino)` 绑定；capability 创建后立即登记到 collection-scope owner，每个 checkout Git producer 在该已绑定 cwd 中先核对 descriptor identity，匹配后才运行，且证明 `git --no-lazy-fetch rev-parse --show-toplevel --show-prefix` 的 top-level 精确等于该 checkout、prefix 为空。StackLock 对每个实际 checkout 读取 `rev-parse HEAD`、`rev-parse --abbrev-ref HEAD`（`HEAD` 映射为 `branch="detached", detached=true`；合法 attached 分支 `detached` 映射为同 branch 且 `detached=false`）与 dirty boolean。dirty observer 先读取 main/linked/nested checkout 的 local、worktree-scope 及 include 后有效配置，发现任何 `filter.*.clean`/`.process` 即 typed fail；index discovery 严格按 NUL record/header/path 解析 stage 0–3，stage 1/2/3 gitlink conflict 或未知/畸形 gitlink fail closed，stage-0 path 原样去重后递归。真正 status 在不含 repository-controlled helper 配置的隔离 Git context 中以 `core.fsmonitor=false`、`--untracked-files=all`、`--ignore-submodules=all` 只观察本层，再组合递归 nested dirty，因此 audit 后注入 helper 也永不执行，同时保留 tracked/untracked/staged/nested dirty 与 repo-local `submodule.*.ignore=all` 覆盖语义。实际 checkout HEAD 可以合法偏离 gitlink；必须忠实记录，不能拒绝、回退或伪装成 gitlink。四 checkout 串行采集；任何失败都在 return 前等待并关闭 owner 已登记资源，不遗留 sibling producer。存在主错误时 cleanup/close 错误不得覆盖主错误；仅无主错误时 close failure 映射为 typed contract failure。

两次 cheap snapshot 同时比较 root authority、四 gitlink、`.gitmodules` object/declarations、四 checkout 物理身份及实际 `commit/branch/detached/dirty`；第二次 renv producer、schema validation 与 immutable result freeze 完成后，以第二 snapshot 持有的四个 directory capability 按固定顺序串行执行 first-sweep，再执行 second-sweep。成功只证明两个完整 publication map 彼此相等并等于待发布 snapshot，随后统一复核 repository root 与四个 canonical checkout pathname identity。first-sweep 中早序 repo 在下一 sibling 开始前后的漂移由 second-sweep 兜底；但任一 repo 在 second-sweep 对它完成最后一次逻辑读取之后发生的 commit/branch/dirty mutation、最后 pathname identity 观察之后的 mutation，以及 observations 之间完整发生并恢复的 ABA 均可能不可观测。因此这里不声称强原子 snapshot、return-time contemporaneity 或“任一 sweep next-sibling mutation 必然失败”；安全目标是 descriptor/cwd identity gate 使 replacement target 不能重定向 Git 读取或被发布。默认 runner 在进入任何 repo cwd 前从仅含非空绝对 component 的 PATH 解析一次绝对 Git executable；root 与 checkout 命令均执行该绝对 binary，descriptor wrapper 通过专用 stderr marker 把 cwd identity mismatch 与 Git 自身相同 exit code 区分。所有生产 Git argv 都把全局 `--no-lazy-fetch` 放在 subcommand 前，Git <2.45 不支持该选项时须在首条 top-level 命令 fail closed，不降级执行。不执行 checkout/fetch/reset，不修改任何 superproject 或 checkout Git 状态。runtime 版本（r/python/sundials/gcc/gdal）M2 填占位探测值或 `unknown`。llm 块从 provider 配置读取 provider/model_id/base_url。现有 `renv.lock` 在打开后的 regular descriptor 上执行 inclusive 16 MiB 上限，超限 fail closed。

**harness 块与两个 digest 的 M2 采集口径**（勘误：早稿「params_digest/prompt_pack_digest 以配置内容哈希生成」与 canonical 字段语义冲突——Minimal_Schemas §2 定义 params_digest = 采样参数集哈希、prompt_pack_digest = prompt pack 实际内容哈希，而 M1 provider 配置的 exact keys 既不含采样参数也不含 prompt pack，照早稿两 digest 会退化为同一份配置文件哈希）：

- `harness.version` = 仓库根 `package.json` 版本；`cli_version` = 占位常量 `"unknown"`（领域 CLI 属后续里程碑，语义见 Domain_CLI_Spec §5）；`prompt_pack` = 占位 id `"promptpack-unset"`；`skills_version` = 占位 id `"skills-unset"`。与 runtime 同型的显式占位允许，升级里程碑在 spec 注明。
- `llm.params_digest` = 当前生效采样参数集的 canonical JSON sha256；M2 无参数存储 → 对空参数集 `{}` 哈希（确定性、可断言，显式记录）。
- `llm.prompt_pack_digest` = prompt pack 实际内容 sha256；M2 无 prompt pack 对象 → 对空字节串哈希占位。两 digest 语义源不同，值必然不同，各自随其机制落地的里程碑升级。
- Config_Secrets §6 的 harness 示例字段（version/config_profile/secrets_policy_version）与 Minimal_Schemas §2（version/cli_version/prompt_pack/skills_version）不一致：**以 Minimal_Schemas §2 为准**（canonical_for core-object-schemas），差异随任务 0.1 落账。

### D8. 细粒度交付策略（本里程碑的过程性决策）

M1 教训：#19 单 issue 扛整个 seatbelt 面（25 轮/205 项拦截）、#74 单链路扛全部幂等+发布权威不变量（47 轮）。M2 规则：

1. 高风险面（文件系统 hashing、数据服务端点、auth 中间件）各自独立成 issue，单 PR 爆炸半径 ≤ 一个服务/路由对。
2. schema、service、route 分层拆 issue，每个 issue 1–3 个紧耦合 task。
3. 复用 M1 硬化 seam（record store、path safety、error envelope、NDJSON 日志），新面数量最小化。
4. 预计 16–18 个子 issue（含 canonical 落账与前端 token bootstrap）；不为压数量合并模块边界。

## Seams under test

| Seam | 选择理由 |
|---|---|
| `createBackendApi`（HTTP 边界，既有） | 最高可用 seam；一次行使 route+service+store 全链路，M1 全部集成测试已锚定于此，零新 seam 成本 |
| core 服务公共函数（`hashFile`/`hashDirectory`、evidence 规则引擎、stack 采集器） | 纯函数/确定性服务的单元粒度，沿用 M1 core-services 测试文件模式 |
| 前端组件测试（既有 dashboard/workbench 测试模式） | UI 三条 W2 细目的最低成本行使点 |

不新增测试专用 seam；LLM/git 等外部依赖经服务的既有注入点（options bag）替身。

## Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| auth 中间件触碰全部既有路由测试（一次性大改） | 独立 issue 且排序最前；测试 helper 统一注入 token，后续 issue 全部在终态体制下编写；迁移清单显式含 `scripts/perf/api.ts`（PERF-API-001，`bun run check` 之外）与前端 fetch 面（任务 1.2） |
| `GET /api/artifacts/:id/data` 路径穿越/泄密 | 仅按已登记 artifact record 的 path 服务；path-safety helper + no-follow；无目录列举；range/分页留 skeleton 注记 |
| 目录 hashing 性能（未来大 forcing 目录） | 流式 hash + 排序行协议；M2 fixture 级数据量；复杂度上界随文件数线性，记录于 spec |
| ID 格式偏离 canonical 示例被审查反复质疑 | D5 显式裁决 + spec 记录，审查以本 design 为准 |
| STACK/DATA 记录并发写 | 全部经 M1 record store 权威（#74 硬化面），无新并发原语 |

## Subagent Workflow Fixture — Issue #87 Child A (local-token store)

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness. Parent PR #125 reached the five-round ceiling and was split by recorded user decision.

Change surface:
- New focused production module under `packages/backend/src/` for workspace file-backed local-token authority, plus its direct tests and private test support.
- No route, middleware, listener, readiness, shared path-helper, frontend, perf, or M1 caller wiring in Child A; those belong to dependent Child B.

Shared production seam frozen for Child B:
- Module path: `packages/backend/src/local-auth/local-token-store.ts` (not exported from a package-wide/public HTTP barrel).
- `openWorkspaceLocalTokenAuthority(input: { workspaceRoot: string }): WorkspaceLocalTokenAuthority` is synchronous, matching backend startup; the input is one absolute/relative workspace root resolved under the module's descriptor-safe rules.
- `WorkspaceLocalTokenAuthority` is frozen and exposes `token: string`, `source: "workspace"`, and `assertCurrent(): void`. `assertCurrent` re-proves the captured workspace/secrets directory binding, canonical file `(dev, ino)`, type/mode/link/size, and exact token bytes before a future caller trusts `token`.
- `LocalTokenStorageError` is the stable failure type with `code="local_token_storage_unsafe"` and message `Local API token storage is unsafe.`; it never includes token bytes or absolute paths. Child B may let startup fail on this type and may use it for readiness classification, but must not reinterpret unsafe storage as missing credentials.

Must preserve:
- Existing backend, core, workspace, route, schema, package/lock, Zero, and submodule behavior remains byte-for-byte/API compatible because the module is not yet wired.
- The accepted boundaries remain explicit: POSIX cannot rediscover a directory inode permanently displaced during simultaneous external move and process termination. Namespace mutation is serialized only among cooperative SHUD-Harness writers that first hold the exclusive nonblocking mutation lock on the opened `secrets` directory descriptor. A process with directory-write permission that ignores that lock is outside the mutation-serializability contract; observable precondition or postcondition interference still fails closed with `LocalTokenStorageError`, but the module does not claim cross-platform source-inode-conditioned rename/unlink against such a writer.
- Bootstrap is a separate cooperative phase because the `secrets` mutation lock cannot exist before the `secrets` directory exists. Cooperative SHUD-Harness creators use no-clobber `mkdirat` on the final workspace-leaf / `secrets` name and never rename or replace those directory names. A creator that loses the initial absence-to-mkdir race fails the current call; a later independent call validates the existing private directory before use. A process with parent-directory write permission that replaces a just-created bootstrap pathname is outside this cooperative bootstrap serialization contract, just as a writer that ignores the established `secrets` lock is outside mutation serializability. The module does not promise to prevent such active replacement, but any replacement observable at the existing rebind/binding checks MUST yield `LocalTokenStorageError` and no authority.

Must add/change:
- A production internal seam that creates/reuses a file-backed token authority under `<workspace>/secrets/local-token`, returns the bounded token to its future integration caller, and can re-prove the same directory/file authority on demand.
- Directory 0700 and single-link regular token 0600; bounded non-empty visible-ASCII token bytes that round-trip through the real Bun `Headers`/`Request` Bearer seam; descriptor-relative no-follow operations; a typed held-mutation-lease capability; generation validation before and after namespace mutation under that cooperative lease; no-clobber publication; durable staged/publishing/rolling-back recovery; observed uncertainty fails closed for the current invocation.
- Workspace-leaf and `secrets` bootstrap checks before mutation that process umask and parent setgid inheritance cannot transform requested `0700`, then writes directly to the final directory name with private mode and no-clobber semantics; unsupported creation environments fail before mkdir with no final residue. It MUST NOT create random directory-staging names. Process death after final-name mkdir leaves at most the final private directory, which a later call validates and resumes, rather than an undiscoverable protocol artifact.
- Stable bounded directory accounting that remains valid after canonical publication and through every recoverable protocol-artifact phase. The accepted external-entry boundary must restart successfully and interrupted states near that boundary must converge or fail closed without manual cleanup.
- Every acquired descriptor is guarded immediately after acquisition and closes when setup, validation, or identity-checked cleanup under the cooperative mutation lease fails.

Frozen resource accounting:
- Token content: valid UTF-8 encoding of visible ASCII bytes `0x21`–`0x7e`, excluding comma; non-empty and at most 4096 bytes. This excludes all control, whitespace, NUL, DEL, and non-ASCII bytes and MUST round-trip exactly through Bun 1.2.19 `Headers` and `Request` at the frozen `Authorization: Bearer <token>` seam. Directory-entry names: valid UTF-8 and at most 255 bytes.
- Directory enumeration hard cap: 1032 decoded entries = at most 1024 external/unrecognized entries plus at most 8 module-owned entries. Owned entries are the canonical `local-token` and recognized staged/publishing/rolling-back/lease/candidate/retired/legacy transaction artifacts; each recognized name must still pass its phase/identity structure checks. Neither canonical publication nor a recoverable protocol phase consumes the external budget.
- A 1025th external entry or a 9th owned entry fails closed before new publication/deletion. Exactly 1024 external entries remain accepted through canonical publication, ordinary restart, and recovery of each supported interrupted phase.
- Recovery performs one descriptor-relative enumeration of at most 1032 entries and bounded constant work per recognized artifact. Lease acquisition is non-blocking; there is no retry, polling, sleep, or PID-age wait. Test subprocesses use a 2 s per-case ceiling and the adversarial matrix a 30 s enclosing ceiling.

Risk packs considered:
- Public API / CLI / script entry: selected - new internal production module seam; no HTTP/CLI/script consumer yet.
- Config / project setup: not selected - environment-token priority and server config belong to Child B.
- File IO / path safety / overwrite: selected - private directory/token creation, no-follow reads, no-clobber publication, identity-checked cleanup under a held mutation lease.
- Schema / columns / units / field names: not selected - no Zod or persisted business-record schema.
- Auth / permissions / secrets: selected - token bytes and 0600/0700 permissions are the module's contract.
- Concurrency / shared state / ordering: selected - typed cooperative mutation lease, first-create, publication collision, crash recovery, stale/foreign generation detection, and directory binding.
- Resource limits / large input / discovery: selected - bounded token bytes, directory entries/names/decoding, descriptor lifecycle, bounded recovery time.
- Legacy compatibility / examples: selected - safe legacy transaction residue remains recoverable; existing unrelated backend behavior is unchanged.
- Error handling / rollback / partial outputs: selected - stable typed/recognizable unsafe-storage failure, no partial authority, lease-serialized generation-validated rollback and cleanup.
- Release / packaging / dependency compatibility: selected - Bun 1.2.19/macOS/Linux, no new dependency or manifest drift.
- Documentation / migration notes: not selected - internal prerequisite; Child B owns public behavior/migration notes.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - evidence must bind to the exact reviewed source and red/green baseline; no scientific decision is made.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no model/runtime behavior.
- Zero adapter / tool registry / agent role governance: not selected - no Zero/tool/role changes.

Invariant Matrix:
- Governing invariant: the module returns authority only for one bounded private, real-Header-transportable token bound to the held secrets-directory mutation lease and current validated file generation; every in-model recovery/destructive transition requires that typed lease, detects observable identity mismatch before/after mutation, fails the affected invocation instead of adopting a foreign generation, remains restartable at accepted resource boundaries, and closes all owned descriptors.
- Source-of-truth identity/contract: before the lease exists, bootstrap authority is the final-name absent observation followed by no-clobber `mkdirat` and private-directory validation; after `secrets` exists, the typed held-mutation-lease capability contains the opened secrets-directory descriptor and identity, plus canonical token/control artifact `(dev, ino)`, bounded token bytes, and stable entry-category accounting.
- Producers: module authority factory and generated-token publication transaction.
- Validators/preflight: workspace/secrets descriptor chain, file type/mode/link/size/UTF-8 validation, directory entry decoder/accounting, exact identity reproof.
- Storage/cache/query: `workspace/secrets/local-token` and bounded transaction artifacts only; no global token cache or DB.
- Public routes/entrypoints: internal module export only; HTTP/listener/readiness consumers are absent by design.
- Frontend/downstream consumers: Child B is the sole planned consumer; no current consumer changes.
- Failure paths/rollback/stale state: setup/open/fstat/write/fsync/rename/cleanup failure, crash at every durable phase, cooperative bootstrap contention, observable same-name replacements, cooperative lock contention, uncooperative interference detection, legacy residue, parent/path races, resource boundary and restart.
- Evidence/audit/readiness: source-bound semantic red proof for new behavior; coverage-only labels for already-correct untested bounds; macOS/Linux focused matrix, backend compatibility, typecheck/check/perf/OpenSpec/hygiene.
- Regression rows:
  - absent safe store -> one 0600 token under 0700 secrets, reusable and re-provable across restart.
  - accepted maximum external entries plus canonical/protocol allowance -> initial publish, ordinary restart, and each interrupted recovery remain bounded and converge.
  - same-name foreign replacement already observable before mutation at canonical/control/candidate/legacy/retired surfaces -> replacement preserved and operation fails closed; postcondition interference -> stable failure without a false authority claim.
  - live publication collision, publishing recovery, or rolling-back recovery observes a foreign canonical/candidate generation -> current invocation preserves the foreign inode/bytes, cleans only identity-proven owned protocol state, and fails; a later independent invocation may validate/reuse the stable canonical token.
  - two cooperative creators are barrier-released at absent workspace-leaf creation -> exactly one public-seam call succeeds and one gets `LocalTokenStorageError`; neither renames/overwrites the final directory, and an independent retry reuses the winner's canonical token.
  - two cooperative creators are barrier-released at absent `secrets` creation -> exactly one public-seam call succeeds and one gets `LocalTokenStorageError`; neither renames/overwrites the final directory, and an independent retry reuses the winner's canonical token.
  - process death after final-name workspace-leaf or `secrets` mkdir -> restart validates the remaining private directory and converges without random directory-staging residue.
  - restrictive owner-bit umask or parent setgid inheritance would transform requested `0700` -> both workspace-leaf and `secrets` creators fail before mkdir with no final-name residue; safe-environment retry succeeds.
  - cooperative writer A holds the directory mutation lease -> writer B through the public module seam fails before namespace mutation; after A releases the lease, B can proceed normally.
  - setup or cleanup failure after any descriptor acquisition -> no returned authority and descriptor/resource baseline restored.
  - stable existing safe token -> exact bytes reused; invalid/symlink/directory/FIFO/oversize/permission state -> no overwrite and stable failure.
  - unchanged backend/core/test consumers -> existing behavior remains green because module is not wired.

Lease-serialized generation-validation inventory and required oracles:
- Only successful exclusive nonblocking `flock` acquisition on the held `secrets` directory descriptor can construct the branded mutation capability. Destructive helpers accept that capability instead of a bare descriptor; callers cannot represent an unlocked mutation path through the production types.
- Token-bearing `canonical`, `staged`, `candidate`, and retired/legacy artifacts: every observation returns `(dev, ino)`; every restore/retire/delete under the cooperative lease validates the observed identity before mutation and validates postconditions afterward. An already-observable same-name/same-byte new inode survives and yields `LocalTokenStorageError`.
- Control `publishing`, `rolling-back`, and `lease`: creation captures identity from the held descriptor; recovery validation returns identity; publishing→rolling-back rename proves the name changed while inode did not for cooperative writers; success, collision, live rollback, startup recovery, catch cleanup, and marker/lease creation-failure cleanup all require the held capability and consume the captured observation for validation.
- Direct tests replace publishing, rolling-back, and lease before mutation in live and recovery paths; replacement inode/bytes remain, no authority returns, and the next bounded recovery either converges or returns the stable error. These tests prove observable tamper rejection, not an unavailable pathname compare-and-swap primitive.

Required scenario evidence:
- `4096` visible-ASCII transport-safe token bytes accepted/reused; `4097`, empty, malformed UTF-8, control/whitespace/comma/NUL/DEL/non-ASCII, wrong mode/type/link count, symlink/FIFO/directory, and unsafe ancestor fail with `LocalTokenStorageError`, no overwrite/outside write; every accepted token round-trips byte-for-byte through real Bun 1.2.19 `Headers`/`Request` at the frozen Bearer seam.
- `1024 external + 0 owned` -> publish canonical, return authority, leave 1025 total entries, second open reuses identical token; `1025 external` -> fail before publication and preserve all entries.
- `1024 external` plus interruption at staged, publishing, and rolling-back durable phases -> next open stays within `1024 external + <=8 owned`, converges to one canonical authority or preserves foreign state with the stable error; no owned residue after successful convergence.
- Real filesystem: 255-byte name accepted and counted; 256-byte is OS-rejected or module-rejected without publication. Controlled raw dirent records for both Darwin and Linux: invalid UTF-8 and duplicate decoded name reject with no publication/residue; these decoder cases are coverage-only because the pre-split implementation already contained the guards.
- Descriptor lifecycle: inject staged `openat` failure plus lease same-name replacement so identity-checked cleanup under the held lease also fails; inject staged `fstat` failure. In each case replacement bytes/inode remain, no authority returns, and repeated isolated attempts restore `/dev/fd` (or platform-equivalent descriptor inventory) to the pre-attempt baseline.
- Mutation-lease serialization: a process holds exclusive `flock` on the same opened `secrets` directory inode; a second process calling the public module seam returns `LocalTokenStorageError` within the 2 s ceiling and creates/renames/unlinks nothing; after release, the second process succeeds.
- Cooperative bootstrap workspace-leaf barrier: two public-seam processes both observe an absent workspace leaf and contend on its final-name `mkdirat`; exactly one succeeds, one returns `LocalTokenStorageError`, neither renames/overwrites the final name, and the loser independently retries and reuses the winner's canonical token.
- Cooperative bootstrap `secrets` barrier: two public-seam processes both observe absent `secrets` and contend on its final-name `mkdirat`; exactly one succeeds, one returns `LocalTokenStorageError`, neither renames/overwrites the final name, and the loser independently retries and reuses the winner's canonical token.
- Cooperative bootstrap crash: killing a process immediately after either final-name mkdir leaves no random directory-staging entry, and restart converges through validation of the remaining `0700` directory.
- Bootstrap creation-mode preflight: restrictive owner-bit umask and Linux setgid-parent cases exercise both workspace-leaf and `secrets`; the operation either proves exact `0700` and restart convergence or fails before mkdir with no final residue.
- Foreign-generation transition: live publication collision plus publishing/rolling-back recovery foreign canonical/candidate cases fail the affected invocation, preserve exact foreign inode/bytes, remove only owned protocol residue, and permit only a later independent retry to reuse a stable canonical token.
- Semantic red protocol: retain the final injection seams and apply three source-bound mutations separately: (1) bypass successful directory-lock acquisition before constructing the mutation capability, making the public cross-process cooperative-writer exclusion test red; (2) legacy total-entry limit of 1024 with no owned allowance, making boundary restart/interrupted-phase tests red; (3) move descriptor guards after staged setup, making lifecycle tests red. Record exact source SHA/patch, command, per-test failure reason, and restore immediately. Existing pre-mutation replacement, 255-byte, and decoder guards are explicitly coverage-only, never claimed as pathname compare-and-swap proof.

Boundary-surface checklist:
- Shared helper roots: new token-store module only; existing path helper and route root unchanged.
- Read/write/delete/overwrite: workspace/secrets descriptors, canonical token, staged/marker/lease/candidate/legacy artifacts; final-name workspace-leaf / `secrets` bootstrap precedes lease availability and requires absent observation + no-clobber `mkdirat` + private-directory validation, while every token/protocol mutation after `secrets` exists requires the branded held lease, pre/post identity validation, and no-clobber publication.
- Staging/publish/rollback: final-name directory bootstrap without staging residue; every token durable phase, cooperative lock contention, collision, restart, and generation-validated retirement under lease.
- Stale-state/idempotency: repeated startup, crashes, foreign generation, resource boundary, descriptor cleanup.
- Downstream: Child B contract documented but not connected.

Non-goals: HTTP auth, listener binding, env priority, readiness, `WORKSPACE_CANONICAL_DIRECTORIES`, deny-root, route-test migration, perf harness, frontend bootstrap, WebSocket/M3+.

Review focus: stable resource accounting across publication/restart; descriptor lifetime from first acquisition; typed lease capability and cooperative-writer serialization; honest pre/post generation-validation claims; source-bound red attribution; no route or shared-helper drift.

## Subagent Workflow Fixture — Issue #87 Child B (local-auth integration)

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness. Child A is merged on `main`; Child B consumes its frozen local-token authority seam and owns the final backend auth/path-safety integration.

Change surface:
- Backend startup/listener and composition roots (`packages/backend/src/index.ts`, route/middleware composition, and focused local-auth integration), `WORKSPACE_CANONICAL_DIRECTORIES`/ready behavior, all M1 backend route tests, and `scripts/perf/api.ts`.
- Shared core path boundary `packages/core/src/domain/services/workspace-path-safety.ts` and its public service exports/tests: add a generic deny-subtree input/contract; `workspace/secrets/**` is the first configured denied subtree.
- No frontend bootstrap/fetch wrapper, stack/data/artifact consumer wiring, schema expansion, WebSocket auth, multi-user session, or M3+ behavior.

Must preserve:
- Child A's `openWorkspaceLocalTokenAuthority`, `WorkspaceLocalTokenAuthority.assertCurrent`, `LocalTokenStorageError`, token grammar, file identity, permissions, resource bounds, and cooperative-writer semantics remain unchanged; Child B must re-prove a workspace authority before trusting its token and must not reinterpret unsafe storage as missing credentials.
- Existing M1 route status/body/idempotency/readiness/logging behavior and all non-auth assertions remain intact. Only `GET /api/health/live` and `GET /api/health/ready` bypass Bearer auth; non-`/api` requests remain outside the auth middleware.
- Existing workspace containment/no-follow behavior remains unchanged for callers that do not configure denied subtrees; SHUD/rSHUD/AutoSHUD/zero, package manifests, schemas, error-category enum, and frontend remain unchanged.

Must add/change:
- Startup resolves exactly one bounded Header-safe token from `HARNESS_LOCAL_TOKEN` when present, otherwise from Child A's workspace authority. Invalid env token fails startup without fallback or secret echo. Workspace-backed use calls `assertCurrent()` before authentication trust; env-backed use does not create or overwrite the token file.
- Server listen configuration is explicitly and testably `127.0.0.1`. A root auth middleware runs before every non-exempt `/api/**` handler, accepts exactly `Authorization: Bearer <token>`, and returns status 401 with the canonical `permission_error` envelope on missing/malformed/wrong credentials without invoking domain handlers.
- `secrets/` joins canonical workspace initialization/readiness while ready output remains non-sensitive. Workspace init creates or validates this one canonical directory at exact `0700` even when the environment token wins, without creating/overwriting `local-token`; the modes and creation semantics of all other canonical directories remain unchanged.
- The shared path helper adds `deniedRelativeRoots?: readonly string[]`: every element is a non-empty, NUL-free, unambiguous workspace-relative subtree (`.`/`..`/empty segments and absolute paths rejected), normalized beneath the absolute `workspaceRoot` and checked against physical aliases/symlink escape. Invalid policy input throws `WorkspacePathSafetyError("deniedRelativeRoots must contain unambiguous workspace-relative subtrees.", evidenceRef)`; a target equal to or within a denied subtree throws `WorkspacePathSafetyError("Resolved path targets a denied workspace boundary.", evidenceRef)` before returning a resolution. Omitted/empty policy preserves existing behavior.
- Request/error logs contain only auth outcome and existing safe metadata; neither configured, presented, generated, nor expected token bytes may appear. M1 route tests use one helper-controlled valid Authorization header and the perf harness injects a test token.

Risk packs considered:
- Public API / CLI / script entry: selected - backend listener, root `/api/**` middleware, route-test entrypoints, and perf script change.
- Config / project setup: selected - env/file token priority, workspace root, listen host, and startup failure behavior.
- File IO / path safety / overwrite: selected - Child A authority consumption, canonical `secrets/` readiness, and shared deny-subtree helper behavior.
- Schema / columns / units / field names: not selected - canonical error envelope and categories are consumed unchanged; no Zod/persisted business schema changes.
- Auth / permissions / secrets: selected - Bearer grammar, health exemptions, authority reproof, 0600/0700 ownership, no leak, and fail-closed startup/request behavior.
- Concurrency / shared state / ordering: selected - middleware must trust one startup authority and re-prove workspace identity before request authorization; no new mutable token cache or retry loop.
- Resource limits / large input / discovery: selected - env/header token uses Child A's 1-4096-byte grammar; deny-subtree inputs and log handling remain bounded by existing request/path boundaries.
- Legacy compatibility / examples: selected - every M1 HTTP route and readiness behavior remains reachable under the test helper; perf behavior does not regress.
- Error handling / rollback / partial outputs: selected - unsafe token storage/invalid env fails startup, unauthorized requests fail before handlers, and no partial auth or token material is published.
- Release / packaging / dependency compatibility: selected - Bun 1.2.19/macOS/Linux and no dependency/package/lock drift.
- Documentation / migration notes: not selected - the OpenSpec requirement and issue already define this internal MVP auth migration; no public deployment guide is in this PR boundary.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - logs/review evidence must bind to the exact head without token material; no scientific decision is made.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver/toolbox/pipeline runtime change.
- Zero adapter / tool registry / agent role governance: not selected - no Zero/tool/role surface.

Invariant Matrix:
- Governing invariant: the backend listens only on loopback and no non-exempt `/api/**` handler can run unless one syntactically exact Bearer credential matches the current validated startup token authority, while token bytes and `workspace/secrets/**` remain unavailable through responses, logs, readiness, or path-service consumers.
- Source-of-truth identity/contract: one startup token source—validated `HARNESS_LOCAL_TOKEN`, otherwise a Child A `WorkspaceLocalTokenAuthority` whose `assertCurrent()` binds the current private file generation before trust—plus the canonical exemption set `{GET live, GET ready}` and configured denied subtree rooted at the resolved workspace `secrets` directory.
- Producers: startup token-source resolver and Child A file authority; no request-provided token becomes authority.
- Validators/preflight: env/Header grammar validation, workspace authority reproof, exact Authorization parsing/comparison, loopback listen config, and path-helper containment/deny checks.
- Storage/cache/query: `workspace/secrets/local-token` via Child A only; no new token cache, persistence lane, URL/query/localStorage value, or business-record schema.
- Public routes/entrypoints: backend listener, app/middleware composition, every `/api/**` route, live/ready exemptions, and perf harness.
- Frontend/downstream consumers: M1 direct route tests and perf script migrate; frontend bootstrap/fetch, WebSocket, and #94/#96/#98 deny-subtree consumers remain out of scope.
- Failure paths/rollback/stale state: invalid env fails app/startup construction with `LocalTokenStorageError`; unsafe/replaced workspace authority detected by `assertCurrent()` during a protected request returns 401 canonical `permission_error`, records only safe 401 metadata, and runs no protected handler; missing/malformed/wrong Authorization follows the same public envelope. Also cover method/path near exemptions, invalid deny-policy roots, path equal to/inside/outside denied subtree, ready before/after init, and logging on 401.
- Evidence/audit/readiness: focused core/backend tests, four auth negative/positive scenarios, listener assertion, all M1 routes, perf, full check/typecheck, strict OpenSpec, hygiene, CI, and review evidence with secret scan.
- Regression rows:
  - env token or current workspace authority + exact Bearer on a protected M1 route -> original handler response; workspace source is re-proved before trust.
  - absent/malformed/wrong credential or `assertCurrent()` stale/unsafe workspace authority -> 401 canonical `permission_error`, zero protected-handler effect, safe 401 request-log metadata only, and zero configured/presented/expected token bytes or storage details in response/log; invalid startup source/storage terminates app construction with `LocalTokenStorageError` before listening.
  - exact `GET` live/ready without token -> existing health behavior; HEAD/other method or lookalike path does not gain an exemption.
  - resolved path equal to or nested under configured `workspace/secrets` -> path-safety rejection before access; sibling/outside path follows unchanged M1 behavior.
  - startup/listener inspection -> host exactly `127.0.0.1`; no wildcard/non-loopback default.
  - unchanged M1 route/perf consumer -> valid helper token preserves prior status/body/performance contract without weakened assertions or new skips.

Required scenario evidence:
- Focused backend tests: no token and wrong/malformed token return 401 `permission_error`; correct token preserves a representative protected route; live/ready alone are exempt; method/path lookalikes remain protected; a handler-effect sentinel proves rejection precedes handler execution.
- Token-source tests: valid env wins; after workspace init, `secrets/` exists as an exact `0700` directory while `secrets/local-token` remains absent and any pre-existing token bytes remain untouched. Invalid/empty/oversize/non-Header-safe env fails app construction with `LocalTokenStorageError` without falling back or echoing; absent env consumes Child A, and a replaced/unsafe authority on a protected request returns the specified 401 envelope before handler execution.
- Logging/redaction tests: exercise configured and presented credentials through 200/401/error logging and assert exact token substrings are absent from every captured NDJSON line and error body.
- Path-safety tests at the public helper seam: `deniedRelativeRoots: ["secrets"]` rejects exact root, nested regular path, traversal-normalized descendant, and physical alias/symlink-reachable attempts before read with the exact denied-boundary `WorkspacePathSafetyError`; blank/absolute/dot-segment/NUL policy entries fail with the exact invalid-policy error. An adjacent sibling and omitted/empty-policy readonly-root/workspace cases preserve existing outputs/errors.
- Ready/listener/tests migration: canonical `secrets/` participates in initialization/ready checks without an absolute path/token in the response; all backend route tests use a shared auth helper; `scripts/perf/api.ts` supplies its test token; listener host assertion is made at the production startup seam.
- Red proof: stash only new/changed production source while retaining new tests, run the focused core/backend new-behavior set once against pre-change source (collection/import failures count only for genuinely new seams), pop immediately, then run green; report exact failing tests and leave no `red-proof` stash.
- Final commands: `npx --yes bun@1.2.19 run test:core-services`; `npx --yes bun@1.2.19 run test:backend-api`; `npx --yes bun@1.2.19 run test:perf:api`; `npx --yes bun@1.2.19 run typecheck`; `npx --yes bun@1.2.19 run check`; `npx --yes openspec validate m2-research-context --strict --no-interactive`; `git diff --check`; package/lock, tracked-workspace, submodule, stash hygiene checks.

Boundary-surface checklist:
- Shared helper roots: `resolveWorkspacePath`/path-safety exports and all unchanged direct consumers; deny policy must be opt-in and centralized rather than route-specific duplication.
- Public entrypoints: production listen options, app composition order, all `/api/**` routes, exact live/ready exemption, non-API surface, test app factory, and perf harness.
- Read/write/delete/overwrite: Child B only selects/re-proves Child A authority and adds canonical directory/readiness consumption; it must not reimplement token publication or add another write path.
- Producer/consumer evidence: env/file authority -> middleware -> response/log; token bytes cannot cross the comparison boundary into evidence.
- Stale-state/idempotency: file generation replacement between startup and request fails closed; existing task idempotency and route handler ordering stay unchanged.
- Unchanged downstream consumers: frontend/WS and #94/#96/#98 wiring remain untouched; current core path callers behave identically when no denied subtree is configured.

Non-goals: frontend token bootstrap/fetch wrapper (#88), stack/data/artifact route/service wiring, WebSocket authentication, sessions/passwords/users, new error categories, metadata/data endpoints, M3+ identity/audit convergence, and changes to Child A publication/recovery internals.

Review focus: middleware altitude/order and exemption exactness; token-source authority/reproof and secret non-observability; deny-subtree helper compatibility across siblings; startup/ready/listener integration; complete M1/perf migration without weakened or skipped oracles.

## Subagent Workflow Fixture — Issue #89

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: public Zod schema/field contracts、persisted Artifact default materialization、legacy compatibility and generated JSON Schema/Markdown.
- Profile triggers: `artifact` and evidence-lineage semantics; the Artifact delta is consumed immediately by the existing M1 registry/store, while StackLock/DataProvenance/ArtifactManifest services follow in 4.x/5.x/6.x.

Change surface:
- `packages/core/src/domain/schemas/` public exports for StackLock、DataProvenance、ArtifactManifest and Artifact input/output types.
- `packages/core/src/domain/schemas/core-schemas.test.ts`, existing M1 Artifact registry/store compatibility tests, `scripts/schema/generate.ts`, and generated JSON/Markdown under `docs/generated/`.

Must preserve:
- Existing callers may continue passing the M1 Artifact input without `llm_generated`; registration and reads now expose the canonical stored output with `llm_generated: false` rather than rejecting the caller or treating a repeated registration as divergent.
- Existing persisted Artifact JSON without the additive field remains readable: parse/get materializes `false` in memory without requiring an eager rewrite; a later duplicate registration of the same legacy input converges on the same logical record.
- Explicit `llm_generated: true` survives schema parse、registry persistence/read and nested ArtifactManifest parse; unknown/non-boolean values remain rejected.
- TaskCard、ErrorRecord、IdempotencyRecord and LockRecord schemas, service behavior, package/lock files, API routes and workspace path/publication authority remain unchanged.

Must add/change:
- Add strict StackLock、DataProvenance and ArtifactManifest contracts exactly matching the task 2.1 deltas, plus their public input/output types and schema-generator registry entries.
- Extend Artifact with optional-input `llm_generated` defaulting to `false`; distinguish `Artifact`/`ArtifactInput` caller input from `StoredArtifact` parse output, and apply the same distinction to ArtifactManifest.
- Regenerate checked-in JSON Schema/Markdown exclusively through `scripts/schema/generate.ts`.

Seams under test:
- Public schema barrel imports are the highest schema seam: compile-time assertions prove omitted-input acceptance and boolean post-parse output.
- `ArtifactSchema.safeParse` and nested `ArtifactManifestSchema.safeParse` prove strict field/default behavior.
- Existing `createArtifactRegistryService` register/get/duplicate flows are the highest current persistence seam and prove the additive default across M1 callers and records.
- `schema:check` proves generator registry and checked-in JSON/Markdown parity without adding a test-only seam.

Risk packs considered:
- Public API / CLI / script entry: selected - public schema barrel exports and generator registry gain new named contracts; no HTTP/CLI entrypoint changes.
- Config / project setup: not selected - no environment、workspace bootstrap or configuration semantics change.
- File IO / path safety / overwrite: selected - no I/O implementation changes, but the existing Artifact registry read/write boundary consumes the changed schema and must prove legacy record reads and canonical persisted defaults; path authority itself is a non-goal.
- Schema / columns / units / field names: selected - this issue adds three strict object graphs and one persisted Artifact field with distinct input/output types.
- Auth / permissions / secrets: not selected - schemas contain no credential and do not change authorization boundaries.
- Concurrency / shared state / ordering: selected - the existing Artifact duplicate-registration comparison consumes parsed persisted state; omitted legacy input must converge rather than create a false immutable conflict.
- Resource limits / large input / discovery: not selected - no reader/discovery loop or unbounded payload surface is introduced; existing schema parsing scope is unchanged.
- Legacy compatibility / examples: selected - M1 callers and persisted Artifact JSON may omit the new field and must materialize the same canonical false value.
- Error handling / rollback / partial outputs: selected - strict unknown/deprecated fields and invalid types fail parse without partial records; existing registry errors remain stable.
- Release / packaging / dependency compatibility: selected - public exports and generated artifacts change while package manifests、lockfile and dependencies must remain unchanged.
- Documentation / migration notes: selected - generated JSON/Markdown must describe required/optional/default semantics and the legacy omission policy is recorded here.
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - `llm_generated` controls later evidence eligibility, so false-by-default and true preservation must be auditable and deterministic; no scientific conclusion is made.
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: not selected - no solver、R pipeline、model input/output or submodule runtime changes.
- Zero adapter / tool registry / agent role governance: not selected - no Zero source、tool registration or role boundary changes.

Invariant Matrix:
- Governing invariant: every accepted research-context object has one strict canonical shape, and an Artifact omitted by a legacy caller can never lose or ambiguously represent its persisted LLM-origin state across parse、register、read、duplicate comparison or manifest nesting.
- Source-of-truth identity/contract: Minimal_Schemas §2/§3、Support_Schema_Contracts §1/§2 and design D5/D5a/D6; `ArtifactSchema` input allows omission while `StoredArtifact` output requires boolean `llm_generated`.
- Producers: existing M1 Artifact callers and legacy JSON records produce Artifact input; new schema fixtures produce StackLock/DataProvenance/ArtifactManifest input; `scripts/schema/generate.ts` produces checked-in JSON/Markdown.
- Validators/preflight: public schemas in `packages/core/src/domain/schemas/`; existing `createArtifactRegistryService` invokes `ArtifactSchema` before register and `readJsonRecord` invokes it on persisted records.
- Storage/cache/query: M1 `workspace/artifacts/manifests/<artifactId>.json` is the current consumer; register stores materialized false, get parses legacy omission to false without eager rewrite, and duplicate comparison uses canonical parsed records. New M2 object persistence is deferred to 4.x/5.x/6.x.
- Public routes/entrypoints: `packages/core/src/domain/schemas/index.ts` and generated schema docs are changed; no HTTP route changes.
- Frontend/downstream consumers: current Artifact registry/service tests plus future StackLock、DataProvenance and ArtifactManifest services; frontend and API wiring remain unchanged.
- Failure paths/rollback/stale state: missing required、deprecated/unknown、wrong-type and invalid-ID inputs fail strict parse before persistence; divergent duplicate semantics and existing stable errors remain unchanged; no rollback surface is added.
- Evidence/audit/readiness: compile-time barrel/type assertions、focused schema tests、focused M1 Artifact registry tests、generator drift check、full core/check suites、strict OpenSpec validation and final CI bound to the PR head.
- Regression rows:
  - M1 Artifact input omitting `llm_generated` -> schema output and register/get result contain `llm_generated: false`, and the persisted new record contains the explicit false value.
  - Existing persisted JSON omitting `llm_generated` -> get returns canonical false without rewriting the file; registering the same old input again converges instead of raising immutable-conflict.
  - Explicit `llm_generated: true` -> Artifact register/get and nested ArtifactManifest parse preserve true; explicit false remains false.
  - Invalid/non-boolean/unknown Artifact field or incomplete/legacy-shaped new M2 object -> strict parse fails and no partial generated/persisted object is accepted.
  - Existing TaskCard、ErrorRecord、IdempotencyRecord and LockRecord tests -> unchanged outputs and failures remain green.

Boundary-surface checklist:
- Shared schema roots: only the four named schema modules plus the public schema barrel are changed; existing sibling schema implementations stay untouched.
- Public entrypoints: schema barrel/type exports and generator registry; no service/route wiring for the three new M2 objects.
- Read/write surfaces: existing M1 Artifact registry/store is compatibility evidence only; no new writer、reader、delete or overwrite implementation.
- Producer/consumer evidence: legacy/caller Artifact input -> ArtifactSchema -> registry/write/read/duplicate -> StoredArtifact; schema registry -> generated JSON/Markdown.
- Stale-state/idempotency: repeated legacy omission and explicit false identify the same logical record; explicit true remains distinct and preserved.
- Unchanged downstream consumers: TaskCard/error/idempotency/lock schemas, API/backend/frontend, package/dependency files and read-only submodules.

Non-goals:
- StackLock/DataProvenance/ArtifactManifest services、workspace directories、routes or UI; evidence rule engine/audit upgrade (6.1); path-safety changes; migration rewrite of legacy Artifact files; dependency or Zero changes.

Review focus:
- Zod input/output typing and default materialization at both direct and nested boundaries.
- M1 Artifact registry register/get/duplicate compatibility, especially legacy omitted-field records.
- Exact strict schemas and generated JSON/Markdown parity for D5/D5a/D6.
- No unintended sibling schema、service、route、package/lock or submodule drift.

## Subagent Workflow Fixture — Issue #90

Fixture level: expanded; repair intensity: high. Project profile: SHUD-Harness.

Expanded-trigger rationale:
- Core triggers: shared hashing service、文件/目录读取、symlink/no-follow、非常规文件拒绝和大输入流式处理。
- Profile triggers: `workspace`、path/evidence lineage；后续 StackLock 与 DataProvenance 会消费本服务，但调用方接线不在本 issue。

Change surface:
- `packages/core/src/domain/services/` 下的 hashing service、service export boundary 与独立 core-services 单测。

Must preserve:
- M1 `workspace-path-safety` 是路径规范化、边界与 symlink preflight 的唯一 owner；本 issue 只消费其公开契约，不修改 helper 本体。
- 现有 core service 导出、测试和 workspace record/read/write 行为不变；不接线 StackLock、DataProvenance、manifest 或 API route。

Must add/change:
- `hashFile` 对常规文件内容做流式 sha256，结果与 `shasum -a 256` 一致。
- `hashDirectory` 递归检查目录树，拒绝任意 symlink/非常规项；把全部常规文件规范为 `/` 分隔的相对路径，按字典序生成 `"<relpath>\n<file-sha256>\n"` 字节序列并哈希；无常规文件时拒绝。
- 在 path-safety preflight 后，以 Mac/Linux 的 descriptor-relative `openat` + `O_NOFOLLOW` 固定每级目录/文件身份，并通过固定目录 descriptor 枚举；文件读取受打开后首次 `fstat.size` 硬上限约束，再执行完整 metadata/身份复核。错误统一为 `WorkspacePathSafetyError` 家族。
- 公共签名固定为 `hashFile(input)` / `hashDirectory(input)`：共同 input 为 `{ workspaceRoot, inputPath, evidenceRef, allowedReadonlyRoots? }`，仅 `hashFile` 额外接受可选 `maxBytes?` 并在已打开 descriptor 的初始 size 上、内容读取前执行；返回 `Promise<string>`。

Risk packs considered:
- Public API / CLI / script entry: selected - `services/index.ts` 暴露公共 core service API；不新增 HTTP/CLI/script 入口。
- Config / project setup: not selected - 无配置、环境变量或 workspace 初始化变化。
- File IO / path safety / overwrite: selected - 读取文件树且必须拒绝 traversal、symlink 和非常规项，不产生写入。
- Schema / columns / units / field names: not selected - 不新增或修改 Zod/持久化 schema。
- Auth / permissions / secrets: not selected - 不接线用户输入端点或 secrets deny 子树；该策略属于 1.1/5.1。
- Concurrency / shared state / ordering: selected - 目录枚举到读取间的对象替换必须 fail closed，不能跟随替换后的 symlink/非原对象。
- Resource limits / large input / discovery: selected - 文件内容流式读取，目录发现仅限目标子树；内存不随文件字节数增长。
- Legacy compatibility / examples: selected - M1 path-safety helper、service export 与既有 core-services 套件保持兼容。
- Error handling / rollback / partial outputs: selected - 任一不安全/缺失/变化项使整次 hash 拒绝，不返回部分 digest；无写入或清理面。
- Release / packaging / dependency compatibility: selected - 仅使用 Node/Bun 内建能力，不新增依赖，package manifests 与 lockfile 保持零漂移。
- Documentation / migration notes: not selected - D3/spec 与 issue 已定义协议，无用户迁移面。
Domain packs:
- Scientific governance / PI gate / evidence lineage: selected - digest 是后续 provenance/StackLock 的证据身份，必须绑定实际读取字节与路径序列。
- Hydrology runtime / SHUD-rSHUD-AutoSHUD compatibility: selected - SHUD 输出可能很大，文件读取不能整读内存；不修改模型或运行时。
- Zero adapter / tool registry / agent role governance: not selected - 不触碰 Zero 或工具注册。

Invariant Matrix:
- Governing invariant: digest 只能代表本次在受信 workspace/read-only 边界内、以 no-follow 方式完整读取并验证过的同一组常规文件字节及其 canonical 相对路径序列。
- Source-of-truth identity/contract: design D3 的文件内容 sha256 与目录 `"<relpath>\n<file-sha256>\n"` 排序行协议；M1 `resolveWorkspacePath`/`WorkspacePathSafetyError`。
- Producers: `hashFile`、`hashDirectory` 与共享的 descriptor/stream hashing 内部实现。
- Validators/preflight: `resolveWorkspacePath(access="read")`、每级 `lstat`、descriptor-relative `openat`/`O_NOFOLLOW`、固定目录 descriptor 枚举、打开后 `fstat`/identity/metadata 核对与初始 size 读取上限。
- Storage/cache/query: none - 纯读取并返回 digest，不缓存、不落盘。
- Public routes/entrypoints: `packages/core/src/domain/services/index.ts` 导出的 `hashFile`/`hashDirectory`；HTTP/CLI/API route 为 none，调用方接线属于 4.1/5.1。
- Frontend/downstream consumers: unchanged future consumers `StackLock` 与 `DataProvenance`；本 issue 只固定公共 service 契约。
- Failure paths/rollback/stale state: missing、空目录、LF-bearing path segment、symlink leaf/ancestor、FIFO/socket/device、目录/文件路径替换、读取中增长/截断/替换/metadata 漂移均 fail closed，不返回 digest；active appender 不得把读取延伸到首次 descriptor size 之外。
- Evidence/audit/readiness: focused hashing tests、`test:core-services`、`typecheck`、`check` 与 strict OpenSpec。
- Regression rows:
  - 常规文件（含大文件/分块边界） -> 流式 digest 等于独立 sha256 参照值，且不调用整文件读取 API。
  - `a.txt="A"`、`nested/b.txt="B"` -> canonical 行序列 `a.txt\n559a...fdffd\nnested/b.txt\ndf7e...20a5c\n` 的独立 oracle digest 为 `abeb7f0f89055fff57ff5fdec6e07f6b397071d82f6b11e52d068bef7951bb0d`；重复两次同 digest，创建顺序不影响结果。
  - 精确碰撞构造 `a="A"`、`b="B"` 与单文件名 `a\n<sha256(A)>\nb`/内容 `B` 不得同时产生 digest：后者与任一 nested LF segment 在文件内容读取前返回 `WorkspacePathSafetyError`，普通名称 oracle 不变。
  - 在上述目录新增文件、修改内容或重命名相对路径 -> digest 改变。
  - 空目录或树内 symlink/非常规项/对象替换 -> `WorkspacePathSafetyError`，且替换后的目录 target 未被枚举、替换 ancestor 下的文件 bytes 未被读取。
  - 首个 64 KiB chunk 后截断/增长及持续 active appender -> `WorkspacePathSafetyError`；读取在首次 descriptor size 内有界收敛。
  - 合法 M1 workspace path 与现有 core service consumers -> 原行为和测试保持通过；无 StackLock/DataProvenance 接线变化。

Boundary-surface checklist:
- Shared helper roots: `workspace-path-safety.ts` 只读复用，不修改。
- Public entrypoints: `packages/core/src/domain/services/index.ts` 导出新的 hashing API；无 HTTP/CLI。
- Read surfaces: 单文件、固定目录 descriptor 的递归枚举、每个常规文件的 descriptor-relative/no-follow 打开与初始 size 有界流式读取。
- Write/delete/overwrite surfaces: none - 服务不得写入、删除或覆盖任何路径。
- Producer/consumer evidence boundaries: 实际文件字节 + canonical 相对路径序列 -> 单一 sha256 字符串；不接受调用方提供 digest。
- Stale-state/idempotency boundaries: 重复读取稳定树确定；读取期间身份/类型变化 fail closed。
- Unchanged downstream consumers: path-safety、record store、artifact/task services 及未来 4.1/5.1 接线边界。

Non-goals:
- StackLock/DataProvenance/manifest/API 接线，修改 path-safety helper，目录写入/发布，或 M3+ 行为。
- 对目录字节做全量内存缓存；M2 不引入跨进程目录快照/锁。

Review focus:
- no-follow 必须落实到打开/读取点，不能只依赖一次路径 preflight。
- 目录行协议的相对路径、换行、排序与变化敏感性精确一致。
- 特殊文件在任何可能阻塞的 read/open 之前被拒绝；大文件内容保持流式。
- 错误保持 path-safety 家族且无 partial digest/副作用。

## Test IDs

W2-SUB-001（submodule discovery）、W2-DATA-001/002（register 存在/缺失路径）、W2-ART-001（artifact metadata 合法性）、W2-ART-002（manifest_sha256 可复算）+ UI 三条（ResearchContext×2、ArtifactRef）。Exit gate：任一 task 可绑定 stack_id + data_id；registry 记录 evidence_usable artifact。
