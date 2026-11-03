# Spec Delta

## Purpose
定义 ChangeRequest（一次代码变更的 patch 载体与科学分级结果）的品牌 id、字段契约、semantic_level floor 表与确定性派生规则、会话工作区文件持久化，以及 `change_create` / `change_submit` 两个工具契约与 TaskCard 回写，使分级与批准都由确定性规则而非 LLM 裁量产生。

## ADDED Requirements

### Requirement: Change identifier
`change_id` SHALL 为品牌类型 `ChangeId`，格式 `CHG-YYYYMMDDTHHMMSS-xxxx`（UTC、精确到秒，`xxxx` 为 4 位小写十六进制），与 RunJob/TaskCard id 同一生成与校验规则（`run-identifiers.ts`）。旧格式 `CHG-0001`、大写十六进制与任意其它字符串 SHALL 被拒绝。工具与策略门 SHALL 先经品牌 schema 校验 id，再由 id 拼接任何路径。

#### Scenario: branded id accepted
- **WHEN** 解析 `change_id: "CHG-20261102T093000-4a1f"`
- **THEN** 解析成功

#### Scenario: legacy and malformed ids rejected
- **WHEN** 解析 `change_id` 为 `"CHG-0001"`、`"CHG-20261102T093000-4A1F"` 或 `"../tasks/x"`
- **THEN** 解析失败并指出 `change_id`

### Requirement: ChangeRequest record
`ChangeRequestSchema` SHALL 为严格对象，恰含：`change_id`（`ChangeId`）、`task_id`（`TaskId`）、`source_path`（相对 POSIX 路径，M4 固定为 `repos/SHUD`）、`base_commit`（40 位小写十六进制 commit id，等于所属 TaskCard 的 `source_base_commit`）、`files_changed`（相对 POSIX 路径数组，非空、唯一、码点升序、无父目录穿越与 NUL）、`semantic_level`（`pure_engineering|io_format|output_semantics|numerical_implementation|parameter_default|physical_equation|model_assumption`）、`semantic_floor`（同枚举）、`floor_categories`（同枚举的数组，非空、唯一、按 `SEMANTIC_LEVEL_ORDER` 升序；SHALL 含 `semantic_floor` 且其最后一项即最大值等于 `semantic_floor`；对应 `Scientific_Change_Gating_Spec.md` 规则 6 的 `floor_categories`）、`risk`（`low|medium|high`）、`patch_path`（恒为 `patches/<change_id>.patch`）、`patch_sha256`（64 位小写十六进制）、`status`（`proposed|approved`）、`approval_ref`（非空字符串或 `null`）、`approved_at`（ISO 时间或 `null`）、`description`（字符串或 `null`）、`created_by`、`created_at`、`updated_at`。`semantic_level` SHALL 不低于 `semantic_floor`（按「Semantic level floor」的偏序）；`status: approved` SHALL 要求 `approval_ref` 与 `approved_at` 非 `null`，`proposed` SHALL 要求两者为 `null`；`risk` SHALL 等于 `riskForLevel(semantic_level)`。原 `Minimal_Schemas.md` §8 的 `interface_impact`、`compat_checks`、`gates`、`patch_bundle`、`theory_bundle_id`、`verification_case_ids`、`pi_gate_required` SHALL NOT 出现（无生产者的字段不保留）。

#### Scenario: proposed record parses
- **WHEN** 解析 `status: proposed`、`approval_ref: null`、`approved_at: null`、`base_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82"`、`semantic_floor: numerical_implementation`、`floor_categories: ["numerical_implementation"]`、`semantic_level: numerical_implementation`、`risk: high`、`files_changed: ["Makefile", "src/Model/MD_rhs_core.cpp"]` 的 ChangeRequest
- **THEN** 解析成功

#### Scenario: level below floor rejected
- **WHEN** 解析 `semantic_floor: numerical_implementation`、`semantic_level: pure_engineering` 的 ChangeRequest
- **THEN** 解析失败并指出 `semantic_level`

#### Scenario: inconsistent approval fields rejected
- **WHEN** 解析 `status: approved` 而 `approval_ref: null`，或 `status: proposed` 而 `approved_at` 非 null 的 ChangeRequest
- **THEN** 解析失败并指出对应字段

