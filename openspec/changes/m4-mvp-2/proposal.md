# Proposal

## Active issue fixture: routed #582

- Issue type: feature (public entry exposure); Fixture level: expanded because a public filesystem API is exposed, although its implementation is unchanged.
- Scope: records root index re-exports the existing ensureDirectory helper and documents its boundary; no helper, writer, tool, schema or package-map change.
- Selected risk packs: Public API / CLI / script entry; File IO / path safety / overwrite; Error handling / rollback / partial outputs; Legacy compatibility / examples; Release / packaging / dependency compatibility; Documentation / migration notes.
- Governing invariant: public and existing internal callers use the same directory policy with identical return values, errors and filesystem effects; no copied guard or wrapper.
- Preserve existing-directory false, readonly-missing false/no creation, writable-missing recursive creation/true, final symlink/non-directory rejection and unchanged raw filesystem errors.
- This is the records prerequisite for #536's all-directory preflight; the caller still owns trusted ancestors, branded path construction, call ordering and controlled tool diagnostics.
- Evidence floor: existing internal reference smoke GREEN and observed public-entry absence, built public runtime/type proof, existing readonly/unsafe-directory regressions, full check/profile/strict OpenSpec/31 generated unchanged and independent exact-head review/CI.
- Non-goals: consumer wiring, new path policy, object publication, transaction/rollback/retry, new namespaces, private subpath exports, permanent export-wiring tests or PI acceptance.

## Why

M4 的用户可见步骤是"提交 openMP RHS 切片 ChangeRequest，经 VerificationCase 判定"（`docs/04_IMPLEMENTATION/Phased_Plan.md` §0 M4 行、§4），验收门为 ADR-0002 D4：治理链路走通 + 正确性门按 serial baseline 一致性判定，不做性能复现。M3 已于 2026-11-01 通过 PI 阶段验收（ADR-0010），TaskCard → RunJob → RunRecord → EvidenceReport 主链与报告终态审批就绪；但 M4 需要的三个对象（ChangeRequest、VerificationCase、BuildRecord）在代码里不存在，`TaskTypeSchema` 没有 `code_change`，`role-tool-map.ts:29-43` 的 coder/reviewer/repo_explorer 仍是 Zero 时代工具 id，coordinator 只能派 worker，所有运行都用预构建 `SHUD_BIN`（仓库内没有任何构建步骤），`Scientific_Change_Gating_Spec.md` 引用的 semantic_level floor 配置不存在。M3→M4 边界的 dsh 升级评估由 PI 决定本轮不做（保持 `dsh-v0.2.1-rc.2`，npm latest 已是 rc.5，仅记录）。

Stage 1 压测结论（`.workplans/m4-mvp-2/grill-gate.json`，25 分支 + 3 开放项，用户确认）是本 change 的输入。两处矛盾已当场纠正：工作区 SHUD base 为 `9a422e5`（P1e StrictOMP 实现提交 `226e3ab` 的父），不是 P1e 收口 `3341368d`，否则 coder 无从"重导出"；base 的 Makefile 只在 NVECTOR 模式接 `-fopenmp`，所以切片必须含 PR-G `85c8215` 的 mode-C 接线，否则 N=1 bitwise 门对任何串行等价重构恒真。

## What Changes

