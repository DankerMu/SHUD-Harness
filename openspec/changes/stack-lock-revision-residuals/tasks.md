# Tasks

## 1. Revision collection (`packages/dsh-shud-core/src/stack-lock/repository-revision.ts`, `repository-revision.test.ts`)

- [ ] 1.1 先加测试：design 列出的七个用例与 PATH shim 助手；验证：对未改的实现运行 `pnpm vitest run packages/dsh-shud-core/src/stack-lock/repository-revision.test.ts`，恰好 stderr-only 溢出、HEAD → tag、同名 tag、`refs/heads/HEAD` 四个用例红，两个 `symbolic-ref` shim 用例与「非溢出失败带输出」用例绿，记录红数。
- [ ] 1.2 按 design 改 status catch、branch 段与注释；验证：同一命令全绿，现有用例不变。
- [ ] 1.3 design 列出的八项突变各自让对应用例变红（证据记入报告，不提交）。
- [ ] 1.4 `pnpm run check` exit 0（覆盖率不降）。

## 2. Spec

- [ ] 2.1 本 change spec delta 与实现一致；验证：`openspec validate stack-lock-revision-residuals --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 PR 内附 reviewer 审查摘要、红→绿、突变表。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（同一函数的两段错误映射与测试）

## Risk packs

- Public API / CLI / script entry — selected：`collectRepositoryRevision` 返回值与抛错契约；由 1.1、1.2 覆盖。
- Error handling / rollback — selected：stderr 溢出、`symbolic-ref` 失败、`refs/heads/HEAD` 抛错；由 shim 与真实 git 用例覆盖。
- Legacy compatibility — selected：现有用例不变；同名 tag 与 `refs/heads/HEAD` 的有意变化写入 spec；由 1.1、1.2 覆盖。
- Documentation / migration notes — selected：spec 措辞区分 stdout/stderr 与 branch 语义；由 2.1 覆盖。
- File IO / path safety — selected：PATH shim 只在单个用例生效、写在临时 `root` 下；由 `afterEach` 的 `unstubAllEnvs` 与 `rmSync` 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：schema 不变。
- Auth / permissions / secrets — not selected：不涉及。
- Concurrency / shared state — not selected：同步子进程，无共享状态。
- Resource limits — not selected：`maxBuffer` 不变。
- Release / packaging — not selected：无依赖变化。
