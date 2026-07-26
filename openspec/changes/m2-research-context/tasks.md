# M2 Research Context — Tasks

粒度纪律（design D8，M1 教训）：schema/service/route 分层拆分，高风险面（hashing、数据服务端点、auth 中间件）各自独立成任务；每任务 = 一个小 PR 尺寸的 issue；不为压数量合并模块边界。依赖: 行内标注。

依赖判定（2026-07-22 split 后代码接缝复核）：只记录在既定 PR boundary 内完成任务所必需的前置产物/契约，不把单纯推荐顺序记成依赖。0.1 的 canonical 修正分别定义 1.1a 使用的 token/目录契约与 2.1 使用的 schema 契约，因此直接阻塞 1.1a、2.1；1.1b 依赖 1.1a 的 token-store 模块，且 1.1b 是 path-safety deny 子树机制的唯一 owner，相关 downstream tasks 仅消费该机制，因此依赖 1.1b；3.1 的文件/目录 hashing 只被 4.1/5.1 消费，6.1 的 evidence 规则、落盘判定与 audit 不计算内容哈希，因此 6.1 不依赖 3.1。

## 0. canonical 账目落账（bug 级修正批次，先行）

- [x] 0.1 canonical 文档 bug 级修正与账本补记（依据 design D1/D4/D5a/D6/D7a 的显式偏离记录）：Minimal_Schemas §2 repos 补 `zero` 行（与 Test_Plan W2-SUB-001 的 canonical 内部矛盾修正）+ `r_packages_lock` 形态改 `{ path, sha256 } | null`；Support_Schema_Contracts §1 Artifact 补 `llm_generated`、§2 ArtifactManifest 补 `superseded_by`；Config_Secrets §4 推荐环境变量表补 `HARNESS_LOCAL_TOKEN` 一行（批次 4 `GLM_API_KEY` 先例）、§6 harness 示例与 Minimal_Schemas §2 对齐；Workspace_Conventions §1.2/§5 与 Repository_Layout §2 的 provenance 目录形态统一为 `workspace/provenance/DATA-*.json` 并补 `secrets/`、`artifacts/manifest-sets/` 目录；Phased_Spec_Activation 例外批次 6 账补记上述各项（验证: 修正后各文档交叉引用一致、provenance 目录无第三种命名残留）

## 1. local-auth（最前落地，design D1 排序决策；#125 terminal split 后串行 Child A → Child B）

