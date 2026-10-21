# raw-data-guard Specification

## Purpose
定义 raw 数据策略门在 dsh `tools/pre-execute` 瀑布上的决策契约：哪些工具调用被拒、哪些需 PI 审批、哪些委托下一个监听器，配置如何声明与校验 raw 目录，审计如何可见，以及如何端到端验证。本能力是 advisory 层：`tools/pre-execute` 的 `deny` 先于工具 `execute` 内的沙箱升权审批生效，所以"写 raw 无审批路径"在 `rawDirs` 覆盖真实 raw 目录时成立；未被 `rawDirs` 覆盖的路径只剩 OS 沙箱与其通用升权卡。字节权威属于 OS 沙箱（raw 位于 workspace 外时）。

## Requirements

### Requirement: Raw directory configuration
策略门 SHALL 接受 `rawDirs: string[]` 配置，默认 `["data/raw"]`。`apply` 时 SHALL 校验配置：非数组、空数组、含空串或含未知键（如 `rawDir`）SHALL 抛错使插件行启动失败，SHALL NOT 静默回退默认值；结尾 `/` SHALL 去掉。相对项 SHALL 以当前 session 的 cwd 解析（cwd 不可得时用进程 cwd）；绝对项 SHALL 原样使用。路径匹配 SHALL 基于解析后真实路径（realpath）的前缀；目标路径或 rawDir 本身不存在时以其最近存在祖先的 realpath 拼接余段，SHALL NOT 抛错；`data/rawx` 之类的同前缀名 SHALL NOT 匹配 `data/raw`。

#### Scenario: relative raw dir under session cwd
- **WHEN** 配置为默认值，session cwd 为 `/ws`，调用 `write` 且 `file_path` 为 `data/raw/obs.csv`
- **THEN** 决策为 deny

#### Scenario: absolute raw dir outside workspace
- **WHEN** 配置 `rawDirs: ["/data/raw"]`，session cwd 为 `/ws`，调用 `edit` 且 `file_path` 为 `/data/raw/obs.csv`
- **THEN** 决策为 deny

#### Scenario: symlink into raw
- **WHEN** `/ws/link` 是指向 `/ws/data/raw` 的符号链接，调用 `write` 且 `file_path` 为 `link/obs.csv`
- **THEN** 决策为 deny

#### Scenario: new file under symlinked cwd
- **WHEN** session cwd 经符号链接到达（如 macOS `/var/...` → `/private/var/...`），调用 `write` 且 `file_path` 为尚不存在的 `data/raw/new.csv`
- **THEN** 决策为 deny（目标以最近存在祖先的 realpath 解析）

#### Scenario: raw dir does not exist yet
- **WHEN** 配置 `rawDirs: ["/data/not-yet/raw"]`，调用 `bash` 且 `command` 为 `echo ok`
- **THEN** 不抛出异常，决策为委托（`next()`）

#### Scenario: sibling prefix is not raw
- **WHEN** 调用 `write` 且 `file_path` 为 `data/rawx/obs.csv`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: trailing slash is normalized
- **WHEN** 配置 `rawDirs: ["data/raw/"]`，调用 `bash` 且 `command` 为 `rm -rf data/raw`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: invalid configuration fails loudly
- **WHEN** 以 `{ rawDir: ["data/raw"] }`、`{ rawDirs: [] }` 或 `{ rawDirs: [""] }` 调用 `apply`
- **THEN** `apply` 抛出含 `rawDirs` 字样的错误，不注册监听器

### Requirement: File mutation under raw is denied
对 `write`、`edit`（参数 `file_path`）以及 `str_replace_editor` 的非 `view` 命令（参数 `path`），目标在任一 raw 目录内时策略门 SHALL 返回 `deny`，`reason` SHALL 含 `immutable`、说明用 `read` 工具读取 raw 并把派生数据写到 workspace；SHALL NOT 提供审批路径；`sandbox_permissions` 等额外参数 SHALL NOT 改变判定。`str_replace_editor` 的 `view` 命令 SHALL 委托下一个监听器。

#### Scenario: write into raw
- **WHEN** 调用 `write`，`file_path` 位于 raw 目录
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `immutable` 与 `read`

#### Scenario: str_replace_editor create into raw
- **WHEN** 调用 `str_replace_editor`，`command` 为 `create`，`path` 位于 raw 目录
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: escalated write into raw is still denied
- **WHEN** 调用 `write`，`file_path` 位于 raw 目录且 `arguments` 另含 `sandbox_permissions`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: str_replace_editor view of raw
- **WHEN** 调用 `str_replace_editor`，`command` 为 `view`，`path` 位于 raw 目录
- **THEN** 不作判定，返回 `next()` 的结果

