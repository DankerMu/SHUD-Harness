# Tasks

合入顺序按依赖而非组号，见 design.md「Migration Plan」：1.1a → 1.2 → 2.3 → 2.1 → 2.2a/b/c/d → 2.4 → 2.5 → 2.6 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 4.1 → 5.0 → 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 6.1 → 6.2a → 6.2b → 6.2c → 7.1a → 7.1b → 7.2 → 8.1。各任务写明的"依赖"是硬前置；组内未写依赖的切片只受上述顺序约束。fixture level 词表以 `subagent-workflow` 的 `issue-risk-contract.md` 为准。需求名一律引用 `specs/*/spec.md` 的 `### Requirement:` 原文。每步 `pnpm run check` 绿；6.2a 起 `profile:smoke` 绿；7.1b 后 `shud:replay` 绿。Stage 4 round 1 的修复映射见 `.workplans/m4-mvp-2/stage4-round1.md`。

## 1. 实现组之前的规范文档对齐（design D14、D15）

- [x] 1.1a `docs/03_SPEC/Minimal_Schemas.md` 全部受影响节：TaskCard（`type` 增 `code_change`、`linked_changes`/`linked_verifications`、`source_base_commit`）、StackLock（`build_id`）、RunJob/RunRecord（`build_id`/`threads`/`binary_sha256`）、DataProvenance（`sources.external_files`）、EvidenceReport（`change_ids`/`verification_ids`，注明报告字段名为 `verification_ids` 而非 Theory_to_Code 的 `verification_case_ids`）、§8 按 change-requests「ChangeRequest record」改写（品牌 id、`floor_categories`、删除无生产者字段）、新增 VerificationCase 与 BuildRecord 节（含 `patch_sha256`）；`Verification_Case_Spec.md` 增 "M4 实现范围" 节（`bundle_id` nullable、`id`→`vc_id`、`run_job_ids/run_record_ids`→base/candidate 两对引用、`target_equations` 不保留、只生产 regression/baseline_regression/passed|failed）；`Scientific_Change_Gating_Spec.md` §1.1 落点改为仓库内受测常量模块（规则 2/6 原文不动，注明"全部匹配取最大、未匹配 → numerical_implementation、产出 floor_categories"）、§2/§6/§7 增 M4 bundle 门免除、§4 增 M4 `change_submit` ask 与 patch 不符 deny 规则、§5 增 M4 批准无 comment 偏离；`Report_Generation_Spec.md` 的 `report_validate` 13 项改 15 项（含 (14) §5 固定句、(15) VC artifact 存在与哈希）；`Roles_and_Boundaries.md` §6（patch 形态、无 interface_impact、"worktree"→scratch workspace 内 `repos/SHUD` 本地 clone、coder 不得改治理目录）与 `Agent_Architecture.md` §4.4a（M4 以 PI 卡替代 bundle 三步路由）/§7（`code_change` 谓词按 task-cards「code_change closure predicate」措辞、review note → VerificationCase 字段）；`docs/adr/implemented/0002-*.md` 开放项 1 加注（M4 pin `9a422e5`，理由：重导出需 base 在切片前）；`Workspace_Conventions.md` 增 `repos/ changes/ patches/ verifications/ builds/` 与治理根写保护；`Phased_Plan.md` §4 验收门措辞对齐 known-answer-replay「Replay acceptance criteria」并把"worktree 内改代码"改为 scratch workspace 内 `repos/SHUD` 本地 clone（§4 唯一 owner）与 §6 记本轮跳过 `chore(dsh-upgrade)` 的理由；`Repository_Layout.md` 新目录与 `shud_run` 的 `build_id`/`threads` 参数说明（D15(3)）；`openspec/glossary.md` 增 BuildRecord、semantic level floor、floor_categories、base/known answer、治理根、`shud:replay`。不改 `CONTEXT.md`（两条不变量随 3.3 与 5.2 的伴生测试落地）。`pnpm run docs:check` 绿。
- [x] 1.2 依赖 1.1a。ADR-0011 从 `docs/adr/proposed/` 移至 `implemented/`，正文增"第二个消费者：M4 `change_submit` 的拒绝理由经对话承载"段；`pnpm run adr:check` 绿；PR 需 PI 确认（ADR 状态转换不由 agent 自批）。