#### Scenario: legacy fields rejected
- **WHEN** 在其它方面合法的 ChangeRequest 上加入 `interface_impact` 或 `patch_bundle`
- **THEN** 解析失败

#### Scenario: invalid floor categories rejected
- **WHEN** 解析 `semantic_floor: numerical_implementation` 而 `floor_categories` 分别为 `[]`、`["output_semantics"]`（不含 floor）、`["numerical_implementation", "output_semantics"]`（未按序）、`["numerical_implementation", "numerical_implementation"]`（重复）或 `["numerical_implementation", "physical_equation"]`（最大值高于 floor）的 ChangeRequest
- **THEN** 每次解析均失败并指出 `floor_categories`

#### Scenario: abbreviated base commit rejected
- **WHEN** 解析 `base_commit` 为 `"9a422e5"` 或 `"9A422E5EB708DF7D2F8B4066A3083A031D679A82"` 的 ChangeRequest
- **THEN** 解析失败并指出 `base_commit`

### Requirement: Semantic level floor
core SHALL 导出 `SEMANTIC_LEVEL_ORDER`（七档偏序，`pure_engineering < io_format < output_semantics < numerical_implementation < parameter_default < physical_equation < model_assumption`）、`SEMANTIC_LEVEL_FLOORS`（`{pattern, floor}` 只读数组，pattern 为相对源仓库根的 glob）、`deriveSemanticFloor(paths)` 与 `riskForLevel(level)`。初值 SHALL 为 `docs/03_SPEC/Scientific_Change_Gating_Spec.md` §1.1 的表（去掉 `SHUD/` 前缀）：`src/ModelData/**`、`src/classes/**`、`src/Model/**` → `numerical_implementation`；`src/Equations/**` → `physical_equation`；`input/**/*.para*` → `parameter_default`；`src/**/IO*` → `io_format`；`src/classes/Model_Control.*`、`src/Equations/print.hpp` → `output_semantics`；`docs/**`、`scripts/**`、`templates/**` → `pure_engineering`（匹配即得该 floor）。每个路径的 floor SHALL 为**全部**匹配条目 floor 的最大值（按 `SEMANTIC_LEVEL_ORDER`），与条目在表中的顺序无关；未匹配任何条目的路径（源仓库内的其它路径，如 `Makefile`、`README.md`）SHALL 为 `numerical_implementation`（Gating 规则 2，宁高勿低）。`deriveSemanticFloor(paths)` SHALL 返回 `{ floor, categories }`：`floor` 为全部路径 floor 的最大值，`categories` 为全部路径**命中的全部条目 floor 值**（未匹配路径计入其默认 `numerical_implementation`）的去重集合、按 `SEMANTIC_LEVEL_ORDER` 升序（Gating 规则 6 的 `floor_categories`：类别不因偏序被吞，`floor` 恒为其最后一项）；`paths` 为空数组时 SHALL 抛错（调用方先以"无改动"拒绝）。`riskForLevel` SHALL 为 `pure_engineering`→`low`、`io_format`→`medium`、其余→`high`。该表 SHALL 是仓库内受测常量模块（与 `governance/wording.ts` 同一模式），SHALL NOT 经 profile 或运行时配置覆写；修改 SHALL 经 PR 审查并刷新 `docs/generated/` 投影。

#### Scenario: model path floors to numerical_implementation
- **WHEN** 对 `["Makefile", "src/Model/MD_rhs_core.cpp", "src/Model/f.cpp"]` 调用 `deriveSemanticFloor`
- **THEN** 返回 `{ floor: "numerical_implementation", categories: ["numerical_implementation"] }`（`Makefile` 未匹配，按规则 2 为 `numerical_implementation`）

#### Scenario: unmatched source path floors to numerical_implementation
- **WHEN** 对 `["README.md"]` 调用 `deriveSemanticFloor`
- **THEN** 返回 `{ floor: "numerical_implementation", categories: ["numerical_implementation"] }`

#### Scenario: documentation and scripts floor to pure_engineering
- **WHEN** 对 `["docs/x.md", "scripts/a.sh"]` 调用 `deriveSemanticFloor`
- **THEN** 返回 `{ floor: "pure_engineering", categories: ["pure_engineering"] }`

