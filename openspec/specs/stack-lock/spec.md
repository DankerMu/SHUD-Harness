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
`collectRepositoryRevision(repoPath)` SHALL 只用 `git rev-parse --show-toplevel`、`git rev-parse --verify HEAD`、`git symbolic-ref --short -q HEAD`、`git status --porcelain --untracked-files=normal --ignore-submodules=none` 采集 `repoPath` 指向的仓库，以参数数组调用 git（无 shell）并附 `-c core.fsmonitor=false`，环境 SHALL 设置 `GIT_OPTIONAL_LOCKS=0` 并剔除继承的仓库定位变量（`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等）。`repoPath` 的规范路径（`realpathSync.native`：解析 symlink，并取文件系统上的实际大小写与 Unicode 写法）SHALL 等于仓库 top-level，否则抛错（不得向上采集父仓库）。`commit` 为 HEAD 的完整 commit id；`branch` 为当前分支短名，detached HEAD 时 SHALL 为 `HEAD`；`dirty` 在上述 status 输出非空时为 `true`（含 tracked 修改与 untracked 文件，不受 `status.showUntrackedFiles` 配置影响）；输出超出读取缓冲上限时同样 SHALL 为 `true`。`dirty` 沿用 `git status` 的忽略语义：被 `.gitignore`、`.git/info/exclude` 或 `core.excludesFile`（未设置时为 `$XDG_CONFIG_HOME/git/ignore`，默认 `~/.config/git/ignore`）排除的文件不计入，因此宿主的全局忽略规则会影响结果。git 自身 SHALL NOT 写入被采集仓库（含 `.git/index`），采集 SHALL NOT 访问网络；宿主配置的外部 filter 驱动（如 git-lfs 的 clean filter）在 status 比对内容时由 git 调用，其副作用不在此保证内。`repoPath` 不是 git 仓库、没有提交，或 status 因缓冲溢出以外的原因失败时，SHALL 抛出含该路径的错误。

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
- **WHEN** untracked 文件多到 status 输出超过读取缓冲上限
- **THEN** `dirty` 为 `true`，不抛错

#### Scenario: detached HEAD
- **WHEN** 仓库处于 `git checkout --detach` 之后
- **THEN** `branch` 为 `HEAD`，`commit` 为 detached 前的 HEAD

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