- Suggested fixture level: none - 只读规范文档对齐与 ADR 状态迁移，无产品代码
- Minimal mergeable slice: 1.1a 首刀（规范与术语自洽可合，无代码依赖）；1.2 为后继（ADR 状态转换需 PI 确认，单独一刀便于 PI 审）

交付记录：1.1a 已由 #551 合并（#516 closed）；1.2 已由 #552 合并（#517 closed），PI 明确确认原文与日期登记在 ADR-0011；2.3 已由 #554 合并（#518 closed），三席白盒审查与同 SHA CI 通过；路由文档漂移 #553 已由 #555 独立合并。共享 change 保持未归档，阶段 PI 验收仍属于 8.1。

### Issue #518 risk and evidence fixture

本刀只执行 2.3；受保护 oracle 为 change-requests 的 Semantic level floor 场景和 engineering-gates 的常量漂移场景，不因实现方便改写。

- Public API / Schema / Auth-governance：七档顺序、所有命中类别并集、保守缺省与 risk 映射；测试 Model_Control 双命中、print.hpp 双命中、未知 README/Makefile、低风险 docs/scripts、参数输入和空数组拒绝。错误的 first-match 或 max-only categories 必须被拒绝。
- File IO / Documentation：常量投影只经现有生成器与安全写入 helper，固定落在既有 `docs/generated/schema/`，不把普通 JSON 值冒充 JSON Schema；ORDER/FLOORS/risk 直接消费 core 唯一来源。生成器自证覆盖变化敏感性；临时隔离副本以改常量不重生成触发真实 schema:check 非零，再生成并更新基准后恢复零。
- Legacy compatibility：全部既有对象 schema 的生成文件字节保持不变；完整 schema self-test/default check 与投影前后摘要对照。
- Config/setup、Concurrency/shared state、Resource/discovery、Error/rollback、Release/dependencies：不新增运行时配置、并发状态、遍历、重试/回滚或依赖；已有生成目录路径保护不可绕过。空输入拒绝属于公共纯函数契约。
- glob 边界：`*` 不跨 `/`，`**/` 可匹配零层或多层，字面 `.` 不作正则通配；输入来自已观测 POSIX 相对路径，不增加未要求的路径清洗/校验 API。
- 表序不敏感证明用隔离副本或隔离加载的表序变体，不原地修改共享冻结常量、不新增生产配置入口。
- 编排器 smoke：build 后经公开 core index 导入，以未知路径、双匹配路径与混合低/高类别运行并对照 oracle。单测绿不替代公开出口运行。
- Verification commands: focused vitest; `pnpm run test:schema-generation`; `pnpm run schema:generate`; real drift-negative/restoration; `pnpm run check`; built public API smoke; CI.
- 语义负例补充：`print.hpp` 必须返回 output_semantics/physical_equation 两项；docs/x.md + README.md 必须保留 pure_engineering/默认 numerical_implementation；docs/x.md + Model_Control.cpp 必须保留三档排序并集。risk 对七个级别逐一断言。
- glob 正反例：input/x.para 与 input/a/b/x.para 均 parameter_default；src/IO.cpp 与 src/a/b/IO.cpp 均 io_format；src/IOdir/file.cpp 不得匹配 IO*、应为默认 numerical_implementation；src/classes/Model_ControlXcpp 不得获得 output_semantics。
- 公共常量/类型契约用临时 smoke 独立检查七档 ORDER、十一条 FLOORS 与 SemanticLevel 可导入性；永久测试保留消费可见的派生/风险行为，不新增逐字复制常量或导出接线的同义反复测试。focused command: `pnpm exec vitest run packages/dsh-shud-core/src/governance/semantic-level-floor.test.ts`；built smoke 从 `packages/dsh-shud-core/lib/index.js` 导入。

### Issue #519 risk and evidence fixture

本刀只执行 2.1。三份 record requirement 的字段与场景为不可弱化的 oracle；跨文件/磁盘/TaskCard 身份核对属于后继生产者，不在纯 schema 中伪造 IO。

