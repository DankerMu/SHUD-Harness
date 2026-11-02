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

### D3 `shud_build` 工具契约：构建输入 = (钉定 commit, 已批 patch)

- 参数（闭合 schema，未知键拒绝）：`task_id`（必填，`planned|running` 的 `code_change` 卡）、`change_id`（可选）、`rhs_openmp`（可选布尔，缺省 `false`）。源目录固定为 `<cwd>/repos/SHUD`（不接受路径参数）。
- 检出校验（任一失败即工具错误、零副作用）：`repos/SHUD` `lstat` 为真实目录、`realpath` 等于 `git rev-parse --show-toplevel` 的 realpath（排除嵌套/外来仓库）、`git rev-parse HEAD` 等于卡的 `source_base_commit`；观测 = `git status --porcelain -z --untracked-files=all`（忽略路径不计）。无 `change_id` 时观测必须为空（base 构建，用户决定）；有 `change_id` 时读取 CR，要求 `status: approved`、`task_id` 相同、`base_commit == HEAD`，`patches/<change_id>.patch` 为普通文件且 sha256 == `patch_sha256`，观测路径集合 == `files_changed`，且 `git diff HEAD --no-ext-diff --no-textconv --no-color -- <files_changed>` 的字节 sha256 == `patch_sha256`。工作树检查是一致性检查（coder 看到的树就是要构建的树），不是构建输入。
- 构建输入绑定（Review 2 P1-2 的修复）：在 `builds/.tmp-<build_id>/`（排他 `mkdir`，EEXIST 重分配 id）内 `git archive --format=tar <source_commit>` 解包到 `src/`；解包后断言 `src/` 的条目集合等于 `git ls-tree -r <source_commit>`（防 `export-ignore`/`export-subst` 改变构建树）；有 `change_id` 时在 `src/` 内 `git apply --check` 再 `git apply`（失败即错误并删除临时目录；`git apply` 另设 `GIT_CEILING_DIRECTORIES=<tmp realpath>`——子代理实测在外层仓库的子目录内 `git apply` 会静默 rc=0 不改文件——并在 apply 后断言 patch 已生效）；`make -C <tmp>/src shud SUNDIALS_DIR=<sundialsRoot>`，`rhs_openmp` 为真时追加 `SHUD_ENABLE_OPENMP_RHS=1`；`sundialsRoot` 取 `shud-jobs` 行配置（未配置时工具错误，不猜路径）；环境只继承 `PATH`/`HOME` 与 `SUNDIALS_DIR`（白名单，不含 `DMXAPI_KEY`）；不传 `-s`，`make.stdout.log` 保留回显的编译命令（`-fopenmp` 证据，D13）。同步等待（本机 `make shud` 约 8 s）。因此工作树里被 `.gitignore` 忽略的源文件、`repos/SHUD/shud` 陈旧二进制、并发的另一次构建都不进入本次构建；`shud_build` 对 `repos/SHUD` 零写入。
- 产物：`make` 退出 0 且 `src/shud` 为普通可执行文件时，复制为 `<tmp>/shud`，计算 sha256；`compiler` 在 `src/` 内以 `make -s -f Makefile -f <tmp>/print-cxx.mk print-cxx` 取 `$(CXX)` 再取 `<cxx> --version` 首行（`print-cxx.mk` 由工具写入临时目录）；删除 `src/` 与 `print-cxx.mk`，写 `build-record.json`，整目录 `rename` 为 `builds/<build_id>/`。`make`/`git apply` 非零或产物缺失：工具错误含退出码、失败阶段与 make 输出末尾至多 40 行（不含环境变量值），临时目录删除（错误不引用已删除的日志路径），不留 `builds/<build_id>/`、不写 BuildRecord。
- 回写：成功后 TaskCard 不记录 build（build 经 RunJob/StackLock 可追溯），不改卡状态。
- git 调用全部经 core `repository-revision.ts` 扩展的受控 runner（D4）。
- 为什么不把构建并入 `shud_run`、不让 coder 裸 `make`：grill 否决；BuildRecord 是 StackLock 与 VerificationCase 交叉校验的锚。为什么不直接在工作树上 `make`：工作树不是可审计的输入（忽略文件、陈旧目标、并发），archive+apply 的成本只是一次解包。

