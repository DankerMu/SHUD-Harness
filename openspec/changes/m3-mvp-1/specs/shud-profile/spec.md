# Spec Delta

## MODIFIED Requirements

### Requirement: Profile composition
`shud` profile SHALL 由 dsh 的 `web` 模板加 SHUD bundle（`@shud-harness/dsh-profile-shud`）组成；该 bundle 的 patch SHALL 设置模型路由为 DMXAPI 上的 `deepseek-flash-guan`、禁用 `session-log-deepseek`，并以 workspace 包说明符插入 raw-guard 插件行 `shud-raw-guard`，其 `config.rawDirs` 默认为 `["data/raw"]`。该 patch SHALL 以 `- id: jobs` 加 `disabled: true` 禁用 Web 模板的 `jobs-local` 行，并以 `- insert:` 插入作业注册表行 `shud-jobs`（`@shud-harness/dsh-shud-jobs`）、工具行 `shud-tools`（`@shud-harness/dsh-shud-tools`）与全局治理行 `shud-policy-gate`（`@shud-harness/dsh-shud-policy-gate`，与 `shud-raw-guard` 并列、不进入任何 preset 子树）；SHALL NOT 以按 id 改 `name` 的方式替换 `jobs` 行（宿主对 `name` 不同的按 id patch 整条跳过）。该 patch SHALL 插入两个 `@deepseek-ai/dsh-agent-preset` 行 `preset-coordinator`（`order: 1`）与 `preset-worker`，并按 id 把 `agent-preset-registry` 行的 `config.default` 设为 `coordinator`。两个 preset 的 `config.plugins` 子树 SHALL 恰为 agent-presets「Preset plugin subtrees」逐行列出的行：`preset-coordinator` 含 `tool-jobs`、`tool-subagent`（`toolName: subagent`、`modelSelectionSettings: false`）与 `config.role: coordinator` 的 `shud-role-restrict` 行（`@shud-harness/dsh-shud-presets`），`preset-worker` 含 `tool-jobs` 与 `config.role: worker` 的 `shud-role-restrict` 行且没有任何委派行；子代理深度沿用 dsh `maxDepth` 设置，不在 patch 中另设。子代理注册表 `subagent` 行与 provider 行 `subagent-spawn-in-process` SHALL 保持 stock bundle 的宿主平面全局行位置，由本 patch 保持启用、各只出现一次，SHALL NOT 出现在任何 preset 子树中；K13 spike 否定 O3 时，`shud-role-restrict` 按 agent-presets「Role tool surface restriction」改为全局行，两个 preset 子树去掉该行。两个 preset 的角色工具面由 agent-presets 定义。preset 行与 `agent-preset-registry.default` 只用于 `web` 模板的 profile：`PROFILE_TEMPLATE=headless` 建立的 profile（如 `shud-probe`，headless 模板没有 `agent-preset-registry`）SHALL NOT 含启用的 `preset-coordinator`、`preset-worker` 行或对 `agent-preset-registry.default` 的设置，其会话角色为 `unknown`、不受角色工具面限制；`shud-policy-gate` 在 headless profile 中仍挂载，报告终态工具的 ask 照常生效（无审批服务时由宿主 fail-closed 拒绝）。作业注册表的必填配置 `stateDir`、`shudBin`、`stackRepos.{SHUD,rSHUD,AutoSHUD}`、`hostVersion`、`llm.base_url`、`llm.request_alias` 由部署期 `profile:install` 写入 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 的同一条 `- id: shud-jobs` 行（见「Idempotent profile installation」），bundle patch 的 `shud-jobs` 插入行 SHALL NOT 带任何 `config`：宿主的按 id patch 整体替换 `config`，bundle 提供的配置会被该用户行覆盖。除 `session-log-deepseek` 外 SHALL NOT 禁用任何其它出站通道。

