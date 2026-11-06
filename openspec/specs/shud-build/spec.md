# shud-build Specification

## Purpose
定义 BuildRecord（一次工作区内 SHUD 构建的身份与证据）的品牌 id、字段契约、工作区源检出校验规则、`shud_build` 工具契约与 `builds/` 持久化，使候选二进制与已批 ChangeRequest 的精确 patch 一一对应，base 二进制与钉定 commit 的干净源树一一对应，并成为 StackLock 与 VerificationCase 交叉校验的锚。

## Requirements

### Requirement: Build identifier
`build_id` SHALL 为品牌类型 `BuildId`，格式 `BUILD-YYYYMMDDTHHMMSS-xxxx`（UTC、精确到秒，`xxxx` 为 4 位小写十六进制），与其它工作区 id 同一生成与校验规则；其它格式 SHALL 被拒绝。

#### Scenario: branded id accepted
- **WHEN** 解析 `build_id: "BUILD-20261102T100000-7b2d"`
- **THEN** 解析成功

#### Scenario: malformed id rejected
- **WHEN** 解析 `build_id: "BUILD-1"` 或 `"build-20261102T100000-7b2d"`
- **THEN** 解析失败并指出 `build_id`

### Requirement: BuildRecord record
`BuildRecordSchema` SHALL 为严格对象，恰含：`build_id`、`task_id`、`change_id`（`ChangeId` 或 `null`；`null` 表示 base 构建）、`patch_sha256`（64 位小写十六进制或 `null`）、`source_path`（相对 POSIX 路径，M4 固定 `repos/SHUD`）、`source_commit`（40 位小写十六进制 commit id，等于所属 TaskCard 的 `source_base_commit`，也是构建归档的 commit）、`source_branch`（非空）、`dirty_paths`（相对 POSIX 路径数组，排序唯一；语义为构建时对 `repos/SHUD` 工作树的观测，不是构建输入）、`make_argv`（非空字符串数组）、`sundials_dir`（绝对路径）、`rhs_openmp`（布尔）、`compiler`（非空，构建所用 `$(CXX)` 的 `--version` 首行）、`exit_code`（恒 `0`：失败构建不产生记录）、`duration_seconds`（非负数）、`binary_path`（恒 `builds/<build_id>/shud`）、`binary_sha256`（64 位小写十六进制）、`stdout_path`、`stderr_path`（`builds/<build_id>/make.stdout.log` / `make.stderr.log`）、`created_at`。`change_id: null` SHALL 要求 `dirty_paths` 为空且 `patch_sha256` 为 `null`；`change_id` 非 `null` SHALL 要求 `dirty_paths` 非空且 `patch_sha256` 非 `null`（`shud_build` 写入的值等于该 ChangeRequest 的 `patch_sha256`，即实际应用到构建源树的 patch 字节的 sha256）。

#### Scenario: base build record parses
- **WHEN** 解析 `change_id: null`、`patch_sha256: null`、`dirty_paths: []`、`rhs_openmp: false`、`exit_code: 0`、`source_commit: "9a422e5eb708df7d2f8b4066a3083a031d679a82"` 的 BuildRecord
- **THEN** 解析成功

#### Scenario: candidate build record parses
- **WHEN** 解析 `change_id: "CHG-20261102T093000-4a1f"`、`patch_sha256` 为 64 位小写十六进制、`dirty_paths: ["Makefile", "src/Model/MD_rhs_core.cpp"]`、`rhs_openmp: true` 的 BuildRecord
- **THEN** 解析成功

#### Scenario: base build with dirty paths rejected
- **WHEN** 解析 `change_id: null` 而 `dirty_paths` 非空
- **THEN** 解析失败并指出 `dirty_paths`

#### Scenario: patch digest must follow the change id
- **WHEN** 解析 `change_id: null` 而 `patch_sha256` 非 `null`，或 `change_id` 非 `null` 而 `patch_sha256: null`
- **THEN** 解析失败并指出 `patch_sha256`