- Public API / Schema：扩展现有 branded-id 注册与公开出口；三个新 schema 均 strict，nested observed 亦拒绝未知键。测试三品牌合法生成、旧格式/大写 hex/错前缀/路径穿越拒绝；不改现有品牌行为或既有测试期望。
- Auth/governance：CR 直接使用 ORDER 和 riskForLevel；proposed/approved 双向审批字段一致、level ≥ floor、risk 取 semantic_level；五种非法 categories 与抬升级别正例。错误分别指向 semantic_level、risk、floor_categories、approval_ref/approved_at。
- CR 边界：files_changed 非空、码点排序唯一；路径复用 isRelativePosixPath，含绝对/父穿越/NUL负例及非BMP排序正反例；source_path 固定 repos/SHUD，patch_path 必须与本 change_id 精确绑定；40/64 小写 hex、ISO 时间、严格字段集及 legacy 字段拒绝。
- VC 边界：保留八种 case_type、五种 expected_result_source（含 agent_proposed）、六态 status；passed 等 sha/null reason，failed 不等 sha/非空 reason；hash 不一致指出 status，reason 不一致指出 failure_reason。artifact_refs 恰两项相对路径，notes 至少一条且每条非空；bundle_id 为非空或null；nested observed 严格且两 digest 为64位小写hex、compared_path相对。不凭空增加其他状态谓词、数组排序唯一或磁盘存在性检查。
- BR 边界：base 的 change_id/patch_sha256 为null且 dirty_paths为空；candidate 三者全非空。分别测试两向不一致；dirty_paths复用相对路径和码点排序唯一规则；binary/stdout/stderr路径分别绑定本build_id；source_path固定、source_commit40hex、binary_sha25664hex、exit_code0、duration非负、make_argv非空字符串数组、sundials_dir绝对路径。
- File IO/path safety：仅纯路径字段约束及已有生成器安全写入；不新增文件读取/创建接口。保留生成路径祖先/符号链接保护和registry completeness自证。
- Legacy compatibility / Documentation：登记三组合法 exampleOverrides（proposed CR、passed VC、base BR），生成三组Markdown+JSON Schema；已有25份生成物（含floor投影）字节不变；新schema与旧对象解析及生成自证共跑，不改旧golden/期望。
- Config/setup、Concurrency/shared state、Resource/discovery、Error/rollback、Release/dependencies：无新增配置、共享运行状态、文件发现、发布事务、依赖；仅schema解析错误与生成器原有失败边界，明确非目标。
- RED/GREEN：先由编排器运行focused新测试得到缺实现RED（只证明接线），实现后通过；另外用隔离负控移除CR审批一致性、VC结果一致性、BR三字段关联中的对应约束，合法向量先绿、非法向量在变体中被错误接受导致断言红，恢复原版绿；不改受保护测试/源表来清闸。
- 命令：四个focused schema/brand测试文件 → `pnpm run schema:generate` / `pnpm run test:schema-generation` → built core index smoke（有效/无效CR、VC、BR及CHG/VC/BUILD生成）→ `pnpm run check` → 三席review与同SHA CI。生成新文件先加入索引再跑schema:check；变更生成物全部来自生成器。

## 2. core：floor 常量、三对象 schema、品牌 id、角色映射、措辞常量、git runner（Critical Path #1/#7）