### D4 `change_create`：观测 diff 与 floor 派生（Critical Path #1）

- 参数：`task_id`（必填）、`semantic_level`（可选，coder 申报）、`description`（可选一行）。源目录固定 `repos/SHUD`。
- 前置：卡 `type: code_change`、`status ∈ {planned, running}`；`changes/`、`patches/`、`tasks/<task_id>/` 按工作区文件规则 (2) 检查（真实目录或创建）；`repos/SHUD` 的 `git rev-parse HEAD` 必须等于卡的 `source_base_commit`，否则错误"检出已偏离钉定 base"、零写入（coder 的 `git commit` 不能把改动移出观测——Review 2 P1-4）。
- 观测：`git status --porcelain -z --untracked-files=all`；存在 untracked（非忽略）路径 → 工具错误并列出路径（Non-Goal：M4 不接受新文件）；存在删除/重命名 → 同样拒绝；观测为空 → 工具错误"无改动"。`files_changed` = 修改的已跟踪文件，POSIX 相对路径排序。
- 派生：`deriveSemanticFloor(files_changed)`（D6）给出 `{floor, categories}`；`semantic_floor = floor`、`floor_categories = categories`；`semantic_level` = coder 申报值与 floor 的最大值，申报低于 floor 时不报错、取 floor 并在结果中说明（"coder 只能向上调"）；`risk` 由 level 映射。
- patch：`git diff HEAD --no-ext-diff --no-textconv --no-color -- <files_changed...>` 的字节原样写 `patches/<change_id>.patch`，sha256 记入 CR；同一命令在 `shud_build` 复核。
- git 调用加固（Review 2 P1-3）：`task_create` 取 HEAD、`change_create`、`shud_build` 的全部 git 调用经 core `stack-lock/repository-revision.ts` 扩展导出的单一 runner：env 白名单 `{PATH, HOME, LC_ALL=C, GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0}`（`git apply` 另加 `GIT_CEILING_DIRECTORIES`，且它在 `<tmp>/src` 这个非仓库目录内运行、不做 toplevel 校验）、`-c core.fsmonitor=false`、status `-z`、diff 禁外部 diff/textconv/颜色、realpath == toplevel；既有 `collectRepositoryRevision` 与 StackLock 采集字节不变。
- 持久化顺序：CR JSON（`proposed`）→ patch → TaskCard 回写（`linked_changes` 追加；卡 `planned` 时转 `running`、`runtime_phase: running_local`；已 `running` 不变）；任一步失败返回含 `change_id` 的错误，已写文件保留（与 M3 `shud_run` 回写失败"运行已 durable"同一语义）。
- `change_create` 不 ask：它只生成对象（对应 `report_generate`）。备选"单一 change_submit 一次完成"被 pre-execute 顺序否决：ask 先于执行，被拒即无 durable 记录。

### D5 `change_submit` 与 policy-gate ask（Critical Path #3）

