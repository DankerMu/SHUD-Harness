---
status: living
---

# 移植清单（Zero 时代 → dsh 插件）

reset 时只有本表列出的代码资产可以从 `archive/zero-v0.8.3` 搬入新布局；其余一律不搬。"可移植"不等于"值得移植"。

| 资产 | 旧路径（tag archive/zero-v0.8.3） | 新落点 | 处置 | 理由 |
|---|---|---|---|---|
| 8 对象 Zod schema | `packages/core/src/domain/schemas/` | `packages/dsh-shud-core/src/schemas/` | 已移植；RunJob/RunRecord schema 与收集链已在 M2 交付 | `RunRecord.llm.response_model` 已存在；#430 已对齐 StackLock 三字段、最小 runtime/harness、品牌 id、仓库 dirty 路径/截断与排除响应模型的指纹；`captureStackLock` 持久化及提交集成仍归后续 M3，不在本刀交付 |
| policy-gate-core 纯函数 + 单测 | `packages/core/src/tools/policy-gate-core.ts`（1.5K 行）+ `.test.ts` | `packages/dsh-shud-core/src/governance/policy-gate/` | 已按规则族拆分；三条 spawn 规则、旧 `DEFAULT_SHUD_POLICY_GATE_CONTEXT` 与重复别名 `isReservedAuthorityPolicyEvidenceId` 已删除；角色规则及其默认上下文待 #436 | 源与测试每文件 ≤1000 行；已移除 ESLint 文件大小/类型安全豁免、`.large-file-guard.json` 排除项及对应 baseline；knip duplicates 为 error，无重复导出豁免；当前保留 authority id 仅 `raw-data-write` 与 `tool-parameter-schema-validation` |
| role→tool_id 映射与快照 | `packages/core/src/tools/role-tool-map*.ts` | `packages/dsh-shud-core/src/governance/`（与 policy-gate-core 互相引用类型，必须同包） | ✅ 已移植；M3 的 presets 包从 core 消费它生成 `ctx.tools.restrict()` 配置 | 角色工具面 |
| 治理措辞规则 | spec 与 prompt 文本 | `packages/dsh-shud-core/src/governance/wording.ts` | M3 重写为常量 + 测试（消费者 EvidenceReport） | 校准 ≠ 验证等四条不变式 |
| Zero 参照、策略门注册层 | `packages/core/src/zero-reference*.ts`、`policy-gate-registry.ts`（2.9K 行） | — | 不搬 | dsh waterfall 取代 |
| raw-data-sandbox 包装 | `packages/core/src/tools/raw-data-sandbox.ts`（5.7K 行） | — | 不搬 | `data/raw` 置于 root 之外由 Seatbelt 守 |
| workspace-record-store | `packages/core/src/domain/services/workspace-record-store.ts`（12K 行） | — | 不搬 | M3 records 包按会话工作区文件重做，不经 ctx.storage；M2 runs 与 stateDir 分工不变 |
| idempotency / lock / failure ledger 服务与 34K 行测试 | `packages/core/src/domain/services/` | — | 不搬 | 零交付功能下不值得 |
| backend（Hono）/ frontend（React） | `packages/backend`、`packages/frontend` | — | 不搬 | ADR-0004 K2 |
| GLM provider 脚本 | `scripts/glm-provider/` | — | 不搬 | 模型改为 DMXAPI（K3） |
| spike 插件 `shud-raw-guard` | `../dsh-spike/plugins/shud-raw-guard/index.js` | `packages/dsh-shud-raw-guard/` | ✅ TS 化 + 单测（M1） | spike 1.2 已验证 |
| spike overlay | `../dsh-spike/overlays/*.yml` | `profile/shud/cordis.patch.yml` | ✅ 已合并 dmxapi-flash；raw-guard ✅ 已加入（包说明符） | 模型路由 + 出站关闭（只关 `session-log-deepseek`，K9；spike 里关掉的 otel/inventory 两行按 K9 不带入） |

移植时的运行时调整：测试从 `bun:test` 改 `vitest`；包内相对导入带 `.ts` 扩展名（`rewriteRelativeImportExtensions`，Node 24 直接运行 `.ts` 的 `scripts/schema/generate.ts` 与 `tsc` 产出都能解析）；`core-schemas.test.ts` 的 `import.meta.dir` 改为 `fileURLToPath(import.meta.url)`；`tsc --noEmit` 不含 `*.test.ts`（与旧根 tsconfig 一致，测试由 vitest 负责）。
