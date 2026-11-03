# Spec Delta

## Purpose
定义 VerificationCase（已知答案回放的正确性门判定单元）的品牌 id、字段契约（M4 只生产 `regression` / `baseline_regression` / `passed|failed`，`bundle_id` 为 `null`）、`verification_run` 工具的交叉校验与 rivqdown SHA256 bitwise 比较器、工作区持久化与 TaskCard 回写，使判定由确定性 artifact 支撑、reviewer 只补充工程结论字段。

## ADDED Requirements

### Requirement: Verification identifier
`vc_id` SHALL 为品牌类型 `VerificationId`，格式 `VC-YYYYMMDDTHHMMSS-xxxx`（UTC、精确到秒，`xxxx` 为 4 位小写十六进制），与其它工作区 id 同一生成与校验规则。`VC-001`、大写十六进制与任意其它字符串 SHALL 被拒绝。

#### Scenario: branded id accepted
- **WHEN** 解析 `vc_id: "VC-20261102T101500-0c3e"`
- **THEN** 解析成功

#### Scenario: legacy id rejected
- **WHEN** 解析 `vc_id: "VC-001"`
- **THEN** 解析失败并指出 `vc_id`

### Requirement: VerificationCase record
`VerificationCaseSchema` SHALL 为严格对象，恰含：`vc_id`、`task_id`、`change_id`（`ChangeId`）、`bundle_id`（非空字符串或 `null`；M4 生产者恒写 `null`）、`case_type`（`dimension_check|mass_balance|limiting_case|manufactured_solution|regression|unit_test|tiny_basin|output_semantics`）、`expected_result_source`（`analytic|published|pi_provided|baseline_regression|agent_proposed`）、`target_code_targets`（相对 POSIX 路径数组）、`description`（非空）、`expected_result`（非空）、`pass_criteria`（非空）、`base_run_id`、`candidate_run_id`（`RunId`）、`base_build_id`、`candidate_build_id`（`BuildId`）、`artifact_refs`（相对 POSIX 路径数组，恰两项）、`observed`（`{ compared_path, base_sha256, candidate_sha256 }`）、`status`（`not_run|running|passed|failed|inconclusive|waived_by_pi`）、`failure_reason`（非空字符串或 `null`）、`reviewed_by`（非空）、`reviewer_notes`（非空字符串数组、至少一条）、`compatibility_verdict`（`compatible|incompatible|unknown`）、`created_at`。`status: passed` SHALL 要求 `observed.base_sha256 == observed.candidate_sha256` 且 `failure_reason: null`；`artifact_refs` 的两项 SHALL 是比较器实际读取并产生 `observed` 两个 sha 的文件（写入时必然存在），其后续存在性与哈希一致性由 evidence-reports「report_validate」第 (15) 项在报告校验时复核（frozen `Verification_Case_Spec.md` "passed 需 artifact"的 M4 落地）；`status: failed` SHALL 要求两 sha 不等且 `failure_reason` 非空；`expected_result_source: agent_proposed` SHALL 被 M4 生产者拒绝（期望值不能自出自判）。与 `docs/03_SPEC/Verification_Case_Spec.md` 的偏离（`bundle_id` nullable、`run_job_ids/run_record_ids` 收敛为 base/candidate 两对引用）SHALL 记入该规范的 M4 实现范围节。

#### Scenario: passed record parses
- **WHEN** 解析 `status: passed`、两 sha 相等、`failure_reason: null`、`bundle_id: null`、`case_type: regression`、`expected_result_source: baseline_regression`、`reviewer_notes` 一条的 VerificationCase
- **THEN** 解析成功

#### Scenario: passed with differing hashes rejected
- **WHEN** 解析 `status: passed` 而 `observed.base_sha256 != observed.candidate_sha256`
- **THEN** 解析失败并指出 `status`

#### Scenario: failed without reason rejected
- **WHEN** 解析 `status: failed`、`failure_reason: null`
- **THEN** 解析失败并指出 `failure_reason`

#### Scenario: empty reviewer notes rejected
- **WHEN** 解析 `reviewer_notes: []`
- **THEN** 解析失败并指出 `reviewer_notes`

### Requirement: Shared project component grammar
core SHALL 提供唯一的纯函数 `isProjectComponent(project: string): boolean`，仅拒绝空字符串、恰为 `.` 或 `..`、以及包含 `/`、反斜杠或 NUL 的字符串。SHALL NOT trim、规范化或额外限制空格、换行、Unicode、shell 标点及内嵌 `..`。jobs 的 prepareInput 与 collect SHALL 直接消费该 core 导出并保持既有校验顺序、错误与文件效果；jobs SHALL NOT 保留旧定义或兼容导出。RunJobSchema.project 的既有非空字符串规则 SHALL NOT 因此收紧。records 比较器后续复用该入口，而不是反向依赖 jobs 或复制规则。