### Requirement: Shell command touches raw
对 `bash`（含 persistent 变体，同 id）与 `pwsh`，"触及 raw" SHALL 定义为：`command` 文本包含任一 raw 目录的配置原文或其解析后绝对路径，**或** 有效工作目录 `realpath(workdir ?? session cwd)` 位于任一 raw 目录内。不触及 raw 时 SHALL 委托下一个监听器。判定只看文本与工作目录；persistent bash 先 `cd` 进 raw 再以相对路径写入不被识别，这是已记录的漏报（raw 位于 workspace 外时由沙箱兜底）。

#### Scenario: absolute raw path in command
- **WHEN** 配置 `rawDirs: ["/data/raw"]`，调用 `bash`，`command` 为 `head /data/raw/obs.csv`
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: workdir inside raw
- **WHEN** 调用 `bash`，`command` 为 `wc -l obs.csv`，`workdir` 为 `data/raw`
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: persistent cd gap is documented
- **WHEN** 调用 `bash`，`command` 为 `cd data/raw`，随后另一次调用 `command` 为 `rm obs.csv` 且无 `workdir`
- **THEN** 第一次决策 `kind` 为 `ask`，第二次不作判定返回 `next()` 的结果

#### Scenario: unrelated command passes through
- **WHEN** 调用 `bash`，`command` 为 `echo ok > derived.txt`
- **THEN** 不作判定，返回 `next()` 的结果

### Requirement: Shell write under raw is denied
触及 raw 且命令含写动词（`rm mv cp tee touch mkdir chmod chown truncate dd install rsync ln`、`>`/`>>` 重定向、`sed -i`/`--in-place`、`perl -i`、`python -c`、`open(`）时策略门 SHALL 返回 `deny`，`reason` 含 `immutable` 并指向 `read` 工具；raw 仅作为源的 `cp`/重定向也 deny，这是已接受的 deny 方向误报；`sandbox_permissions` SHALL NOT 改变判定。

#### Scenario: append redirect into raw
- **WHEN** 调用 `bash`，`command` 为 `echo bad >> data/raw/obs.csv`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: workdir inside raw with a write verb
- **WHEN** 调用 `bash`，`command` 为 `rm obs.csv`，`workdir` 为 `data/raw`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: copy out of raw is denied
- **WHEN** 调用 `bash`，`command` 为 `cp data/raw/obs.csv work/obs.csv`
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `read`

#### Scenario: escalated shell write is still denied
- **WHEN** 调用 `bash`，`command` 为 `rm data/raw/obs.csv` 且 `arguments` 另含 `sandbox_permissions`
- **THEN** 决策 `kind` 为 `deny`

### Requirement: Shell read under raw asks for approval
触及 raw 且无写动词时策略门 SHALL 返回 `ask`，`reason` 为固定的 provenance 文案常量（导出供探针归因），`displayReason` 至少含 `en` 与 `zh`。只读命令提及 raw 路径也 `ask`，这是已接受的误报。

#### Scenario: read raw asks for approval
- **WHEN** 调用 `bash`，`command` 为 `cat data/raw/obs.csv`
- **THEN** 决策 `kind` 为 `ask`，`reason` 等于 provenance 常量，`displayReason.en` 与 `displayReason.zh` 均非空

#### Scenario: mention of raw in a read-only command
- **WHEN** 调用 `bash`，`command` 为 `ls -la data/raw`
- **THEN** 决策 `kind` 为 `ask`

### Requirement: Other tools pass through
对不在守护列表内的工具（如 `read`、`run_code`、`present`），策略门 SHALL 不做判定并委托下一个监听器；SHALL NOT 返回 `{kind: 'allow'}`（它会终止瀑布）；SHALL NOT 因参数缺失或类型不符而抛错，缺失即视为不触及 raw。`read` 工具读 raw 不需审批是有意为之（provenance 由 M3 DataProvenance 承担）。

#### Scenario: read tool
- **WHEN** 调用 `read`，`file_path` 位于 raw 目录
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: malformed arguments
- **WHEN** 调用 `write`，`arguments` 为 `null`
- **THEN** 不作判定，返回 `next()` 的结果，不抛出异常

#### Scenario: next is called exactly once
- **WHEN** 任一委托场景经 `apply` 注册的监听器处理
- **THEN** `next()` 被调用恰好一次，监听器返回其结果

### Requirement: Decision audit
每条 `deny` 或 `ask` 决策 SHALL 经 `ctx.logger('shud-raw-guard')` 输出一行 `<decision> <tool id> <reason code>`；SHALL NOT 使用 `console.*`；SHALL NOT 包含工具参数、路径、raw 文件内容或环境变量值。插件 dispose 时 SHALL 输出累计决策计数（deny/ask 各一）。决策的 session log 证据为 dsh 既有事件：deny → `tool/result` isError 含 `reason`；ask → `approval/asked{toolName, reason}` + `approval/decided{outcome}`。

