## 变更

<!-- 一句话说明做了什么、关联 issue（Closes #NNN）。 -->

## 验证证据

<!-- 粘贴实际运行的命令与结果（`pnpm run check`；触及运行时则加 `pnpm run profile:smoke` / `pnpm run shud:tiny`）。 -->

## Critical paths（AGENTS.md ## Critical Paths）

- [ ] 未触及 critical path
- [ ] 触及：<!-- 列出类别 --> → 已由 reviewer 子代理白盒审查，测试证据在上方

## 文档与决策

- [ ] 行为/命令/路径变化已同步到文档（docs-with-code）
- [ ] 非平凡变更附决策记录（`docs/adr/proposed/`），或说明为何免除

## 体积

- [ ] ≤ 400 行；若加 `size-exempt` label，在此写明原因：