#### Scenario: all matching entries contribute
- **WHEN** 对 `["src/classes/Model_Control.cpp"]` 调用 `deriveSemanticFloor`（同时命中 `src/classes/**` → `numerical_implementation` 与 `src/classes/Model_Control.*` → `output_semantics`）；另以表中这两条的顺序对调后的表再求值
- **THEN** 两次均返回 `{ floor: "numerical_implementation", categories: ["output_semantics", "numerical_implementation"] }`，结果与条目顺序无关

#### Scenario: empty path list throws
- **WHEN** 对 `[]` 调用 `deriveSemanticFloor`
- **THEN** 抛出错误，不返回 floor

#### Scenario: risk mapping
- **WHEN** 分别对 `pure_engineering`、`io_format`、`numerical_implementation`、`model_assumption` 调用 `riskForLevel`
- **THEN** 依次返回 `low`、`medium`、`high`、`high`

### Requirement: Source change observation
本 change 新增的全部 git 调用（`task_create` 读取 `HEAD`、`change_create` 的 rev-parse/status/diff、`shud_build` 的 rev-parse/status/diff/archive/apply）SHALL 经 core `packages/dsh-shud-core/src/stack-lock/repository-revision.ts` 扩展导出的单一受控 git runner 执行；既有 `collectRepositoryRevision` 的调用方式与 StackLock 采集字节 SHALL 不变。该 runner SHALL：(a) 以 `execFile` 调用 `git`（不经 shell），子进程环境恰为白名单 `{PATH, HOME, LC_ALL=C, GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0}`（`PATH`、`HOME` 取宿主值，其余为固定值），SHALL NOT 继承 `DMXAPI_KEY`、`GIT_DIR`、`GIT_WORK_TREE` 等其它宿主变量；(b) 每次调用统一前缀 `git -C <sourceDir> -c core.fsmonitor=false`；(c) 在任何 status/diff/archive 之前校验 `realpath(sourceDir)` 等于 `realpath(git rev-parse --show-toplevel)`，不等（`sourceDir` 只是外层仓库的子目录或嵌套/外来仓库）即拒绝。

records SHALL 提供确定性函数 `observeSourceChanges(sourceDir)`：经该 runner 执行 `git status --porcelain -z --untracked-files=all`（忽略路径不计，按 NUL 分隔解析，路径不做引号转义还原），返回已跟踪文件的修改路径集合（码点升序）。存在 untracked 路径、删除或重命名 SHALL 使观测失败并列出路径（M4 不接受新文件）；`sourceDir` 不是真实目录、不是 git 工作树或未通过 (c) SHALL 失败；观测为空 SHALL 由调用方视为"无改动"。patch SHALL 经该 runner 以固定命令 `git diff HEAD --no-ext-diff --no-textconv --no-color -- <files...>`（files 为排序后的观测集合）生成，字节原样保存。

`<files...>` 表示上述真实路径身份：每个 Git pathspec 操作数 SHALL 用 `:(literal)<path>` 编码，SHALL NOT 把文件名中的 glob 或 exclusion magic 当作选择规则；返回的 `files_changed` SHALL 保持原名。M4 只接受已跟踪路径的 index/worktree `M` 与空白组合（至少一侧 `M`）；新增 `A`（含 intent-to-add）、copy、未合并、类型变化或其它未支持状态 SHALL 失败并列出路径，而不是当作普通修改继续生成记录。

#### Scenario: literal pathspec names cannot suppress tracked changes
- **WHEN** `normal.cpp` 与名为 `:(exclude)normal.cpp` 的两个已跟踪文件均被修改
- **THEN** 观测保留两个真实路径，patch 包含两个文件的改动；exclusion 名称不会把另一个文件从 diff 中排除

#### Scenario: tracked modifications observed
- **WHEN** 临时 git 仓库中修改两个已跟踪文件并新增一个被 `.gitignore` 忽略的文件后调用 `observeSourceChanges`
- **THEN** 返回恰为两个已跟踪路径（码点升序）

#### Scenario: untracked file rejects observation
- **WHEN** 仓库中存在一个未忽略的新文件
- **THEN** 观测失败，错误列出该路径

#### Scenario: deletion rejects observation
- **WHEN** 仓库中删除一个已跟踪文件
- **THEN** 观测失败，错误列出该路径