- [x] 2.3 `governance/semantic-level-floor.ts`：`SEMANTIC_LEVEL_ORDER`、`SEMANTIC_LEVEL_FLOORS`（Gating §1.1 初值，去 `SHUD/` 前缀）、`deriveSemanticFloor(paths): {floor, categories}`（每路径取全部匹配条目 floor 的最大值，无匹配 → `numerical_implementation`）、`riskForLevel`；正反例：`Makefile`+`src/Model/*` → numerical_implementation、`README.md` → numerical_implementation、`docs/x.md` → pure_engineering、`src/classes/Model_Control.cpp` 双匹配取最大且 categories 含两者、risk 映射；投影到 `docs/generated/`。按 change-requests「Semantic level floor」。无依赖。
- [ ] 2.1 依赖 2.3。新增 `ChangeId`/`VerificationId`/`BuildId` 品牌 id（复用 `run-identifiers.ts`）与 `change-request.ts`（含 `floor_categories`、`risk == riskForLevel` refine）、`verification-case.ts`、`build-record.ts`（含 `patch_sha256` iff `change_id`、40 hex `source_commit`）严格 schema（字段与 refine 按 change-requests「ChangeRequest record」、verification-cases「VerificationCase record」、shud-build「BuildRecord record」）；正反例测试；`pnpm run schema:generate` 投影；`index.ts` 导出。
- [ ] 2.2a 依赖 2.1。`TaskTypeSchema` 增 `code_change`；TaskCard 增 `linked_changes`/`linked_verifications`（`default([])`，排序唯一）与 `source_base_commit`（40 hex 或 null，缺键按 null；refine `code_change` ⇒ 非 null、其它 ⇒ null）；M3 卡片夹具原样可读回归；投影更新。按 task-cards「TaskCard record」「TaskCard generated projection」。
- [ ] 2.2b 依赖 2.1。StackLock 增 nullable `build_id`（非 null 时纳入 `computeStackFingerprint`，null 时指纹与 M3 逐字节相同、旧 lock 仍可复用）；固定向量测试；投影。按 stack-lock「StackLock schema alignment」「Stack fingerprint」。
- [ ] 2.2c 依赖 2.1。RunJob/RunRecord 增 nullable `build_id`/`threads`（正整数）/`binary_sha256`（缺键按 null；iff `build_id` 的 refine 在默认值之后求值）；M2/M3 夹具原样可读回归；投影。按 run-records「RunJob record」「RunRecord record」「Generated projection」。
- [ ] 2.2d DataProvenance 增 `sources.external_files`（`{path(绝对), sha256, size_bytes}` 数组，缺键按 `[]`）；M3 夹具回归；投影。按 data-provenance「DataProvenance record」「DataProvenance generated projection」。无依赖。
- [ ] 2.4 `role-tool-map.ts` 四角色真实 id（coordinator `local` 三委派工具；coder/reviewer/repo_explorer `inherited` 按 agent-presets「Role tool map uses mounted names」）；删除 `harness.memory.propose`、`patch.apply`、`validator.run`、`repo.*`、`git.inspect`；`readCallerPresetId` 映射增 coder/reviewer（policy-gate「Caller role derivation」）；`ROLE_TOOL_IDS` 并集测试；policy-gate-core `role-tool-surface` 表随之更新并附四角色 × 新工具的 deny 正反例（policy-gate「Role tool surface rule」）。无依赖。
- [ ] 2.5 `governance/wording.ts` 导出 `code_change` §5 固定句常量，正反例测试（逐字、不进扫描短语集）；按 evidence-reports「code_change report wording constant」、engineering-gates「Scientific wording rules are enforced by tested constants」。无依赖。
- [ ] 2.6 `stack-lock/repository-revision.ts` 扩展导出受控 git runner（env 白名单 `PATH/HOME/LC_ALL=C/GIT_OPTIONAL_LOCKS=0/GIT_CONFIG_NOSYSTEM=1/GIT_CONFIG_GLOBAL=/dev/null/GIT_TERMINAL_PROMPT=0`、`-c core.fsmonitor=false`、realpath == `rev-parse --show-toplevel` 校验、status `-z`、diff `--no-ext-diff --no-textconv --no-color`）；既有 `collectRepositoryRevision` 行为与 StackLock 采集字节不变的回归；子进程看不到 `DMXAPI_KEY` 的断言。按 change-requests「Source change observation」、shud-build「Workspace source checkout validation」。无依赖。

- Suggested fixture level: expanded - 共享 schema 单源、生成投影、分级常量、策略门决策表与受控子进程（Critical Path #1/#7）
- Minimal mergeable slice: 2.3 首刀（无依赖、无消费者）；2.1 依赖 2.3；2.2a–d 依赖 2.1（2.2d 可独立）且彼此独立；2.4、2.5、2.6 各自独立于其它切片