#### Scenario: unsafe components remain rejected
- **WHEN** 传入空字符串、`.`、`..`、`a/b`、含反斜杠或 NUL 的字符串
- **THEN** 返回 false，既有提交/收集消费者保持其原拒绝语义

#### Scenario: existing ordinary components remain accepted
- **WHEN** 传入 `tiny`、`a..b`、`...`、Unicode、含空格或换行的单分量字符串以及带 shell 标点的 project
- **THEN** 返回 true；这不授权 shell 插值或改变求解器语法，仅保留原路径分量接受集合

### Requirement: Rivqdown comparator
records SHALL 提供确定性的同步函数 `compareRivqdown(baseRunDir, candidateRunDir, project)`：先验证两个运行根为绝对路径字符串、project符合core共享路径分量语法，再构造相对运行根的POSIX路径 `output/<project>.out/<project>.rivqdown.dat`。对两个最终目标分别 `lstat` 确认为普通文件后，通过no-follow/nonblocking打开及描述符普通类型/身份校验，有界读取原始字节计算sha256，依次关闭描述符，返回且仅返回 `{ compared_path, base_sha256, candidate_sha256, equal }`。任一文件缺失、为符号链接或特殊文件，以及读取/关闭失败 SHALL 抛出含相关路径的受控错误，不包含原始异常载荷或文件内容（缺证据不是 `failed`）；SHALL NOT 返回部分判定。调用方拥有运行根身份与ancestor namespace；比较器保持原始绝对根的物理路径遍历语义，不新增递归ancestor策略或文件写入。SHALL NOT 读取数值、SHALL NOT 使用容差、SHALL NOT 比较其它产物、SHALL NOT 读取日志内容。

#### Scenario: identical outputs compare equal
- **WHEN** 两个运行目录的 rivqdown 文件字节相同
- **THEN** 返回 `equal: true` 且两 sha 相同

#### Scenario: differing outputs compare unequal
- **WHEN** 候选文件与 base 文件有一个字节不同
- **THEN** 返回 `equal: false` 且两 sha 不同

#### Scenario: missing output is an error
- **WHEN** 候选运行目录没有 `output/keliya.out/keliya.rivqdown.dat`
- **THEN** 函数抛出指明路径的错误，不返回判定

#### Scenario: unsafe project is rejected before filesystem access
- **WHEN** project是空字符串、`.`、`..`、含路径分隔符或NUL，或者任一运行根不是绝对路径字符串
- **THEN** 比较器在构造目标路径与任何lstat/open/read之前拒绝，不创建或修改文件

#### Scenario: final links and non-files cannot supply evidence
- **WHEN** 任一rivqdown最终目标为符号链接、目录、FIFO或其它非普通文件，或者打开后的描述符类型/身份与预检不符
- **THEN** 抛出含目标路径的受控错误，不读取不安全目标、不返回equal判定

#### Scenario: byte evidence and descriptor lifecycle remain exact
- **WHEN** 两个普通文件字节不相等，即使文本数值可解释为相同，且所有读取与关闭成功
- **THEN** 返回equal:false及各自原始字节的SHA256；读取内存有界，第一文件描述符关闭后才打开第二个，文件bytes/mtime不变

