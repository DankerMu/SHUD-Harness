# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [ ] 1.1 先加测试：design 列出的 deny/ask/next/反例/误报行入新 `test.each` 表；验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，恰好新增的 deny/ask 行与误报钉住行红（当前为 next），next 与反例行绿，记录红行数。
- [ ] 1.2 `pwsh` 前移、`texts` 改为 design 的构造并加注释；验证：同一命令全绿，既有行不变，`git diff` 中 `decide.ts` 只动 shell 分支。
- [ ] 1.3 design 列出的五项突变各自让对应行变红（证据记入报告，不提交）。
- [ ] 1.4 订正 fail-closed 注释块措辞（只改注释）。
- [ ] 1.5 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`。

## 2. Spec

- [ ] 2.1 本 change spec delta 与实现一致；验证：`openspec validate raw-guard-quote-split --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方）两次：T1–T5 PASS 或 INCONCLUSIVE 重跑，md5 不变。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（三种额外拼写共用一个候选文本构造与 pwsh 判定前移）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：兄弟名不误中、bash `sub\x` 不误判；由反例行覆盖。
- Auth / permissions / secrets — selected：next→deny/ask 收紧，已接受误报写明；由误报钉住行覆盖。
- Legacy compatibility — selected：既有全部行与探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：spec delta（四处已记录漏报）；由 2.1 覆盖。
- Resource limits — selected：候选文本至多 8 份、无新正则回溯；由 design 的复杂度说明与既有 1e6 对抗行（#255）在新构造下仍通过覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
