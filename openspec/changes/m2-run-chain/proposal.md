# Proposal

## Why

M2 的用户可见步骤是"一句话跑 ccw，中途重启 dsh，完成后被唤醒并拿到 RunRecord"（`docs/04_IMPLEMENTATION/Phased_Plan.md` §0 M2 行）。spike 1.3 证明 dsh 自带的 `jobs-local` 做不到：SIGTERM 杀掉 shud 且不留 `job/settled`，SIGKILL 留下孤儿，重启后所有作业 id 都是 `unknown job`（`docs/Migration_Plan_dsh.md` 1.3 行，ADR-0004 K8）。仓库里也还没有 RunJob/RunRecord 的 Zod schema（`docs/04_IMPLEMENTATION/Port_List.md` 已记录漂移）。M1 已于 2026-10-22 完成 PI 验收，M2 是下一道门。

## What Changes

- 新包 `@shud-harness/dsh-shud-jobs`：继承 dsh `LocalJobRegistry`，在 profile 中按 id 替换 `jobs` 行，成为唯一的 `ctx.jobs`。非 shud 作业行为与 `jobs-local` 一致；`kind: shud` 作业在工作区 `runs/<run_id>/` 落盘、以脱离宿主的进程运行、活过 dsh 的 SIGTERM 与 SIGKILL，启动时对账、结算时自动 collect 出 RunRecord，并至少一次唤醒发起会话。同一时刻只运行一个 SHUD，其余 FIFO 排队，队列跨重启保留。
- 新包 `@shud-harness/dsh-shud-tools`：模型工具 `shud_run`（任意输入目录，整份复制后运行，可选覆写 `END` 天数）与 `shud_collect`（幂等返回 RunRecord）。
- `@shud-harness/dsh-shud-core`：新增 RunJob/RunRecord Zod schema、品牌 id（`JOB-`/`RUN-` + UTC 时间戳 + 4 位十六进制）、退出码类别映射；`pnpm run schema:generate` 刷新 `docs/generated/`；`docs/03_SPEC/Minimal_Schemas.md` 随之修订 id 规范与 M2 状态集。
- raw-guard：识别 `shud_run` 参数——输入目录在 raw 下弹读审批卡，运行目录（会话工作目录）在 raw 下拒绝。
- profile：`jobs` 行改挂 `dsh-shud-jobs`，插入 `dsh-shud-tools`，新增必填配置 `stateDir`、`shudBin`；`profile:smoke` 断言随之更新。
- 新的本机验收脚本 `pnpm run shud:restart`：真实 ccw，SIGTERM 与 SIGKILL 各重启一次，判据取自 session log 与 run 目录；运行时不变量伴生测试进入 Verification Matrix。
- eslint seam 白名单：运行时 import 放宽到 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local`，其余宿主包只允许 `import type`（决策记录 `docs/adr/implemented/0006-dsh-jobs-seam-imports.md`）。
- 里程碑到期杂项：`scripts/schema/generate.ts` 拆到 ≤1000 行并清掉其 eslint 基线；M1→M2 边界的 `chore(dsh-upgrade)` 记录。
- 首个子 issue 为限时 spike，回答 design 的开放问题后才进入实现。
- PI 功能验收在 Epic 收口时统一进行（决策记录 `docs/adr/implemented/0007-m2-epic-acceptance.md`）。

## Capabilities

### New Capabilities

- `run-records`: RunJob 与 RunRecord 的字段契约、id 规范、M2 状态集、退出码类别、可空的跨对象引用与生成投影。
- `shud-run-jobs`: 持久化作业注册表——替换 `jobs-local`、shud 作业的生命周期与落盘、脱离宿主运行、单并发 FIFO 队列、启动对账、结算自动 collect、至少一次唤醒、重启验收脚本与 Epic 收口手工验收。
- `shud-run-tools`: 模型可调用的 `shud_run` 与 `shud_collect` 的参数、校验、输入复制与返回契约。

### Modified Capabilities

- `raw-data-guard`: 新增对 `shud_run` 参数的判定（输入在 raw 下 ask，运行目录在 raw 下 deny）。
- `shud-profile`: Profile composition 改为挂载 `dsh-shud-jobs`（替换 `jobs` 行）与 `dsh-shud-tools`，新增必填配置项。

## Impact

- 代码：新包 `packages/dsh-shud-jobs`、`packages/dsh-shud-tools`；`packages/dsh-shud-core/src/schemas/`（Critical Path #7）；`packages/dsh-shud-raw-guard/src/decide.ts`（Critical Path #1/#2）；`profile/shud/`；`scripts/runtime/`（新增 `shud-restart.sh`，改 `profile-smoke.sh`）；`scripts/schema/generate.ts` 拆分；`eslint.config.mjs` 与 `scripts/guardrails/` 闸自证。
- 作业持久化与 park-resume 属 Critical Path #4，相关 PR 需 reviewer 白盒审查。
- 文档：`docs/03_SPEC/Minimal_Schemas.md`（frozen，随本 change 修订）、`docs/generated/`、`CONTEXT.md` 不变量、`openspec/glossary.md`、`instructions/agents/*`（Verification Matrix 新增 `shud:restart`，经 `instructions:render`）、`constraints.yaml`（review_only 触发项转为 matrix、generate.ts 基线移除）、`docs/adr/proposed/` 两份决策记录。
- 依赖：新包对 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-jobs-local` 的运行时依赖随钉版 `0.2.1-rc.2`，不引入第三方新依赖。
- 运行时：SHUD 不套宿主沙箱，单用户工作台前提下由 `shud_run` 守住运行目录与 raw 边界；CI 无 SHUD 二进制，`shud:restart` 与 `shud:tiny` 一样只在本机运行。
