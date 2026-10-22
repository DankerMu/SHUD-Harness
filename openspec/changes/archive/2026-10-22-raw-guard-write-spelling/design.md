# Design

Change surface: `packages/dsh-shud-raw-guard/src/decide.ts`。

新增：
- 未导出辅助函数 `unquote`（从 `texts` 构造中提出，`texts` 改为调用它，行为不变）；
- tar 解包检测：常量 `TAR_COMMAND`、`TAR_EXTRACT_OPTION` 与未导出函数 `tarExtracts`；
- 第一遍循环的写判定改为对 `[command, unquote(command)]` 取 OR，并加上 `tarExtracts`；
- 第二遍祖先判定的 POSIX 破坏性动词改为对 `[command, unquote(command)]` 取 OR。

不改：
- `WRITE_VERBS`、`PWSH_WRITES`、`ANCESTOR_DESTRUCTIVE`、`PWSH_ANCESTOR_DESTRUCTIVE`、`DISCARD_REDIRECT` 常量本身（`WRITE_VERBS` 里原有的 `g?tar\s+-[a-zA-Z]*x` 子式保留）；
- mention 判定、`texts` 的内容、workdir 判定、文件工具分支、`normalizeRawDirs`；
- pwsh 写动词只测原文；
- 导出。

Must preserve:
- `decide.test.ts` 现有全部行逐行结果不变（原文仍在候选中，deny 只增不减；新增 tar 检测只会把 ask 收紧为 deny）。若有既有行结果变化，停下报告，不改断言。
- 第一遍循环的顺序与多 raw 以第一个命中者为准；第二遍只在第一遍无命中时进行。
- 探针 T1–T5 判定不变。

Must add/change:
- 代码（注释风格同文件内其他常量）：
  ```ts
  // Quote splicing, \ escapes and \<newline> join one bash word, so a copy drops them.
  function unquote(text: string): string {
    return text.replace(/\\\n|["'\\]/g, "");
  }
  // #279: tar extracts (writes) when, after tar in the same command segment, a
  // short-option cluster holds x (tar -C <raw> -xf, tar -f a.tar -x), --extract or
  // --get (or an abbreviation: --ext, --ge) appears, or the first word is an
  // old-style cluster holding x (tar xf). x is case-sensitive: -X is
  // --exclude-from. Segments end at ; | newline and at & except in >& and <&
  // (&>word is already a write or a stripped /dev/null). Scanning from the first tar of each segment keeps the check linear.
  const TAR_COMMAND = /(?<![A-Za-z0-9_.-])[gG]?[tT][aA][rR]\s/;
  const TAR_EXTRACT_OPTION = /^\s+[A-Za-z]*x|\s(?:-[A-Za-z]*x|--(?:ext[a-z]*|get?)(?![A-Za-z0-9-]))/;
  const COMMAND_SEGMENT = /[;|\n]|(?<![<>])&/;
  function tarExtracts(text: string): boolean {
    return text.split(COMMAND_SEGMENT).some((segment) => {
      const tar = TAR_COMMAND.exec(segment);
      return tar !== null && TAR_EXTRACT_OPTION.test(segment.slice(tar.index + tar[0].length - 1));
    });
  }
  ```
  - `texts` 构造中 `text.replace(/\\\n|["'\\]/g, "")` 改为 `unquote(text)`。
  - 第一遍循环：
    ```ts
    const writes = [command, unquote(command)].some((text) => {
      const checked = text.replace(DISCARD_REDIRECT, " ");
      return WRITE_VERBS.test(checked) || tarExtracts(checked);
    });
    return writes || (pwsh && PWSH_WRITES.test(command)) ? DENY : ASK;
    ```
  - 第二遍：`[command, unquote(command)].some((text) => ANCESTOR_DESTRUCTIVE.test(text)) || (pwsh && PWSH_ANCESTOR_DESTRUCTIVE.test(command))`。
