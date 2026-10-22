## MODIFIED Requirements

### Requirement: Raw directory configuration
策略门 SHALL 接受 `rawDirs: string[]` 配置，默认 `["data/raw"]`。`apply` 时 SHALL 校验配置：非数组、空数组、含空串或含未知键（如 `rawDir`）SHALL 抛错使插件行启动失败，SHALL NOT 静默回退默认值。校验通过后，每一项配置原文 SHALL 做一次词法规范化，之后的提及判定、祖先推导与路径解析都只使用规范化后的文本：连续 `/` 折叠为一个；作为路径段的 `/.` 去除；前导 `./` 去除（整串只剩 `./` 时保留 `.`）；结尾 `/` 去掉（整串只剩 `/` 时保留 `/`）。`//` 折叠 SHALL 先于前导 `./` 去除（`.//sub/raw` 规范化为 `sub/raw`，SHALL NOT 成为绝对路径）。配置侧的 `/.` 只在后接 `/` 或结尾时算路径段（命令侧规则见「Shell command touches raw」）。连续出现的 `//` 与 `/.` SHALL 全部处理（如 `./././sub/raw`、`.//.//sub/raw`、`.///sub/raw` 都规范化为 `sub/raw`）。`..` 段与 `.` 开头的名字（如 `.raw`、`. raw`）SHALL 保持原样。本规范其他 Requirement 所说的「配置原文」均指规范化后的文本。相对项 SHALL 以当前 session 的 cwd 解析（cwd 不可得时用进程 cwd）；绝对项 SHALL 原样使用。路径匹配 SHALL 基于解析后真实路径（realpath）的前缀；目标路径或 rawDir 本身不存在时以其最近存在祖先的 realpath 拼接余段，SHALL NOT 抛错；`data/rawx` 之类的同前缀名 SHALL NOT 匹配 `data/raw`。

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

#### Scenario: leading dot-slash is normalized
- **WHEN** 配置 `rawDirs: ["./sub/raw"]`、`["././sub/raw"]` 或 `["./sub/./raw"]`，调用 `bash` 且 `command` 为 `rm -rf sub/raw`、`rm -rf sub/raw/x`、`cp a sub/raw/b` 或 `echo hi > sub/raw/f`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`；`command` 为 `cat sub/raw/x` 时决策为 `ask`；`rm -rf ./sub/raw` 与绝对路径写法仍为 `deny`

#### Scenario: dot-slash configuration keeps sibling names apart
- **WHEN** 配置 `rawDirs: ["./sub/raw"]`，调用 `bash` 且 `command` 为 `rm -rf sub/rawx`、`rm -rf sub/raw.bak` 或 `rm -rf sub/raw_old`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: dot-slash configuration feeds the ancestor rule
- **WHEN** 配置 `rawDirs: ["./sub/raw"]`，调用 `bash` 且 `command` 为 `rm -rf sub`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-ancestor-write`

#### Scenario: separator folding precedes dot-slash removal
- **WHEN** 配置 `rawDirs: [".//sub/raw"]` 或 `["/data/./raw/"]`
- **THEN** 分别规范化为 `sub/raw`（相对项，以 session cwd 解析）与 `/data/raw`；`["/data/raw"]` 与 `["../outside/raw"]` 保持不变

#### Scenario: workspace-only spellings stay the workspace
- **WHEN** 配置 `rawDirs: ["./"]` 或 `["."]`
- **THEN** 两者都规范化为 `.`（整个 session cwd 为 raw），SHALL NOT 变为文件系统根 `/`；调用 `write` 且 `file_path` 为 `x.csv` 时决策为 `deny`

#### Scenario: invalid configuration fails loudly
- **WHEN** 以 `{ rawDir: ["data/raw"] }`、`{ rawDirs: [] }` 或 `{ rawDirs: [""] }` 调用 `apply`
- **THEN** `apply` 抛出含 `rawDirs` 字样的错误，不注册监听器