#### Scenario: abbreviated source commit rejected
- **WHEN** 解析 `source_commit: "9a422e5"` 的 BuildRecord
- **THEN** 解析失败并指出 `source_commit`

#### Scenario: nonzero exit code rejected
- **WHEN** 解析 `exit_code: 2`
- **THEN** 解析失败并指出 `exit_code`

### Requirement: Workspace source checkout validation
`shud_build` 的源目录 SHALL 固定为会话 cwd 下的 `repos/SHUD`（SHALL NOT 接受路径参数）。全部 git 调用 SHALL 经 change-requests「Source change observation」定义的 core 受控 git runner（`packages/dsh-shud-core/src/stack-lock/repository-revision.ts` 扩展导出；env 白名单 `{PATH, HOME, LC_ALL=C, GIT_OPTIONAL_LOCKS=0, GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_TERMINAL_PROMPT=0}`、统一前缀 `-c core.fsmonitor=false`）。工具 SHALL 校验：该路径 `lstat` 为真实目录（非符号链接）；`realpath(repos/SHUD)` 等于 `realpath(git rev-parse --show-toplevel)`（嵌套于外层仓库的普通目录或外来仓库即拒绝）；`git rev-parse HEAD` 等于 `task_id` 所指 TaskCard 的 `source_base_commit`，否则返回"检出已偏离钉定 base"错误；观测 = `observeSourceChanges(repos/SHUD)`（`git status --porcelain -z --untracked-files=all`，忽略路径不计）。无 `change_id` 时观测 SHALL 为空（base 构建）；有 `change_id` 时 SHALL 读取并校验 CR，要求 `status: approved`、`task_id` 与参数相同、`base_commit` 等于卡的 `source_base_commit`，观测路径集合 SHALL 等于 `files_changed`，`git diff HEAD --no-ext-diff --no-textconv --no-color -- <files_changed...>` 的字节 sha256 SHALL 等于 `patch_sha256`，且 `patches/<change_id>.patch`（`patches/` 与文件先 `lstat`，须为真实目录与普通文件）的字节 sha256 SHALL 等于 `patch_sha256`。工作树观测与 diff 校验是工作树一致性检查（检出须恰好反映已批 patch），SHALL NOT 被当作构建输入：构建输入只有 `source_commit` 的归档与已校验的 patch 文件字节（见「shud_build」）。任一校验失败 SHALL 返回指明原因的工具错误，SHALL NOT 启动 `make`，SHALL NOT 写任何文件。工具 SHALL NOT 创建或切换检出：检出由回放工作区准备契约（known-answer-replay「Replay workspace preparation」）拥有。

#### Scenario: clean tree required for base build
- **WHEN** 不带 `change_id` 调用 `shud_build`，而 `repos/SHUD` 有一个已跟踪文件被修改
- **THEN** 工具返回错误并列出该路径，没有 `make` 进程、`builds/` 无新目录

#### Scenario: candidate build requires exact approved diff
- **WHEN** 以 `approved` CR 调用 `shud_build`，而工作树除 CR 的 `files_changed` 外还修改了另一个文件，或某文件内容与 patch 不同
- **THEN** 工具返回错误并指出路径集合或 sha256 不匹配，不启动 `make`

#### Scenario: tampered patch file rejected
- **WHEN** 以 `approved` CR 调用 `shud_build`，工作树 diff 与 `patch_sha256` 一致，但 `patches/<change_id>.patch` 在批准后被改动一个字节或替换为符号链接
- **THEN** 工具返回指出 patch 文件的错误，不执行 `git archive` 与 `make`，`builds/` 无新目录

#### Scenario: proposed change cannot build
- **WHEN** 以 `status: proposed` 的 CR 调用 `shud_build`
- **THEN** 工具返回错误并指出 CR 状态，不启动 `make`

