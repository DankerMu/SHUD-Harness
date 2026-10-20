# Proposal

## Why

Phased_Plan v2 的 M1 验收门是「`dsh --profile shud` 启动；raw-guard 单测 + 5 探针全绿；CI 通过」。Phase 4 reset 后仓库只有领域层 `dsh-shud-core` 与一份只做模型路由的 bundle patch：没有可启动的 `shud` profile，spike 1.2 的 55 行 raw-guard 还是未纳入仓库的 JS，CI 也不能证明 profile 能启动。M1 把这三样补齐，是 M2（`shud_run` + durable JobRegistry）得以在真实 profile 上落地的前置。

Phased_Plan §0 M1 行的用户可见步骤原文是「raw 数据写入被拒并可审批」。grill 分支⑤由用户拍板为「写 raw → deny，无审批路径；bash/pwsh 读 raw → ask（PI 审批卡）」，本 change 据此把 §0 该行的"用户可见步骤"改写为与决策一致的文字，并把"主题"列的"两个薄插件"修正为事实（一个插件 + 一个库）；"验收门"列原文不动（见 design D13）。

## What Changes

- 新增 `packages/dsh-shud-raw-guard`：spike 插件 TypeScript 化。`tools/pre-execute` 瀑布监听器——写 raw 目录（`write`/`edit`/`str_replace_editor` 的目标路径，或 `bash`/`pwsh` 带写动词触及 raw）→ `deny`；`bash`/`pwsh` 读触及 raw → `ask`（PI 审批）；其余调用 `next()` 委托。"触及 raw" 同时看命令文本与有效工作目录（`workdir ?? session cwd`）。纯决策函数与插件适配分离；`rawDirs: string[]` 配置（相对 session cwd 或绝对路径，realpath 前缀匹配），非法配置在 `apply` 时抛错而不是静默回退。类型来自包内 devDependency `@deepseek-ai/dsh-tools` + `@deepseek-ai/cordis`。审计走 `ctx.logger`，不走 `console.error`。
- `profile/shud` bundle 增加对 `@shud-harness/dsh-shud-raw-guard` 的 workspace 依赖，`cordis.patch.yml` 以**包说明符**插入插件行并带 `config.rawDirs`。ADR-0004 K10 的"文件路径挂载"修正为"workspace 包说明符挂载"（实测：patch 相对路径经 `link:` 安装后解析到 `$DSH_HOME/profiles/shud/node_modules/packages/...`，找不到模块；而裸包名在 `--patch` overlay 下又解析不到——只有"bundle 声明依赖 + 包说明符 + `link:` 装进 profile"这一条路可导入）。
- 新增 `scripts/runtime/dsh-root.sh`（被 source：识别 dsh checkout 布局 `apps/cli/lib/bin.js` + git tag，或 npm 布局 `lib/bin.js` + `package.json` version）与 `scripts/runtime/profile-install.sh`（`PROFILE_NAME`/`PROFILE_TEMPLATE` 可参数化：`--from-default-profile <template> --dump-config` 建档 + `dsh plugin add link:<repo>/profile/shud`，幂等）。`profile:smoke` 改为「build → 临时 `DSH_HOME` 建 `shud` profile → `--dump-config` 断言路由、出站关闭、raw-guard 行与 `rawDirs` → `--dump-config-schema` 断言 raw-guard 行可导入」。
- 新增 `scripts/runtime/raw-guard-probes.sh`：临时 `DSH_HOME` 下用 headless 模板建 `shud-probe` profile 并装同一 bundle（不是 `--patch`），在临时 workspace 以 `--json` 复现 spike 五探针 T1–T5，从 `--json` 事件流与 session log 断言 deny / ask fail-closed / 沙箱拒写 / 放行与 raw 文件 md5 不变；`--judge <dir>` 模式对已保存的运行目录重判（供 `test-guardrails` 用提交的夹具自证）；负例用 `--patch` overlay 禁用插件行。本机 block；进 Verification Matrix 与 `constraints.yaml`。
- CI 新增 `profile-smoke` job：`pnpm add --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2` 装到临时目录（actions cache），建档 + dump-config/schema 断言。无回退分支——若 CI 环境根本不可行，另开 change 修订「CI profile smoke」requirement。eng-init 记录的"CI 无 dsh"缺口关闭（SHUD 仍只能本机）。
- eslint `no-restricted-imports` 增加 dsh seam 白名单（只允许 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`），`constraints.yaml` review_only 对应项转为机械闸，`test-guardrails` 加正反例。
- 文档与控制面：Phased_Plan §0 M1 行与 §1 交付文字按 D13 改写；Port_List 的 `wording.ts` 与 policy-gate-core 体量重估两行改归 M3、raw-guard/overlay 两行状态更新；Repository_Layout §1/§3 与 `openspec/project-profile.md` 的挂载/启动命令文字按包说明符与 `shud-probe` 改写；ADR-0004 加一行 K10 revisit 记录；`instructions/agents/shared.md` 的 Verification Matrix / Enforcement Index / Runtime Lifecycle / "CI 没有 dsh" 行同步后 `pnpm run instructions:render`；`profile/shud/cordis.patch.yml` 头注释去掉"挂载行随里程碑加入"的说明。
- M1 收口时做一次手工 Web 验收（审批卡往返），证据为 session log 事件序列，记入 `docs/Migration_Plan_dsh.md`。
- 不改 `dsh-shud-core` 的任何代码。

## Capabilities

### New Capabilities

- `shud-profile`: `shud` profile 的组成（web 模板 + SHUD bundle）、建档脚本、部署期 raw 目录覆写方式、配置自检（本机 `profile:smoke` 与 CI `profile-smoke`）、一次性手工 Web 验收，对外可观察的行为与断言。
- `raw-data-guard`: raw 数据策略门的决策契约（deny / ask / 委托）、配置形态与校验、覆盖的工具 id 与"触及 raw"的定义、审计可见性，以及五探针端到端验证脚本。

### Modified Capabilities

（无——`openspec/specs/` 为空，本 change 是首个 change。）

## Impact

- 代码：新包 `packages/dsh-shud-raw-guard`（src/decide.ts、src/index.ts、tests、package.json 含 devDependencies）；`profile/shud/package.json` 与 `cordis.patch.yml`；`scripts/runtime/{dsh-root.sh,profile-install.sh,profile-smoke.sh,raw-guard-probes.sh}` 与 `scripts/runtime/fixtures/raw-guard-probes/`；`scripts/guardrails/test-guardrails.sh` 新增用例；`eslint.config.mjs`；`.github/workflows/ci.yml` 新 job；根 `package.json` 新 script `profile:install`、`raw-guard:probes`。
- 依赖：`packages/dsh-shud-raw-guard/package.json` devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2`、`@deepseek-ai/cordis@4.0.5`（实测 42MB，`autoInstallPeers: false` 下 `skipLibCheck` 通过）；`profile/shud/package.json` dependencies `@shud-harness/dsh-shud-raw-guard: workspace:*`。`pnpm-lock.yaml` 变更并提交，CI `--frozen-lockfile` 通过。
- 控制面：`instructions/agents/shared.md`（Verification Matrix 两行、Enforcement Index 三行、Runtime Lifecycle 命令、第 67 行 CI 能力描述）→ 生成 `AGENTS.md`/`CLAUDE.md`；`constraints.yaml`（verification 镜像、readiness_gaps、review_only）；`knip.json` 工作区新增包。
- 文档：`docs/04_IMPLEMENTATION/{Phased_Plan,Port_List,Repository_Layout}.md`、`docs/adr/implemented/0004-dsh-kernel.md`、`openspec/project-profile.md`、`docs/Migration_Plan_dsh.md`。
- 运行时：`$DSH_HOME/profiles/shud/` 由脚本创建；部署期 raw 目录由用户 patch 覆写；`data/raw` 字节保护仍由 Seatbelt 承担（raw 位于 workspace 外时）。

## Issue #211 delivery fixture

Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: path safety and permissions)
Blast radius: incorrect deny/ask/next decisions for raw-data tool calls.
Selected risk packs: public API; config; file IO/path safety; permissions; error handling; packaging; documentation.
Evidence floor: decision scenario tests, real symlink/missing-path cases, direct Node smoke, frozen install, `pnpm run check`.
Only tasks 1.1–1.2 belong to this slice; adapter, profile, probes and CI remain subsequent issues. Keep this shared change unarchived until the entire Epic and PI acceptance are complete.
