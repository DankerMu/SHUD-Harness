# Spec Delta

## MODIFIED Requirements

### Requirement: Shell command touches raw
对 `bash`（含 persistent 变体，同 id）与 `pwsh`，"触及 raw" SHALL 定义为：`command` 文本包含任一 raw 目录的配置原文或其解析后绝对路径且该文本的后继字符不是路径名字符（`[A-Za-z0-9._-]`）或已到行尾，**或** `command` 文本经路径等价规范化（连续 `/` 折叠为一个、作为路径段的 `/.` 去除）后满足前一条，**或** 有效工作目录 `realpath(workdir ?? session cwd)` 位于任一 raw 目录内。raw 根所在文件系统大小写不敏感时（探测：raw 根的另一种大小写拼写——含小写字母时取全大写，否则取全小写——能被 realpath 解析回同一路径；根不存在、解析失败或根中无字母时视为敏感；每次判定重新探测，不缓存），原文与绝对路径的匹配 SHALL 不区分大小写；文件系统大小写敏感时大小写变体 SHALL NOT 视为触及（不误伤同名异例目录）。glob、brace、反引号、逗号等 shell 元字符紧随 raw 文本时 SHALL 视为触及（fail-closed）；兄弟路径（`<raw>x`、`<raw>.bak`、`<raw>_old`）SHALL NOT 视为触及。不触及 raw 时 SHALL 委托下一个监听器。判定只看文本与工作目录，有三处已记录的漏报（raw 位于 workspace 外时由沙箱兜底）：persistent bash 先 `cd` 进 raw 再以相对路径写入不被识别；比 raw 原文更短的 glob 前缀（如 `rm -rf protecte*`）不含原文，不被识别；`..` 回溯写法（如 `data/x/../raw`）不做解析，不被识别。

#### Scenario: absolute raw path in command
- **WHEN** 配置 `rawDirs: ["/data/raw"]`，调用 `bash`，`command` 为 `head /data/raw/obs.csv`
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: glob after raw text is touching
- **WHEN** 配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `cat protected*` 或 `cat protected?`
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: shorter glob prefix is a documented gap
- **WHEN** 配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `rm -rf protecte*`
- **THEN** 不作判定，返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）

#### Scenario: brace and backtick around raw text are touching
- **WHEN** 调用 `bash`，`command` 为 `ls {protected,derived}` 或 `` ls `echo protected` ``
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: sibling path is not touching
- **WHEN** 调用 `bash`，`command` 为 `rm protectedx/x`、`rm protected2/x`、`rm protected.bak` 或 `cat protected_old/x`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: workdir inside raw
- **WHEN** 调用 `bash`，`command` 为 `wc -l obs.csv`，`workdir` 为 `data/raw`
- **THEN** 判定为触及 raw（决策 `kind` 为 `ask`）

#### Scenario: persistent cd gap is documented
- **WHEN** 调用 `bash`，`command` 为 `cd data/raw`，随后另一次调用 `command` 为 `rm obs.csv` 且无 `workdir`
- **THEN** 第一次决策 `kind` 为 `ask`，第二次不作判定返回 `next()` 的结果

#### Scenario: unrelated command passes through
- **WHEN** 调用 `bash`，`command` 为 `echo ok > derived.txt`
- **THEN** 不作判定，返回 `next()` 的结果

#### Scenario: dot and double-slash spellings are touching
- **WHEN** 默认配置，调用 `bash`，`command` 为 `rm -rf data/./raw`、`rm -rf data//raw` 或 `cat data/./raw/x`
- **THEN** 前两者决策 `kind` 为 `deny`，后者为 `ask`；`rm data/raw-x`、`rm data/rawx/y` 仍返回 `next()` 的结果

#### Scenario: case variant on a case-insensitive filesystem is touching
- **WHEN** raw 根所在文件系统大小写不敏感（如 macOS 默认 APFS），配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `rm -rf PROTECTED`、`rm -rf Protected/x` 或 `cat Protected/x`；或默认配置下 `command` 为 `rm -rf DATA/RAW`
- **THEN** `rm` 决策 `kind` 为 `deny`，`cat` 为 `ask`

#### Scenario: case variant on a case-sensitive filesystem is a documented gap
- **WHEN** raw 根所在文件系统大小写敏感，或 raw 根尚不存在，`command` 为 `rm -rf PROTECTED`（`rawDirs: ["protected"]`）
- **THEN** 不作判定，返回 `next()` 的结果（敏感文件系统上大写拼写是另一个路径；根不存在时无法确认等价，按敏感处理）；敏感文件系统上另建同名异例目录 `PROTECTED/` 时同样返回 `next()` 的结果

#### Scenario: parent traversal spelling is a documented gap
- **WHEN** 默认配置，调用 `bash`，`command` 为 `rm -rf data/x/../raw`
- **THEN** 不作判定，返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）
