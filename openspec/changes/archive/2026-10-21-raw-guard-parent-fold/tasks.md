# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [x] 1.1 先加测试：design 列出的 deny/ask/组合/默认 raw/反例/不回归/残留/资源行入新 `test.each` 表，并把 #247 拼写表的 `data/x/../raw` 行改为 deny；验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，恰好新增 deny/ask 行（含改为 deny 的那行、s1 误报行与资源行）红（当前为 next），反例、不回归、残留 next 行绿，记录红行数。
- [x] 1.2 新增 `foldParentSegments` 并改 `texts` 第二层为 design 的构造；验证：同一命令全绿，既有行不变，`git diff` 中 `decide.ts` 只动新函数与 `texts`。
- [x] 1.3 design 列出的十一项突变各自让对应行变红（证据记入报告，不提交）。
- [x] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`。

## 2. Spec

- [x] 2.1 本 change spec delta 与实现一致；验证：`openspec validate raw-guard-parent-fold --strict --no-interactive`。

## 3. Verification

- [x] 3.1 `pnpm run raw-guard:probes`（编排方）两次：T1–T5 PASS 或 INCONCLUSIVE 重跑，md5 不变。
- [x] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（一个折叠函数与一处候选文本构造）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：兄弟名、跨词、折叠到他处不误中；符号链接残留钉住；由反例与残留行覆盖。
- Auth / permissions / secrets — selected：next→deny/ask 收紧，已接受误报（链接后回溯）写明；由 s1 行覆盖。
- Legacy compatibility — selected：既有全部行与探针不变，`<raw>/../other` 不变；由 1.1、不回归行、3.1 覆盖。
- Documentation / migration notes — selected：spec delta（`..` 漏报收窄）；由 2.1 覆盖。
- Resource limits — selected：折叠线性、候选文本至多 12 份；由资源行覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
