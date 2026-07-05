## 工作情况说明（Merge 前）

- 关联 Issue：#19
- PR：#48
- 冻结提交：`15af873cf0eb54b6510257b126d55250a071df7f`

### 背景与目标

- #19 已按 ADR-0001 revisit 裁决重定为条 2'：`data/raw/**` 写禁区 authority 下沉到执行层 macOS seatbelt，pre-exec 静态检查降级为 advisory。
- 本 PR 的验收边界是 raw 字节完整性、可信可观测拒绝面、hardlink 残留演示与有界扫描、`tool.failed`/audit 最小证据，以及 Zero 源码零改动。

### 本次具体改动

- 新增 SHUD 侧 `RawDataSandboxedBashTool`，通过 `/usr/bin/sandbox-exec -f` 施加 seatbelt profile，保护 raw/evidence/audit 边界。
- 增加 raw 写 advisory、profile 组装、audit 行、hardlink `nlink>1` 扫描、输出截断和生命周期终态处理。
- 增加 backend `tool.failed` skeleton builder，约束 raw-denial trusted evidence 来源。
- 更新 OpenSpec、ADR 与 M1 plan，明确隐藏拒绝完整遥测和任意后代生命周期所有权移出 #19。
- 最后修复 custom evaluator malformed deny：外层 evaluator 不能伪造 raw-denial evidence， malformed deny 会 fail closed 且 finalize running handle。

### 测试与验证

- 本地：`pnpm --package=bun@1.2.19 dlx bun run check` 通过。
- 本地 seatbelt：`SHUD_REQUIRE_SEATBELT_TESTS=1 pnpm --package=bun@1.2.19 dlx bun run test:policy-gate` 通过，208 tests。
- 本地专项：`pnpm --package=bun@1.2.19 dlx bun test packages/core/src/tools/policy-gate-registry.test.ts --timeout 30000` 通过，24 tests。
- OpenSpec：`openspec validate m1-foundation --strict --no-interactive` 通过。
- Git/Zero：`git diff --check` 通过；`zero/` 无 diff 且 HEAD 为 `13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`。
- GitHub CI：`linux-base`、`macos-seatbelt`、聚合 `check` 均为 SUCCESS。

### Review 与修复闭环

- #19 经多轮 high-risk 六路 review + verifier，前期 blockers 已逐类修复并留存于 `.workplans/issue-19/review/`。
- 最新六路 comprehensive follow-up 在 `15af873cf0eb54b6510257b126d55250a071df7f` 上 clean，无候选 finding。
- Phase 7 final gap sweep 在同一 SHA 上 clean，无新增 P0/P1/P2。
- 最后一个已确认 blocker `cand-final-92f5569-01-malformed-custom-evaluator-deny` 已由 `15af873` 关闭。

### 兼容性、风险与已知限制

- 不修改 `zero/`，不新增 WS 事件类型，不实现 Linux 沙箱后端。
- seatbelt execution tests 只在 macOS job 强制运行；Linux job 负责基础 check。
- 预存 hardlink alias 是 ADR 已记录残留：本 PR 提供演示与有界 `nlink>1` 扫描，正式 ingest/readiness 接线不在本 issue。
- 隐藏拒绝完整遥测与任意后代进程生命周期所有权不在 #19 验收内，已在 OpenSpec/ADR 记为后续 executor/audit 边界。

### 维护者关注点

- 无额外关注点；本轮 merge gate 关注的是 final evidence 是否与冻结 SHA `15af873cf0eb54b6510257b126d55250a071df7f` 对齐。