#### Scenario: checkout drifted from pinned base
- **WHEN** 卡的 `source_base_commit` 为 `9a422e5eb708df7d2f8b4066a3083a031d679a82`，`repos/SHUD` 的 `HEAD` 已被移到另一个 commit，分别以无 `change_id` 与 `approved` CR 调用 `shud_build`
- **THEN** 两次均返回"检出已偏离钉定 base"错误并给出两个 commit id，不启动 `make`、`builds/` 无新目录

#### Scenario: missing checkout fails closed
- **WHEN** 会话 cwd 下没有 `repos/SHUD`，或它是符号链接、或不是 git 工作树、或是位于外层 git 仓库工作树内的普通目录（`--show-toplevel` 指向外层仓库）
- **THEN** 工具返回错误并指出该路径，零副作用

### Requirement: shud_build
`shud_build` SHALL 由 `dsh-shud-tools` 以闭合 schema 挂载，参数：`task_id`（必填，`type: code_change` 且 `status ∈ {planned, running}` 的卡）、`change_id`（可选）、`rhs_openmp`（可选布尔，缺省 `false`）；未知键拒绝。`sundialsRoot` 取 `shud-jobs` 行配置，未配置 SHALL 在任何写入前返回错误，不猜路径。通过「Workspace source checkout validation」后按以下顺序执行；工具 SHALL NOT 向 `repos/SHUD` 写入、删除或改动任何文件，在 `builds/.tmp-<build_id>/`（下称 `<tmp>`）之外 SHALL NOT 写文件（发布时的整目录 `rename` 除外）：

1. `builds/` 按 task-cards「TaskCard workspace file」规则 (2) 预检；分配 `build_id`，以排他 `mkdir` 创建 `<tmp>`（EEXIST 或 `builds/<build_id>/` 已存在时重新分配 `build_id`，最多重新分配 3 次，仍冲突即返回错误）。
2. 构建源树：创建空目录 `<tmp>/src/`，经受控 runner 执行 `git archive --format=tar <source_commit>`（`-C repos/SHUD`），以 `tar -x -C <tmp>/src` 解包；`<tmp>/src/` 即 SHUD 源树根（SHUD 自身的 `src/Model/…` 位于 `<tmp>/src/src/Model/…`）。`repos/SHUD` 中的未跟踪文件、被忽略文件（如 `.gitignore` 的 `shud`、`shud.*` 所匹配的文件）与陈旧构建产物因此不会进入构建源树。解包后 SHALL 断言 `<tmp>/src/` 的条目（路径、类型与 blob id，blob id 经受控 runner 以 `git hash-object --no-filters` 计算）恰等于 `git ls-tree -r <source_commit>` 的结果；`export-ignore`、`export-subst` 等归档属性（含 `repos/SHUD/.git/info/attributes` 中的设置）造成的任何差异即失败并删除 `<tmp>`。
3. 有 `change_id` 时：把校验时读取并核对过 sha256 的 patch 字节写入 `<tmp>/change.patch`（不再从 `patches/` 重读），在 `<tmp>/src/` 内依次执行 `git apply --check <tmp>/change.patch` 与 `git apply <tmp>/change.patch`；两条命令沿用受控 runner 的 env 白名单与 `-c core.fsmonitor=false` 前缀（`<tmp>/src/` 不是仓库，不做仓库根校验），并另设 `GIT_CEILING_DIRECTORIES=<tmp 的绝对 realpath>`，使 git 不向上发现外层仓库——工作区位于某个 git 仓库内时，未设该变量的 `git apply` 会忽略当前子目录以外的路径并以退出码 0 静默不改任何文件（本机实测）。apply 之后 SHALL 断言 `files_changed` 中每个路径在 `<tmp>/src/` 内的字节与解包时不同，否则以"patch 未生效"错误失败。任一步失败 SHALL 返回错误并删除 `<tmp>`。
4. `make`：以 session cwd 为工作目录同步执行 `make -C builds/.tmp-<build_id>/src shud SUNDIALS_DIR=<sundialsRoot>`（`rhs_openmp` 为真时追加 `SHUD_ENABLE_OPENMP_RHS=1`）；`make_argv` 记录该 argv 原样。子进程环境 SHALL 只含 `PATH`、`HOME`、`SUNDIALS_DIR`（白名单），SHALL NOT 含 `DMXAPI_KEY` 或其它宿主变量；stdout/stderr 分别写入 `<tmp>/make.stdout.log` 与 `<tmp>/make.stderr.log`。工具 SHALL NOT 传 `-s`/`--silent` 或以其它方式静默 make，SHALL NOT 修改 Makefile：`make.stdout.log` SHALL 含 make 回显的编译与链接命令行，作为构建所用编译标志（如 `-fopenmp`）的直接证据。
5. `make` 退出 0 且 `<tmp>/src/shud` 为普通可执行文件时：复制为 `<tmp>/shud` 并计算 sha256；采集 `compiler`——工具把只含目标 `print-cxx`（输出 `$(CXX)`）的片段写入 `<tmp>/print-cxx.mk`，在同一 env 白名单与同样的变量参数下执行 `make -s -C builds/.tmp-<build_id>/src -f Makefile -f <tmp 的绝对路径>/print-cxx.mk print-cxx` 取得 `$(CXX)`（须为非空单个词，否则失败），再执行 `<cxx> --version` 取首行；该探测的输出不写入 `make.stdout.log`。随后删除 `<tmp>/src/`、`<tmp>/change.patch` 与 `<tmp>/print-cxx.mk`，写 `<tmp>/build-record.json`，把 `<tmp>` 整目录 `rename` 为 `builds/<build_id>/`；发布后的目录恰含 `shud`、`build-record.json`、`make.stdout.log`、`make.stderr.log`。
6. `make` 非零、产物缺失或非普通可执行文件、或 `compiler` 探测失败：返回含退出码、失败阶段与 `make.stderr.log`/`make.stdout.log` 末尾至多 40 行（不含任何环境变量值）的错误，删除 `<tmp>`（因此错误中不引用已删除的日志路径），SHALL NOT 留下 `builds/<build_id>/` 或 BuildRecord。

