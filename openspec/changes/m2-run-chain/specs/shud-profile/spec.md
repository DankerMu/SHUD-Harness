## MODIFIED Requirements

### Requirement: Profile composition
`shud` profile SHALL 由 dsh 的 `web` 模板加 SHUD bundle（`@shud-harness/dsh-profile-shud`）组成；该 bundle 的 patch SHALL 设置模型路由为 DMXAPI 上的 `deepseek-flash-guan`、禁用 `session-log-deepseek`，并以 workspace 包说明符插入 raw-guard 插件行 `shud-raw-guard`，其 `config.rawDirs` 默认为 `["data/raw"]`。该 patch SHALL 以 `- id: jobs` 把作业注册表行改指 `@shud-harness/dsh-shud-jobs`，并插入工具行 `shud-tools`（`@shud-harness/dsh-shud-tools`）。作业注册表的必填配置 `stateDir` 与 `shudBin` 是机器相关路径，bundle patch SHALL NOT 提供它们：部署期由用户在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 的 `- id: jobs` 行配置，`profile:install` SHALL NOT 生成或改写该行；`profile:smoke` 与 `raw-guard:probes` SHALL 以 `--patch <overlay>` 提供指向临时目录与临时可执行文件的值。除 `session-log-deepseek` 外 SHALL NOT 禁用任何其它出站通道。

#### Scenario: dump-config shows the composed tree
- **WHEN** 在已建档的 `DSH_HOME` 上以提供 `stateDir` 与 `shudBin` 的 overlay 执行 `dsh --profile shud --patch <overlay> --dump-config`
- **THEN** 输出包含 `model: deepseek-flash-guan`、`baseURL: https://www.dmxapi.cn`、`apiKeyEnv: DMXAPI_KEY`、`id: session-log-deepseek` 紧随 `disabled: true`、`id: shud-raw-guard` 且其 `name` 为 `@shud-harness/dsh-shud-raw-guard` 且其 `config.rawDirs` 含 `data/raw`、`id: jobs` 且其 `name` 为 `@shud-harness/dsh-shud-jobs`、`id: shud-tools` 且其 `name` 为 `@shud-harness/dsh-shud-tools`，并且注释行含 `patched by @shud-harness/dsh-profile-shud`

#### Scenario: no other outbound channel disabled
- **WHEN** 对同一 dump-config 输出检查 `plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 行
- **THEN** 两行均不带 `disabled: true`

#### Scenario: plugin row is importable
- **WHEN** 执行 `dsh --profile shud --patch <overlay> --dump-config-schema`
- **THEN** `shud-raw-guard`、`jobs`、`shud-tools` 三行的 `status` 均为 `absent` 或 `schema`（不是 `error`），输出中不出现针对这些行的 `Cannot find module`

#### Scenario: bundle carries no machine paths
- **WHEN** 检查 `profile/shud/cordis.patch.yml`
- **THEN** `- id: jobs` 行不含 `stateDir` 与 `shudBin` 配置