- `@shud-harness/dsh-shud-core`：新增 ChangeRequest、VerificationCase、BuildRecord 三个 Zod schema 与品牌 id `CHG-/VC-/BUILD-<UTC>-xxxx`（复用 run-identifiers 生成器）；`TaskTypeSchema` 增加 `code_change`，TaskCard 增加 `linked_changes`、`linked_verifications`；StackLock 增加 nullable `build_id`（引用 build 时 `repos.SHUD` 记构建源，`build_id` 进指纹）；RunJob/RunRecord 增加 nullable `build_id` 与 `threads`；新增 `governance/semantic-level-floor.ts`（Gating §1.1 初值的 path→floor 表，未匹配路径为 `numerical_implementation`，仓库内常量、无运行时覆写，与 `wording.ts` 同一模式）与 level→risk 确定性映射；`role-tool-map` 的 coder/reviewer/repo_explorer 改为真实挂载名、coordinator `local` 扩为三个委派工具、删除 `harness.memory.propose`（K11）。`pnpm run schema:generate` 刷新 `docs/generated/`。
- `@shud-harness/dsh-shud-records`：三对象工作区文件层（`changes/<change_id>.json`、`patches/<change_id>.patch`、`verifications/<vc_id>.json`、`builds/<build_id>/{build-record.json,shud}`，复用既有原子写与路径安全）；观测工作区 `repos/SHUD` 的 `git status --porcelain` → floor 派生 → ChangeRequest 生成的纯函数；`code_change` closure 谓词与状态转换；DataProvenance 解析 `tsd.forc` 目录与每个 Filename 路径，按规范物理路径逐文件归类，将输入副本外引用文件哈希为 `external_files`；StackLock 采集接受 build 源；EvidenceReport 模板为 `code_change` 报告增加 ChangeRequest 与 VerificationCase 事实表。
- `@shud-harness/dsh-shud-jobs`：`shud_run` 提交接受可选 `build_id`（以 `builds/<build_id>/shud` 替代配置 `shudBin`，校验 BuildRecord 与二进制 sha256）与可选 `threads`（包装进程环境 `OMP_NUM_THREADS`/`SHUD_RHS_THREADS`），RunJob 记录两者；DataProvenance 生成含外部 forcing 文件。
- `@shud-harness/dsh-shud-tools`：新增 `change_create`（coder：观测 diff、派生 level/risk、落 CR(`proposed`) + patch、回写 TaskCard）、`change_submit(change_id)`（coder：高风险 level 由 policy-gate ask，allowed-once → `approved`）、`shud_build`（coder：校验工作区 `repos/SHUD` 检出的 commit 与 dirty，无 CR 要求干净树，有 CR 要求 `approved` 且观测 diff 与 patch 一致；执行 `make shud SUNDIALS_DIR=<sundialsRoot> [SHUD_ENABLE_OPENMP_RHS=1]`，产 BuildRecord 与二进制）、`verification_run`（reviewer：比较 base run 与 candidate run 的 `output/<project>.out/<project>.rivqdown.dat` SHA256，写 VerificationCase 终态与 reviewer 字段）；`shud_run` 增加 `build_id`、`threads`；`task_create` 与 `report_generate` 接受 `code_change` 卡。
- `@shud-harness/dsh-shud-policy-gate`：角色推导识别 coder/reviewer preset；`change_submit` 在 CR 的 `semantic_level` 属 gate matrix 高风险集合（`output_semantics` 及以上）时无条件 ask，`displayReason` 含 change_id、level、files_changed 与 patch 路径；M4 偏离登记：卡片 allowed-once 即批准、不要求 PI comment；拒绝不落盘、PI 的话经对话给 coder；不新增 decide 工具。raw-guard 为四个新写入根（`changes`、`patches`、`verifications`、`builds`）沿 task_create/report 工具的固定输出根保护。
- `@shud-harness/dsh-shud-presets` 与 profile：新增 coder、reviewer 两个 preset（prompt + 子树：coder 挂 tool-fs/tool-bash 与全局 shud 工具，reviewer 只读）；coordinator 子树改为三条 `tool-subagent` 行（`subagent`→worker、`subagent_coder`→coder、`subagent_reviewer`→reviewer）；restrict 面按 role-tool-map 扩；headless 安装器禁用四个 preset 行；`profile:smoke` 断言更新。
- 已知答案回放工作区契约与本机阻断闸 `pnpm run shud:replay <scratch-workspace>`：准备脚本在工作区建 `repos/SHUD`（本地 `git clone` 根 submodule 并 checkout `9a422e5`，不写 `.git/modules/SHUD`）与 `input/keliya`（复制 `../openMP/SHUD/Basins/keliya/input/keliya`，`NUM_OPENMP` 改为 1，`tsd.forc` 第 2 行改为 `forcing.trimmed` 绝对路径）；真实 Web/LLM 单提示主链：coordinator 建 `code_change` 卡 → coder 按 P1e 设计重导出 StrictOMP 实现与 mode-C 接线并 `change_create`/`change_submit`（ask 自动 Allow once，工程证据）→ coder `shud_build` 两次（base、candidate）→ worker `shud_run(build_id, threads: 1)` 跑 keliya 两次 → reviewer `verification_run` → coordinator 报告 → 报告审批。CI 不运行，不代替 PI 验收。
- 规范对齐（实现组之前）：`Minimal_Schemas.md` §8 品牌 id 与字段、`Verification_Case_Spec.md` 记录 M4 `bundle_id` nullable 偏离、`Scientific_Change_Gating_Spec.md` floor 落点、未匹配默认、M4 ask 规则与 §5 comment 偏离、`Roles_and_Boundaries.md`/`Agent_Architecture.md` §7 `code_change` 谓词措辞、`Workspace_Conventions.md` 新目录、`Phased_Plan.md` §4 验收门措辞、glossary 新术语；ADR-0011 转 implemented。
- Non-Goals 见 design.md：不做 TheoryToCodeBundle、不做跨 N 决定论、不做性能、不做 metrics/水量平衡（#422，M5）、不建 repo_explorer preset、不升级 dsh。

## Capabilities

### New Capabilities

