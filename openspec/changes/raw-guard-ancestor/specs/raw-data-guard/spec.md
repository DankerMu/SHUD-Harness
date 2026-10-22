# Spec Delta

## MODIFIED Requirements

### Requirement: Shell command touches raw
对 `bash`（含 persistent 变体，同 id）与 `pwsh`，"触及 raw" SHALL 定义为：`command` 文本包含任一 raw 目录的配置原文或其解析后绝对路径且该文本的后继字符不是路径名字符（`[A-Za-z0-9._-]`）或已到行尾，**或** `command` 文本经路径等价规范化（连续 `/` 折叠为一个、作为路径段的 `/.` 去除）后满足前一条（比较时配置原文同样做该规范化），**或** `command` 文本去掉反斜杠续行（`\` 紧跟换行）与全部 `"`、`'`、`\` 字符后（再做或不做路径等价规范化）满足第一条（引号拼接、反斜杠转义与续行在 shell 词法阶段合成 raw 名，如 `prot"ected"`、`prot\ected`），**或** 对 pwsh 语境（`pwsh` 工具，或命令文本含 `pwsh`/`powershell` 词）把 `\` 视为 `/` 后（再做上述去引号与规范化）满足第一条（PowerShell 在 Unix 上接受 `\` 作路径分隔符；bash 里 `sub\x` 是 `subx`，不做此替换），**或** 上述每份规范化后的文本再做 `..` 词法折叠（按空白、`;&|()<>`、引号与反引号切词，词内以 `/` 分段，`..` 与紧邻其前的普通段——非空、非 `.`、非 `..`——相消，可多级；不解析符号链接）后满足第一条（如 `data/x/../raw`、`data/x/y/../../raw`、`data//x/./../raw`），**或** 有效工作目录 `realpath(workdir ?? session cwd)` 位于任一 raw 目录内。raw 根所在文件系统大小写不敏感时（探测：raw 根的另一种大小写拼写——含小写字母时取全大写，否则取全小写——能被 realpath 解析回同一路径；根不存在、解析失败或根中无字母时视为敏感；每次判定重新探测，不缓存），原文与绝对路径的匹配 SHALL 不区分大小写；文件系统大小写敏感时大小写变体 SHALL NOT 视为触及（不误伤同名异例目录）。glob、brace、反引号、逗号等 shell 元字符紧随 raw 文本时 SHALL 视为触及（fail-closed）；去引号会让名字含字面反斜杠或引号的兄弟目录（如 `rm 'prot\ected'`、pwsh 的 `'prot''ected'`）也被视为触及；pwsh 语境下未换 `/` 的文本同样去 `\`（pwsh `Remove-Item sub\x` 对 `rawDirs: ["subx"]` 视为触及）；正则参数里转义的 raw 路径（如 `sed 's/data\/raw/…/'`、`grep 'data\/raw'`）同样视为触及（raw 名含 `/` 时仅去 `\` 副本命中）；命令文本任意位置出现 `pwsh`/`powershell` 词即对全文做 `\`→`/`（如 `grep -l pwsh notes; rm sub\x` 对 `rawDirs: ["sub/x"]` 视为触及）；经符号链接回溯的写法按词法折叠计（`sub/lnk/../raw` 对 `rawDirs: ["sub/raw"]` 视为触及，即使 `lnk` 指向别处）；这些都是已接受的 deny/ask 方向误报；兄弟路径（`<raw>x`、`<raw>.bak`、`<raw>_old`）SHALL NOT 视为触及。不触及 raw 时，除命中「Shell write to a raw ancestor is denied」外，SHALL 委托下一个监听器。判定只看文本与工作目录，有五处已记录的漏报（raw 位于 workspace 外时由沙箱兜底）：persistent bash 先 `cd` 进 raw 再以相对路径写入不被识别；比 raw 原文更短的 glob 前缀（如 `rm -rf protecte*`）不含原文，不被识别；glob 或 brace 出现在 raw 名字中段（如 `rm -rf p*d`、`protecte?`、`prot[e]cted`、`prot{e,}cted`、`protect{ed,}`）不含原文，不被识别（判定它需要 glob/brace 展开或分词，属 shell 语法解析）；`..` 回溯仅在经符号链接回溯（词法折叠与物理路径不一致，如 `lnk/../raw` 而 `lnk` 指向 `data/x`）、被消去的段含引号或转义的空白或 shell 元字符（如 `"data/a b/../raw"`、`data/a\ b/../raw`：折叠按空白与元字符切词，不做 shell 分词），或从工作目录向上的前导 `..`（如 workdir 为 `data/x` 时 `../raw`，含同一命令内先 `cd data/x` 再 `../raw`）时不被识别；raw 的祖先目录只在按严格边界点名第 1–3 级祖先时被识别（见「Shell write to a raw ancestor is denied」），第 4 级及更高的祖先（如默认配置下 workspace 的祖父目录）、隐式写法（`rm -rf .`、`rm -rf *`，或 workdir 位于祖先、或同一命令内先 `cd` 到祖先时以相对名写入，如 workdir 为 `data` 时 `rm -rf raw`、`cd data && rm -rf raw`）、经 `~` 或变量展开得到的祖先、紧跟在单独出现的 `cd`/`pushd`/`sl` 等词之后的祖先（切换目录剥离不判断命令位置，如 `rm -rf cd data`）、非破坏性写入对祖先内文件的覆盖（重定向、`cp`、`tar -x`、`tee`、`mkdir`），以及解释器一行程序删除祖先（如 `python -c "shutil.rmtree('data')"`）不被识别。此外 ANSI-C/locale 引号（`$'…'`、`$"…"`）与 pwsh 反引号转义不做解析，写法与上述漏报同类，不另计。

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