### Requirement: verification_run
`verification_run` SHALL 由 `dsh-shud-tools` 以闭合 schema 挂载，参数：`task_id`、`base_run_id`、`candidate_run_id`（均必填，品牌校验）、`reviewer_notes`（非空字符串数组，至少一条）、`compatibility_verdict`（`compatible|incompatible|unknown`）；未知键拒绝。交叉校验（任一失败即工具错误、零写入）：卡存在、通过 schema 校验且 `type: code_change`、`status: running`；两个运行的 RunJob SHALL 取自注册表只读 `listRunJobsByTask(task_id)`（不轮询、不收集、不写文件或索引），`base_run_id` 与 `candidate_run_id` 均 SHALL 出现在其结果中（因而 RunJob `task_id` 等于参数 `task_id`），下文 RunJob 的 `job_id`、`run_dir`、`build_id`、`threads`、`binary_sha256` 均取自该结果；两个运行经注册表 `collectShud(id, {readonly: true})` 只读取得已有 RunRecord（SHALL NOT 触发收集、失败记账、状态投影或通知；未 collected 的运行即拒绝），均 `status: succeeded`、`project` 相同；两个 RunRecord 的 `task_id` SHALL 等于参数 `task_id`，且其 `job_id` SHALL 属于卡片 `linked_jobs`；两个运行的 RunJob `run_dir` 的 realpath SHALL 等于 `realpath(<session cwd>/runs/<run_id>)`（运行属于本会话工作区，`artifact_refs` 才能在会话 cwd 下解析），否则拒绝；候选 RunJob 的 `build_id` 非 `null`，其 BuildRecord `change_id` 非 `null`、该 CR `status: approved` 且 `task_id` 相同；base RunJob 的 `build_id` 非 `null`，其 BuildRecord `change_id: null`、`rhs_openmp: false`（serial baseline），且 `source_commit` 等于候选 BuildRecord 的 `source_commit`；两个 BuildRecord 的 `task_id` SHALL 等于参数 `task_id`，`source_commit` SHALL 等于卡片 `source_base_commit`；两个 RunJob 的 `threads` 均为 `1`；两个 RunJob 的 `binary_sha256` 分别等于各自 BuildRecord 的 `binary_sha256`；两个运行的 DataProvenance `files` 与 `sources.external_files` 的 `(path, sha256)` 集合相等；`reviewer_notes` 任一条命中 core `wording.ts` 禁止用语时 SHALL 返回错误（它们会渲染进报告，与模型撰写节同一护栏）。校验通过后调用「Rivqdown comparator」，`equal` → `status: passed`，否则 `status: failed` 且 `failure_reason` 为受控文本（含两 sha）；比较器错误 → 工具错误、零写入。持久化：分配 `vc_id`，以排他创建原子写 `verifications/<vc_id>.json`（EEXIST 时按 task-cards「TaskCard workspace file」规则 (4) 重新分配 id，SHALL NOT 覆盖已有 VC；字段：`change_id` 取自候选 BuildRecord 的 `change_id`（不是工具参数）、`case_type: regression`、`expected_result_source: baseline_regression`、`bundle_id: null`、`target_code_targets` = 该 CR `files_changed`、`expected_result` 与 `pass_criteria` 为固定文本、`artifact_refs` 恰为相对会话 cwd 的 `runs/<base_run_id>/output/<project>.out/<project>.rivqdown.dat` 与 `runs/<candidate_run_id>/output/<project>.out/<project>.rivqdown.dat` 两项（依此顺序）、`reviewed_by` = 调用者当前 preset 投影），再回写 TaskCard `linked_verifications`（追加排序去重，不改状态）；回写失败返回含 `vc_id` 的错误并保留 VC 文件。同一对运行可重复调用生成新 VC，SHALL NOT 改写旧 VC。结果 SHALL 含 `vc_id`、`status`、`observed` 与 `failure_reason`。

#### Scenario: replay passes
- **WHEN** reviewer 以 base 运行（null-CR 构建、threads 1、succeeded）与候选运行（approved-CR 构建、同 source_commit、threads 1、succeeded、同输入）调用 `verification_run`，两个 rivqdown 字节相同
- **THEN** 写入 `status: passed` 的 VC，其 `change_id` 等于候选 BuildRecord 的 `change_id`，`artifact_refs` 为 `runs/<base_run_id>/output/<project>.out/<project>.rivqdown.dat` 与 `runs/<candidate_run_id>/output/<project>.out/<project>.rivqdown.dat`；卡片 `linked_verifications` 含该 `vc_id`，卡状态仍 `running`；两个运行的 `run-job.json`、`run-record.json` 与索引字节不变

#### Scenario: replay fails but is recorded
- **WHEN** 同上但候选 rivqdown 与 base 不同
- **THEN** 写入 `status: failed`、`failure_reason` 含两 sha 的 VC，卡片 `linked_verifications` 含该 `vc_id`

#### Scenario: candidate build without approved change rejected
- **WHEN** 候选运行的 BuildRecord `change_id: null`，或其 CR 为 `proposed`
- **THEN** 工具返回错误并指出该 `build_id`/`change_id`，不写 `verifications/`

#### Scenario: base commit mismatch rejected
- **WHEN** base BuildRecord 的 `source_commit` 与候选不同
- **THEN** 工具返回错误并指出两个 commit，零写入

#### Scenario: build source commit differs from pinned base rejected
- **WHEN** base 与候选 BuildRecord 的 `source_commit` 相同，但不等于卡片 `source_base_commit`（例如检出在建卡后被切换到另一 commit 再构建）
- **THEN** 工具返回错误并指出该 `source_commit` 与卡片 `source_base_commit`，零写入

