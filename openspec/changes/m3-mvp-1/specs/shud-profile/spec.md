# Spec Delta

## MODIFIED Requirements

### Requirement: Profile composition
`shud` profile SHALL 由 dsh web 模板加 `@shud-harness/dsh-profile-shud` bundle 组成，路由 DMXAPI 的 deepseek-flash-guan，仅禁用 session-log-deepseek。raw-guard 以 workspace 包说明符挂载，默认 rawDirs 为 `["data/raw"]`。patch SHALL 禁用既有 jobs-local 的 jobs 行，再插入 shud-jobs、shud-tools、全局 shud-policy-gate；不得按 id 改 name，因宿主会跳过这种 patch。

profile SHALL 插入 preset-coordinator（order1）、preset-worker 两个 dsh-agent-preset 行，default 为 coordinator，子树精确按 agent-presets「Preset plugin subtrees」。coordinator tool-subagent 显式配置 agentPreset worker、toolName subagent、modelSelectionSettings false。shud-role-restrict（@shud-harness/dsh-shud-presets）SHALL 是无固定 role 配置的全局行，不进入两个 preset 子树。子代理注册表 subagent 与 subagent-spawn-in-process 各一次启用、保留宿主平面位置，不覆写 maxDepth。

headless 模板没有 agent-preset-registry；安装器 SHALL 禁用两 preset 行且不写默认 preset 设置。headless 角色 unknown 不受角色限制，但全局 policy-gate 和 shud-role-restrict 行仍可挂载；报告 ask 无审批服务时由宿主 fail-closed 拒绝。

必填 stateDir、shudBin、stackRepos.{SHUD,rSHUD,AutoSHUD}、hostVersion、llm.base_url/request_alias SHALL 由 profile:install 写入用户 patch 唯一 shud-jobs 项。bundle 的 shud-jobs 插入行 SHALL 不带 config（按 id patch 会整体替换 config）。除 session-log-deepseek 外不得禁用其它出站通道。

#### Scenario: dump-config shows the composed tree
- **WHEN** 在以 `SHUD_BIN` 执行过 `profile:install` 的 `DSH_HOME` 上执行 `dsh --profile shud --dump-config`
- **THEN** 输出含 model deepseek-flash-guan、baseURL https://www.dmxapi.cn、apiKeyEnv DMXAPI_KEY；session-log-deepseek 与旧 jobs 行禁用；raw-guard 包行及默认 data/raw；shud-jobs 包行与全部采集配置键；shud-tools、全局 shud-policy-gate、全局无 role 配置的 shud-role-restrict 包行；两个 preset 行与 default coordinator，子树按规范且没有 restrict，coordinator tool-subagent 指定 worker、worker 无 tool-subagent*；宿主 subagent/provider 各一次启用；注释含 patched by @shud-harness/dsh-profile-shud