- [x] 1.1a Child A — workspace file-backed local-token store production module（不接线 routes）：0600/0700、1–4096 byte visible-ASCII real-Header-safe token、descriptor-relative no-follow、creation-mode preflight + final-name no-clobber cooperative bootstrap（无错误 mode/随机目录-staging residue）、typed mutation-lease 下的 lease-serialized generation-validated token publication/recovery（观察到 foreign generation 的当前调用失败，后续独立调用才可复用）、稳定目录资源预算、全失败路径 descriptor 收敛；不承诺对忽略 bootstrap/ mutation-lock 协议的同目录 writer 提供跨平台 source-inode-conditioned rename/unlink；完整 expanded/high fixture 见 design「Issue #87 Child A」（依赖: 0.1。验证: cooperative absent-tree concurrency + post-mkdir process-death restart + restrictive umask/setgid preflight、真实 Headers/Request grammar、foreign live/recovery generation fail-current-call、source-bound semantic red + coverage-only 账；macOS/Linux focused；backend compatibility；typecheck/check/perf/OpenSpec/hygiene）
- [x] 1.1b Child B — localhost 绑定 + 单一本地 token 中间件 + 既有测试面迁移，消费 1.1a 模块（token 来源 `HARNESS_LOCAL_TOKEN` → `workspace/secrets/local-token` 文件 0600/目录 0700；`secrets/` 加入 `WORKSPACE_CANONICAL_DIRECTORIES` 并联动 ready 检查、不受任何目录列举/读取端点服务、token 值受 redaction 覆盖；豁免 health live/ready，非 `/api` 面不做 Bearer 校验；401 canonical envelope `category=permission_error`（design D1，不扩 frozen 枚举）；token 不入日志。迁移清单 = M1 全部路由测试（helper 统一注入）+ `scripts/perf/api.ts` 注入测试 token；完整 expanded/high 风险包、Invariant Matrix、required evidence 与 boundary-surface checklist 见 design「Issue #87 Child B」）（依赖: 1.1a。验证: 新增负例 4 条 + `bun run check` 全绿 + `bun run test:perf:api` 通过）
- [x] 1.2 前端 token bootstrap + 统一鉴权 fetch wrapper + M1 UI 回归（入口页注入 `window.__HARNESS_BOOTSTRAP__`；api 层统一 wrapper 为全部 `/api/**` 请求附加 Authorization；迁移 Dashboard 既有 `window.fetch` 直连调用点；token 不落 URL/localStorage）（依赖: 1.1b。验证: 浏览器建卡 M1 走查在 token 体制下端到端成功 + `bun run test:frontend`）
  - Fixture (#88): expanded / high；共享入口页、public API wrapper 与 token/credential 边界触发 mandatory expanded，沿用本 change 已有 proposal/design/spec 全集。
  - Invariant Matrix (#88): authority producer = backend `LocalTokenAuthority`；distribution = loopback-only `/`/`/dashboard` inline bootstrap；validator = transport-safe token parser；carrier = forced `Authorization` header；consumer = Dashboard 与后续 ResearchContext；failure = missing/malformed bootstrap、非 `/api/**`、cross-origin、stale authority 均 fail closed；persistence = none（URL/query/localStorage/cookie 均不写）。
  - Risk packs (#88): Public API / entrypoint、Auth / permissions / secrets、Legacy compatibility、Error handling、Release / packaging selected；Config、File IO、Schema、Concurrency、Resource limits、Documentation 与三项 SHUD domain packs not selected（无对应变更面）。
  - Boundary-surface checklist (#88): `packages/frontend/src/api` 是浏览器 `/api/**` 唯一出口；Dashboard POST/GET 显式消费 wrapper；production server 仅在 loopback Host 的 GET 入口注入，HTML `no-store` 且无 CORS；auth middleware/token-store 与新 UI 均不改。
  - Evidence floor (#88): frontend wrapper/header merge/cross-origin/script-escaping tests；Dashboard 建卡/列表脚本回归与无直连 `window.fetch` 断言；backend 真实 auth middleware 下 bootstrap → POST → GET 浏览器 harness；`npx --yes bun@1.2.19 run test:frontend`；`npx --yes bun@1.2.19 run test:backend-api`；`npx --yes bun@1.2.19 run typecheck`；`npx --yes bun@1.2.19 run check`；`npx --yes openspec validate m2-research-context --strict --no-interactive`；`git diff --check`；submodule/workspace hygiene。

## 2. core-schemas 扩展

- [x] 2.1 StackLock + DataProvenance + ArtifactManifest Zod schemas + Artifact `llm_generated` 扩展 + 正反例单测（strict 拒废弃字段；llm.base_url required；event_window 对象形态；ID 格式 `STACK-/DATA-/MANIFEST-<uuid>`（design D5）；StackLock repos 四键与 `r_packages_lock` 对象形态按 D5a 偏离记录；ArtifactManifest 与 Support_Schema_Contracts §2 一一对应——含必填 `generator`、可选 `report_id`、`artifacts` 为完整 Artifact[]、可选 `superseded_by`；Artifact 增 `llm_generated` 可选缺省 false（design D6 偏离记录）（依赖: 0.1。验证: `bun run test:schemas`、schema drift 检查覆盖 D5a/D6 偏离记录）
  - Fixture (#89): expanded / high；新增公共 Zod 对象契约、strict unknown-key 语义、默认值输入/输出差异、既有 M1 Artifact 持久化消费面与生成 JSON Schema/Markdown 触发 mandatory expanded；完整 fixture 见 design「Subagent Workflow Fixture — Issue #89」。
  - Invariant Matrix (#89): canonical source = Minimal_Schemas §2/§3 + Support_Schema_Contracts §1/§2 + design D5/D5a/D6；producers = M1 Artifact callers/legacy JSON、新 M2 schema fixtures、schema generator；validators = 四个 public schemas + existing Artifact registry/readJsonRecord parse；storage consumer = existing `workspace/artifacts/manifests/`（三项新对象的 storage deferred 到 4.x/5.x/6.x）；failure = strict parse before persistence；evidence = barrel/type assertions + schema tests + M1 registry regression + generated drift。
  - Risk packs (#89): Public API、File IO（既有 Artifact store 消费）、Schema / fields、Concurrency（duplicate canonical comparison）、Legacy compatibility、Error handling、Release / packaging、Documentation / migration、Scientific evidence lineage selected；Config、Auth、Resource limits、Hydrology runtime、Zero governance not selected；逐包理由与 non-goal/evidence mapping 见 design fixture。
  - Boundary-surface checklist (#89): 生产改动限于 core schema exports 与 generator registry，生成物限于 `docs/generated/**`；既有 Artifact registry/store 只作为 compatibility seam 由测试覆盖，不改 path/publication authority；不接线三项新 service/route、不创建 workspace 写路径、不改变 TaskCard/error/idempotency/lock 既有对象语义。
  - Evidence floor (#89): public barrel compile/type assertions证明 Artifact input omission 合法且 StoredArtifact output 为 boolean；StackLock 四 repo + nullable/object renv 正例，missing base_url、旧 renv 字符串、runtime.container/root limits/policy_version/degraded 负例；DataProvenance object window/hash/source 正例与 array window/缺 hash/缺 observation field/unknown key 负例；ArtifactManifest full Artifact/optional refs 正例与 compact artifact/missing generator/invalid IDs 负例；direct/nested Artifact omitted marker → false、true 保留、非 boolean/unknown key 拒绝；focused M1 registry tests证明 omitted input register/get 持久化 false、legacy omitted-field JSON get 不重写且 duplicate 收敛、explicit true round-trip；`npx --yes bun@1.2.19 run test:schemas`；`npx --yes bun@1.2.19 run test:core-services`；`npx --yes bun@1.2.19 run schema:check`；`npx --yes bun@1.2.19 run typecheck`；`npx --yes bun@1.2.19 run check`；`npx --yes @fission-ai/openspec@1.3.1 validate m2-research-context --strict --no-interactive`；`git diff --check`；package/lock/submodule/workspace hygiene。

## 3. hashing 工具（高风险面，独立）

- [x] 3.1 sha256 双形态工具：文件流式 + 目录排序行协议；符号链接/非常规文件/空目录拒绝，no-follow 纪律，复用 M1 path-safety helper（验证: 确定性/变更敏感/链接拒绝单测，core-services 套件）
  - Fixture (#90): expanded / high；完整风险包、Invariant Matrix 与 boundary-surface checklist 见 design「Subagent Workflow Fixture — Issue #90」。
  - Evidence floor (#90):
    - 文件 fixture（已知字节、空文件、大于 stream chunk）-> digest 与独立 `createHash`/`shasum -a 256` 参照一致；测试证明实现不使用 `readFile` 整读。
    - 从 `packages/core/src/domain/services` barrel 导入 `hashFile`/`hashDirectory`，断言固定 options 输入、`Promise<string>` 输出及 `WorkspacePathSafetyError` 错误契约。
    - 独立目录协议 oracle：`a.txt="A"`（file sha `559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd`）与 `nested/b.txt="B"`（file sha `df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c`）按 `/` 相对路径和精确单换行组装后，directory sha 为 `abeb7f0f89055fff57ff5fdec6e07f6b397071d82f6b11e52d068bef7951bb0d`；不同创建顺序仍相同。
    - `inputPath="."`、absolute workspace root 与 exact `allowedReadonlyRoot` 均以独立 directory oracle 重复验证并保持变更敏感；boundary root 枚举使用独立 open-file description，不共享目录 cursor。
    - 在上述目录新增文件、修改内容、重命名相对路径 -> digest 均改变。
    - 空目录、symlink leaf、symlink ancestor、目录内 symlink、FIFO（平台支持时）及枚举/打开窗口对象替换 -> `WorkspacePathSafetyError`，不跟随、不阻塞、不返回 partial digest；test-side `bun:ffi` directory descriptor 与 callback `node:fs.read` wrapper 先由 control hash 证明实际调用，再证明 root/nested 目录替换 target 未被枚举、替换 ancestor/leaf 的文件 bytes 未被读取。
    - D3 行协议保持原 ordinary-name oracle；精确 LF collision 构造与 nested LF segment 在读取对应文件内容前拒绝，并保留原 `evidenceRef`；active callback `node:fs.read` control 证明受影响 inode 在拒绝前零读取。
    - 目录项解码保留 leading UTF-8 BOM；root file 与 nested directory 分别以 `a`/`\uFEFFa` 共存，digest 等于独立 D3 oracle，修改任一 distinct file 均改变 digest；test-side FFI replay 合成的重复 decoded name/canonical path 在内容访问前拒绝，受影响 inode 零读取。
    - 文件首个 64 KiB chunk 后截断/增长/metadata 漂移拒绝；active appender 存活期间仍按首次 descriptor size 有界收敛为 `WorkspacePathSafetyError`。
    - `npx --yes bun@1.2.19 run test:core-services`；`npx --yes bun@1.2.19 run typecheck`；`npx --yes bun@1.2.19 run check`；`npx --yes openspec validate m2-research-context --strict --no-interactive`；`git diff --check`；`git -C zero diff --quiet`；`test -z "$(git ls-files workspace)"`；`git diff --exit-code origin/main -- package.json packages/*/package.json bun.lock`。

## 4. stack-lock

- [x] 4.1 采集服务：submodule gitlink 只读发现（四 repo commit/branch，W2-SUB-001）+ renv.lock 内容哈希（缺失 → null + `renv_lock_missing` 降级）+ runtime 版本占位 + harness 块占位口径（version=根 package.json，cli_version/prompt_pack/skills_version=占位常量，design D7a）+ llm 块从 provider 配置读取 provider/model_id/base_url、params_digest/prompt_pack_digest 按 D7a 语义分别计算（依赖: 2.1、3.1。验证: zero commit == pin 断言；harness 占位断言；两 digest 确定且互不相同；api key 值零出现）
  - Fixture (#91): expanded / high；public core service、固定 Git 子进程、repository/config 文件读取、credential-adjacent provider projection、四 submodule/zero 复现证据触发 mandatory expanded；完整 fixture 与执行偏离见 `evidence/issue-91.md`。
  - Invariant Matrix (#91): authority = superproject `HEAD` gitlinks + root package/provider config + optional `renv.lock` bytes；producers = fixed `git ls-tree`/bounded readers/shared `hashFile`；validators = exact inventory/path/type/count、provider/model/base URL、StackLock content projection；storage = none；failure = typed non-disclosing error and zero partial output；consumer = future 4.2/4.3 only。
  - Risk packs (#91): Public API、Config、File IO/path、Schema/fields、Auth/secrets、Concurrency/read consistency、Resource bounds、Legacy compatibility、Error handling、Release/packaging、Documentation and all three SHUD domain packs selected；逐包理由、non-goals 与 evidence mapping 见 issue fixture。
  - Boundary-surface checklist (#91): only new collector/test/barrel plus OpenSpec evidence；consume but do not modify StackLock schema、hashing、path safety、durable reader、provider config、package/lock、routes、record store or submodules；zero write/delete/overwrite/persist surface。
  - Evidence floor (#91): exact injected Git args + malformed inventory；real four-gitlink/zero-pin and HEAD/status no-mutation guard；missing/existing/change-sensitive/symlink renv；harness/provider/digest oracles；API-key/path non-disclosure；source-bound red proof；`test:core-services`、`typecheck`、`check`、`schema:check`、`test:perf:api`、strict OpenSpec、diff/package/lock/submodule/workspace hygiene。
- [ ] 4.2 StackLock 组装 + 内容域 canonical fingerprint（计算域 = repos/runtime/harness/llm，排除 stack_id/created_at/fingerprint）+ 经既有 record store 权威持久化到 `workspace/stacks/`（依赖: 4.1。验证: 同环境两次组装不同 stack_id 同 fingerprint、改 llm.base_url 后 fingerprint 变化、目录树扩展幂等）
- [ ] 4.3 `POST /api/stacks/lock`（响应形态 `{ stack, degraded: string[] }`，degraded 不落盘）+ `GET /api/stacks/:stackId`（裸记录）路由与 envelope（404 负例；重复 lock 非幂等——两次调用各得独立记录、不同 stack_id 同 fingerprint、不受理 Idempotency-Key；响应无 secrets/绝对路径）（依赖: 1.1b、4.2。验证: `bun run test:backend-api`）

## 5. data-provenance

- [ ] 5.1 DataProvenance 服务：来源路径安全校验（含 `workspace/secrets/**` deny 子树拒绝）+ 文件/目录 sha256 + 只读纪律 + 持久化到 `workspace/provenance/`（`provenance/` 加入 `WORKSPACE_CANONICAL_DIRECTORIES` 并联动 ready 检查；目录裁决 design D4）（依赖: 1.1b、2.1、3.1。验证: register 前后来源字节一致断言 + secrets 路径拒绝负例）
- [ ] 5.2 `POST /api/data/register` + `GET /api/data/:dataId` 路由（独立输入 schema：basin/event_window/sources 描述字段必填，sha256 为服务端专属——输入含 sha256/output_sha256 → 422；重复提交非幂等各得独立 data_id；W2-DATA-001 存在路径成功 / W2-DATA-002 缺失路径 404/422 / 越界 422 / secrets 子树 422）（依赖: 1.1b、5.1。验证: `bun run test:backend-api`）

## 6. artifact-evidence

- [ ] 6.1 evidence_usable 七条规则引擎 + `llm_generated` 落盘值判定（update/升级路径读落盘值，不采信请求值）+ 升级 core 服务操作经 options bag 注入的 `auditSink` 写 `audit.evidence_upgrade` NDJSON 行（行 schema ts/level/service/event/actor/target_id/result + 默认 sink，交付物含 sink 定义，design D6；agent-403 deferred requirement 记录，M3+）（依赖: 1.1b、2.1。验证: W2-ART-001 + 七条正反例 + llm_generated 洗白负例 + audit 行断言）
- [ ] 6.2 群组 ArtifactManifest read/write 到 `workspace/artifacts/manifest-sets/`（design D4 目录裁决——`artifacts/manifests/` 已被 M1 单 artifact 记录占用；目录加入 `WORKSPACE_CANONICAL_DIRECTORIES`）+ `manifest_sha256` 复算 + 重生成新 id 且旧记录标记 `superseded_by`（W2-ART-002）（依赖: 2.1、6.1。验证: 复算一致 + 不可覆盖 + superseded 标记断言）
- [ ] 6.3 `GET /api/artifacts/:artifactId/data` skeleton（高风险面，独立）：按登记 path 服务、no-follow、无目录列举、`workspace/secrets/**` deny 子树（登记 422 / 服务 403）、404/410 envelope、range 留注记（依赖: 1.1b、6.1。验证: 穿越负例 + secrets 负例 + media_type 断言）

## 7. research-context-binding

- [ ] 7.1 TaskCard 绑定存在性校验：`POST /api/tasks` 可选 stack_id/data_id，悬空引用 422；stack_id/data_id 纳入 `taskCreateRequestDigest`（幂等适用清单不变，digest 覆盖新可选字段并复核 digest bounds——同 key 不同绑定 → 422 digest mismatch）（依赖: 1.1b、4.2、5.1。验证: exit-gate 正例 + 悬空负例 + 同 key 不同 stack_id 422 负例，M1 幂等回归绿）
- [ ] 7.2 前端 ResearchContext SideNav 折叠卡：StackLock 摘要（含 llm base_url）+ DataProvenance 摘要 + 未绑定空态；读取经 1.2 统一鉴权 fetch wrapper（依赖: 1.2、4.3、5.2、7.1。验证: W2 UI 细目 ×2，`bun run test:frontend`）
- [ ] 7.3 前端 ArtifactRef 组件（纯展示，props 由调用方传入，design D7）：id/类型/相对路径 + 复制交互 + 非证据视觉标记，组件不发起网络请求（依赖: 6.1。验证: W2 UI 细目"可点击/复制路径"组件测试）
- [ ] 7.4 前端 ExperimentHeader 完整化：title/status/绑定徽标随 activeTask 切换（依赖: 7.1。验证: 徽标随任务切换断言）

## 8. 验收门

- [ ] 8.1 W2 验收走查与留痕：exit gate（task 绑定 stack_id + data_id；SideNav 完整版本链含 base_url——浏览器走查在 1.2 token bootstrap 体制下执行；registry 记录 evidence_usable artifact）+ W2 五条集成细目 + 三条 UI 细目逐项核销，豁免项显式落档（依赖: 0–7 节全部。验证: 验收记录文档 + PERF-API-001 不回归）
