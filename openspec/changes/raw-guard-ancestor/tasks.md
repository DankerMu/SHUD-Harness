# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [ ] 1.1 先加测试：把 design 列出的 deny/误报/只读/反例/级数上限/`..` 排除/已记录漏报行写入新的 `ancestorCases` 表。验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，应恰好是新增的 deny 行（含已接受误报行）为红（当前为 next），其余新行为绿，既有行全绿。记录红行数。
- [ ] 1.2 新增 design 列出的常量与 `rawAncestors`，在原 rawDirs 循环之后加第二遍祖先判定（原循环不变）。验证：同一命令全绿，既有行不变；`git diff` 中 `decide.ts` 只动新常量、新函数与第二遍判定。
- [ ] 1.3 design 列出的三十项突变各自让对应行变红（证据记入报告，不提交）。
- [ ] 1.4 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build`；`pnpm run test-guardrails`。

## 2. Spec

- [ ] 2.1 本 change 的 spec delta 与实现一致；验证：`openspec validate raw-guard-ancestor --strict --no-interactive`。

## 3. Verification

- [ ] 3.1 `pnpm run raw-guard:probes`（编排方）跑两次：T1–T5 PASS，INCONCLUSIVE 则重跑；md5 不变。
- [ ] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿、突变表、probes 结果。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（一个祖先判定和一处分支改动）

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 的决策契约；由 1.1、1.2 覆盖。
- File IO / path safety — selected：严格边界，`data/derived` 与 `other/data` 不得误中；由反例行覆盖。
- Auth / permissions / secrets — selected：next→deny 收紧，已接受误报写明；由误报行覆盖。
- Legacy compatibility — selected：既有全部行与探针不变；由 1.1、3.1 覆盖。
- Documentation / migration notes — selected：spec delta（新 Requirement、第五处漏报）；由 2.1 覆盖。
- Resource limits — selected：每个 raw 最多 9 个祖先正则（三处来源各 3 级）× 候选文本，只对未触及 raw 的命令计算，均为线性正则；由两条走到祖先分支的 1e6 级对抗行覆盖。
- Config / project setup — not selected：无配置变化（级数为 PI 决定的模块常量）。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
