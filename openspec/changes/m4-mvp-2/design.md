# Design

## Context

动机见 proposal.md「Why」。本 change 只在钉版 `dsh-v0.2.1-rc.2` 的既有 seam 上扩展，不开新 seam；以下事实均已核查：

- dsh seam：`tools/pre-execute` waterfall（`allow|deny|cancel|ask`，宿主 fail-closed）、`approval/asked|decided` log-only 审计且无 comment 字段、`ctx.subagents.spawn` 支持独立 `agentPreset`（`tool-subagent` 行每行固定一个 preset）、`ctx.sandbox` workspace-write、`agent.ctx.tools.restrict`。响应 model 仍只能取 configured。#511 后三种文件权限模式（read-only / workspace-write / danger-full-access）都保持 approval ask，文件权限与业务审批分离。
- M3 机制复用：工作区文件原子写与路径安全（task-cards「TaskCard workspace file」）、品牌 id 生成器、`readCallerPresetId` 当前投影、`role-tool-map` 的 `{inherited, local}`、policy-gate 的 deny→ask 瀑布与 `displayReason`、`report_generate`→`report_submit` 的"先生成对象再对已有 id ask"模式、`captureStackLock`/`generateProvenance`、`submitShud` 的输入复制与回滚边界、raw-guard 对文件工具与 bash 写动词的判定与路径身份规则、core `stack-lock/repository-revision.ts` 的受控 git 调用（`GIT_OPTIONAL_LOCKS=0`、`core.fsmonitor=false`、`-z`）。
- 代码现状：`TaskTypeSchema` 为 `engineering|science_assist|ops`；`task-closure.ts:85` 只支持 `science_assist`；`role-tool-map.ts:29-43` 三行为 Zero id 并含 `harness.memory.propose`；`profile/shud/cordis.patch.yml:85-91` 单条 `tool-subagent` 固定 worker；`shud-jobs` 配置已含可选 `sundialsRoot`；`shud_run` 只改副本 END（`shud-end.ts`）；无 ChangeRequest/VerificationCase/BuildRecord schema，无构建步骤。M3 没有任何角色拥有 `edit`/`bash`：工作区治理文件（`tasks/ reports/ …`）只被工具写过。
- SHUD base `9a422e5`（全 sha `9a422e5eb708df7d2f8b4066a3083a031d679a82`，P1e 内、`226e3ab` 的父）：`MD_rhs_core.cpp:776-807` 的 `rhs_core` 在 `SHUD_ENABLE_OPENMP_RHS` 下 StrictOMP/ProductionOMP 为 `std::abort()` 桩，`f.cpp` 永远传 `ExecPolicy::Serial`；Makefile `BUILDDIR = .`，`SRC` 用 shell glob `src/{classes,ModelData,Model,Equations}/*.cpp`，`make shud SHUD_ENABLE_OPENMP_RHS=1` 只加 `-D` 不加 `-fopenmp`（仅 `shud_omp`/`SHUD_USE_OPENMP_NVECTOR=1` 接 libomp）；`shud` 不是 phony 目标；`.gitignore` 忽略 `shud`、`shud.*`、`output`——因此 `src/Model/shud.x.cpp` 这类被忽略的文件对 `git status` 不可见却会被 glob 编译；线程数来自 `cfg.para` 的 `NUM_OPENMP`（`shud.cpp:132`）。上游 PR-G `85c8215` 为 mode C 接 `-fopenmp` 并加 `SHUD_RHS_THREADS` 环境变量（Makefile、`Macros.hpp`、`shud.cpp`、`MD_rhs_core.cpp`），其 keliya N=1 的 rivqdown SHA 与 mode A 相同。
- keliya（`../openMP/SHUD/Basins/keliya/`）：484 单元；`input/keliya/keliya.cfg.para` `NUM_OPENMP 8`、`START 12053`、`END 12143`；`keliya.tsd.forc` 第 1 行 `32 19510101`、第 2 行为机器绝对路径指向完整 `forcing/`（228 MB），表格引用 32 个文件；`forcing.trimmed/`（1.1 MB，34 项，其中 32 项被引用）覆盖该窗口；输出 `output/keliya.out/keliya.rivqdown.dat` 是 P1e AC-S2 的判据文件。ccw 的 `tsd.forc` 第 2 行是 `./input/ccw/`（运行目录内）。
- Harness 根 submodule `SHUD` 在 `3aec657`，对象库含 `9a422e5`/`226e3ab`/`85c8215`（在 `origin/openmp-baseline`），但它们不是 `3aec657` 的祖先。
- `docs/03_SPEC/Scientific_Change_Gating_Spec.md` §1.1 规则 2：三仓库内未登记 pattern 的路径 → 至少 `numerical_implementation`（宁高勿低）；规则 6：产出 `floor_categories`。Stage 1 曾误记为"未定义默认"，Stage 4 按规则 2 修正（用户裁决）。

Stage 1 grill 结论（`.workplans/m4-mvp-2/grill-gate.json`，25 分支 + 3 开放项）是本 design 的输入，逐条落在 Decisions 与 Non-Goals；Stage 3 以该凭证核对。Stage 4 round 1 的修复决策与 finding 映射在 `.workplans/m4-mvp-2/stage4-round1.md`。

## Goals / Non-Goals

**Goals:**
- 在 `dsh --profile shud` 的 Web 里：coordinator 建 `code_change` 卡（钉定 `repos/SHUD` 的 HEAD）→ 派 coder 在工作区 `repos/SHUD@9a422e5` 重导出 StrictOMP 切片 → `change_create` 落 ChangeRequest + patch → `change_submit` 弹 PI 审批卡 → 允许后 coder `shud_build` 两次（base：钉定 commit 的 `git archive`；candidate：同一 archive + 已批 patch）→ 派 worker `shud_run(build_id, threads: 1)` 跑 keliya 两次 → 派 reviewer `verification_run` 比较 rivqdown SHA256 并写 VerificationCase → coordinator 生成报告（含 CR/VC/Build 事实表）→ `report_submit` 审批。
- 分级、构建身份、比较判定、closure 全部确定性、零 LLM 裁量；coder 只能提高 semantic_level；候选二进制由 (钉定 commit, 已批 patch) 唯一决定，工作树与被忽略文件都不是构建输入。
- 模型的文件/shell 工具不能改写治理文件：`tasks/ stacks/ provenance/ reports/ runs/ changes/ patches/ verifications/ builds/` 对 `edit`/`write`/`bash` 的写入一律 deny（raw-guard 固定治理根）。
- 所有新行为在钉版 rc.2 seam 上，无 dsh 升级、无第三方新依赖；根 submodule 与 `data/raw` 不变。

**Non-Goals:**
- TheoryToCodeBundle、ImplementationMapping、NumericalSchemeSpec 及其对 `accepted_for_search` 的门（`VerificationCase.bundle_id` 在 M4 为 `null`，偏离登记见 D15）。
- 高风险 CR 批准的 PI comment 必填（Gating §5）：M4 以卡片 allowed-once 为批准、无 comment 通道，偏离登记见 D15；不新增 `change_decide`。
- Reviewer 的报告 (L) 三项语义判断（M3 Non-Goal，用户确认 M4 仍不做，开放项 O1）；repo_explorer preset（映射改真实 id，不建 preset、不消费）。
- 跨 N 决定论（P1e AC-S1）、性能/加速比、`NUM_OPENMP>1` 或 `threads>1` 的任何判定；mode D（OpenMP NVECTOR）。
- metrics / 水量平衡 / rSHUD 指标生产者与 `numerical_health`（#422，M5）；比较器只给 SHA 判定。
- `timed_out`、`max_wall_minutes`、`cost_budget` 超时终止（GAP-02）；TaskCard `parked`/`blocked` 自动产生者（开放项 O3）。
- coder 新增文件（untracked）进入 ChangeRequest：M4 切片只修改已跟踪文件，`change_create` 拒绝 untracked 非忽略路径。
- 多 CR 并行、CR 修订链、CR 的 `rejected` 持久状态：被拒 CR 保持 `proposed`，coder 改码后新建 CR。
- 通用"源检出"工具、`shud_run` 复制 forcing、把 keliya 纳入仓库 fixture、dsh 升级（PI 决定保持 rc.2）。
- `ctx.storage` 持久化、stateDir 索引、`builds/` 清理策略；多用户。
- 审批凭据与 session log 的交叉核对（workspace 外的审批账本）：用户选择治理根写保护 + patch sha 复核（D16），残余风险登记 D15。

## Decisions

### D1 三对象 schema、品牌 id 与工作区落点（Critical Path #7）

- core 新增 `change-request.ts`、`verification-case.ts`、`build-record.ts` 严格 Zod schema，品牌 id `ChangeId`（`CHG-YYYYMMDDTHHMMSS-xxxx`）、`VerificationId`（`VC-…`）、`BuildId`（`BUILD-…`），复用 `run-identifiers.ts` 的生成与校验；`Minimal_Schemas.md` §8 的 `CHG-NNNN` 随之修订（与 M3 对 TASK/REPORT 的处理同类）。
- ChangeRequest 字段：`change_id`、`task_id`、`source_path`（工作区内相对路径，M4 固定 `repos/SHUD`）、`base_commit`（40 位小写十六进制，等于卡的 `source_base_commit`）、`files_changed`（观测集，排序 POSIX 相对路径）、`semantic_level`（七档）、`semantic_floor`（派生值）、`floor_categories`（全部路径 floor 值的升序去重集合，Gating 规则 6）、`risk`（`low|medium|high`，由 level 映射：`pure_engineering`→low，`io_format`→medium，其余→high）、`patch_path`（`patches/<change_id>.patch`）、`patch_sha256`、`status`（`proposed|approved`）、`approval_ref`（approved 时为 `change_submit` 的 exec.callId，否则 null）、`approved_at`、`description`（coder 一行说明或 null）、`created_by`、`created_at`、`updated_at`。Minimal_Schemas 的 `interface_impact`/`compat_checks`/`gates`/`patch_bundle`/`theory_bundle_id`/`verification_case_ids`/`pi_gate_required` 不保留（无生产者的字段不保留，同 M3 StackLock 原则）；CR→VC 的关联由 VerificationCase 的 `change_id` 单向承载。
- VerificationCase 字段：`vc_id`、`task_id`、`change_id`（取自候选 BuildRecord，非参数）、`bundle_id`（`null`，M4 不生产）、`case_type`（M4 只生产 `regression`，schema 保留 spec 八种）、`expected_result_source`（M4 只生产 `baseline_regression`）、`target_code_targets`（= CR `files_changed`）、`description`、`expected_result`（固定文本）、`pass_criteria`（固定文本 `sha256(candidate rivqdown.dat) == sha256(base rivqdown.dat)`）、`base_run_id`、`candidate_run_id`、`base_build_id`、`candidate_build_id`、`artifact_refs`（两个相对会话 cwd 的 rivqdown 路径 `runs/<run_id>/output/<project>.out/<project>.rivqdown.dat`）、`observed`（`{base_sha256, candidate_sha256, compared_path}`）、`status`（`passed|failed`，M4 不生产其余四态，schema 保留枚举）、`failure_reason`（failed 时非空）、`reviewed_by`（reviewer 当前 preset 投影）、`reviewer_notes`（非空字符串数组，模型参数）、`compatibility_verdict`（`compatible|incompatible|unknown`，模型参数，M4 只是记录不裁决）、`created_at`。
- BuildRecord 字段：`build_id`、`task_id`、`change_id`（null = base 构建）、`patch_sha256`（null 当且仅当 `change_id` 为 null，否则等于 CR 的值：构建输入的第二个身份）、`source_path`、`source_commit`（40 位小写十六进制，等于卡的 `source_base_commit`）、`source_branch`、`dirty_paths`（构建时工作树观测）、`make_argv`（字符串数组）、`sundials_dir`、`rhs_openmp`（布尔，`SHUD_ENABLE_OPENMP_RHS=1`）、`compiler`（`<cxx> --version` 首行）、`exit_code`、`duration_seconds`、`binary_path`（`builds/<build_id>/shud`）、`binary_sha256`、`stdout_path`/`stderr_path`（`builds/<build_id>/make.{stdout,stderr}.log`，stdout 含 make 回显的编译命令）、`created_at`。失败的构建不留 `builds/<build_id>/`（临时目录构建成功后 rename 发布，见 D3）。
- TaskCard 新增 `source_base_commit`（40 hex 或 null；`code_change` 必非 null），见 D7。
- 落点：`<cwd>/changes/<change_id>.json`、`patches/<change_id>.patch`、`verifications/<vc_id>.json`、`builds/<build_id>/`；原子写、`lstat` 路径安全与 id 先校验后拼路径全部沿 task-cards「TaskCard workspace file」；新对象以排他创建落盘，id 碰撞时重新分配（≤3 次），不覆盖已有对象。不建索引：查找按 id 定位；TaskCard 的 `linked_changes`/`linked_verifications` 是 closure 的唯一入口（不扫描目录）。
- 备选 `ctx.storage`、保留 `CHG-NNNN` 顺序号、新增 ReviewNote 对象：grill 均否决（持久化/id/review note 三支）。

#### Issue #527 implementation boundary

Goal and ownership: extend the existing records file layer, not add a second store. The seven-kind table remains the identity/schema/layout authority; verification uses vc_id, not a synthesized verification_id. Existing task/stack/data/report reads, writes, allocation and readonly behavior remain unchanged. MutableWorkspaceRecordKind stays exactly task/data/report; untyped callers cannot use the generic overwrite API for new kinds.

Read contract: validate the branded id before path construction or IO, check managed ancestors and target using lstat, parse the existing core schema and always bind the embedded id for the three new kinds. Missing roots follow the existing readonly option; the published builds/<id> directory is never created by a read. BuildRecord metadata reads do not implicitly execute or scan; consumers explicitly use the shared binary-verification helper before accepting a build.

