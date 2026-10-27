# shud-profile Specification

## Purpose
定义 `shud` dsh profile 的可观察组成与自检：它如何在一台机器上建立、启动后配置树里必须出现什么、部署期如何覆写 raw 目录、本机与 CI 如何机械地证明它能启动，以及 M1 收口时一次手工 Web 验收的证据形态。

## Requirements

### Requirement: Profile composition
`shud` profile SHALL 由 dsh 的 `web` 模板加 SHUD bundle（`@shud-harness/dsh-profile-shud`）组成；该 bundle 的 patch SHALL 设置模型路由为 DMXAPI 上的 `deepseek-flash-guan`、禁用 `session-log-deepseek`，并以 workspace 包说明符插入 raw-guard 插件行 `shud-raw-guard`，其 `config.rawDirs` 默认为 `["data/raw"]`。该 patch SHALL 以 `- id: jobs` 加 `disabled: true` 禁用 Web 模板的 `jobs-local` 行，并以 `- insert:` 插入作业注册表行 `shud-jobs`（`@shud-harness/dsh-shud-jobs`）与工具行 `shud-tools`（`@shud-harness/dsh-shud-tools`）；SHALL NOT 以按 id 改 `name` 的方式替换 `jobs` 行（宿主对 `name` 不同的按 id patch 整条跳过）。作业注册表的必填配置 `stateDir` 与 `shudBin` 是机器相关路径，bundle patch SHALL NOT 提供它们：部署期由 `profile:install` 写入 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 的 `- id: shud-jobs` 行（见「Idempotent profile installation」）。除 `session-log-deepseek` 外 SHALL NOT 禁用任何其它出站通道。

#### Scenario: dump-config shows the composed tree
- **WHEN** 在以 `SHUD_BIN` 执行过 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出包含 `model: deepseek-flash-guan`、`baseURL: https://www.dmxapi.cn`、`apiKeyEnv: DMXAPI_KEY`、`id: session-log-deepseek` 紧随 `disabled: true`、`id: shud-raw-guard` 且其 `name` 为 `@shud-harness/dsh-shud-raw-guard` 且其 `config.rawDirs` 含 `data/raw`、`id: jobs` 行带 `disabled: true`、`id: shud-jobs` 且其 `name` 为 `@shud-harness/dsh-shud-jobs` 且其 `config` 含 `stateDir` 与 `shudBin`、`id: shud-tools` 且其 `name` 为 `@shud-harness/dsh-shud-tools`，并且注释行含 `patched by @shud-harness/dsh-profile-shud`

#### Scenario: no other outbound channel disabled
- **WHEN** 对同一 dump-config 输出检查 `plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 行
- **THEN** 两行均不带 `disabled: true`

#### Scenario: plugin row is importable
- **WHEN** 执行 `dsh --profile shud --dump-config-schema`
- **THEN** `shud-raw-guard`、`shud-tools` 两行的 `status` 为 `absent` 或 `schema`；`shud-jobs` 行的 `status` 为 `unsupported`，且该行唯一的诊断是 `Config is not a native Schemastery schema`（O6：注册表 `Config` 是手写 Standard Schema，宿主投影不了，`app-boot/src/config-schema/collect.ts:205-207`）；三行都不是 `error`，输出中不出现针对这些行的 `Cannot find module`

#### Scenario: bundle carries no machine paths
- **WHEN** 检查 `profile/shud/cordis.patch.yml`
- **THEN** `- id: jobs` 行只含 `disabled: true`，插入的 `shud-jobs` 行不含 `stateDir` 与 `shudBin` 配置

### Requirement: Idempotent profile installation
系统 SHALL 提供 `pnpm run profile:install`（`scripts/runtime/profile-install.sh`）在给定 `DSH_HOME` 下建立 profile：参数 `PROFILE_NAME`（默认 `shud`）与 `PROFILE_TEMPLATE`（默认 `web`），以及必填环境变量 `SHUD_BIN`（SHUD 可执行文件的绝对路径）。`SHUD_BIN` 缺失、不是绝对路径或不可执行时 SHALL 在建档前以非 0 退出并指明 `SHUD_BIN`，SHALL NOT 回退任何默认路径。profile 目录不存在时以 `dsh --profile <name> --from-default-profile <template> --dump-config` 创建，然后把本仓库的 bundle 以 `link:` 方式安装进 profile，再在用户的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写入或替换唯一一条 `- id: shud-jobs` 行（按 id 配置 bundle 插入的行，与 `shud-raw-guard` 的用户覆写同一机制），其 `config` 为 `shudBin: $SHUD_BIN` 与 `stateDir: $DSH_HOME/profiles/<name>/shud-jobs`。建档 SHALL 先于 bundle 安装；该文件中 `- id: shud-jobs` 行之外的内容 SHALL 逐字节保留；以相同 `SHUD_BIN` 重复执行 SHALL 不改变结果且以 0 退出。

#### Scenario: first install
- **WHEN** `DSH_HOME` 为空目录且以可执行的 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** `$DSH_HOME/profiles/shud/package.json` 的 `dsh.profile.bundles` 精确为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@shud-harness/dsh-profile-shud"]`，`profiles/shud/cordis.patch.yml` 含 `- id: shud-jobs` 行且其 `shudBin` 等于 `SHUD_BIN`、`stateDir` 为 `$DSH_HOME/profiles/shud/shud-jobs`，退出码 0

