# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [ ] 1.1 先加测试：design 列出的 deny/ask 行入新 `test.each` 表（`kind` 与 `reason` 断言齐全）；验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，恰好 `>&` 文件形态、`<>` 形态、两条组合形态与 `>&/dev/nullx` 等新增 deny 行红，ask 行绿，记录红行数。
- [ ] 1.2 `WRITE_VERBS` 追加 `>&` 与 `<>` 两支，`DISCARD_REDIRECT` 扩为含 `>&`、`<>`，更新注释；验证：同一命令全绿；`git diff` 中 `decide.ts` 只动两个常量及注释。
- [ ] 1.3 design 列出的十项突变各自让对应行变红（证据记入报告，不提交）。
- [ ] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build` 产出 `lib/decide.js`。

## 2. Spec

- [ ] 2.1 本 change `specs/raw-data-guard/spec.md` delta 与实现一致：写动词清单补 `>&word`、`<>`，丢弃型列表补 `>&`、`<>`，两个新场景；验证：`openspec validate raw-guard-fd-redirect --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方执行）：T1–T5 PASS 或 INCONCLUSIVE 重跑，md5 不变，证据目录记入 PR。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿证据、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（一个常量的两支与丢弃列表互相依赖：只加 `>&` 支不扩丢弃列表会把 `>&/dev/null` 读判 deny）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：`/dev/null` 与 `/dev/nullx` 边界、`>&2x` 文件名；由 1.1 deny 行覆盖。
- Auth / permissions / secrets — selected：ask→deny 收紧，fd 复制必须仍 ask；由 1.1 ask 行与探针 T2 覆盖。
- Legacy compatibility — selected：既有行不变、探针 T3 仍 deny；由 1.1（既有表）、3.1 覆盖。
- Documentation / migration notes — selected：spec delta；由 2.1 覆盖。
- Resource limits — selected：新正则线性；由 1.1 中 design 列出的三条 1e6 级对抗输入测试行覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
