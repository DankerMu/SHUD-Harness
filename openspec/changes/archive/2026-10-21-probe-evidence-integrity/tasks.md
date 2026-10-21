# Tasks

## 1. Fixtures (`scripts/runtime/fixtures/raw-guard-probes/`)

- [x] 1.1 新建 `fail-empty-session/`：复制 `pass/`，T5 `stream.jsonl` 置空、T5 `session.jsonl` 置为 `" \n"`，其余字节不变；对修复前脚本运行 `--judge` 并记录其 exit 0（红）。
- [x] 1.2 新建 `fail-approval-granted/`：复制 `pass/`，仅 T2 `session.jsonl` 的 `approval/decided.outcome` → `allowed-once`；`--judge` exit 1、恰 T2 FAIL。注意：此夹具对修复前脚本已 exit 1——它测的是自证强度（能否分辨 T2 判据退化），不是红→绿用例；报告中如实写明。
- [x] 1.3 `gitleaks` 对两份新夹具 0 leaks；`diff -r` 对 `pass/` 只显示设计写明的差异。

Suggested fixture level: expanded
Minimal mergeable slice: atomic

## 2. Judge integrity gate (`scripts/runtime/raw-guard-probes.sh`)

- [x] 2.1 `judge()` 每探针先过完整性门（首事件 session + 合法非空 `sessionId` + header `id` 相等 + exit 0 无 signal/error），不满足即该探针 FAIL；T1–T5 业务判据原文不动；live 路径不动。
- [x] 2.2 `--judge pass` 仍 5/5 PASS exit 0；`fail` exit 1；`fail-empty-session` 恰 T5 FAIL exit 1；`fail-approval-granted` 恰 T2 FAIL exit 1。

## 3. Guardrail self-test (`scripts/guardrails/test-guardrails.sh`)

- [x] 3.1 新增 `expect_fail` ×2（两份新夹具）与一条 judge 输出形状用例（design 给出的 `expect_pass … sh -c '…'` 原文：`pass` 含 `T5 PASS`；`fail` 含 `md5 FAIL`；两份新夹具各恰该探针 FAIL、`md5 PASS` 且 FAIL 行恰 1 条；四组夹具均不含 `all five PASS`），不加 helper、不改既有用例；`pnpm run test-guardrails` 全 PASS。

## 4. Verification

- [x] 4.1 `pnpm run check` exit 0；`pnpm run raw-guard:probes` live 5/5 PASS、md5 不变（证明门不误伤真实绿跑）。
- [x] 4.2 PR 内附 reviewer 白盒审查摘要、`test-guardrails` 与 probes 结果。

## Risk packs

- Public API / CLI / script entry — selected：`--judge` 的退出码与输出契约；由 2.2/3.1 覆盖。
- File IO / path safety — selected：空/空白/缺失文件的读取路径；由 1.1、2.1 覆盖。
- Legacy compatibility — selected：`pass/`、`fail/` 结果不变，live 5/5；由 2.2、4.1 覆盖。
- Error handling / rollback — selected：完整性失败局部化为该探针 FAIL，不中断整体 judge；由 `fail-empty-session` 的 `T5 FAIL` + 「FAIL 行恰 1 条」断言覆盖（间接断言 T1–T4 未失败）。
- Documentation / migration notes — selected：spec delta。
- Config / project setup — not selected：无配置变化。
- Schema / fields — not selected：不改事件 schema，仅读取。
- Auth / permissions / secrets — not selected：夹具脱敏由 1.3 gitleaks 覆盖，无新密钥流。
- Concurrency / shared state — not selected：单进程顺序读取。
- Resource limits — not selected：夹具 <100KB。
- Release / packaging — not selected：无依赖变化。
