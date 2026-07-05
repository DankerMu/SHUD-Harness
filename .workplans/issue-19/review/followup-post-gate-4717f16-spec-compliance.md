Reviewer agent: review-spec-compliance
Review round: post-gate follow-up on 4717f16
Reviewed head SHA: 4717f1608058418a279365b385afc17e35e2238a

Summary: 仍有 1 个 P1 spec-compliance 缺口：over-budget + hidden raw-write 组合会把被 sandbox 拦截的 raw 写尝试记成成功。

Invariant Matrix Coverage:
- issue/task/spec scenarios: missing - 六类主逃逸、合法 raw read/workspace write、hardlink residual、advisory evidence 均有覆盖；但 `COMMAND_ANALYSIS_MAX_LENGTH` 超限且 stderr/exit 被隐藏的非法 raw 写没有失败证据覆盖。
- ADR boundary: covered - authority 位于 SHUD wrapper 的 macOS seatbelt 执行层；Linux backend/full ingest/full WS 均未扩张。
- non-goals: covered - 未实现 Linux landlock/bwrap、完整 WS bus、完整 AuditEvent、ingest/readiness hardlink 接线。
- zero+WS registry: covered - `zero` diff 为 0，HEAD=`13e25c116c62411e6ee8a0ad67a6c53dc7c376c6`；WS 仅复用 `tool.failed`，未新增事件类型。

Findings:
- severity: P1
  failure class: evidence-state false success / spec compliance
  violated invariant/contract: `data/raw/**` 写尝试即使由 OS sandbox 拦截，也必须返回失败工具结果、`tool.failed` 证据和 audit denial；不能记为 `tool.completed`/`allowed`。见 `openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md:23`、`:31-32`，以及 `openspec/changes/m1-foundation/design.md:178`。
  concrete scenario: `printf hidden > data/raw/over-budget-hidden.txt 2>/dev/null; true # <140k filler>` 超过 command analysis budget，sandbox 会阻止 raw 字节落盘，但 shell 把 stderr 和 exit code 都吞掉。
  evidence (file:line): `packages/core/src/tools/raw-data-sandbox.ts:674-685` 超预算时丢弃 raw target 识别；`packages/core/src/tools/raw-data-sandbox.ts:634-656` hidden-denial guard 只拒绝已识别/未完整扫描的 raw target；`packages/core/src/tools/raw-data-sandbox.ts:3789-3794` 超预算 post-exec 只在 `!result.success` 且有 denial output 时归一化；`packages/core/src/tools/raw-data-sandbox.ts:453-465` 成功结果会落 `tool.completed`/`allowed`；现有 over-budget 测试只覆盖合法 raw read/workspace write，见 `packages/core/src/tools/raw-data-sandbox.test.ts:2669-2698`。
  consequence: raw bytes虽然未被改动，但工具层会向上游报告成功并写入 allowed audit，PI/后续 agent 会得到错误执行事实，违背 denial evidence 契约。
  fix direction: 在超预算路径保留一个廉价、保守的 raw-write + hidden-evidence 判定，或让执行层能独立捕捉 sandbox violation；修复必须继续允许 over-budget 合法 raw read/workspace write。
  required test/proof: 增加 macOS seatbelt 测试：over-budget hidden raw write 应返回 `raw_data_write_denied`、audit `tool.failed`，且 raw 文件缺失；同时保留 `2669-2698` 的合法 over-budget allow 断言。
  sibling surfaces: interpreter payload length budget、segment-count budget、large generated R/Python/Node scripts、`enableAdvisory=false` wrapper path、post-exec denial normalization。
  blocking status: Blocking for issue #19/task 3.3 spec-compliance sign-off.

Non-blocking notes:
- `tasks.md:33` 仍未勾选，我未单独作为 finding；该状态可能由 orchestrator 在最终 evidence gate 后更新。
- 已执行只读校验：`git diff --check`、`openspec validate m1-foundation --strict --no-interactive`、`git -C zero diff --quiet && git -C zero rev-parse HEAD`。未运行 Bun 测试：`bun` 不在 PATH，且我未用 `pnpm dlx` 拉取运行时以保持只读 review。

Execution Summary: agents=review-spec-compliance; skills=review; tools=gh,git,rg,sed,openspec; verification=static/read-only checks passed, Bun tests not run; limits=no file writes.
