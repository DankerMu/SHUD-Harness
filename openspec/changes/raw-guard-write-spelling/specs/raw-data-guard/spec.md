## MODIFIED Requirements

### Requirement: Shell write under raw is denied
触及 raw 且命令含写动词时策略门 SHALL 返回 `deny`，`reason` 含 `immutable` 并指向 `read` 工具。写动词 SHALL 包括：POSIX 动词 `rm mv cp tee touch mkdir chmod chown chgrp truncate dd install rsync ln unlink rmdir shred gzip gunzip bzip2 xz unzip`（不区分大小写；动词前允许任意路径前缀、反斜杠转义、引号或 `sudo` 等前导词，即动词前一个字符不是 `[A-Za-z0-9_.-]` 即可——`.` 排除使 `x.xz`、`x.dd` 这类文件名后缀不算动词；动词后为行尾或 `[\s;&|)}'"`]` 之一，因此管道末尾、子 shell、`sh -c '…'` 引号内、pwsh 脚本块 `{… | del}` 内的动词也算）；工具形态 `git clean|checkout|restore`、`tar -x…`、`sort -o`、`awk -i`、`sed -i`/`--in-place`、`perl -i`/`-e`、`python -c`、`Rscript -e`/`--expr`、`node -e`/`--eval`、以 heredoc 喂入的解释器（`python|Rscript|node|perl - <<`）——这一组工具名前同样要求非路径名字符，以排除 `a.tar -X` 这类文件名碰撞；GNU 前缀变体 `gsed -i`、`gawk -i`、`gtar -x` 与 `ipython -c` 视同原工具（`gsed -i <raw>/x` 必须 deny；heredoc 形态不含 `i?` 前缀，`ipython - <<` 落 `ask`）；`>`/`>>` 重定向；文件形态的 `>&word`/`N>&word`（bash 的 word 只在空格、制表、换行与元字符 `;&|()<>` 处断开，引号与 `}` 不断开；纯数字、纯数字加 `-` 或单个 `-` 且其后紧接行尾、空格、制表、换行或 `;&|()<>` 时是 fd 复制、移动或关闭，如 `2>&1`、`>&2`、`>& 2`、`2>&1-`、`1>&-`、`2>&1)`、`$(… 2>&1)`，不算写；其他 `word` 都按文件处理（等价于 `&>word`），如 `>&2x`、`>&2:x`、`>&2$x`、`>&2"x"`、`>&2" "`、`>&2}`；fd 号后紧跟引号或反引号时同样按文件处理，因此 `sh -c '… >&2'`、`bash -c "… 2>&1"`、`` `… 2>&1` `` 这类引号包裹的读命令判 deny，属 deny 方向误报；引号内文本中的 `>&`（如 `grep '>&x' <raw>/log`）同样按写处理，属 deny 方向误报；`word` 为 `$` 变量等运行时才知道的值时按写处理，属 deny 方向误报）；读写重定向 `<>word`/`N<>word`（以读写方式打开，不存在则新建，可原地覆写；命令文本中其他位置的 `<>`，如 SQL 不等号，同样按写处理，属 deny 方向误报）（目标为 `/dev/null` 的丢弃型重定向 `>`、`>>`、`N>`、`N>>`、`&>`、`&>>`、`>&`、`N>&`、`<>`、`N<>` 除外：它们不写任何文件，判定时先剥除（只剥 `&`/`>`/`<` 起的部分，不吞前导 fd 数字：`bzip2>/dev/null <raw>/x` 中的 `bzip2` 仍是写动词）再看其余写动词与重定向；`/dev/nullx`、`/dev/null/x` 不是 `/dev/null`，不剥除）；`open(`；破坏性标志 `-delete`、`--remove-files`（前导为行首或空白，后继与动词相同）；pwsh cmdlet `Remove-Item Move-Item Copy-Item Rename-Item New-Item Set-Content Add-Content Clear-Content Clear-Item Out-File` 与别名 `del erase ri rd ren rni move mi copy cpi ni clc cli`（不区分大小写；仅对 `pwsh` 工具、或 `bash` 命令文本含 `pwsh`/`powershell` 词时生效——这些别名在 bash 里不是命令，`grep -r move <raw>` 必须仍是 `ask`）。该清单是启发式 denylist 而非穷举：不在清单内的写法落 `ask`（仍经 PI 审批），raw 在 workspace 外时由沙箱兜底。raw 仅作为源的 `cp`/重定向（指写到真实文件的重定向，如 `cat <raw>/x | sort > out.txt`）也 deny，这是已接受的 deny 方向误报；`sandbox_permissions` SHALL NOT 改变判定。

写动词、工具形态与重定向 SHALL 同时对原文和去引号副本判定，任一命中即为写；去引号副本与「Shell command touches raw」相同，即去掉反斜杠续行（`\` 紧跟换行）与全部 `"`、`'`、`\` 字符。因此动词中段被引号或转义拆开的写法同样 deny，如 `r"m"`、`r'm'`、`r\m`、`m"v"`、`c\p`、`r\` 接换行再接 `m`。pwsh 写动词仍只对原文判定。

tar 解包 SHALL 按以下规则判为写：在 `tar` 或 `gtar`（命令名与 POSIX 动词同样不区分大小写，前一个字符不是路径名字符，判定同样作用于去引号副本）之后、同一命令段内（命令段在 `;`、`|`、换行处结束，在 `&` 处也结束，但重定向 `>&`、`<&` 中的 `&` 除外（`&>word` 本身已按写重定向或丢弃重定向处理）），任意位置出现短选项簇含小写 `x`（`-xf`、`-zxf`、`-C <raw> -xf`、`-f a.tar -x`）、`--extract`、`--get` 或它们的缩写（`--ext`、`--ge`）；或 `tar` 之后的第一个词是不带 `-` 的旧式选项簇且含小写 `x`（`tar xf`、`tar zxf`）。`x` 区分大小写，`-X`（`--exclude-from`）不是解包；`-C <raw>` 本身不是写（`tar -cf o.tar -C <raw> .` 只读 raw）。判定 SHALL 与命令长度成线性关系。引号内出现的 `;`、`|`、`&` 同样结束命令段，因此其后的解包选项不被识别（已记录漏报，如 `tar -C <raw> --exclude="a|b" -xf a.tar` 落 `ask`）。

以下 deny 方向误报已接受：读命令的引号或转义文本拼出写动词，如 `grep 'r''m' <raw>/log`、`grep "c\p" <raw>/log`；短选项与参数连写时参数里的 `x`，如 `tar -tvf <raw>/a.tar -Xexcl`；`tar` 作为普通参数词时（含引号内的文本），其后第一个词含小写 `x`，或其后同一命令段内任一短选项簇含小写 `x` 或出现 `--ext…`/`--ge…`（如 `grep "tar extracted" <raw>/log`、`grep -rn tar <raw> -x`）；raw 仅作为解包源、解到别处或标准输出的 tar（如 `tar -C work -xzf <raw>/x.tgz`、`tar -O -xf <raw>/a.tar f`），与 raw 仅作为源的 `cp` 同类。

#### Scenario: append redirect into raw
- **WHEN** 调用 `bash`，`command` 为 `echo bad >> data/raw/obs.csv`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: glob delete under raw is denied
- **WHEN** 配置 `rawDirs: ["protected"]`，调用 `bash`，`command` 为 `rm -rf protected*`、`rm -rf protected?` 或 `rm -rf {protected,x}`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: glob delete under the default raw dir is denied
- **WHEN** 使用默认 `rawDirs`，调用 `bash`，`command` 为默认 raw 路径分别接 `*`、接 `?`、或包进 `{<raw>,x}` 的 `rm -rf`
- **THEN** 三条决策 `kind` 均为 `deny`；同一路径接 `*` 的 `cat` 决策 `kind` 为 `ask`

#### Scenario: write verb at the end of a pipeline
- **WHEN** 调用 `bash`，`command` 为 `find protected -type f | xargs rm`；或调用 `pwsh`，`command` 为 `Get-ChildItem protected | Remove-Item`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: write verb inside a subshell or quoted wrapper
- **WHEN** 调用 `bash`，`command` 为 `sh -c 'ls protected | xargs rm'`、`echo $(ls protected | xargs rm)`、`ls protected | xargs rm;echo`、`"rm" protected/x`、`` echo `find protected -delete` `` 或 `RM protected/x`；或调用 `pwsh`，`command` 为 `pwsh -c "Get-ChildItem protected | Remove-Item"`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: interpreter one-liner that mutates raw
- **WHEN** 调用 `bash`，`command` 为 `Rscript -e 'unlink("protected", recursive=TRUE)'`、`node -e 'require("fs").rmSync("protected",{recursive:true})'`、`perl -e 'unlink("protected/x")'` 或以 `python3 - <<'EOF'` 开头且正文提及 `protected` 的 heredoc
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: file-replacing tools and cmdlet aliases
- **WHEN** 调用 `bash`，`command` 为 `gzip protected/x`、`git clean -fdx protected`、`tar -xzf a.tgz -C protected`、`sort -o protected/x protected/x`；或调用 `pwsh`，`command` 为 `ren protected/x y`、`ni protected/x`、`Clear-Item protected/x`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: verb-shaped substrings inside file names stay reads
- **WHEN** 调用 `bash`，`command` 为 `cat protected/model x`、`ls protected/rivers`、`cat protected/x.xz`、`grep -r move protected`、`file protected/ni`、`tar -tzf protected/a.tgz`、`tar -tvf protected/a.tar -X excl`、`git log -- protected`、`awk '{print $1}' protected/x`、`sed -n 1,5p protected/x` 或 `Rscript analyse.R protected/x`；或调用 `pwsh`，`command` 为 `Get-ChildItem protected/third x`
- **THEN** 决策 `kind` 为 `ask`

#### Scenario: pwsh aliases and script blocks
- **WHEN** 调用 `pwsh`，`command` 为 `gci protected | %{$_|del}` 或 `Get-ChildItem protected | ForEach-Object {$_ | Remove-Item}`；或调用 `bash`，`command` 为 `pwsh -c 'gci protected | del'`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: GNU-prefixed tools are still writes
- **WHEN** 调用 `bash`，`command` 为 `gsed -i s/a/b/ protected/x`、`/opt/homebrew/bin/gsed -i s/a/b/ protected/x`、`gawk -i inplace 1 protected/x`、`gtar -xf a.tar -C protected` 或 `ipython -c x protected`
- **THEN** 决策 `kind` 为 `deny`；`tar -tvf protected/a.tar -X excl` 仍为 `ask`

#### Scenario: heredoc-fed interpreters
- **WHEN** 调用 `bash`，`command` 分别以 `Rscript - <<'EOF'`、`node - <<'EOF'`、`perl - <<'EOF'` 开头且正文提及 `protected`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: prefixed or escaped verb is still a write
- **WHEN** 调用 `bash`，`command` 为 `/bin/rm protected/x`、`\rm protected/x` 或 `sudo rm protected/x`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: additional POSIX verbs and destructive flags
- **WHEN** 调用 `bash`，`command` 为 `unlink protected/x`、`rmdir protected`、`shred protected/x`、`find protected -delete`、`find protected -delete; echo` 或 `tar -cf a.tar protected --remove-files`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: pwsh cmdlets and aliases
- **WHEN** 调用 `pwsh`，`command` 为上述 10 个 cmdlet 或 13 个别名中任一个后接 `protected/x`（如 `Remove-Item protected/x`、`Set-Content protected/x 1`、`del protected/x`），或小写 `remove-item protected/x`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: verb substring inside another word is not a write
- **WHEN** 调用 `bash`，`command` 为 `docker run --rm -v protected:/d img` 或 `arm protected/x`
- **THEN** 决策 `kind` 为 `ask`（触及但无写动词）

#### Scenario: workdir inside raw with a write verb
- **WHEN** 调用 `bash`，`command` 为 `rm obs.csv`，`workdir` 为 `data/raw`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: copy out of raw is denied
- **WHEN** 调用 `bash`，`command` 为 `cp data/raw/obs.csv work/obs.csv`
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `read`

#### Scenario: escalated shell write is still denied
- **WHEN** 调用 `bash`，`command` 为 `rm data/raw/obs.csv` 且 `arguments` 另含 `sandbox_permissions`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: discarding redirect keeps a read an ask
- **WHEN** 调用 `bash`，`command` 为 `head data/raw/obs.csv 2>/dev/null`、`ls data/raw >/dev/null`、`cat data/raw/obs.csv 2>/dev/null | wc -l`、`ls data/raw &>/dev/null` 或 `head data/raw/obs.csv 1>/dev/null 2>&1`
- **THEN** 决策 `kind` 为 `ask`，`reason` 为 provenance 常量（与不带重定向的读取相同）

#### Scenario: discarding redirect does not mask a real write
- **WHEN** 调用 `bash`，`command` 为 `cat data/raw/a 2>/dev/null > data/raw/b`、`head data/raw/a > /dev/nullx`、`head data/raw/a > /dev/null/x`、`bzip2>/dev/null data/raw/obs.csv` 或 `head data/raw/a >/dev/null; rm data/raw/a`
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `immutable`

#### Scenario: file-target forms of >& and <> are writes
- **WHEN** 调用 `bash`，`command` 为 `echo x >&data/raw/b`、`echo x >& data/raw/b`、`echo x 1>&data/raw/b`、`cat data/raw/a >&out.txt`、`echo XY 1<>data/raw/a`、`exec 3<>data/raw/new` 或 `cat data/raw/a 2>/dev/null >&data/raw/b`
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `immutable`

#### Scenario: fd duplication and closing stay reads
- **WHEN** 调用 `bash`，`command` 为 `head data/raw/a 2>&1`、`head data/raw/a >&2`、`head data/raw/a >& 2`、`head data/raw/a 1>&-`、`head data/raw/a 2>&1-`、`head data/raw/a 2>&1 | wc -l` 或 `head data/raw/a >&/dev/null`
- **THEN** 决策 `kind` 为 `ask`，`reason` 为 provenance 常量

#### Scenario: quotes after the fd number fail closed
- **WHEN** 调用 `bash`，`command` 为 `cat data/raw/a >&2" "`、`cat data/raw/a >&2" /../data/raw/b"`、`cat data/raw/a >&2}` 或 `sh -c 'head data/raw/a >&2'`
- **THEN** 决策 `kind` 为 `deny`，`reason` 含 `immutable`（前三条 bash 写文件；最后一条是引号包裹的读命令，正则无法区分开闭引号，按 deny 方向误报处理）

#### Scenario: quote-split verb is still a write
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `r"m" -rf prot`、`r'm' -rf prot`、`r\m -rf prot`、`m"v" a prot/b`、`c\p a prot/b`，或 `r\` 接换行再接 `m -rf prot`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: tar extraction anywhere in its command segment
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -C prot -xf a.tar`、`tar -f a.tar -x -C prot`、`tar --extract -f a.tar -C prot`、`tar --get -f a.tar -C prot`、`tar -C prot --ext -f a.tar`、`tar xf a.tar -C prot`、`tar zxf a.tgz -C prot`、`tar -C prot -zxf a.tgz`、`tar 2>&1 -C prot -xf a.tar`、`gtar -C prot -xzf a.tgz`、`TAR -C prot -xf a.tar`、`/usr/bin/tar -C prot -xf a.tar`、`tar -C prot -Jxf a.txz`、`tar -f a.tar -C prot --extract` 或 `cd w && tar -C prot -xf a.tar`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: tar listing, creation and exclude stay reads
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -tf prot/a.tar`、`tar -tvf prot/a.tar -X excl`、`tar -cf o.tar prot`、`tar -cf o.tar -C prot .`、`tar -tf prot/a.tar | grep -x foo`、`tar -tf prot/a.tar && grep -x foo`、`tar -tf prot/a.tar; ls -x`、`tar -tf prot/a.tar & ls -x`、`tar -tf prot/a.tar` 接换行再接 `ls -x`，或 `ls prot/a.tar -x`
- **THEN** 决策 `kind` 为 `ask`；`rm protx/x` 与 `echo ok > derived.txt` 返回 `next()` 的结果

#### Scenario: quote-spliced read text is an accepted false positive
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `grep 'r''m' prot/log`、`grep "c\p" prot/log`、`grep -rn tar prot -x`、`grep "tar extracted" prot/log`、`tar -tvf prot/a.tar -Xexcl` 或 `tar -C work -xzf prot/x.tgz`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: quoted segment separators hide a later tar extract option
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -C prot --exclude="a|b" -xf a.tar`
- **THEN** 决策 `kind` 为 `ask`（已记录漏报）

### Requirement: Shell write to a raw ancestor is denied
对 `bash`（含 persistent 变体）与 `pwsh`，命令不触及任何 raw 目录（见「Shell command touches raw」），但点名某个 raw 目录的严格祖先、且含**破坏性动词**时，策略门 SHALL 返回 `deny`。返回的 `code` 为 `raw-ancestor-write`，`reason` 含 `immutable`，说明命令在删除、移动或改权限时点名了一个包含 raw 的目录，应改为针对该目录下的明确路径或拆分命令（reason 中不写具体路径）。

破坏性动词 SHALL 为以下两组（不区分大小写，前后锚点与「Shell write under raw is denied」的 POSIX 动词相同）：
- POSIX：`rm`、`rmdir`、`unlink`、`mv`、`chmod`、`chown`、`chgrp`、`shred`、`rsync`、`-delete`、`--remove-files`、`git clean`；
- pwsh 语境下另加：`Remove-Item`、`Move-Item`、`Rename-Item`，以及别名 `del`、`erase`、`ri`、`rd`、`ren`、`rni`、`move`、`mi`。

POSIX 破坏性动词 SHALL 同时对原文和去引号副本判定（去引号副本同「Shell write under raw is denied」），因此 `r"m" -rf data`、`m\v data x` 同样触发本规则。

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

含破坏性动词的命令即按上述规则判定，即使实际删的或移的是别处，例如 `mv x.csv data`、`chmod -R g+w data`，以及复合命令中只读或文本里出现祖先、破坏性动词作用于别处的情形（如 `ls data && rm -f tmp.csv`、`git commit -m 'refresh data' && rm -rf build`、`rm -f data/*.tmp`）。reason SHALL 同时提示改用明确路径或拆分命令。这些 deny 方向的误报已接受；改用 `data/x.csv` 这类明确路径即不再命中。

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
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`command` 为 `mv x.csv sub` 或 `chmod -R g+w sub`；或默认配置下 `command` 为 `ls data && rm -f tmp.csv`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-ancestor-write`（已接受误报）

#### Scenario: changing into an ancestor is not naming it
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，workspace 的规范路径为 `W`，`command` 为 `cd sub && rm -rf derived`、`cd W && python run.py > log.txt`；或调用 `pwsh`，`command` 为 `Set-Location sub; Remove-Item -Recurse derived`
- **THEN** 返回 `next()` 的结果；`cd W && rm -rf sub`、`cd -P&&rm -rf sub` 与 `mv abcd sub` 决策 `kind` 为 `deny`

#### Scenario: implicit ancestor writes are a documented gap
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，`command` 为 `rm -rf .`、`rm -rf *`（workdir 为 workspace 根）或 `cd sub && rm -rf raw`；或 `workdir` 为 `sub` 时 `command` 为 `rm -rf raw`；或默认配置下 `command` 为 `python -c "import shutil; shutil.rmtree('data')"`
- **THEN** 返回 `next()` 的结果（已记录漏报；仅当 raw 在 workspace 外时由沙箱兜底）

#### Scenario: quote-split destructive verb on an ancestor
- **WHEN** 配置 `rawDirs: ["sub/raw"]`，调用 `bash`，`command` 为 `r"m" -rf sub` 或 `m\v sub x`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-ancestor-write`
