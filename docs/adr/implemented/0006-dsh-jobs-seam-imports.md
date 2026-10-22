---
status: accepted
kind: architecture
---

# ADR-0006: 放宽 dsh seam 导入白名单以实现持久化作业注册表

## 背景

ADR-0004 K2 规定插件只经文档化 seam 接入宿主，`eslint.config.mjs` 据此只允许 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`。M2 的持久化作业注册表必须替换 Web 模板的 `jobs-local` 行（ADR-0004 K8）：dsh 只允许一个 `ctx.jobs` 实现，替换者必须继承 `@deepseek-ai/dsh-jobs` 的 `JobRegistry` 契约。PI 在 M2 压测（OpenSpec change `m2-run-chain`，Stage 1 grill）中选定继承 `@deepseek-ai/dsh-jobs-local` 的 `LocalJobRegistry`，复用其约 900 行作用域与事件实现。重启后的唤醒需要 `sessionController`、`sessions` 与 Agent 的类型。

## 决策

1. 运行时 import 白名单增加 `@deepseek-ai/dsh-jobs`（抽象契约与类型）与 `@deepseek-ai/dsh-jobs-local`（`LocalJobRegistry` 父类）。
2. 其余宿主包只允许 `import type`，用于 `ctx.inject` 取得的服务（`sessionController`、`sessions`、Agent 等）的静态类型；运行时一律经 `ctx.inject` 取服务，不 import 宿主实现。
3. `scripts/guardrails/test-guardrails.sh` 为上述三类各加正反例：两包运行时 import 通过、其它宿主包运行时 import 被拒、其它宿主包 `import type` 通过。

## 权衡

- 继承 `LocalJobRegistry` 依赖其公开方法与 teardown 行为（producer `cancel` 在宿主退出时被调用），这些不是 dsh 文档承诺的扩展点。备选是只继承抽象 `JobRegistry` 从零实现（约 1000 行以上、JobId 跨重启稳定），PI 选择复用以降低代码量。
- 耦合面因此扩大到 `jobs-local` 的实现细节。缓解：里程碑边界的 `chore(dsh-upgrade)` 必须核对 `jobs-local` 与 `jobs` 包的变更；作业注册表的集成测试覆盖 teardown 路径。
- 仅类型导入不引入运行时耦合，宿主接口变化会在 typecheck 暴露，优于本地手写结构类型。

## 边界

只放宽上述两包的运行时导入与宿主包的类型导入；不允许 import dsh loop 内部（`deepseek-harness/**` 路径仍被拒），不改 `../deepseek-harness`。其它插件需要新 seam 时另立决策记录。
