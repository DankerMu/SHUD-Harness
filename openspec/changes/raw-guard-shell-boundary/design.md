# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts` — `WRITE_VERBS` 常量（`:26-27`）与 `decideRawAccess` 的 `mentioned` 判定（`:91-94`）。`index.ts` 适配层、`normalizeRawDirs`、`canonical`/`contains` 不动。

Must preserve:
- `rm protectedx/x` → `next`、`write protectedx/new.csv` → `next`（兄弟前缀不是 raw，`decide.test.ts:53,89,109`）。
- `cat <raw>/obs.csv` / `ls -la <raw>` / `head <abs raw>/x` → `ask`，`reason` 为 `RAW_READ_PROVENANCE_REASON`，`displayReason.en/zh` 非空。
- `echo ok > derived.txt` → `next`；`cp <raw>/x work/x` → `deny`（已接受的方向误报）；`workdir` 在 raw 内的 `rm x` → `deny`、`wc -l x` → `ask`。
- `str_replace_editor view`、`read`、`run_code`、畸形参数 → `next`；symlink/realpath 行为全部不变。
- 探针 T1–T5（`scripts/runtime/raw-guard-probes.sh`）判据不变，live 全绿。

Must add/change:
- 提及边界：`<escaped raw>(?![A-Za-z0-9._-])`。效果：`<raw>*`、`<raw>?`、`{<raw>,x}`、`` `<raw>` ``、`<raw>/x` 均算提及；`<raw>x`、`<raw>.bak`、`<raw>_old`、`<raw>-2` 不算。
- 写动词锚定：`(?<![A-Za-z0-9_-])` 代替 `(^|[\s;&|(])`，使 `/bin/rm`、`\rm`、`sudo rm`、`$(rm` 命中，`arm`、`--rm` 不命中；收尾改为**与标志共用的** `(?=$|[\s;&|)'"\`])`（round 1 修正：仅 `(?=\s|$)` 会让 `sh -c '… | xargs rm'`、`$(… rm)`、`rm;echo`、`"rm" x` 落 ask），使管道末尾、子 shell、引号包裹的动词都命中；POSIX 动词正则加 `i` 标志（APFS 大小写不敏感下 `RM` 仍执行 `/bin/rm`）。
- 动词表新增 `unlink rmdir shred chgrp gzip gunzip bzip2 xz unzip`；工具形态 `git\s+(clean|checkout|restore)`、`tar\s+-[a-zA-Z]*x`、`sort\s+-o`、`awk\s+-i`；解释器一行式 `Rscript\s+(-e|--expr)`、`node\s+(-e|--eval)`、`perl\s+-[a-zA-Z]*[ie]`、heredoc 喂入 `(python[0-9.]*|Rscript|node|perl)\s+-\s*<<`（与既有 `python -c` 同级）；标志 `-delete`、`--remove-files`（前导为行首或空白，后继同动词收尾，任何动词携带即 deny）；pwsh cmdlet 加 `Clear-Item`，别名加 `ren rni move mi copy cpi ni clc cli`；spec 明文该清单为启发式 denylist 而非穷举；pwsh cmdlet 与别名见 proposal，pwsh 子式不区分大小写（`remove-item` 同样命中）——TS 5.8 会校验正则字面量语法，内联 `(?i:…)` 不可用，pwsh 部分应是独立带 `i` 标志的正则，与 POSIX/标志正则用 `||` 组合。重定向、`sed -i`、`perl -i`、`python -c`、`open(` 子式不变。
- 规范同步：spec "Shell command touches raw" 写明边界定义与 glob/brace 场景；"Shell write under raw is denied" 列出完整动词/标志/cmdlet 清单与前缀规则。

Governing invariant: 命令文本一旦按规范定义"包含"任一 raw 目录（后继不是路径名字符），决策只能是 `deny` 或 `ask`，绝不 `next`；带任何已知写动词或破坏性标志时必须是 `deny`，读审批卡文案不得承载写操作。

