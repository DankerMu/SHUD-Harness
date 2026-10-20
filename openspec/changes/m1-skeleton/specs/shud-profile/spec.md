# Spec Delta

## Purpose

定义 `shud` dsh profile 的可观察组成与自检：它如何在一台机器上建立、启动后配置树里必须出现什么、部署期如何覆写 raw 目录、本机与 CI 如何机械地证明它能启动，以及 M1 收口时一次手工 Web 验收的证据形态。

## ADDED Requirements

### Requirement: Profile composition
`shud` profile SHALL 由 dsh 的 `web` 模板加 SHUD bundle（`@shud-harness/dsh-profile-shud`）组成；该 bundle 的 patch SHALL 设置模型路由为 DMXAPI 上的 `deepseek-flash-guan`、禁用 `session-log-deepseek`，并以 workspace 包说明符插入 raw-guard 插件行 `shud-raw-guard`，其 `config.rawDirs` 默认为 `["data/raw"]`。除 `session-log-deepseek` 外 SHALL NOT 禁用任何其它出站通道。

#### Scenario: dump-config shows the composed tree
- **WHEN** 在已建档的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出包含 `model: deepseek-flash-guan`、`baseURL: https://www.dmxapi.cn`、`apiKeyEnv: DMXAPI_KEY`、`id: session-log-deepseek` 紧随 `disabled: true`、`id: shud-raw-guard` 且其 `name` 为 `@shud-harness/dsh-shud-raw-guard` 且其 `config.rawDirs` 含 `data/raw`，并且注释行含 `patched by @shud-harness/dsh-profile-shud`

#### Scenario: no other outbound channel disabled
- **WHEN** 对同一 dump-config 输出检查 `plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 行
- **THEN** 两行均不带 `disabled: true`

#### Scenario: plugin row is importable
- **WHEN** 执行 `dsh --profile shud --dump-config-schema`
- **THEN** `shud-raw-guard` 行的 `status` 为 `absent` 或 `schema`（不是 `error`），输出中不出现针对该行的 `Cannot find module`

### Requirement: Idempotent profile installation
系统 SHALL 提供 `pnpm run profile:install`（`scripts/runtime/profile-install.sh`）在给定 `DSH_HOME` 下建立 profile：参数 `PROFILE_NAME`（默认 `shud`）与 `PROFILE_TEMPLATE`（默认 `web`）；profile 目录不存在时以 `dsh --profile <name> --from-default-profile <template> --dump-config` 创建，然后把本仓库的 bundle 以 `link:` 方式安装进 profile。建档 SHALL 先于 bundle 安装；重复执行 SHALL 不改变结果且以 0 退出；SHALL NOT 写入用户的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`。

#### Scenario: first install
- **WHEN** `DSH_HOME` 为空目录且执行 `pnpm run profile:install`
- **THEN** `$DSH_HOME/profiles/shud/package.json` 的 `dsh.profile.bundles` 精确为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@shud-harness/dsh-profile-shud"]`，退出码 0

#### Scenario: second install is a no-op
- **WHEN** 对同一 `DSH_HOME` 再次执行 `pnpm run profile:install`
- **THEN** 退出码 0，`profiles/shud/package.json` 与 `profiles/shud/cordis.patch.yml` 的 sha256 与第一次之后相同

#### Scenario: headless-template profile for probes
- **WHEN** `PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless` 执行 `pnpm run profile:install`
- **THEN** `$DSH_HOME/profiles/shud-probe/package.json` 的 `dsh.profile.bundles` 以 `@shud-harness/dsh-profile-shud` 结尾且不含 `@deepseek-ai/dsh-web-app`，`dsh --profile shud-probe --dump-config-schema` 中 `shud-raw-guard` 行 `status` 不是 `error`

### Requirement: dsh root resolution
`scripts/runtime/dsh-root.sh`（被 `profile-install.sh`、`profile-smoke.sh`、`raw-guard-probes.sh` source）SHALL 同时接受 dsh checkout 布局（`$DSH_ROOT/apps/cli/lib/bin.js`，git tag 须为 `dsh-v0.2.1-rc.2`）与 npm 安装布局（`$DSH_ROOT/lib/bin.js`，`package.json` version 须为 `0.2.1-rc.2`），导出二进制路径与版本标签；dsh 不可用或版本不符时 SHALL 以非 0 退出并说明。

#### Scenario: dsh missing
- **WHEN** `DSH_ROOT` 指向不含 `apps/cli/lib/bin.js` 也不含 `lib/bin.js` 的目录
- **THEN** 命令以非 0 退出，stderr 列出两种期望的二进制路径与期望版本 `dsh-v0.2.1-rc.2` / `0.2.1-rc.2`

#### Scenario: npm layout accepted
- **WHEN** `DSH_ROOT` 指向 `pnpm add @deepseek-ai/dsh@0.2.1-rc.2` 装出的 `node_modules/@deepseek-ai/dsh`
- **THEN** `profile:install` 退出 0，首次安装后的 bundles 与 checkout 布局下相同

