# stack-lock Specification

## Purpose
定义 StackLock 中三个源码仓库（SHUD、rSHUD、AutoSHUD）的版本记录：字段形态、对仓库只读的采集方式，以及让不可等价环境可快速区分的整体指纹（IR-001）。

## Requirements

### Requirement: Repository revision records dirty state
`StackLockSchema.repos` SHALL 恰含 `SHUD`、`rSHUD`、`AutoSHUD` 三个键，每个值 SHALL 为严格对象 `{ commit, branch, dirty, dirty_paths, dirty_paths_truncated }`：`commit`、`branch` 为非空字符串，`dirty` 为 required boolean，`dirty_paths` 为 required 数组，元素为非空字符串（相对仓库 top-level 的 POSIX 路径，去重后按与 locale 无关的码点升序排列），`dirty_paths_truncated` 为 required boolean；缺失任一字段、`dirty` 或 `dirty_paths_truncated` 非 boolean、`dirty_paths` 不是字符串数组或出现多余字段时解析 SHALL 失败。`dirty_paths_truncated` 为 `false` 时 `dirty` SHALL 等于 `dirty_paths` 非空；为 `true`（status 读取因缓冲溢出中断，见「Read-only repository revision collection」）时 `dirty` SHALL 为 `true`，`dirty_paths` 只列出已完整读到的条目、可能不完整；违反这两条的记录解析 SHALL 失败。生成投影 `docs/generated/schema/stack-lock.md` 与 `docs/generated/json-schema/stack-lock.json` SHALL 与该 schema 一致。

#### Scenario: complete revision parses
- **WHEN** 三个 repo 均为 `{ commit: "<40 hex>", branch: "master", dirty: false, dirty_paths: [], dirty_paths_truncated: false }` 的 StackLock 交给 `StackLockSchema.safeParse`
- **THEN** 解析成功

#### Scenario: dirty revision lists its paths
- **WHEN** 某个 repo 为 `{ dirty: true, dirty_paths: ["notes.txt", "src/Model.cpp"], dirty_paths_truncated: false }`，其余字段完整
- **THEN** 解析成功

#### Scenario: missing or non-boolean dirty is rejected
- **WHEN** 任一 repo 缺 `dirty`，或其 `dirty` 为字符串 `"false"`
- **THEN** 解析失败，缺失时 issue path 为 `repos.<name>.dirty`

#### Scenario: missing dirty_paths fields are rejected
- **WHEN** 任一 repo 缺 `dirty_paths` 或 `dirty_paths_truncated`
- **THEN** 解析失败，issue path 为 `repos.<name>.dirty_paths` 或 `repos.<name>.dirty_paths_truncated`

#### Scenario: dirty flag inconsistent with paths is rejected
- **WHEN** 某个 repo 为 `dirty: false, dirty_paths: ["x"], dirty_paths_truncated: false`；或 `dirty: true, dirty_paths: [], dirty_paths_truncated: false`；或 `dirty: false, dirty_paths_truncated: true`
- **THEN** 三种情形解析均失败

#### Scenario: truncated overflow may carry an incomplete list
- **WHEN** 某个 repo 为 `dirty: true, dirty_paths: [], dirty_paths_truncated: true`
- **THEN** 解析成功