Sibling surfaces:
- 文件工具分支 `decide.ts:75-85`：用 canonical 路径包含判定，不走文本正则，不受本次影响；测试保持。
- `scripts/guardrails/no-bypass.sh:39-50` `writes_to()`：agent 侧 PreToolUse hook 的同类文本检测，不在 dsh seam 上，不合并、不改。
- 探针脚本与夹具：命令形态（edit/cat/追加重定向/workspace 外写/derived 写）不含 glob 或前缀动词，判据不变。
- `ASK.displayReason` 文案常量：不改文案；通过把破坏性命令归入 deny 消除"读文案承载写"的错配。

Seams under test: 导出函数 `decideRawAccess(call, options)` 与 `normalizeRawDirs`（`decide.test.ts` 直接调用，fake cwd 临时目录）。不新增 ctx 级测试。

Required evidence:
- 对 `rawDirs: ["protected"]`：`rm -rf protected*` / `rm -rf protected?` / `rm -rf {protected,x}` / `rm -rf protected/*` → `deny`；`cat protected*` / `cat protected?` / `ls {protected,derived}` / `` cat `echo protected` `` → `ask`；`rm protectedx/x` / `rm protected.bak` / `cat protected_old/x` → `next`。
- 动词清单逐项迭代（参照 `decide.test.ts:63` 的 `split(" ")` 循环）：POSIX 全部 22 个动词各一条 `<verb> protected/x derived/x` → `deny`（另加全大写形式一轮）；前缀/转义/前导词 `/bin/rm`、`\rm`、`sudo rm` → `deny`；标志 `find protected -delete`、`find protected -delete; echo`、`tar -cf a.tar protected --remove-files` → `deny`；管道末尾 `find protected -type f | xargs rm` → `deny`（bash 与 pwsh 同跑）。
- pwsh：10 个 cmdlet 与 13 个别名各一条 `<cmdlet> protected/x` → `deny`；小写 `remove-item protected/x` → `deny`；管道末尾 `Get-ChildItem protected | Remove-Item` → `deny`。
- 非动词：`docker run --rm -v protected:/d img`、`arm protected/x` → `ask`。
- 对默认 `normalizeRawDirs()`：默认 raw 路径分别接 `*`、`?`、包进 `{…,x}` 的删除三条 → `deny`，默认 raw 路径接 `*` 的 `cat` → `ask`（测试用字符串拼接构造命令，避免仓库 hook 的文本拦截）。
- 现有 7 个 test（含仅 darwin 的 1 个）全部保持；`pnpm run check` 绿；`pnpm run raw-guard:probes` T1–T5 PASS、md5 PASS。

Non-goals: 变量/命令替换混淆（`$D/raw`、`eval`、base64）；**比 raw 名更短的 glob 前缀**（`protecte*`、默认配置下的 `data/r*`）——纯文本判定不含 raw 原文，无法识别，登记为与 persistent `cd` 同级的已知漏报（raw 在 workspace 外时由沙箱兜底）；persistent `cd` 漏报；`cp`/重定向方向误报；shell 语法解析；沙箱读边界验证；`index.ts`/探针/profile/文档以外的任何改动。

Review focus:
1. 新边界 `(?![A-Za-z0-9._-])` 是否把所有 shell 元字符都归为提及，且兄弟目录仍为 `next`（两方向都有测试）。
2. 动词 lookbehind 是否误伤含 `rm`/`dd` 子串的词（`arm`、`--rm`、`add`、`sudo` 自身），是否有灾难性回溯（无 `\S*` 贪婪前缀）。
3. 动词/标志/工具/pwsh 共用的后继 `(?=$|[\s;&|)}'"\`])` 是否覆盖 `-delete;`、`{…|del}` 等形态，且 `--delete-after`（rsync 本身已是动词）不影响判定；pwsh 别名只在 pwsh 上下文生效，bash `grep -r move <raw>` 仍 ask。
4. spec 清单与 `WRITE_VERBS` 常量逐项一致，无一项只在一边。
5. 每条新测试对修复前源码为红（implementer 报告需列出）。