成功 SHALL NOT 改变 TaskCard。BuildRecord 的 `source_commit` 为卡的 `source_base_commit`，`dirty_paths` 为构建时工作树观测（base 为 `[]`，候选等于 `files_changed`），`patch_sha256` 为 CR 的值或 `null`。结果 SHALL 含 `build_id`、`change_id`、`patch_sha256`、`source_commit`、`rhs_openmp`、`binary_sha256`、`duration_seconds`。

#### Scenario: base build succeeds
- **WHEN** 以真实临时 git 仓库（提交了一个产出可执行 `shud`、配方不带 `@` 前缀的假 `Makefile`）作为 `repos/SHUD`、HEAD 等于卡的 `source_base_commit`，调用 `shud_build`（无 `change_id`）
- **THEN** 出现恰含 `shud`、`build-record.json`、`make.stdout.log`、`make.stderr.log` 的 `builds/<build_id>/`（无 `src/`、`print-cxx.mk`、`change.patch`），记录 `change_id: null`、`patch_sha256: null`、`rhs_openmp: false`、`source_commit` 等于卡的 `source_base_commit`、`make_argv` 含 `-C`、`builds/.tmp-<build_id>/src` 与 `SUNDIALS_DIR=<sundialsRoot>` 且不含 `SHUD_ENABLE_OPENMP_RHS=1` 与 `-s`，`make.stdout.log` 含假 Makefile 回显的编译命令行，`compiler` 等于独立执行 `$(CXX) --version` 的首行，`binary_sha256` 等于对 `shud` 独立计算的值；`repos/SHUD` 中全部文件的字节与修改时间不变，其中没有新出现或被删除的 `shud`

