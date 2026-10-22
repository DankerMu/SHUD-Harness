## MODIFIED Requirements

### Requirement: Shell write under raw is denied
触及 raw 且命令含写动词时策略门 SHALL 返回 `deny`，`reason` 含 `immutable` 并指向 `read` 工具。写动词 SHALL 包括：POSIX 动词 `rm mv cp tee touch mkdir chmod chown chgrp truncate dd install rsync ln unlink rmdir shred gzip gunzip bzip2 xz unzip`（不区分大小写；动词前允许任意路径前缀、反斜杠转义、引号或 `sudo` 等前导词，即动词前一个字符不是 `[A-Za-z0-9_.-]` 即可——`.` 排除使 `x.xz`、`x.dd` 这类文件名后缀不算动词；动词后为行尾或 `[\s;&|)}'"`]` 之一，因此管道末尾、子 shell、`sh -c '…'` 引号内、pwsh 脚本块 `{… | del}` 内的动词也算）；工具形态 `git clean|checkout|restore`、`tar -x…`、`sort -o`、`awk -i`、`sed -i`/`--in-place`、`perl -i`/`-e`、`python -c`、`Rscript -e`/`--expr`、`node -e`/`--eval`、以 heredoc 喂入的解释器（`python|Rscript|node|perl - <<`）——这一组工具名前同样要求非路径名字符，以排除 `a.tar -X` 这类文件名碰撞；GNU 前缀变体 `gsed -i`、`gawk -i`、`gtar -x` 与 `ipython -c` 视同原工具（`gsed -i <raw>/x` 必须 deny；heredoc 形态不含 `i?` 前缀，`ipython - <<` 落 `ask`）；`>`/`>>` 重定向；文件形态的 `>&word`/`N>&word`（bash 的 word 只在空格、制表、换行与元字符 `;&|()<>` 处断开，引号与 `}` 不断开；纯数字、纯数字加 `-` 或单个 `-` 且其后紧接行尾、空格、制表、换行或 `;&|()<>` 时是 fd 复制、移动或关闭，如 `2>&1`、`>&2`、`>& 2`、`2>&1-`、`1>&-`、`2>&1)`、`$(… 2>&1)`，不算写；其他 `word` 都按文件处理（等价于 `&>word`），如 `>&2x`、`>&2:x`、`>&2$x`、`>&2"x"`、`>&2" "`、`>&2}`；fd 号后紧跟引号或反引号时同样按文件处理，因此 `sh -c '… >&2'`、`bash -c "… 2>&1"`、`` `… 2>&1` `` 这类引号包裹的读命令判 deny，属 deny 方向误报；引号内文本中的 `>&`（如 `grep '>&x' <raw>/log`）同样按写处理，属 deny 方向误报；`word` 为 `$` 变量等运行时才知道的值时按写处理，属 deny 方向误报）；读写重定向 `<>word`/`N<>word`（以读写方式打开，不存在则新建，可原地覆写；命令文本中其他位置的 `<>`，如 SQL 不等号，同样按写处理，属 deny 方向误报）（目标为 `/dev/null` 的丢弃型重定向 `>`、`>>`、`N>`、`N>>`、`&>`、`&>>`、`>&`、`N>&`、`<>`、`N<>` 除外：它们不写任何文件，判定时先剥除（只剥 `&`/`>`/`<` 起的部分，不吞前导 fd 数字：`bzip2>/dev/null <raw>/x` 中的 `bzip2` 仍是写动词）再看其余写动词与重定向；`/dev/nullx`、`/dev/null/x` 不是 `/dev/null`，不剥除）；`open(`；破坏性标志 `-delete`、`--remove-files`（前导为行首或空白，后继与动词相同）；pwsh cmdlet `Remove-Item Move-Item Copy-Item Rename-Item New-Item Set-Content Add-Content Clear-Content Clear-Item Out-File` 与别名 `del erase ri rd ren rni move mi copy cpi ni clc cli`（不区分大小写；仅对 `pwsh` 工具、或 `bash` 命令文本含 `pwsh`/`powershell` 词时生效——这些别名在 bash 里不是命令，`grep -r move <raw>` 必须仍是 `ask`）。该清单是启发式 denylist 而非穷举：不在清单内的写法落 `ask`（仍经 PI 审批），raw 在 workspace 外时由沙箱兜底。raw 仅作为源的 `cp`/重定向（指写到真实文件的重定向，如 `cat <raw>/x | sort > out.txt`）也 deny，这是已接受的 deny 方向误报；`sandbox_permissions` SHALL NOT 改变判定。

写动词、工具形态与重定向 SHALL 同时对原文和去引号副本判定，任一命中即为写；去引号副本与「Shell command touches raw」相同，即去掉反斜杠续行（`\` 紧跟换行）与全部 `"`、`'`、`\` 字符。因此动词中段被引号或转义拆开的写法同样 deny，如 `r"m"`、`r'm'`、`r\m`、`m"v"`、`c\p`、`r\` 接换行再接 `m`。pwsh 写动词仍只对原文判定。

tar 解包 SHALL 按以下规则判为写：在 `tar`、`gtar` 或 `bsdtar`（命令名与 POSIX 动词同样不区分大小写，前一个字符不是路径名字符，判定同样作用于去引号副本）之后、同一命令段内（命令段在 `;`、`|`、换行处结束，在 `&` 处也结束，但重定向 `>&`、`<&` 中的 `&` 除外（`&>word` 本身已按写重定向或丢弃重定向处理）），任意位置出现短选项簇含小写 `x`（`-xf`、`-zxf`、`-C <raw> -xf`、`-f a.tar -x`）、`--extract`、`--get` 或它们的缩写（`--ext`、`--ge`）；或 `tar` 之后的第一个词是不带 `-` 的旧式选项簇且含小写 `x`（`tar xf`、`tar zxf`）。`x` 区分大小写，`-X`（`--exclude-from`）不是解包；`-C <raw>` 本身不是写（`tar -cf o.tar -C <raw> .` 只读 raw）。判定 SHALL 与命令长度成线性关系。引号内出现的 `;`、`|`、`&` 同样结束命令段，因此其后的解包选项不被识别（已记录漏报，如 `tar -C <raw> --exclude="a|b" -xf a.tar` 落 `ask`）。

tar 写归档 SHALL 按以下规则判为写：同一命令段内（分段与命令名规则同 tar 解包；命令段内 `(`、反引号之后的部分另作候选，`$( )`、反引号里的 tar 不被段内先出现的 tar 词遮住）出现写归档模式，且其归档操作数位于 raw 下时判 `deny`。写归档模式为短选项簇含 `c`、`r`、`u` 或 `A`（区分大小写：`-C` 是切换目录），旧式首个选项簇含这些字母，或长选项 `--create`、`--append`、`--update`、`--catenate`、`--concatenate`、`--delete` 及其缩写（`--cr…`、`--ap…`、`--up…`、`--ca…`、`--conc…`、`--dele…`；`--del` 与 `--delay-directory-restore` 有歧义，不算）。归档操作数为：短选项簇中第一个 `f` 之后紧接的文本或下一个词（`-cf <raw>/a.tar`、`-c -f <raw>/a.tar`、`-cf<raw>/a.tar`）、`--file=WORD`/`--file WORD`（含 `--fil`），或旧式首簇含 `f` 时其后的第一个词（`tar cf <raw>/a.tar x`）；操作数为 `-`（标准输出）时不算。操作数按 shell 的工作目录（`workdir`，缺省为 session cwd）解析，`-C` 不改变归档路径；操作数位于任一 raw 下即判写（不限于命令所触及的那个 raw）。raw 只作为打包源时（`tar -cf o.tar <raw>`、`tar -cf o.tar -C <raw> .`）不触发本条，仍为 `ask`。判定 SHALL 与命令长度成线性关系。已接受误报（deny 方向）：选项与参数连写且参数含模式字母（如 `tar -tf <raw>/a.tar -Hustar`），以及 `tar` 作为文本出现（如 `grep "tar -cf <raw>/a.tar" <raw>/log`）。已接受误报还包括：选项与参数连写的 `-Cwork` 一类；workdir 在 raw 内时 `~/out.tar`、`$HOME/out.tar` 按字面路径解析为 raw 内。已记录漏报：归档操作数含变量或 `~`（`$PWD/<raw>/a.tar`，无法解析为 raw 内）、经符号链接指向 raw 而命令未字面提及 raw，以及经 `cd`/`pushd` 改变目录后的相对操作数（`cd <raw> && tar -cf a.tar x`），这些仍为 `ask`。

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
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -C prot -xf a.tar`、`tar -f a.tar -x -C prot`、`tar --extract -f a.tar -C prot`、`tar --get -f a.tar -C prot`、`tar -C prot --ext -f a.tar`、`tar xf a.tar -C prot`、`tar zxf a.tgz -C prot`、`tar -C prot -zxf a.tgz`、`tar 2>&1 -C prot -xf a.tar`、`gtar -C prot -xzf a.tgz`、`TAR -C prot -xf a.tar`、`/usr/bin/tar -C prot -xf a.tar`、`tar -C prot -Jxf a.txz`、`tar -C prot -zvxf a.tgz`、`tar zvxf a.tgz -C prot`、`tar` 接制表符再接 `xf a.tar -C prot`、`gtar xzf a.tgz -C prot`、`tar -f a.tar -C prot --extract` 或 `cd w && tar -C prot -xf a.tar`
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

#### Scenario: tar writes an archive under raw
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -cf prot/a.tar x`、`tar -rf prot/a.tar x`、`tar -uf prot/a.tar x`、`tar -Af prot/a.tar b.tar`、`tar --delete -f prot/a.tar x`、`tar cf prot/a.tar x`、`tar --create --file=prot/a.tar x`、`tar -c -f prot/sub/a.tar x`、`tar -f prot/a.tar -c x`、`tar -zcf prot/a.tgz x`、`tar cfv prot/a.tar x`、`gtar -rf prot/a.tar x`、`bsdtar -cf prot/a.tar x`、`tar rf prot/a.tar x`、`tar Jcf prot/a.txz x` 或 `tar -cf prot/a.tar x && ls`；或配置 `rawDirs: ["prot", "raw2"]` 时 `command` 为 `tar -cf raw2/a.tar prot/x`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: bsdtar extraction into raw
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `bsdtar -xf a.tar -C prot`、`/usr/bin/bsdtar -xf a.tar -C prot` 或 `bsdtar -tf a.tar $(tar xf b.tar -C prot)`
- **THEN** 决策 `kind` 为 `deny`，`code` 为 `raw-immutable`

#### Scenario: raw as an archive source stays a read
- **WHEN** 配置 `rawDirs: ["prot"]`，调用 `bash`，`command` 为 `tar -cf o.tar prot`、`tar -cf o.tar -C prot .`、`tar -cf - prot | wc -c`、`bsdtar -tf prot/a.tar`、`cat prot/mybsdtar.log` 或 `cd prot && tar -cf a.tar x`（已记录漏报）
- **THEN** 决策 `kind` 为 `ask`；`tar -cf protx/a.tar x` 返回 `next()` 的结果
