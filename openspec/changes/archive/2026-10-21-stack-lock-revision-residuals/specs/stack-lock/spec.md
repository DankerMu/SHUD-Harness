# Spec Delta

## MODIFIED Requirements

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
