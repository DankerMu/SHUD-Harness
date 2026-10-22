# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`, `decide-spelling.test.ts`)

- [x] 1.1 先加测试：design 列出的拆分动词、tar 解包、大小写、ask/next 钉住、已接受误报、祖先、资源行。验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard`，红绿划分须与 design「Required evidence」一致，既有行全绿。记录红行数。
- [x] 1.2 按 design 加 `unquote`、`TAR_COMMAND`、`TAR_EXTRACT_OPTION`、`tarExtracts`，改两遍判定。验证：同一命令全绿，既有行不变；`git diff` 中 `decide.ts` 只动这些位置。
- [x] 1.3 design 列出的三十四项突变各自让对应行变红（证据记入报告，不提交）。
- [x] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`；`pnpm run test-guardrails`。

## 2. Spec

- [ ] 2.1 本 change 的 spec delta 与实现一致；验证：`openspec validate raw-guard-write-spelling --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方）跑两次：T1–T5 PASS，INCONCLUSIVE 则重跑；md5 不变。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（写判定候选集与 tar 检测同属第一遍写判定）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：`-X`、`-C`、分段与 `a.tar` 文件名不得误判；由 ask 钉住行与突变 5、6、8、10、20–34 覆盖。
- Auth / permissions / secrets — selected：ask→deny 收紧与已接受误报；由误报行覆盖。
- Legacy compatibility — selected：既有全部行与探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：两条 Requirement 的 delta；由 2.1 覆盖。
- Resource limits — selected：`tarExtracts` 分段后从第一个 `tar` 扫描，线性；由两条资源行与突变 14 覆盖。分段规则由突变 6、19 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