## 3. records：文件层、观测/派生、closure、provenance、StackLock、报告模板、比较器

- [ ] 3.1 依赖 2.1。三对象文件层：`changes/`、`patches/`、`verifications/` 原子写（排他创建、EEXIST 重分配 id ≤3 次）与读取校验，`builds/<id>/` 临时目录（排他 `mkdir`）rename 发布与消费者 sha256 校验（change-requests「ChangeRequest workspace files」、verification-cases「VerificationCase workspace files」、shud-build「Build workspace files」、task-cards「TaskCard workspace file」扩展的 id/目录/排他创建与目录级 rename 例外）；路径安全复用 `workspace-paths.ts`；符号链接/非目录 fail-closed 正反例。
- [ ] 3.2 依赖 2.3、2.6、3.1。`observeSourceChanges(sourceDir)`（经 2.6 runner：porcelain `-z` 解析、忽略路径不计、untracked/删除/重命名拒绝、realpath ≠ toplevel 拒绝）与 ChangeRequest 生成纯函数（floor/categories 派生、申报抬升、patch 固定命令、sha256、`base_commit` 40 hex）；以真实临时 git 仓库测试（change-requests「Source change observation」）。
- [ ] 3.3 依赖 2.2a、3.1。`code_change` 状态进入（`change_create` → running/running_local）与 `codeChangeClosure(card, loaders)` 六子句（0 输入非空、1 approved CR 属本卡且 patch sha 匹配、2 终态 VC 属本卡且其两个 run 的 RunJob ∈ `linked_jobs`、3/4 schema 保证、5 既有运行子句）正反例，不合格对象按不可读处理；`task-closure.ts` 分派按 `type`；`CONTEXT.md` 增"code_change closure 不以 LLM 为据"不变量并指向本测试（task-cards「code_change state entry」「code_change closure predicate」）。
- [ ] 3.4 依赖 2.2d。`generateProvenance` 解析 `<project>.tsd.forc` 第 2 行与 Filename 列，副本内无外部文件、副本外逐一哈希为 `external_files`，缺失/非普通文件/解析失败抛错（data-provenance「Provenance generation at submission」）；ccw（得 `[]`）与构造的绝对 forcing 两类夹具。
- [ ] 3.5 依赖 2.2b。`captureStackLock` 接受可选 build 源：`repos.SHUD` 取 BuildRecord 源修订（`dirty_paths` 原样、`dirty_paths_truncated: false`）、`build_id` 写入并进指纹；无 build 时逐字节不变的回归（stack-lock「Deterministic capture at shud_run submission」）。
- [ ] 3.6 依赖 2.5、3.3。报告：`.json` 增 `change_ids`/`verification_ids`（`default([])`）与生成投影；`.md` 事实表增 ChangeRequest 段（含 `floor_categories`）、VerificationCase 段、BuildRecord 段，StackLock 表增 `build_id`；§5 由 2.5 常量逐字渲染；§7 列 failed VC；golden 更新只限新增段；M3 报告渲染字节不变回归（evidence-reports「EvidenceReport record」「Deterministic facts table」「Report template」「EvidenceReport generated projection」「code_change report wording constant」）。
- [ ] 3.7 依赖 2.1。`compareRivqdown(baseRunDir, candidateRunDir, project)`：`lstat` 普通文件、sha256、`equal`；缺失/链接/特殊文件抛错；相同/不同/缺失正反例（verification-cases「Rivqdown comparator」）。

- Suggested fixture level: expanded - 持久化文件格式与路径安全、分级派生、closure 谓词、报告措辞护栏（Critical Path #6/#7）
- Minimal mergeable slice: 3.1 首刀（文件层无消费者，可独立保绿）；3.2、3.3 依赖 3.1 且彼此独立；3.4、3.5、3.7 只依赖 core、互不依赖、可并行；3.6 依赖 3.3

## 4. jobs：提交消费 build 与线程环境（Critical Path #4 局部）