- 参数：`change_id`。工具读取 CR，要求 `proposed`、`task_id` 的卡存在且 `running`，`lstat` 读取 `patches/<change_id>.patch` 并校验 sha256 == `patch_sha256`（不等 → 错误、零写入），然后原子写 `status: approved`、`approval_ref: exec.callId`、`approved_at`；CR 无 Markdown 投影。已 `approved` 的 CR 再次调用返回错误（不重复审批）。
- policy-gate：在 `role-tool-surface` 未 deny 后，对 `change_submit` 读取 `changes/<change_id>.json`（经 schema 校验，只读 `changes/` 之内）与 `patches/<change_id>.patch`（只读 `patches/` 之内）：两者均可读而 patch sha256 ≠ `patch_sha256` → `deny`，reason 为导出受控常量（code `change-patch-mismatch`），不 ask（PI 不应为与记录不符的 patch 发卡）；否则 `semantic_level ∈ {output_semantics, numerical_implementation, parameter_default, physical_equation, model_assumption}` → `ask`，`reason` = 导出前缀常量 + 空格 + `change_id`（id 缺失/非法 → 前缀 + 受控标记，不含原始参数）；`displayReason.{en,zh}` 含 `change_id`、`semantic_level`、`semantic_floor`、`floor_categories`、`risk`、`files_changed` 全列表、`patches/<change_id>.patch` 路径与 `description`，PI 可在卡片决定前打开 patch。`pure_engineering`/`io_format` → `next`（不 ask）。CR 文件缺失/损坏或 patch 缺失/不可读 → 仍 `ask`（fail-closed：不因读不到而放行），`displayReason` 含"无法读取"。
- 审计：策略门的决策审计对 `change_submit` 的 ask 使用新导出常量 `change-approval` 作为 code，载荷只含经品牌校验的 `change_id` 与 `semantic_level`，不含 `files_changed`、`description`、patch 内容或原始参数（这些只进 `displayReason`）；patch 不符的 deny 记 `deny change_submit change-patch-mismatch`。既有「Global pre-execute mounting」「Policy core deny layer」「Policy decision audit」「Host fail-closed approval outcome」四条措辞随之扩到三个 ask 工具。
- 宿主结果：allowed-once → 工具执行写 `approved`；rejected/cancelled/unavailable → 宿主 deny，工具不执行，CR 保持 `proposed`，审计只有 `approval/asked|decided`。danger-full-access 会话同样发卡（#511）。PI 的拒绝理由经对话到 coordinator → coder（ADR-0011 的对话承载），不落盘（D15 偏离）。
- `shud_build` 只接受 `approved` CR，所以"无 ask 窗口"不存在：policy-gate 行在 M3 已挂载，新规则与新工具同一切片落地（见 Migration Plan）。

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

### D9 build 与 run 的绑定：`shud_run(build_id, threads)`、StackLock、RunJob（Critical Path #4 局部）

- `shud_run` 新增可选 `build_id`（品牌 `BuildId`）与 `threads`（正整数）。注册表在输入复制之后、StackLock 采集之前解析 `builds/<build_id>/build-record.json`（schema 校验、`task_id` 与本次相同或本次无 task）、校验 `builds/<build_id>/shud` 为普通可执行文件且 sha256 == `binary_sha256`，随后把它原子复制为 `<run_dir>/bin/shud`（临时文件 + rename，0755）并让包装进程执行该副本（关闭"校验后、执行前被替换"的窗口，运行目录自包含）；RunJob/RunRecord 新增 `binary_sha256`（非 null 当且仅当 `build_id` 非 null；M2/M3 记录缺该键按 null 解析，iff 约束在默认值之后求值）。任一失败走既有提交回滚（不留运行目录）。无 `build_id` 时执行与二进制选择逐字节沿用 M2/M3 路径（DataProvenance 的 `tsd.forc` 解析除外，见 D10）。
- `threads` 提供时，包装进程环境追加 `OMP_NUM_THREADS=<n>` 与 `SHUD_RHS_THREADS=<n>`；不提供时不设置（继承宿主）。RunJob/RunRecord 新增 nullable `build_id` 与 `threads`，collect 原样继承。M3 规范中"`threads: 4` 为未知参数"的场景改为"`threads: 0`/非整数被拒绝"。
- StackLock：引用 build 时 `repos.SHUD` = BuildRecord 的 `{source_commit, source_branch, dirty: dirty_paths.length>0, dirty_paths, dirty_paths_truncated:false}`，`build_id` 字段为该 id 并进入指纹；无 build 时 `build_id: null`、`repos.SHUD` 仍采根 submodule。因此 base 与 candidate 运行必然得到两个不同的 StackLock；报告逐 lock 列出。`rSHUD`/`AutoSHUD` 不变。
- raw-guard：`shud_run` 的三写入根判定不变；`builds/` 是读取源，不纳入写入根。

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

