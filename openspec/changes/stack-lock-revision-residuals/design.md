# Design

Change surface: `packages/dsh-shud-core/src/stack-lock/repository-revision.ts` 的 `collectRepositoryRevision`：branch 段（`:53-64`）与 status 段的 catch（`:75-83`），以及 JSDoc 中 status 溢出一句（`:19`）。`run` 封装、环境剔除、top-level 校验、`rev-parse --verify HEAD`、status 参数、`failureField`/`failureDetail` 不改。

Must preserve:
- `repository-revision.test.ts` 现有全部用例（干净、tracked 修改、untracked、`.gitignore`、detached、gitfile、继承 `GIT_DIR`、非仓库三态、stat-only 与 index 字节不变、`showUntrackedFiles=no`、`info/exclude` 与 `core.excludesFile`、6000 文件 stdout 溢出仍 dirty、损坏 index 抛错、大小写变体根）逐个通过。
- 对仓库零写入（`GIT_OPTIONAL_LOCKS=0`、fsmonitor 关闭）；git 调用仍为参数数组、无 shell。
- 导出与 `RepositoryRevision` schema 不变。

Must add/change:
- status catch：
  ```ts
  // Any porcelain output means dirty, even when the read was cut short by either
  // stream overflowing; an overflow with empty stdout is a failure.
  const stdout = failureField(error, "stdout");
  if (failureField(error, "code") !== "ENOBUFS" || typeof stdout !== "string" || stdout === "") {
    throw new Error(`cannot read git status at ${repoPath}: ${failureDetail(error)}`, { cause: error });
  }
  dirty = true;
  ```
- branch：
  ```ts
  let ref: string;
  try {
    ref = run(["symbolic-ref", "-q", "HEAD"]).trim();
  } catch (error) {
    // Detached HEAD: symbolic-ref -q exits 1 silently.
    if (failureField(error, "status") !== 1 || failureField(error, "stdout") !== "") throw …（原错误不变）;
    ref = "";
  }
  // Only refs/heads/<name> is a branch, and <name> HEAD would read as detached.
  // HEAD symref'd elsewhere (e.g. a tag, whose rev-parse may be a tag object) fails.
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
  if (ref !== "" && (name === undefined || name === "HEAD")) {
    throw new Error(`cannot read git branch at ${repoPath}: HEAD points at ${ref}, not a branch`);
  }
  const branch = name ?? "HEAD";
  ```
  具体写法由实现者定（保持现有风格），行为须与上述一致。去掉 `--short`：`--short` 在存在同名 tag 时输出 `heads/v1`，且无法区分 `refs/tags/v1`。
- JSDoc `:19`：改为「any porcelain output counts as dirty, even if the read overflowed; an overflow with empty stdout throws」。
- 测试（`repository-revision.test.ts`，沿用 `committedRepo`/`git` 助手与 `beforeEach` 的 env 隔离）：
  - PATH shim 助手：在 `root` 下写可执行 `sh` 脚本 `shim/git`，以 `$5` 精确匹配子命令（`run` 的调用形如 `-C <repo> -c core.fsmonitor=false <sub> …`；测试助手 `git()` 的子命令在 `$3`，不会误中），执行替身动作，其余 `exec "<真 git 绝对路径>" "$@"`；不用 `case "$*"` 子串匹配（repo 路径可能含子命令字样）；真 git 路径在 stub 前解析（`command -v git`）；fixture 仓库建好后再 `vi.stubEnv("PATH", shimDir + delimiter + process.env.PATH)`（`afterEach` 已 `unstubAllEnvs`）。
  - stderr-only 溢出：shim 对 `status` 向 stderr 写 > 1 MiB 的分行警告（重复 `warning: could not open directory 'x/': Permission denied` 行，使 `failureDetail` 首行短小）、stdout 不写 → 抛 `cannot read git status at ${repo}: warning: could not open directory`。
  - 非溢出失败带输出：shim 对 `status` 向 stdout 写 `?? x`、exit 128 → 抛 `cannot read git status at ${repo}: `，`cause.status === 128`（不得记为 dirty）。
  - `symbolic-ref` 退出 128：shim 向 stderr 写 `fatal: simulated symbolic-ref failure`、exit 128 → 抛 `cannot read git branch at ${repo}: fatal: simulated symbolic-ref failure`，`cause.status === 128`。
  - `symbolic-ref` 退出 1 但有 stdout：shim 输出 `refs/heads/x`、exit 1 → 抛 `cannot read git branch at ${repo}: `。
  - HEAD → tag（真实 git）：`git tag v1`，把 `.git/HEAD` 写成 `ref: refs/tags/v1\n` → 抛 `cannot read git branch at ${repo}: `（annotated tag 下 `rev-parse --verify HEAD` 得 tag 对象 id 而非提交，记 `HEAD` 会写出错误的 `commit`，故抛错）。
  - 同名 tag（真实 git）：`git checkout -q -b v1`、`git tag v1` → `branch` 为 `v1`。
  - `refs/heads/HEAD`（真实 git）：`git update-ref refs/heads/HEAD <sha>`，`.git/HEAD` 写成 `ref: refs/heads/HEAD\n` → 抛 `cannot read git branch at ${repo}: `。

Sibling surfaces:
- StackLock 组装与持久化（M3 records 包）尚未消费 `branch`，语义变化无下游。
- `docs/generated/` 不受影响（schema 不变）。
- raw-guard（#263）不触及本文件。

Seams under test: `collectRepositoryRevision(repoPath)`（vitest，真实 git + PATH shim）。

Required evidence:
- 新用例在改动前的实现上红（stderr-only 溢出当前为 dirty；HEAD → tag 当前返回 `v1`；同名 tag 当前为 `heads/v1`；`refs/heads/HEAD` 当前为 `heads/HEAD`）；两条 `symbolic-ref` shim 用例与「非溢出失败带输出」用例改前即绿（覆盖既有分支，补缺口）；改后全绿。
- 突变：
  1. 去掉 stdout 非空判别 → stderr-only 溢出用例红。
  2. 判别写反（要求 stdout 为空）→ 6000 文件 stdout 溢出用例红。
  3. 去掉 `status !== 1` 析取（任何失败都当 detached）→ 退出 128 用例红。
  4. 去掉 `stdout !== ""` 析取 → 「退出 1 但有输出」用例红。
  5. 不检查 `refs/heads/` 前缀（非分支 symref 不抛错）→ HEAD → tag 用例红。
  6. 去掉 `refs/heads/HEAD` 守卫 → 该用例红。
  7. 恢复 `--short` → 同名 tag 用例红（及其他依赖全名的用例）。
  8. 去掉 `code !== "ENOBUFS"` 析取（任何带 stdout 的失败都记 dirty）→ 「非溢出失败带输出」用例红。
- `pnpm vitest run packages/dsh-shud-core/src/stack-lock` 全绿；`pnpm run check` exit 0（覆盖率不降）。

Non-goals: `maxBuffer` 调大或流式读取；真实 `chmod 000` 目录复现 stderr 溢出（依赖非 root 与文件系统权限、耗时长，用 shim 覆盖同一分支，复现记录在 issue）；status 参数与忽略语义；StackLock 组装与持久化（M3）；`llm` K4 对齐；git-lfs filter 副作用与宿主全局忽略（既定契约）。