- [ ] 4.1 依赖 3.1、3.4、3.5。`submitShud` 请求增 `build_id`/`threads`：输入复制之后、StackLock 采集之前解析 `builds/<build_id>/build-record.json`（schema、`task_id` 相容）、校验二进制 sha256、原子复制为 `<run_dir>/bin/shud` 并让包装进程执行该副本、RunJob 写入 `binary_sha256`；`threads` 为包装进程追加 `OMP_NUM_THREADS`/`SHUD_RHS_THREADS`；RunJob 写入两字段、collect 原样继承；StackLock 采集传 build 源；provenance 含 `external_files`；任一失败走既有回滚不留运行目录；无 `build_id` 的执行与二进制选择逐字节不变（shud-run-jobs「Shud job submission」「Build-referenced execution」「Detached execution and exit capture」、run-records「RunJob record」）。集成测试覆盖 tampered binary、缺记录、threads 环境可见（包装脚本回显 env）、外部 forcing 缺失回滚、ccw 提交得 `external_files: []`。

- Suggested fixture level: expanded - 提交事务、回滚与持久化文件、包装进程环境（Critical Path #4）
- Minimal mergeable slice: atomic - build 解析、二进制复制与替换、threads 环境、RunJob 字段与 provenance 外部文件在同一提交事务内，拆开会留下"记录 build_id 但仍跑 shudBin"或"threads 落盘但未设环境"的中间态

## 5. raw-guard、tools 与 policy-gate：治理根写保护、四个新工具、`shud_run` 扩参、报告入口（Critical Path #2/#3）