#### Scenario: parent traversal spelling is touching
- **WHEN** 默认配置，调用 `bash`，`command` 为 `rm -rf data/x/../raw`、`rm -rf data/x/y/../../raw` 或 `cat data//x/./../raw/f`；或配置 `rawDirs: ["sub/raw"]`，调用 `pwsh`，`command` 为 `Remove-Item sub\x\..\raw`
- **THEN** `rm`、`Remove-Item` 决策 `kind` 为 `deny`，`cat` 为 `ask`；`rm -rf data/x/../rawx`、`rm -rf data/x/../../raw` 与 `cat data/a b/../raw` 仍返回 `next()` 的结果；`rm -rf data/raw/../other` 仍为 `deny`

#### Scenario: parent traversal spelling is a documented gap
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`lnk2` 是指向 `sub/x` 的符号链接，调用 `bash`，`command` 为 `rm -rf lnk2/../raw`；或 `workdir` 为 `sub/x`，`command` 为 `rm -rf ../raw`
- **THEN** 不作判定，返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）

#### Scenario: quote and escape splitting is touching
- **WHEN** 配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `rm -rf prot"ected"`、`rm -rf prot'ected'`、`rm -rf prot\ected`、`rm -rf "prot"ected/obs.csv`、`rm -rf prot\` 接换行再接 `ected`，或 `cat prot''ected/obs.csv`
- **THEN** 前五者决策 `kind` 为 `deny`，最后一条为 `ask`；`rm "prot ected"` 仍返回 `next()` 的结果

#### Scenario: pwsh backslash separator is touching
- **WHEN** 配置 `rawDirs: ["sub/x"]`，调用 `pwsh`，`command` 为 `Remove-Item sub\x` 或 `Get-Content sub\x\obs.csv`；或调用 `bash`，`command` 为 `pwsh -c "Remove-Item sub\x"`
- **THEN** `Remove-Item` 两条决策 `kind` 为 `deny`，`Get-Content` 为 `ask`；`bash` 的 `rm sub\x`（bash 语义为 `subx`）与 `pwsh` 的 `Remove-Item sub\xy` 仍返回 `next()` 的结果

#### Scenario: mid-name glob or brace is a documented gap
- **WHEN** 配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `rm -rf p*d`、`rm -rf protecte?`、`rm -rf prot[e]cted`、`rm -rf prot{e,}cted` 或 `rm -rf protect{ed,}`
- **THEN** 不作判定，返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）

## ADDED Requirements

### Requirement: Shell write to a raw ancestor is denied
对 `bash`（含 persistent 变体）与 `pwsh`，命令不触及任何 raw 目录（见「Shell command touches raw」），但点名某个 raw 目录的严格祖先、且含**破坏性动词**时，策略门 SHALL 返回 `deny`。返回的 `code` 为 `raw-ancestor-write`，`reason` 含 `immutable`，说明命令在删除、移动或改权限一个包含 raw 的目录，应改为针对该目录下的明确路径（reason 中不写具体路径）。

破坏性动词 SHALL 为以下两组（不区分大小写，前后锚点与「Shell write under raw is denied」的 POSIX 动词相同）：
- POSIX：`rm`、`rmdir`、`unlink`、`mv`、`chmod`、`chown`、`chgrp`、`shred`、`rsync`、`-delete`、`--remove-files`、`git clean`；
- pwsh 语境下另加：`Remove-Item`、`Move-Item`、`Rename-Item`，以及别名 `del`、`erase`、`ri`、`rd`、`ren`、`rni`、`move`、`mi`。

其余写入 SHALL NOT 触发本规则，即重定向、`tee`、`cp`、`mkdir`、`touch`、heredoc、`tar -x`、解释器一行程序（PI 2026-10-21 决定）。

只有在所有 raw 目录都不被直接触及时才判定本规则：命令只要触及任一 raw，就按原有规则判定，与 rawDirs 的顺序无关。

祖先 SHALL 从三处取：配置原文（经路径等价规范化）、解析后的规范绝对路径、按 session cwd 字面拼接的绝对路径（realpath 之前）。规则如下：
- 每处向上至多 3 级，即父、祖父、曾祖父（PI 2026-10-21 决定）；
- `/` 不算祖先；
- 配置原文的祖先以 `.` 或 `..` 段结尾时不取，并停止继续向上。

"点名"SHALL 定义为：取「Shell command touches raw」用到的任一候选文本（原文、去引号副本、pwsh `\`→`/` 副本、规范化副本、`..` 折叠副本），去掉切换目录命令的操作数后，仍出现祖先文本，且前后都满足边界条件。
- 切换目录命令：`cd`、`pushd`；pwsh 另含 `Set-Location`、`sl`、`Push-Location`。不区分大小写，操作数之前的 `-` 选项一并去掉，但选项不越过 `;&|()<>`。
- 前一字符：不存在，或为空白、`;&|()<>`、引号、反引号、`=`、`:`、`,`、`{`。祖先文本前可带零或多个 `./`。
- 后一位置：行尾、空白、`;&|()<>`、引号、反引号、`,`、`{`、`}`、glob 字符（`*?[]`），或 `/` 且其后紧跟行尾、空白、上述元字符或 glob 字符。

祖先匹配的大小写规则与 raw mention 相同。

由此：
- SHALL 视为点名：`data`、`data/`、`./data`、`data/*`、`data*`、`data/{raw,x}`、`{data,x}`、`"data"`、`-Path:data`。
- SHALL NOT 视为点名：`data/derived/x`、`data.bak`、`datax`、`mydata`、`other/data`。

切换目录的操作数不算点名，所以下列命令 SHALL 委托下一个监听器：
- `cd data && rm -rf processed`；
- `cd <workspace> && python run.py > log.txt`。

`cd <workspace> && rm -rf data`、`cd -P&&rm -rf data` 因直接点名 `data`，仍为 `deny`。

点名祖先但不含破坏性动词时 SHALL 委托下一个监听器。这包括只读命令，如 `ls data`、`grep -r foo data`，以及非破坏性写入，如 `ls data > files.txt`、`mkdir -p data`、`cp out.csv data/`、heredoc 或 `python -c` 里出现单词 `data`。这些都不弹 provenance 审批卡。

含破坏性动词的命令即按上述规则判定，即使实际删的或移的是别处，例如 `mv x.csv data`、`chmod -R g+w data`。这些 deny 方向的误报已接受；改用 `data/x.csv` 这类明确路径即不再命中。

#### Scenario: deleting or moving a raw ancestor is denied
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，调用 `bash`，`command` 为以下任一：
  - `rm -rf sub`、`rm -rf sub/`、`rm -rf ./sub`、`rm -rf sub/*`、`rm -rf sub*`、`rm -rf sub/{raw,x}`、`rm -rf {sub,x}`
  - `mv sub x`、`chmod -R 000 sub`、`rmdir sub`、`find sub -delete`、`git clean -fdx sub`
  - `rm -rf sub/rawx/..`
- 或调用 `pwsh`，`command` 为 `Remove-Item -Recurse sub`、`Remove-Item -Recurse .\sub` 或 `Remove-Item -Recurse -Path:sub`
- 或默认配置下 `command` 为 `rm -rf data`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-ancestor-write`，`reason` 含 `immutable`

#### Scenario: absolute ancestors are checked up to three levels
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，workspace 的规范路径为 `W`，`command` 分别为 `rm -rf W/sub`、`rm -rf W`、`rm -rf <W 的父目录>`、`rm -rf <W 的祖父目录>`；另有一例：session cwd 是指向 `W` 的符号链接 `A`，`command` 为 `rm -rf A/sub`
- **THEN** 前三条与 `rm -rf A/sub` 决策 `kind` 为 `deny`，`rm -rf <W 的祖父目录>` 返回 `next()` 的结果

#### Scenario: configured ancestors are checked up to three levels
- **WHEN** 配置 `rawDirs: ["a/b/c/d/raw"]`，`command` 为 `rm -rf a/b/c/d`、`rm -rf a/b` 或 `rm -rf a`
- **THEN** 前两条决策 `kind` 为 `deny`，`rm -rf a` 返回 `next()` 的结果

#### Scenario: reads and non-destructive writes naming an ancestor pass through
- **WHEN** 默认配置，`command` 为以下任一：
  - `ls data`、`grep -r foo data`、`ls data > files.txt`、`mkdir -p data`、`cp out.csv data/`
  - `python -c "data = 1" > out.log`、`Rscript -e 'data <- 1'`、`echo 'load data' >> notes.md`
  - 写 `data = 1` 的 heredoc `cat > scripts/a.py <<'EOF'`
- **THEN** 返回 `next()` 的结果

#### Scenario: paths that only share a prefix with an ancestor pass through
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`command` 为 `rm -rf sub/derived`、`rm sub/rawx/y`、`rm -rf subx`、`rm -rf mysub`、`rm -rf other/sub`、`rm -rf sub.bak` 或 `rm -rf other:subx`；或配置 `rawDirs: ["../outside/raw"]`，`command` 为 `mv out.csv ..`
- **THEN** 返回 `next()` 的结果

#### Scenario: touching any raw dir keeps the raw decision
- **WHEN** 配置 `rawDirs: ["sub/raw", "protected"]` 或 `["protected", "sub/raw"]`，`command` 为 `rm -rf sub protected/x`
- **THEN** 两种顺序下决策都为 `deny`，`code` 为 `raw-immutable`

#### Scenario: a destructive verb elsewhere in an ancestor-naming command is denied
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`command` 为 `mv x.csv sub` 或 `chmod -R g+w sub`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-ancestor-write`（已接受误报）

#### Scenario: changing into an ancestor is not naming it
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，workspace 的规范路径为 `W`，`command` 为 `cd sub && rm -rf derived`、`cd W && python run.py > log.txt`；或调用 `pwsh`，`command` 为 `Set-Location sub; Remove-Item -Recurse derived`
- **THEN** 返回 `next()` 的结果；`cd W && rm -rf sub`、`cd -P&&rm -rf sub` 与 `mv abcd sub` 决策 `kind` 为 `deny`

#### Scenario: implicit ancestor writes are a documented gap
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`command` 为 `rm -rf .`、`rm -rf *`（workdir 为 workspace 根）或 `cd sub && rm -rf raw`；或 `workdir` 为 `sub` 时 `command` 为 `rm -rf raw`；或默认配置下 `command` 为 `python -c "import shutil; shutil.rmtree('data')"`
- **THEN** 返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）