#### Scenario: dump-config shows the composed tree
- **WHEN** 在以 `SHUD_BIN` 执行过 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出包含 `model: deepseek-flash-guan`、`baseURL: https://www.dmxapi.cn`、`apiKeyEnv: DMXAPI_KEY`、`id: session-log-deepseek` 紧随 `disabled: true`、`id: shud-raw-guard` 且其 `name` 为 `@shud-harness/dsh-shud-raw-guard` 且其 `config.rawDirs` 含 `data/raw`、`id: jobs` 行带 `disabled: true`、`id: shud-jobs` 且其 `name` 为 `@shud-harness/dsh-shud-jobs` 且其 `config` 含 `stateDir`、`shudBin`、`stackRepos`、`hostVersion` 与 `llm`、`id: shud-tools` 且其 `name` 为 `@shud-harness/dsh-shud-tools`、`id: shud-policy-gate` 且其 `name` 为 `@shud-harness/dsh-shud-policy-gate`、`id: preset-coordinator` 与 `id: preset-worker` 且其 `name` 均为 `@deepseek-ai/dsh-agent-preset`、`agent-preset-registry` 行的 `config.default` 为 `coordinator`，`preset-coordinator` 子树含 `tool-subagent` 与 `role: coordinator` 的 `shud-role-restrict` 且不含 `subagent-spawn-in-process`，`preset-worker` 子树含 `role: worker` 的 `shud-role-restrict` 且无任何 `tool-subagent*` 行，全局插件列表中 `id: subagent` 与 `id: subagent-spawn-in-process` 各出现一次且未被禁用，并且注释行含 `patched by @shud-harness/dsh-profile-shud`

