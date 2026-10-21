# Proposal

## Why

#199（IR-001，`docs/00_INDEX/Requirements_Catalog.md:65`；`docs/03_SPEC/Workspace_Conventions.md:70,74`）：StackLock 必须记录 SHUD/rSHUD/AutoSHUD 的实际 commit 与 dirty state。现 `packages/dsh-shud-core/src/schemas/stack-lock.ts:6-9` 的 `RepositoryRevisionSchema` 只有 `{ commit, branch }`，同一 commit 的 clean checkout 与含本地修改的 checkout 产生相同 `repos`，两种不可等价环境被视为同一复现栈。仓库内也没有任何采集逻辑与指纹算法：`Minimal_Schemas.md:90` 只写了 `fingerprint: "sha256:..." # 整体哈希`，验收条目「同 commit 的 clean→dirty 改变 fingerprint」因此无从断言。

## What Changes

- `packages/dsh-shud-core/src/schemas/stack-lock.ts`：`RepositoryRevisionSchema` 增加 required `dirty: z.boolean()`（strictObject 不变）；导出 `RepositoryRevision` 类型。`llm` 字段不动（K4 三字段对齐属于 M3 StackLock 交付，见 `docs/04_IMPLEMENTATION/Port_List.md:11` 已记录漂移）。
- 新增 `packages/dsh-shud-core/src/stack-lock/fingerprint.ts`：`computeStackFingerprint(lock)` = `"sha256:" + hex(sha256(canonicalJson(content)))`，`content` 为 lock 去掉 `stack_id`、`created_at`、`fingerprint` 三个字段；`canonicalJson` 在每一层按键名码元序排序、无空白、`null` 原样保留。
- 新增 `packages/dsh-shud-core/src/stack-lock/repository-revision.ts`：`collectRepositoryRevision(repoPath)` 只读采集 `{ commit, branch, dirty }`——`git rev-parse --show-toplevel`（必须等于 `realpathSync.native(repoPath)`，不得向上发现父仓库）、`git rev-parse --verify HEAD`、`git symbolic-ref --short -q HEAD`（detached → 固定值 `"HEAD"`）、`git status --porcelain --untracked-files=normal --ignore-submodules=none`（tracked 修改 + untracked 文件，沿用 git status 的三个忽略来源 `.gitignore`、`.git/info/exclude`、`core.excludesFile`，不受 `status.showUntrackedFiles` 配置影响）。`execFileSync` 参数数组无 shell，附 `-c core.fsmonitor=false`；环境 `GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`，并剔除继承的仓库定位变量（`GIT_DIR` 等）。非仓库路径、无提交的仓库、或另一仓库内的空子目录（未初始化 submodule）抛错并写明路径。
- `packages/dsh-shud-core/src/index.ts` 导出两个函数。
- 测试：schema 正反例（`core-schemas.test.ts`）；指纹（新 `fingerprint.test.ts`）；采集（新 `repository-revision.test.ts`，只用 `mkdtemp` 临时仓库，绝不对 `SHUD/`、`rSHUD/`、`AutoSHUD/` 执行）。
- `pnpm run schema:generate` 重建 `docs/generated/schema/stack-lock.md` 与 `docs/generated/json-schema/stack-lock.json`。
- `docs/03_SPEC/Minimal_Schemas.md` §2：`repos` 示例加 `dirty: false`，`fingerprint` 注释改为算法定义，并加 `dirty` 语义一句。

落点理由：`docs/04_IMPLEMENTATION/Repository_Layout.md:25` 规划的 `dsh-shud-records` 是 `ctx.storage` 域插件包；指纹是纯函数、采集只依赖 `node:child_process`/`node:crypto`，都不依赖 dsh 运行时，符合 core「运行时无关」（`policy-gate-core.ts:1` 已导入 `node:util`）。现在为一个采集函数建空壳插件包违反 YAGNI；M3 的 records 包组装 StackLock 时导入这两个函数。

## Triage

Issue type: feature
Fixture level: expanded
Upstream suggested level: absent；触发词：`StackLock`（project-profile Domain expanded-triggers）、Schema 与生成投影（Critical Paths #7）、子进程执行
Blast radius: 采集写入 submodule（index 刷新、fsmonitor socket）会破坏只读不变量；继承 `GIT_DIR`，或从未初始化 submodule 的空目录向上发现父仓库，会静默采集错仓库（后者会把 SHUD-Harness 的 commit 记成 SHUD 的）；用户配置 `status.showUntrackedFiles=no` 会隐藏 untracked 文件而误判 clean；指纹算法不稳定（键序、包含 `created_at`）会让同一环境比对失败；`dirty` 改为 required 会使既有 StackLock 文档失效——仓库内无持久化的 StackLock 写入方（schema 之外无引用），只有测试夹具 `validStackLock()` 受影响
Selected risk packs: Schema / fields; Public API / CLI / script entry; File IO / path safety; Error handling / rollback; Legacy compatibility; Documentation / migration notes
Evidence floor: schema 正反例；采集 clean / tracked 修改 / untracked / ignored / detached / gitfile / 继承 `GIT_DIR` / 非仓库 / 无提交 / 仓库内空子目录 / `status.showUntrackedFiles=no` / index 字节不变 / `.git/info/exclude` 与 `core.excludesFile` 排除 / status 输出超缓冲 / status 其他失败带路径抛错 / 大小写不同的路径写法（大小写不敏感文件系统）；指纹 clean→dirty 变化、`stack_id`/`created_at`/`fingerprint` 无关、键序无关、固定向量；`pnpm run check`；`pnpm run schema:check` 无漂移

## Capabilities

### New Capabilities

- `stack-lock`: StackLock 仓库版本字段、只读采集、整体指纹。

## Impact

- 代码：`packages/dsh-shud-core/src/schemas/stack-lock.ts`、新增 `src/stack-lock/{fingerprint,repository-revision}.ts` 与测试、`src/index.ts`。
- 生成物：`docs/generated/schema/stack-lock.md`、`docs/generated/json-schema/stack-lock.json`（`schema:generate`）。
- 文档：`docs/03_SPEC/Minimal_Schemas.md` §2。
- 运行时：无（尚无 StackLock 组装方；M3 records 包接入）。