#### Scenario: special characters in paths are parsed verbatim
- **WHEN** 已跟踪文件 `src/a b.cpp` 与名字含换行符的已跟踪文件均被修改
- **THEN** 观测按 NUL 分隔原样返回这两个路径（不含引号或转义、不被换行拆开），diff 的 files 参数同为这些路径

#### Scenario: host environment and repository config do not leak into git
- **WHEN** 宿主环境含 `DMXAPI_KEY` 与指向另一仓库的 `GIT_DIR`，仓库本地配置设置了 `diff.external`、`core.fsmonitor` 与 `color.ui=always`，随后调用 `observeSourceChanges` 并生成 patch
- **THEN** git 子进程环境不含 `DMXAPI_KEY` 与 `GIT_DIR`，观测针对 `sourceDir` 本身；fsmonitor 命令与外部 diff 程序均未被执行；patch 为不含颜色转义的标准 unified diff

#### Scenario: nested directory of another repository is rejected
- **WHEN** `sourceDir` 是一个普通目录，位于另一个 git 仓库的工作树内（自身没有 `.git`）
- **THEN** 观测失败并指出 `sourceDir` 不是仓库根，未执行 status 或 diff

### Requirement: ChangeRequest workspace files
ChangeRequest SHALL 写入会话 cwd 下的 `changes/<change_id>.json`，patch SHALL 写入 `patches/<change_id>.patch`；两目录与文件的路径安全 SHALL 遵循 task-cards「TaskCard workspace file」规则（目录 `lstat` 为真实目录、目标文件非链接/特殊文件、id 先校验后拼路径）。新对象的首次落盘 SHALL 为排他创建：在同目录临时文件写满后以不覆盖的方式发布（`wx` 打开或 `link` 到最终路径，目标已存在即 EEXIST），SHALL NOT 以 `rename` 覆盖已存在的对象；`changes/<change_id>.json` 的 EEXIST SHALL 使 `change_create` 重新分配 `change_id` 后重试（最多重新分配 3 次，仍冲突即返回错误、不写 patch 与 TaskCard），已存在的对象字节不变。对已存在 CR 的后续改写（`change_submit`）SHALL 以同目录临时文件加 rename 原子替换。SHALL NOT 经 `ctx.storage` 或 stateDir 索引；查找 SHALL 按 id 直接定位，SHALL NOT 扫描目录。读取 SHALL 经 schema 校验，损坏文件 SHALL 报错且 SHALL NOT 被改写。

#### Scenario: files written atomically
- **WHEN** `change_create` 成功
- **THEN** `changes/<change_id>.json` 通过 `ChangeRequestSchema`，`patches/<change_id>.patch` 的 sha256 等于记录的 `patch_sha256`，目录中没有临时文件残留

#### Scenario: symlinked changes directory fails closed
- **WHEN** 会话 cwd 下 `changes` 是指向其它目录的符号链接时调用 `change_create`
- **THEN** 工具返回错误，不写任何文件

#### Scenario: id collision reallocates without overwriting
- **WHEN** 注入的 id 生成器首次返回一个已有 `changes/<change_id>.json` 的 id，第二次返回新 id；另一用例中连续四次返回已占用的 id
- **THEN** 前者以第二个 id 写入新 CR 与 patch，原有 CR 字节与修改时间不变；后者返回指出 id 冲突的错误，不写 patch、不改写 TaskCard，已有 CR 字节不变

