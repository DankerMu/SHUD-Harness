# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [x] 1.1 先加测试：design 列出的 `normalizeRawDirs` 单测、shell 决策表、祖先行、工作区行、文件工具行。验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，红绿划分须与 design「Required evidence」一致（改前就为绿的钉住行不得删除），既有行全绿。记录红行数。
- [x] 1.2 按 design 改 `normalizeRawDirs` 返回值。验证：同一命令全绿，既有行不变；`git diff` 中 `decide.ts` 只动该返回值与其注释。
- [x] 1.3 design 列出的十一项突变各自让对应行变红（证据记入报告，不提交）。
- [x] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`；`pnpm run test-guardrails`。

## 2. Spec

- [x] 2.1 本 change 的 spec delta 与实现一致；验证：`openspec validate raw-guard-dot-prefix --strict --no-interactive`。

## 3. Verification

- [x] 3.1 `pnpm run raw-guard:probes`（编排方）跑两次：T1–T5 PASS，INCONCLUSIVE 则重跑；md5 不变。
- [x] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Path #2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（一处返回值）

## Risk packs

- Config / project setup — selected：`rawDirs` 配置的规范化语义；由 1.1 单测覆盖。
- File IO / path safety — selected：`..`、`.raw`、`. raw`、绝对路径不变，`./` 不得变 `/`，`.//x` 不得变绝对路径；由单测与突变 3、5、6、7 覆盖。
- Auth / permissions / secrets — selected：next→deny/ask 收紧；由 shell 决策表覆盖。
- Legacy compatibility — selected：既有全部行与探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：spec delta；由 2.1 覆盖。
- Public API / CLI / script entry — not selected：导出签名不变。
- Resource limits — not selected：启动时每项一次线性替换。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
