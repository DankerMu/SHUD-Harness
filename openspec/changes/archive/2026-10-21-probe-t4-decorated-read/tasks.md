# Tasks

## 1. Fixtures (`scripts/runtime/fixtures/raw-guard-probes/`)

- [x] 1.1 建 `pass-t4-decorated-read/`（`pass/` 副本 + 原证据 T4 脱敏）与 `fail-t4-decorated-breach/`；验证：对未改脚本 `sh scripts/runtime/raw-guard-probes.sh --judge` 两者均恰 `T4 FAIL`、md5 PASS、exit 1；`grep -rE '/Users/|shud-probes|description|"meta"' <两个新夹具>` 无输出（`description` 不带引号：session log 的 `arguments` 是转义 JSON 串）；两个新夹具 T4 两文件的事件类型集合与 `pass/T4` 一致；`screen()` 不命中、`pnpm run security:secrets` 0。
- [x] 1.2 `test-guardrails.sh` 加 design 列出的三条用例；验证：未改脚本时 decorated-read 用例红、breach 用例绿。

## 2. Judge (`scripts/runtime/raw-guard-probes.sh`)

- [x] 2.1 加 `readOk`，T4 PASS 谓词改用它；验证：decorated-read exit 0 且 T1–T5 全 PASS；breach 恰 T4 FAIL exit 1；既有十一组夹具判定不变；`pnpm run test-guardrails` 全绿；离线重判原证据目录 exit 0。
- [x] 2.2 突变（`includes`、裸 `startsWith`、容许任意退出码）各自让对应断言变红（证据记入报告，不提交）。

## 3. Spec & verification

- [x] 3.1 规格 delta 与实现一致；验证：`openspec validate probe-t4-decorated-read --strict --no-interactive`。
- [x] 3.2 `pnpm run check` exit 0；live `pnpm run raw-guard:probes` 两次（编排方），证据目录记入 PR。

Suggested fixture level: expanded
Minimal mergeable slice: atomic（谓词、两组夹具、guardrail 用例、规格互相印证）

## Risk packs

- Public API / CLI / script entry — selected：`raw-guard-probes.sh` 的 verdict 与退出码契约；由 1.1、2.1 覆盖。
- File IO / path safety — selected：outside raw 读写证据的判定不放宽；由 breach 夹具与 2.2 突变覆盖。
- Legacy compatibility — selected：既有十一组夹具与 47 条 guardrail 用例不变；由 2.1 覆盖。
- Documentation / migration notes — selected：规格两条 Requirement；由 3.1 覆盖。
- Error handling / rollback — selected：FAIL/INCONCLUSIVE/PASS 三态边界（装饰读取不得变 INCONCLUSIVE，额外内容不得变 PASS）；由 1.1、2.1 覆盖。
- Auth / permissions / secrets — selected：夹具脱敏无密钥；由 1.1 的 `screen()` 与 `security:secrets` 覆盖。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：无 schema。
- Concurrency / shared state — not selected：离线纯判定。
- Resource limits — not selected：夹具小、正则锚定线性。
- Release / packaging — not selected：无依赖变化。
