---
status: living
---

# 移植清单（Zero 时代 → dsh 插件）

reset 时只有本表列出的代码资产可以从 `archive/zero-v0.8.3` 搬入新布局；其余一律不搬。"可移植"不等于"值得移植"。

| 资产 | 旧路径（tag archive/zero-v0.8.3） | 新落点 | 处置 | 理由 |
|---|---|---|---|---|
| 8 对象 Zod schema | `packages/core/src/domain/schemas/` | `packages/dsh-shud-core/src/schemas/` | 移植，删除 Zero 引用 | 运行时无关 |
| policy-gate-core 纯函数 + 单测 | `packages/core/src/tools/policy-gate-core.ts`（1.5K 行）+ `.test.ts` | `packages/dsh-shud-core/src/governance/` | 移植，重估体量 | 直接挂 `tools/pre-execute` |
| role→tool_id 映射与快照 | `packages/core/src/tools/role-tool-map*.ts` | `packages/dsh-shud-presets/` | 移植为 preset 的 `ctx.tools.restrict()` 配置 | 角色工具面 |
| 治理措辞规则 | spec 与 prompt 文本 | `packages/dsh-shud-core/src/governance/wording.ts` | 重写为常量 + 测试 | 校准 ≠ 验证等四条不变式 |
| Zero 参照、策略门注册层 | `packages/core/src/zero-reference*.ts`、`policy-gate-registry.ts`（2.9K 行） | — | 不搬 | dsh waterfall 取代 |
| raw-data-sandbox 包装 | `packages/core/src/tools/raw-data-sandbox.ts`（5.7K 行） | — | 不搬 | `data/raw` 置于 root 之外由 Seatbelt 守 |
| workspace-record-store | `packages/core/src/domain/services/workspace-record-store.ts`（12K 行） | — | 不搬 | 用 `ctx.storage` 域重做 |
| idempotency / lock / failure ledger 服务与 34K 行测试 | `packages/core/src/domain/services/` | — | 不搬 | 零交付功能下不值得 |
| backend（Hono）/ frontend（React） | `packages/backend`、`packages/frontend` | — | 不搬 | ADR-0004 K2 |
| GLM provider 脚本 | `scripts/glm-provider/` | — | 不搬 | 模型改为 DMXAPI（K3） |
| spike 插件 `shud-raw-guard` | `../dsh-spike/plugins/shud-raw-guard/index.js` | `packages/dsh-shud-raw-guard/` | TS 化 + 单测 | spike 1.2 已验证 |
| spike overlay | `../dsh-spike/overlays/*.yml` | `profile/shud/cordis.patch.yml` | 合并 | 模型路由 + 出站关闭 |