- `change-requests`: ChangeRequest 的品牌 id、字段（观测 `files_changed`、派生 `semantic_level`/`risk`、`patch_path`、`status`、审批关联）、semantic_level floor 表与派生规则、工作区持久化、`change_create`/`change_submit` 工具契约与 TaskCard 回写。
- `verification-cases`: VerificationCase 的品牌 id、字段（`bundle_id` nullable、`case_type: regression`、`expected_result_source: baseline_regression`、确定性 `pass_criteria`、run/record/build 引用、reviewer 字段、状态）、`verification_run` 工具契约（rivqdown SHA256 bitwise 比较器与交叉校验）、持久化与 TaskCard 回写。
- `shud-build`: BuildRecord 的品牌 id 与字段（源路径、commit、dirty_paths、make argv、退出码、编译器身份、二进制 sha256、关联 CR）、工作区源检出校验规则、`shud_build` 工具契约、`builds/` 持久化。
- `known-answer-replay`: 回放工作区准备契约（`repos/SHUD@9a422e5` clone、`input/keliya` 副本及其两项准备期改写）、本机阻断闸 `shud:replay` 的驱动与判据、控制面登记、Epic 收口 PI 验收。

### Modified Capabilities

- `task-cards`: `type` 增加 `code_change`；TaskCard 增加 `linked_changes`/`linked_verifications`；`code_change` 的状态进入与 closure 谓词；`task_create` 接受 `code_change`。
- `stack-lock`: 增加 nullable `build_id`；引用 build 时 `repos.SHUD` 采自构建源、`build_id` 进指纹。
- `run-records`: RunJob/RunRecord 增加 nullable `build_id`、`threads` 与 `binary_sha256`（M2/M3 记录缺键按 `null` 解析）。
- `data-provenance`: 对输入副本外的 forcing 引用文件生成 `external_files`，逐文件归类而非按目录直接判空。
- `shud-run-tools`: `shud_run` 增加可选 `build_id`、`threads`；新增 `change_create`、`change_submit`、`shud_build`、`verification_run` 由 `dsh-shud-tools` 挂载。
- `shud-run-jobs`: 提交时以 build 二进制替代配置 `shudBin`、包装进程线程环境变量，RunJob 记录 `build_id`/`threads`。
- `evidence-reports`: `code_change` 报告的 ChangeRequest/VerificationCase 事实表、§5 固定措辞与 closure 入口。
- `policy-gate`: 角色推导识别 coder/reviewer；`change_submit` 高风险 ask 与 M4 comment 偏离；`role-tool-surface` 覆盖新角色与新工具。
- `raw-data-guard`: `change_create`/`change_submit`/`shud_build`/`verification_run` 固定输出根保护；新增固定治理根写保护（`tasks stacks provenance reports runs changes patches verifications builds` 对模型 `edit`/`write`/`bash` 写入一律 deny）。
- `agent-presets`: coder/reviewer preset 行与子树、coordinator 三条委派行、role-tool-map 真实 id、prompt 资产、smoke 断言、headless 禁用四行。
- `shud-profile`: 挂载新 preset 行与委派行；`profile:install` headless 禁用集扩为四行。
- `engineering-gates`: `shud:replay` 登记为本机阻断闸；三个新 schema 纳入 schema drift 闸。

## Impact

- 代码：`packages/dsh-shud-core/src/schemas/`、`src/governance/`（Critical Path #1/#7）；`packages/dsh-shud-records`；`packages/dsh-shud-jobs`（提交路径消费 build 与线程环境，Critical Path #4 局部）；`packages/dsh-shud-tools`（四个新工具 + `shud_run`）；`packages/dsh-shud-policy-gate`（Critical Path #3）；`packages/dsh-shud-raw-guard`（Critical Path #2）；`packages/dsh-shud-presets`；`profile/shud/`；`scripts/runtime/`（replay 脚本与工作区准备）；`constraints.yaml`、`knip.json`。
- 文档：`docs/03_SPEC/{Minimal_Schemas,Verification_Case_Spec,Scientific_Change_Gating_Spec,Workspace_Conventions}.md`、`docs/02_ARCHITECTURE/{Roles_and_Boundaries,Agent_Architecture}.md`、`docs/04_IMPLEMENTATION/{Phased_Plan,Repository_Layout,Testing_Strategy,Test_Fixtures_And_Command_Matrix}.md`、`CONTEXT.md`（新不变量伴生）、`openspec/glossary.md`、`instructions/agents/*`（经 `instructions:render`）、`docs/generated/`；两份决策记录（ADR-0011 转 implemented、M4 Epic 验收）。
- 依赖：不引入第三方新依赖、不引入 R 依赖；dsh 保持钉 `0.2.1-rc.2`；构建依赖本机 `make`、C++ 编译器、libomp 与 `SUNDIALS_ROOT`（仅本机闸）。
- 运行时：所有角色的模型文件/shell 工具不能再改写工作区治理文件（治理根 deny）；DataProvenance 自 M4 起对每次提交解析 `tsd.forc`（ccw 得空 `external_files`，解析失败是新的提交失败点）；新增模型工具 4 个（`change_create`、`change_submit`、`shud_build`、`verification_run`）、preset 2 个、委派工具 2 个；SHUD 运行路径只在传 `build_id`/`threads` 时改变二进制来源与环境；`data/raw` 不变；工作区外输入（keliya forcing.trimmed）只读引用。
- 科学边界不变：bitwise 一致只证明回放切片在 N=1 下与 serial 一致，不构成并行正确性、模型改进或性能结论；报告措辞常量与 K12 不变。
