# Tasks

## 1. Decision core (`packages/dsh-shud-raw-guard/src/decide.ts`, `decide.test.ts`)

- [x] 1.1 先加测试：design 列出的 ask 行与 deny 行（含默认 `data/raw` 的 `>>` 行与对照行）入 `test.each` 表，`reason` 断言齐全；验证：对未改的 `decide.ts` 运行 `pnpm vitest run packages/dsh-shud-raw-guard/src/decide.test.ts`，恰好新增的 ask 行红、deny 行绿，记录红行数。
- [x] 1.2 加 `DISCARD_REDIRECT` 常量与 `checked = command.replace(DISCARD_REDIRECT, " ")`，`WRITE_VERBS.test(checked)`；mention 判定、`PWSH_WRITES.test(command)` 不改；验证：同一命令全绿，`git diff` 显示 `decide.ts` 仅新增常量与改一行。
- [x] 1.3 `pnpm run check` exit 0（覆盖率不降）；`pnpm run build` 产出 `lib/decide.js`。

Suggested fixture level: expanded
Minimal mergeable slice: atomic

## 2. Spec

- [x] 2.1 本 change `specs/raw-data-guard/spec.md` delta（编排方已写）与实现一致：剥除列表、`/dev/nullx` 排除、两个场景；验证：`openspec validate raw-guard-discard-redirect --strict --no-interactive`。

## 3. Verification

- [x] 3.1 `pnpm run raw-guard:probes`（编排方执行）：T1–T5 PASS 或 INCONCLUSIVE 重跑，md5 不变，证据目录记入 PR。
- [x] 3.2 PR 内附 reviewer 白盒审查摘要（Critical Paths #1/#2）、红→绿证据、probes 结果。

## Risk packs

- Public API / CLI / script entry — selected：`decideRawAccess` 决策契约（deny/ask 行）；由 1.1、1.2 覆盖。
- File IO / path safety — selected：`/dev/null` 与 `/dev/nullx`、`/dev/null/x` 的边界；由 1.1 的 deny 行覆盖。
- Auth / permissions / secrets — selected：deny→ask 把决定权交回 PI 审批卡，方向仍 fail-closed（ask 而非 next）；由 ask 行 `reason` 断言与探针 T2 覆盖。
- Legacy compatibility — selected：全部既有行不变、探针 T3 仍 deny；由 1.1（既有表）、3.1 覆盖。
- Documentation / migration notes — selected：spec delta；由 2.1 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：纯函数。
- Resource limits — not selected：正则线性。
- Error handling / rollback — not selected：无新错误路径。
- Release / packaging — not selected：无依赖变化。