#### Scenario: no other outbound channel disabled
- **WHEN** 对同一 dump-config 输出检查 `plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 行
- **THEN** 两行均不带 `disabled: true`

#### Scenario: plugin row is importable
- **WHEN** 执行 `dsh --profile shud --dump-config-schema`
- **THEN** `shud-raw-guard`、`shud-tools`、`shud-policy-gate` 三行的 `status` 为 `absent` 或 `schema`；`shud-jobs` 行的 `status` 为 `unsupported`，且该行唯一的诊断是 `Config is not a native Schemastery schema`（O6：注册表 `Config` 是手写 Standard Schema，宿主投影不了，`app-boot/src/config-schema/collect.ts:205-207`）；四行都不是 `error`，输出中不出现针对这些行的 `Cannot find module`

#### Scenario: bundle carries no machine paths
- **WHEN** 检查 `profile/shud/cordis.patch.yml`
- **THEN** `- id: jobs` 行只含 `disabled: true`，插入的 `shud-jobs` 行不含 `config`（因而不含 `stateDir`、`shudBin`、`stackRepos`、`hostVersion` 与 `llm`）

### Requirement: Idempotent profile installation
系统 SHALL 提供 `pnpm run profile:install`（`scripts/runtime/profile-install.sh`）在给定 `DSH_HOME` 下建立 profile：参数 `PROFILE_NAME`（默认 `shud`）与 `PROFILE_TEMPLATE`（默认 `web`），以及必填环境变量 `SHUD_BIN`（SHUD 可执行文件的绝对路径）。`SHUD_BIN` 缺失、不是绝对路径或不可执行时 SHALL 在建档前以非 0 退出并指明 `SHUD_BIN`，SHALL NOT 回退任何默认路径。profile 目录不存在时以 `dsh --profile <name> --from-default-profile <template> --dump-config` 创建，然后把本仓库的 bundle 以 `link:` 方式安装进 profile，再由 `scripts/runtime/profile-patch.ts`（`profile-install.sh` 调用它）在用户的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写入或替换唯一一条 `- id: shud-jobs` 行（按 id 配置 bundle 插入的行，与 `shud-raw-guard` 的用户覆写同一机制），其 `config` SHALL 为注册表的完整必填配置：`shudBin: $SHUD_BIN`、`stateDir: $DSH_HOME/profiles/<name>/shud-jobs`、`stackRepos.SHUD`/`stackRepos.rSHUD`/`stackRepos.AutoSHUD` 为本仓库根下 `SHUD`、`rSHUD`、`AutoSHUD` 的绝对路径、`hostVersion` 为 bundle `package.json` 中 `@deepseek-ai/dsh` peer 的钉版版本（`0.2.1-rc.2`）、`llm.base_url` 为 bundle patch `llm-deepseek` 行的 `config.baseURL`、`llm.request_alias` 为 bundle patch `agent-default-model` 行的 `config.model`；环境变量 `SUNDIALS_ROOT` 已设置时 SHALL 写入 `sundialsRoot: $SUNDIALS_ROOT`（须为已存在目录，否则在建档前以非 0 退出并指明 `SUNDIALS_ROOT`），未设置时 SHALL NOT 写该键（StackLock 的 `runtime.sundials_version` 因而为 `null`）。这些值 SHALL 从上述来源读取，SHALL NOT 在安装器中另行硬编码。安装器整体拥有该 `shud-jobs` 行：每次安装 SHALL 以当次环境与仓库重新生成该行的完整 `config`，用户手工加入该行的键不保留。三个 `stackRepos` 路径任一不是已存在目录时 SHALL 在建档前以非 0 退出并指明该路径（目录是否为已初始化的 git 仓库在 `shud_run` 采集时检查，见 stack-lock）。建档 SHALL 先于 bundle 安装；该文件中 `- id: shud-jobs` 行之外的内容 SHALL 逐字节保留；以相同 `SHUD_BIN`、相同 `SUNDIALS_ROOT`（或同样未设置）、同一仓库根与未变的 bundle 重复执行 SHALL 不改变结果且以 0 退出；已有 `- id: shud-jobs` 行只含 `shudBin`/`stateDir`（M2 安装）时 SHALL 在同一行补齐上述键。

#### Scenario: first install
- **WHEN** `DSH_HOME` 为空目录且以可执行的 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** `$DSH_HOME/profiles/shud/package.json` 的 `dsh.profile.bundles` 精确为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@shud-harness/dsh-profile-shud"]`，`profiles/shud/cordis.patch.yml` 含唯一 `- id: shud-jobs` 行且其 `shudBin` 等于 `SHUD_BIN`、`stateDir` 为 `$DSH_HOME/profiles/shud/shud-jobs`、`stackRepos.SHUD` 为 `<本仓库根>/SHUD`（另两键同理）、`hostVersion` 为 `0.2.1-rc.2`、`llm.base_url` 为 `https://www.dmxapi.cn`、`llm.request_alias` 为 `deepseek-flash-guan`，退出码 0

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
- **THEN** `$DSH_HOME/profiles/shud-probe/package.json` 的 `dsh.profile.bundles` 以 `@shud-harness/dsh-profile-shud` 结尾且不含 `@deepseek-ai/dsh-web-app`，`stateDir` 为 `$DSH_HOME/profiles/shud-probe/shud-jobs`，`dsh --profile shud-probe --dump-config-schema` 中 `shud-raw-guard`、`shud-policy-gate` 与 `shud-jobs` 行 `status` 不是 `error`，`dsh --profile shud-probe --dump-config` 中没有启用的 `preset-coordinator` 或 `preset-worker` 行

#### Scenario: M2 install gains capture configuration
- **WHEN** 用户 patch 的 `- id: shud-jobs` 行只有 M2 安装器写入的 `shudBin` 与 `stateDir`，另有 `shud-raw-guard` 覆写行，以相同 `SHUD_BIN` 执行 `pnpm run profile:install`
- **THEN** 同一 `shud-jobs` 行补齐 `stackRepos`、`hostVersion`、`llm.base_url`、`llm.request_alias`，文件中仍只有一条 `shud-jobs` 行，`shud-raw-guard` 覆写行及其它内容逐字节不变；以相同参数再执行时文件 sha256 不变