#### Scenario: candidate build passes the openmp flag
- **WHEN** 以 `approved` CR 与 `rhs_openmp: true` 调用 `shud_build`，工作树 diff 与 patch 一致，假 `Makefile` 把 `src/Model/f.cpp` 的内容嵌入产出的 `shud`
- **THEN** 记录 `change_id` 为该 CR、`patch_sha256` 等于 CR 的值、`dirty_paths` 等于 `files_changed`、`make_argv` 含 `SHUD_ENABLE_OPENMP_RHS=1`、`rhs_openmp: true`；`builds/<build_id>/shud` 含 patch 之后的 `f.cpp` 内容

#### Scenario: unexpected publication entries fail closed
- **WHEN** 主构建或编译器探测在 `<tmp>` 顶层留下额外条目，或使应发布的日志或可执行文件缺失或不再为普通文件
- **THEN** 工具在写 BuildRecord 与整目录发布前拒绝；失败清理自有临时目录，不改变源检出或 TaskCard；规范发布器不承担工具专属的文件清单校验

#### Scenario: compiler probing cannot change the hashed executable
- **WHEN** 初次复制与 sha256 计算成功后，编译器选择 make 或 `<cxx> --version` 改写 `<tmp>/shud` 的内容或使其不再是普通且对当前进程可执行的文件
- **THEN** 工具在发布前复核文件类型、有效执行权限及与初次计算值相同的 sha256，拒绝变化并清理自有临时目录，不把变化后的二进制重新认定为有效构建；源检出与 TaskCard 不变

#### Scenario: compiler probing preserves main make logs
- **WHEN** 主构建替换最初创建的 stdout/stderr 日志文件，或后续编译器选择 make / `<cxx> --version` 替换日志或改写主构建结束后的日志字节
- **THEN** 工具基于创建时的日志文件身份及主构建结束后的内容摘要在发布前拒绝；不发布包含伪造或探测污染日志的 BuildRecord，清理自有临时目录并保持源检出与 TaskCard 不变；主构建向原日志描述符写入正常输出不被拒绝

#### Scenario: ignored file in the working tree does not reach the build
- **WHEN** `repos/SHUD` 中存在被 `.gitignore`（`shud.*`）忽略的未跟踪文件 `src/Model/shud.extra.cpp`，假 `Makefile` 以 shell glob `SRC = src/*/*.cpp` 编译并回显全部源文件，分别做 base 构建与候选构建
- **THEN** 两次校验均通过（忽略文件不计入观测），`make.stdout.log` 不含 `shud.extra.cpp`，`builds/<build_id>/shud` 不含该文件的内容；`repos/SHUD/src/Model/shud.extra.cpp` 字节不变

#### Scenario: stale binary in the checkout is not published
- **WHEN** `repos/SHUD/shud` 是一个被忽略的陈旧可执行文件（内容不同于本次构建产物），`shud` 为假 `Makefile` 的非 phony 目标，调用 `shud_build`
- **THEN** `make` 在 `<tmp>/src/` 内重新生成 `shud`，`binary_sha256` 不等于陈旧文件的 sha256；`repos/SHUD/shud` 字节与修改时间不变

#### Scenario: patch applies inside an enclosing repository
- **WHEN** 会话 cwd 本身位于另一个 git 仓库的工作树内，以 `approved` CR 调用 `shud_build`
- **THEN** `git apply` 实际修改了 `<tmp>/src/` 中 `files_changed` 的全部路径，构建成功且产物反映 patch

#### Scenario: ineffective patch application fails
- **WHEN** 测试替身使 `git apply` 以退出码 0 返回而不修改 `<tmp>/src/` 中某个 `files_changed` 路径
- **THEN** 工具返回"patch 未生效"错误并指出该路径，不启动 `make`，`builds/` 下没有 `.tmp-*` 或 `<build_id>` 目录

#### Scenario: archive attributes cannot alter the build tree
- **WHEN** `repos/SHUD/.git/info/attributes` 把某个已跟踪源文件标为 `export-ignore` 或 `export-subst`，调用 `shud_build`
- **THEN** 工具返回指出该路径与 `ls-tree` 不一致的错误，不启动 `make`，`builds/` 下没有 `.tmp-*` 或 `<build_id>` 目录

