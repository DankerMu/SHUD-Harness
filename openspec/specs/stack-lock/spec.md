# stack-lock Specification

## Purpose
定义 StackLock 中三个源码仓库（SHUD、rSHUD、AutoSHUD）的版本记录：字段形态、对仓库只读的采集方式，以及让不可等价环境可快速区分的整体指纹（IR-001）。

## Requirements

### Requirement: Repository revision records dirty state
`StackLockSchema.repos` SHALL 恰含 `SHUD`、`rSHUD`、`AutoSHUD` 三个键，每个值 SHALL 为严格对象 `{ commit, branch, dirty }`：`commit`、`branch` 为非空字符串，`dirty` 为 required boolean；缺失 `dirty`、`dirty` 非 boolean 或出现多余字段时解析 SHALL 失败。生成投影 `docs/generated/schema/stack-lock.md` 与 `docs/generated/json-schema/stack-lock.json` SHALL 与该 schema 一致。

#### Scenario: complete revision parses
- **WHEN** 三个 repo 均为 `{ commit: "<40 hex>", branch: "master", dirty: false }` 的 StackLock 交给 `StackLockSchema.safeParse`
- **THEN** 解析成功

#### Scenario: missing or non-boolean dirty is rejected
- **WHEN** 任一 repo 缺 `dirty`，或其 `dirty` 为字符串 `"false"`
- **THEN** 解析失败，缺失时 issue path 为 `repos.<name>.dirty`

### Requirement: Read-only repository revision collection
`collectRepositoryRevision(repoPath)` SHALL 只用 `git rev-parse --show-toplevel`、`git rev-parse --verify HEAD`、`git symbolic-ref -q HEAD`、`git status --porcelain --untracked-files=normal --ignore-submodules=none` 采集 `repoPath` 指向的仓库，以参数数组调用 git（无 shell）并附 `-c core.fsmonitor=false`，环境 SHALL 设置 `GIT_OPTIONAL_LOCKS=0` 并剔除继承的仓库定位变量（`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等）。`repoPath` 的规范路径（`realpathSync.native`：解析 symlink，并取文件系统上的实际大小写与 Unicode 写法）SHALL 等于仓库 top-level，否则抛错（不得向上采集父仓库）。`commit` 为 HEAD 的完整 commit id；`branch` 为 HEAD 所指 `refs/heads/<name>` 的 `<name>`（去掉该前缀，同名 tag 不影响）；detached HEAD（`symbolic-ref -q` 静默退出 1）时 SHALL 为 `HEAD`；HEAD 指向 `refs/heads/` 以外的引用（如手写的 `ref: refs/tags/v1`，annotated tag 时 `rev-parse` 得到的是 tag 对象而非提交），或分支名恰为 `HEAD`（只能经 `git update-ref` 等底层命令创建，与 detached 哨兵冲突）时 SHALL 抛出含路径的错误；`symbolic-ref` 的其他失败（非 1 退出码，或退出 1 但有输出）SHALL 抛出含路径的错误；`dirty` 在上述 status 输出非空时为 `true`（含 tracked 修改与 untracked 文件，不受 `status.showUntrackedFiles` 配置影响）；读取因任一输出流超出缓冲上限而中断但 stdout 已有输出时同样 SHALL 为 `true`；stdout 为空的溢出（如大量 `could not open directory` 警告只写入 stderr）SHALL 视为失败并抛错，不得因警告量把干净工作区记为 dirty。`dirty` 沿用 `git status` 的忽略语义：被 `.gitignore`、`.git/info/exclude` 或 `core.excludesFile`（未设置时为 `$XDG_CONFIG_HOME/git/ignore`，默认 `~/.config/git/ignore`）排除的文件不计入，因此宿主的全局忽略规则会影响结果。git 自身 SHALL NOT 写入被采集仓库（含 `.git/index`），采集 SHALL NOT 访问网络；宿主配置的外部 filter 驱动（如 git-lfs 的 clean filter）在 status 比对内容时由 git 调用，其副作用不在此保证内。`repoPath` 不是 git 仓库、没有提交，或 status 因「缓冲溢出且 stdout 非空」以外的原因失败时，SHALL 抛出含该路径的错误。

#### Scenario: clean checkout
- **WHEN** 对一个刚提交、工作区干净的 `main` 分支临时仓库采集
- **THEN** 结果为 `{ commit: <HEAD 完整 id>, branch: "main", dirty: false }`

#### Scenario: tracked modification or untracked file marks dirty
- **WHEN** 修改一个已提交文件的内容，或新建一个未被忽略的未跟踪文件
- **THEN** `dirty` 为 `true`，`commit` 不变

#### Scenario: untracked-files config cannot hide dirt
- **WHEN** 仓库配置 `status.showUntrackedFiles no` 后新建一个未跟踪文件
- **THEN** `dirty` 为 `true`

#### Scenario: ignored file stays clean
- **WHEN** 仅新建一个被 `.gitignore`、`.git/info/exclude` 或仓库配置的 `core.excludesFile` 排除的文件
- **THEN** `dirty` 为 `false`

#### Scenario: oversized status output still marks dirty
- **WHEN** untracked 文件多到 status 的 stdout 超过读取缓冲上限
- **THEN** `dirty` 为 `true`，不抛错

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
`computeStackFingerprint(lock)` SHALL 返回 `sha256:` 加 64 位小写十六进制：对 lock 去掉 `stack_id`、`created_at`、`fingerprint` 后的内容，在每一层按键名排序、无空白地序列化为 JSON，取其 UTF-8 字节的 SHA-256。指纹 SHALL 只由该内容决定：`stack_id`、`created_at`、`fingerprint` 的值与键的先后顺序 SHALL NOT 影响结果；内容中任一值变化 SHALL 改变结果。`llm.response_model`（K4：只记录、不使 lock 失效）是否加入排除集由 M3 按 K4 对齐 `llm` 字段时决定。

#### Scenario: clean to dirty changes the fingerprint
- **WHEN** 两个 lock 仅有一个 repo 的 `dirty` 分别为 `false` 与 `true`
- **THEN** 两者指纹不同

#### Scenario: identity, time and key order do not matter
- **WHEN** 两个 lock 内容相同，仅 `stack_id`、`created_at`、`fingerprint` 的值或键顺序（含嵌套对象）不同
- **THEN** 两者指纹相同

#### Scenario: algorithm is pinned by a fixed vector
- **WHEN** 对测试中写死的一份 lock 计算指纹
- **THEN** 结果等于测试中写死的、由 `shasum -a 256` 对其规范 JSON 独立算出的值