### D10 DataProvenance 的外部 forcing 引用

- `generateProvenance` 在遍历副本后解析 `<copied input>/<project>.tsd.forc`：第 2 行为 forcing 目录；相对路径按运行目录解析（SHUD 以运行目录为 cwd；ccw 的 `./input/ccw/` 落在副本内）。解析结果（realpath）位于副本目录之内 → `external_files: []`；位于副本外 → 第 3 行起的表格每行最后一列 `Filename` 拼该目录，逐一 `lstat` 为普通文件、计算 sha256 与字节数，按路径排序写入新增字段 `sources.external_files: [{path(绝对), sha256, size_bytes}]`（M3 记录读取时 `default([])`，不改写）。目录不存在、文件缺失、非普通文件或 `tsd.forc` 解析失败 → 提交失败并回滚（不降级为空列表）。这对 ccw 与所有无 build 提交同样生效：是 M4 对无 build 路径唯一的行为变化，Migration 回滚不声称"逐字节不变"。
- `external_files` 的路径可能指向 `data/raw` 之外的任意只读目录（keliya 在 `../openMP`）；raw-guard 对 `shud_run` 的 `input_dir` 判定不变，不对外部 forcing 目录做 ask（它不是参数，也不被写入）。

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

### D12 报告：`code_change` 的事实表与固定措辞（Critical Path #6）

- `report_generate` 对 `code_change` 卡求 D7 谓词；报告 `.json` 新增 `change_ids`、`verification_ids`（M3 报告 `default([])`），生成投影随之更新。
- `.md` 事实表新增三段（由对象确定性生成）：ChangeRequest（`change_id`、`base_commit`、`semantic_level`/`semantic_floor`/`floor_categories`/`risk`、`files_changed`、`patches/<id>.patch` 路径与 sha256、`status`、`approval_ref`）；VerificationCase（`vc_id`、`case_type`、`expected_result_source`、`pass_criteria`、`base_run_id`/`candidate_run_id`、两个 `build_id`、两个 sha256、`status`、`failure_reason`、`reviewed_by`、`compatibility_verdict`、`reviewer_notes` 逐条）；BuildRecord（每个 VC 的两个构建：`build_id`、`change_id`、`source_commit`、`rhs_openmp`、`make_argv`、`compiler`、`patch_sha256`、`binary_sha256`——让 PI 在报告里看到候选确实带 OpenMP 构建）。StackLock 表逐 lock 列出 `build_id`。
- §5 对 `code_change` 固定写："本里程碑无指标 artifact；验证判定见 §3 VerificationCase 表。bitwise 一致只证明候选在 N=1 下与 serial baseline 输出一致，不构成并行正确性、性能或模型改进结论。"（该句进入 `wording.ts` 常量并由模板逐字渲染）。§7 另列 `status: failed` 的 VC。
- `report_validate` 增至 15 项：(14) `code_change` §5 固定句；(15) `verification_ids` 中每个 VC 的 `artifact_refs` 两项均为会话 cwd 下的普通文件且 sha256 分别等于 `observed.base_sha256`/`candidate_sha256`（frozen `Verification_Case_Spec.md` 的"passed 需 artifact"在 M4 的落地：`verification_run` 写入时两个 artifact 刚被比较器读过、必然存在，第 (15) 项在报告校验时复核它们仍存在且未改；Review 2 P1-7）。其余 10 节、7 态水印、四句不变式、禁语与密钥扫描不变；`Report_Generation_Spec.md` 的"13 项"改为 15 项。

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