#### Scenario: make failure leaves nothing
- **WHEN** 假 `Makefile` 以退出码 2 失败
- **THEN** 工具返回含 `2` 与 make 输出末尾行的错误，不引用任何 `builds/.tmp-*` 路径，`builds/` 下没有 `.tmp-*` 或 `<build_id>` 目录

#### Scenario: signaled make failure preserves cleanup
- **WHEN** the actual make subprocess is terminated by a signal during an admitted build attempt
- **THEN** the tool reports that observed signal, does not misclassify an ordinary nonzero exit as signal termination, removes its owned temporary build without publishing a BuildRecord, and preserves source checkout and TaskCard bytes and modification times

#### Scenario: secrets are not inherited by make
- **WHEN** 宿主环境含 `DMXAPI_KEY`，假 `Makefile` 把全部环境变量名写入 stdout
- **THEN** `make.stdout.log` 不含 `DMXAPI_KEY`，含 `SUNDIALS_DIR`；`git archive`/`git apply` 子进程环境同样不含 `DMXAPI_KEY`

#### Scenario: missing sundials configuration fails
- **WHEN** `shud-jobs` 行未配置 `sundialsRoot` 时调用 `shud_build`
- **THEN** 工具返回指明 `sundialsRoot` 的错误，不启动 `make`，`builds/` 无新目录

#### Scenario: wrong role denied
- **WHEN** 当前 preset 投影为 worker、reviewer 或 coordinator 的 Agent 调用 `shud_build`
- **THEN** policy-gate `role-tool-surface` 返回 `deny`，工具不执行

### Requirement: Build workspace files
`builds/<build_id>/` SHALL 由临时目录 `builds/.tmp-<build_id>/` 整体 `rename` 发布（发布即提交点）；临时目录 SHALL 以排他 `mkdir` 创建，EEXIST 时重新分配 `build_id`（最多 3 次），SHALL NOT 复用或清空已存在的临时目录或已发布目录。`builds/` 目录的路径安全 SHALL 遵循 task-cards「TaskCard workspace file」规则（真实目录、非链接）；读取 `build-record.json` SHALL 经 schema 校验并核对文件内 `build_id`，损坏记录报错不改写；消费者（`shud_run`、`verification_run`、StackLock 采集）SHALL 校验 `builds/<build_id>/shud` 为普通可执行文件且 sha256 等于记录值，不匹配即拒绝。

#### Scenario: tampered binary rejected by consumers
- **WHEN** 发布后修改 `builds/<build_id>/shud` 的一个字节，再以该 `build_id` 调用 `shud_run`
- **THEN** `shud_run` 返回指出 sha256 不匹配的错误，不提交作业

#### Scenario: symlinked builds directory fails closed
- **WHEN** 会话 cwd 下 `builds` 是符号链接时调用 `shud_build`
- **THEN** 工具返回错误，不启动 `make`

#### Scenario: temporary directory collision reallocates
- **WHEN** 注入的 id 生成器首次返回的 `build_id` 已有 `builds/.tmp-<build_id>/`（另一个进行中的构建），第二次返回新 id
- **THEN** 本次构建使用第二个 id，已存在的临时目录内容不变；连续四次冲突时返回错误且不启动 `make`

### Requirement: BuildRecord generated projection
`pnpm run schema:generate` SHALL 把 `BuildRecordSchema` 投影到 `docs/generated/`，`pnpm run schema:check` 在漂移时 SHALL 失败；`docs/03_SPEC/Minimal_Schemas.md` 新增的 BuildRecord 节 SHALL 与本 schema 一致。

#### Scenario: projection drift blocks
- **WHEN** 修改 `BuildRecordSchema` 而不重新生成
- **THEN** `pnpm run schema:check` 失败