- [ ] 5.0 raw-guard 治理根写保护：固定九根 `tasks stacks provenance reports runs changes patches verifications builds`；`write`/`edit`/`str_replace_editor` 目标在内 → deny `governance-immutable`；`bash`/`pwsh` 触及且按既有写 denylist 判写 → deny，只读触及 → next；与角色/`sandbox_permissions` 无关；raw 判定优先；路径身份复用既有规则；决策审计。矩阵测试：九根 × 存在/不存在 × 符号链接别名 × 写/读命令 × 四角色与 unknown（raw-data-guard「Governance roots are write-protected from model file and shell tools」）。无依赖；必须先于 6.2a 合入。Critical Path #2：reviewer 白盒审查记录 + 测试证据贴 PR。
- [ ] 5.1 依赖 2.2a、2.6、3.2、3.3。`task_create` 的 `type` 接受 `code_change` 并钉定 `repos/SHUD` HEAD 为 `source_base_commit`（检出缺失/不合法拒绝；`science_assist` 不访问 `repos/`）；`change_create`（闭合 schema、固定源目录、三目录预检、HEAD == `source_base_commit`、观测→派生→写 CR/patch→回写卡，失败保留已写文件；change-requests「change_create」、task-cards「task_create」「TaskCard links」）；raw-guard 为 `change_create` 判定 `changes`/`patches` 根、确切 task 目标与 `repos/SHUD` 为 raw 时 deny（raw-data-guard「Change, build and verification tools protect their fixed output roots」）；工具挂载按 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」；真实 ToolRuntime + 临时 git 仓库矩阵（申报抬升/高于 floor/planned→running/类型错误/无改动/untracked/HEAD 偏离）。
- [ ] 5.2 依赖 2.6、3.1、5.1。`shud_build`（检出校验含 HEAD 钉定与 realpath == toplevel、CR 可选契约与 patch sha 校验、`git archive` + `ls-tree` 一致性断言 + `git apply`（`GIT_CEILING_DIRECTORIES`，apply 后断言生效）到 `builds/.tmp-<id>/src/`、`make` 白名单环境与同步执行、`print-cxx.mk` 采 compiler、临时目录 rename、失败清理、`repos/SHUD` 零写入；shud-build「Workspace source checkout validation」「shud_build」「Build workspace files」）；以真实临时 git 仓库 + 假 `Makefile` 行使，含被忽略源文件不进入构建、工作树陈旧 `shud` 不被发布；raw-guard 为 `builds` 根与 `repos/SHUD` 为 raw 时 deny；工具挂载按 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」；`CONTEXT.md` 增"候选二进制 ⇔ 钉定 commit + 已批 patch"不变量并指向本测试。
- [ ] 5.3 依赖 2.4、5.1。policy-gate 增 `change_submit` 规则（高风险 ask / 低风险 next / 文件缺失仍 ask / patch sha 不符 deny `change-patch-mismatch` / displayReason 含 `floor_categories` / reason 前缀常量 / 审计 code `change-approval` 只含 change_id 与 level / danger-full-access 仍 ask；policy-gate「change_submit asks for high-risk change requests」「M4 approval comment deviation」「Global pre-execute mounting」「Policy core deny layer」「Policy decision audit」「Host fail-closed approval outcome」）与 `change_submit` 工具（patch sha 复核、proposed→approved、approval_ref = exec.callId、重复/状态错误拒绝；change-requests「change_submit」）同一切片落地，真实 ToolRuntime + policy-gate 集成：allowed-once 执行、rejected/cancelled/unavailable 不执行且 CR 字节不变；raw-guard 为 `change_submit` 判定确切 `changes/<change_id>.json` 目标；工具挂载按 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」。Critical Path #3：reviewer 白盒审查记录 + 测试证据贴 PR。
- [ ] 5.4 依赖 4.1。`shud_run` 增 `build_id`/`threads` 参数（闭合 schema；`threads: 0`、非整数、未知 `build_id`、sha 不匹配拒绝不建目录；shud-run-tools「shud_run arguments」）；回放不传 `end_days` 的 keliya 结构夹具（START/END 保留）。
- [ ] 5.5 依赖 3.1、3.3、3.7、5.4。`verification_run`（交叉校验矩阵：角色、卡类型与状态、两运行只读 collect 终态/同 task/同 project/`job_id ∈ linked_jobs`、候选 build 的 approved CR、base build null CR 且 `rhs_openmp: false`、两 build `source_commit == source_base_commit`、`threads: 1`、RunJob `binary_sha256` 与 BuildRecord 一致、provenance 集合相等、`reviewer_notes` 禁止用语拒绝；比较器 passed/failed/缺证据错误；`artifact_refs` 相对 cwd；写 VC 与回写卡；verification-cases「verification_run」）；raw-guard 为 `verifications` 根与确切 task 目标判定；工具挂载按 shud-run-tools「Report and task tools are mounted by dsh-shud-tools」。
- [ ] 5.6 依赖 3.6、5.5。`report_generate` 对 `code_change` 卡求 closure 并写 `change_ids`/`verification_ids`；`report_validate` 15 项：(8) failed VC 在 §7、(14) §5 固定句、(15) VC `artifact_refs` 存在且哈希一致，`CHG-/VC-/BUILD-` 引用存在性（evidence-reports「report_validate」「Citation existence check」）；`report_submit`/`report_decide` 不变的回归；真实工具 smoke 用构造的 approved CR + passed VC 产出报告并通过校验（evidence-reports「report_generate」）。

- Suggested fixture level: expanded - 模型可见工具契约、审批 seam 结果处理、原始数据保护与工作区写入（Critical Path #2/#3）
- Minimal mergeable slice: 5.0 首刀（raw-guard 独立包，无工具依赖，必须先于 coder preset）；5.1 依赖 core/records 可独立保绿；5.2 与 5.3 均依赖 5.1、彼此独立；5.4 只依赖 4.1；5.5 依赖 5.4；5.6 依赖 5.5

## 6. presets 与 profile：coder/reviewer、三条委派行、restrict 与 headless