#### Scenario: base build with rhs_openmp true rejected
- **WHEN** base 运行的 BuildRecord 为 `change_id: null` 而 `rhs_openmp: true`
- **THEN** 工具返回错误并指出该 `build_id` 与 `rhs_openmp`，零写入

#### Scenario: run not in linked_jobs rejected
- **WHEN** 候选（或 base）运行的 RunRecord `task_id` 等于参数 `task_id`，但其 `job_id` 不在卡片 `linked_jobs` 中（例如卡片回写失败后未经 reconcile 补齐）；或其 RunRecord `task_id` 为另一张卡或 `null`
- **THEN** 工具返回错误并指出该 `run_id`/`job_id`，零写入

#### Scenario: build from another task rejected
- **WHEN** 候选或 base 运行的 BuildRecord `task_id` 不等于参数 `task_id`
- **THEN** 工具返回错误并指出该 `build_id` 与 `task_id`，零写入

#### Scenario: run outside the session workspace rejected
- **WHEN** 候选运行的 RunJob `run_dir` 位于另一会话工作区的 `runs/` 下（经完成索引可查到）
- **THEN** 工具返回错误并指出该 `run_id` 的 `run_dir`，零写入

#### Scenario: thread count other than one rejected
- **WHEN** 候选 RunJob `threads: 2` 或 `threads: null`
- **THEN** 工具返回错误并指出 `threads`，零写入

#### Scenario: input mismatch rejected
- **WHEN** 两个运行的 DataProvenance `files` 集合不同（例如 END 不同）
- **THEN** 工具返回错误并指出输入不一致，零写入

#### Scenario: forbidden phrase in reviewer notes rejected
- **WHEN** `reviewer_notes` 含 `wording.ts` 禁止用语之一（如"模型机制已验证"）
- **THEN** 工具返回错误并指出该条目，零写入

#### Scenario: run binary mismatch rejected
- **WHEN** 候选 RunJob 的 `binary_sha256` 与其 BuildRecord 的 `binary_sha256` 不同
- **THEN** 工具返回错误并指出该 `run_id`/`build_id`，零写入

#### Scenario: uncollected run rejected
- **WHEN** 候选运行仍为 `running`，或已终态但尚未 collected
- **THEN** 工具返回错误并指出该 `run_id` 当前状态，零写入，不触发该运行的收集（运行目录不新增 `run-record.json` 或 `collect-error.json`）

#### Scenario: wrong role denied before execution
- **WHEN** 当前 preset 投影为 coder 或 worker 的 Agent 调用 `verification_run`
- **THEN** policy-gate `role-tool-surface` 返回 `deny`，工具不执行

### Requirement: VerificationCase workspace files
VerificationCase SHALL 以同目录临时文件写完后排他发布（`wx` 语义，不覆盖已有文件，EEXIST 时重新分配 `vc_id`，至多 3 次）的方式原子写入会话 cwd 下的 `verifications/<vc_id>.json`；目录与文件的路径安全 SHALL 遵循 task-cards「TaskCard workspace file」规则；SHALL NOT 经 `ctx.storage` 或 stateDir 索引；查找按 id 定位、不扫描目录；读取经 schema 校验，损坏文件报错且不改写。

#### Scenario: verification file persisted
- **WHEN** `verification_run` 成功
- **THEN** `verifications/<vc_id>.json` 通过 `VerificationCaseSchema`，无临时文件残留

#### Scenario: existing verification file never overwritten
- **WHEN** 新分配的 `vc_id` 对应的 `verifications/<vc_id>.json` 已存在
- **THEN** 工具重新分配 `vc_id` 写入新文件，已有文件字节与修改时间不变

#### Scenario: symlinked verifications directory fails closed
- **WHEN** 会话 cwd 下 `verifications` 是符号链接时调用 `verification_run`
- **THEN** 工具返回错误，不写任何文件

### Requirement: VerificationCase generated projection
`pnpm run schema:generate` SHALL 把 `VerificationCaseSchema` 投影到 `docs/generated/`，`pnpm run schema:check` 在漂移时 SHALL 失败；`docs/03_SPEC/Minimal_Schemas.md` 新增的 VerificationCase 节与 `Verification_Case_Spec.md` 的 M4 实现范围节 SHALL 与本 schema 一致。

#### Scenario: projection drift blocks
- **WHEN** 修改 `VerificationCaseSchema` 而不重新生成
- **THEN** `pnpm run schema:check` 失败