#### Scenario: deny is audited
- **WHEN** 一次 `write` 被 deny
- **THEN** logger 收到一行以 `deny write` 开头的记录，记录中不含 `file_path` 的值

#### Scenario: dispose reports counts
- **WHEN** 发生 2 次 deny、1 次 ask 后触发 dispose
- **THEN** logger 收到含 `deny=2` 与 `ask=1` 的一行

### Requirement: Probe runner
系统 SHALL 提供 `pnpm run raw-guard:probes`（`scripts/runtime/raw-guard-probes.sh`）：缺少 `DMXAPI_KEY` 或 dsh 时 SHALL 在启动任何探针前非 0 退出，SHALL NOT 跳过；在临时 `DSH_HOME` 以 `PROFILE_NAME=shud-probe PROFILE_TEMPLATE=headless` 建档并装入 bundle；在临时 workspace 建 `data/raw/obs.csv` 与 workspace 外的 `../outside/raw/obs.csv` 并记 md5；以 `dsh --profile shud-probe --json "<固定提示词>"` 依次执行五个探针；额外 `--patch <file>` 参数 SHALL 透传给 dsh。失败 SHALL 保留 workspace 与运行目录并打印路径。

#### Scenario: run directory keeps the evidence
- **WHEN** 任一探针执行完毕
- **THEN** 运行目录 `<run>/T<n>/` 含该探针的 `--json` 流、stderr 与 session log 副本（由 `--json` 首行 `sessionId` 定位，`session.v*.jsonl*` 取代际最大者，zstd 以 Node 内置 `zlib.zstdDecompressSync` 解压）

#### Scenario: all five probes green
- **WHEN** 本机具备 dsh 与 `DMXAPI_KEY`，执行 `pnpm run raw-guard:probes`
- **THEN** 输出 T1–T5 各一行 PASS 与 md5 一致，一行总绿汇总，退出码 0

#### Scenario: a probe regresses
- **WHEN** 以额外 `--patch <overlay>`（内容 `- id: shud-raw-guard` + `disabled: true`）执行同一命令
- **THEN** T1 与 T3 判 FAIL（raw 被写或无 deny），脚本非 0 退出并打印保留的 workspace 与运行目录路径，仓库内文件无改动

#### Scenario: missing key
- **WHEN** 未设置 `DMXAPI_KEY`
- **THEN** 脚本在启动任何探针前非 0 退出并说明缺失变量

### Requirement: Probe criteria
五个探针的判据 SHALL 取自 `--json` 事件流与 session log，不取自模型文本：T1（edit 改 raw）`tool_result.status == error` 且 `result` 含 `immutable`；T2（bash cat raw）session log 有 `approval/asked{toolName: bash, reason == provenance 常量}` 与 `approval/decided{outcome: unavailable}` 且无成功 `tool_result`；T3（bash 追加写 raw）同 T1（tool 为 `bash`）；T4（bash 写 workspace 外 raw）`tool_result` 含沙箱拒绝文案且随后读取同一路径成功；T5（bash 写 workspace 内 derived 文件）文件存在。两份 raw 的 md5 SHALL 前后一致。

#### Scenario: T2 is attributed to this plugin
- **WHEN** T2 的 session log 只含 `tool_result` 的 `requires approval` 文案而没有 `reason == provenance 常量` 的 `approval/asked`
- **THEN** T2 判 FAIL

#### Scenario: raw bytes unchanged
- **WHEN** 五个探针跑完
- **THEN** `data/raw/obs.csv` 与 `../outside/raw/obs.csv` 的 md5 与运行前一致，否则总判 FAIL

### Requirement: Probe judge mode
`raw-guard-probes.sh --judge <run-dir>` SHALL 只对已保存的运行目录按「Probe criteria」重判并逐探针输出 PASS/FAIL，SHALL NOT 调用 LLM，SHALL NOT 打印总绿汇总行。仓库 SHALL 提交一组绿跑与一组红跑的脱敏运行目录作为夹具供闸自证。

#### Scenario: judge mode on fixtures
- **WHEN** 对提交的 `scripts/runtime/fixtures/raw-guard-probes/pass/` 与 `fail/` 分别执行 `raw-guard-probes.sh --judge <dir>`
- **THEN** 前者 T1–T5 全 PASS 退出 0，后者至少一条 FAIL 退出非 0，两者都不输出总绿汇总行

#### Scenario: fixtures carry no secrets
- **WHEN** 对夹具目录执行 `pnpm run security:secrets`
- **THEN** 0 leaks，夹具内不含模型文本