### Requirement: change_create
`change_create` SHALL 由 `dsh-shud-tools` 以闭合 schema 挂载，参数：`task_id`（必填）、`semantic_level`（可选，七档之一）、`description`（可选一行）；未知键 SHALL 被拒绝。源目录 SHALL 固定为会话 cwd 下的 `repos/SHUD`，SHALL NOT 接受路径参数。执行顺序：(1) 校验 `task_id`，读取 `tasks/<task_id>/task.json`，要求 `type: code_change` 且 `status ∈ {planned, running}`，否则错误且零副作用；(2) 校验检出：`repos/SHUD` 经 `lstat` 为真实目录，经「Source change observation」的受控 runner 通过仓库根校验，且 `git rev-parse HEAD` 等于卡的 `source_base_commit`，否则返回错误"检出已偏离钉定 base"（含两者的值）、零写入；(3) 「Source change observation」，失败即错误；(4) `{ floor, categories } = deriveSemanticFloor(files_changed)`，`semantic_floor = floor`、`floor_categories = categories`，`semantic_level = max(申报值, semantic_floor)`（申报低于 floor 时不报错、取 floor 并在结果说明），`risk = riskForLevel(semantic_level)`，`base_commit` 为卡的 `source_base_commit`（即第 (2) 步核对的 `HEAD`，40 位小写十六进制）；(5) 在任何对象写入之前，对 `changes/`、`patches/`、`tasks/<task_id>/` 按 task-cards「TaskCard workspace file」规则 (2) 预检（不存在时创建；已存在须 `lstat` 为真实目录，否则返回指出该路径的错误，不写 CR、patch 或 TaskCard）；(6) 分配 `change_id`，按「ChangeRequest workspace files」排他写 CR（`proposed`）→ 排他写 patch → 回写 TaskCard（`linked_changes` 追加并排序去重；卡为 `planned` 时转 `running`、`runtime_phase: running_local`；已 `running` 不变）。第 (6) 步在 CR 落盘后任一环节失败 SHALL 返回含 `change_id` 的错误并保留已写文件。结果 SHALL 含 `change_id`、`semantic_level`、`semantic_floor`、`floor_categories`、`risk`、`files_changed`、`patch_path` 与 `status: proposed`。`change_create` SHALL NOT 触发审批，SHALL NOT 调用 LLM。

用于规范纯派生函数的候选 id 字符串 MAY 在内存中先行生成；按工作区文件规则，id 只在第 (6) 步首次排他发布时被占有。目录预检失败时 SHALL NOT 对外返回候选 id、占有对象或写入 CR/patch/TaskCard；不得为复用纯派生而引入占位 id、重复 floor 实现或额外记录构造器。异步 Git 观测后，发布边界 SHALL 使用新鲜且仍符合类型/状态/钉定 base 的 TaskCard，保留其它调用已写入的链接与 runtime_phase；不以早先快照覆盖当前卡片。此边界不声明跨 Git 命令的外部并发写入快照隔离。

#### Scenario: coder declaration below floor is raised
- **WHEN** coder 以 `semantic_level: pure_engineering` 调用 `change_create`，观测到 `src/Model/f.cpp` 被修改
- **THEN** 写入的 CR `semantic_floor` 与 `semantic_level` 均为 `numerical_implementation`、`floor_categories: ["numerical_implementation"]`、`risk: high`，结果说明申报值已被抬升

#### Scenario: declaration above floor is kept
- **WHEN** coder 以 `semantic_level: physical_equation` 调用 `change_create`，观测只有 `Makefile`
- **THEN** CR `semantic_floor: numerical_implementation`、`floor_categories: ["numerical_implementation"]`、`semantic_level: physical_equation`、`risk: high`

#### Scenario: planned card becomes running
- **WHEN** 对 `planned` 的 `code_change` 卡调用 `change_create` 成功
- **THEN** 卡片 `status: running`、`runtime_phase: running_local`，`linked_changes` 含该 `change_id`；CR 的 `base_commit` 等于卡的 `source_base_commit`

#### Scenario: wrong task type rejected
- **WHEN** 对 `science_assist` 卡或 `done` 的 `code_change` 卡调用 `change_create`
- **THEN** 工具返回错误并指出类型或状态，不写 `changes/`、`patches/`，卡片字节不变

#### Scenario: checkout drifted from pinned base
- **WHEN** `code_change` 卡的 `source_base_commit` 为 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，而 `repos/SHUD` 已被 `git commit` 或 `git checkout` 移到另一个 commit，随后调用 `change_create`
- **THEN** 工具返回"检出已偏离钉定 base"错误并给出两个 commit id，未执行 status/diff，`changes/`、`patches/` 无新文件，卡片字节不变

#### Scenario: no modifications rejected
- **WHEN** `repos/SHUD` 工作树干净时调用 `change_create`
- **THEN** 工具返回"无改动"错误，零写入

#### Scenario: untracked file rejected
- **WHEN** `repos/SHUD` 含一个未忽略的新文件
- **THEN** 工具返回错误并列出该路径，零写入