First-write protocol: createChangeRequest accepts a complete schema-valid candidate from the pure derivation layer, claims its first change_id/patch_path through exclusive publication, and reallocates/derives a replacement patch_path only after collision (#528 clean composition cutover). createVerificationCase still allocates vc_id from supplied fields. Both validate complete records before filesystem mutation and use one state-files exclusive byte-publication primitive: same-directory wx temporary file, write/fsync/close, link to the final name, remove owned temporary. Only a first-target collision permits reallocation, at most three after the first attempt. Unsafe paths fail closed instead of being treated as collisions. Each reallocation reconstructs schema-derived paths. A link-success followed by cleanup failure is already committed: preserve the final object and report its id, never allocate a duplicate.

Companion/update contract: writeChangePatch accepts a validated change id and bytes, binds the existing CR and checks patch_sha256 before exclusive publication; patch EEXIST returns an id-bearing error and preserves both existing patch and CR. The patch reader honors WorkspaceReadOptions exactly like the existing record reader: default/readonly:false creates a missing patches root, readonly:true never creates paths; neither mode repairs a missing patch. rewriteChangeRequest validates the existing record identity and requires it to exist, then uses the single state-files tmp+rename implementation; it is not an upsert or approval state machine.

Build publication API: publishBuildDirectory owns id allocation, exclusive .tmp-<id> reservation and final rename. Its explicit async producer receives the owned temporary path and selected BuildId, writes the binary/logs and returns schema-valid BuildRecord metadata for that same id and final paths. The file layer writes build-record.json directly inside the unpublished directory, without per-file tmp+rename. No make/archive/apply logic lives here. An occupied final path or temporary directory is checked before invoking the producer; successful retries never reuse or empty another producer's directory.

Directory ownership: retain physical parent and temporary directory dev/ino, recheck after producer awaits and before publication/cleanup; reject unsafe replacements. Recheck final absence immediately before the synchronous rename, including a target that appeared during populate. Failure removes only the still-owned temporary directory, preserves foreign replacements and any preexisting final target, and reports primary plus cleanup failure without raw payload leakage. Final rename is the commit point; never delete a committed directory as rollback.

Concurrency boundary: exclusive .tmp-<id> mkdir serializes same-id cooperating publishers; file link is an actual atomic no-clobber operation. Directory lstat plus rename is not rename-no-replace against arbitrary external writers between syscalls. This preserves the existing records trusted single-user namespace boundary (workspace-records synchronous publication contract and M3 design); no new cross-process hostile namespace transaction is promised. Tests cover cooperating contenders and controlled target/replacement injection during the producer await.

Binary consumer helper: verifyBuildBinary validates the supplied BuildRecord/id before IO, checks builds and the published id directory without creating them, lstat rejects links/special/non-executable shud, and descriptor-bound SHA256 must equal binary_sha256. Reuse one bounded-buffer hash implementation; close descriptors on success and all failures. Shared helper consumption is wired only by later jobs/tools issues, not by StackLock capture here.

Executable means the current process can execute the ordinary file, not merely that some execute bit is set: an owned mode-0641 file has an execute bit but fails X_OK for its non-root owner. Check effective X_OK after safe path/type validation as well as mode bits; test access-denied cleanup and the real OS permission distinction without executing the fixture or skipping root environments.

Error/API compatibility: retain the existing WorkspaceRecordStage union so report-inputs narrowing is not silently broken; collisions must nevertheless explicitly identify the validated id and collision reason. No arbitrary payload/cause is exposed through model-facing errors. New APIs are exported once from records; no core or generated changes.

Verification/containment: real filesystem suites cover read/identity/path rejection, four-candidate allocation, atomic visibility/no-clobber, patch mismatch/collision, update-only CR, build ownership/publish/failure cleanup and binary tampering. Freeze old M3 records for built readback with unchanged bytes/mtime. Built public-API smoke creates/reads/rewrites new records, publishes an executable fixture build and rejects a flipped byte; it is file-layer proof, not a SHUD build or PI acceptance. Until downstream wiring these APIs have no host seam effect; rollback is the normal PR revert, never a parallel store or alias.

#### Routed issue #597 implementation boundary

Origin and scope: #541's physical-parent fixture fails before artifact validation because shared records owners lexically join trusted cwd. The independent built readonly oracle qualifies two same-id reports and observes the lexical decoy instead of the physical workspace. This predates #541. Fix records owners together before restoring #541; the route does not implement its fifteen-check validator.

Path decision: one internal workspace-paths helper appends a fixed managed-root name to the original cwd spelling without normalization, reuses ensureDirectory's existing lstat/recursive-create policy, then native-realpaths a verified existing managed root before descendant joins. Do not canonicalize managed symlinks into acceptance. Readonly missing roots must remain absent and never look for a lexical decoy; represent absence explicitly so callers retain their own missing semantics, especially readReportMarkdown returning undefined. Writable missing cwd/root behavior remains recursive creation. Do not call realpath before existing kind/id/record validation or add a new public helper export.

Clean cutover owners: workspacePath (seven-kind readers/writers, Markdown and exclusive objects), createFlatRecord (data/report allocation and Markdown collisions), changePatchPath, publishBuildDirectory and verifyBuildBinary; task-card-file creation; capture-stack-lock enumeration/reuse/publication; report-inputs readReportRun. After root resolution, every descendant join starts from the physical root, including temporary paths, metadata and binary reads. No remaining raw-cwd join may reintroduce the lexical route. State-file publishers already append temporary names and keep their atomic/exclusive implementation.

Build and concurrency: the producer receives a physical temporary directory so its ordinary child joins cannot escape back to the lexical workspace. Preserve reservation, collision retry limits, parent/temp dev/ino ownership, post-await checks, whole-directory commit and rollback. Do not turn a canonicalization failure into a collision or success, remove a foreign replacement, introduce retries, or claim a cross-process atomic snapshot.

Compatibility and error boundaries: preserve all existing statuses/brands/schema bytes, readonly no-create, mutable/exclusive write rules, TaskCard allocation, StackLock fingerprint/reuse and build binary verification. Existing managed roots/files that are symlinks, dangling links or special files remain rejected. Ordinary cwd and cwd aliases/TMPDIR retain the same filesystem effects; internal physical path spellings may differ, so fault injection must target the actual owned path rather than rely on a platform alias spelling. Preserve meaningful path/stage diagnostics and facade sanitization, not incidental native path spelling. Do not rewrite persisted record fields to canonicalize history.

Full-suite-discovered test integration: policy change-approval/report-presentation and tools change-create/change-submit/report decision/publication/shud-build/shud-run durability/verification IO-publication fixtures compare or inject against the old platform cwd spelling. Migrate those existing fault and barrier targets to independently qualified physical managed paths, keeping raw public cwd, exact approval/state/history/rollback expectations, and evidence that the fault/barrier fired.

Review-confirmed consumer coherence: a built ToolRuntime counterexample publishes a physical-workspace ChangeRequest containing the lexical workspace's patch. Resolve the original cwd through native filesystem traversal in the existing source-checkout boundary, and carry that physical workspace through its three consumers: code_change task_create, change_create and shud_build. Bind source HEAD/diff, record reads, directory preflight, build producer cwd, publication and rollback to the same workspace. Preserve branded/schema admission and eligible-task-before-Git ordering; science_assist still has no source-checkout prerequisite and retains missing-workspace creation. No new generic path API, lexical fallback, governance rule or hostile-writer snapshot guarantee. This is the minimum production consumer migration required by the records cutover, not a separate policy change.

Review oracle strengthening: same-id lexical report decoys must fail a real validator clause (forbidden wording), with direct physical PASS and direct lexical FAIL controls before testing the physical-parent alias. Cover a missing physical reports root despite a populated lexical root; validation must not create or fall back. Actual ToolRuntime tests must distinguish physical versus lexical source HEAD, patch bytes and clean/dirty build admission, not merely pathname spelling.

Verification phases: first public readonly same-id decoy tracer RED→GREEN; then actual writer/Markdown and build-producer commit/rollback tracers, followed by every listed owner, absent physical root with populated lexical decoy, missing cwd writable/readonly, invalid-brand zero-IO, root/target unsafe kinds, ordinary aliases, root resolution faults and ownership replacement cases. Frozen M3 reports retain bytes and existing thirteen-check results on this route; after integration #541 must pass its unchanged physical-parent fifteen-check case. Parent runs built API smoke/full check/profile/strict/generated equality, reviewers inspect all sibling owners, and exact-head CI gates merge.

Containment: keep #541 paused in its owned-file stash until this route merges. Restore all nonoverlapping files byte-identically and resolve shared fixture/API-doc overlap as a recorded three-way union; keep consumed evidence immutable. No archive or PI acceptance is implied.

#### Routed issue #579 implementation boundary

Change surface: the existing embedded JavaScript judge in scripts/runtime/raw-guard-probes.sh; new complete offline fixture trees following its existing convention; scripts/guardrails/test-guardrails.sh and Testing_Strategy. No package or host production edit.

Governing invariant: targetCall and withinRaw agree with the pinned host's file-versus-shell cwd contract. For edit/write, extra workdir is ignored and file_path resolves from manifest workspace, which is this runner's session cwd. For bash, retain resolve(workspace, input.workdir || "."). A single narrow internal selector owns that distinction; retain existing matching/tokenization and unknown-tool admission.

Parent RED: three independently constructed copies of the existing passing fixture produce respectively T1 INCONCLUSIVE/exit2 for a correctly denied raw write with workdir elsewhere, T1 FAIL/exit1 for a safe completed write with workdir data/raw, and T1 INCONCLUSIVE/exit2 for a completed raw write with workdir elsewhere. Expected results are PASS/0, INCONCLUSIVE/2 and FAIL/1, all with unchanged md5. The legacy fail-t3-raw-workdir fixture remains T3 FAIL/1.

Sibling surfaces: targetCall feeds pass and attempted predicates for all probes; withinRaw feeds file and shell breach detection. Cover edit and write, relative and absolute file paths, misleading or irrelevant extra workdir, and the existing bash raw-workdir counterexample. Session/stream calls and results in each constructed fixture must agree; no real filesystem write or model call is implied.

Preserve every existing fixture byte and verdict, session identity checks, process-status checks, approval handling, T4 read semantics, T5 derived-file requirement, stdout shape and exit priority. Safe-only completion is INCONCLUSIVE rather than PASS because the required raw attempt is absent. Successful real raw completion stays FAIL. This route does not fix #581's separate pass-before-breach defect; do not add mixed pass-and-breach events here.

Verification: tests/fixtures first, parent executes the actual --judge entry without key or host before and after the selector change; independent frozen offline copies also exercise the changed CLI. Run all old and new offline fixtures, guardrail self-test, full default check, strict OpenSpec and hash comparisons. No profile/solver/live-probe result is claimed for this offline-only fix. Expanded review covers both helpers and unchanged verdict consumers; exact-head CI remains required.

Non-goals: raw policy or prompts, host code, bash parsing or shell expansion, new validation/retry/discovery, #581 precedence, scientific/Web/PI acceptance. No new public API or dependency; normal revert is rollback.

#### Routed issue #581 implementation boundary

Change surface: the final shared verdict branch of the embedded raw-guard probe judge, one new complete offline mixed-evidence fixture plus isolated sibling variants in the existing guardrail suite, and Testing_Strategy. All predicate definitions, target resolution, prompts and live process handling stay unchanged.

Governing invariant: violated dominates pass for every T1–T5 probe. Order is violated → FAIL, otherwise pass → PASS, otherwise not attempted → INCONCLUSIVE, otherwise FAIL. Retain existing exception-to-FAIL and final exit1-over-exit2 ordering; do not add a probe-specific exception.

Parent RED: a copy of the canonical pass fixture retains the immutable edit denial and appends a successful raw write whose literal content MD5 equals run.json before/after raw (406a4b65e6edef2cae087755117da2b9). Stream/session identities and results agree. The actual key-free/host-free --judge returns all five PASS, md5 PASS and exit0. Required result is T1 FAIL, T2–T5 PASS, md5 PASS and exit1 with no INCONCLUSIVE. These are synthetic events, not a real raw write or live bypass.

Sibling surfaces: the one verdict branch governs all probes, including T3 immutable bash denial and T5 derived-file success. Add independent mixed-evidence sibling controls so a T1-only fix cannot pass. Deny-only pass, raw-breach-only failure, clean skipped-action inconclusive, wrong-deny failure, approvals and T4 read evidence keep their existing predicate meanings. A completed safe write must not itself become a breach.

Compatibility: preserve all old fixture bytes and every existing overall exit code. Exactly the already-global md5-failure fixtures can tighten formerly misleading PASS rows to FAIL: fail has T4/T5 PASS before, and fail-t3-skipped-md5 has T1/T2/T4/T5 PASS before; unchanged violated includes !unchanged for every probe, so both become five FAIL rows after. This is the intended precedence correction, not a changed md5 predicate or weakened oracle. Other old fixture stdout/stderr remain identical.

Verification: permanent fixture/assertions RED before production edit, independent frozen CLI replay after, qualified same-byte hash, exact new stdout/exit, all old fixture/exit/hash checks, guardrails and default check, strict OpenSpec, 31 generated hashes and exact-head eight-job CI. No host/key/live-probe/profile/solver result is claimed. Expanded review audits predicates byte-for-byte and all shared verdict consumers; ordinary PR revert is rollback.

Non-goals: changing pass, violated or attempted, cwd/shell parsing, new validation or policy, discovery/retry/timeouts, actual filesystem enforcement or scientific/Web/PI acceptance.

#### Routed issue #590 implementation boundary

Change surface: the existing change_create branch in raw-guard decide.ts, direct real-Cordis tools/pre-execute regression coverage and the existing Repository_Layout change_create raw-boundary paragraph. Existing verification_run and change_submit branches provide the pattern but are not modified.

Governing invariant: task-id field access or schema parsing failure is unavailable identity, not unavailable filesystem identity. Initialize the target to tasks, isolate identity extraction in a narrow catch, then run the unchanged canonical fixed-root checks in their own failure boundary. A valid branded id selects only tasks/<id>/task.json; missing, invalid and throwing identity retain tasks. Do not alter canonical/containsRawPath, rawRoots, target order, denial codes or path failure handling.

Parent RED: built plugin in actual Cordis waterfall with a throwing task_id getter yields generic target-unavailable denial for rawDirs data/raw, changes, patches, tasks and repos/SHUD. Getter executes once, next never executes, no readFile/writeFile/mkdir occurs and canary bytes/mtime/inventory remain. Required behavior is exact downstream result/one next for disjoint data/raw and raw-immutable/no next for each fixed root.

Public boundary: this is direct JavaScript invocation of tools/pre-execute, not NativeToolRuntime/model JSON. The specific non-enumerable throwing-getter fixture is rejected during native argument snapshotting before the waterfall. This is not a general accessor-rejection contract: the installed snapshot walker can evaluate enumerable JSON-valued getters. Preserve outer execution.arguments adapter behavior; do not broaden this patch into envelope extraction or claim a raw access bypass. Capture controlled logger rows and check that private getter/error payloads do not appear.

Sibling and negative controls: successful valid identity must retain the exact task target and ignore another task's protected child; missing/ordinary-invalid identities retain fixed tasks. Fixed changes/patches/repos checks cannot depend on identity success. Existing and prospective targets, path aliases and sibling prefixes retain their owners. Real canonical failures, including an unavailable target or raw-root identity, must still reject before next even when task extraction throws.

Evidence: first one disjoint-waterfall tracer RED before the minimal source fix, then all four raw-root cases plus valid/missing/invalid identity, downstream return/rejection identity, no-content-IO and path-failure/privacy boundaries. Parent replays the frozen built oracle after rebuilding, runs raw-guard and affected tool suites, full default check, profile smoke, live raw probes with explicit engineering-only limits, strict OpenSpec and 31 generated hash equality. Three-seat white-box review and exact-head CI gate merge.

Non-goals: descriptor-only input semantics, all-tool abstraction, policy/approval changes, content reads, writes, mkdir, configuration, state, retries or host changes. Existing error owners remain; normal PR revert is rollback.

#### Routed issue #582 implementation boundary

Change surface: records/src/index.ts exports the already implemented workspace-paths.ts ensureDirectory and adds concise public API documentation. The helper body, all internal callers, package exports map and dependencies remain byte-identical.

Governing invariant: root public entry and current internal records paths execute one identical implementation; exposing it must not change directory, readonly, error or object-store semantics.

Return behavior: existing real directory returns false without mutation; missing path with readonly=true returns false without creating ancestors; writable missing path recursively creates and returns true; later calls return false.

Path boundary: final lstat rejects symlink, dangling link, ordinary file and special file in either mode. This is the existing per-directory primitive, not a recursive ancestor/traversal guard or atomic authorization. Trusted callers must validate each managed ancestor and branded path components in their existing order.

Error boundary: retain existing label/path errors and native filesystem failures. This primitive does not sanitize arbitrary caller labels or errno payloads; tools own controlled model-facing mapping. Do not introduce a synonymous facade or error hierarchy.

Sibling surfaces: workspace-records managedDirectory, task-card allocation and capture-stack-lock continue importing the same internal implementation; future change_create uses the root public seam only after this issue. No existing caller migration is needed because the implementation is not moved or duplicated. Existing capture, task-card and workspace directory regressions remain part of the full gate.

Runtime/type evidence: freeze existing internal helper behavior through a temporary filesystem oracle, record missing public export as entry absence (not a semantic helper failure), then run the same oracle through built package root. Check existing-directory inode/mtime, readonly no creation, writable recursive creation and final link/file/FIFO rejection with sentinel bytes/mtime unchanged. Verify emitted root declaration permits a boolean result without exposing private subpaths.

Verification: existing workspace readonly and unsafe-directory tests plus full check, build/profile smoke, strict OpenSpec, generated-file equality, independent review and exact-head CI. No permanent test that merely asserts an export exists; reuse behavior coverage and keep temporary entrypoint proof local.

Implementation mechanics: the one-line re-export and API comment may be applied inline by the orchestrator under the mechanical-edit rule, as with routed #574; disclose this without weakening fixture review, independent code review or checks.

Non-goals: #536's three-directory sequencing or TaskCard writes, new directory layout, stronger ancestor policy, retries, descriptors, concurrency controls, approval authority, source checkout access or scientific/PI acceptance.



#### Issue #519 implementation boundary

Change surface: core schemas/run-identifiers, three new strict record schemas, schema/public exports, existing generator registry and generated documents.

Governing invariant: parsing a new record accepts only its declared closed shape and internally consistent identity/governance/result fields; a valid id is checked before its derived path is accepted.

Must preserve: existing JOB/RUN/TASK/STACK/DATA/REPORT/DEC validation and generation, all prior schema parse semantics, the #518 ORDER/risk single source, Unicode code-point repository ordering, and byte-identical existing generated artifacts.

Must add: CHG/VC/BUILD brands through the existing generator; three schemas and inferred types; schema registry entries with valid examples. No runtime state or compatibility aliases.

Sibling surfaces: schemas/index.ts and core/index.ts; branded-ids.test.ts; relative-posix-path.ts and stack-lock/compare-paths.ts; registry discovery/completeness and generated-paths safe writer; downstream tasks 2.2a–c/3.1 consume these exports only after this slice.

CR: level and floor use the core tuple; risk follows the declared level; all floor_categories are sorted unique and end at floor; approval fields are null exactly for proposed. Fixed patch identity is derived from change_id.

VC: schema keeps the full declared enums, including agent_proposed and nonterminal statuses; M4 producer narrowing is not a schema rule. Passed/failed impose the spec hash/reason invariants; no artifact filesystem checks in parsing.

BR: base versus candidate binds change_id, patch_sha256 and dirty_paths in both directions. All three output paths bind exactly to build_id. Schema cannot verify referenced task commits or actual binary bytes.

Seams under test: source public schema exports, built core index exports, generated examples accepted by their own schemas, and schema drift gate.

Required evidence: task fixture positive/negative vectors and error paths; three independent cross-field semantic negative controls; existing projections unchanged; public built-runtime parsing/id generation; full local gate and same-SHA CI.

Non-goals: task/run/stack/provenance extensions, persistence or build execution, tool/policy integration, source checkout validation, producer enum narrowing, PI approval or M4 acceptance.

Review focus: precise strict shapes and error paths; complete bidirectional predicates; shared validators instead of forks; no discarded legacy behavior; generator examples/projections remain canonical.

### D2 回放工作区准备契约（脚本/PI 拥有，工具只校验）

- scratch workspace 由 `scripts/runtime/shud-replay-prepare.sh`（`shud:replay` 的前置步骤，也可单独执行供 PI 验收）建立：
  - `repos/SHUD`：`git clone <本仓库根>/SHUD repos/SHUD`（本地对象库 clone，不向根 submodule 的 git dir 写入）后 `git checkout --detach 9a422e5`；脚本断言 `git rev-parse HEAD` 为全 sha `9a422e5eb708df7d2f8b4066a3083a031d679a82`、`git rev-parse --absolute-git-dir` 为 `<ws realpath>/repos/SHUD/.git`、`git status --porcelain` 为空；根 submodule 的 git dir 以 `git -C SHUD rev-parse --absolute-git-dir` 定位（本仓库 `SHUD/.git` 是目录而非 gitlink，`.git/modules/SHUD` 不一定存在），准备前后文件清单不变。备选 `git worktree add` 会在根 submodule 的 git dir 下写 `worktrees/` 元数据，违反"submodule 永不改动"，否决。
  - `input/keliya`：复制 `../openMP/SHUD/Basins/keliya/input/keliya/`（路径由脚本参数 `--keliya <dir>` 或环境变量 `SHUD_REPLAY_KELIYA` 显式给出，缺省失败，不猜兄弟目录）；仅两项准备期改写：`keliya.cfg.para` 的 `NUM_OPENMP` 改为 `1`；`keliya.tsd.forc` 第 2 行改为同一来源下 `forcing.trimmed/` 的绝对路径。脚本记录两项改写前后的 sha256 到 `input/keliya/PREPARED.json`（非 SHUD 输入文件，`shud_run` 复制时原样带入副本、DataProvenance 照常哈希）。`forcing.trimmed/` 不复制。
- 工具不做检出、不做输入改写：`task_create(code_change)` 只观测并钉定 HEAD；`shud_build` 只校验 `repos/SHUD` 是 git 工作树且 HEAD 为钉定 commit，构建输入取自对象库（D3）；`shud_run` 照 M2/M3 复制 `input/keliya` 并只改 END（回放不传 `end_days`，窗口由准备期的 cfg 决定）。
- 准备脚本断言 `forcing.trimmed/` 含 `tsd.forc` 引用的 32 个文件（目录另有 2 项未被引用）。
- 回放不改 ccw 路径的执行与二进制选择；但 DataProvenance 自 M4 起对所有提交解析 `tsd.forc`（D10），ccw 得 `external_files: []`，解析失败是新的提交失败点——"无 build 的 `shud_run` 逐字节不变"只对执行与二进制选择成立。

#### Issue #546 implementation boundary

The standalone shell entry resolves the harness root from its own location, not caller cwd. Its Node-standard-library preparation logic accepts workspace plus optional --keliya; the flag overrides the environment, but no missing-source default exists. Resolve the documented input/keliya source physically and derive the same basin's forcing.trimmed directory two parents above; never trust the old manifest directory or guess another checkout.

Preflight source structure, one NUM_OPENMP line, forcing header/table referencing 32 distinct ordinary files, and both absent destinations before creating workspace outputs. Canonicalize the workspace through its nearest existing ancestor (including explicit workspace aliases) before physical overlap checks; no platform-specific /tmp or /var exceptions. Below that physical workspace, reject symlink/non-directory destination ancestors. Preserve line endings and all non-owned bytes while replacing exactly the NUM_OPENMP line and physical forcing-directory second line. The pinned SHUD reader consumes that directory with sscanf %s: reject ASCII whitespace in its physical path before writes; workspace spaces remain supported. PREPARED.json records source identity and per-file before/after SHA256, not scientific validity. Reject layouts overlapping the source/root submodule; do not overwrite or delete pre-existing paths.

Clone from the local root SHUD object store with real git, detach the full pinned commit and verify HEAD, clean status and independent physical .git. Disable optional Git locks and core.fsmonitor for readonly source observations, following the existing core revision collector; record root HEAD/status, Git-dir file inventory and gitlink bytes before work and compare afterward, including failure paths after clone starts. Existing source files/forcing contents stay byte-identical. Retain owned failed scratch output with explicit diagnostics rather than inventing a cross-directory atomic transaction or retry.

Tests invoke the actual public shell CLI with constructed basin files and real root SHUD object store; never mock Git success, copy scientific data into fixtures, or mutate a submodule. Parent runs the first tracer before implementation, then focused evidence/full default check and an independent successful/failure CLI smoke. vitest include gains scripts/runtime tests without coverage exclusions or threshold changes. Expanded review covers CLI parsing, source/destination siblings, no-overwrite, source preservation, input-byte fidelity and evidence hashes. #547 owns actual keliya replay; #548 owns gate/fixture registration.

### D3 `shud_build` 工具契约：构建输入 = (钉定 commit, 已批 patch)

- 参数（闭合 schema，未知键拒绝）：`task_id`（必填，`planned|running` 的 `code_change` 卡）、`change_id`（可选）、`rhs_openmp`（可选布尔，缺省 `false`）。源目录固定为 `<cwd>/repos/SHUD`（不接受路径参数）。
- 检出校验（任一失败即工具错误、零副作用）：`repos/SHUD` `lstat` 为真实目录、`realpath` 等于 `git rev-parse --show-toplevel` 的 realpath（排除嵌套/外来仓库）、`git rev-parse HEAD` 等于卡的 `source_base_commit`；观测 = `git status --porcelain -z --untracked-files=all`（忽略路径不计）。无 `change_id` 时观测必须为空（base 构建，用户决定）；有 `change_id` 时读取 CR，要求 `status: approved`、`task_id` 相同、`base_commit == HEAD`，`patches/<change_id>.patch` 为普通文件且 sha256 == `patch_sha256`，观测路径集合 == `files_changed`，且 `git diff HEAD --no-ext-diff --no-textconv --no-color -- <files_changed>` 的字节 sha256 == `patch_sha256`。工作树检查是一致性检查（coder 看到的树就是要构建的树），不是构建输入。
- 构建输入绑定（Review 2 P1-2 的修复）：在 `builds/.tmp-<build_id>/`（排他 `mkdir`，EEXIST 重分配 id）内 `git archive --format=tar <source_commit>` 解包到 `src/`；解包后断言 `src/` 的条目集合等于 `git ls-tree -r <source_commit>`（防 `export-ignore`/`export-subst` 改变构建树）；有 `change_id` 时在 `src/` 内 `git apply --check` 再 `git apply`（失败即错误并删除临时目录；`git apply` 另设 `GIT_CEILING_DIRECTORIES=<tmp realpath>`——子代理实测在外层仓库的子目录内 `git apply` 会静默 rc=0 不改文件——并在 apply 后断言 patch 已生效）；`make -C <tmp>/src shud SUNDIALS_DIR=<sundialsRoot>`，`rhs_openmp` 为真时追加 `SHUD_ENABLE_OPENMP_RHS=1`；`sundialsRoot` 取 `shud-jobs` 行配置（未配置时工具错误，不猜路径）；环境只继承 `PATH`/`HOME` 与 `SUNDIALS_DIR`（白名单，不含 `DMXAPI_KEY`）；不传 `-s`，`make.stdout.log` 保留回显的编译命令（`-fopenmp` 证据，D13）。同步等待（本机 `make shud` 约 8 s）。因此工作树里被 `.gitignore` 忽略的源文件、`repos/SHUD/shud` 陈旧二进制、并发的另一次构建都不进入本次构建；`shud_build` 对 `repos/SHUD` 零写入。
- 产物：`make` 退出 0 且 `src/shud` 为普通可执行文件时，复制为 `<tmp>/shud`，计算 sha256；`compiler` 在 `src/` 内以 `make -s -f Makefile -f <tmp>/print-cxx.mk print-cxx` 取 `$(CXX)` 再取 `<cxx> --version` 首行（`print-cxx.mk` 由工具写入临时目录）；删除 `src/` 与 `print-cxx.mk`，写 `build-record.json`，整目录 `rename` 为 `builds/<build_id>/`。`make`/`git apply` 非零或产物缺失：工具错误含退出码、失败阶段与 make 输出末尾至多 40 行（不含环境变量值），临时目录删除（错误不引用已删除的日志路径），不留 `builds/<build_id>/`、不写 BuildRecord。
- 回写：成功后 TaskCard 不记录 build（build 经 RunJob/StackLock 可追溯），不改卡状态。
- git 调用全部经 core `repository-revision.ts` 扩展的受控 runner（D4）。
- 为什么不把构建并入 `shud_run`、不让 coder 裸 `make`：grill 否决；BuildRecord 是 StackLock 与 VerificationCase 交叉校验的锚。为什么不直接在工作树上 `make`：工作树不是可审计的输入（忽略文件、陈旧目标、并发），archive+apply 的成本只是一次解包。

#### Issue #537 implementation boundary

Scope: compose the existing #526/#527/#536 APIs into the registered shud_build tool, raw fixed-target protection and the CONTEXT companion invariant. No jobs configuration API, records publisher rewrite, policy approval, preset mount, source checkout mutation or real solver build.

Configuration seam: tools already injects jobs. Pinned Cordis publicly documents Context.fiber, Fiber.store (the loaded dependency implementation snapshot), Impl.fiber and Fiber.config (validated provider configuration). Read only sundialsRoot from the injected jobs provider, whose service is the required ShudJobRegistry; do not scan loader rows, serialize configuration, access protected service internals or fall back to process.env. A real Cordis preflight proved this path. The context service is a tracing proxy, so raw implementation value and ctx.jobs need not be strictly equal. Missing sundialsRoot fails invocation before any filesystem write; absent config must not prevent existing tools from mounting.

Admission: strict branded task_id/change_id and boolean rhs_openmp; explicit calling cwd. Read task/CR/patch with readonly canonical APIs. Reuse readSourceCheckout for physical root/40-hex HEAD, require the task pin, then canonical observeSourceChanges. Base needs an empty observation; candidate needs approved, same-task, same-base CR, exact observed paths, observed patch digest and persisted ordinary patch digest. Keep validated patch bytes for the build; never reread them later. Observe source_branch through runGit; detached HEAD uses the existing HEAD spelling. Recheck task eligibility/pin after admission awaits before build effects, without changing the card.

Build input: use publishBuildDirectory as the sole reservation/id-collision/metadata/rename/cleanup owner. Its producer creates src, archives the pinned object via runGit and system tar, and compares the complete extracted leaf paths/types/blob identities to NUL-delimited ls-tree output. Reject archive attribute changes before make; never copy working-tree files. Hash blob bytes through runGit hash-object --no-filters; this runner deliberately closes stdin, so do not depend on stdin input. Validate extracted paths/types without following unsafe entries outside the owned tree. Apply only the retained patch with applyCeiling set to the real temporary parent; compare every changed path before/after and reject ineffective application.

Execution: run make synchronously with the exact specified argv from session cwd and only PATH/HOME/SUNDIALS_DIR. Log stdout/stderr directly into exclusive temporary files; never use a shell command string or silent build flag. The separate print-cxx target may use -s as specified; reject an empty/multiword CXX before executing the compiler with --version and taking its first line. Validate the produced shud as ordinary and executable, copy/hash the actual build result, remove only producer-owned transient entries and return the complete BuildRecord to the canonical publisher. The published directory has exactly the four specified files. No TaskCard writes or SHUD process submission.

Errors and resources: reserve once per canonical candidate, never retry a failed build into success. Capture only controlled stage, exit/signal fact and bounded last-at-most-40-line make diagnostics; redact environment values and deleted temporary paths before exposing errors. Keep file descriptors and subprocess resources balanced, including errors. publishBuildDirectory intentionally sanitizes arbitrary producer exceptions: retain the tool's already-controlled diagnostic in invocation-local state, let the publisher clean its owned reservation, then preserve both that diagnostic and any controlled cleanup-failure fact. Never relay native causes or bypass the publisher to retain arbitrary exceptions. Cleanup/ownership uncertainty retains evidence rather than deleting a replacement; no new retry API.

Ownership/concurrency: the records publisher already checks parent/temp identity after producer awaits and before metadata/rename/cleanup. The build producer must retain the same owned namespace when it resumes its own async Git operations before further writes or extraction. Preserve the established cooperating-publisher collision semantics, including a winner that disappears after EEXIST; do not promise rename-no-replace against arbitrary external writers between syscalls. Concurrent builds use distinct owned trees and never share artifacts.

Raw boundary: shud_build checks builds and repos/SHUD using the existing canonical/nearest-existing-ancestor containment before any tool execution, archive or make. Cover both existing and absent builds/repos/source, native case and symlink aliases, sibling prefixes and unrelated descendants; raw decisions do not read cards/CRs or expose paths. Existing policy-gate owns role-tool-surface; test worker/reviewer/coordinator denial and coder admission without duplicating role logic.

Sibling surfaces: task_create/source-checkout and change_create pin semantics; readonly workspace task/CR/patch readers; core runner root/ceiling/env/output limits; records publisher reservation/cleanup and BuildRecord identity paths; raw metadata target classifier; tools mounting/current role policy; jobs build consumers and StackLock readers remain unchanged. Build metadata compiler/log/binary paths must agree with actual output and the final collision-resolved id.

Delivery sequence: base-build tracer with real ToolRuntime/Git/tar/make first, then candidate-patch and raw tracers, then adversarial matrices. Build before cross-package tests. Parent verifies actual emitted plugin, executes its fake-Makefile binary, independently checks compiler/digests and complete source/card snapshots. Full check/profile/live raw probes/guardrails/strict/generated equality and three-seat review gate delivery. Existing #579/#581 judge issues require retained-byte stronger audit; automated evidence is never PI acceptance.

Rollback boundary: before rename, canonical owned-temp cleanup; after rename, the BuildRecord is committed and no rollback deletes the published directory. Source checkout and TaskCard are not rollback targets because this tool never owns writes there.


### D4 `change_create`：观测 diff 与 floor 派生（Critical Path #1）

- 参数：`task_id`（必填）、`semantic_level`（可选，coder 申报）、`description`（可选一行）。源目录固定 `repos/SHUD`。
- 前置：卡 `type: code_change`、`status ∈ {planned, running}`；`changes/`、`patches/`、`tasks/<task_id>/` 按工作区文件规则 (2) 检查（真实目录或创建）；`repos/SHUD` 的 `git rev-parse HEAD` 必须等于卡的 `source_base_commit`，否则错误"检出已偏离钉定 base"、零写入（coder 的 `git commit` 不能把改动移出观测——Review 2 P1-4）。
- 观测：`git status --porcelain -z --untracked-files=all`；存在 untracked（非忽略）路径 → 工具错误并列出路径（Non-Goal：M4 不接受新文件）；存在删除/重命名 → 同样拒绝；观测为空 → 工具错误"无改动"。`files_changed` = 修改的已跟踪文件，POSIX 相对路径排序。
- 派生：`deriveSemanticFloor(files_changed)`（D6）给出 `{floor, categories}`；`semantic_floor = floor`、`floor_categories = categories`；`semantic_level` = coder 申报值与 floor 的最大值，申报低于 floor 时不报错、取 floor 并在结果中说明（"coder 只能向上调"）；`risk` 由 level 映射。
- patch：`git diff HEAD --no-ext-diff --no-textconv --no-color -- <files_changed...>` 的字节原样写 `patches/<change_id>.patch`，sha256 记入 CR；同一命令在 `shud_build` 复核。
- git 调用加固（Review 2 P1-3）：`task_create` 取 HEAD、`change_create`、`shud_build` 的全部 git 调用经 core `stack-lock/repository-revision.ts` 扩展导出的单一 runner：env 白名单 `{PATH, HOME, LC_ALL=C, GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0}`（`git apply` 另加 `GIT_CEILING_DIRECTORIES`，且它在 `<tmp>/src` 这个非仓库目录内运行、不做 toplevel 校验）、`-c core.fsmonitor=false`、status `-z`、diff 禁外部 diff/textconv/颜色、realpath == toplevel；既有 `collectRepositoryRevision` 与 StackLock 采集字节不变。
- 持久化顺序：CR JSON（`proposed`）→ patch → TaskCard 回写（`linked_changes` 追加；卡 `planned` 时转 `running`、`runtime_phase: running_local`；已 `running` 不变）；任一步失败返回含 `change_id` 的错误，已写文件保留（与 M3 `shud_run` 回写失败"运行已 durable"同一语义）。
- `change_create` 不 ask：它只生成对象（对应 `report_generate`）。备选"单一 change_submit 一次完成"被 pre-execute 顺序否决：ask 先于执行，被拒即无 durable 记录。

#### Issue #536 implementation boundary

Goal/scope: implement task_create(code_change) and change_create in tools, plus only change_create's fixed raw targets. Existing core/records APIs and routed #582 are prerequisites, not implementation targets. Keep the issue's atomic tool/publication boundary; no build, approval, verification or preset work.

What exists: strictTool closes model and captured runtime parameter validation; readCallerPresetId owns current preset identity; records owns schema/id-safe reads, deterministic observation/derivation, exclusive CR/patch publication and TaskCard transitions. ensureDirectory is now public and remains the sole directory primitive.

Source checkout helper: a small internal tools helper shared by both entrypoints validates fixed repos/SHUD with lstat, resolves its physical identity, calls core runGit for --show-toplevel and HEAD, compares native realpaths and validates exactly40 lowercase hex. runGit does not automatically root-check rev-parse; callers must perform this explicit check. Strip only Git's trailing newline from path output, not arbitrary path whitespace. No collectRepositoryRevision, shell Git wrapper, source creation or writes.

Task creation phase: closed type enum science_assist|code_change and existing nonempty fields/workspace checks precede IO. For code_change, complete checkout validation/HEAD observation before createTaskCard can mkdir; absent/link/file/nonrepo/nested/unborn/invalid HEAD errors leave no task/output directories. science_assist retains null pin and does not inspect even a broken repos path.

Change admission phase: validate closed task_id/optional semantic_level/one-line description before tool IO; fixed source path is not a parameter. Read the canonical readonly TaskCard and require code_change plus planned|running. Compare captured HEAD to its pin before status/diff; drift error contains both validated commits, no writes or observation. Empty observation rejects; unsupported paths retain the canonical observer's diagnostic paths.

Derivation/preflight phase: deriveChangeRequest is the sole floor/categories/risk/hash constructor. Its explicit in-memory candidate id is not an occupied object (existing #528 composition); it may be generated for pure derivation before directory checks, but is never exposed or published on preflight failure. Claim/public allocation occurs at exclusive CR publication. No dummy id, duplicate floor computation, second constructor or new records API. All changes/patches/tasks-parent/task-directory checks complete before any object write, using ensureDirectory with controlled caller-side errors.

Publication/state phase: after awaited Git work, freshly reread/validate the card and its captured source pin; then derive/preflight/publish CR→patch→fresh synchronous card transition/link union without an await between the final card read and write. Preserve unrelated current fields and all existing links; planned enters running_local, running retains its phase. Collision returns the actual new id/path from createChangeRequest, which must drive patch/result/link writes.

Failure boundary: no rollback of successfully committed CR or patch. After CR publication, patch/card failures return a controlled stage and the actual change_id, preserving committed bytes and not adding a false TaskCard link. A records publisher's controlled committed-cleanup error already carries its id and must not be replaced by an id-less error. No raw exception payloads from native directory/card failures.

Raw phase: before generic model file/shell classification, change_create checks changes, patches, validated exact task.json (invalid/missing id falls back to tasks), and repos/SHUD using existing canonical containment only. Target inside raw denies before Git/execute/approval; a raw descendant of a target or another task does not blanket-deny. Do not read object contents. task_create(code_change) still checks only tasks; #535 governance and all previous raw paths remain unchanged.

Sibling surfaces: two task types, current preset attribution, strictTool/runtime registration, source helper plus observer's independent protected-verb checks, readonly TaskCard identity, exclusive collision/partial commit behavior, transitionTask and concurrent link/state writers, raw fixed/exact targets and generic governance classifier. No new global queue, cache or mutable policy.

Phases/verification: first real ToolRuntime code_change pin tracer RED→GREEN; next change_create+raw tracer RED→GREEN; then focused adversarial/compatibility matrices. Full check/profile/raw probes/strict fixture/generated equality and three white-box seats gate the complete issue. Existing source-plugin ToolRuntime smoke is labeled as such; final built-tool execution must be exercised separately, without pretending a boundary double is Web/LLM or PI proof.

Constraints/assumptions: trusted session cwd as in existing tools; canonical id/path readers and controlled runner remain authority. External writers can change the checkout between Git commands; no new snapshot isolation or retry is promised. In-process awaited TaskCard updates must not be lost. File-side effects begin only after valid card/head/observation/derivation.

Rollback/containment: before publication, reject with no objects; preflight may create empty managed directories. After exclusive CR commit, preserve evidence on later failure and report its id. Deployment rollback is a normal PR revert, not a second tool version or storage shim.

Next step: fixture review and strict validation, then one implementer with parent-owned RED/GREEN gates. Open decisions: none after applying existing candidate-versus-owned identity composition; reviewer must check that distinction against the observable no-public-id-on-preflight-failure criterion.


#### Issue #528 implementation boundary

Observation API: observeSourceChanges(sourceDir) returns Promise<{files_changed: string[], patch: Buffer}>. lstat first rejects missing/non-directory/symlink source roots; status and diff are invoked only through core runGit, which owns physical-root validation and environment/argument hardening. Nested ordinary directories fail before target status/diff. No TaskCard read, source mutation, staging, ask, model call or workspace-record publication occurs in the observer.

Porcelain contract: parse v1 NUL-framed byte records, not lines or quoted display paths. Preserve spaces, tabs, quotes, backslashes, newlines and a leading Unicode BOM in names; invalid UTF-8/framing/status records fail closed. Accept index/worktree M and blank combinations with at least one M; reject untracked, staged/intent-to-add additions, deletion, rename/copy, conflicts and type/unsupported changes with the involved paths. R/C consume their second path record before reporting. M4 still modifies existing tracked files only.

Path and patch binding: sort captured valid UTF-8 path byte views with Buffer.compare (UTF-8 lexicographic order equals Unicode scalar order), then decode without stripping a BOM. Validate the canonical path set through existing public core field schemas. Each diff operand is :(literal)<raw path>, preserving path identity even for exclusion/glob syntax. Core supplies the fixed HEAD diff hardening flags before --. Return stdout bytes unchanged; a clean observation returns empty paths and an empty Buffer without invoking a broad unfiltered diff. Do not add --binary, index mutation, custom Git environment, repository config editing or a second runner.

Pure derivation API: deriveChangeRequest receives explicit change_id, task_id, base_commit, files_changed, optional semantic_level/description, created_by, created_at and patch Uint8Array bytes. Validate ids before derived path construction; use existing core field schemas and complete ChangeRequestSchema rather than duplicate validation rules. The refined Zod object cannot be picked directly, so reuse its public shape fields without adding a dependency. Return {record, level_adjustment}, where adjustment is null or {declared, effective} only when a valid declaration is raised. The record is proposed, has null approval fields, source_path repos/SHUD, updated_at equal to supplied created_at, canonical patch_path, and SHA256 of the exact bytes. Floor/categories/order/risk come only from core; no IO, clock, randomness, input mutation, or LLM choice.

Storage composition: a candidate id string is not an occupied workspace object; task-cards rule (4) assigns ownership at first exclusive publication. createChangeRequest now validates and publishes the full candidate without discarding its first id; the same existing allocator rebinds id/path after collisions. Replace the fields-only signature, migrate all tests/typechecks/callers, and remove obsolete comments—no optional compatibility mode or second constructor. Preserve malformed-id pre-IO rejection, schema validation, four candidates, owned temporary cleanup, patch binding and every old M3/VC/build behavior. Caller tools still own preflight and the actual publication order.

Must preserve and non-goals: core runner and legacy collector/capture remain untouched; all generated artifacts remain byte-identical. Named fsmonitor/external-diff/textconv/color controls are proven, not generalized attribute/config determinism. Observe the required Git status/diff semantics without inventing a Git snapshot transaction, patch applicability test, HEAD pinning, commit operation, source archive or compiler. These remain downstream responsibilities.

Verification: real repos cover mixed staged/unstaged modifications, ignored new files, all rejected states, empty observations, nested/unsafe roots, special and Unicode/literal-magic names. Native C environment recording reuses the existing scripts fixture and system cc prerequisite, without a second trace parser or core edit; prove absent fake DMXAPI_KEY/GIT_DIR and no configured marker execution. Pure vectors cover missing/below/equal/above declarations, multi-match categories, invalid inputs, supplied timestamps, exact digest and detached deterministic output. Built public API observes, derives and exclusively persists a candidate/patch, then reads it back; original repo bytes/index/HEAD stay unchanged. File-layer migration retains real collision/security regressions; full check and three-seat whitebox review follow.


#### Issue #526 implementation boundary

Change surface: repository-revision.ts exported runGit and focused tests; index wildcard already exposes the API.

Governing invariant: every new-runner child receives only the specified environment and hardening argv, and protected commands cannot observe a parent repository through a nested cwd.

Must preserve: collectRepositoryRevision source, four-call argv, inherited env excluding locator vars, normal untracked listing, existing overflow/error semantics and StackLock capture bytes. The new capability does not replace this legacy collector.

Must add: async non-shell execFile returning Buffer; automatic native-realpath root validation for status/diff/archive and normal apply; fixed status/diff flags inserted before pathspec separator.

Apply exception: named applyCeiling only for apply, existing absolute physical strict ancestor; add only GIT_CEILING_DIRECTORIES and skip root check. No arbitrary extraEnv or generic skipRootCheck.

Resource/error contract: bounded 64 MiB default (actual pinned SHUD archive 18,636,800 bytes), optional positive integer maxBuffer; any new-runner overflow fails, never partial success. Bounded 4096-byte stderr tail, exit/system code and truncation indication, without raw cause/stdout/env/command dumps.

Subprocess lifecycle: the API accepts no stdin input. The shared execFile invocation immediately ends its unused stdin pipe so EOF-driven commands, including ordinary and ceiling apply without a patch operand, return Git's controlled exit rather than waiting indefinitely. Regression probes use an isolated process group and clean it up on failure; no production timeout or input API is added.

Sibling surfaces: legacy collector and tests; captureStackLock repository snapshots/reuse; future observeSourceChanges, task_create HEAD and shud_build archive/apply. No new helper framework or consumer implementation.

Required evidence: native git shim exact entry environment/prefix and absent fake-secret, compiled by system cc into test-owned temporary directories; Node/Python runtime-added Darwin variables cannot be filtered to fake this oracle. Record only key names and allowlisted values. Real config markers remain untouched; special path/root LF preservation; nested target verbs never run; archive beyond Node default buffer; real nonrepo apply isolation; legacy host-config discriminator and pre/post capture bytes/mtime.

Non-goals: arbitrary Git-config determinism, pathspec literalization (#528), archive-attribute integrity (#537), source observation/build orchestration, additional environment variables, legacy refactor or retries.

Review focus: actual subprocess environment rather than shell-added keys; unavoidable root checks; bounded complete output; no diagnostic raw-cause leak; unchanged legacy behavior and no fake archive/apply proof.

### D5 `change_submit` 与 policy-gate ask（Critical Path #3）

- 参数：`change_id`。工具读取 CR，要求 `proposed`、`task_id` 的卡存在且 `running`，`lstat` 读取 `patches/<change_id>.patch` 并校验 sha256 == `patch_sha256`（不等 → 错误、零写入），然后原子写 `status: approved`、`approval_ref: exec.callId`、`approved_at`；CR 无 Markdown 投影。已 `approved` 的 CR 再次进入工具时返回错误，不重复写入批准；pre-execute 是否发卡仍严格遵循下面的五步策略，不以终态绕过高风险 ask。
- policy-gate：在 `role-tool-surface` 未 deny 后，对 `change_submit` 读取 `changes/<change_id>.json`（经 schema 校验，只读 `changes/` 之内）与 `patches/<change_id>.patch`（只读 `patches/` 之内）：两者均可读而 patch sha256 ≠ `patch_sha256` → `deny`，reason 为导出受控常量（code `change-patch-mismatch`），不 ask（PI 不应为与记录不符的 patch 发卡）；否则 `semantic_level ∈ {output_semantics, numerical_implementation, parameter_default, physical_equation, model_assumption}` → `ask`，`reason` = 导出前缀常量 + 空格 + `change_id`（id 缺失/非法 → 前缀 + 受控标记，不含原始参数）；`displayReason.{en,zh}` 含 `change_id`、`semantic_level`、`semantic_floor`、`floor_categories`、`risk`、`files_changed` 全列表、`patches/<change_id>.patch` 路径与 `description`，PI 可在卡片决定前打开 patch。`pure_engineering`/`io_format` → `next`（不 ask）。CR 文件缺失/损坏或 patch 缺失/不可读 → 仍 `ask`（fail-closed：不因读不到而放行），`displayReason` 含"无法读取"。
- 审计：策略门的决策审计对 `change_submit` 的 ask 使用新导出常量 `change-approval` 作为 code，载荷只含经品牌校验的 `change_id` 与 `semantic_level`，不含 `files_changed`、`description`、patch 内容或原始参数（这些只进 `displayReason`）；patch 不符的 deny 记 `deny change_submit change-patch-mismatch`。既有「Global pre-execute mounting」「Policy core deny layer」「Policy decision audit」「Host fail-closed approval outcome」四条措辞随之扩到三个 ask 工具。
- 宿主结果：allowed-once → 工具执行写 `approved`；rejected/cancelled/unavailable → 宿主 deny，工具不执行，CR 保持 `proposed`，审计只有 `approval/asked|decided`。danger-full-access 会话同样发卡（#511）。PI 的拒绝理由经对话到 coordinator → coder（ADR-0011 的对话承载），不落盘（D15 偏离）。
- `shud_build` 只接受 `approved` CR，所以"无 ask 窗口"不存在：policy-gate 行在 M3 已挂载，新规则与新工具同一切片落地（见 Migration Plan）。

#### Issue #538 implementation boundary

Policy precedence is one existing listener: core role/evaluator deny first, then canonical readonly CR lookup, readonly patch bytes, mismatch deny, unreadable patch ask, finally level-based ask/next. Invalid/unavailable CR never causes a patch read or managed-directory creation. Known off-role callers never trigger CR/patch reads. Unknown caller uses the same level rule, not an unconditional ask for valid low-risk input. No status-based policy shortcut or fourth deny source.

The explicit policy requirement assigns proposed/running preconditions to the handler. D5's former shorthand "不重复审批" and the duplicate scenario mean no second durable approval execution, not exemption from pre-execute policy: an approved high-risk CR with matching patch can still produce an ask, and after allowed-once the tool rejects without changing bytes; an approved low-risk CR delegates then rejects. This interpretation preserves the fixed five-step order and the policy's explicit ownership sentence. Both duplicate paths require regression evidence; fixture review must flag any unresolved acceptance contradiction before code.

The handler validates the branded id, session cwd and nonempty exec.callId, then reads a fresh canonical CR and its existing running TaskCard readonly. It checks the exact patch bytes again after host approval and writes only status, approval_ref, approved_at and updated_at through rewriteChangeRequest. All reads/hash/conversion/atomic publication are synchronous, with no await/queue, state transition helper, directory bootstrap, new type/base restriction, TaskCard/link write, Markdown projection, comment capture or decision record. A simultaneous second accepted call observes approved and fails. Missing/unsafe/damaged inputs and write failures expose controlled stage/id diagnostics, never raw payload/cause; the canonical writer owns temporary-file cleanup and commit behavior.

Approval presentation is not audit authority: reason contains only fixed prefix plus validated change_id or invalid marker; displayReason has complete bilingual validated CR facts and explicit unavailable fields. Audit allows only code, validated id and schema-validated level for ask, only validated id for mismatch deny; paths/descriptions/digests/raw arguments never enter audit. Preserve report ask behavior and cumulative disposal counts. The helper returns ask/deny or delegation information, not host allow, and never calls ctx.approval itself.

Raw guard observes only the metadata identity of changes/<validated-id>.json, falling back to changes for missing/invalid ids. Session cwd and existing physical/case/nearest-ancestor semantics apply; raw denial precedes policy reads/cards regardless of malformed arguments or rawDirs order. Do not broaden to unrelated sibling CR files or patch reads.

Sibling surfaces: policy-gate.ts/report-approval.ts/index.ts and existing logger/host-outcome tests; tools strictTool/report-decision.ts/index.ts and canonical record readers/rewriteChangeRequest; raw decide.ts report-target patterns; full-access-approval.test.ts approved real PermissionPresetService/ApprovalService/SessionStore seam under ADR-0012. Extend that existing filename for the actual change tool rather than creating a new restricted-import exception or changing root config. Public Agent/Session doubles in other ToolRuntime tests remain explicitly described; real-service event proof and built-plugin smoke do not claim Web/PI acceptance.

Verification follows vertical tracers: a held high-risk approval cannot publish until allowed-once, with durable approval_ref equal to execution/asked callId, not approval request id; then denied outcomes, patch mutation while held, low-risk/no-card and raw-first rejection. Only after these loops expand argument/state/path/audit/level/role/outcome/concurrency/failure matrices. Default gate, profile smoke, raw probes with stronger retained-evidence audit, guardrails, strict fixture, unchanged generated schemas, three review seats and exact-head CI complete the slice. No model/solver/scientific validation claim.

### D6 semantic_level floor 的形态（Gating 规则 1/2/6）

- 形态沿 M3 措辞常量先例：`packages/dsh-shud-core/src/governance/semantic-level-floor.ts` 导出 `SEMANTIC_LEVEL_ORDER`（七档偏序）、`SEMANTIC_LEVEL_FLOORS: ReadonlyArray<{pattern, floor}>`（初值 = Gating §1.1 表，pattern 相对于源仓库根，即去掉 `SHUD/` 前缀：`src/ModelData/**`、`src/classes/**`、`src/Model/**`→`numerical_implementation`，`src/Equations/**`→`physical_equation`，`input/**/*.para*`→`parameter_default`，`src/**/IO*`→`io_format`，`src/classes/Model_Control.*`、`src/Equations/print.hpp`→`output_semantics`，`docs/**`、`scripts/**`、`templates/**`→`pure_engineering`；rSHUD/AutoSHUD 条目保留但 M4 源仓库只有 SHUD）、`deriveSemanticFloor(paths): {floor, categories}`、`riskForLevel(level)`，附正反例测试与 `docs/generated/` 投影。
- 语义（Review 2 P1-1 / Review 1 P1-3 的修复，用户裁决）：每个路径的 floor 是**全部**匹配条目 floor 的最大值（不依赖表的顺序，`src/classes/Model_Control.cpp` 同时命中 `src/classes/**` 与 `src/classes/Model_Control.*`，取 `numerical_implementation`，categories 含两者）；不匹配任何条目的路径按 Gating 规则 2 取 `numerical_implementation`（`Makefile`、`README.md`、`src/main.cpp` 都是）；`docs/** scripts/** templates/**` 因表中有条目而得 `pure_engineering`。`floor = max(各路径 floor)`，`categories` = 各路径 floor 值的升序去重集合（规则 6 的 `floor_categories`）。coder 申报只能抬高。
- 仓库内常量、无 profile 覆写（与 `wording.ts` 同：改表走 PR + 审查，不走运行时配置）。Gating §1.1 的"配置文件（非硬编码）"措辞在文档任务中改为"仓库内受测常量模块"；规则 2 与规则 6 原文不动。回放切片（`Makefile` + `src/Model/*`）的派生结果仍是 `numerical_implementation`，`change_submit` 必 ask。

#### Issue #518 implementation boundary

Invariant: for nonempty observed POSIX paths, evaluate every matching entry; the floor is the maximum by ORDER and categories are the sorted deduplicated union of all matched entry levels, plus numerical_implementation for each unmatched path. Empty input throws. This explicit rule and the normative spec resolve the older per-path-floor shorthand above.

Must preserve: exact seven-level order and eleven SHUD-relative table entries, conservative unknown fallback, order-independent results, no first-match/max-only categories, no profile/runtime override, no extra normalization API or dependency. Existing object-schema generated bytes and safe generated-path helpers remain unchanged; permutation evidence must not mutate shared constants.

Sibling surfaces: task 2.1 consumes ORDER/riskForLevel and task 3.2 consumes deriveSemanticFloor, neither implemented here. Existing wording constants are a pattern reference, not a second floor source. The single generation entrypoint owns the new constant projection; its registry completeness, self-test and check.sh remain the gate.

Required evidence: semantic positive/negative vectors and seven risk mappings in the task fixture, legacy projection hashes, generator self-test, isolated real constant-drift rejection and restoration, built public-index smoke, full default gate and independent CI. Non-goals: schema/record/tool consumers, runtime permissions and M4 end-to-end replay.


### D7 `code_change` TaskCard 状态、钉定 base 与 closure 谓词

- `task_create` 的 `type` 接受 `science_assist|code_change`；`code_change` 卡建卡后 `planned`，并在建卡前观测 `repos/SHUD`（真实目录、git 工作树、realpath == toplevel）的 `git rev-parse HEAD` 写入新字段 `source_base_commit`（40 hex）；检出缺失/不合法 → 错误、不建卡；`science_assist` 的该字段为 null，不访问 `repos/`。M3 卡缺该键按 null 解析，不改写。这是回放钉定 `9a422e5` 的唯一真相源：`change_create`、`shud_build`、`verification_run` 都以它校验。
- 进入 `running`：`change_create` 成功（`runtime_phase: running_local`）或 `shud_run(task_id)`（既有 `submitted_job`）二者之一先到；`shud_build`、`change_submit` 与 `verification_run` 不改状态。`linked_changes`（`ChangeId[]` 码点升序去重）由 `change_create` 回写；`linked_verifications`（`VerificationId[]`）由 `verification_run` 回写；两者在 schema 中必填数组，M3 卡读取时按 `[]` 默认兼容（schema `default([])`，M3 文件不改写）。
- closure 谓词（`report_generate` 中、reconcile 之后求值，纯函数 `codeChangeClosure(card, loaders)`）：
  0. `linked_jobs` 非空，且 `observations`、`limitations`、`pi_questions` 各至少一条（同 `science_assist`）；
  1. `linked_changes` 中至少一个 CR `status: approved`、`task_id` 为本卡，且其 `patches/<change_id>.patch` 存在、sha256 匹配；
  2. `linked_verifications` 中至少一个 VC 的 `change_id` 为该 approved CR、`task_id` 为本卡、`status ∈ {passed, failed}`（失败不阻塞 closure：报告必须呈现失败），且其 `base_run_id`/`candidate_run_id` 对应的 RunJob 都在 `linked_jobs` 中（Review 2 P1-5）；
  3. 该 VC 的 `reviewer_notes` 非空且 `reviewed_by` 非空（schema 已保证，列出以对应 Agent_Architecture §7；不合格文件在读取时即按不可读处理）；
  4. `semantic_level` 已填（schema 必填，恒真，同上）；
  5. 既有 `science_assist` 的运行子句对 `linked_jobs` 同样求值（全部 `collected` 且 RunRecord `stack_id/data_id` 非 null；失败/取消/收集耗尽阻塞）。
  不成立时 `report_generate` 返回点名子句的错误、不写报告、不改卡。`engineering` 谓词不动（本 change 不实现，保持无生产者）。

#### Issue #529 implementation boundary

Governing invariant: closure is decided from linked, identity-bound durable evidence and authored-array presence, never model classification. Failed verification is reportable evidence, not an automatic veto; invalid linked evidence cannot be hidden by a valid sibling.

Public contract: retain synchronous evaluateClosure(card, runJobs, runRecords, draft) for existing callers; an optional fifth CodeChangeObjectLoaders is used only for code_change, with missing loaders returning a controlled failure. CodeChangeObjectLoaders supplies readChange(ChangeId): unknown, readPatch(ChangeId): Uint8Array and readVerification(VerificationId): unknown. CodeChangeClosureLoaders extends these with listRunJobsByTask(TaskId): readonly ClosureRunJob[], runRecords: readonly RunRecord[] and draft: ClosureDraft. This list is an injected, already prepared snapshot enriched with explicit collect_error_attempts, not a direct binding to the asynchronous registry. The direct codeChangeClosure(card, loaders) calls it once. The facade adapts its existing run inputs; science_assist never invokes object loaders. #541 owns async preparation, readonly filesystem adapters and the fresh-card/reconcile boundary.

One internal task-closure module owns existing clauses 0/5 and their types; the facade and code predicate reuse it without runtime circular imports or a fake science_assist card. Existing science_assist results, automatic_limitation, metric_fact, failure ordering, ambiguity/count handling and unsupported engineering/ops behavior remain unchanged. Code-specific failures name clause 0/1/2/5 or a controlled read/identity failure, with branded change_id/vc_id/run_id/job_id where relevant. Schema-invalid reviewer fields are a read failure, not clause 3. No raw exception/cause, prose or unvalidated identifier enters diagnostics.

Read each distinct linked CR and VC once, validate the core schema and requested embedded ID, and require this task's ownership; malformed or foreign linked records block even when another pair qualifies. Do not scan directories or request unlinked objects. Proposed CR records are validated but cannot satisfy clause 1; read/hash patches for every approved CR candidate, not proposed CRs. A required patch read/type/hash failure blocks with clause 1 and change_id, including when a second approved CR is valid. Exact Uint8Array-view bytes are hashed; no normalization or repair.

Clause 2 examines terminal passed/failed VCs tied to the same qualified approved CR. Each referenced run must map unambiguously to a task-owned snapshot RunJob whose job_id is in linked_jobs. Missing, foreign, ambiguous or unlinked bindings name vc_id/run_id and job_id when known. Valid ineligible/nonterminal alternatives are not global failures when another witness qualifies; if none qualifies, report clause 2 and the relevant candidates. Independently, all linked jobs undergo the shared original run predicates, including retained collect exhaustion despite a successful RunRecord. Clauses 3/4 are enforced by the existing schemas, not duplicated policy checks.

Transition ownership: add only change_create. A planned code_change card becomes running/running_local; an already running card keeps status/runtime_phase while the accepted transition retains normal updated_at ownership. Other task types yield a controlled invalid_task_type error; other states yield invalid_transition. shud_build/change_submit/verification_run remain invalid_event at this layer and cannot read the clock or mutate the card. Tool-owned link updates and no-write/persistence ordering remain outside this helper.

Sibling surfaces: task-closure.ts and its 409-line legacy tests; task-transition.ts and its closed event matrix; task-reconcile.ts; records public index/typechecks; tools report-generate.ts, report-workflow.ts and shud-run.ts consumers (unchanged); core CR/VC schemas and readonly workspace readers; CONTEXT.md invariant 11 and one new companion invariant. No core/tools/jobs source change or generated projection change.

Verification: thirteen closure/five state scenarios plus alternative-witness and corrupt-sibling tests; real readonly adapters for missing/malformed/schema-invalid/unsafe/identity-mismatched files with unchanged bytes/mtime/inventory; missing loader, loader throw and private-payload diagnostics; all run and transition compatibility cases; frozen pre-change built M3 outputs; built direct/facade code closure, transition and readonly-file smoke; full default check, strict OpenSpec, unchanged 31 generated hashes, three-seat review and same-SHA CI. These are domain evidence, not report-tool execution or PI acceptance.

#### Issue #520 implementation boundary

Change surface: TaskCard schema, focused schema tests, TaskCard registry example and generated projection; minimum literal additions at existing typed writers only where required.

Governing invariant: parsing old M3 cards supplies new nullable/array fields without changing stored evidence; after defaults, source_base_commit is present exactly for code_change.

Must preserve: old raw input fixtures, read-only file bytes/mtime, all prior TaskCard field constraints, optional fields and root/nested unknown-key stripping. Schema link arrays validate brands but preserve input order and duplicates.

Must add: code_change enum member; ChangeId/VerificationId links defaulting to fresh empty arrays; lowercase40 source_base_commit defaulting to null; post-default type/commit equivalence with field-specific error.

Sibling surfaces: core public index and run-identifiers types; records/test-harness.ts legacy taskCase; records/workspace-records.ts readonly parser; records/createTaskCard and tools/task-create.ts typed writes; generator registry/self-test; existing lifecycle/reconcile/closure tests.

Output migration: legacy input bytes remain frozen, while parsed output intentionally gains three defaults. Update broken output-only assertions to check preserved old values plus new defaults; never modify disk fixtures or weaken path/identity/security checks to hide this change.

Seams under test: source TaskCardSchema and built public core index; actual built readWorkspaceRecord readonly path; existing task_create's science_assist-only behavior remains unchanged.

Required evidence: task fixture boundary matrix, positive legacy missing-key parse, semantic failing-before/passing-after tests, real scratch file unchanged after readonly parse, generator changes limited to two TaskCard files, full check and same-SHA CI.

Non-goals: task_create code_change/HEAD pinning, links writer sorting, TaskCard transitions/closure, other object fields, filesystem migration/rewrite, host or profile behavior.

Review focus: default application precedes refine; all non-code types reject commits; arrays retain order/duplicates and reject bad brands; old evidence not rewritten; typed-writer changes are literal-only.

### D8 `verification_run` 工具契约与交叉校验

- 参数：`task_id`、`base_run_id`、`candidate_run_id`、`reviewer_notes`（非空字符串数组）、`compatibility_verdict`（`compatible|incompatible|unknown`）。
- 交叉校验（任一失败即错误、零写入）：卡 `type: code_change`、`status: running`；两个 run 经 `collectShud(id, {readonly: true})` 只读取得 RunRecord（不触发收集），均 `status: succeeded`、`task_id` == 参数 `task_id`、`project` 相同，且其 `job_id` 都在卡的 `linked_jobs` 中；候选 RunJob 的 `build_id` 非 null，其 BuildRecord `task_id` 相同、`change_id` 非 null 且该 CR `approved`、`task_id` 相同；base RunJob 的 `build_id` 非 null，其 BuildRecord `task_id` 相同、`change_id` 为 null、`rhs_openmp: false`（serial baseline）；两个 BuildRecord 的 `source_commit` 都等于卡的 `source_base_commit`；两个 RunJob `threads` 均为 1；两个 RunJob 的 `binary_sha256` 分别等于各自 BuildRecord 的 `binary_sha256`（运行的就是记录的二进制，见 D9）；两个运行的 DataProvenance `files` 与 `external_files` 的 `(path, sha256)` 集合相等（同一输入）。`reviewer_notes` 任一条命中 `wording.ts` 禁止用语 → 工具错误（它们会被渲染进报告，与模型撰写节同一护栏）。VC 的 `change_id` 取自候选 BuildRecord。
- 比较：`<run_dir>/output/<project>.out/<project>.rivqdown.dat` 两者均为普通文件（`lstat`），分别计算 sha256；相等 → `passed`，否则 `failed` 且 `failure_reason` 为两 sha 不等的受控文本；文件缺失/非普通文件 → 工具错误（不是 `failed`：缺证据不等于判定）。不读取数值、无容差、不比较其它产物。`artifact_refs` 记为相对会话 cwd 的两个路径，供 `report_validate` 第 (15) 项复核。
- 持久化：`verifications/<vc_id>.json` 原子写 → TaskCard `linked_verifications` 追加。同一对运行可重复生成新 VC（id 不同），不改写旧 VC。
- 为什么 reviewer 触发而不是 collect 自动：grill 决定；比较需要两个终态运行与 reviewer 结论字段，自动路径无从填 `reviewer_notes`。

#### Issue #540 implementation boundary

Change surface: one registered strict verification_run tool and its narrow internal evidence helpers, plus raw-guard fixed verifications/exact TaskCard targets. Existing records/jobs/core contracts are consumed unchanged. Use the already-shipped readonly collect option; do not create a second retrieval seam.

Validate all branded ids, notes and compatibility enum before tool-owned IO/query. Preserve nonempty strings verbatim, scan the canonical forbidden phrase list, report a controlled note index rather than echoing arbitrary authored text. Known off-role denial remains the existing global policy's responsibility; reviewed_by comes from readCallerPresetId's current projection, not the creation header or a hardcoded reviewer.

Read an eligible code_change/running card readonly, obtain indexed RunJobs through listRunJobsByTask and existing RunRecords through collectShud(id, {readonly:true}); never reconcile, poll, collect a new result, touch retry ledgers, notify or scan unindexed runs. Bind requested run_id/job_id/task identity, require successful RunRecords and linked jobs, and compare project from the identity-bound RunJobs: the existing RunRecord schema has no project field. Do not add a schema field or infer project from argv. Missing/null build or provenance references fail closed.

After asynchronous evidence retrieval, reread and validate the current card before the synchronous validation/comparison/publication stretch. Current pin, links, status and all unrelated fields must survive; reject newly ineligible/unlinked/mismatched evidence before any publication. No new task queue or cross-process snapshot guarantee.

Resolve the session workspace and both run roots physically, retaining symlink-plus-parent traversal semantics, and require each run root to equal the physical cwd/runs/<requested-id> target. The caller owns the output ancestor namespace: check ordinary output/project directories before the comparator; do not let an ancestor link redirect evidence outside the bound run. Reuse the shared project-component grammar before forming project-derived paths. Final-file identity, bounded hashing and descriptor cleanup remain compareRivqdown-owned.

Load canonical BuildRecords, candidate CR and DataProvenance readonly and enforce every D8 predicate. The provenance comparison is mathematical set equality over (path,sha256) pairs from sources.files plus sources.external_files: order and duplicate entries do not change the set. Internal paths remain relative and external paths absolute under the existing schema, so an identical pair cannot migrate between those collections. Do not normalize paths, drop external entries, compare whole provenance ids or collapse pairs by path alone.

Call compareRivqdown once after preflight. Equal bytes produce passed/null failure_reason; unequal bytes produce failed with both observed digests. Missing/unsafe/unreadable evidence throws a controlled tool error and creates no verification directory, record or task link. compatibility_verdict and notes do not override the deterministic status.

Create the complete core-valid regression/baseline_regression record through createVerificationCase: null bundle, candidate build's change_id, CR files_changed targets, fixed descriptive/expected/pass text, exact base-then-candidate relative artifact refs, current preset and unchanged authored fields. That existing publisher owns allocation, first-plus-three collisions and exclusive atomic publication. No custom writer or overwrite path.

Only after the VC commits, reread the eligible card and synchronously merge the actual allocated vc_id into sorted deduplicated linked_verifications with updated_at; preserve status/runtime_phase and other fields. A write-back failure names and retains the committed vc_id; no rollback or automatic repair. Repeated pairs create new cases; an unequal comparison is a successful recorded failed verdict and still links, unlike a preflight/comparison error.

Raw checks remain metadata-only and prior to policy/tool execution: verifications plus tasks/<validated-id>/task.json, falling back to tasks for missing/invalid/unavailable argument identity. Separate argument extraction fallback from physical-resolution errors; do not repeat routed #590's getter behavior or change unrelated tool branches. Existing aliases, missing ancestors, rawDirs ordering and unrelated sibling cases remain intact.

Sibling surfaces: report-generate.ts's fresh-card pattern, change-create.ts's exclusive-object/link ordering, tools/index.ts/strict-tool.ts, raw decide.ts's change_submit extraction split, core wording/current-preset helper, records workspace publication/comparator, jobs readonly collection/listing, and existing task/report/raw tests. Use existing real ToolRuntime, seedQueryRun/makeRunRecord and workspace-record fixtures without modifying shared executable symlink targets.

Verification: vertical passed, unequal and missing-evidence/raw loops; then both-side cross-object rejection matrix, exact readonly snapshots, fresh-card interleavings, native file/link/FIFO failures, exclusive collision exhaustion and retained write-back failure. Independent built-plugin smoke must observe durable VC and links, unchanged run evidence, and missing-output error with no new publication. Full default/profile/raw/guardrails/strict/generated gates and three review seats complete engineering delivery; no scientific or PI acceptance claim.

#### Issue #532 implementation boundary

Change surface: add synchronous compareRivqdown(baseRunDir:string,candidateRunDir:string,project:string) to records/public index; extract the existing hashDescriptor(fd):string loop from workspace-records.ts into an internal hash-descriptor.ts module shared by the comparator and verifyBuildBinary. The live issue records this minimal records-only reuse boundary; do not expose a new public hash API or duplicate the loop.

Governing invariant: return a byte-exact SHA256 comparison only when both selected rivqdown targets are valid ordinary-file evidence and both reads/descriptor closures succeed; missing or unsafe evidence is an error, never a failed scientific verdict.

Input and result: validate both roots as absolute strings and project through core isProjectComponent before constructing targets or issuing filesystem calls. compared_path is exactly the POSIX relative path output/<project>.out/<project>.rivqdown.dat, preserving accepted project spelling. Return only {compared_path,base_sha256,candidate_sha256,equal}, with lowercase64 hashes and equal determined solely by their equality. Empty/binary files are valid; numerically equivalent text with different bytes is unequal.

Path boundary: append the relative target to each supplied absolute root without lexically normalizing away aliases followed by "..". Final-target lstat must find a non-link ordinary file; preflight both targets before content hashing. Absolute run roots and ancestor namespace ownership remain the caller's responsibility: do not add recursive ancestor rejection, canonical-root pinning, repository checks or new directory creation. Root aliases/trailing separators may retain native traversal semantics; the final file itself cannot be a symlink.

Descriptor boundary: open each preflighted target with O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat and match ordinary type/dev/ino before reading. This rejects final replacement with links/special/different files between inspection and open without hanging on a FIFO. Hash through the existing bounded descriptor primitive, then close before opening the other file. Use controlled stage/path errors for lstat/open/fstat/read/close and cleanup failures; do not attach raw native causes or data. Failed reads produce no result. Preserve a primary controlled failure when cleanup also fails.

Canonical reuse: move the existing 64KiB readSync/SHA256 loop unchanged into the private module. verifyBuildBinary retains its X_OK/execute-bit checks, descriptor identity, native-error wrapping and cleanup protocol; only its helper import changes. Provenance streaming lifecycle is a different existing IO protocol and is not refactored here. No configurable buffers, retry framework or generic filesystem abstraction.

Sibling surfaces: records index, workspace-records verifyBuildBinary and workspace-build-binary.test.ts; workspace-paths regularTarget; core project-component and VerificationCase observed relative-path/digest schema; future verification_run consumes the result and owns cross-object/run identity checks. No current production comparator consumer exists.

Required evidence: independently pinned empty/ASCII/binary/large digests; equal/different/same-path results; missing base or candidate, final symlink/dangling link/directory/FIFO, invalid project/root pre-IO failures, physical alias/parent traversal, accepted Unicode/space/metacharacter project spelling, no unrelated artifact/log reads. Check descriptor type/identity replacement and injected open/fstat/read/close faults, bounded reads, controlled diagnostics and input bytes/mtime unchanged. After open/fstat/read failures whose cleanup succeeds, assert descriptor closure and no leak. Persistent primary-close or cleanup-close failure instead requires a controlled stage/path error, no result/raw native cause, and preservation of the primary error; descriptor state/ownership is unknown, never reported as closed or leak-free. Test-harness recovery of its descriptors is separate from behavioral evidence. Existing binary-verification regression suite and 31 generated artifacts stay unchanged.

Oracle and runtime: parent qualified a temporary system-shasum reference against identical, byte-different/numerically equivalent, missing and symlink evidence; candidate-ignored and missing-as-unequal mutants fail semantic assertions, then reference restoration passes. This is independent judge qualification, not production RED; tests are added before the missing public API is implemented. Built public API smoke must perform the same comparisons and rejections on real files, followed by full check/profile smoke/strict fixture/white-box review/same-SHA CI.

Non-goals and rollback: no numerical parsing/tolerance, solver execution, logs/stats comparison, VerificationCase publication, new permissions/approval or scientific/PI claim. Descriptor binding observes bytes now; it is not snapshot isolation against concurrent content modification and does not validate caller run identity. Existing D8 is the decision record; normal PR revert is rollback.

#### Routed issue #574 implementation boundary

Change surface: move isProjectComponent(project:string):boolean from jobs/shud-input.ts to core/project-component.ts and export from core/index.ts; prepareInput and shud-collect import directly from core. Remove the old definition/export rather than adding a shim. New focused core behavior tests cover the same predicate; no records production consumer until #532.

Governing invariant: one implementation, identical results for every accepted string input, and unchanged caller validation order/error/filesystem effects. The exact old expression rejects empty, exactly "."/"..", slash, backslash and NUL. Whitespace-only strings, embedded newlines, Unicode, shell metacharacters, ".hidden", "a..b" and "..." remain valid components; this is a path-component check, not a shell/solver syntax policy.

Ownership: domain core is already depended on by both jobs and records; adding records→jobs would create a cycle. Do not tighten RunJobSchema.project, whose nonempty-string shape remains separate. The helper still takes string, not unknown, and does not become a schema/type guard or perform IO.

Cutover and sibling surfaces: both existing callers keep their current local parsing/guard placement, controlled errors and cleanup behavior. prepareInput checks before cwd/input filesystem traversal; collection checks a parsed terminal job before exit/output reads. Public core entry, jobs package dependencies and future records import all resolve the same implementation. LSP references were attempted and unavailable; targeted search found exactly the definition and two consumers.

Equivalence evidence: .workplans/issue-574/reference-baseline.json freezes the actual old callable predicate for 830 deterministic strings and 21 independently specified positive/negative examples. A disposable mutant omitting backslash rejection fails 142 inputs; one rejecting whitespace/semicolon/embedded dotdot fails 227; the original reference then passes again. These are semantic qualification failures, not import/setup errors or changes to production. Add core behavioral tests before the move, temporarily targeting the existing predicate only for the pre-cutover check; final committed tests import core and contain no jobs dependency. Reuse the frozen output corpus in a throwaway built smoke, never in permanent tests.

Runtime evidence: actual registry submit/collect safety regressions remain green, including pre-side-effect rejection; actual detached-script submission with tiny and metacharacter project preserves input, argv and canaries. Built core import resolved from records can evaluate the full frozen corpus. A final namespace check confirms the old jobs export is absent; this is throwaway cutover evidence, not a permanent wiring test.

Resource/error boundaries: no new streams, allocations, disk operations, retries, logs or exception handling. Existing filesystem safety/record rollback stays with jobs. No scientific syntax, permissions, schema, configuration, package version or generated-document changes. All 31 generated artifacts must remain byte-identical.

Execution and rollback: the exact small move and compact pure-case tests are mechanical parent edits; three read-only review seats and same-SHA CI independently accept them. Existing D8/project-path contract and this routing record document ownership; no new ADR required. Normal PR revert is rollback, not a retained alias. Shared M4 change remains active through PI acceptance.

### D9 build 与 run 的绑定：`shud_run(build_id, threads)`、StackLock、RunJob（Critical Path #4 局部）

- `shud_run` 新增可选 `build_id`（品牌 `BuildId`）与 `threads`（正整数）。注册表在输入复制之后、StackLock 采集之前解析 `builds/<build_id>/build-record.json`（schema 校验、`task_id` 与本次相同或本次无 task）、校验 `builds/<build_id>/shud` 为普通可执行文件且 sha256 == `binary_sha256`，随后把它原子复制为 `<run_dir>/bin/shud`（临时文件 + rename，0755）并让包装进程执行该副本（关闭"校验后、执行前被替换"的窗口，运行目录自包含）；RunJob/RunRecord 新增 `binary_sha256`（非 null 当且仅当 `build_id` 非 null；M2/M3 记录缺该键按 null 解析，iff 约束在默认值之后求值）。任一失败走既有提交回滚（不留运行目录）。无 `build_id` 时执行与二进制选择逐字节沿用 M2/M3 路径（DataProvenance 的 `tsd.forc` 解析除外，见 D10）。
- `threads` 提供时，包装进程环境追加 `OMP_NUM_THREADS=<n>` 与 `SHUD_RHS_THREADS=<n>`；不提供时不设置（继承宿主）。RunJob/RunRecord 新增 nullable `build_id` 与 `threads`，collect 原样继承。M3 规范中"`threads: 4` 为未知参数"的场景改为"`threads: 0`/非整数被拒绝"。
- StackLock：引用 build 时 `repos.SHUD` = BuildRecord 的 `{source_commit, source_branch, dirty: dirty_paths.length>0, dirty_paths, dirty_paths_truncated:false}`，`build_id` 字段为该 id 并进入指纹；无 build 时 `build_id: null`、`repos.SHUD` 仍采根 submodule。因此 base 与 candidate 运行必然得到两个不同的 StackLock；报告逐 lock 列出。`rSHUD`/`AutoSHUD` 不变。
- raw-guard：`shud_run` 的三写入根判定不变；`builds/` 是读取源，不纳入写入根。

#### Issue #539 implementation boundary

The existing tool adds only optional build_id and threads to its closed parameter surface; output remains the same five running-job fields. Validate BuildId with core and supplied threads with the existing core RunJob field constraints, rejecting persisted null/default forms as explicit request values. Perform both validations before listRunJobsByTask, TaskCard reads/reconciliation or any submission filesystem work. This preserves the former unknown-argument side-effect-free behavior for invalid new inputs, including a valid supplied task_id. Do not change old context/model/project/task error ordering beyond inserting these pure checks.

The native ToolRuntime requires losslessly JSON-serializable arguments before plugin admission: explicit JavaScript undefined, NaN and infinities are rejected by that transport boundary without task or submission IO. They do not become omitted values or parameter-specific plugin errors. Omitted JSON keys remain the supported tool absence form; #534's direct registry request still independently treats undefined as absent. Do not strip/coerce arguments or change the host to manufacture a successful non-JSON tool call.

Forward only supplied, validated values in the existing submitShud request. No tool-level build lookup, source/hash/task ownership validation, environment merge, binary copy, retry or backend fallback. Threads and build selection are independent: build-only records null threads and inherits the host; threads-only uses configured shudBin and records null build_id/binary_sha256. Both omitted never inspect builds and do not add either thread variable; existing host thread values remain inherited rather than erased.

Reuse the #534 canonical BuildRecord fixture and real executable bytes in tools tests rather than creating a second backend or fake forwarding oracle. A configured fallback executable and build executable must be observably distinct; inspect the actual run-local invocation/threads, durable RunJob and collected references. Never overwrite the shared fixture script through h.shudBin: unlink only the fixture-owned symlink before installing owned alternative bytes, or use the existing installer.

Unknown-build and hash-mismatch failures must surface through real ToolRuntime with no run directory/registration/index or newly captured stack/provenance, preserving input/build bytes. The registry owns rollback; do not fix backend code in this slice. Invalid-value tests prove no workspace IO even when task-linked reconciliation would otherwise run. Add no-task build and independent-thread combinations, preserve old task-link/id/model/label behavior, and retain existing default-path tests.

For omitted end_days, construct only a synthetic keliya-shaped cfg/input fixture with START/END and NUM_OPENMP lines plus valid self-contained forcing metadata; compare the full copied cfg bytes with the original. Do not import basin data or edit a submodule. Raw tests mount the existing guard and prove builds as a read source does not become a write root, while runs/stacks/provenance remain denied when raw. No new raw read/approval policy is introduced.

Sibling surfaces: shud-run.ts, strict-tool.ts, shud-run-validation/task/guard/path/context/lifecycle/rollback tests, existing tools harness; canonical jobs shud-input/shud-submissions/shud-build/detached execution and #534 build tests (read-only). Parent built-plugin smoke composes actual task_create/code-change pin, shud_build fake-Makefile executable and shud_run build/threads to prove the user-facing input chain; it is not a real solver, Web or PI acceptance test. Full check, profile smoke, strict fixture, unchanged generated schemas, three-seat review and exact-head CI remain required.

#### Issue #534 implementation boundary

Change surface: SubmitShudRequest and PreparedInput in jobs/shud-input.ts (registry imports the type), prepareInput, shud-submissions.ts, detached-shud.ts, shud-collect.ts and jobs integration tests. A focused internal jobs binary-preparation module is permitted; use public records readWorkspaceRecord/verifyBuildBinary/captureStackLock/generateProvenance rather than importing records internals or reimplementing their object validation.

Governing invariant: before first created publication, the command, build_id/binary_sha256, independent threads, StackLock source and provenance identify the executable/input combination that this run will use. Before successful preparation there is no producer or wrapper; post-publication fields survive all transitions and collect unchanged.

Preflight: explicit invalid build_id or threads rejects before even realpath/lstat, reservation or input inspection. Undefined means absent; null is not an optional request value. Validate BuildId through core and positive safe integer threads through the existing core field constraints without accepting its persisted null/default form as supplied input. Keep all old preflight order and path/overlap constraints.

Transaction: copy complete input and optionally patch END, then readonly load the requested BuildRecord, bind embedded id, and require its task_id to equal the request when supplied. No task_id accepts a task-owned build and records null. Call verifyBuildBinary for ordinary/effective-executable/hash validation. Prepare a newly owned bin directory and temporary binary, publish bin/shud by rename with final mode0755, and verify copied bytes against the BuildRecord before capture or first created write. Use its absolute run-local path as argv[0]; never execute the builds source or fall back to configured shudBin after a build error.

Copy safety/resources: safely acquire the source without following its final symlink or reading a special file, keep memory bounded, and close/drain owned copy/hash resources before publication success or ordinary rollback. Preserve the existing run-root/directory ownership checks across asynchronous work; never delete or continue writing through a replaced run. Source/build-directory safety remains enforced by canonical readonly records checks and copy acquisition. A failed close cannot be reported as proven closed; cleanup uncertainty remains an error, not a successful run. No new retries or generic copier/hash API; this is not arbitrary concurrent-writer snapshot isolation.

The no-new-retry rule applies to newly introduced jobs copy/hash resources. Existing records verifyBuildBinary retains its established close/cleanup behavior, including its catch-path close attempt; consuming it here does not authorize a records refactor. Fault evidence distinguishes that existing helper from new copier ownership and never treats a failed close as proof of descriptor release.

After preparation, pass the validated BuildRecord to captureStackLock's existing third argument, then use generateProvenance on the copied input. Do not reorder immutable lock publication or remove any lock during rollback. Build-validation/copy failures occur before stack/provenance publication; forcing/provenance or later failures may retain a newly created or reused lock, as before. Remove only owned run/bin and this submission's provenance/index when safe; cleanup failures retain evidence/reservations under existing fail-closed semantics.

Threads are independent of build selection: supplied n overlays both OMP_NUM_THREADS and SHUD_RHS_THREADS with String(n) on the inherited host environment, without mutating process.env or losing unrelated variables. Omitted threads leaves spawn environment inheritance unchanged, including existing values. This clarifies the live issue's former shorthand “no build => three null”: only build_id/binary_sha256 depend on build; no-build plus omitted threads has three nulls.

No-build path never inspects builds, even if it is absent, a broken symlink or otherwise unsafe; no bin is created and configured shudBin/positional wrapper argv remain unchanged. All submissions already use #530 forcing parsing; do not recreate it here. New three fields must be explicit in first created RunJob and copied into the collector's newly constructed RunRecord, not silently reset by schema defaults.

Sibling surfaces: registry admission/drain, shud-input preflight, producer's prepared RunJob, all submitted/running/terminal/recovered transitions, detached wrapper environment and positional argv, collector existing-record reuse/new generation, records build reader/verifier and capture APIs, current submit-shud capture/fault/ownership tests. Preserve D7, abort-before-file-removal, stateDir lock lifetime, strict exit evidence and notification behavior; no new lifecycle service.

Required evidence: configured fake solver exits13 but build copy exits0, echoes exact absolute $0 and threads; base/candidate StackLocks match BuildRecord sources; created fields precede producer; terminal collect inherits them. Source build mutation/deletion after submission cannot change run-local bytes. Test no-task build, no-build+threads and omitted-thread inherited environment, no-build unsafe builds, invalid values before fs, all build record/path/mode/hash/copy/rename/chmod/copy-hash failures, forcing missing/invalid/external failures, later rollback, owner replacement and accepted-copy drain before unlock. Preserve original/build/external input bytes/mtime and unrelated evidence.

Built public registry smoke uses real Cordis and detached executable fixtures, not mocked spawn; real shud:tiny and shud:first-task prove no-build ccw and Web chain compatibility after the change. Shell credentials remain environment-only. Full check, profile smoke, strict OpenSpec, unchanged31generated, three white-box seats and same-SHA CI are required; engineering automatic approval is not PI acceptance.

Non-goals/rollback: no build producer, tools schema, governance root changes, records/schema edits, new binary provenance format or scientific claim. Normal PR revert, no parallel implementation. Existing D9/D10 are the decision record.

#### Issue #531 implementation boundary

Change surface: extend the existing synchronous captureStackLock(config, llm, build?: BuildRecord) in place. Add focused build-source cases in a separate test file because the existing capture suite is already 664 lines. No production caller change until #534; the existing two-argument API remains its own no-build path, not a compatibility shim.

Governing invariant: a build-backed lock identifies the exact supplied BuildRecord build_id and source observation while preserving the unchanged runtime, harness, LLM, other repositories and immutable lock-store semantics.

Ownership: the optional third argument is already schema-validated by its caller. Do not read builds/, parse BuildRecord again, check task ownership or binary bytes, or collect configured SHUD Git metadata when it is supplied. Existing configuration validation still requires all configured repository paths to be absolute strings; a valid absolute configured SHUD path need not exist or be a Git repository in build mode. rSHUD/AutoSHUD are always collected normally and retain path-bearing controlled failures.

Projection: build_id is build.build_id; repos.SHUD is exactly {commit:source_commit, branch:source_branch, dirty:dirty_paths.length>0, dirty_paths, dirty_paths_truncated:false}. Do not sort, truncate, mutate, substitute current HEAD or infer dirty contents. The schema-valid output is detached through the existing StackLock validation. Other BuildRecord fields are deliberately not copied into the lock.

Publication: keep existing candidate/full StackLock validation, core fingerprint, matching-lock scan, smallest-id selection, existing-entry validation, wx write/fsync/close and three-total-attempt allocation unchanged. Invalid projected values fail before a new lock file is published; directory creation and entropy ordering remain existing behavior, not a newly promised side-effect-free preflight. Repository collection failures precede lock-directory creation as before.

Compatibility: no build means build_id:null and unchanged three-repository collection/runtime/harness/LLM fields. Core already excludes null build_id from the M3 fingerprint. A persisted M3 lock lacking the field parses to null and must be reused without rewriting bytes/mtime, retaining original response_model/created_at. Same build and environment reuse; distinct build IDs distinguish locks even when all source metadata is identical.

Sibling surfaces: records public index and StackCaptureConfig/StackCaptureLlm; jobs registry Config inheritance and shud-submissions.ts two-argument call; submit-shud-capture/faults tests; records package-boundary consumer; core BuildRecord/StackLock schemas, repository collector and computeStackFingerprint; unchanged workspace-records/path/state ownership. LSP references were attempted and unavailable; targeted reference search identifies these consumers.

Required evidence: base clean and candidate full dirty-path projections; same-source different IDs give distinct fingerprints, repeated same build reuses bytes/mtime, configured SHUD missing/dirty/invalid repository is not inspected in build mode, other two repositories still fail closed. Include caller-input immutability, full lists beyond small fixtures, invalid projected id/path rejection with no new lock, prior corrupt lock and smallest matching id through build mode; existing collision/cleanup/resource tests remain intact. Frozen actual old-built no-build/M3-shape reuse and independent canonical digest replay; built public API captures both builds and reads persisted locks without a builds directory; full check, unchanged generated files, runtime profile smoke, strict fixture, white-box review and same-SHA CI.

Non-goals and rollback: no build/schema/fingerprint/config redesign or producer transaction, no solver run/PI assertion, no new cross-process safety guarantee. Revert the PR normally if needed; do not preserve duplicate implementations. Active fixture/API comment document the narrow contract; existing D9 is the decision record.

#### Issue #521 implementation boundary

Change surface: StackLock schema/fingerprint and their tests, registry example, generated projection; minimum captureStackLock build_id:null literal if required by output typing.

Governing invariant: a missing/null build reference preserves the exact M3 fingerprint and reuse identity, while each non-null build reference participates in canonical environment identity.

Must preserve: existing M3 fixed hash/canonical bytes; all prior exclusion/sensitivity rules and UTF-16 object-key ordering; strict schema and canonical repository paths; original legacy file bytes/mtime; capture selection, collision, error and directory-safety behavior.

Must add: BuildId|null defaultnull schema output; conditional null exclusion in fingerprint; input type permits only the additional legacy omission; independent non-null fixed vector.

Sibling surfaces: public core exports and fingerprint callers; records/capture-stack-lock.ts Environment/candidateSchema/matchingLock; records/workspace-records.ts readonly parser; raw stackCase fixture and existing capture/allocation tests; registry/discovery/selftest.

Evidence identity: the M3 fixed vector remains974a68b60908c59c718e3e4e84a9a7f5af2e079337bc0450be529f06fbb64948; the independent build vector isb0dfc39447ff3685933c7db596191d9202b9e3c4ea8f86c5515b9d3e25d5bc19 for BUILD-20261102T080000-3f9c. Neither expectation comes from the production hashing function.

Seams under test: public built schema/fingerprint, true readonly workspace read, and actual capture reuse of a pre-change lock in an unchanged temporary three-repository environment.

Required evidence: null/missing equality and fixed M3 digest; two distinct build IDs and non-null fixed digest; original sensitivity/exclusion regressions; malformed brand field errors; read/reuse without bytes/mtime/file-count changes;29sibling projections unchanged.

Non-goals: BuildRecord-derived repo metadata, job submission, binary validation, tool arguments, report facts, profile or scientific conclusions.

Review focus: null-only exclusion (never unconditional build_id exclusion); no broad input-type weakening; unchanged serialization algorithm; legacy evidence remains raw; capture adaptation is literal-only.

#### Issue #522 implementation boundary

Change surface: RunJob/RunRecord schemas, focused schema tests, generated examples/projections; only minimum null literals at typed jobs writers if required.

Governing invariant: after defaults, build identity and binary digest are either both null or both present on either record type, independent of execution status or thread annotation.

Must preserve: raw M2/M3 missing-key fixtures and file bytes/mtime; RunJob running pid/start checks; RunRecord exit triple, artifact paths, measurement and provenance constraints; original required fields and strict object shapes.

Must add: branded nullable build_id, independently nullable positive-integer threads, nullable lowercase64 binary_sha256; default each to null; field-specific iff failure on binary_sha256 for all valid statuses.

Sibling surfaces: source/public schema exports; existing core-schemas.test.ts fixtures and required-field checks; jobs submission/collector typed record construction and readonly file consumers; registry/selftest; generated RunJob/RunRecord projections.

Control-flow boundary: RunJob's current running-only early return must not skip the new iff for submitted/collected or other statuses. Append an independent refine or place the relation outside that branch without changing the old pid check.

Compatibility boundary: old raw inputs remain missing the new keys; parsed outputs intentionally add defaults. Adapt only observed output assertions or minimum writer null literals; never populate old fixtures to hide missing-key behavior.

Seams under test: built core schema parsing of actual legacy JSON file reads and public valid/invalid records; this does not claim registry, collector, recovery, or submission behavior for non-null build fields.

Required evidence: both schemas' null/build/partial-missing/invalid cases, all-status iff, independent threads validity, semantic RED/GREEN, unchanged legacy file evidence, only four generated artifacts changed, full check and same-SHA CI.

Non-goals: build lookup/copy/hash computation, execution thread environment, collect inheritance, tool parameters, process/state/index/notification transitions, scientific claims.

Review focus: defaults before iff; no accidental status gate or threads coupling; old predicates and raw evidence preserved; consumer adaptations literal-only.

### D10 DataProvenance 的外部 forcing 引用

- `generateProvenance` 在遍历副本后解析 `<copied input>/<project>.tsd.forc`。第 2 行为 forcing 目录，相对路径按运行目录解析后取 realpath；随后按 SHUD 的目录 + `/` + `Filename` 拼接逐个引用，保留物理 `..` 语义、逐组件拒绝链接并要求最终普通文件。按每个文件的规范绝对路径与输入副本规范根比较：内部引用由 `files` 覆盖，外部引用逐个哈希/计字节，规范路径去重、码点排序写入 `sources.external_files`。不再以 forcing 目录在副本内作为直接返回 `[]` 的条件。该修订来自用户明确选择“支持路径，逐文件归类”；rSHUD 的 fallback/tilde/绝对 Filename 覆盖语义不适用。任一目录/引用缺失、非普通文件、链接或 manifest 解析失败均中止生成，不发布空/部分结果；提交回滚仍由既有 jobs 调用方负责。M3 记录 default([]) 读取不改写；该新输入检查也作用于无 build 提交。
- `external_files` 的路径可能指向 `data/raw` 之外的任意只读目录（keliya 在 `../openMP`）；raw-guard 对 `shud_run` 的 `input_dir` 判定不变，不对外部 forcing 目录做 ask（它不是参数，也不被写入）。

#### Issue #530 implementation boundary

Change surface: generate-provenance.ts and focused parser/path/resource tests, with the canonical Minimal_Schemas provenance paragraph aligned to this user-authorized contract.

Governing invariant: every manifest-referenced ordinary file is accounted for either by the copied-input inventory or by a canonical external digest entry; no invalid reference can become a successful empty or partial inventory.

User decision: “支持路径，逐文件归类” replaces the former directory-only shortcut. SHUD MD_readin.cpp concatenates directory + "/" + Filename; do not use rSHUD read_forc_fn's manifest-location fallback, tilde expansion or absolute-Filename override. Leading separators in Filename therefore do not replace the forcing directory. The forcing directory itself is realpath-normalized and must be a directory; subsequent reference components are checked without following links.

Parsing: consume manifest bytes incrementally after copy inventory, with strict UTF-8 decoding and LF/CRLF plus final unterminated-line support. The first whitespace-delimited token is a complete, nonnegative safe decimal integer; later first-line fields are not solver/date-validated. Zero stations is allowed only with zero data rows and a valid directory/header. The directory is the whole trimmed second line, preserving internal spaces required by the existing custom-project fixture. Header must end in Filename; each nonempty data row must have the header's column count. Count rows before deduplication; do not validate other scientific columns or invent quoted/CSV grammar.

Path resolution: preserve raw component traversal rather than lexically collapsing a/.. before checking a. Starting at the canonical forcing directory, require each intermediate normal component to be a non-link directory, process dot/parent components physically, and require a final non-link regular file; trailing slash/dot/parent spellings cannot turn a directory or link into a file. Canonicalize actual spelling with native realpath, compare to the native copied-root spelling, and deduplicate canonical absolute paths only after validating every reference. Hardlink aliases with different canonical paths remain distinct referenced paths.

Classification: a forcing directory inside the copy may reference outside via .. and must then produce external evidence; a directory outside may reference back inside and must not duplicate internal files. All referenced files, including internal ones, must exist and be regular. Resolve/check the complete reference set before external content hashing; only referenced external files are streamed, never an external directory inventory. Sort by codepoint using once-encoded UTF-8 path keys, not locale/UTF-16 order or per-comparison encoding.

Resource/error ownership: preserve one active stream and await its close on success/failure. Reuse one stream-consumption lifecycle for inventory hashing, incremental manifest parsing and external hashing, instead of adding whole-file reads or a second resource protocol. Size is observed bytes, not a stale stat size. No provenance allocation/publication until parsing, reference checks and all hashes succeed; prior evidence stays byte/mtime-identical. Native exceptions, causes and manifest/scientific payloads never enter diagnostics; controlled stages and affected paths do. No retries, partial fallback, external writes/copies or extra approval.

Compatibility: actual pre-change built ccw capture has 45 files/6,933,713 bytes and external_files=[]; after implementation its sources lists must match exactly while a new data_id is allocated. Old internal-file hashes and ordering are unchanged. Existing records synthetic successes gain a valid manifest with an independent byte/hash vector; the old empty-tree success is obsolete because the manifest is now required. Keep file-safety, bounded-chunk, single-stream, close/drain, prior-evidence and atomic-publication regressions. Remove incidental total-read-byte assertions rather than pinning a new number after the required second manifest read.

Sibling surfaces: jobs shud-submissions.ts invokes this producer unchanged; routed #569 shared jobs fixtures and pollFixture descendants already contain manifests. Records createDataProvenance/workspace-paths/state-files retain allocation/path/commit ownership. Core DataProvenance schema and all 31 projections remain unchanged. SHUD/rSHUD/AutoSHUD sources are read-only references, not reusable parsers or edit targets.

Required evidence: real ccw baseline replay; 32 referenced of 34 external items with independent hashes and Unicode codepoint order; canonical aliases/duplicates; nested paths, both directions across the copy boundary, physical .., root aliases and link/special/missing references; malformed count/header/width/UTF-8/line termination; stream-open/read/mid-read failures and closure; no publication on any failure; repeated new IDs with identical lists; unchanged external bytes/mtime; built public smoke, full check, strict OpenSpec and same-SHA CI.

Non-goals/review focus: no #534 registry rollback implementation, schema or raw-guard policy change, new solver parsing behavior, real-data modification, scientific conclusion or PI acceptance. Static path validation and streaming observations do not claim snapshot isolation against a separate writer replacing inputs concurrently; preserve the existing boundary rather than adding a transaction or retry mechanism.

#### Routed issue #569 implementation boundary

Change surface: jobs submit-shud/test-harness.ts, the existing submit-shud-capture exact inventory oracle, and detached-shud.test.ts custom-project setup. No production module changes.

Governing invariant: every successful synthetic submission has a project-matching manifest whose sole forcing reference resolves inside its prepared input copy, while all original input/argv/security assertions retain their meaning.

Must preserve: existing helper positional arguments/defaults, three original file bytes, END rewrites, exact source/copy inventories and input_bytes, physical symlink-parent path tests, shell-metacharacter project/argv and injection canaries, existing cleanup/collection/cancellation behavior.

Must add: optional trailing project = "tiny" parameters to writeInputTree and submissionFixture; one canonical single-station manifest template with Filename last, ./input/<project>/nested and forcing.dat; project-specific cfg/manifest names constructed from the start. The custom metacharacter case passes its original project into the shared fixture rather than leaving obsolete tiny files through post-hoc renaming. The capture test keeps an independent literal manifest oracle alongside its unchanged three original entries.

Sibling surfaces: direct writeInputTree callers in submit-shud-paths, submit-shud-runs-case and submit-shud-validation tests; submissionFixture consumers in submit/detached suites; poll-shud/test-harness.ts pollFixture and downstream poll/collect/kill/cleanup/list-run-jobs lifecycle tests. Their calls keep default tiny semantics and automatically inherit the manifest. shud-end fixture.cfg.para is not a submitted tree and remains outside scope.

Seams under test: existing exact capture/inventory assertions and the actual registry submission path using detached script fixtures. The standalone oracle validates manifest shape, run-cwd resolution, sole reference containment, source bytes/mtime and literal custom argv; it is not the future records parser.

Required evidence: exact four-entry capture expectation RED before helper change, GREEN afterward; standalone missing-manifest ENOENT before migration, then normal/custom successful submissions with four copied files and unchanged source; focused consumer tests and full check; strict OpenSpec; unchanged 31 projections and all production/config bytes; three-seat review and same-SHA full CI.

Non-goals: #530 parsing/validation/harvesting, #534 production integration/rollback, real/raw forcing inputs, fallback behavior, new dependency, changed host/profile/policy or PI acceptance.

Review focus: no removed oracle, positional API compatibility, one template shared across project names, no obsolete tiny manifest in the custom case, actual run-root-relative containment rather than a string-only path assertion, and no production/config diff.

#### Issue #523 implementation boundary

Change surface: DataProvenance schema/focused tests, registry example/generated projections; minimum external_files:[] literal at the existing typed producer.

Governing invariant: legacy missing external metadata parses to an empty array without rewriting evidence; supplied external entries satisfy their absolute-path/digest/byte-size contract without changing existing internal-file semantics.

Must preserve: raw M3 dataCase and files/metadata constraints, required existing keys and strict boundaries, relative POSIX internal paths, historical nonempty internal digest strings, input array order/duplicates, readonly bytes/mtime.

Must add: sources.external_files default([]), strict items with nonempty absolute path, lowercase64 digest, and existing nonnegative integral byte sizes. Reuse size validation, not the old permissive digest constraint unchanged.

Sibling surfaces: DataSourceSchema and ArtifactSchema size primitive; records/generate-provenance.ts typed createDataProvenance call; records/workspace-records.ts readonly data reader and allocation; raw dataCase and existing workspace tests; registry/selftest.

Compatibility boundary: do not populate raw legacy input to hide defaults. Parsed-output assertions may add only sources.external_files:[] while retaining all original values and safety checks.

Seams under test: built public DataProvenance schema and actual readonly data-file reader. No forcing discovery, reads, hashes, directory checks or producer inventory completeness are proved by this slice.

Required evidence: valid/invalid entry/default/strict matrix, legacy read without byte/mtime/inventory changes, independent empty-array defaults, unchanged internal-file acceptance, only two generated artifacts changed, full check and same-SHA CI.

Non-goals: parsing tsd.forc, external inventory/hashing, submission rollback, provenance-set comparison, jobs/profile behavior or scientific interpretation.

Review focus: separate internal/external path+digest contracts; default only the new nested array; no new inventory policy; old evidence and producer algorithm unchanged.

### D11 角色、preset 与委派（Critical Path #1）

- 新增 `preset-coder`、`preset-reviewer` 两行 `@deepseek-ai/dsh-agent-preset`，子树逐行显式：
  - coder：`persona`、`agent-instructions`（maxBytes 65536）、`time-context`、`tool-fs`（`read`、`edit`）、`tool-bash`。全局 shud 工具（`change_create`、`change_submit`、`shud_build`）经 restrict 进入 inherited；不挂 `tool-jobs`、`tool-subagent*`。bash/edit 的写范围由 `ctx.sandbox` workspace-write、raw-guard 的 raw 判定与治理根写保护（D16）共同限定。
  - reviewer：`persona`、`agent-instructions`、`time-context`、`tool-fs`（仅 `read`；`edit` 不挂）、`tool-jobs`（供 `shud_collect` 前查看作业）。不挂 bash、不挂委派。
  - coordinator 子树：`tool-jobs` 不变；`tool-subagent` 行改为三行，`id` 分别 `tool-subagent`、`tool-subagent-coder`、`tool-subagent-reviewer`（同包名 `@deepseek-ai/dsh-tool-subagent`，`toolName` 分别 `subagent`、`subagent_coder`、`subagent_reviewer`，`agentPreset` 分别 worker、coder、reviewer，`modelSelectionSettings: false`）。同一 preset 子树三次挂同一包不同 id 在 rc.2 未实测：该切片的**第一条**断言即 `--dump-config` 出现三行且 `tool-subagent` 的 `toolName` 互异，再以真实 Web session log 的 `request/header.data.header.tools` 证明 coordinator 看到三个委派工具；若宿主拒绝同包三行，按 Seam-only 规则报告偏差并停止，不 fork、不改 dsh。
  - worker 子树不变。agent-presets「Preset plugin subtrees」的"两个子树 SHALL NOT 挂 tool-fs/tool-bash"改写为对 coordinator/worker 成立、coder/reviewer 按上表。
- role-tool-map：coordinator `inherited` 不变、`local` = `subagent`、`subagent_coder`、`subagent_reviewer`；worker 不变；coder `inherited` = `bash`、`read`、`edit`、`change_create`、`change_submit`、`shud_build`，`local` 空；reviewer `inherited` = `read`、`verification_run`、`shud_collect`、`job_output`、`job_list`，`local` 空；repo_explorer `inherited` = `read`（M4 无 preset、不消费、注明），`local` 空；删除 `harness.memory.propose`、`patch.apply`、`validator.run`、`repo.*`、`git.inspect`。`readCallerPresetId` 映射增加 coder、reviewer；policy-gate `role-tool-surface` 按并集 deny（worker 调 `change_create`、coder 调 `shud_run`、reviewer 调 `shud_build` 均 deny）。
- restrict：全局 `shud-role-restrict` 不改机制，四角色按 `inherited` 绑定；headless 安装器禁用四个 preset 行（`disabled: true`，扩展既有两行逻辑）。
- prompt：`packages/dsh-shud-presets/prompts/{coder,reviewer}.md`。coder.md 含：只在 `repos/SHUD` 改已跟踪文件、不 `git commit`、先 base 构建再改码、改完 `change_create` → `change_submit`、被拒即停止并回报（不重试提交）、批准后 `shud_build(change_id, rhs_openmp: true)` 并回报 `build_id`、禁止科学结论措辞、禁止跑 SHUD、禁止改写 `changes/ patches/ builds/ tasks/` 等治理目录（工具会拒绝）。reviewer.md 含：只调用 `verification_run`、`reviewer_notes` 只陈述工程事实、"bitwise 相等 ≠ 并行正确性/性能"。worker.md 增：收到 `build_id` 时以 `shud_run(input_dir, task_id, build_id, threads: 1)` 提交、不传 `end_days`，等待收集后回报 `run_id` 与 `build_id`；无 `build_id` 时同 M3。coordinator.md 增加 code_change 流程（建卡 → 派 coder base 构建 → 派 coder 改码提交 → 派 worker 跑 base → 派 coder 候选构建 → 派 worker 跑候选 → 派 reviewer 验证 → 报告），以及"CR 被拒时把 PI 的话转给 coder、不自行批准"。prompt 中的 wording 文案由既有漂移测试与 `wording.ts` 比对。
- `instructions/agents/shared.md` 的 Runtime Lifecycle 段（preset/委派/headless 目标）随 6.2 同步并 `instructions:render`，否则 CLAUDE.md/AGENTS.md 漂移。

#### Issue #524 implementation boundary

Change surface: role-tool-map, caller-preset policy mapping, role-tool-surface and tests; necessary existing consumer type/test migration only.

Governing invariant: current projection confers only one of four active policy roles; its allowed inherited/local union is the sole authority tool surface, without erasing attribution or widening other roles.

Must preserve: coordinator inherited/worker collections, frozen collections, unknown policy behavior, raw custom attribution, projection receiver/error/header semantics, authority classification and input-independent denial.

Must add: exact normative five-row map and union, coder/reviewer role mapping and off-role denial, coordinator two new local delegations, deletion of obsolete Zero capabilities.

Sibling surfaces: task-create attribution; policy-gate listener/evaluator/approval tests; role-restrict type and direct consumer tests; core exports and generic default context.

Boundary correction: widening presetIdToRole cannot compile against Restriction.role's old two-role union, and existing plugin tests explicitly expect coder/reviewer unknown. Minimal canonical-derived type and changed-contract tests belong to this cutover; no second mapper or cast workaround.

Seams under test: core public projection/mapping/evaluation APIs, existing real Cordis consumer suites; built core smoke and pinned profile smoke. No claim of new preset rows or complete four-role Web tools.

Required evidence: independent exact collections and cross-role matrix; stale header switches, custom attribution/unknown separation, removed IDs false; payload/workDir not accessed, denial no approval/next; full gate and unchanged old lifecycle guards.

Non-goals: new tools/ask rules, prompts/profile rows, restrict algorithm/lifecycle expansion or scientific conclusions. Full four-role restrict lifecycle/unknown-name checks remain #542, bundle #543.

Review focus: clean identity/authorization separation; consumer compatibility without disabling new roles; no stale Zero allow paths or softened old lifecycle/approval evidence.

#### Issue #542 implementation boundary

Change surface: presets prompt assets and existing prompt/restrict tests and harness. #524 already widened canonical-derived Restriction.role and current projection mapping; no new mapper, role table or restrict algorithm is needed. package.json already exports ./prompts/*.md. Keep these production mechanisms unchanged unless an observed in-scope failure requires repair.

Governing invariant: known-role restrictions use only canonical inherited, not local; install replacement before releasing prior ownership, retain prior mask on failure, ignore stale header/event payload, and invalidate reentrant pending bindings. History d23303c5 repaired reentry/cleanup; preserve its tests and effect semantics.

Content: preserve existing coordinator text byte-for-byte outside a new code_change section; append worker build-bound instructions without weakening no-build collection/wake behavior. Coordinator orders base build before edits, approved change before candidate build, both collected runs before reviewer, then report gates. Denial relays PI words, never self-approval or retry of a denied CR. Coder only edits tracked repos/SHUD files, never commits/runs SHUD/writes governance roots, returns base/change/candidate identities; reviewer produces verification through verification_run with engineering-only notes. Canonical lists in coordinator/coder/reviewer are compared directly with core constants; the worker remains a collection prompt, not a fourth list copy. Prompts contain no machine paths or upstream diff.

Sibling surfaces: core role-tool-map/current projection, existing public ToolRuntime harness, prompts.test.ts canonical-list parser, package asset exports and read-only profile persona Loader. Expand the harness to all three Agent-owned coordinator delegations and inherited role tools without mistaking registration-only doubles for real profile assembly. Independent expected tool collections must not be derived from the map being checked.

Evidence: first missing code_change prompt requirement must fail semantically before adding content. Four roles must reject empty/unknown inherited at creation and replacement, preserve old/foreign masks on failed replacement, avoid stacking repeated events, isolate live Agents and stop binding after disposal. Keep historical reentry tests. Existing unchanged lifecycle behavior may already be GREEN: do not invent a production RED or alter working code to manufacture one. Built emitted-plugin/asset smoke exercises actual public runtime restrictions and export loading; #545 owns real Web evidence, #547 actual model sequence.

No persistence, new config/dependency, profile mount, governance policy or solver changes. Prompt content itself is the delivered documentation; parent fixture records the package-only cut. Default check, profile smoke, strict validation, three-seat critical-path review and exact-head CI gate merge.

#### Issue #543 implementation boundary

Change surface: bundle rows plus smoke preset predicates/negative controls. The existing smoke is 999 lines; move its current JavaScript preset checks into an imported scripts/runtime helper, remove the old implementation and retain one canonical predicate. Do not refactor process cleanup or installer writers. A JavaScript module preserves the existing heredoc dialect; no new dependency or lint exclusion.

Governing invariant: three distinct coordinator delegation registrations survive actual Loader composition, each with its fixed provider/toolName/agentPreset/model-selection settings. First new composed-dump assertion checks this seam before broader preset checks. Current single-row RED establishes the absent feature; after configuring the intended rows, a host rejection/collapse is the mandated stop condition, not permission to weaken the assertion or choose a different delegation API.

Pinned tool-fs defaults enable read, readImage, write and edit. Configure coder as read/edit only and reviewer as read only, explicitly disabling readImage/write and reviewer edit. Use existing persona asset Loader expression, agent-instructions maxBytes65536, exact child ordering, no order on new presets, no worker changes or nested restrict/delegation. Host registry/provider remain once globally with unchanged default depth.

Sibling surfaces: profile installer and profile-patch are read-only; preserve jobs capture, raw overrides, YAML metadata-only parsing, secret checks, failed boot diagnostics and bounded subprocess cleanup. Existing negative mutations for old presets/default/imports/host rows stay effective after helper extraction. New controls mutate actual dumps through the same predicate, never a second expected-tree implementation.

Headless four-row ownership/assertions remain #544. During this separately mergeable slice, preserve existing two-row headless tests and make the new Web-only acceptance boundary explicit; do not silently enable a headless default or claim new rows disabled. #544 must extend the same canonical predicate, not fork it. New Web role tools and prompt delivery are not proved by dump metadata; #545 supplies session-log evidence.

Verification: actual pinned-host install/dump first vertical, full profile smoke with negative controls and existing invalid-boot path, default check/guard self-tests/strict/generated preservation, three-seat whitebox review and exact-head CI. No host/scientific changes or PI acceptance.

#### Issue #544 implementation boundary

Change surface: extend OwnedPatch and headless desired targets from two presets to four, plus the same smoke/helper predicates and fixtures. The #543 helper is the current owner of preset assertions; no second headless checker. Governing invariant: jobs and four disabled fields form one validated in-memory transaction and one atomic publication, preserving all other preset properties and external bytes.

Preserve original-source preflight before any reduce/update even when desired values already match (5297ee59), source-range/YAML dialect handling, inert Loader tags, regular-file checks, controlled diagnostics and cleanup. New targets must not escape duplicate/shared/aliased rejection. No parser rewrite, retries, new config, Web ownership change or bundle modification.

Required evidence: first actual headless dump RED for enabled coder/reviewer then minimal target extension GREEN; M3 old two rows plus raw/comments migrate without rewriting them; second install preserves bytes/inode/mtime/mode. Exercise four-role duplicate/shared/aliased inputs through precheck, writer and installer while jobs also needs updating, including already-desired targets. Independent actual writer interception counts one rename for valid five-target publication and zero for unsafe/precheck/no-op; temp files do not remain. Existing Web override/no-op, flow/CRLF/indent/document-end/missing-field metadata and secret/invalid-boot checks survive. Default/profile/guardrails/strict plus exact-head CI and critical-path review gate merge.

No real Web role header, model workflow or PI acceptance claim; those remain #545/#547/#549. Preserve installed Web composition and all31 generated artifacts.

#### Issue #545 implementation boundary

Change surface: actual Web/DMXAPI engineering evidence plus shared.md Runtime Lifecycle/profile-smoke description and renderer outputs. Existing public WebHost supplies startup, authenticated RPC, flush and identity-owned cleanup; use disposable verification code, not a new product probe or permanent test. No package/profile/host changes.

Governing invariant: one actual coordinator session calls subagent/subagent_coder/subagent_reviewer, yielding exactly one catalog-bound worker/coder/reviewer. Match each tool/call callId to its successful native tool/result child receipt and that child's stored preset, not merely the set of three roles. Flush each session separately, read its stored canonical log, verify parent/origin/role identity and exact request/header.data.header.tools. Child logs must contain request evidence and completed turns, advertise no delegation tools and contain no nested catalog entries; do not derive truth from model acknowledgements. Prompt asks children to attempt delegation only if a delegation tool is actually advertised, never to substitute shell or domain operations.

Qualify the evidence judge against wrong stored role/parent, missing and extra tools, missing/wrong delegate calls and fabricated nested children; untouched evidence must return GREEN. Prompt delivery, if cited, comes only from system/message.data.message.content. Screen bounded evidence before persistence; keep launch URLs/cookies/API keys out of files and PRs, stop only the owned host, no approval answers or SHUD execution. This is characterization, not a fabricated product fix.

Observed qualification correction: the first private probe counted every coordinator call as a delegation and rejected one additional authorized readonly job_list, although all three delegations completed, children made no tool calls and the workspace stayed empty. #545 requires three explicit delegates and exact advertised tool sets, not perfect adherence to the probe's stricter no-job-tool wording. Preserve the original failure and canonical bytes; qualified audit counts delegates separately, permits only this readonly host inspection as an extra call, still rejects domain/mutating calls, and adds that negative control. Do not report the initial probe as PASS or claim verbatim model compliance.

After proof, update only relevant existing instruction paragraphs and stale profile-smoke count wording, render generated files without hand edits, and verify source/generated consistency, full check/profile smoke/strict, independent review and exact-head CI. Actual Web session evidence does not prove full code_change replay, browser clicks, scientific validity or PI acceptance; #547/#549 remain.


### D12 报告：`code_change` 的事实表与固定措辞（Critical Path #6）

- `report_generate` 对 `code_change` 卡求 D7 谓词；报告 `.json` 新增 `change_ids`、`verification_ids`（M3 报告 `default([])`），生成投影随之更新。
- `.md` 事实表新增三段（由对象确定性生成）：ChangeRequest（`change_id`、`base_commit`、`semantic_level`/`semantic_floor`/`floor_categories`/`risk`、`files_changed`、`patches/<id>.patch` 路径与 sha256、`status`、`approval_ref`）；VerificationCase（`vc_id`、`case_type`、`expected_result_source`、`pass_criteria`、`base_run_id`/`candidate_run_id`、两个 `build_id`、两个 sha256、`status`、`failure_reason`、`reviewed_by`、`compatibility_verdict`、`reviewer_notes` 逐条）；BuildRecord（每个 VC 的两个构建：`build_id`、`change_id`、`source_commit`、`rhs_openmp`、`make_argv`、`compiler`、`patch_sha256`、`binary_sha256`——让 PI 在报告里看到候选确实带 OpenMP 构建）。StackLock 表逐 lock 列出 `build_id`。
- §5 对 `code_change` 固定写："本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。"（该句进入 `wording.ts` 常量并由模板逐字渲染）。§7 另列 `status: failed` 的 VC。
- `report_validate` 增至 15 项：(14) `code_change` §5 固定句；(15) `verification_ids` 中每个 VC 的 `artifact_refs` 两项均为会话 cwd 下的普通文件且 sha256 分别等于 `observed.base_sha256`/`candidate_sha256`（frozen `Verification_Case_Spec.md` 的"passed 需 artifact"在 M4 的落地：`verification_run` 写入时两个 artifact 刚被比较器读过、必然存在，第 (15) 项在报告校验时复核它们仍存在且未改；Review 2 P1-7）。其余 10 节、7 态水印、四句不变式、禁语与密钥扫描不变；`Report_Generation_Spec.md` 的"13 项"改为 15 项。

#### Issue #541 implementation boundary

Scope and invariant: tools compose the shipped #529 closure and #533 report projection; records extends the existing validator to fifteen checks. No report-render/template, core, jobs, policy, raw or approval implementation changes. Closure remains deterministic linked evidence, not model assertion; failed VCs remain reportable.

Generation order: require an eligible science_assist/code_change card before query/reconciliation; unsupported types produce a controlled type error. Preserve planned/running/reporting eligibility. Validate standalone branded citations in all authored fields before any reconciliation/publication, adding CHG/VC/BUILD to the existing six namespaces with canonical readonly schema/id checks. Malformed, embedded and DEC tokens retain existing behavior. After async job/ledger/readonly-record preparation, reread the current card and pass explicit readonly change/patch/verification loaders to evaluateClosure. The facade owns all shared and code-specific predicates; do not reimplement them or add verification_run's build/pin/thread constraints. Draft change_ids/verification_ids copy the fresh card's links, including proposed changes and failed verifications; no new model parameters.

Publication compatibility: existing reconciliation is an independent commit. Closure failure cannot write a report or otherwise change the card. Keep report operation lanes, fresh-card merges and partial-publication repair semantics. report_validate entry repair remains independently committed before validation; failure thereafter preserves JSON/Markdown/card bytes and mtimes. report_submit/report_decide behavior, approval handling, watermark states and expectations remain unchanged.

Validation: every schema-valid report root receives all fifteen ordered results, including when references/rendering fail. Check 8 retains failed-run checks and requires each failed VC id in template-owned section 7. Check 14 requires core CODE_CHANGE_SECTION5_WORDING in template-owned section 5 when change_ids is nonempty, otherwise vacuous. Authored fake headings cannot supply either section. Existing Markdown is not the canonical input; use current JSON/references and the existing renderer. Forbidden-phrase scan fields and whole-document secret detection are unchanged.

Check 15 reads every referenced VC through the canonical readonly schema/id boundary, independently of unrelated rendering failures. With nonempty verification_ids it is not vacuous. Each of the two ordered artifact_refs must resolve beneath the physical session cwd, with every relative component checked by lstat, no symlink traversal, ordinary directory ancestors and an ordinary final file. Cwd aliases such as platform TMPDIR are allowed; artifact-component links are not. Open only the qualified final descriptor with the existing no-follow/nonblocking identity-check discipline, reuse internal hashDescriptor, close every descriptor on success/failure, and compare hashes against base then candidate observed digests. Do not read solver logs, parse numerical values, buffer whole artifacts, discover files or add a second public hash API. Missing, unreadable, unsafe or changed evidence fails without writes; no concurrent hostile-writer snapshot guarantee is added.

Diagnostics reconcile the two existing normative constraints: identify vc_id and the offending relative artifact path, but never echo a secret-pattern match. Include the artifact index, preserve ordinary relative paths, redact every REPORT_SECRET_PATTERN match in displayed paths, and never expose resolved absolute paths or OS/cause payloads. The index remains unambiguous if redacted display paths coincide. Check 13 still reports sections only. This is not a new secret regex or permission to disclose other record prose.

Sibling surfaces and evidence: report-generate/report-citations/report-workflow/report-validate; records validateReport and its public check/detail/result types; existing report-validation and real ToolRuntime harnesses; unchanged submit/decide tests. Cover all thirteen code_change closure scenarios through the tool, fresh-link changes across awaits, citations before reconciliation, all fifteen checks under upstream failures, each artifact position and multiple VCs, native filesystem faults and descriptor cleanup, and secret-shaped paths. Tests for missing section text mutate the canonical template/render seam, not only stale Markdown. Preserve science_assist behavior with checks 14/15 explicitly vacuous.

Reference-discovered minimum migration: workspace-records.typecheck.ts asserts the exported tuple's last id and rejects out-of-range indexes/ids; update those contract assertions to fifteen checks without changing record APIs. records/index.ts needs only its public thirteen-clause documentation corrected, not new exports. Existing code-change validator fixtures deliberately omit artifacts under the old thirteen-check boundary; give positive artifact-check cases real files with matching hashes, while retaining no-cross-object/readonly/wording assertions. Do not weaken checks to preserve obsolete thirteen-row expectations.

Delivery: vertical real-ToolRuntime RED→GREEN before matrix expansion, actual built generate→validate with approved CR/passed VC/two collected runs, failed VC reporting and changed-artifact rejection; full check, profile smoke, strict OpenSpec, 31 generated hashes unchanged, expanded three-seat review and exact-head CI. Existing documentation records fifteen checks and closure boundaries; no PI or scientific acceptance claim. Normal PR revert is rollback, no dual validator.

#### Issue #533 implementation boundary

Change surface: EvidenceReportSchema adds unique branded change_ids/verification_ids with default([]); generated EvidenceReport Markdown/JSON Schema and registry example overrides change together. Keep raw M3 fixtures missing both keys. A private creation-input type may omit only these new default-backed fields; do not widen all brands through z.input or make other fields optional. Existing tools caller remains unchanged.

Governing invariant: the report projects schema/path/id-valid records without deciding scientific or cross-object compatibility, and template-owned wording is independent of authored prose.

The existing readonly report-inputs boundary loads CR/VC/BuildRecord through readWorkspaceRecord(...,{readonly:true}). Load arrays in declared order. VC references independently trigger VC/build sections even when change_ids is empty; each VC displays base then candidate, retaining repeated shared builds. Caching identical build reads is optional, never a reason to deduplicate display. StackLock build_id only adds its row; it does not implicitly load a build.

All D12 fact fields must appear, including each files_changed/floor_categories/make_argv/reviewer_notes element. New nullable facts use literal null; do not change legacy metadata(null) = "unknown (null)". Structured metadata uses the existing single escaping boundary; authored prose remains verbatim. Proposed CRs and failed VCs remain visible. No patch, make log, binary or output contents are read.

Replace only the packaged §5 literal with a controlled template token: nonempty change_ids selects CODE_CHANGE_SECTION5_WORDING, otherwise preserve the old sentence byte-for-byte. The constant is not injected into JSON. Preserve projectTemplate's original-token-only substitution and trusted heading offsets; authored fake headings/tokens cannot redefine validator section origins. Append only failed VC id/reason to existing §7 run failures.

Sibling surfaces: renderReport and renderReportDocument; validateReport's canonical document call; workspace-records createEvidenceReport/createFlatRecord input types; three existing parsed-output tests; core schema tests; scripts/schema/registry.ts examples; packaged template and old golden. Both canonical document consumers load the same new facts; no silent empty-facts default. validateReport keeps thirteen ordered checks and existing controlled render_unavailable handling; its secret check must see new structured facts. Checks 14/15, failed-VC validation and closure belong to #541.

Compile-discovered sibling: scripts/runtime/shud-first-task-evidence.ts also calls the internal document renderer from its offline M3 evidence judge. Migrate that caller with an explicit empty facts object only after asserting both report reference arrays are empty via its existing IDENTITY_JOIN predicate. Do not read live workspace files, silently drop new references or expand this judge into M4 replay. Verify the actual shud:first-task Web/SHUD chain and replay its retained snapshot with nonempty-reference rejection controls; there is no tracked standalone judge self-test. This minimal integration exception is recorded in live #533.

Readonly failures: missing, corrupt, wrong embedded id, unsafe directories or symlink targets for each new kind reject rendering through controlled errors; no managed directory creation, rewritten JSON or partial return. Do not add cross-object task/approval/hash comparisons or directory discovery. No new concurrency/snapshot guarantee or resource limit; only cited JSON and packaged template are read.

Required evidence: semantic RED on old public renderer/schema, then exact fields/order/null/escaping/failed-only risks and unchanged thirteen-check behavior. Frozen actual built M3 baselines are 4035 bytes SHA256 4620ac33c381c2ece739b5bb7f863aead720bd54ef505680857224a33bf54827 (two runs) and 2768 bytes SHA256 1f7916272f888169970cd53a3752bd681bf3b6e3b38bdc1aa74b04272f2c8356 (single successful run). Reconstruct fresh workspaces from frozen inputs and compare output plus input bytes/mtime; preserve report-render.golden.md and add a distinct code-change golden fixture. Built public render/validate smoke inspects actual Markdown and controlled failures; full check and same-SHA CI.

Non-goals and rollback: no tools/policy/jobs, new validator clauses, artifact comparison or PI acceptance. Only two EvidenceReport generated files may change; other 29 remain byte-identical. This D12 boundary is the decision record; normal PR revert is rollback, no parallel renderer or migration rewrite.

#### Issue #525 implementation boundary

Change surface: wording.ts constant and wording.test.ts; existing core wildcard export needs no duplicate statement.

Governing invariant: scientific qualification text is one immutable, exact public literal, independent of model-text phrase scanning.

Must preserve: ten forbidden phrases, four invariants, scanner field/order/substrings and no template whitelist; M3 rendering remains untouched.

Must add: CODE_CHANGE_SECTION5_WORDING as const, byte-exact normative text with no whitespace/punctuation normalization.

Sibling surfaces: core index wildcard, existing wording scanner/tests, future records template/validator and preset prompts.

Required evidence: exact independent literal equality and mutation negative control; observation full sentence no hits but appended forbidden phrase still detected; built export/scanner smoke and full check.

Non-goals: template/rendered JSON/Markdown, validator rule14, prompts, profile config, new scanning exemptions, generated schema changes.

Review focus: exact scientific limits and punctuation, exported primitive, no scanner changes or premature downstream claims.

### D13 回放脚本与验收门

- `pnpm run shud:replay <scratch-workspace>`（`scripts/runtime/shud-replay.sh` → `shud-replay.ts`，复用 `shud-web-driver.ts` 与首任务脚本的会话/审批驱动）：前置 `DMXAPI_KEY`、`SHUD_BIN`（安装器仍需）、`SUNDIALS_ROOT`、`SHUD_REPLAY_KELIYA`；执行 D2 准备；安装独立 Web profile；单提示启动 coordinator；对两次 `approval/asked`（`change_submit`、`report_submit`）自动 Allow once（工程证据，不是 PI 验收）；等待 worker/reviewer 子会话结束。
- 判据的唯一正文在 known-answer-replay「Replay acceptance criteria」（design 与 engineering-gates 只引用）。本轮新增的判据要点：卡 `source_base_commit` 与两个 BuildRecord `source_commit` 均为 `9a422e5` 全 sha；CR `files_changed` 含 `Makefile` 与 `src/Model/MD_rhs_core.cpp`；候选 BuildRecord `rhs_openmp: true` 且 `make.stdout.log` 含 `-fopenmp`（无此证据即 base Makefile 忽略 pragma、门是空的——Review 1 P1-2）；base `rhs_openmp: false`；`repos/SHUD` 的 `--absolute-git-dir` 在工作区内、根 submodule 的 git dir（`git -C SHUD rev-parse --absolute-git-dir`）无新文件。VC `failed` 为 exit 1 并保留全部证据（coder 重导出失败是回归证据，不是 INCONCLUSIVE）。
- 控制面登记：Verification Matrix 增 `shud:replay` 行（block，本机，CI 不跑）；`Test_Fixtures_And_Command_Matrix` 增 keliya 回放夹具；`Phased_Plan` §4 验收门措辞对齐（owner 为 1.1a）。
- PI 验收：Epic 收口时 PI 在 Web 亲自完成一次回放（含 CR 卡与报告卡各一次操作），证据记 `Migration_Plan_dsh.md`；决策记录 `docs/adr/proposed/00NN-m4-epic-acceptance.md`（沿 0010 模式，PI 通过后转 implemented）。模型是否真能重导出切片是本验收的实测项，不预设结论。

### D14 规范对齐任务组（实现组之前）与 ADR-0011

一次 docs-only 任务（1.1a）：`Minimal_Schemas.md` 全部受影响节（TaskCard：`code_change`/两链接数组/`source_base_commit`；StackLock：`build_id`；RunJob/RunRecord：`build_id`/`threads`/`binary_sha256`；DataProvenance：`sources.external_files`；EvidenceReport：`change_ids`/`verification_ids`，并注明报告字段名为 `verification_ids` 而非 Theory_to_Code 的 `verification_case_ids`；§8 ChangeRequest 重写并删除无生产者字段；新增 VerificationCase/BuildRecord 节）；`Verification_Case_Spec.md` 增 "M4 实现范围" 节（`bundle_id` nullable、`id`→`vc_id`、`run_job_ids/run_record_ids`→base/candidate 两对引用、`target_equations` 不保留、只生产 regression/baseline_regression/passed|failed）；`Scientific_Change_Gating_Spec.md` §1.1 落点措辞、§2/§6/§7 的 M4 bundle 免除、§4 M4 ask 规则、§5 M4 comment 偏离；`Report_Generation_Spec.md` 13→15 项；`Roles_and_Boundaries.md` §6 与 `Agent_Architecture.md` §4.4a/§7（`code_change` 谓词按 D7 措辞，review note → VerificationCase 字段，M4 路由以 PI 卡替代 bundle 三步，"worktree"→"scratch workspace 内 `repos/SHUD` 本地 clone"）；ADR-0002 开放项 1 加注（M4 pin `9a422e5`）；`Workspace_Conventions.md` 增 `changes/ patches/ verifications/ builds/ repos/` 与治理根写保护；`Phased_Plan.md` §4 与 §6（本轮跳过 dsh-upgrade issue 的理由）；`Repository_Layout.md`；`openspec/glossary.md`（BuildRecord、semantic floor、floor_categories、known-answer replay 的 base/known answer 两态、治理根、`shud:replay`）。`CONTEXT.md` 的两条新不变量（候选二进制 ⇔ 钉定 commit + 已批 patch；code_change closure 不以 LLM 为据）由创建伴生测试的任务落地（5.2、3.3），1.1 不写，避免 `docs:check` 路径声明指向尚不存在的测试。ADR-0011 移至 `implemented/`（1.2，PI 在该 PR 确认）。

### D15 偏离登记（独立于功能 PR 之外可审计）

每条注明来源与落点；全部是 M4 范围裁剪而非对 `constraints.yaml`/baseline 的放宽，不写 `docs/adr/proposed/`，但每个落点在 1.1a 逐一改写：

1. `VerificationCase.bundle_id` nullable（frozen Verification_Case_Spec 要求必填），且 Gating §2 gate matrix / §6 / §7 对 `output_semantics` 及以上要求 bundle 的门在 M4 整体免除，Agent_Architecture §4.4a 的三步路由（bundle → mapping → accepted_for_search）不执行，以 `change_submit` 的 PI 卡替代——M4 不生产 bundle。
2. 高风险 CR 批准无 comment（Gating §5）——卡片无 comment 通道，M4 以 allowed-once 为批准。
3. `shud_run` 新增 `threads`（M3 规范以 `threads: 4` 为未知参数示例）——场景改写。
4. Roles_and_Boundaries §6 的"patch bundle / diff 摘要 / interface_impact"——M4 为 `patches/<id>.patch` + 确定性分级，不采集 `interface_impact`。
5. ADR-0002 开放项 1 的 pin（`3341368d` 或 `7a1dc8f`）——M4 pin 改为 `9a422e5`：重导出需要 base 在切片之前，ADR-0002 正文加注。
6. Verification_Case_Spec 字段：`id`→`vc_id`，`run_job_ids`/`run_record_ids`→base/candidate 两对引用，`target_equations` 不保留（无 bundle）。
7. Phased_Plan §6 的里程碑边界 `chore(dsh-upgrade)` issue 本轮跳过（PI 决定保持 rc.2），Phased_Plan 记跳过理由。
8. Phased_Plan §4 与 Roles §6 的"worktree"措辞——M4 为 scratch workspace 内 `repos/SHUD` 本地 clone（`git worktree add` 会写根 submodule 元数据）。
9. 治理根写保护（D16）是 raw-guard 同款启发式 denylist：治理根在 workspace 内、无沙箱兜底，绕过启发式的 bash 写法仍可能改写 `changes/<id>.json`；M4 的补偿是 patch sha 三处复核与回放脚本对 `approval_ref` ↔ `approval/asked.callId` 的 session log 核对，不是密码学证据；workspace 外的审批账本留 Not yet specified。

### D16 治理根写保护（Critical Path #2/#3）

- M3 没有角色拥有 `edit`/`bash`；M4 的 coder 有，因而能把 `changes/<id>.json` 改成 `approved`、改写 `builds/*/shud` 或 `tasks/*/task.json`（Review 2 P0-1）。用户裁决：复用 raw-guard，不开新 seam。
- raw-guard 新增固定、不可配置的治理根集合（相对会话 cwd）：`tasks`、`stacks`、`provenance`、`reports`、`runs`、`changes`、`patches`、`verifications`、`builds`。`write`/`edit`/`str_replace_editor`(非 view) 目标在其中 → `deny`（code `governance-immutable`，reason 含 `immutable`，指明只能经对应工具写）；`bash`/`pwsh` 命令触及任一治理根且按既有写 denylist 判为写 → `deny`；只读触及 → `next`（治理文件不敏感，不像 raw 那样 ask）。与角色无关、与 `sandbox_permissions` 无关；raw 与治理根同时命中时 raw 判定优先。`repos/` 不在集合内。
- 其它层的复核：policy-gate ask 前与 `change_submit` 执行时复核 patch sha（D5）；`shud_build` 从对象库 + 已批 patch 构建（D3）；closure 复核 patch sha（D7）；`shud_run`/`verification_run` 复核二进制 sha（D8/D9）。
- 已知边界：raw-guard 的 bash 判定是启发式（同 raw 的漏报清单），且 `repos/SHUD/.git` 不受保护——coder 用 bash 篡改对象库不在 M4 威胁模型内（与 coder 本就可以写任意源码同一信任级别）；登记 D15(9)。

#### Issue #594 implementation boundary

Change surface: only the existing shared decideFileShellAccess admission boundary, focused tests and existing documentation. Recognize exactly write, edit, str_replace_editor, bash and pwsh before reading call.arguments; all other names return the existing NEXT. Keep recognition in the shared owner rather than duplicating filters at its raw and governance callers.

Must preserve: raw-specific dispatch first; raw deny/ask terminates before governance; existing supported-tool parsing, fields, cwd/workdir resolution, path identity failures, read/write rules, next result and audit behavior. No broad exception handling, new policy/root/configuration, special case for verification_run or changes to index.ts's adapter.

The observed failure is a direct exported-function call with a throwing arguments property. change_submit can catch identity extraction and return NEXT, only for governance fallback to read it again; shud_build never needs arguments but fallback reads them. Generic non-file calls unnecessarily read arguments before returning NEXT too. The fix removes only these irrelevant accesses, not any supported-tool guard.

Use existing shud_build/change_submit and generic names for independent main-based RED/GREEN. The #540 verification branch is not on main and remains in the preserved parent slice; its original protected-verifications/tasks and disjoint-raw accessor regression must pass unchanged after integration. This evidence split prevents a false dependency cycle without reducing the overall invariant.

Sibling surfaces: both callers of the shared classifier, all five supported names, task/build/change specialized branches, index.ts's plain adapter, governance and raw file/shell/alias/error tests. The adapter reads execution.arguments before calling decideRawAccess, so no claim that a getter envelope reaches this path from native ToolRuntime or an LLM.

Required evidence: first throwing-envelope direct-decision RED; supported read/write/raw-priority counterexamples; full raw suite and built direct/function plus real-plugin plain-envelope smoke; full default gate, profile smoke, raw probes with retained-byte stronger audit, guardrails, strict fixture, generated equality, three white-box seats and exact-head CI. No arbitrary raw data writes, external host changes, new sandbox guarantees or scientific acceptance.

#### Issue #535 implementation boundary

Change surface: decideRawAccess/decideKnownRawAccess and existing internal file/shell classifiers in raw-guard/decide.ts; new test files because decide.test.ts is already near its size bound. index.ts keeps its existing configuration, waterfall and audit adapter. No second copy of command/path classifiers or new configurable roots.

Governing invariant: prior raw deny/ask remains authoritative; only raw NEXT permits governance classification. Recognized file/shell writes into fixed session governance roots deny with governance-immutable, without calling next or asking; reads/unrelated calls return the exact downstream result once.

Path contract correction: pinned tool-fs write/edit execute relative file_path through session workingDirectory, not args.workdir. Its open root parameter schema accepts an extra workdir but parseWriteArgs ignores it. The actual validateArgs probe accepted the bypass-shaped request; therefore file target identity uses session cwd, while shell keeps effective workdir. Live #535 and this delta explicitly align; host/raw behavior is not changed.

Reuse boundary: file containment, canonical/nearest-ancestor identity, shell normalization/unquote/parent folding/case/workdir, write verbs, tar and pwsh predicates remain one implementation. Raw ancestor detection remains raw-only, never governance. A small internal extraction is permitted to share classifiers without rerunning specialized task/report/shud_run rules against governance roots.

Sibling surfaces: write/edit/str_replace_editor mutation and read/view; bash persistent same id and pwsh (including pwsh-in-bash); raw file/shell/ancestor and specialized domain-tool targets; plugin fieldsOf session extraction, exactly-once next, error propagation, per-decision audit, unload. No role-specific branch.

Required evidence: nine roots with existing/missing targets and roots, direct/absolute/session-symlink/root-symlink/native-case aliases, sibling prefixes; bash/pwsh writes/reads/workdir and representative classifier spellings; raw ask/deny precedence, malformed inputs, extra permission/workdir fields, all four roles plus unknown at the real Cordis seam. Assert protected bytes/mtime unchanged and no approval/downstream on deny; reads preserve downstream identity/error once, audit excludes paths/content.

Resource/errors: preserve bounded namespace probes and no new recursive discovery/cache/state. Existing PathUnavailable fail-closed diagnostics remain controlled. Missing/malformed arguments do not trigger new throws; unrelated/read paths avoid needless governance filesystem work. Existing path-error regressions stay, no new retry.

Governance-specific identity failures: deterministic OS-boundary fixtures exercise missing changes with file target CHANGES/x.json and shell workdir CHANGES. Proven-insensitive namespaces deny governance-immutable for writes; proven-sensitive distinct namespaces delegate once. Empty/unreadable/changing plausible-case namespaces deny raw-path-unavailable with zero downstream/approval and path-free audit. Assert bounded enumeration, directory close, fresh next-decision evidence, no probe writes and no sensitivity cache. Existing raw-consumer tests alone are insufficient.

Precedence controls: rawDirs data/raw with bash rm -rf data tasks returns raw-ancestor-write and audits that code, never governance-immutable. With unrelated raw configuration, governance-only rm -rf . and rm -rf * delegate once; no new ancestor protection is claimed.

Evidence limits: built Cordis smoke proves middleware and logger routing, not host executor or PI action; real raw probes preserve T1–T5 engineering checks and raw bytes. Native case evidence is platform-dependent; deterministic existing OS-boundary tests remain. Full check/profile/strict fixture and three white-box seats gate merge.

Non-goals: fixed roots do not protect ancestors such as rm -rf . or rm -rf *; inherited heuristic false negatives and ordinary-word false positives remain D15(9). No new shell parser, persistent state, sandbox, approvals ledger, repos/.git protection, domain-tool output checks, profile changes or scientific acceptance.

Review focus: raw precedence cannot collapse ask into next; governance cannot inherit raw ancestor deny; file workdir cannot redirect identity; shared classifiers retain tar/discard/pwsh semantics; no new global allow, configurable roots, secret/path audit or role bypass.


### Sketch seams under test

- `tools/pre-execute` 监听（policy-gate）以真实 Cordis `Context` + `@deepseek-ai/dsh-tools` 注册的假 `change_submit`：高风险 ask / 低风险 next / 角色 deny / 文件缺失仍 ask / patch sha 不符 deny / allowed-once 才执行 / danger-full-access 仍 ask——最高的已有 seam，M3 范式直接复用。
- `tools/pre-execute` 监听（raw-guard）对 `edit`/`write`/`bash` 写治理根：九根 × 存在/不存在 × 符号链接别名 × 写/读命令矩阵，复用 raw 的判定夹具。
- `ShudJobRegistry.submitShud()`（已有）：`build_id` 解析与二进制替换、`threads` 环境、`external_files`、StackLock `build_id` 指纹——沿 M2/M3 提交集成测试扩展，含失败回滚不留运行目录。
- records 纯函数 + 临时 git 仓库：受控 git runner（env 白名单断言子进程看不到 `DMXAPI_KEY`、realpath ≠ toplevel 拒绝）、`observeSourceChanges`（porcelain `-z` 解析、untracked 拒绝）、`deriveSemanticFloor`（全部匹配取最大、未匹配默认、categories）、`riskForLevel`、`codeChangeClosure` 正反例、`compareRivqdown` 正反例、三对象原子写、排他创建与路径安全。
- `shud_build` 以真实临时 git 仓库 + 假 `Makefile`（产出可执行 `shud` 或非零退出）行使：archive+apply 构建、被忽略源文件不进入构建、工作树陈旧 `shud` 不被发布、干净树/脏树、approved/proposed CR、diff ≠ patch、patch 文件被改、临时目录 rename 与失败清理、`repos/SHUD` 零写入断言、env 白名单。不在单测里编译真 SHUD。
- 模型工具经 `dsh-shud-tools` 既有 strict-tool 装配；`verification_run` 以真实 ToolRuntime + 构造的两个 collected 运行目录行使交叉校验矩阵（含 `linked_jobs` 绑定、base `rhs_openmp` 为真拒绝、钉定 commit 不符拒绝）。
- preset/委派/restrict：`--dump-config` 投影断言（profile:smoke，三行委派与四 preset）+ `shud:replay` 的真实 Web session log（四角色 header、工具面、两次审批）。

## Risks / Trade-offs

- [同包三行 `tool-subagent` 在 rc.2 未实测] → 作为 D11 切片的首条 dump-config 断言；失败即报告 seam 偏差（备选：单行 + 运行时 `agentPreset` 参数，grill 已否决，需 PI 重开）。
- [模型未必能重导出切片] → 这是 M4 验收的实测项；`shud:replay` 以 `failed` VC 为 exit 1 并保留证据，不放宽为 INCONCLUSIVE；回放任务文本提供 P1e 设计文档路径与五文件清单（prompt 资产不嵌入机器路径），不提供上游 diff。
- [`make` 依赖本机工具链（clang/gcc、libomp、SUNDIALS）] → 只在本机闸；`shud_build` 错误含退出码与 make 输出末尾行；CI 不构建。
- [coder 拥有 bash/edit] → sandbox workspace-write + raw-guard raw 判定 + 治理根写保护（D16）；`shud_build` 的 env 白名单防止密钥进入构建日志；coder 子树不挂 `tool-jobs`，不能 kill 作业。治理根保护是启发式，残余风险见 D15(9)。
- [候选构建与工作树脱钩] → 构建输入是 (钉定 commit, 已批 patch)，工作树一致性检查只是防止 coder 看到的与构建的不一致；StackLock 记 `dirty_paths` 为证据。
- [`git archive` + `tar -x` 依赖系统 tar] → Darwin/Linux 均有；缺失即工具错误，不回退到工作树构建。
- [keliya 输入在仓库外且含机器绝对路径] → 准备脚本显式参数、`PREPARED.json` 记两项改写；`external_files` 哈希 forcing.trimmed 中被引用的 32 个文件；跨机器不可移植在 D2 明示。
- [`threads=1` 仍依赖 `NUM_OPENMP 1` 的准备期改写] → 双保险（env + cfg）；VC 交叉校验只认 `threads: 1` 的运行。
- [`-fopenmp` 证据取自 make 回显] → 若上游 Makefile 改为静默编译则证据消失；M4 base 固定为 `9a422e5`，回放判据对此 Makefile 成立。
- [报告 §5 固定句宣称"不构成并行正确性结论"] → 与 K12 一致；PI 审阅是最终防线。
- [`linked_changes`/`linked_verifications`/`source_base_commit`/`binary_sha256`/`external_files` 的默认值] → schema `default`，M3 文件不改写；生成投影随之更新。
- [被拒 CR 永远 `proposed`] → 报告事实表列出全部 `linked_changes` 及状态，PI 可见历史；M4 不做修订链（Non-Goal）。
- [ccw 提交新增 `tsd.forc` 解析] → ccw 的 `./input/ccw/` 在副本内，得 `[]`；`shud:tiny`/`shud:first-task` 是回归闸。

## Migration Plan

合入顺序（每步 `pnpm run check` 绿；profile 切片起 `profile:smoke` 绿；脚本切片后 `shud:replay` 绿）：

1. 文档对齐 1.1a（Minimal_Schemas 全节/VC/Gating/Roles/Agent_Architecture/ADR-0002 加注/Workspace_Conventions/Phased_Plan §4+§6/Repository_Layout/Report_Generation_Spec/glossary）→ 1.2（ADR-0011 转 implemented）。
2. core：2.3 floor 常量与派生函数（无依赖）→ 2.1 三品牌 id + 三 schema + 生成投影（CR 的 `risk` refine 依赖 2.3）→ 2.2a TaskCard（`code_change`、两链接数组、`source_base_commit`）、2.2b StackLock `build_id`、2.2c RunJob/RunRecord `build_id`/`threads`/`binary_sha256`、2.2d DataProvenance `external_files`（互不依赖）→ 2.4 role-tool-map 真实 id 与 `readCallerPresetId` 映射 → 2.5 §5 固定句常量 → 2.6 受控 git runner（扩展 `repository-revision.ts`）。
3. records：3.1 三对象文件层 → 3.2 `observeSourceChanges` + CR 生成纯函数 → 3.3 `codeChangeClosure` + `code_change` 转换 → 3.4 `external_files` → 3.5 StackLock 采集接受 build 源 → 3.6 报告模板三段与固定句 → 3.7 `compareRivqdown`。
4. jobs：4.1 `submitShud` 消费 `build_id`/`threads` + provenance 外部文件（同一提交事务，atomic）。
5. raw-guard/tools/policy-gate：5.0 治理根写保护（无依赖，先于 coder preset）→ 5.1 `task_create(code_change)` 钉定 + `change_create` + 其 raw-guard 判定 → 5.2 `shud_build` → 5.3 policy-gate `change_submit` 规则（含 patch sha deny）+ `change_submit` 工具 + raw-guard 确切目标（同刀）→ 5.4 `shud_run(build_id, threads)` → 5.5 `verification_run` → 5.6 `report_generate(code_change)` + `report_validate` 15 项。
6. presets/profile：6.1 coder/reviewer prompt 与 restrict 映射 → 6.2a bundle 两 preset 行 + 三委派行 + smoke（首条断言为三行委派）→ 6.2b headless 四行禁用 → 6.2c 真实 Web session log 证据 + shared.md 同步。
7. 7.1a 准备脚本 → 7.1b `shud:replay` → 7.2 控制面登记。
8. 8.1 Epic 收口 PI 验收 + ADR。

回滚：每个包独立 PR；profile 行可 `disabled: true` 关闭新 preset 与委派行而不影响 M3 主链；无 `build_id` 的 `shud_run` 执行与二进制选择不变（DataProvenance 的 `tsd.forc` 解析是唯一新失败点，由 `shud:tiny`/`shud:first-task` 回归）。

## Not yet specified

- `verification_run` 是否同时比较 `cvode_stats.txt` 的 `nst`（开放项 O2）：P1e 把 nst 作 informational；M4 只比 rivqdown，nst 比较的判据与呈现待 M5 批量运行需要时界定。
- 被拒 CR 的修订链（新 CR 与旧 CR 的 supersedes 关系）与报告中的呈现：M4 逐条列出，不定义关系。
- `builds/` 与 `repos/` 的清理与体积策略（每次构建复制一份二进制，约数 MB）。
- 多 `code_change` 卡共用同一 `repos/SHUD` 的互斥（M4 单卡单 coder；并发第二张卡的 `change_create` 会观测到他人改动）。
- coder 需要新增文件（untracked）的 CR 形态与 patch 生成（`git add -N` 或 `--intent-to-add`）。
- `threads>1` 运行的 VC 语义与 cross-N 判定（AC-S1）归并行课题。
- workspace 外的审批账本（stateDir 或 session log 交叉核对）以替代启发式治理根保护；`repos/SHUD/.git` 对象库篡改的防护。

## Open Questions

- O1（已答，用户）：Reviewer (L) 三项语义判断仍不做；reviewer 只做确定性验证与兼容结论字段。
- O2（开放）：`cvode_stats.txt` nst 比较，见 Not yet specified。
- O3（已答，用户）：GAP-02 超时与 parked/blocked 产生者继续 Non-Goals。
- O4（待实测，D11）：同包三行 `tool-subagent` 在 rc.2 的装配；由 6.2a 首条断言回答，不开 spike。
