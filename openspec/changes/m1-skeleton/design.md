# Design

## Context

见 proposal.md「Why」。约束：ADR-0004 K2（只挂文档化 seam，不 import dsh loop 内部）、K9（只关 `session-log-deepseek`）、K10（TS + tsc 多包，profile 挂载各包）、K12（治理不变式）、K13（作用域）。dsh 钉 `dsh-v0.2.1-rc.2`，checkout 在 `../deepseek-harness`，只作运行宿主。spike 1.2 已验证 `tools/pre-execute` 返回 `deny`/`ask` 与 headless fail-closed、Web 审批卡往返。eng-init 控制面已落地：L3 闸、`profile:smoke`、`shud:tiny`、`test-guardrails`。

事实基线（本 change 前实测，2026-10-20）：

- `dsh --profile shud --from-default-profile web --dump-config` 建自定义 profile；`web` 模板的 bundle 集合是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`。`dsh plugin --profile shud add link:<abs>/profile/shud` 把本仓库 bundle 追加进 `dsh.profile.bundles`（不是 `dependencies`），第二次 add 输出 `Already up to date`、退出 0、`package.json` 字节不变。dump-config 显示 `patched by @shud-harness/dsh-profile-shud`。
- 不带 dump 参数的 `--from-default-profile web` 会直接启动 web app；建档必须带 `--dump-config`。`dsh plugin` 对不存在的 profile 自行初始化时只用 `['@deepseek-ai/dsh-base']`，所以建档必须先于 `plugin add`。
- 插件行解析（`--dump-config-schema` 的 `status` ∈ `schema | partial | absent | unsupported | error`；`absent` = 行合法且模块导入成功但无 `Config` 导出，`error` = 导入失败）：
  - 经 `link:` 安装的 bundle，其 patch 里的相对路径 `name:` 被解析为 `$DSH_HOME/profiles/shud/node_modules/packages/...`，`error`（Cannot find module）。
  - `--profile headless --patch <overlay>`，overlay 行用裸包名 `@shud-harness/<pkg>`：`error`——overlay 不是 layer，裸包名按 profile 目录解析，headless profile 没有这个包。
  - `--profile <x> --from-default-profile headless` 建档 + `plugin add link:` 装入声明了 `dependencies["@shud-harness/<pkg>"] = "workspace:*"` 的 bundle，再以裸包名插入（无论行在 bundle patch 还是 overlay 里）：`absent`，即可导入。
- `@deepseek-ai/dsh-tools@0.2.1-rc.2` + `@deepseek-ai/cordis@4.0.5` 作 devDependency，`skipLibCheck: true` 下引用 `ToolExecution`/`PreToolDecision`/`Context` 的插件 tsc 通过，node_modules 42MB。`dsh-tools` 的 peer（`dsh-agent`、`dsh-session`）未安装，`exec.agent` 在 TS 里退化为 `any`。
- dsh 工具 id 与参数：`write`/`edit`（`file_path`）、`str_replace_editor`（`command` ∈ view/create/str_replace/insert，`path`）、`bash` 与 `bash` persistent（`command`，可选 `workdir`——bash schema 引导模型"pass `workdir` instead of `cd`"，spike T4 里模型未经提示就带了 `workdir`；可选 `sandbox_permissions` 用于沙箱升权重试）、`pwsh`（`command`）。headless profile 注册 `tool-bash`、`tool-pwsh`、`tool-fs`。
- `PreToolDecision = {kind:'allow'} | {kind:'deny', reason, info?} | {kind:'cancel'} | {kind:'ask', reason?, displayReason?: {en, [locale]}}`。`allow` 终止瀑布；放行必须调用 `next()`。
- `ask` 的处理在 `packages/core/tools/src/index.ts` ~1739–1770：`ask.reason`/`displayReason` 原样传入 `approval.request(...)`；无 approval 服务或 headless 无 answerer 时 deny，文案 `tool "<name>" requires approval, but no approval channel is available`，session log 追加 `approval/asked{id, toolName, callId?, reason?}` 与 `approval/decided{id, outcome: 'unavailable'}`。Web 下 Allow once → `approval/decided{outcome: 'allowed-once'}` → `tool/result`。
- `tools/pre-execute` 先于 `execute` 内的沙箱升权审批（`packages/sandbox/sandbox/src/escalation.ts` `approveEscalation` 经 `approval.request`，`allowed-once` 返回更宽模式；`write`/`edit`/`bash` 共用）：插件 `deny` 在前，沙箱升权卡在后。升权卡只显示命令与模型写的理由，不标注目标是 raw。
- npm `@deepseek-ai/dsh@0.2.1-rc.2`：`pnpm add` 后 529MB，bin 为 `lib/bin.js`，无 `.git`。pnpm 10.11 安装只告警；仓库钉 `packageManager: pnpm@11.28.5`，pnpm 11 下 `pnpm add` 因依赖的 postinstall 被默认拦截以 `ERR_PNPM_IGNORED_BUILDS` 退出 1，`pnpm add --ignore-scripts` 退出 0，之后建档、`plugin add link:`、dump-config、dump-config-schema 全部正常（`.npmrc` 需 `auto-install-peers=true`）。
- headless `--json` 事件流：首行 `{"type":"session","sessionId","cwd"}`，中间 `tool_call{callId,tool,input}`、`tool_result{callId,status:'error'|…,result}`，末行 `final`。session log 为 `session.v<N>.jsonl[.zstd]`，N 是格式代际（当前 4），dsh 升级会变；Node 24 内置 `zlib.zstdDecompressSync`。

## Goals / Non-Goals

**Goals:**

- 一台装好 dsh（checkout 或 npm 布局）的机器上，一条命令建出 `shud` profile；`dsh --profile shud --dump-config` 可断言路由、出站、插件行与 `rawDirs`；`--dump-config-schema` 可断言插件行可导入。
- raw-guard 决策表是纯函数 + 单测可覆盖；插件适配薄到只做配置校验、字段提取、`next()` 委托与审计。
- 五探针可重复执行并自动判定，有离线重判模式供闸自证，升级 dsh 时作回归。
- CI 能证明 profile 可启动（dump-config + schema），不依赖本机 checkout。
- K2"不 import dsh loop 内部"从 review-only 变成 eslint 机械闸。

**Non-Goals:**

- `ctx.jobs` durable backend、`shud_run`/`shud_collect`、RunRecord（M2）。
- TaskCard、EvidenceReport、StackLock（含 llm 三字段对齐）、DataProvenance、审批接线到治理动作、agent preset（M3）。
- `wording.ts` 治理措辞常量与 policy-gate-core 体量重估（用户决定移 M3；Port_List 两行随本 change 改归 M3）。
- 自定义 Web UI / 审批卡片样式（K7）。
- raw 数据的字节保护——由 OS 沙箱（raw 在 workspace root 之外、workspace-write 模式）承担，插件只是 advisory 层。
- 关闭 K9 之外的任何出站通道。
- 把 raw 写操作做成可审批（用户决定：deny 无审批路径）。
- 追踪 persistent bash 的 `cd` 状态（文本 + `workdir` 判定之外的漏报，见 D8）。
- 导出 schemastery `Config` schema 供 dsh 校验配置（M1 在 `apply` 内校验并抛错；`@deepseek-ai/schemastery` 已发 npm，配置变复杂时再引入）。
- CI 运行 SHUD 二进制或真实 LLM 探针（无 key / 无 SUNDIALS）。

## Decisions

| # | 决策 | 备选与否决理由 | 来源 |
|---|---|---|---|
| D1 | `shud` profile = `web` 模板 + `@shud-harness/dsh-profile-shud` bundle。本机 `profile:smoke` 与 CI 都对 `shud` profile 跑 dump-config / dump-config-schema（不启动 web、不调 LLM）。探针用临时 `DSH_HOME` 下按 `headless` 模板建的 `shud-probe` profile + 同一 bundle（`link:`），不用 `--patch` 挂插件 | headless 底座违背 Web-first（K7）且无法演示审批卡；`--profile headless --patch` 挂裸包名插件行实测 `error`（事实基线），spike 能跑是因为用了相对文件路径 | 用户（底座）+ 事实核查（探针入口） |
| D2 | raw-guard 类型来自 `packages/dsh-shud-raw-guard/package.json` 的 devDependencies `@deepseek-ai/dsh-tools@0.2.1-rc.2` + `@deepseek-ai/cordis@4.0.5`，`skipLibCheck` 已在 base tsconfig。两项 devDependencies 与首个 import 它们的 `src/index.ts` 在同一 PR 加入（tasks 2.1），`decide.ts` 所在的首个 PR 不带它们 | 窄接口自定义零依赖但与 dsh 真类型漂移只能靠探针兜底；tsconfig paths 指 checkout 让 CI 无法 typecheck；devDependencies 早于 import 合入（无论放根还是放包）都会让 knip 报 unused devDependencies | 用户（devDependency）+ 工程（位置与时机） |
| D3 | 建档 = `scripts/runtime/profile-install.sh`，参数：`DSH_HOME`（必填）、`DSH_ROOT`（默认 `../deepseek-harness`）、`PROFILE_NAME`（默认 `shud`）、`PROFILE_TEMPLATE`（默认 `web`）。步骤：仅当 `$DSH_HOME/profiles/$PROFILE_NAME` 不存在时 `dsh --profile $PROFILE_NAME --from-default-profile $PROFILE_TEMPLATE --dump-config >/dev/null`；然后 `dsh plugin --profile $PROFILE_NAME add link:<abs>/profile/shud`（幂等）。绝不写用户 `cordis.patch.yml`。dsh 定位与版本校验抽到 `scripts/runtime/dsh-root.sh`（被 source）：`$DSH_ROOT/apps/cli/lib/bin.js` 存在 → checkout 布局，`git describe --tags --exact-match` 须为 `dsh-v0.2.1-rc.2`；否则 `$DSH_ROOT/lib/bin.js` 存在 → npm 布局，`$DSH_ROOT/package.json` 的 `version` 须为 `0.2.1-rc.2`；两者皆无 → 非 0 并打印两种期望路径 | 手写 `$DSH_HOME/profiles/shud` 三文件绕开 dsh 的 profile 校验；不带 `--dump-config` 会启动 web；先 `plugin add` 会建出只有 dsh-base 的 profile | 用户 + 事实核查 |
| D4 | CI job `profile-smoke`：`pnpm run build` → `$RUNNER_TEMP/dsh` 下写 `.npmrc`（`auto-install-peers=true`）并 `pnpm add --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2`（`actions/cache` 以 `dsh-0.2.1-rc.2` 为 key）→ `DSH_ROOT=$RUNNER_TEMP/dsh/node_modules/@deepseek-ai/dsh DSH_HOME=$RUNNER_TEMP/home pnpm run profile:smoke`。安装或断言失败即 job 失败，不 skip-green；进入 `all-checks-passed.needs`。无回退分支：若 CI 环境根本不可行，另开 change 修订 spec「CI profile smoke」 | 保持本机 only 使 M1 门"CI 通过"只证明单测；在 tasks 里预置"删 job"回退会让 spec 的 SHALL 无人收回，且会把可修缺陷（tag 校验、ignored builds）误判为"装不上" | 用户 + 事实核查 |
| D5 | raw 写 → `deny`（插件内无审批路径）；raw 读（bash/pwsh 触及 raw 且无写动词）→ `ask`；其余 `next()`。`deny.reason` 含 "immutable"，指向用 `read` 工具读取、派生数据写到 workspace；`ask.reason` 为固定 provenance 文案常量（探针按此归因），`displayReason` 中英双语。理由修正：pre-execute 的 deny 先于 `execute` 内的沙箱升权审批，所以"无审批路径"在 `rawDirs` 覆盖真实 raw 目录时成立；`rawDirs` 没覆盖到的 raw 路径只剩沙箱升权卡这条通用兜底（卡上不标注 raw） | 写也 `ask`：PI 在升权卡之外再多一张卡，且"批了也成功"把 K12 的"删除原始数据禁止"变成一次点击 | 用户（grill 分支⑤） |
| D6 | `config.rawDirs: string[]`，默认 `["data/raw"]`——这是开发与探针口径（workspace 内，沙箱不保护，插件是唯一防线）。部署期真实 `<data_root>/raw`（workspace 外绝对路径，Repository_Layout 不变式）由用户在 `$DSH_HOME/profiles/shud/cordis.patch.yml` 加一行 `- id: shud-raw-guard` + `config: { rawDirs: [...] }` 覆写，`profile:smoke` 断言默认值行存在。校验在 `apply`：非数组、空数组、含空串、未知键（如 `rawDir`）→ 抛错，使插件行启动失败而非静默回退；结尾 `/` 去掉。相对项以 session cwd（`exec.agent.session.header.cwd`，缺省 `process.cwd()`）解析；绝对项原样；比较用 realpath 前缀（目标或 rawDir 不存在时对最近存在祖先 realpath 再拼余段），防 symlink 与 macOS `/var → /private/var` 绕过 | 单字符串与 `<data_root>/raw` 不兼容；把部署路径写进 bundle patch 会让仓库绑定一台机器；环境变量是隐藏配置通道 | 用户（形态）+ 工程（校验/覆写） |
| D7 | 插件挂载用包说明符：bundle `dependencies["@shud-harness/dsh-shud-raw-guard"] = "workspace:*"`，patch `insert` 行 `name: '@shud-harness/dsh-shud-raw-guard'`。K10 "以文件路径挂载各包 lib/" 修正为 "以 workspace 包说明符挂载"，ADR-0004 加 revisit 记录，Repository_Layout / project-profile / Port_List 同步 | 相对路径经 `link:` 解析失败（事实基线） | 事实核查 |
| D8 | 守护的工具 id：`write`、`edit`（`file_path`）、`str_replace_editor`（`command != view` 时 `path`）、`bash`（含 persistent，同 id）、`pwsh`（`command`）。shell "触及 raw" = 命令文本包含任一 rawDir 的配置原文或其 realpath，**或** 有效工作目录 `realpath(workdir ?? session cwd)` 位于某 rawDir 内。写动词正则沿用 spike（`rm mv cp tee touch mkdir chmod chown truncate dd rsync ln`、`>`/`>>`、`sed -i`、`perl -i`、`python -c`、`open(`）并加 `install`；有写动词即 deny——包括 raw 只是源的 `cp data/raw/x work/`（已接受的 deny 方向误报，reason 指向 `read` 工具）。`sandbox_permissions` 不改变判定。persistent bash 先 `cd data/raw`（文本含 raw → ask）再 `rm obs.csv`（文本与 workdir 都不含 raw → `next()`）是已记录的漏报；raw 在 workspace 外时由沙箱兜底 | 只守 spike 三个 id 漏掉 `str_replace_editor`/persistent bash；只看文本漏掉 `workdir`；按"写目标位置"判方向需要 shell 语法解析，M1 不值 | 事实核查 + 工程 |
| D9 | 五探针 = `scripts/runtime/raw-guard-probes.sh`：前置检查 `DMXAPI_KEY` 与 dsh（缺即非 0，不跳过）；临时 `DSH_HOME`，`PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless profile-install.sh`；临时 workspace（`data/raw/obs.csv` + `../outside/raw/obs.csv`，记 md5）；对 T1–T5 以 `dsh --profile shud-probe --json "<固定提示词>"` 逐个执行并把 stdout 流、stderr、session log 复制到运行目录 `<run>/T<n>/`；判据：T1 `tool_result.status == 'error'` 且 `result` 含 `immutable`；T2 session log 有 `approval/asked{toolName:'bash', reason == provenance 常量}` 与 `approval/decided{outcome:'unavailable'}` 且无成功 `tool_result`；T3 同 T1（tool `bash`）；T4 `tool_result` 含沙箱拒绝文案且随后对同一路径的读取成功；T5 `derived` 文件存在；两份 raw md5 不变。session log 由 `--json` 首行 `sessionId` 定位，取 `session.v*.jsonl*` 代际最大者，zstd 用 Node `zlib.zstdDecompressSync`。`--judge <run-dir>` 只重判已保存运行目录（不调 LLM、不打印总绿汇总行），供 `test-guardrails` 用提交的夹具自证。失败保留 workspace 与运行目录并打印路径。负例 = 额外 `--patch <overlay>`，overlay 内容 `- id: shud-raw-guard` + `disabled: true`，不碰仓库文件 | 人工跑写 NOTES 无法回归；`--patch` 挂插件解析不到（D1）；只看 `requires approval` 文案无法归因到本插件（沙箱升权失败文案也含它） | 用户 + 事实核查 |
| D10 | 包布局：`packages/dsh-shud-raw-guard/src/decide.ts`（纯函数 `decideRawAccess(call, options): RawGuardDecision`，`kind ∈ deny | ask | next`，无 dsh import）、`src/index.ts`（`export const name`、`export function apply(ctx, config)`：校验 config（D6）、把 `ToolExecution` 当 `unknown` 经类型守卫收窄出 `name/arguments/cwd`（`exec.agent` 为 `any`，直接链式访问会触发 `no-unsafe-member-access`）、映射决策为 `PreToolDecision`（`next` → `return next()`）、`ctx.logger('shud-raw-guard')` 审计一行 `<decision> <tool> <reason-code>`（不含参数、路径、文件内容），`ctx.on('dispose')` 输出累计计数）、`src/*.test.ts`；`tsc -p tsconfig.build.json` 到 `lib/`；`package.json` `main/types/exports` 指 lib，`peerDependencies["@deepseek-ai/dsh"]="0.2.1-rc.2"`。不导出 `Config`（schema status 为 `absent`，接受） | 单文件把决策与 ctx 混在一起不可单测；`console.error` 违反 shared.md Observability 约定；按 session 计数在 Web 多 session 下无"session 结束"时机 | 工程 |
| D11 | `profile:smoke` 重写：`pnpm run build`（`PROFILE_SMOKE_SKIP_BUILD=1` 跳过，供负例）→ source `dsh-root.sh` → 临时 `DSH_HOME` 跑 `profile-install.sh` → `--profile shud --dump-config` 断言 `model: deepseek-flash-guan`、`baseURL`、`apiKeyEnv`、`session-log-deepseek` 紧随 `disabled: true`、`plugin-package-inventory-deepseek` 与 `session-telemetry-otel` 未 disabled、`id: shud-raw-guard` + `name: '@shud-harness/dsh-shud-raw-guard'` + `rawDirs` 含 `data/raw`、注释含 `patched by @shud-harness/dsh-profile-shud`、无密钥 → `--dump-config-schema` 断言 raw-guard 行 `status` 为 `absent` 或 `schema`（非 `error`）。汇总行含 dsh 版本标签、模型 id 与 `raw-guard mounted` | 现有 headless+patch 冒烟不证明 profile 存在，且 dump-config 不导入插件，裸包名解析失败会被它掩盖 | 工程 |
| D12 | eslint `no-restricted-imports`：在现有 `**/deepseek-harness/**` 之外，禁止 `@deepseek-ai/*`，白名单 `@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`；`test-guardrails` 植入 `import '@deepseek-ai/dsh-agent'` 必红、白名单必绿；`constraints.yaml` review_only 删除该项，Enforcement Index 该行 `review-only until M1` → `block` | 继续 review-only：第一个 import dsh 的插件就是 constraints 写明的触发点，不接就是假声明 | 工程（constraints.yaml 既定触发器） |
| D13 | Phased_Plan §0 M1 行改写两列：主题「骨架：profile + bundle + raw-guard 插件（包：`dsh-shud-core` 库 + `dsh-shud-raw-guard`）」（事实修正：一个插件 + 一个库，不是"两个薄插件"）；用户可见步骤「在 `dsh --profile shud` 里对话：写 raw 被拒（无审批路径），bash 读 raw 弹出 PI 审批卡」（依据 grill 分支⑤的用户决策）。验收门一列原文不动（`dsh --profile shud` 启动；raw-guard 单测 + 5 探针全绿；CI 通过）。用户可见步骤的证据 = 一次手工 Web 验收（spec「Manual Web acceptance」），登记为 Verification Matrix 的 manual 行，不写进验收门 | 保留原文「写入被拒并可审批」会让验收人逐字对照时判不下来；把手工验收写进验收门会扩大 oracle 的判定项 | 用户（grill 分支⑤）+ 事实核查 |

### Sketch seams under test

1. `decideRawAccess(call, options)`（`packages/dsh-shud-raw-guard/src/decide.ts`）——最高的纯边界，决策表全部正反例在这里：工具 id × 路径形态（相对/绝对/symlink/不存在/前缀相似如 `data/rawx`/结尾斜杠）× 写动词 × `workdir` × 多 rawDirs。理由：零 dsh 依赖、毫秒级、覆盖率主体。
2. `apply(fakeCtx, config)`——用捕获 `ctx.on('tools/pre-execute', listener)` 与 `ctx.on('dispose', ...)` 的假 ctx：验证配置校验抛错、字段提取、`next()` 恰好一次、`PreToolDecision` 形状、`ctx.logger` 审计行与计数。理由：这是与 dsh 真类型的唯一接缝，一个测试文件即可。
3. `pnpm run profile:smoke`（真实 dsh，`--dump-config` + `--dump-config-schema`）——证明 bundle 依赖、包说明符解析、patch 行形状、两种 dsh 布局。理由：D7 的事实只能在真实宿主上证明。
4. `pnpm run raw-guard:probes`（真实 dsh + 真实 LLM）与 `--judge <fixture>`（离线）——证明 seam 语义（deny 文案到模型、ask fail-closed 且归因到本插件、沙箱字节权威）与判定器本身不会假绿。理由：M1 验收门原文；本机 block。

## Risks / Trade-offs

- [`@deepseek-ai/dsh-tools` 的 .d.ts 引用未安装的 peer 类型，`exec.agent` 退化为 `any`] → 适配层把字段提取集中在一个类型守卫函数并用假 ctx 测试；探针用真宿主兜底；dsh 升级 issue 复查。
- [CI 从 npm 安装 dsh（529MB）慢或失败] → `--ignore-scripts`（dump-config 不需要 `dsh-subprocess-local` 的原生 helper）+ `actions/cache` 以版本号为 key；失败即 job 红；若环境根本不可行，另开 change 修订 spec。
- [`dsh plugin add link:` 在 profile 内调用 pnpm，受 profile 自己的 pnpm 版本（实测 v10.11.0）影响] → 脚本只依赖 `add` 幂等语义；失败输出原文。
- [bash 命令文本 + workdir 匹配有误报（任何提及 raw 路径的只读命令都 `ask`；`cp data/raw/x work/` 被 deny）与漏报（persistent `cd` 状态、变量拼接路径）] → advisory 层的已接受边界，全部写进 spec；字节权威在沙箱（raw 在 workspace 外）；`ask` 只多一次审批。
- [默认 `rawDirs` 在 workspace 内，部署没覆写时真实 raw 只剩沙箱升权卡] → spec 单列 requirement「Deployment raw directory override」，Repository_Layout 写明；M2 `shud_run` 定义 `data_root` 时复查。
- [`--from-default-profile web` 的 web 模板启用 HMR 监视 profile 文件，`link:` 下也监视仓库内 patch] → `profile:smoke` 只跑 dump-config；探针走 headless 模板；负例用 overlay，不改仓库 patch。
- [探针依赖 DMXAPI 与模型遵从提示的稳定性] → 断言放在 `--json` 工具事件与 session log 审批事件，不放模型文本；提示词写死；失败时保留 workspace 与运行目录。
- [session log 文件名代际（`v4`）随 dsh 升级变化] → glob `session.v*.jsonl*` 取最大代际。
- [K10 文字修正影响 Repository_Layout §1/§3、project-profile、Port_List] → 同 change 内改文字，ADR-0004 加 revisit 行，不改决策本体（仍是 TS 多包 + 不发 npm）。

## Migration Plan

1. 包 + 决策核 + 测试（PR 1，无 dsh 依赖）；适配层 + devDependencies + build（PR 2）；eslint seam 白名单（PR 3）。都不改 profile。
2. bundle 依赖 + patch 行；`dsh-root.sh` + `profile-install.sh`；`profile:smoke` 重写；K10 文字传播。
3. 探针脚本（live + judge）+ 负例 + 夹具 + 矩阵/constraints/AGENTS 行。
4. CI job + 控制面"CI 有 dsh"同步。
5. 文档对齐（Phased_Plan §0/§1、Port_List、Migration_Plan）+ 一次手工 Web 验收。
回滚：每步独立 PR，revert 单个 PR 即可；profile 目录在 `$DSH_HOME`，`rm -rf $DSH_HOME/profiles/shud` 即清。

## Not yet specified

- PTC 模式下 `run_code` 的内层原生工具调用是否经过同一 `tools/pre-execute`（文档称 sub-dispatch 带 `parent` 走同一 pipeline，未实测）。M2 `shud_run` 落地时验证；在那之前 raw-guard 不声明对 PTC 的覆盖。
- `ask` 决策在 Web profile 下审批卡的文案/本地化字段是否需要超出 `displayReason.{en,zh}`（spike 已见卡片显示 `displayReason`）。M3 审批接线时随 PI 批注承载问题（ADR-0004 附录 ⑫）一起定。
- 导出 schemastery `Config` 让 dsh 在 dump-config-schema 阶段校验 `rawDirs`（需要 `@deepseek-ai/schemastery` 运行时依赖并面对与 dsh 内置实例并存的问题）。配置超过一个字段时再定。
- pwsh 的写动词只覆盖 POSIX 词表（`Remove-Item` 会落到 `ask`）。本项目只在 Mac 运行，M1 只记录不覆盖。

## Open Questions

- 无需在本 change 内决定的项已归入 Not yet specified；其余决策已拍板。

## Issue #211 implementation boundary

- Governing invariant: recognized raw mutations return deny, recognized shell reads ask, and unrelated calls next; the decision core never executes a tool or grants approval.
- Must preserve: core governance/schema behavior, host checkout, raw bytes, and the documented persistent-shell/PowerShell limitations.
- Sibling surfaces: file-tool targets and shell workdir share realpath containment; shell text checks configured and canonical raw paths; multiple rawDirs are alternatives.
- Seams under test: `normalizeRawDirs` and `decideRawAccess`; malformed arguments delegate, invalid configuration throws, absent targets resolve through their nearest existing ancestor.
- Required evidence: real symlink/new-file deny versus sibling-prefix next, shell write deny versus read ask, all listed write verbs, escalation invariance, and frozen workspace install.
- Non-goals: `apply`, dsh dependencies, profile activation, OS sandbox authority, shell parsing and tracking persistent cwd. Package entry remains the planned `lib/index.js` until #212; this slice is tested through `decide.ts`.