#### Scenario: unsafe output directory fails before any object write
- **WHEN** `repos/SHUD` 有合法改动，`changes/` 为真实目录而 `patches` 是符号链接或普通文件，调用 `change_create`
- **THEN** 工具返回指出 `patches` 的错误，`changes/` 中没有新 CR，TaskCard 字节不变，未分配可见的 `change_id`

### Requirement: change_submit
`change_submit` SHALL 由 `dsh-shud-tools` 以闭合 schema 挂载，唯一参数 `change_id`。执行：读取并校验 CR，要求 `status: proposed`，其 `task_id` 的卡存在且 `status: running`；随后读取 `patches/<change_id>.patch`（`patches/` 目录与文件先 `lstat`，须为真实目录与普通文件），其字节 sha256 SHALL 等于 CR 的 `patch_sha256`——patch 缺失、不可读、为链接/特殊文件或 sha256 不等时 SHALL 返回指明原因的错误且零写入（patch 在 `change_create` 之后被改动时须重新 `change_create`）；全部通过后在同步边界原子改写 CR 为 `status: approved`、`approval_ref` = 本次执行的 `exec.callId`、`approved_at` = 当前 UTC 时间、`updated_at` 更新；结果含 `change_id`、`status: approved`、`approval_ref`。已 `approved` 的 CR、未知 id、损坏文件或卡状态不符 SHALL 返回错误且零写入。工具本身 SHALL NOT 判断风险：是否弹审批卡由 policy-gate「change_submit asks for high-risk change requests」决定；该规则在 ask 之前也校验 patch sha256，工具执行时的复核覆盖审批卡展示与执行之间的改动，二者不互相替代。宿主 deny（rejected/cancelled/unavailable）时工具不执行，CR SHALL 保持 `proposed`，审计只有 `approval/asked|decided`。`approval_ref` SHALL 是执行 callId，经 session log 的 `asked.callId → asked.id → decided.id` 关联，SHALL NOT 与审批 id 混同。

#### Scenario: allowed-once approves the change
- **WHEN** coder 对 `proposed` 的高风险 CR 调用 `change_submit`，PI 在卡片选择 Allow once
- **THEN** 工具执行，CR 变为 `approved`，`approval_ref` 等于该调用的 callId 且与 session log 中 `approval/asked.callId` 相同

#### Scenario: rejected card leaves the change proposed
- **WHEN** PI 在卡片选择 Reject
- **THEN** 工具未执行，`changes/<change_id>.json` 字节不变、`status: proposed`，session log 含 `approval/asked` 与 `outcome: rejected` 的 `approval/decided`

#### Scenario: already approved rejected
- **WHEN** 对 `approved` 的 CR 再次调用 `change_submit`
- **THEN** 工具返回错误，文件字节不变，不产生第二张审批卡的执行

#### Scenario: low-risk change needs no card
- **WHEN** CR `semantic_level: pure_engineering`、patch sha256 与记录一致时调用 `change_submit`
- **THEN** 没有 `approval/asked`，CR 直接变为 `approved`，`approval_ref` 仍为执行 callId

#### Scenario: patch changed after the card was shown
- **WHEN** 高风险 CR 的审批卡已发出，PI 作答前 `patches/<change_id>.patch` 被改动一个字节，PI 随后选择 Allow once
- **THEN** 工具执行但返回指出 patch sha256 不匹配的错误，`changes/<change_id>.json` 字节不变、`status: proposed`、`approval_ref: null`

#### Scenario: missing patch blocks approval
- **WHEN** 对 `semantic_level: pure_engineering` 的 CR 调用 `change_submit`，而 `patches/<change_id>.patch` 不存在或是符号链接
- **THEN** 工具返回指出 patch 的错误，CR 字节不变

### Requirement: ChangeRequest generated projection
`pnpm run schema:generate` SHALL 把 `ChangeRequestSchema`、`SEMANTIC_LEVEL_FLOORS` 与 `SEMANTIC_LEVEL_ORDER` 投影到 `docs/generated/`，`pnpm run schema:check` 在投影漂移时 SHALL 失败；`docs/03_SPEC/Minimal_Schemas.md` §8 SHALL 与本 schema 一致。

#### Scenario: projection drift blocks
- **WHEN** 修改 `SEMANTIC_LEVEL_FLOORS` 而不重新生成
- **THEN** `pnpm run schema:check` 失败并指出 `docs/generated/` 差异