- `decide-spelling.test.ts`（新文件；祖先行在 `decide.test.ts`；`rawDirs: ["prot"]`，workspace 下建 `prot/`；祖先行用既有 `subRaw`/`W` 与 `expectAncestorDecision`）：
  - 拆分动词 deny（`code: "raw-immutable"`）：`r"m" -rf prot`、`r'm' -rf prot`、`r\m -rf prot`、`m"v" a prot/b`、`c\p a prot/b`、`r\` 接换行再接 `m -rf prot`。
  - tar 解包 deny（`code: "raw-immutable"`）：`tar -C prot -xf a.tar`、`tar -f a.tar -x -C prot`、`tar --extract -f a.tar -C prot`、`tar --get -f a.tar -C prot`、`tar xf a.tar -C prot`、`gtar -C prot -xzf a.tgz`、`TAR -C prot -xf a.tar`（不加 runIf：命令名大小写与文件系统无关）。
  - tar 解包补钉住 deny（fixture review r1）：`tar -C prot -zxf a.tgz`（`x` 不在簇首）、`tar zxf a.tgz -C prot`（旧式 `x` 不在首字母）、`"tar" -C prot -xf a.tar`、`tar -C prot -"x"f a.tar`（只在去引号副本里成立）、`tar` 接制表符再接 `-C prot -xf a.tar`、`tar 2>&1 -C prot -xf a.tar`、`tar >&2 -C prot -xf a.tar`、`tar <&0 -C prot -xf a.tar`（重定向里的 `&` 不分段）、`tar -C prot --ext -f a.tar`、`tar -C prot --ge -f a.tar`（长选项缩写）。
  - ask：`cat prot/x`、`tar -tf prot/a.tar`、`tar -tvf prot/a.tar -X excl`、`tar -cf o.tar prot`、`tar -cf o.tar -C prot .`、`tar -tf prot/a.tar | grep -x foo`、`ls prot/a.tar -x`。
  - next：`rm protx/x`、`echo ok > derived.txt`。
  - 已接受误报 deny：`grep 'r''m' prot/log`、`grep -rn tar prot -x`；review round 1 补：`grep "c\p" prot/log`、`tar -tvf prot/a.tar -Xexcl`、`grep "tar extracted" prot/log`、`tar -C work -xzf prot/x.tgz`。
  - review round 1 补 deny（`code: "raw-immutable"`）：`cd w && tar -C prot -xf a.tar`、`ls; tar -C prot -xf a.tar`（非首段）、`tar -C prot -Jxf a.txz`、`tar Jxf a.txz -C prot`（大写字母簇）、`tar -f a.tar -C prot --extract`（长选项在行尾）、`/usr/bin/tar -C prot -xf a.tar`（路径前缀）、`tar` 接两个空格再接 `xf a.tar -C prot`、`tar -C prot` 接制表符再接 `-xf a.tar`、`GTAR -C prot -xf a.tar`、`tar>/dev/null -C prot -xf a.tar`（丢弃重定向剥除后才成立）；review round 2 补：`tar zvxf a.tgz -C prot`、`tar -C prot -zvxf a.tgz`（`x` 在簇内第 3 位）；review round 3 补：`tar` 接制表符再接 `xf a.tar -C prot`、`tar zvvxf a.tgz -C prot`、`tar -C prot -zvvxf a.tgz`、`gtar xzf a.tgz -C prot`、`(tar -C prot -f a.tar --extract)`。
  - review round 1 补 ask（分段）：`tar -tf prot/a.tar && grep -x foo`、`tar -tf prot/a.tar; ls -x`、`tar -tf prot/a.tar & ls -x`、`tar -tf prot/a.tar` 接换行再接 `ls -x`。
  - 已记录漏报 ask：`tar -C prot --exclude="a|b" -xf a.tar`（引号内的 `|` 仍分段）。
  - 祖先 deny（`code: "raw-ancestor-write"`）：`r"m" -rf sub`、`m\v sub x`。
  - 资源：`"tar " .repeat(2e5) + "prot"` → ask；`"tar -" + "a".repeat(5e5) + " prot"` → ask。均在默认超时内完成。

Governing invariant:
- 写判定的候选集是原文加去引号副本，原文永远在内：结果只会从 ask/next 收紧为 deny。
- tar 解包的 `x` 区分大小写；`-C` 不是写信号。
- 每个辅助判定对命令长度线性。

Sibling surfaces:
- mention 判定已用去引号副本（#260），不改。
- `scripts/guardrails/no-bypass.sh` 是 agent 侧 hook，不在 dsh `tools/pre-execute` 路径上，不在范围。
- pwsh 中段引号/反引号拆分（`PWSH_WRITES` 只测原文）不在范围，已登记为 #260 同类漏报。
- `lib/decide.js` 由 build 生成。

Seams under test: `decideRawAccess(call, options)`（vitest）；live 探针 T1–T5。

Required evidence:
- 改动前（origin/main 的 `decide.ts`）：拆分动词 deny 行、tar 解包 deny 行与补钉住行、已接受误报行、祖先 deny 行为红；ask/next 行、已记录漏报行与资源行为绿。改后全部为绿，既有行不变。
- 突变，每项至少让一行变红：
  1. 第一遍写判定只测原文（去掉 `unquote(command)`）→ 拆分动词 deny 行与误报行 `grep 'r''m' prot/log` 变红。
  2. `unquote` 不去 `\` → `r\m`、`c\p` 行变红。
  3. `unquote` 不去 `\`+换行（只去单个 `\`）→ 续行行变红。
  4. 不调用 `tarExtracts` → tar 解包 deny 行变红。
  5. `TAR_EXTRACT_OPTION` 加 `/i` → `tar -tvf prot/a.tar -X excl` 变红。
  6. 不分段 → `tar -tf prot/a.tar | grep -x foo` 变红。
  7. 去掉旧式首词分支 → `tar xf a.tar -C prot` 变红。
  8. 旧式分支去掉 `^` 锚点 → `tar -tvf prot/a.tar -X excl`（` excl` 被当作选项簇）变红。
  9. 去掉 `get?` 分支 / 去掉 `ext[a-z]*` 分支 → `--get`、`--ge` / `--extract`、`--ext` 行变红；`get?` 改为 `get`、`ext[a-z]*` 改为 `extract` → 缩写行变红。
  10. `TAR_COMMAND` 去掉前向否定（lookbehind）→ `ls prot/a.tar -x` 变红。
  11. `TAR_COMMAND` 去掉 `[gG]?` → `gtar -C prot -xzf a.tgz` 变红。
  12. `TAR_COMMAND` 只认小写 `tar` → `TAR -C prot -xf a.tar` 变红。
  13. 祖先破坏性动词只测原文 → 祖先拆分动词行变红。
  14. `tarExtracts` 改为单个正则 `[gG]?[tT][aA][rR]\s+(?:[^;&|\n]*?\s)?…` → `"tar " .repeat(2e5)` 资源行超时。
  15. `\s-[A-Za-z]*x` 改为 `\s-x` → `tar -C prot -zxf a.tgz` 变红。
  16. 旧式分支 `[A-Za-z]*x` 改为 `x` → `tar zxf a.tgz -C prot` 变红。
  17. `tarExtracts` 只对原文调用 → `"tar" -C prot -xf a.tar`、`tar -C prot -"x"f a.tar` 变红。
  18. `TAR_COMMAND` 的 `\s` 改为空格 → 制表符行变红。
  19. `COMMAND_SEGMENT` 改回 `/[;&|\n]/` → `tar 2>&1 …`、`tar >&2 …`、`tar <&0 …` 行变红。
  20. 分段判定 `.some` 改为 `.every` → `cd w && tar …`、`ls; tar …` 行变红。
  21. 短选项簇字母类 `[A-Za-z]` 改为 `[a-z]` → `-Jxf` 行变红。
  22. 旧式首词字母类 `[A-Za-z]` 改为 `[a-z]` → `Jxf` 行变红。
  23. 长选项前瞻 `(?![A-Za-z0-9-])` 改为 `(?=\s)` → 行尾 `--extract` 行变红。
  24. `TAR_COMMAND` 前一字符排除集加 `/` → `/usr/bin/tar` 行变红。
  25. 旧式分支 `^\s+` 改为 `^\s` → 两个空格行变红。
  26. 选项前的 `\s` 改为空格 → 选项前制表符行变红。
  27. `[gG]?` 改为 `g?` → `GTAR` 行变红。
  28. `tarExtracts(checked)` 改为 `tarExtracts(text)` → `tar>/dev/null …` 行变红。
  29. `COMMAND_SEGMENT` 去掉 `;` / 去掉 `&` 分支 / 去掉 `\n` → 对应分段 ask 行变红。
  30. 旧式分支 `[A-Za-z]*x` 改为 `[A-Za-z]?x` / 短选项簇 `-[A-Za-z]*x` 改为 `-[A-Za-z]?x` → `tar zvxf a.tgz -C prot` / `tar -C prot -zvxf a.tgz` 变红（`x` 在簇内第 3 位，review round 2）。
  31. 旧式分支 `^\s+` 改为 `^ +` → `tar` 接制表符再接 `xf a.tar -C prot` 行变红（review round 3）。
  32. 两处簇内 `[A-Za-z]*` 改为 `[A-Za-z]{0,2}` → `tar zvvxf a.tgz -C prot`、`tar -C prot -zvvxf a.tgz` 变红。
  33. slice 偏移写死为 `tar.index + 3` → `gtar xzf a.tgz -C prot` 变红。
  34. 长选项前瞻改为 `(?=\s|$)` → `(tar -C prot -f a.tar --extract)` 变红。
- `pnpm run check`、`pnpm run build`、`pnpm run test-guardrails` 绿。
- live `pnpm run raw-guard:probes` 两次 T1–T5 PASS、md5 不变。

Non-goals:
- pwsh 写动词的引号/反引号拆分。
- 变量、命令替换、`eval`、base64、ANSI-C 引号 `$'r\x6d'`。
- 完整 shell 词法解析；按参数位置区分 `x` 属于哪个选项；引号内的 `;`、`|`、`&`。
- `bsdtar` 命令名；`tar -c/-r/-u/-A/--delete` 写入 raw 内的归档文件（改动前已存在，另立 issue）。
- 修改 ASK 审批卡文案。
