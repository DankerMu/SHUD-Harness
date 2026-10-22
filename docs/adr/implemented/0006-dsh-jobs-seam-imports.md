---
status: accepted
kind: architecture
---

# ADR-0006: 放宽 dsh seam 导入白名单以实现持久化作业注册表

## 背景

ADR-0004 K2 规定插件只经文档化 seam 接入宿主，`eslint.config.mjs` 据此只允许 import `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`。M2 的持久化作业注册表必须替换 Web 模板的 `jobs-local` 行（ADR-0004 K8）：dsh 只允许一个 `ctx.jobs` 实现，替换者必须继承 `@deepseek-ai/dsh-jobs` 的 `JobRegistry` 契约。PI 在 M2 压测（OpenSpec change `m2-run-chain`，Stage 1 grill）中选定继承 `@deepseek-ai/dsh-jobs-local` 的 `LocalJobRegistry`，复用其约 700 行作用域与事件实现。重启后的唤醒需要 `sessionController`、`sessions` 与 Agent 的类型，并要构造一条用户消息投递给发起会话；注册表测试需要复现 Web 模板中 `tool-jobs` 只在 preset 作用域内挂载的形态。

## 决策

1. 运行时 import 白名单增加 `@deepseek-ai/dsh-jobs`（抽象契约与类型）与 `@deepseek-ai/dsh-jobs-local`（`LocalJobRegistry` 父类）。
2. 运行时 import 白名单增加 `@deepseek-ai/dsh-llm`，但只允许具名导入 `createUserMessage`（构造唤醒消息；宿主先例 `deepseek-harness/packages/schedule/schedule/src/runtime.ts:2`、`:119`）；该包的类型（含为 `shud-jobs` 消息来源扩充 `MessageSourceMap`）照常 `import type`。
3. 测试文件额外允许运行时 import `@deepseek-ai/dsh-scope` 的 `createScope`（`deepseek-harness/packages/core/scope/src/index.ts:137`），用于在测试中构造 preset 式作用域。eslint 以两个 glob 限定：`**/*.test.ts` 与 `**/test-harness.ts`；跨测试共享的作用域装配只能放在名为 `test-harness.ts` 的文件中。`test-harness.ts` 由所在包 `tsconfig.json` 的 `exclude` 排除出构建产物，经测试文件引用而对 knip 可达，计入 vitest 覆盖率（`vitest.config.ts` 不改）。其它文件（生产代码）仍禁止运行时 import 该包。
4. 其余宿主包只允许 `import type`，用于 `ctx.inject` 取得的服务（`sessionController`、`sessions`、Agent 等）的静态类型（如 `import type {} from '@deepseek-ai/dsh-api-session-controller'`）；运行时一律经 `ctx.inject` 取服务（含可选服务的回调形式 `ctx.inject([...], 回调)`，见 OpenSpec change `m2-run-chain` design D7），不 import 宿主实现。
5. `scripts/guardrails/test-guardrails.sh` 为上述各类加正反例：`dsh-jobs`/`dsh-jobs-local` 运行时 import 通过；`dsh-llm` 的 `createUserMessage` 通过、该包其它具名运行时导入被拒；`*.test.ts` 与 `test-harness.ts` 中运行时 import `dsh-scope` 的 `createScope` 通过、其它非测试文件（如 `harness.ts`）中同样的导入被拒；其它宿主包运行时 import 被拒（含测试文件中的 `dsh-agent-loop-testkit`）；其它宿主包 `import type` 通过。

## 权衡

- 继承 `LocalJobRegistry` 依赖其公开方法与 teardown 行为（producer `cancel` 在宿主退出时被调用），这些不是 dsh 文档承诺的扩展点。备选是只继承抽象 `JobRegistry` 从零实现（JobId 跨重启稳定，但需重写作用域与事件契约），PI 选择复用以降低代码量。
- 注册表还依赖两处实现细节：`attachController` 把控制器挂到**调用方上下文**的作用域层（无作用域上下文即全局层），以及控制器只在 `start` 的准入检查（`servesOwner`）中被读取。shud 作业以无 owner 登记，只能由全局控制器放行，注册表据此用构造时捕获的自身上下文瞬时挂载、登记后立即释放（design D1）。任一细节变化都会让 shud 登记失败或改变非 shud 作业的准入。
- 缓解：里程碑边界的 `chore(dsh-upgrade)` 必须核对 `jobs-local`、`jobs`、`dsh-llm` 与 `dsh-scope` 的变更；作业注册表的集成测试覆盖 teardown 路径、只有 preset 作用域控制器时的登记，以及释放后无残留全局控制器。
- `dsh-llm` 只放行一个无状态构造函数，`dsh-scope` 只在测试中放行；二者都比本地手写消息结构或伪造作用域更贴近宿主真实行为。
- 仅类型导入不引入运行时耦合，宿主接口变化会在 typecheck 暴露，优于本地手写结构类型。

## 边界

只放宽上述运行时导入（`dsh-jobs`、`dsh-jobs-local`、`dsh-llm` 的 `createUserMessage`、测试文件中 `dsh-scope` 的 `createScope`）与宿主包的类型导入；不允许 import dsh loop 内部（`deepseek-harness/**` 路径仍被拒），不改 `../deepseek-harness`。其它插件需要新 seam 时另立决策记录。