### Requirement: Read-only repository revision collection
`collectRepositoryRevision(repoPath)` SHALL 只用 `git rev-parse --show-toplevel`、`git rev-parse --verify HEAD`、`git symbolic-ref -q HEAD`、`git status --porcelain -z --untracked-files=normal --ignore-submodules=none` 采集 `repoPath` 指向的仓库，以参数数组调用 git（无 shell）并附 `-c core.fsmonitor=false`，环境 SHALL 设置 `GIT_OPTIONAL_LOCKS=0` 并剔除继承的仓库定位变量（`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等）。`repoPath` 的规范路径（`realpathSync.native`：解析 symlink，并取文件系统上的实际大小写与 Unicode 写法）SHALL 等于仓库 top-level，否则抛错（不得向上采集父仓库）。`commit` 为 HEAD 的完整 commit id；`branch` 为 HEAD 所指 `refs/heads/<name>` 的 `<name>`（去掉该前缀，同名 tag 不影响）；detached HEAD（`symbolic-ref -q` 静默退出 1）时 SHALL 为 `HEAD`；HEAD 指向 `refs/heads/` 以外的引用（如手写的 `ref: refs/tags/v1`，annotated tag 时 `rev-parse` 得到的是 tag 对象而非提交），或分支名恰为 `HEAD`（只能经 `git update-ref` 等底层命令创建，与 detached 哨兵冲突）时 SHALL 抛出含路径的错误；`symbolic-ref` 的其他失败（非 1 退出码，或退出 1 但有输出）SHALL 抛出含路径的错误；`dirty` 在上述 status 输出非空时为 `true`（含 tracked 修改与 untracked 文件，不受 `status.showUntrackedFiles` 配置影响）；读取因任一输出流超出缓冲上限而中断但 stdout 已有输出时同样 SHALL 为 `true`；stdout 为空的溢出（如大量 `could not open directory` 警告只写入 stderr）SHALL 视为失败并抛错，不得因警告量把干净工作区记为 dirty。`dirty_paths` SHALL 由同一次 status 调用的 stdout 解析得到，SHALL NOT 为此新增任何 git 调用：输出按 NUL 分隔为记录（无引号转义，`core.quotePath` 不影响路径），每条记录取其路径字段；重命名或复制条目（状态 `R`/`C`）只记新路径、不记原路径；结果去重后按与 locale 无关的码点升序排列。status 未溢出时 `dirty_paths_truncated` 为 `false`，因「缓冲溢出且 stdout 非空」判 dirty 时为 `true`，此时 `dirty_paths` 只含已完整读到的记录。`dirty` 沿用 `git status` 的忽略语义：被 `.gitignore`、`.git/info/exclude` 或 `core.excludesFile`（未设置时为 `$XDG_CONFIG_HOME/git/ignore`，默认 `~/.config/git/ignore`）排除的文件不计入，因此宿主的全局忽略规则会影响结果。git 自身 SHALL NOT 写入被采集仓库（含 `.git/index`），采集 SHALL NOT 访问网络；宿主配置的外部 filter 驱动（如 git-lfs 的 clean filter）在 status 比对内容时由 git 调用，其副作用不在此保证内。`repoPath` 不是 git 仓库、没有提交，或 status 因「缓冲溢出且 stdout 非空」以外的原因失败时，SHALL 抛出含该路径的错误。

status 的 stdout SHALL 按原始字节读取，先确定完整 NUL 记录与 R/C 双路径边界，再对要记录的新路径严格解码 UTF-8。完整路径含非法 UTF-8 时 SHALL 明确抛出含 repoPath 的读取错误，不能以替换字符静默合并路径；合法字面 U+FFFD 与开头 U+FEFF SHALL 原样保留。溢出时未完整读取的尾记录先丢弃，不因尾部切在多字节字符中而误报；前三个 git 命令的解码/错误行为、四次调用与缓冲上限保持不变。非 UTF-8 文件名的可逆字节表示不在本契约内。

#### Scenario: clean checkout
- **WHEN** 对一个刚提交、工作区干净的 `main` 分支临时仓库采集
- **THEN** 结果为 `{ commit: <HEAD 完整 id>, branch: "main", dirty: false, dirty_paths: [], dirty_paths_truncated: false }`

#### Scenario: tracked modification or untracked file marks dirty
- **WHEN** 修改一个已提交文件的内容，或新建一个未被忽略的未跟踪文件
- **THEN** `dirty` 为 `true`，`dirty_paths` 含该文件相对仓库根的 POSIX 路径，`dirty_paths_truncated` 为 `false`，`commit` 不变

#### Scenario: dirty paths are sorted and come from the same status call
- **WHEN** 先后新建未跟踪文件 `b.txt` 与 `a.txt`，并修改已提交文件 `src/x.c`，再采集
- **THEN** `dirty_paths` 为 `["a.txt", "b.txt", "src/x.c"]`，且本次采集执行的 git 子命令仍只有上述四条

#### Scenario: rename records only the new path
- **WHEN** 以 `git mv old.txt new.txt` 重命名一个已提交文件后采集
- **THEN** `dirty_paths` 含 `new.txt`、不含 `old.txt`

#### Scenario: special characters are recorded verbatim
- **WHEN** 新建未跟踪文件 `数据 a.txt`（含非 ASCII 字符与空格），且仓库 `core.quotePath` 为默认值
- **THEN** `dirty_paths` 含原样的 `数据 a.txt`，不带引号或八进制转义

#### Scenario: invalid UTF-8 path fails closed
- **WHEN** Linux 仓库含非法 UTF-8 字节文件名，status 成功输出该完整 NUL 路径
- **THEN** 采集明确失败，不返回替换字符路径或碰撞的 StackLock；合法字面 U+FFFD 与开头 U+FEFF 文件名仍原样采集

#### Scenario: incomplete multibyte overflow tail is ignored
- **WHEN** status 溢出，完整路径之后的尾记录在 UTF-8 多字节字符或 R/C 第二路径中间截断
- **THEN** 只保留前面的完整有效记录，dirty 与 dirty_paths_truncated 均为 true，不解码不完整尾记录、不错误拒绝整个观测

#### Scenario: untracked-files config cannot hide dirt
- **WHEN** 仓库配置 `status.showUntrackedFiles no` 后新建一个未跟踪文件
- **THEN** `dirty` 为 `true`

#### Scenario: ignored file stays clean
- **WHEN** 仅新建一个被 `.gitignore`、`.git/info/exclude` 或仓库配置的 `core.excludesFile` 排除的文件
- **THEN** `dirty` 为 `false`，`dirty_paths` 为空

#### Scenario: oversized status output still marks dirty
- **WHEN** untracked 文件多到 status 的 stdout 超过读取缓冲上限
- **THEN** `dirty` 为 `true`、`dirty_paths_truncated` 为 `true`，不抛错

#### Scenario: non-overflow status failure throws even with output
- **WHEN** status 以非 0 退出码失败且 stdout 有输出（未溢出）
- **THEN** 抛出错误，消息以 `cannot read git status at <repoPath>: ` 开头，不记为 dirty

#### Scenario: stderr-only overflow throws
- **WHEN** status 的 stdout 为空，而 stderr 超过读取缓冲上限（不论退出码）
- **THEN** 抛出错误，消息以 `cannot read git status at <repoPath>: ` 开头

#### Scenario: detached HEAD
- **WHEN** 仓库处于 `git checkout --detach` 之后
- **THEN** `branch` 为 `HEAD`，`commit` 为 detached 前的 HEAD

#### Scenario: branch name is not shortened by a same-name tag
- **WHEN** 当前分支为 `v1`，且存在同名 tag `v1`
- **THEN** `branch` 为 `v1`

#### Scenario: non-branch HEAD target or failing symbolic-ref throws
- **WHEN** `.git/HEAD` 被写成 `ref: refs/tags/v1`；或 HEAD 指向经 `git update-ref` 创建的 `refs/heads/HEAD`；或 `symbolic-ref` 以非 1 退出码失败，或退出 1 但有输出
- **THEN** 抛出错误，消息以 `cannot read git branch at <repoPath>: ` 开头

#### Scenario: gitfile checkout like a submodule
- **WHEN** 工作区的 `.git` 是指向另一目录的 gitfile（`git init --separate-git-dir`）
- **THEN** 采集成功并返回该仓库的 commit

#### Scenario: inherited GIT_DIR does not redirect collection
- **WHEN** 进程环境的 `GIT_DIR` 指向另一个仓库时采集 `repoPath`
- **THEN** 返回 `repoPath` 仓库的 commit

#### Scenario: collection does not rewrite the index
- **WHEN** 只更新一个已提交文件的 mtime（内容不变）后采集
- **THEN** `dirty` 为 `false`，且 `.git/index` 在采集前后字节相同

#### Scenario: not a repository
- **WHEN** `repoPath` 是普通目录、没有任何提交的新仓库，或另一个仓库内的空子目录（如未初始化的 submodule）
- **THEN** 抛出错误，消息含 `repoPath`；不返回父仓库的 commit

### Requirement: Stack fingerprint
`computeStackFingerprint(lock)` SHALL 返回 `sha256:` 加 64 位小写十六进制：对 lock 去掉 `stack_id`、`created_at`、`fingerprint` 与 `llm.response_model` 后的内容，在每一层按键名排序、无空白地序列化为 JSON，取其 UTF-8 字节的 SHA-256。`llm.response_model` 按 K4 只记录、不使 lock 失效，因此在排除集内。指纹 SHALL 只由该内容决定：`stack_id`、`created_at`、`fingerprint`、`llm.response_model` 的值与键的先后顺序 SHALL NOT 影响结果；内容中任一值变化（含 `repos.<name>.dirty_paths` 与 `dirty_paths_truncated`）SHALL 改变结果。

#### Scenario: clean to dirty changes the fingerprint
- **WHEN** 两个 lock 仅有一个 repo 的 `dirty` 分别为 `false` 与 `true`（`dirty_paths` 相应为空与非空）
- **THEN** 两者指纹不同

#### Scenario: dirty_paths change alters the fingerprint
- **WHEN** 两个 lock 的某个 repo 均为 `dirty: true`，仅 `dirty_paths` 分别为 `["a.txt"]` 与 `["b.txt"]`
- **THEN** 两者指纹不同

#### Scenario: response model does not affect the fingerprint
- **WHEN** 两个 lock 仅 `llm.response_model` 不同
- **THEN** 两者指纹相同

#### Scenario: identity, time and key order do not matter
- **WHEN** 两个 lock 内容相同，仅 `stack_id`、`created_at`、`fingerprint` 的值或键顺序（含嵌套对象）不同
- **THEN** 两者指纹相同

#### Scenario: algorithm is pinned by a fixed vector
- **WHEN** 对测试中写死的一份符合当前 `StackLockSchema` 的 lock 计算指纹
- **THEN** 结果等于测试中写死的、由 `shasum -a 256` 对其规范 JSON（已去掉排除集字段）独立算出的值

### Requirement: Repository root pathname fidelity

Repository revision collection SHALL preserve legal whitespace in the configured physical root pathname. The reported git top-level pathname SHALL be obtained by removing only the single final LF record terminator, if present, rather than trimming pathname content. The existing physical-root equality check and refusal to collect an enclosing repository SHALL remain in force. Collection SHALL retain the existing four read-only git operations, environment isolation and revision fields.

#### Scenario: Committed root with trailing whitespace
- **WHEN** a committed repository root basename ends in a space or LF
- **THEN** collection succeeds with that repository's full commit, branch, dirty flag and dirty paths, preserving pathname content independently of git's output terminator

#### Scenario: Descendant of whitespace-ended root
- **WHEN** collection is requested for an empty descendant inside that repository rather than its root
- **THEN** it throws the existing non-root error and does not return the enclosing repository's revision

### Requirement: Relocated records retains canonical build version

The emitted records package public entry SHALL import successfully from outside the repository when its declared runtime dependencies are provided. Runtime module linking and capture SHALL NOT require the repository-root package.json outside that package. Captured harness.version SHALL equal the canonical harness root manifest version at build time, not a relocated package manifest or caller workspace version. The capture API and persisted StackLock shape SHALL remain unchanged.

#### Scenario: External package import and capture
- **WHEN** emitted records files and its package manifest are physically copied outside the checkout, core dependency is explicitly provided, and a fresh Node process imports the public entry from an external cwd
- **THEN** module linking succeeds without an ancestor repository manifest and capture produces a valid persisted StackLock with the canonical build-time harness version
- **AND** unrelated package/cwd version values do not change that captured version

#### Scenario: Clean and repeated builds capture the root version
- **WHEN** the normal records build runs without prior emitted output, or runs again after the canonical root version changes
- **THEN** the package-local version artifact is created or refreshed from that root before compilation, without introducing a manually maintained second version source or runtime fallback

### Requirement: StackLock schema alignment
`StackLockSchema` SHALL 为严格对象，恰含 `stack_id`、`repos`、`runtime`、`harness`、`llm`、`fingerprint`、`created_at`。`stack_id` SHALL 为品牌类型 `StackId`，格式 `STACK-YYYYMMDDTHHMMSS-xxxx`（UTC、精确到秒，`xxxx` 为 4 位小写十六进制），与 RunJob/RunRecord id 同一生成规则；旧格式 `STACK-0001`、`STACK-<UUID>` 与大写十六进制 SHALL 被拒绝。`llm` SHALL 恰为 `{ base_url, request_alias, response_model }` 三个非空字符串。`runtime` SHALL 恰为 `{ os, sundials_version, host_version }`：`os`、`host_version` 为非空字符串，`sundials_version` 为非空字符串或 `null`。`harness` SHALL 恰为 `{ version }`（非空字符串）。原 `llm.provider`、`llm.model_id`、`llm.params_digest`、`llm.prompt_pack_digest`，原 `runtime.r_version`、`runtime.r_packages_lock`、`runtime.python_version`、`runtime.gcc_version`、`runtime.gdal_version`，以及原 `harness.cli_version`、`harness.prompt_pack`、`harness.skills_version` SHALL 作为多余字段被拒绝，不以 nullable 形式保留。

#### Scenario: aligned lock parses
- **WHEN** 解析 `stack_id: "STACK-20261027T080000-3f9a"`、三 repo 完整、`runtime: { os: "Darwin 25.6.0", sundials_version: null, host_version: "0.2.1-rc.2" }`、`harness: { version: "0.9.0" }`、`llm: { base_url: "https://www.dmxapi.cn", request_alias: "deepseek-flash-guan", response_model: "deepseek-flash-guan" }` 的 StackLock
- **THEN** 解析成功

#### Scenario: legacy stack ids rejected
- **WHEN** 以 `stack_id: "STACK-0001"`、`"STACK-0b6f4c2e-1d2a-4e5f-9a8b-7c6d5e4f3a2b"` 或 `"STACK-20261027T080000-3F9A"` 解析 StackLock
- **THEN** 解析失败并指出 `stack_id`

#### Scenario: legacy llm, runtime and harness fields rejected
- **WHEN** 在其它方面合法的 StackLock 上分别加入 `llm.model_id`、`runtime.r_version` 或 `harness.cli_version`
- **THEN** 每一种情形解析均失败

#### Scenario: missing llm field rejected
- **WHEN** StackLock 的 `llm` 缺 `request_alias`，或 `response_model` 为空字符串
- **THEN** 解析失败并指出对应 `llm` 字段

### Requirement: Deterministic capture at shud_run submission
每次 `shud_run` 提交 SHALL 在输入复制完成之后、`run-job.json` 首次写入之前确定性地采集 StackLock，不经 LLM：`repos.{SHUD,rSHUD,AutoSHUD}` 为对 `shud-jobs` 行配置 `stackRepos.{SHUD,rSHUD,AutoSHUD}`（绝对路径）逐一执行「Read-only repository revision collection」的结果；`runtime.os` 为 `os.type()` 加一个空格加 `os.release()`；`runtime.sundials_version` 为 `shud-jobs` 行可选配置 `sundialsRoot` 下 `include/sundials/sundials_config.h` 中 `SUNDIALS_VERSION` 的值，未配置 `sundialsRoot` 或该文件不存在时为 `null`；`runtime.host_version` 为 `shud-jobs` 行配置 `hostVersion`；`harness.version` 为本仓库根 `package.json` 的 `version`；`llm.base_url`、`llm.request_alias` 为 `shud-jobs` 行配置 `llm.base_url`、`llm.request_alias`；`llm.response_model` 为本次 `shud_run` 记入 RunJob `llm.response_model` 的同一已配置模型 id（`response_model_source` 不进 StackLock）。`stackRepos` 的三个键、`hostVersion`、`llm.base_url`、`llm.request_alias` 是 `shud-jobs` 行的必填配置，缺失或为空时该行 apply SHALL 失败并指明配置键，SHALL NOT 回退默认值。

采集结果 SHALL 按「Stack fingerprint」计算指纹，并与会话 cwd 下 `stacks/` 中已有的 StackLock 文件比较：存在指纹相等的文件时 SHALL 复用其 `stack_id`，SHALL NOT 改写该文件（因此其中记录的 `llm.response_model` 可能与本次调用的已配置模型 id 不同）；指纹相等的文件不止一份（如两次并发的首次提交各写了一份）时 SHALL 复用 `stack_id` 码点序最小的那一份，其余文件保留不动、仍然有效。不存在时 SHALL 分配新 `stack_id` 并以排他创建（`wx` 标志）写入 `<session cwd>/stacks/<stack_id>.json`——lock 只新建、从不改写，排他创建即其不覆盖保证；创建以 `EEXIST` 失败时 SHALL 重新分配 `stack_id` 再试，连同首次至多 3 次，3 次均 `EEXIST` 时 SHALL 以指明 `stacks/` 冲突的错误使本次采集失败，SHALL NOT 覆盖已有文件。`stacks/` 目录与其中文件的路径安全遵循 task-cards「TaskCard workspace file」的工作区文件安全规则。读取 `stacks/` 中的已有文件 SHALL 经 `StackLockSchema` 校验，校验失败或不可读的文件 SHALL 使本次采集失败，SHALL NOT 改写或跳过该文件。任一 repo 路径不是 git 仓库（含未初始化的 submodule 空目录）、采集抛错或 StackLock 写入失败时，`shud_run` SHALL 返回说明原因的工具错误、SHALL NOT 提交作业，并 SHALL NOT 留下运行目录；SHALL NOT 以 `null` 或占位值代替无法采集的仓库版本。采集得到的 `stack_id` SHALL 写入同一次提交的 RunJob（见 run-records）。

#### Scenario: first submission writes a new lock
- **WHEN** 会话 cwd 下没有 `stacks/` 目录，三个 `stackRepos` 均为干净的 git 仓库，提交一次 `shud_run`
- **THEN** 出现唯一文件 `stacks/<stack_id>.json`，其内容通过 `StackLockSchema`，`llm.request_alias` 等于 `shud-jobs` 行 `llm.request_alias`，`run-job.json` 的 `stack_id` 等于该 `stack_id`

#### Scenario: unchanged environment reuses the lock
- **WHEN** 环境不变时再提交一次 `shud_run`
- **THEN** `stacks/` 中文件数量不变，已有文件字节与修改时间不变，新 `run-job.json` 的 `stack_id` 与前一次相同

#### Scenario: environment change produces a new lock
- **WHEN** 在某个 `stackRepos` 仓库中新建一个未被忽略的文件后再提交 `shud_run`
- **THEN** `stacks/` 中新增一个文件，其该 repo 的 `dirty` 为 `true` 且 `dirty_paths` 含该文件，新 `run-job.json` 的 `stack_id` 指向新文件

#### Scenario: fingerprint-equal duplicates reuse the smallest id
- **WHEN** `stacks/` 中有两份指纹与本次环境相等的 lock，`stack_id` 分别为 `STACK-20261027T080001-b000` 与 `STACK-20261027T080001-a000`，提交一次 `shud_run`
- **THEN** 新 `run-job.json` 的 `stack_id` 为 `STACK-20261027T080001-a000`，两份文件的字节与修改时间均不变，`stacks/` 不新增文件

#### Scenario: id collision on create is retried
- **WHEN** 新分配的 `stack_id` 对应的文件在排他创建时已存在（`EEXIST`），而重新分配的第二个 id 不冲突
- **THEN** 采集以第二个 id 写入新 lock 并成功，已存在的那份文件字节不变

#### Scenario: repeated collisions fail the capture
- **WHEN** 连续 3 次分配的 `stack_id` 排他创建均以 `EEXIST` 失败
- **THEN** `shud_run` 返回指明 `stacks/` 冲突的工具错误，不提交作业、不留下运行目录，已有文件字节不变

#### Scenario: sundials version is optional
- **WHEN** `shud-jobs` 行未配置 `sundialsRoot`，或其下没有 `include/sundials/sundials_config.h`
- **THEN** 采集成功，`runtime.sundials_version` 为 `null`

#### Scenario: uninitialized submodule fails the submission
- **WHEN** `stackRepos.rSHUD` 指向一个未初始化 submodule 的空目录时调用 `shud_run`
- **THEN** 工具返回错误结果并指明该路径，不提交作业，`runs/` 下没有新运行目录，`stacks/` 不新增文件

#### Scenario: corrupt existing lock fails closed
- **WHEN** `stacks/` 中有一个不能通过 `StackLockSchema` 的文件时调用 `shud_run`
- **THEN** 工具返回错误结果，不提交作业、不留下运行目录，该文件字节不变

#### Scenario: missing capture configuration fails apply
- **WHEN** 以缺少 `hostVersion` 或 `stackRepos.SHUD` 的配置 apply `shud-jobs` 行
- **THEN** apply 抛错且错误消息含该配置键，注册表不注册

### Requirement: StackLock generated projection
StackLock 的 Zod schema SHALL 位于 `packages/dsh-shud-core/src/schemas/`，经 `pnpm run schema:generate` 投影到 `docs/generated/schema/stack-lock.md` 与 `docs/generated/json-schema/stack-lock.json`；`pnpm run schema:check` SHALL 在二者不一致时失败。`docs/03_SPEC/Minimal_Schemas.md` 的 StackLock 段 SHALL 与本 spec 一致，并逐项写明相对原文的处置：`stack_id` 改为 `STACK-YYYYMMDDTHHMMSS-xxxx`；`llm` 收窄为 `base_url`/`request_alias`/`response_model`，`response_model` 排除出指纹；`repos.<name>` 新增 `dirty_paths` 与 `dirty_paths_truncated`；`runtime` 最小化为 `os`/`sundials_version`/`host_version`，删除 `r_version`、`r_packages_lock`、`python_version`、`gcc_version`、`gdal_version`；`harness` 只保留 `version`，删除 `cli_version`、`prompt_pack`、`skills_version`。

#### Scenario: projection reflects the aligned schema
- **WHEN** 执行 `pnpm run schema:generate`
- **THEN** `docs/generated/json-schema/stack-lock.json` 的 `llm` 属性恰为 `base_url`、`request_alias`、`response_model`，`runtime` 属性恰为 `os`、`sundials_version`、`host_version`，repo 修订对象含 `dirty_paths` 与 `dirty_paths_truncated`

#### Scenario: drift detected
- **WHEN** 修改 StackLock 的 Zod 字段而未重新生成
- **THEN** `pnpm run schema:check` 以非 0 退出
