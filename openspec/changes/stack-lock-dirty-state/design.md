# Design

Change surface: `packages/dsh-shud-core/src/schemas/stack-lock.ts`（`RepositoryRevisionSchema` 加一个字段 + 导出类型）；新目录 `packages/dsh-shud-core/src/stack-lock/`（两个模块 + 两个测试）；`src/index.ts` 一行导出；`core-schemas.test.ts` 的 `validStackLock()` 与新增反例；`docs/generated/` 两个投影；`docs/03_SPEC/Minimal_Schemas.md` §2。

Must preserve:
- `StackLockSchema` 其余字段与 strictObject 语义不变：`stack_id` 正则、`runtime`、`harness`、`llm`（旧五字段，M3 对齐，不在本 change）、`fingerprint`、`created_at`。
- 其他 7 个对象 schema 与其生成投影字节不变（`schema:generate` 后 `git diff --stat docs/generated/` 只含 `stack-lock.md`、`stack-lock.json`）。
- `core-schemas.test.ts` 现有全部用例仍绿；`validStackLock()` 只加三个 `dirty: false`。
- 采集对目标仓库零写入：`.git/index` 字节、HEAD、refs、工作区文件在调用前后不变；不发起网络（只用 `rev-parse`、`symbolic-ref`、`status`，没有 `fetch`/`remote`）。
- 测试绝不对 `SHUD/`、`rSHUD/`、`AutoSHUD/` 或本仓库执行 git；只用 `mkdtemp` 临时目录，`afterEach` 删除。

Must add/change:
- Schema：`RepositoryRevisionSchema = z.strictObject({ commit: z.string().min(1), branch: z.string().min(1), dirty: z.boolean() })`；`export type RepositoryRevision = z.infer<typeof RepositoryRevisionSchema>`（类型导出；schema 常量是否导出由实现决定，未用导出会被 knip 拦）。
- 指纹 `computeStackFingerprint(lock: Omit<StackLock, "fingerprint"> & { fingerprint?: string }): string`：
  - `content` = 去掉 `stack_id`、`created_at`、`fingerprint` 后的对象（`repos`、`runtime`、`harness`、`llm`）。理由：`stack_id` 是身份、`created_at` 是时刻，同一环境两次建 lock 的指纹必须相等（`Minimal_Schemas.md:90`「用于快速比对」）；`fingerprint` 自指。
  - `canonicalJson(v)`：对象按 `Object.keys(v).sort()`（码元序）递归输出 `{"k":v,...}`；数组按序；字符串/数字/布尔/`null` 用 `JSON.stringify`；无空白。`undefined` 值不会出现（输入已过 schema；函数不负责校验）。
  - 返回 `"sha256:" + createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")`（64 位小写 hex）。
