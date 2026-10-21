# Spec Delta

## MODIFIED Requirements

### Requirement: Shell command touches raw
对 `bash`（含 persistent 变体，同 id）与 `pwsh`，"触及 raw" SHALL 定义为：`command` 文本包含任一 raw 目录的配置原文或其解析后绝对路径且该文本的后继字符不是路径名字符（`[A-Za-z0-9._-]`）或已到行尾，**或** 有效工作目录 `realpath(workdir ?? session cwd)` 位于任一 raw 目录内。glob、brace、反引号、逗号等 shell 元字符紧随 raw 文本时 SHALL 视为触及（fail-closed）；兄弟路径（`<raw>x`、`<raw>.bak`、`<raw>_old`）SHALL NOT 视为触及。不触及 raw 时 SHALL 委托下一个监听器。判定只看文本与工作目录，有两处已记录的漏报（raw 位于 workspace 外时由沙箱兜底）：persistent bash 先 `cd` 进 raw 再以相对路径写入不被识别；比 raw 原文更短的 glob 前缀（如 `rm -rf protecte*`）不含原文，不被识别。

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
- **WHEN** 调用 `bash`，`command` 为 `rm protectedx/x`、`rm protected.bak` 或 `cat protected_old/x`
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

### Requirement: Shell write under raw is denied
触及 raw 且命令含写动词时策略门 SHALL 返回 `deny`，`reason` 含 `immutable` 并指向 `read` 工具。写动词 SHALL 包括：POSIX 动词 `rm mv cp tee touch mkdir chmod chown truncate dd install rsync ln unlink rmdir shred`（动词前允许任意路径前缀、反斜杠转义或 `sudo` 等前导词，即动词前一个字符不是 `[A-Za-z0-9_-]` 即可；动词后为空白或行尾，因此管道末尾的 `| xargs rm` 也算）；`>`/`>>` 重定向；`sed -i`/`--in-place`、`perl -i`、`python -c`、`open(`；破坏性标志 `-delete`、`--remove-files`（前导为行首或空白，后继为行尾或 `[\s;&|)]`，任意动词携带即算写）；pwsh cmdlet `Remove-Item Move-Item Copy-Item Rename-Item New-Item Set-Content Add-Content Clear-Content Out-File` 与别名 `del erase ri rd`（不区分大小写）。raw 仅作为源的 `cp`/重定向也 deny，这是已接受的 deny 方向误报；`sandbox_permissions` SHALL NOT 改变判定。

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

#### Scenario: prefixed or escaped verb is still a write
- **WHEN** 调用 `bash`，`command` 为 `/bin/rm protected/x`、`\rm protected/x` 或 `sudo rm protected/x`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: additional POSIX verbs and destructive flags
- **WHEN** 调用 `bash`，`command` 为 `unlink protected/x`、`rmdir protected`、`shred protected/x`、`find protected -delete`、`find protected -delete; echo` 或 `tar -cf a.tar protected --remove-files`
- **THEN** 决策 `kind` 为 `deny`

#### Scenario: pwsh cmdlets and aliases
- **WHEN** 调用 `pwsh`，`command` 为上述 9 个 cmdlet 或 4 个别名中任一个后接 `protected/x`（如 `Remove-Item protected/x`、`Set-Content protected/x 1`、`del protected/x`），或小写 `remove-item protected/x`
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
