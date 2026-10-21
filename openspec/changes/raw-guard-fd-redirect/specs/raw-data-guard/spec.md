# Spec Delta

## MODIFIED Requirements

### Requirement: Shell write under raw is denied
触及 raw 且命令含写动词时策略门 SHALL 返回 `deny`，`reason` 含 `immutable` 并指向 `read` 工具。写动词 SHALL 包括：POSIX 动词 `rm mv cp tee touch mkdir chmod chown chgrp truncate dd install rsync ln unlink rmdir shred gzip gunzip bzip2 xz unzip`（不区分大小写；动词前允许任意路径前缀、反斜杠转义、引号或 `sudo` 等前导词，即动词前一个字符不是 `[A-Za-z0-9_.-]` 即可——`.` 排除使 `x.xz`、`x.dd` 这类文件名后缀不算动词；动词后为行尾或 `[\s;&|)}'"`]` 之一，因此管道末尾、子 shell、`sh -c '…'` 引号内、pwsh 脚本块 `{… | del}` 内的动词也算）；工具形态 `git clean|checkout|restore`、`tar -x…`、`sort -o`、`awk -i`、`sed -i`/`--in-place`、`perl -i`/`-e`、`python -c`、`Rscript -e`/`--expr`、`node -e`/`--eval`、以 heredoc 喂入的解释器（`python|Rscript|node|perl - <<`）——这一组工具名前同样要求非路径名字符，以排除 `a.tar -X` 这类文件名碰撞；GNU 前缀变体 `gsed -i`、`gawk -i`、`gtar -x` 与 `ipython -c` 视同原工具（`gsed -i <raw>/x` 必须 deny；heredoc 形态不含 `i?` 前缀，`ipython - <<` 落 `ask`）；`>`/`>>` 重定向；文件形态的 `>&word`/`N>&word`（bash 的 word 只在空白与元字符处断开；`word` 不是纯数字、纯数字加 `-` 或单个 `-` 时 bash 把它当文件，等价于 `&>word`，如 `>&2x`、`>&2:x`、`>&2$x`、`>&2"x"`；纯数字、纯数字加 `-` 或单个 `-` 且其后（可隔引号）即为行尾、空白或 `;&|()<>}` 时是 fd 复制、移动或关闭，如 `2>&1`、`>&2`、`>& 2`、`2>&1-`、`1>&-`、`2>&1)`、`sh -c '… >&2'`，不算写；引号内文本中的 `>&`（如 `grep '>&x' <raw>/log`）同样按写处理，属 deny 方向误报；`word` 为 `$` 变量等运行时才知道的值时按写处理，属 deny 方向误报）；读写重定向 `<>word`/`N<>word`（以读写方式打开，不存在则新建，可原地覆写；命令文本中其他位置的 `<>`，如 SQL 不等号，同样按写处理，属 deny 方向误报）（目标为 `/dev/null` 的丢弃型重定向 `>`、`>>`、`N>`、`N>>`、`&>`、`&>>`、`>&`、`N>&`、`<>`、`N<>` 除外：它们不写任何文件，判定时先剥除（只剥 `&`/`>`/`<` 起的部分，不吞前导 fd 数字：`bzip2>/dev/null <raw>/x` 中的 `bzip2` 仍是写动词）再看其余写动词与重定向；`/dev/nullx`、`/dev/null/x` 不是 `/dev/null`，不剥除）；`open(`；破坏性标志 `-delete`、`--remove-files`（前导为行首或空白，后继与动词相同）；pwsh cmdlet `Remove-Item Move-Item Copy-Item Rename-Item New-Item Set-Content Add-Content Clear-Content Clear-Item Out-File` 与别名 `del erase ri rd ren rni move mi copy cpi ni clc cli`（不区分大小写；仅对 `pwsh` 工具、或 `bash` 命令文本含 `pwsh`/`powershell` 词时生效——这些别名在 bash 里不是命令，`grep -r move <raw>` 必须仍是 `ask`）。该清单是启发式 denylist 而非穷举：不在清单内的写法落 `ask`（仍经 PI 审批），raw 在 workspace 外时由沙箱兜底。raw 仅作为源的 `cp`/重定向（指写到真实文件的重定向，如 `cat <raw>/x | sort > out.txt`）也 deny，这是已接受的 deny 方向误报；`sandbox_permissions` SHALL NOT 改变判定。

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