#### Scenario: version mismatch
- **WHEN** `DSH_ROOT` 指向 `package.json` version 不是 `0.2.1-rc.2` 的 npm 布局目录
- **THEN** 以非 0 退出并打印实际与期望版本

### Requirement: Deployment raw directory override
默认 `rawDirs: ["data/raw"]` 是开发与探针口径。部署期真实 raw 目录 SHALL 由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 中以 `- id: shud-raw-guard` + `config: { rawDirs: ["<绝对路径>", ...] }` 行覆写；`profile:install` SHALL NOT 生成或改写该行；该覆写 SHALL 在 `dsh --profile shud --dump-config` 中可见。

#### Scenario: user patch overrides rawDirs
- **WHEN** 用户 patch 含 `- id: shud-raw-guard` 且 `config.rawDirs` 为 `["/srv/data_root/raw"]`，执行 `dsh --profile shud --dump-config`
- **THEN** `shud-raw-guard` 行的 `rawDirs` 为 `["/srv/data_root/raw"]`，不再含 `data/raw`

#### Scenario: install keeps the user patch
- **WHEN** 用户 patch 已含上述覆写行，再次执行 `pnpm run profile:install`
- **THEN** 该文件 sha256 不变

### Requirement: Local profile smoke
`pnpm run profile:smoke` SHALL 先构建插件包（`PROFILE_SMOKE_SKIP_BUILD=1` 时跳过构建），再在临时 `DSH_HOME` 建档，再对 `dsh --profile shud` 的 dump-config 与 dump-config-schema 执行「Profile composition」的全部断言，并断言输出中不含密钥材料（`DMXAPI_KEY=` 或 `sk-` 开头的长 token）。任一断言失败 SHALL 以非 0 退出并打印失败的断言名；SHALL NOT 在 dsh 缺失或版本不符时静默通过。

#### Scenario: all assertions pass
- **WHEN** 本机 dsh 为 `dsh-v0.2.1-rc.2`（checkout 或 npm 布局）且执行 `pnpm run profile:smoke`
- **THEN** 退出码 0，输出一行汇总含 dsh 版本标签、模型 id 与 `raw-guard mounted`

#### Scenario: plugin not built
- **WHEN** `packages/dsh-shud-raw-guard/lib/` 缺失且以 `PROFILE_SMOKE_SKIP_BUILD=1` 执行
- **THEN** dump-config-schema 断言失败（raw-guard 行 `status` 为 `error`），退出码非 0，输出指出 raw-guard 行不可导入

#### Scenario: wrong dsh version
- **WHEN** `DSH_ROOT` 指向版本不是 `0.2.1-rc.2` 的 npm 布局目录
- **THEN** 脚本在建档前以非 0 退出并打印实际与期望版本

### Requirement: CI profile smoke
CI SHALL 有一个独立 job `profile-smoke`，在无本机 dsh checkout 的环境下以 `pnpm add --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2` 安装钉版 dsh（`.npmrc` `auto-install-peers=true`，`actions/cache` 以版本号为 key），以 npm 布局的 `DSH_ROOT` 执行 `pnpm run profile:smoke`；安装或断言失败 SHALL 使 job 失败，job 结果 SHALL 进入 `all-checks-passed` 聚合。该 job SHALL NOT 需要 `DMXAPI_KEY`。

#### Scenario: PR runs the profile smoke
- **WHEN** 一个 PR 触发 CI
- **THEN** `profile-smoke` job 出现在检查列表，且 `all-checks-passed` 的 `needs` 包含它

#### Scenario: dsh install fails in CI
- **WHEN** npm 安装 `@deepseek-ai/dsh@0.2.1-rc.2` 失败
- **THEN** `profile-smoke` job 失败，`all-checks-passed` 失败；job 不以 skipped 或 success 结束

### Requirement: Manual Web acceptance
M1 收口 SHALL 在 `dsh --profile shud` 的 Web 界面做一次手工验收作为 Phased_Plan §0 M1 行"用户可见步骤"的证据，并把证据（session log 路径与事件序列摘录）记入 `docs/Migration_Plan_dsh.md`；Verification Matrix SHALL 以 `manual` 登记该项；它 SHALL NOT 被写进 §0 的验收门列。验收内容：bash 读 raw 弹出审批卡且 Allow once 后读取成功；写 raw 被拒且不出现审批卡。

#### Scenario: read raw round-trips through the approval card
- **WHEN** 在 Web 会话中要求 agent 用 bash `cat data/raw/obs.csv` 并点击 Allow once
- **THEN** session log 依次出现 `approval/asked{toolName: "bash", reason: <provenance 文案>}`、`approval/decided{outcome: "allowed-once"}`、`tool/result`（文件内容）

#### Scenario: write raw is denied without a card
- **WHEN** 在同一会话中要求 agent 用 `write` 工具改 `data/raw/obs.csv`
- **THEN** session log 出现 `tool/result` isError 且含 `immutable`，期间没有新的 `approval/asked`，文件 md5 不变