- [ ] 6.1 依赖 2.4。`prompts/{coder,reviewer}.md`、`coordinator.md` 新增 code_change 流程段与 `worker.md` 的 build_id/threads 提交段（agent-presets「Preset system prompts」「code_change orchestration」）；wording 漂移测试覆盖三份 prompt；restrict 按四角色 `inherited` 绑定（agent-presets「Role tool surface restriction」）；未被 profile 引用时可独立保绿。
- [ ] 6.2a 依赖 6.1、5.0。bundle：`preset-coder`、`preset-reviewer` 行与子树、coordinator 三条 `tool-subagent` 行（id/toolName/agentPreset 互异）、worker 不变（agent-presets「Coordinator and worker preset rows」「Preset plugin subtrees」）；`profile:smoke` 断言四 preset、三委派行、宿主 subagent/provider 各一次（shud-profile「Profile composition」「Local profile smoke」、agent-presets「Profile smoke covers presets」）。**首条断言**为 dump-config 三委派行且 `toolName` 互异；若宿主拒绝同包三行，按 Seam-only 报告偏差并停止（design D11/O4）。
- [ ] 6.2b 依赖 6.2a。`profile-patch.ts` headless 禁用四个 preset 行（扩展既有两行逻辑，原子发布不变；shud-profile「Idempotent profile installation」）；`profile:smoke` 断言 headless 四行禁用。
- [ ] 6.2c 依赖 6.2b、5.2、5.3、5.5。真实 Web session log 证明四角色 header 与 coordinator `header.tools` 含三委派工具、coder/reviewer 的 `header.tools` 为各自 inherited（agent-presets「Role tool surface restriction」）；`instructions/agents/shared.md` 的 Runtime Lifecycle 段（四 preset、三委派、headless 四行、治理根写保护）同步并 `pnpm run instructions:render`，CI 比对无漂移。

- Suggested fixture level: expanded - 生产 profile 配置、安装器写入、角色工具面（Critical Path #1）
- Minimal mergeable slice: 6.1 首刀（prompt 与 restrict 映射未被 profile 引用时可独立保绿）；6.2a 依赖 6.1 与 5.0；6.2b 依赖 6.2a；6.2c 为后继且依赖全部新工具

## 7. 回放脚本、工作区准备与控制面登记

- [ ] 7.1a `scripts/runtime/shud-replay-prepare.sh`（clone + `checkout --detach 9a422e5`、全 sha 与 `--absolute-git-dir` 断言、keliya 副本两项改写、`PREPARED.json`、已存在不覆盖、根 submodule git dir（`git -C SHUD rev-parse --absolute-git-dir`）文件清单不变断言；known-answer-replay「Replay workspace preparation」）与其单测（构造的 keliya 夹具、缺来源/已存在失败）。无运行时依赖。
- [ ] 7.1b 依赖 5.6、6.2c、7.1a。`shud-replay.sh`/`shud-replay.ts`（前置检查、独立 Web profile、单提示、恰两次自动 Allow once、等待、判据与退出码；known-answer-replay「Replay local acceptance script」「Replay acceptance criteria」）；`package.json` 增 `shud:replay` 入口；复用 `shud-web-driver.ts` 与首任务脚本的会话驱动；判据求值的单测（构造的工作区与 session log 夹具，含缺 `-fopenmp` 证据、第三次审批、VC failed 三个反例）；本机一次真实运行记录到 PR。
- [ ] 7.2 依赖 7.1b。控制面登记：Testing_Strategy Verification Matrix 行、Test_Fixtures_And_Command_Matrix keliya 回放夹具、`constraints.yaml` 本机闸清单、`instructions/agents/shared.md` Verification Matrix 行并 `instructions:render`（known-answer-replay「Replay gate registration」、engineering-gates「Replay local gate is registered」「New core objects participate in schema drift gate」）。不改 Phased_Plan（owner 为 1.1a）。

- Suggested fixture level: compact - 本机脚本与控制面文档，运行时行为由前组覆盖
- Minimal mergeable slice: 7.1a 首刀（纯脚本与单测，可独立保绿）；7.1b 依赖全部工具切片；7.2 为后继

## 8. Epic 收口：PI 功能验收

- [ ] 8.1 依赖 7.2。PI 在 Web 亲自完成一次回放（CR 卡与报告卡各至少一次操作），证据记 `docs/Migration_Plan_dsh.md`；新决策记录 `docs/adr/proposed/00NN-m4-epic-acceptance.md`（沿 ADR-0010 模式，PI 通过后转 implemented）；`shud:replay` 自动审批与子 PR 合并不表述为 PI 验收；bitwise 一致不表述为并行正确性/性能/模型改进（known-answer-replay「Epic-close PI acceptance for replay」）。

- Suggested fixture level: none - 手工验收记录
- Minimal mergeable slice: atomic - 一次完整验收与其证据记录