- 采集 `collectRepositoryRevision(repoPath: string): RepositoryRevision`：
  - `run(args)` = `execFileSync("git", ["-C", repoPath, "-c", "core.fsmonitor=false", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })`；`core.fsmonitor=false` 防止 fsmonitor 守护进程在 `.git/` 写 IPC socket（零写入）；`env` = `process.env` 复制，删去会把 git 重定向到别的仓库的变量 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_COMMON_DIR`、`GIT_NAMESPACE`，再设 `GIT_OPTIONAL_LOCKS=0` 与 `LC_ALL=C`（错误文本固定为英文）。用户/系统 git 配置照常生效（`safe.directory` 等需要它）；与 dirty 语义相关的配置由显式参数覆盖。`GIT_CEILING_DIRECTORIES` 等发现限制类变量保留（它们只收紧搜索，`-C <repo>` 不受其害）。
  - top-level 校验：`run(["rev-parse", "--show-toplevel"]).trim()` 必须等于 `realpathSync(repoPath)`（macOS 上 `/var` → `/private/var`，两侧都取 realpath），否则抛错（消息含 `repoPath` 与实际 top-level）。理由：`git -C <仓库内的空目录>` 会向上发现父仓库并返回父仓库的 commit——未初始化的 `SHUD/` submodule（未带 `--recurse-submodules` 的 clone）会被静默记成 SHUD-Harness 的 commit 与 dirty（fixture review 实测）。非仓库目录在此步即失败抛错。
  - `commit` = `run(["rev-parse", "--verify", "HEAD"]).trim()`；失败（无提交）→ `throw new Error(\`cannot read git HEAD at ${repoPath}: ...\`)`，含 git stderr 首行。
  - `branch` = `symbolic-ref --short -q HEAD` 的输出；该命令在 detached 时以 1 退出且无输出 → `"HEAD"`（git 禁止名为 `HEAD` 的分支，故无歧义）；其他非 0 退出码 → 抛错。
  - `dirty` = `run(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]).length > 0`：显式参数覆盖 `status.showUntrackedFiles=no` 等配置（否则 untracked 文件会被配置隐藏而判 clean，fixture review 实测）；`.gitignore` 忽略的文件不计；嵌套子模块改动计入。
- 测试 `repository-revision.test.ts`（临时仓库 helper：`git init -b main`，提交时 `-c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false`；`beforeEach` 用 `vi.stubEnv` 设 `GIT_CONFIG_GLOBAL=<os.devNull>`、`GIT_CONFIG_NOSYSTEM=1`，使 helper 与被测采集都不受宿主机全局 `core.hooksPath`、`init.templateDir`、`status.showUntrackedFiles`、`core.fsmonitor` 影响；`afterEach` 调 `vi.unstubAllEnvs()`（`vitest.config.ts` 未设 `unstubEnvs`）并 `rmSync(dir, { recursive: true, force: true })`）：
  1. clean：`{ commit: <rev-parse 结果, 40 hex>, branch: "main", dirty: false }`。
  2. tracked 修改：改已提交文件内容 → `dirty: true`，commit 不变。
  3. untracked 文件 → `dirty: true`。
  4. `.gitignore` 忽略的新文件 → `dirty: false`。
  5. detached（`checkout --detach`）→ `branch: "HEAD"`，commit 等于 detached 前 HEAD。
  6. gitfile 仓库（`git init --separate-git-dir <other>`，工作区 `.git` 为文件，形同 submodule）→ 正常采集。
  7. 继承 `GIT_DIR` 指向另一个仓库（先建好两个仓库，再 `vi.stubEnv("GIT_DIR", ...)`）→ 结果仍是 `repoPath` 的 commit。
  8. 非仓库目录 → 抛错，消息含该路径；`git init` 后无提交 → 抛错；**仓库内的空子目录**（形同未初始化的 submodule）→ 抛错，消息含该路径（不得返回父仓库的 commit）。
  9. 只读：用 `utimesSync(file, t, t)` 把已提交文件的 mtime 显式设为与提交时相差至少 2 秒（内容不变；不用 `sleep`，保证 stat 必然变化）后采集 → `dirty: false`，且 `.git/index` 采集前后 sha256 相同。编排方已在 git 2.49.0 实测：此情形下默认 `git status` 会改写 index，`GIT_OPTIONAL_LOCKS=0` 不会，故本测试能区分。
  10. 仓库内 `git config status.showUntrackedFiles no` 后新建未跟踪文件 → 仍 `dirty: true`。
- 测试 `fingerprint.test.ts`（以 `validStackLock()` 形态的本地常量为输入）：
  1. 格式 `/^sha256:[0-9a-f]{64}$/`。
  2. 只改一个 repo 的 `dirty` false→true → 指纹不同（IR-001 验收）。
  3. 只改 `stack_id`、`created_at`、或 `fingerprint` 值 → 指纹相同。
  4. 同内容不同键序（含嵌套对象）→ 指纹相同。
  5. `runtime.r_packages_lock` 为 `null` 与对象 → 指纹不同。
  6. 固定向量：一份写死的 lock 的指纹等于测试里写死的 64 位 hex；该 hex 由 `printf '%s' '<canonical json>' | shasum -a 256` 独立算出，命令与 canonical 串作为注释写在测试里（钉住算法，防止后续改动静默改变比对结果）。该向量同时钉住当前旧五字段 `llm` 形态；M3 按 K4 把 `llm` 收窄为三字段时，向量 SHALL 随之重算更新（测试注释写明），这是预期变化而非回归。
- `core-schemas.test.ts`：`validStackLock()` 三个 repo 加 `dirty: false`；新增反例：任一 repo 缺 `dirty` → issue path `repos.<name>.dirty`；`dirty: "false"`（字符串）→ 拒绝；多余字段仍被 strictObject 拒绝。
- `Minimal_Schemas.md` §2：三行示例改为 `{ commit: ..., branch: master, dirty: false }`；`fingerprint` 注释改为「`sha256:` + 去掉 `stack_id`/`created_at`/`fingerprint` 后按键排序的紧凑 JSON 的 SHA-256」；示例后加一句 `dirty` 语义（`git status --porcelain` 非空即 true，含 untracked、不含 ignored；detached 时 `branch` 为 `HEAD`）。

Governing invariant: 同一 commit 下 clean 与 dirty checkout 产生不同 `repos` 内容与不同指纹；采集对被采集仓库零写入、只看 `repoPath` 指向的仓库；指纹只由环境内容决定，与身份、时刻、键序无关。

Sibling surfaces:
- `scripts/schema/generate.ts:98-102` 读 `StackLockSchema` 生成投影——`schema:check`（CI）比对。
- `docs/03_SPEC/Workspace_Conventions.md:70,74,262` 已写 dirty 要求——不改，本 change 兑现它。
- `docs/04_IMPLEMENTATION/Port_List.md:11` 记录的 llm 漂移——不改。
- `knip`：新导出须被 `src/index.ts` 或测试使用；core workspace 以测试为 entry。
- `eslint` 的 `no-restricted-imports` 白名单：只用 `node:child_process`、`node:crypto`、`zod`，不 import dsh。

Seams under test: `StackLockSchema.safeParse`；`computeStackFingerprint` 纯函数；`collectRepositoryRevision` 对真实 git 二进制 + 临时仓库。

Required evidence:
- CI `sast`（semgrep `p/typescript`）通过：本 change 首次在包内引入 `child_process`，semgrep 只在 CI 运行。
- 新测试先红（模块不存在 / schema 缺 `dirty`）后绿；`pnpm vitest run packages/dsh-shud-core` 全绿。
- `pnpm run schema:generate` 后 `git diff --stat docs/generated/` 恰两个 stack-lock 文件，`stack-lock.json` 的 repos 定义 `required` 含 `dirty`、`type: boolean`。
- `pnpm run check` exit 0（覆盖率 ≥80%，新文件不靶向排除）。
- 固定向量的 `shasum` 命令可由 reviewer 复算。

Non-goals: `symbolic-ref` 除「detached 退出 1」外的其他非 0 退出码会抛错，但难以稳定构造，不设测试（已知缺口）；`llm.response_model` 是否进入指纹排除集——K4 规定它只记录、不使 lock 失效，M3 按 K4 对齐 `llm` 时一并决定（届时固定向量也重算）；描述符/fd 级权限证明、两次快照一致性屏障、Rust/gix；三仓库 StackLock 组装与持久化（M3 records 包）；`llm` K4 三字段对齐；EvidenceReport 对 dirty lock 的下游拒绝策略；schema 层校验 `fingerprint` 与内容一致；`stack_id` 格式（文档 `STACK-NNNN` 与代码 UUID 的差异，另记）。

Review focus:
1. 采集零写入：`GIT_OPTIONAL_LOCKS=0` 生效且测试 9 真的会在去掉它时变红（`git status` 默认会刷新 stat-dirty 的 index）。
2. 继承 `GIT_DIR` 被剔除，测试 7 在不剔除时变红。
3. detached 判定只把「退出 1 且无输出」当 detached，其他错误抛出。
4. 指纹 canonical 化递归到嵌套对象；排除集合恰为三字段。
5. `dirty` 为 required，生成投影同步；其余 schema 投影字节不变。