#### Scenario: SUNDIALS_ROOT controls sundialsRoot
- **WHEN** 以设置为已存在目录的 `SUNDIALS_ROOT` 执行 `pnpm run profile:install`，随后在未设置 `SUNDIALS_ROOT` 时再执行一次
- **THEN** 第一次后 `shud-jobs` 行含 `sundialsRoot` 且等于该目录；第二次后该行不含 `sundialsRoot`，其余键不变，文件中仍只有一条 `shud-jobs` 行

#### Scenario: invalid SUNDIALS_ROOT
- **WHEN** `SUNDIALS_ROOT` 指向不存在的路径时执行 `pnpm run profile:install`
- **THEN** 以非 0 退出，stderr 指明 `SUNDIALS_ROOT`，`$DSH_HOME/profiles/shud/` 未被创建或修改

#### Scenario: missing stack repository directory
- **WHEN** 本仓库根下 `AutoSHUD` 目录不存在时执行 `pnpm run profile:install`
- **THEN** 以非 0 退出，stderr 指明该路径，`$DSH_HOME/profiles/shud/` 未被创建或修改

### Requirement: Local profile smoke
`pnpm run profile:smoke` SHALL 先构建插件包（`PROFILE_SMOKE_SKIP_BUILD=1` 时跳过构建），再在临时 `DSH_HOME` 以指向临时占位可执行文件的 `SHUD_BIN` 执行 `profile:install`，再对 `dsh --profile shud` 的 dump-config 与 dump-config-schema 执行「Profile composition」的全部断言（含 `shud-policy-gate` 全局行、两个 preset 行与其子树行、默认 preset `coordinator`，以及宿主平面 `subagent` 与 `subagent-spawn-in-process` 行各一次、未禁用且不在任何 preset 子树内），断言 `shud-jobs` 行 `config` 含 `stateDir`、`shudBin`、`stackRepos.SHUD`、`stackRepos.rSHUD`、`stackRepos.AutoSHUD`、`hostVersion`、`llm.base_url`、`llm.request_alias`，且 `llm.base_url` 等于 `llm-deepseek` 行的 `baseURL`、`llm.request_alias` 等于 `agent-default-model` 行的 `model`，并断言输出中不含密钥材料（`DMXAPI_KEY=` 或 `sk-` 开头的长 token）。随后 SHALL 做一次真实启动检查：以 `shud-jobs` 行 `config` 为安装时的完整配置、仅把 `shudBin` 置空的 overlay（按 id 的 patch 整体替换 `config`，`vendor/include/src/index.ts:120-123`，故 overlay 须带上 `stateDir` 与全部采集配置键，使 `shudBin` 成为唯一缺失项）执行 `dsh --profile shud --patch <overlay> --no-open --port <p>`，断言 stderr 含 `did not activate`、`shud-jobs` 与 `shudBin`，再终止该进程。任一断言失败 SHALL 以非 0 退出并打印失败的断言名；SHALL NOT 在 dsh 缺失或版本不符时静默通过。

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

#### Scenario: llm alias drift between rows is caught
- **WHEN** `profile:install` 写入的 `shud-jobs` 行 `llm.request_alias` 与 dump-config 中 `agent-default-model` 行的 `model` 不一致时执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出 `llm.request_alias` 与 `agent-default-model` 不一致

#### Scenario: policy gate row is asserted
- **WHEN** bundle patch 删除或禁用 `shud-policy-gate` 行，或把它移进某个 preset 子树后执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出 `shud-policy-gate` 断言失败

#### Scenario: host-plane subagent rows are asserted
- **WHEN** bundle patch 禁用 `subagent-spawn-in-process`，或把它放进 `preset-coordinator` 子树后执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出宿主平面 subagent 行断言失败

#### Scenario: missing preset default is caught
- **WHEN** bundle patch 未把 `agent-preset-registry` 的 `config.default` 设为 `coordinator` 时执行 `pnpm run profile:smoke`
- **THEN** 退出码非 0，输出指出默认 preset 断言失败