#### Scenario: no other outbound channel disabled
- **WHEN** 对同一 dump-config 输出检查 `plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 行
- **THEN** 两行均不带 `disabled: true`

#### Scenario: plugin row is importable
- **WHEN** 执行 `dsh --profile shud --dump-config-schema`
- **THEN** shud-raw-guard、shud-tools、shud-policy-gate、shud-role-restrict 的状态为 absent 或 schema；shud-jobs 为 unsupported 且唯一诊断为 Config is not a native Schemastery schema（M2 注册表使用手写 Standard Schema）；五行均非 error，无 Cannot find module

#### Scenario: bundle carries no machine paths
- **WHEN** 检查 `profile/shud/cordis.patch.yml`
- **THEN** `- id: jobs` 行只含 `disabled: true`，插入的 `shud-jobs` 行不含 `config`（因而不含 `stateDir`、`shudBin`、`stackRepos`、`hostVersion` 与 `llm`）

### Requirement: Idempotent profile installation
系统 SHALL 提供 `pnpm run profile:install`（`scripts/runtime/profile-install.sh`）在给定 `DSH_HOME` 下建立 profile：参数 `PROFILE_NAME`（默认 `shud`）与 `PROFILE_TEMPLATE`（默认 `web`），以及必填环境变量 `SHUD_BIN`（SHUD 可执行文件的绝对路径）。`SHUD_BIN` 缺失、不是绝对路径或不可执行时 SHALL 在建档前以非 0 退出并指明 `SHUD_BIN`，SHALL NOT 回退任何默认路径。profile 目录不存在时以 `dsh --profile <name> --from-default-profile <template> --dump-config` 创建，然后把本仓库的 bundle 以 `link:` 方式安装进 profile，再由 `scripts/runtime/profile-patch.ts`（`profile-install.sh` 调用它）在用户的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写入或替换唯一一条 `- id: shud-jobs` 行（按 id 配置 bundle 插入的行，与 `shud-raw-guard` 的用户覆写同一机制），其 `config` SHALL 为注册表的完整必填配置：`shudBin: $SHUD_BIN`、`stateDir: $DSH_HOME/profiles/<name>/shud-jobs`、`stackRepos.SHUD`/`stackRepos.rSHUD`/`stackRepos.AutoSHUD` 为本仓库根下 `SHUD`、`rSHUD`、`AutoSHUD` 的绝对路径、`hostVersion` 为 bundle `package.json` 中 `@deepseek-ai/dsh` peer 的钉版版本（`0.2.1-rc.2`）、`llm.base_url` 为 bundle patch `llm-deepseek` 行的 `config.baseURL`、`llm.request_alias` 为 bundle patch `agent-default-model` 行的 `config.model`；环境变量 `SUNDIALS_ROOT` 已设置时 SHALL 写入 `sundialsRoot: $SUNDIALS_ROOT`（须为已存在目录，否则在建档前以非 0 退出并指明 `SUNDIALS_ROOT`），未设置时 SHALL NOT 写该键（StackLock 的 `runtime.sundials_version` 因而为 `null`）。这些值 SHALL 从上述来源读取，SHALL NOT 在安装器中另行硬编码。安装器整体拥有该 `shud-jobs` 行：每次安装 SHALL 以当次环境与仓库重新生成该行的完整 `config`，用户手工加入该行的键不保留。三个 `stackRepos` 路径任一不是已存在目录时 SHALL 在建档前以非 0 退出并指明该路径（目录是否为已初始化的 git 仓库在 `shud_run` 采集时检查，见 stack-lock）。建档 SHALL 先于 bundle 安装；该文件中 `- id: shud-jobs` 行之外的内容 SHALL 逐字节保留；以相同 `SHUD_BIN`、相同 `SUNDIALS_ROOT`（或同样未设置）、同一仓库根与未变的 bundle 重复执行 SHALL 不改变结果且以 0 退出；已有 `- id: shud-jobs` 行只含 `shudBin`/`stateDir`（M2 安装）时 SHALL 在同一行补齐上述键。

headless 安装另外拥有唯一 `preset-coordinator` 与 `preset-worker` 用户 patch 项的 `disabled` 字段，并将其设为 true；这两项目标内其它既有属性保留，目标范围之外字节不变。三个目标先在内存中全部验证再经同一原子发布写入，任一目标重复、共享 anchor 或无法安全更新时整个用户文件不变。web 安装不主动清除用户的 preset disabled 覆写，不承担同名 profile 的模板转换。

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

#### Scenario: headless preset overrides are idempotent and atomic
- **WHEN** headless 用户 patch 含两 preset 的既有属性、独立 raw 覆写与注释，重复安装同一配置
- **THEN** 两 preset disabled 为 true、其它属性保留、目标范围外字节不变；第二次不改字节、inode、mtime 与文件 mode

#### Scenario: unsafe headless target rejects the entire update
- **WHEN** 第二个 preset 目标重复或含被其它项引用的共享 anchor，且本次 jobs 配置也应更新
- **THEN** precheck 失败并给出受控目标诊断，用户 patch 与 profile manifest 均不变，不先提交 jobs 或第一个 preset 修改

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