#### Scenario: second install is a no-op
- **WHEN** 对同一 `DSH_HOME` 以相同 `SHUD_BIN` 再次执行 `pnpm run profile:install`
- **THEN** 退出码 0，`profiles/shud/package.json` 与 `profiles/shud/cordis.patch.yml` 的 sha256 与第一次之后相同

#### Scenario: missing SHUD_BIN
- **WHEN** 未设置 `SHUD_BIN` 时执行 `pnpm run profile:install`
- **THEN** 以非 0 退出，stderr 指明 `SHUD_BIN`，`$DSH_HOME/profiles/shud/` 未被创建或修改

#### Scenario: user patch lines preserved
- **WHEN** 用户 patch 已含 `- id: shud-raw-guard` 的 `rawDirs` 覆写行，再以另一个 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** 只有 `- id: shud-jobs` 行的 `shudBin` 改变，`shud-raw-guard` 覆写行逐字节不变

#### Scenario: headless-template profile for probes
- **WHEN** `PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless` 且设置 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** `$DSH_HOME/profiles/shud-probe/package.json` 的 `dsh.profile.bundles` 以 `@shud-harness/dsh-profile-shud` 结尾且不含 `@deepseek-ai/dsh-web-app`，`stateDir` 为 `$DSH_HOME/profiles/shud-probe/shud-jobs`，`dsh --profile shud-probe --dump-config-schema` 中 `shud-raw-guard` 与 `shud-jobs` 行 `status` 不是 `error`

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
默认 `rawDirs: ["data/raw"]` 是开发与探针口径。部署期真实 raw 目录 SHALL 由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 中以 `- id: shud-raw-guard` + `config: { rawDirs: ["<绝对路径>", ...] }` 行覆写；`profile:install` SHALL NOT 生成或改写该行，该行及其它非 `shud-jobs` 内容 SHALL 逐字节保留；该覆写 SHALL 在 `dsh --profile shud --dump-config` 中可见。升级已有 profile 时允许按「Idempotent profile installation」新增或更新唯一 `shud-jobs` 行；该行已为相同目标配置时，重复安装 SHALL 保持整个用户 patch 的 sha256 不变。

#### Scenario: user patch overrides rawDirs
- **WHEN** 用户 patch 含 `- id: shud-raw-guard` 且 `config.rawDirs` 为 `["/srv/data_root/raw"]`，执行 `dsh --profile shud --dump-config`
- **THEN** `shud-raw-guard` 行的 `rawDirs` 为 `["/srv/data_root/raw"]`，不再含 `data/raw`

#### Scenario: install keeps the user patch
- **WHEN** 用户 patch 已含上述 raw 覆写行及安装器按相同 `SHUD_BIN` 写入的目标 `shud-jobs` 配置，再次执行 `pnpm run profile:install`
- **THEN** 该文件 sha256 不变

#### Scenario: existing raw override migrates without byte changes
- **WHEN** 已有 profile 的用户 patch 含 raw 覆写及其它用户内容但没有 `shud-jobs` 行，以有效 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** 安装器新增唯一目标 `shud-jobs` 行，raw 覆写及其它原有内容逐字节不变；以相同参数再执行时，整个用户 patch 的 sha256 与升级后相同

### Requirement: Local profile smoke
`pnpm run profile:smoke` SHALL 先构建插件包（`PROFILE_SMOKE_SKIP_BUILD=1` 时跳过构建），再在临时 `DSH_HOME` 以指向临时占位可执行文件的 `SHUD_BIN` 执行 `profile:install`，再对 `dsh --profile shud` 的 dump-config 与 dump-config-schema 执行「Profile composition」的全部断言，并断言输出中不含密钥材料（`DMXAPI_KEY=` 或 `sk-` 开头的长 token）。随后 SHALL 做一次真实启动检查：以 `shud-jobs` 行 `config` 为安装时的 `stateDir` 加空 `shudBin` 的 overlay（按 id 的 patch 整体替换 `config`，`vendor/include/src/index.ts:120-123`，故 overlay 须带上 `stateDir`）执行 `dsh --profile shud --patch <overlay> --no-open --port <p>`，断言 stderr 含 `did not activate`、`shud-jobs` 与 `shudBin`，再终止该进程。任一断言失败 SHALL 以非 0 退出并打印失败的断言名；SHALL NOT 在 dsh 缺失或版本不符时静默通过。

#### Scenario: all assertions pass
- **WHEN** 本机 dsh 为 `dsh-v0.2.1-rc.2`（checkout 或 npm 布局）且执行 `pnpm run profile:smoke`
- **THEN** 退出码 0，输出一行汇总含 dsh 版本标签、模型 id、`raw-guard mounted` 与 `shud-jobs mounted`

#### Scenario: plugin not built
- **WHEN** `packages/dsh-shud-raw-guard/lib/` 缺失且以 `PROFILE_SMOKE_SKIP_BUILD=1` 执行
- **THEN** dump-config-schema 断言失败（raw-guard 行 `status` 为 `error`），退出码非 0，输出指出 raw-guard 行不可导入

#### Scenario: boot check catches a silent config fallback
- **WHEN** 注册表被改成 `shudBin` 为空时回退默认值，再执行 `pnpm run profile:smoke`
- **THEN** 真实启动检查断言失败，退出码非 0，输出指出 `shud-jobs` 行未报告 `shudBin`

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
