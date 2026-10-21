# Tasks

## 1. Schema (`packages/dsh-shud-core/src/schemas/stack-lock.ts`, `core-schemas.test.ts`)

- [ ] 1.1 先改测试：`validStackLock()` 三个 repo 加 `dirty: false`；新增反例（每个 repo 缺 `dirty` → issue path `repos.<name>.dirty`；`dirty: "false"` 拒绝；多余字段拒绝）；验证：对未改 schema 运行 `pnpm vitest run packages/dsh-shud-core/src/schemas/core-schemas.test.ts`，正例与缺 `dirty` 反例红。
- [ ] 1.2 `RepositoryRevisionSchema` 加 `dirty: z.boolean()`，导出 `RepositoryRevision` 类型；验证：同一命令全绿。
- [ ] 1.3 `pnpm run schema:generate`；验证：`git diff --stat docs/generated/` 恰 `schema/stack-lock.md` 与 `json-schema/stack-lock.json`，JSON 的 repo 定义 `required` 含 `dirty`。

## 2. Fingerprint (`packages/dsh-shud-core/src/stack-lock/fingerprint.ts`)

- [ ] 2.1 先写 `fingerprint.test.ts`（design 列出的 6 条，含 `shasum` 独立算出的固定向量与注释；注释注明 M3 `llm` K4 对齐时须重算）；验证：模块不存在时红。
- [ ] 2.2 实现 `computeStackFingerprint`；验证：`pnpm vitest run packages/dsh-shud-core/src/stack-lock/fingerprint.test.ts` 全绿。

## 3. Collector (`packages/dsh-shud-core/src/stack-lock/repository-revision.ts`)

- [ ] 3.1 先写 `repository-revision.test.ts`（design 列出的 10 条，含仓库内空子目录抛错与 `showUntrackedFiles no` 仍 dirty；仅 `mkdtemp` 临时仓库，宿主 git 配置以 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` 屏蔽，`afterEach` 还原环境）；验证：模块不存在时红。
- [ ] 3.2 实现 `collectRepositoryRevision`；验证：该测试文件全绿；临时去掉 top-level 校验时空子目录测试红；去掉 `--untracked-files=normal` 时测试 10 红；去掉 `GIT_OPTIONAL_LOCKS=0` 时测试 9 红（mtime 用 `utimesSync` 显式错开 ≥2 秒）、去掉 `GIT_DIR` 剔除时测试 7 红（突变证据记入报告，不提交）。
- [ ] 3.3 `src/index.ts` 导出两个函数；验证：`pnpm run deadcode` 0 error。

## 4. Docs

- [ ] 4.1 `docs/03_SPEC/Minimal_Schemas.md` §2：repos 示例加 `dirty: false`、`fingerprint` 注释改为算法定义、加 `dirty` 语义一句；验证：`pnpm run docs:check` 绿。
- [ ] 4.2 本 change spec delta 与实现一致；验证：`openspec validate stack-lock-dirty-state --strict --no-interactive`。

## 5. Verification

- [ ] 5.1 `pnpm run check` exit 0（覆盖率 ≥80%）；CI `sast`（semgrep）通过；`pnpm run schema:check` 无漂移；`git status --short` 不含 `SHUD/`、`rSHUD/`、`AutoSHUD/` 变化。
- [ ] 5.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #7）与上述证据。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（schema 字段、指纹、采集同属 IR-001 一条验收，拆开会留下无法断言的半截）

## Risk packs

- Schema / fields — selected：`dirty` required、生成投影；由 1.1–1.3 覆盖。
- Public API / CLI / script entry — selected：`computeStackFingerprint`、`collectRepositoryRevision` 两个导出契约；由 2.1、3.1、3.3 覆盖。
- File IO / path safety — selected：对被采集仓库零写入（optional locks、fsmonitor 关闭）、只看 `repoPath`（剔除 `GIT_DIR`、top-level 校验）；由 3.1 测试 6/7/8/9 与 5.1 覆盖。
- Error handling / rollback — selected：非仓库、无提交、仓库内空子目录 → 抛错带路径，由 3.1 测试 8 覆盖；symbolic-ref 非 detached 失败抛错无测试（难以稳定构造，design Non-goals 记为已知缺口）。
- Legacy compatibility — selected：其余 schema 与投影字节不变、既有测试仍绿；无持久化 StackLock 需迁移（仓库内无写入方）；由 1.3、5.1 覆盖。
- Documentation / migration notes — selected：`Minimal_Schemas.md` §2 与 spec delta；由 4.1、4.2 覆盖。
- Config / project setup — not selected：无配置项；git 为既有系统依赖。用户 git 配置照常生效，dirty 相关配置由显式参数覆盖（测试 10）。
- Auth / permissions / secrets — not selected：不读写凭据；git 命令不触网。
- Concurrency / shared state — not selected：同步纯读；`GIT_OPTIONAL_LOCKS=0` 已避免与并发 git 进程争 index 锁。
- Resource limits — not selected：三仓库 `git status` 规模小（SHUD/rSHUD/AutoSHUD）。
- Release / packaging — not selected：无新依赖（`node:` 内建）。
